#!/usr/bin/env node
/**
 * run-bench.mjs — Unified benchmark orchestrator (local + Docker modes).
 *
 * Replaces the duplicated logic in local-bench.sh and local-docker-bench.sh.
 * Handles: CLI arg parsing, build pipeline invocation, manifest iteration,
 * filtering by app/preset/engine, and measurement invocation.
 *
 * Modes:
 *   --mode local   Run build + measure directly on the host (no Docker)
 *   --mode docker  Wrap build + measure in Docker container invocations
 *
 * Usage:
 *   node scripts/run-bench.mjs --mode local
 *   node scripts/run-bench.mjs --mode local --app try-mud-blazor --engine chrome
 *   node scripts/run-bench.mjs --mode docker --dry-run
 *   node scripts/run-bench.mjs --mode local --skip-build --preset debug
 *
 * Filtering (all comma-separated):
 *   --app <list>          Only build/measure these apps
 *   --preset <list>       Only build/measure these presets
 *   --engine <list>       Only measure with these JS engines (chrome,firefox,v8,node)
 *   --runtime <rt>        Runtime flavor (default: mono)
 *   --sdk-channel <ch>    SDK channel (default: 11.0)
 *   --sdk-version <ver>   Specific SDK version
 *   --runtime-pack <ver>  Specific runtime pack version
 *
 * Flow control:
 *   --skip-build           Skip the build step (reuse artifacts)
 *   --skip-measure         Skip the measure step
 *   --skip-docker          Skip Docker image rebuild (docker mode only)
 *   --step <name>          Run only one step: build | measure | docker-build
 *   --dry-run              Chrome only, debug preset only (unless --app/--preset override)
 *   --retries <n>          Measurement retry count (default: 3)
 *   --timeout <ms>         Per-measurement timeout (default: 300000)
 */

import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'mode': { type: 'string', default: 'local' },
        'skip-build': { type: 'boolean', default: false },
        'skip-measure': { type: 'boolean', default: false },
        'skip-docker': { type: 'boolean', default: false },
        'step': { type: 'string', default: '' },
        'sdk-channel': { type: 'string', default: '11.0' },
        'sdk-version': { type: 'string', default: '' },
        'runtime': { type: 'string', default: 'mono' },
        'runtime-pack': { type: 'string', default: '' },
        'runtime-commit': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'app': { type: 'string', default: '' },
        'preset': { type: 'string', default: '' },
        'engine': { type: 'string', default: '' },
        'retries': { type: 'string', default: '3' },
        'timeout': { type: 'string', default: '300000' },
    },
    strict: true,
});

// ── Step logic ──────────────────────────────────────────────────────────────

