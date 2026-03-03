#!/usr/bin/env node
/**
 * run-pipeline.mjs — Single-container benchmark orchestrator.
 *
 * Runs all build + measurement steps in one container to avoid redundant
 * SDK/workload downloads across matrix jobs.
 *
 * Pipeline phases:
 *   1. Resolve / install .NET SDK
 *   2. Validate that wasm-tools workload is NOT yet installed
 *   3. For all apps × non-workload presets → build
 *   4. Install wasm-tools workload, capture version in sdk-info.json
 *   5. For all apps × workload presets → build
 *   6. For all engines × apps × presets → run measurements
 *
 * Usage:
 *   node scripts/run-pipeline.mjs [options]
 *
 * Options:
 *   --sdk-channel <ch>       SDK channel (default: 11.0)
 *   --sdk-version <ver>      Specific SDK version (default: latest from channel)
 *   --runtime <rt>           Runtime to benchmark (default: mono)
 *   --ci-run-id <id>         GitHub Actions run ID (optional)
 *   --ci-run-url <url>       GitHub Actions run URL (optional)
 *   --timeout <ms>           Measurement timeout in ms (default: 300000)
 *   --retries <n>            Measurement retries (default: 3)
 *   --dry-run                Skip measurement, only build
 */

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPresetGroups, validateCombination } from './lib/build-config.mjs';
import { parseWorkloadVersion, isWorkloadInstalled } from './lib/sdk-info.mjs';

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'sdk-channel': { type: 'string', default: '11.0' },
        'sdk-version': { type: 'string', default: '' },
        'runtime': { type: 'string', default: 'mono' },
        'ci-run-id': { type: 'string', default: '' },
        'ci-run-url': { type: 'string', default: '' },
        'timeout': { type: 'string', default: '300000' },
        'retries': { type: 'string', default: '3' },
        'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
});

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const REPO_DIR = resolve(SCRIPT_DIR, '..');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || join(REPO_DIR, 'artifacts');
const APPS_DIR = join(REPO_DIR, 'apps');
const SDK_INFO_PATH = join(ARTIFACTS_DIR, 'sdk', 'sdk-info.json');

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, cmdArgs, { label, env: extraEnv } = {}) {
    const displayCmd = `${cmd} ${cmdArgs.join(' ')}`;
    console.error(`\n▶ ${label || displayCmd}`);
    try {
        execFileSync(cmd, cmdArgs, {
            stdio: 'inherit',
            env: { ...process.env, ...extraEnv },
            cwd: REPO_DIR,
        });
    } catch (err) {
        console.error(`✗ Failed: ${label || displayCmd}`);
        throw err;
    }
}

function runCapture(cmd, cmdArgs) {
    return execFileSync(cmd, cmdArgs, {
        encoding: 'utf-8',
        env: process.env,
        cwd: REPO_DIR,
    }).trim();
}

function dotnet() {
    const p = join(ARTIFACTS_DIR, 'sdk', 'dotnet');
    try {
        execFileSync(p, ['--version'], { stdio: 'ignore' });
        return p;
    } catch {
        return 'dotnet';
    }
}

/** Discover app directories under apps/ (each dir with a .csproj). */
async function discoverApps() {
    const entries = await readdir(APPS_DIR, { withFileTypes: true });
    const apps = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const appDir = join(APPS_DIR, entry.name);
        const files = await readdir(appDir);
        if (files.some(f => f.endsWith('.csproj'))) {
            apps.push(entry.name);
        }
    }
    apps.sort();
    return apps;
}

// ── Phase 1: Resolve SDK ────────────────────────────────────────────────────

async function resolveSDK() {
    console.error('\n═══ Phase 1: Resolve .NET SDK ═══');
    run('bash', [
        join(SCRIPT_DIR, 'resolve-sdk.sh'),
        args['sdk-channel'],
        args['sdk-version'],
    ], { label: `resolve-sdk.sh ${args['sdk-channel']} ${args['sdk-version']}` });

    // Update process.env so child processes (build-app.sh, dotnet) find the SDK
    const sdkDir = join(ARTIFACTS_DIR, 'sdk');
    process.env.DOTNET_ROOT = sdkDir;
    process.env.PATH = `${sdkDir}:${process.env.PATH}`;
}

// ── Phase 2: Validate no workload installed ─────────────────────────────────

async function validateNoWorkload() {
    console.error('\n═══ Phase 2: Validate wasm-tools workload is NOT installed ═══');
    const dotnetPath = dotnet();
    const output = runCapture(dotnetPath, ['workload', 'list']);
    if (isWorkloadInstalled(output)) {
        throw new Error(
            'wasm-tools workload is already installed before non-workload builds. '
            + 'The SDK should not have a workload pre-installed.\n'
            + `dotnet workload list output:\n${output}`
        );
    }
    console.error('✓ Confirmed: wasm-tools workload is NOT installed');
}

// ── Phase 3 / 5: Build apps ─────────────────────────────────────────────────

