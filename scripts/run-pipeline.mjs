#!/usr/bin/env node
/**
 * run-pipeline.mjs — Build orchestrator for benchmark pipeline.
 *
 * Builds all sample apps inside a single container to avoid redundant
 * SDK/workload downloads. Produces a build-manifest.json with the matrix
 * of successful builds, compile times, and integrity checksums.
 *
 * Pipeline phases:
 *   1. Resolve / install .NET SDK
 *   2. Validate that wasm-tools workload is NOT yet installed
 *   3. For all apps × non-workload presets → build
 *   4. Install wasm-tools workload, capture version in sdk-info.json
 *   5. For all apps × workload presets → build
 *   6. Write build-manifest.json (matrix + compile-time + integrity)
 *
 * Usage:
 *   node scripts/run-pipeline.mjs [options]
 *
 * Options:
 *   --sdk-channel <ch>       SDK channel (default: 11.0)
 *   --sdk-version <ver>      Specific SDK version (default: latest from channel)
 *   --runtime <rt>           Runtime to benchmark (default: mono)
 *   --dry-run                Build only empty-browser app (fast validation)
 */

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPresetGroups, validateCombination } from './lib/build-config.mjs';
import { parseWorkloadVersion, isWorkloadInstalled } from './lib/sdk-info.mjs';
import { resolveRuntimePack } from './lib/runtime-pack-resolver.mjs';

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'sdk-channel': { type: 'string', default: '11.0' },
        'sdk-version': { type: 'string', default: '' },
        'runtime': { type: 'string', default: 'mono' },
        'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
});

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const REPO_DIR = resolve(SCRIPT_DIR, '..');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || join(REPO_DIR, 'artifacts');
const APPS_DIR = join(REPO_DIR, 'src');
const SDK_INFO_PATH = join(ARTIFACTS_DIR, 'sdk', 'sdk-info.json');

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, cmdArgs, { label, env: extraEnv } = {}) {
    const displayCmd = `${cmd} ${cmdArgs.join(' ')}`;
    console.error(`\n▶ ${label || displayCmd}`);
    try {
        execFileSync(cmd, cmdArgs, {
            stdio: ['inherit', process.stderr, 'inherit'],
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

/** Discover app directories under src/ (each dir with a .csproj). */
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
    const succeeded = [];
    for (const app of apps) {
        for (const preset of presets) {
            // Skip invalid combinations
            try {
                validateCombination(runtime, preset);
            } catch {
                console.error(`  Skipping invalid combination: ${runtime} + ${preset}`);
                continue;
            }
            try {
                run('bash', [
                    join(SCRIPT_DIR, 'build-app.sh'),
                    app,
                    runtime,
                    preset,
                ], { label: `build ${app} (${runtime}/${preset})` });
                succeeded.push({ app, preset });
            } catch {
                console.error(`  ⚠ Build failed for ${app}/${preset}, skipping`);
            }
        }
    }
    return succeeded;
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

// ── Integrity computation ───────────────────────────────────────────────────

/**
 * Walk a directory and compute file count + total byte size.
 * @param {string} dir Absolute path
 * @returns {Promise<{fileCount: number, totalBytes: number}>}
 */
async function computeIntegrity(dir) {
    let fileCount = 0;
    let totalBytes = 0;
    try {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const parentPath = entry.parentPath || entry.path;
            const fullPath = join(parentPath, entry.name);
            const fileStat = await stat(fullPath);
            fileCount++;
            totalBytes += fileStat.size;
        }
    } catch {
        // directory doesn't exist
    }
    return { fileCount, totalBytes };
}

// ── Build manifest ──────────────────────────────────────────────────────────

/**
 * Enrich build entries with compile-time and integrity data,
 * then write build-manifest.json.
 */
async function writeBuildManifest(builds) {
    console.error('\n═══ Phase 6: Write build manifest ═══');
    const manifest = [];

    for (const { app, preset } of builds) {
        const publishDir = join(ARTIFACTS_DIR, 'publish', app, preset);
        const compileTimePath = join(publishDir, 'compile-time.json');

        // Read compile time
        let compileTimeMs = null;
        try {
            const ct = JSON.parse(await readFile(compileTimePath, 'utf-8'));
            compileTimeMs = typeof ct.compileTimeMs === 'number' ? ct.compileTimeMs : null;
        } catch {
            console.error(`  ⚠ Could not read compile-time.json for ${app}/${preset}`);
        }

        // Compute integrity
        const integrity = await computeIntegrity(publishDir);
        console.error(`  ${app}/${preset}: ${integrity.fileCount} files, ${(integrity.totalBytes / 1024 / 1024).toFixed(1)} MB, compile ${compileTimeMs ?? '?'}ms`);

        manifest.push({ app, preset, compileTimeMs, integrity });
    }

    await mkdir(join(ARTIFACTS_DIR, 'results'), { recursive: true });
    const manifestPath = join(ARTIFACTS_DIR, 'results', 'build-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.error(`\n✓ Build manifest written to ${manifestPath}`);
    return manifest;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.error('╔═══════════════════════════════════════════════╗');
    console.error('║       Benchmark Pipeline — Build              ║');
    console.error('╚═══════════════════════════════════════════════╝');

    const { nonWorkload, workload } = getPresetGroups();

    // Phase 1: Install SDK
    await resolveSDK();

    // Phase 1b: Resolve custom runtime pack (if --runtime-commit specified)
    let customRuntimePackDir = '';
    if (args['runtime-commit']) {
        console.error('\n═══ Phase 1b: Resolve custom runtime pack ═══');
        const result = await resolveRuntimePack(args['runtime-commit'], {
            destDir: join(ARTIFACTS_DIR, 'runtime-packs'),
            strategy: 'closest-after',
        });
        customRuntimePackDir = result.packDir;
        console.error(`✓ Runtime pack resolved: ${result.version} (match: ${result.match})`);
        console.error(`  Pack runtime commit: ${result.runtimeCommit?.substring(0, 12)}`);

        // Update sdk-info.json with runtime pack info
        const sdkInfo = JSON.parse(await readFile(SDK_INFO_PATH, 'utf-8'));
        sdkInfo.runtimeGitHash = result.runtimeCommit || sdkInfo.runtimeGitHash;
        sdkInfo.customRuntimePackVersion = result.version;
        sdkInfo.customRuntimePackMatch = result.match;
        await writeFile(SDK_INFO_PATH, JSON.stringify(sdkInfo, null, 2) + '\n');

        // Set env var for build-app.sh
        process.env.CUSTOM_RUNTIME_PACK_DIR = customRuntimePackDir;
    }

    // Phase 2: Validate no workload pre-installed (ensures clean SDK image)
    await validateNoWorkload();

    // Discover apps
    let apps = await discoverApps();
    if (args['dry-run']) {
        apps = apps.filter(a => a === 'empty-browser');
        console.error(`\nDry-run mode: building only ${apps.join(', ')}`);
    } else {
        console.error(`\nDiscovered apps: ${apps.join(', ')}`);
    }

    // Phase 3: Build non-workload presets (no wasm-tools needed)
    const phase3 = await buildApps(apps, nonWorkload, 'Phase 3: Build non-workload presets');

    // Phase 4: Install workload + capture version
    await installWorkload();

    // Phase 5: Build workload/native presets (WasmBuildNative=true / AOT / etc.)
    const phase5 = await buildApps(apps, workload, 'Phase 5: Build workload/native presets');

    const allSucceeded = [...phase3, ...phase5];
    console.error(`\n✓ ${allSucceeded.length} builds succeeded`);

    // Phase 6: Write build manifest with compile-time + integrity
    await writeBuildManifest(allSucceeded);

    console.error('\n✓ Build pipeline complete');
}

main().catch(err => {
    console.error(`\n✗ Pipeline failed: ${err.message}`);
    process.exit(1);
});
