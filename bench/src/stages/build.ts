import { readFile, writeFile, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type BenchContext, type BuildManifestEntry } from '../context.js';
import {
    type App, type Preset, type Runtime,
    Runtime as R,
    WORKLOAD_PRESETS, NON_WORKLOAD_PRESETS, MONO_ONLY_PRESETS,
    PRESET_MAP, PRESET_CONFIG,
} from '../enums.js';
import { dotnetPublish, dotnetWorkloadInstall, dotnetWorkloadList } from '../exec.js';
import { banner, info, err } from '../log.js';

// ── Runtime flavor mapping ──────────────────────────────────────────────────

function mapRuntimeFlavor(runtime: Runtime): string {
    return runtime === R.CoreCLR ? 'CoreCLR' : 'Mono';
}

// ── Workload detection helpers ───────────────────────────────────────────────

function parseWorkloadVersion(output: string): string | null {
    const match = output.match(/^\s*wasm-tools\s+([\w.\-]+)/m);
    return match ? match[1] : null;
}

function isWorkloadInstalled(output: string): boolean {
    return parseWorkloadVersion(output) !== null;
}

// ── Integrity computation ────────────────────────────────────────────────────

async function computeIntegrity(dir: string): Promise<{ fileCount: number; totalBytes: number }> {
    let fileCount = 0;
    let totalBytes = 0;
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parentPath = entry.parentPath || entry.path;
        const fullPath = join(parentPath, entry.name);
        const s = await stat(fullPath);
        fileCount++;
        totalBytes += s.size;
    }
    return { fileCount, totalBytes };
}

// ── Publish arg builder ──────────────────────────────────────────────────────

function getPublishArgs(
    appDir: string,
    runtime: Runtime,
    preset: Preset,
    publishDir: string,
    buildLabel: string,
    runtimePackDir?: string,
): string[] {
    const args = [
        appDir,
        `/p:BenchmarkPreset=${PRESET_MAP[preset]}`,
        '-c', PRESET_CONFIG[preset],
        `/p:RuntimeFlavor=${mapRuntimeFlavor(runtime)}`,
        `/p:BuildLabel=${buildLabel}`,
        `-bl:${publishDir}/publish.binlog`,
        '-o', publishDir,
    ];
    if (runtimePackDir) {
        args.push(`/p:RuntimePackDir=${runtimePackDir}`);
    }
    return args;
}

// ── Build phase (shared for non-workload and workload presets) ───────────────

async function buildPhase(
    ctx: BenchContext,
    presets: Preset[],
    succeeded: BuildManifestEntry[],
): Promise<void> {
    for (const app of ctx.apps) {
        const appDir = join(ctx.repoRoot, 'src', app);
        for (const preset of presets) {
            if (MONO_ONLY_PRESETS.has(preset) && ctx.runtime === R.CoreCLR) {
                info(`Skipping ${app}/${preset}: ${preset} is mono-only`);
                continue;
            }

            const publishDir = join(ctx.artifactsDir, 'publish', app, ctx.buildLabel!, preset);

            try {
                await rm(publishDir, { recursive: true, force: true });
                await mkdir(publishDir, { recursive: true });

                info(`Building ${app} (runtime=${ctx.runtime}, preset=${preset})`);

                const publishArgs = getPublishArgs(
                    appDir, ctx.runtime, preset, publishDir,
                    ctx.buildLabel!, ctx.runtimePackDir,
                );

                const startTime = performance.now();
                await dotnetPublish(ctx.dotnetBin!, publishArgs, { cwd: ctx.repoRoot });
                const compileTimeMs = Math.round(performance.now() - startTime);

                await writeFile(
                    join(publishDir, 'compile-time.json'),
                    JSON.stringify({ compileTimeMs, app, runtime: ctx.runtime, preset }, null, 2) + '\n',
                );

                const integrity = await computeIntegrity(publishDir);
                info(`  ${app}/${preset}: ${integrity.fileCount} files, ${(integrity.totalBytes / 1024 / 1024).toFixed(1)} MB, ${compileTimeMs}ms`);

                succeeded.push({ app: app as App, preset, runtime: ctx.runtime, compileTimeMs, integrity, publishDir });
            } catch (e) {
                err(`Build failed for ${app}/${preset}: ${e instanceof Error ? e.message : e}`);
            }
        }
    }
}