async function buildApps(apps, presets, phaseLabel) {
    console.error(`\n═══ ${phaseLabel} ═══`);
    const runtime = args.runtime;
    for (const app of apps) {
        for (const preset of presets) {
            // Skip invalid combinations
            try {
                validateCombination(runtime, preset);
            } catch {
                console.error(`  Skipping invalid combination: ${runtime} + ${preset}`);
                continue;
            }
            run('bash', [
                join(SCRIPT_DIR, 'build-app.sh'),
                app,
                runtime,
                preset,
            ], { label: `build ${app} (${runtime}/${preset})` });
        }
    }
}

// ── Phase 4: Install workload & capture version ─────────────────────────────

async function installWorkload() {
    console.error('\n═══ Phase 4: Install wasm-tools workload ═══');
    const dotnetPath = dotnet();

    run(dotnetPath, ['workload', 'install', 'wasm-tools'], {
        label: 'dotnet workload install wasm-tools',
    });

    // Verify and capture version
    const output = runCapture(dotnetPath, ['workload', 'list']);
    const workloadVersion = parseWorkloadVersion(output);
    if (!workloadVersion) {
        throw new Error(
            'wasm-tools workload was not found after install.\n'
            + `dotnet workload list output:\n${output}`
        );
    }
    console.error(`✓ wasm-tools workload installed: ${workloadVersion}`);

    // Update sdk-info.json with workload version
    const sdkInfo = JSON.parse(await readFile(SDK_INFO_PATH, 'utf-8'));
    sdkInfo.workloadVersion = workloadVersion;
    await writeFile(SDK_INFO_PATH, JSON.stringify(sdkInfo, null, 2) + '\n');
    console.error(`✓ Updated sdk-info.json with workloadVersion: ${workloadVersion}`);
}

// ── Phase 6: Run measurements ───────────────────────────────────────────────

async function runMeasurements(apps, presets) {
    console.error('\n═══ Phase 6: Run measurements ═══');
    const runtime = args.runtime;
    const sdkInfo = JSON.parse(await readFile(SDK_INFO_PATH, 'utf-8'));
    const runtimeHash = sdkInfo.runtimeGitHash || sdkInfo.gitHash || '';
    const runtimeHash7 = runtimeHash.slice(0, 7);
    const commitTime = sdkInfo.commitTime;

    // Engines: for browser apps use chrome; future: could expand
    const engines = ['chrome'];

    for (const engine of engines) {
        for (const app of apps) {
            for (const preset of presets) {
                // Skip invalid combinations
                try {
                    validateCombination(runtime, preset);
                } catch {
                    continue;
                }

                const filename = `${commitTime}_${runtimeHash7}_${runtime}_${preset}_${engine}_${app}.json`;
                const publishDir = join(ARTIFACTS_DIR, 'publish', app, 'wwwroot');
                const compileTimeFile = join(ARTIFACTS_DIR, 'results', 'compile-time.json');
                const outputFile = join(ARTIFACTS_DIR, 'results', filename);

                run('node', [
                    join(SCRIPT_DIR, 'measure-external.mjs'),
                    '--app', app,
                    '--publish-dir', publishDir,
                    '--sdk-info', SDK_INFO_PATH,
                    '--compile-time-file', compileTimeFile,
                    '--runtime', runtime,
                    '--preset', preset,
                    '--retries', args.retries,
                    '--timeout', args.timeout,
                    ...(args['ci-run-id'] ? ['--ci-run-id', args['ci-run-id']] : []),
                    ...(args['ci-run-url'] ? ['--ci-run-url', args['ci-run-url']] : []),
                    '--output', outputFile,
                ], { label: `measure ${app} (${runtime}/${preset}/${engine})` });
            }
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.error('╔═══════════════════════════════════════════════╗');
    console.error('║       Benchmark Pipeline — Single Container  ║');
    console.error('╚═══════════════════════════════════════════════╝');

    const { nonWorkload, workload } = getPresetGroups();
    const allPresets = [...nonWorkload, ...workload];

    // Phase 1: Install SDK
    await resolveSDK();

    // Phase 2: Validate no workload pre-installed (ensures clean SDK image)
    await validateNoWorkload();

    // Discover apps
    const apps = await discoverApps();
    console.error(`\nDiscovered apps: ${apps.join(', ')}`);

    // Phase 3: Build non-workload presets (no wasm-tools needed)
    await buildApps(apps, nonWorkload, 'Phase 3: Build non-workload presets');

    // Phase 4: Install workload + capture version
    await installWorkload();

    // Phase 5: Build workload/native presets (WasmBuildNative=true / AOT / etc.)
    await buildApps(apps, workload, 'Phase 5: Build workload/native presets');

    // Phase 6: Run measurements (unless dry-run)
    if (args['dry-run']) {
        console.error('\n⚠ Dry run — skipping measurements');
    } else {
        await runMeasurements(apps, allPresets);
    }

    console.error('\n✓ Pipeline complete');
}

main().catch(err => {
    console.error(`\n✗ Pipeline failed: ${err.message}`);
    process.exit(1);
});