if (args.step) {
    args['skip-build'] = true;
    args['skip-measure'] = true;
    switch (args.step) {
        case 'docker-build': args['skip-docker'] = false; break;
        case 'build': args['skip-build'] = false; break;
        case 'measure': args['skip-measure'] = false; break;
        default:
            console.error(`Unknown step: ${args.step} (valid: docker-build, build, measure)`);
            process.exit(1);
    }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || join(REPO_DIR, 'artifacts');
const MANIFEST_PATH = join(ARTIFACTS_DIR, 'results', 'build-manifest.json');
const SDK_INFO_PATH = join(ARTIFACTS_DIR, 'sdk', 'sdk-info.json');

const BUILD_IMAGE = 'browser-bench-build:latest';
const MEASURE_IMAGE = 'browser-bench-measure:latest';

const isDocker = args.mode === 'docker';
const IS_WINDOWS = process.platform === 'win32';

/** Convert a Windows path to WSL /mnt/... path. No-op on non-Windows. */
function toWslPath(winPath) {
    if (!IS_WINDOWS) return winPath;
    const resolved = resolve(winPath);
    const match = resolved.match(/^([A-Za-z]):\\(.*)/);
    if (!match) return resolved.replace(/\\/g, '/');
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
}

/** Execute a docker command, routing through WSL on Windows. */
function dockerExec(dockerArgs, opts = {}) {
    const execOpts = { stdio: 'inherit', cwd: REPO_DIR, ...opts };
    if (IS_WINDOWS) {
        execFileSync('wsl.exe', ['docker', ...dockerArgs], execOpts);
    } else {
        execFileSync('docker', dockerArgs, execOpts);
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function banner(msg) { console.error(`\n\x1b[1;36m═══ ${msg} ═══\x1b[0m`); }
function info(msg) { console.error(`\x1b[0;32m▶ ${msg}\x1b[0m`); }
function err(msg) { console.error(`\x1b[0;31m✗ ${msg}\x1b[0m`); }

function execInherit(cmd, cmdArgs, opts = {}) {
    execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: REPO_DIR, ...opts });
}

/** Run a command inside a Docker container with /bench volume. */
function dockerRun(image, bashCommand, opts = {}) {
    const userArgs = image === MEASURE_IMAGE
        ? ['--user', `${process.getuid?.() ?? 1001}:${process.getgid?.() ?? 1001}`]
        : [];
    const repoMount = toWslPath(REPO_DIR);
    dockerExec([
        'run', '--rm',
        ...userArgs,
        '-v', `${repoMount}:/bench`,
        '-w', '/bench',
        '-e', 'ARTIFACTS_DIR=/bench/artifacts',
        ...(opts.extraArgs || []),
        image,
        'bash', '-c', bashCommand,
    ]);
}

/** Fix ownership on Docker-created artifacts so host user can access them. */
function fixPermissions(...dirs) {
    if (!isDocker) return;
    for (const d of dirs) {
        const target = join(ARTIFACTS_DIR, d);
        const mountPath = toWslPath(target);
        try {
            dockerExec([
                'run', '--rm', '-v', `${mountPath}:/a`, BUILD_IMAGE,
                'chmod', '-R', 'a+rw', '/a',
            ], { stdio: 'pipe' });
        } catch { /* ignore */ }
    }
}

// ── Build pipeline args (shared between modes) ─────────────────────────────

function buildPipelineArgs() {
    const pArgs = [
        '--sdk-channel', args['sdk-channel'],
        '--runtime', args.runtime,
    ];
    if (args['sdk-version']) pArgs.push('--sdk-version', args['sdk-version']);
    if (args['runtime-commit']) pArgs.push('--runtime-commit', args['runtime-commit']);
    if (args.app) pArgs.push('--app', args.app);
    if (args.preset) pArgs.push('--preset', args.preset);
    else if (args['dry-run']) pArgs.push('--preset', 'debug');
    // In dry-run mode without explicit --app filter, pass --dry-run to build
    if (args['dry-run'] && !args.app) pArgs.push('--dry-run');
    return pArgs;
}

// ── Measure job args (shared between modes) ─────────────────────────────────

function measureJobArgs(app, preset, publishDir, sdkInfoPath, manifestPath) {
    const mArgs = [
        '--app', app,
        '--preset', preset,
        '--publish-dir', publishDir,
        '--sdk-info', sdkInfoPath,
        '--build-manifest', manifestPath,
        '--output-dir', isDocker ? '/bench/artifacts/results' : join(ARTIFACTS_DIR, 'results'),
        '--runtime', args.runtime,
        '--retries', args.retries,
        '--timeout', args.timeout,
    ];
    if (args.engine) mArgs.push('--engine', args.engine);
    if (args['dry-run']) mArgs.push('--dry-run');
    return mArgs;
}

// ── Step: Docker image build ────────────────────────────────────────────────

async function stepDockerBuild() {
    banner('Docker image build');
    const dockerfilePath = toWslPath(join(REPO_DIR, 'docker/Dockerfile'));
    const contextPath = toWslPath(REPO_DIR);
    info(`Building ${BUILD_IMAGE}...`);
    dockerExec([
        'build', '--target', 'browser-bench-build',
        '-t', BUILD_IMAGE, '-f', dockerfilePath, contextPath,
    ]);
    info(`Building ${MEASURE_IMAGE}...`);
    dockerExec([
        'build', '--target', 'browser-bench-measure',
        '-t', MEASURE_IMAGE, '-f', dockerfilePath, contextPath,
    ]);
    info('Docker images ready');
}

// ── Step: Build ─────────────────────────────────────────────────────────────

async function stepBuild() {
    banner('Build all apps');

    // Clean previous SDK and publish
    if (isDocker) {
        fixPermissions('sdk', 'publish');
    }
    const { rm } = await import('node:fs/promises');
    await rm(join(ARTIFACTS_DIR, 'sdk'), { recursive: true, force: true });
    await rm(join(ARTIFACTS_DIR, 'publish'), { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    const pArgs = buildPipelineArgs();
    const startTime = Date.now();

    if (isDocker) {
        const cmd = `node scripts/run-pipeline.mjs ${pArgs.map(a => `'${a}'`).join(' ')}`;
        dockerRun(BUILD_IMAGE, cmd);
        fixPermissions('sdk', 'publish', 'results');
    } else {
        execInherit('node', [join(SCRIPT_DIR, 'run-pipeline.mjs'), ...pArgs], {
            env: { ...process.env, ARTIFACTS_DIR },
        });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Verify manifest was created
    try {
        await readFile(MANIFEST_PATH);
    } catch {
        err(`Build manifest not found at ${MANIFEST_PATH}`);
        process.exit(1);
    }

    info(`Build completed in ${elapsed}s`);
    info(`Build manifest: ${await readFile(MANIFEST_PATH, 'utf-8')}`);
    try {
        info(`SDK info: ${await readFile(SDK_INFO_PATH, 'utf-8')}`);
    } catch {
        info('SDK info: not found');
    }
}

// ── Step: Measure ───────────────────────────────────────────────────────────

async function stepMeasure() {
    banner('Run measurements');

    // Verify prerequisites
    try {
        await readFile(SDK_INFO_PATH);
    } catch {
        err('sdk-info.json not found — run the build step first.');
        process.exit(1);
    }

    let manifest;
    try {
        manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'));
    } catch {
        err('Build manifest not found — run the build step first.');
        process.exit(1);
    }

    await mkdir(join(ARTIFACTS_DIR, 'results'), { recursive: true });

    // Parse comma-separated app/preset filters
    const appFilter = args.app ? new Set(args.app.split(',').map(s => s.trim())) : null;
    const presetFilter = args.preset
        ? new Set(args.preset.split(',').map(s => s.trim()))
        : args['dry-run'] ? new Set(['debug']) : null;

    // Filter manifest entries
    const entries = manifest.filter(entry => {
        if (appFilter && !appFilter.has(entry.app)) return false;
        if (presetFilter && !presetFilter.has(entry.preset)) return false;
        return true;
    });

    info(`Measuring ${entries.length} of ${manifest.length} app/preset combinations...`);
    const totalStart = Date.now();
    let failed = 0;

    for (let i = 0; i < entries.length; i++) {
        const { app, preset } = entries[i];
        const prefix = isDocker ? '/bench/artifacts' : ARTIFACTS_DIR;
        const publishDir = `${prefix}/publish/${app}/${preset}`;
        const sdkInfo = isDocker ? '/bench/artifacts/sdk/sdk-info.json' : SDK_INFO_PATH;
        const manifestArg = isDocker
            ? '/bench/artifacts/results/build-manifest.json'
            : MANIFEST_PATH;

        info(`[${i + 1}/${entries.length}] Measuring ${app} / ${preset}...`);
        const stepStart = Date.now();

        const mArgs = measureJobArgs(app, preset, publishDir, sdkInfo, manifestArg);

        try {
            if (isDocker) {
                const cmd = `node scripts/run-measure-job.mjs ${mArgs.map(a => `'${a}'`).join(' ')}`;
                dockerRun(MEASURE_IMAGE, cmd);
                fixPermissions('results');
            } else {
                execInherit('node', [join(SCRIPT_DIR, 'run-measure-job.mjs'), ...mArgs], {
                    env: { ...process.env, ARTIFACTS_DIR },
                });
            }
        } catch {
            err(`Measurement failed for ${app} / ${preset} (continuing...)`);
            failed++;
        }

        const stepElapsed = Math.round((Date.now() - stepStart) / 1000);
        info(`[${i + 1}/${entries.length}] ${app} / ${preset} completed in ${stepElapsed}s`);
    }

    banner('Results');
    const totalElapsed = Math.round((Date.now() - totalStart) / 1000);
    info(`Total measurement time: ${totalElapsed}s`);

    const { readdirSync } = await import('node:fs');
    try {
        const resultFiles = readdirSync(join(ARTIFACTS_DIR, 'results'))
            .filter(f => f.endsWith('.json') && f !== 'build-manifest.json' && f !== 'build-matrix.json');
        if (resultFiles.length > 0) {
            console.error('Result files:');
            for (const f of resultFiles) console.error(`  ${f}`);
        } else {
            console.error('No result files produced.');
        }
    } catch {
        console.error('No result files produced.');
    }

    if (failed > 0) {
        err(`${failed} measurement(s) failed`);
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.error(`╔═══════════════════════════════════════════════╗`);
    console.error(`║  Benchmark Pipeline — ${isDocker ? 'Docker' : 'Local '}               ║`);
    console.error(`╚═══════════════════════════════════════════════╝`);

    info(`Mode: ${args.mode}`);
    if (args.app) info(`App filter: ${args.app}`);
    if (args.preset) info(`Preset filter: ${args.preset}`);
    if (args.engine) info(`Engine filter: ${args.engine}`);
    if (args.runtime !== 'mono') info(`Runtime: ${args.runtime}`);
    if (args['dry-run']) info('Dry-run mode (chrome only, debug preset only)');

    // Docker image build (docker mode only)
    if (isDocker && !args['skip-docker'] && (!args.step || args.step === 'docker-build')) {
        await stepDockerBuild();
    }

    // Build step
    if (!args['skip-build']) {
        await stepBuild();
    } else {
        info('Skipping build (reusing artifacts)');
        try {
            await readFile(MANIFEST_PATH);
        } catch {
            err('No build manifest found. Run the build step first.');
            process.exit(1);
        }
    }

    // Measure step
    if (!args['skip-measure']) {
        await stepMeasure();
    } else {
        info('Skipping measurements');
    }

    console.error('');
    info('Done.');
}

main().catch(e => {
    err(`Pipeline failed: ${e.message}`);
    process.exit(1);
});