// ── Stage entry point ────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    // Validate prerequisites
    if (!ctx.sdkInfo) throw new Error('build stage requires ctx.sdkInfo (run acquire-sdk first)');
    if (!ctx.sdkDir) throw new Error('build stage requires ctx.sdkDir (run acquire-sdk first)');
    if (!ctx.dotnetBin) throw new Error('build stage requires ctx.dotnetBin (run acquire-sdk first)');
    if (!ctx.buildLabel) throw new Error('build stage requires ctx.buildLabel (run acquire-sdk first)');
    if (ctx.sdkInfo.runtimePackVersion && !ctx.runtimePackDir) {
        throw new Error('build stage requires ctx.runtimePackDir when runtimePackVersion is set');
    }

    const sdkInfoPath = join(ctx.sdkDir, 'sdk-info.json');

    // Partition presets
    const nonWorkloadPresets = ctx.presets.filter(p => NON_WORKLOAD_PRESETS.has(p));
    const workloadPresets = ctx.presets.filter(p => WORKLOAD_PRESETS.has(p));

    // Validate no pre-installed workload
    banner('Validate wasm-tools workload is NOT installed');
    const wlOutput = await dotnetWorkloadList(ctx.dotnetBin);
    if (isWorkloadInstalled(wlOutput)) {
        if (ctx.isCI) {
            throw new Error(
                'wasm-tools workload is already installed before non-workload builds. '
                + 'The SDK should not have a workload pre-installed.\n'
                + `dotnet workload list output:\n${wlOutput}`,
            );
        }
        info('wasm-tools is already installed (cached SDK). Non-workload results may differ from CI.');
    } else {
        info('Confirmed: wasm-tools workload is NOT installed');
    }

    const succeeded: BuildManifestEntry[] = [];

    // Phase A: Non-workload presets (before wasm-tools install)
    if (nonWorkloadPresets.length > 0) {
        banner('Build non-workload presets');
        await buildPhase(ctx, nonWorkloadPresets, succeeded);
    }

    // Phase: Install workload (only if workload presets are requested)
    if (workloadPresets.length > 0) {
        banner('Install wasm-tools workload');
        await dotnetWorkloadInstall(ctx.dotnetBin, 'wasm-tools', { cwd: ctx.repoRoot });

        const verifyOutput = await dotnetWorkloadList(ctx.dotnetBin);
        const workloadVersion = parseWorkloadVersion(verifyOutput);
        if (!workloadVersion) {
            throw new Error(
                'wasm-tools workload was not found after install.\n'
                + `dotnet workload list output:\n${verifyOutput}`,
            );
        }
        info(`wasm-tools workload installed: ${workloadVersion}`);

        ctx.sdkInfo.workloadVersion = workloadVersion;
        await writeFile(sdkInfoPath, JSON.stringify(ctx.sdkInfo, null, 2) + '\n');

        // Phase B: Workload presets
        banner('Build workload presets');
        await buildPhase(ctx, workloadPresets, succeeded);
    }

    if (succeeded.length === 0) {
        throw new Error('All builds failed — nothing to measure');
    }
    info(`${succeeded.length} builds succeeded`);

    // Generate run ID and write manifest
    const runId = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const resultsDir = join(ctx.artifactsDir, 'results', runId);
    await mkdir(resultsDir, { recursive: true });

    await writeFile(
        join(resultsDir, 'build-manifest.json'),
        JSON.stringify(succeeded, null, 2) + '\n',
    );

    const sdkInfoContent = await readFile(sdkInfoPath, 'utf-8');
    await writeFile(join(resultsDir, 'sdk-info.json'), sdkInfoContent);
    await writeFile(join(ctx.artifactsDir, 'results', '.run-id'), runId);

    info(`Build manifest written to ${resultsDir}`);

    return { ...ctx, buildManifest: succeeded, runId, resultsDir };
}
