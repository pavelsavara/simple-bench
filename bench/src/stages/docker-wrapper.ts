import { join } from 'node:path';
import { type BenchContext, saveContext, loadContext } from '../context.js';
import { type DockerRunOptions, dockerRun, dockerFixPermissions } from '../exec.js';
import { Stage } from '../enums.js';
import { BUILD_IMAGE, MEASURE_IMAGE } from './docker-image.js';
import { banner, info, debug } from '../log.js';

// ── Stage → Container Classification ─────────────────────────────────────────

type ContainerTarget = 'host' | 'build' | 'measure';

const STAGE_CONTAINER: Record<Stage, ContainerTarget> = {
    [Stage.DockerImage]: 'host',
    [Stage.EnumerateCommits]: 'build',
    [Stage.EnumerateDailyPacks]: 'build',
    [Stage.EnumerateReleasePacks]: 'build',
    [Stage.AcquireSdk]: 'build',
    [Stage.Build]: 'build',
    [Stage.Measure]: 'measure',
    [Stage.Consolidate]: 'host',
    [Stage.Schedule]: 'host',
    [Stage.TransformViews]: 'host',
};

// ── Stage Batching ───────────────────────────────────────────────────────────

interface StageBatch {
    target: ContainerTarget;
    stages: Stage[];
}

/** Group consecutive stages that run in the same container. */
function batchStages(stages: Stage[]): StageBatch[] {
    const batches: StageBatch[] = [];
    for (const stage of stages) {
        const target = STAGE_CONTAINER[stage];
        const last = batches[batches.length - 1];
        if (last && last.target === target) {
            last.stages.push(stage);
        } else {
            batches.push({ target, stages: [stage] });
        }
    }
    return batches;
}

// ── Container CLI Argument Builder ───────────────────────────────────────────

/**
 * Build CLI arguments for the bench CLI invocation inside the container.
 * Forwards all relevant config so the container's buildContext() produces
 * an equivalent BenchContext (with container-appropriate paths).
 */
function buildContainerArgs(ctx: BenchContext, stages: Stage[], contextPath: string): string[] {
    const args: string[] = [
        'bench/src/main.ts',
        '--stages', stages.join(','),
        '--context', contextPath,
        '--sdk-channel', ctx.sdkChannel,
        '--runtime', ctx.runtime,
        '--retries', String(ctx.retries),
        '--timeout', String(ctx.timeout),
        '--warm-runs', String(ctx.warmRuns),
        '--major', String(ctx.major),
        '--months', String(ctx.months),
        '--release-majors', ctx.releaseMajors.join(','),
    ];
    if (ctx.sdkVersion) args.push('--sdk-version', ctx.sdkVersion);
    if (ctx.runtimePack) args.push('--runtime-pack', ctx.runtimePack);
    if (ctx.runtimeCommit) args.push('--runtime-commit', ctx.runtimeCommit);
    if (ctx.apps.length > 0) args.push('--app', ctx.apps.join(','));
    if (ctx.presets.length > 0) args.push('--preset', ctx.presets.join(','));
    if (ctx.engines.length > 0) args.push('--engine', ctx.engines.join(','));
    if (ctx.profiles.length > 0) args.push('--profile', ctx.profiles.join(','));
    if (!ctx.headless) args.push('--no-headless');
    if (ctx.dryRun) args.push('--dry-run');
    if (ctx.verbose) args.push('--verbose');
    if (ctx.forceEnumerate) args.push('--force-enumerate');
    return args;
}

// ── Container Environment Variables ──────────────────────────────────────────

function buildContainerEnv(): Record<string, string> {
    const env: Record<string, string> = {
        REPO_ROOT: '/bench',
        ARTIFACTS_DIR: '/bench/artifacts',
        NUGET_PACKAGES: '/bench/artifacts/nuget-packages',
        DOTNET_NOLOGO: 'true',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    };
    // Forward GitHub auth tokens for enumerate stages
    if (process.env['GITHUB_TOKEN']) env['GITHUB_TOKEN'] = process.env['GITHUB_TOKEN'];
    if (process.env['GH_TOKEN']) env['GH_TOKEN'] = process.env['GH_TOKEN'];
    return env;
}

// ── Fix Permissions ──────────────────────────────────────────────────────────

async function fixArtifactPermissions(artifactsDir: string): Promise<void> {
    const dirs = ['sdks', 'publish', 'results', 'nuget-packages'];
    for (const d of dirs) {
        await dockerFixPermissions(BUILD_IMAGE, join(artifactsDir, d));
    }
}

// ── Main Docker Wrapper ─────────────────────────────────────────────────────

/**
 * Orchestrate stage execution via Docker containers.
 *
 * Stages are classified into three targets:
 *   - **host**: runs directly (docker-image, consolidate, schedule, transform-views)
 *   - **build**: runs in BUILD_IMAGE (enumerate-*, acquire-sdk, build)
 *   - **measure**: runs in MEASURE_IMAGE (measure)
 *
 * Consecutive stages with the same target are batched into a single container
 * invocation. Context is serialized to a JSON file and passed via --context
 * for cross-container handoff.
 */
export async function runStagesViaDocker(
    ctx: BenchContext,
    runDirect: (ctx: BenchContext) => Promise<BenchContext>,
): Promise<BenchContext> {
    // Step 0: Ensure Docker images exist (auto-build unless --skip-docker-build)
    if (!ctx.skipDockerBuild) {
        const { run: buildImages } = await import('./docker-image.js');
        await buildImages(ctx);
    } else {
        info('Docker image build skipped (--skip-docker-build)');
    }

    // Filter out docker-image stage (already handled) and batch the rest
    const effectiveStages = ctx.stages.filter(s => s !== Stage.DockerImage);
    if (effectiveStages.length === 0) return ctx;

    const batches = batchStages(effectiveStages);
    let current = ctx;

    const contextFile = join(ctx.artifactsDir, 'docker-context.json');
    const containerContextFile = '/bench/artifacts/docker-context.json';

    for (const batch of batches) {
        if (batch.target === 'host') {
            // Run host stages directly (without docker wrapping)
            const hostCtx: BenchContext = { ...current, stages: batch.stages, viaDocker: false };
            current = await runDirect(hostCtx);
            current = { ...current, viaDocker: true };
        } else {
            const image = batch.target === 'build' ? BUILD_IMAGE : MEASURE_IMAGE;
            const stageNames = batch.stages.join(', ');
            banner(`Docker [${batch.target}]: ${stageNames}`);

            // Persist context for container consumption
            await saveContext(current, contextFile);

            // Build container invocation.
            // The Docker image's entrypoint.sh populates /bench/node_modules
            // with symlinks to /opt/bench-deps/node_modules/*, so ESM import()
            // resolves packages correctly (it doesn't honour NODE_PATH).
            const cliArgs = buildContainerArgs(current, batch.stages, containerContextFile);
            const cmd = ['tsx', ...cliArgs];
            const env = buildContainerEnv();

            const dockerOpts: DockerRunOptions = {
                volumes: [{ host: ctx.repoRoot, container: '/bench' }],
                cwd: '/bench',
                env,
                // Hide host's node_modules (may contain incompatible platform-specific
                // binaries). Container resolves npm packages via NODE_PATH from the
                // image's /opt/bench-deps/node_modules instead.
                extraArgs: ['--tmpfs', '/bench/node_modules'],
                label: `${batch.target}: ${stageNames}`,
            };

            // Measure container runs as non-root user (Firefox requirement)
            if (batch.target === 'measure') {
                const uid = process.getuid?.() ?? 1001;
                const gid = process.getgid?.() ?? 1001;
                dockerOpts.user = `${uid}:${gid}`;
            }

            info(`Image: ${image}`);
            if (ctx.verbose) debug(`Command: tsx ${cliArgs.join(' ')}`);

            await dockerRun(image, cmd, dockerOpts);

            // Fix permissions on Docker-created artifacts (only on Linux;
            // WSL bind-mounts inherit host permissions so this is a no-op
            // on Windows and just hangs due to slow container spin-up).
            if (ctx.platform === 'linux') {
                await fixArtifactPermissions(ctx.artifactsDir);
            }

            // Load updated context from container
            current = await loadContext(contextFile);
            current = { ...current, viaDocker: true };

            info(`Docker [${batch.target}] completed`);
        }
    }

    return current;
}
