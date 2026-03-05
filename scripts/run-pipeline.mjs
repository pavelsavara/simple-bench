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
 *   --runtime-pack <ver>     Specific runtime pack version
 *   --runtime-commit <hash>  Specific dotnet/runtime commit hash
 *   --dry-run                Build only empty-browser app + devloop preset (fast validation)
 *   --app <list>             Comma-separated app filter (e.g. empty-browser,try-mud-blazor)
 *   --preset <list>          Comma-separated preset filter (e.g. devloop,aot)
 */

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPresetGroups, validateCombination } from './lib/build-config.mjs';
import { parseWorkloadVersion, isWorkloadInstalled } from './lib/sdk-info.mjs';
import { refreshRuntimePacks, restoreRuntimePack, PACKAGE_ID } from './lib/runtime-pack-resolver.mjs';
import { resolveSDK } from './lib/resolve-sdk.mjs';
import { buildApp } from './lib/build-app.mjs';

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'sdk-channel': { type: 'string', default: '11.0' },
        'sdk-version': { type: 'string', default: '' },
        'runtime': { type: 'string', default: 'mono' },
        'runtime-commit': { type: 'string', default: '' },
        'runtime-pack': { type: 'string', default: '' },
        'dry-run': { type: 'boolean', default: false },
        'app': { type: 'string', default: '' },
        'preset': { type: 'string', default: '' },
    },
    strict: true,
});

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || join(REPO_DIR, 'artifacts');
const APPS_DIR = join(REPO_DIR, 'src');
const OS_PREFIX = process.platform === 'win32' ? 'windows' : 'linux';
const channelSuffix = args['sdk-version'] ? '' : `.${args['sdk-channel']}`;
let SDK_DIR = `${OS_PREFIX}.sdk${args['sdk-version'] || ''}${channelSuffix}`;
let SDK_INFO_PATH = join(ARTIFACTS_DIR, 'sdks', SDK_DIR, 'sdk-info.json');

// Run ID = UTC timestamp used to namespace results for this pipeline run
const RUN_TIMESTAMP = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
const RESULTS_RUN_DIR = join(ARTIFACTS_DIR, 'results', RUN_TIMESTAMP);

// Parse comma-separated filters into sets (empty = no filter)
const appFilter = args.app ? new Set(args.app.split(',').map(s => s.trim())) : null;
const presetFilter = args.preset ? new Set(args.preset.split(',').map(s => s.trim())) : null;
// In dry-run mode, default to devloop preset only (unless explicit --preset given)
const effectivePresetFilter = presetFilter
    || (args['dry-run'] ? new Set(['devloop']) : null);

// ── Helpers ─────────────────────────────────────────────────────────────────

function runCapture(cmd, cmdArgs) {
    return execFileSync(cmd, cmdArgs, {
        encoding: 'utf-8',
        env: process.env,
        cwd: REPO_DIR,
    }).trim();
}

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

function dotnet() {
    const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    return join(ARTIFACTS_DIR, 'sdks', SDK_DIR, exe);
}

/** Discover app directories under src/ (each dir with a .csproj). */
async function discoverApps() {
    const entries = await readdir(APPS_DIR, { withFileTypes: true });
    const apps = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip variant project directories (used as build-time redirects)
        if (entry.name.endsWith('-v6v7')) continue;
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

async function resolveSDKPhase() {
    console.error('\n═══ Phase 1: Resolve .NET SDK ═══');
    await resolveSDK({
        channel: args['sdk-channel'],
        sdkVersion: args['sdk-version'],
        installDir: join(ARTIFACTS_DIR, 'sdks', SDK_DIR),
    });
}

// ── Phase 2: Validate no workload installed ─────────────────────────────────

async function validateNoWorkload() {
    console.error('\n═══ Phase 2: Validate wasm-tools workload is NOT installed ═══');
    const dotnetPath = dotnet();
    const output = runCapture(dotnetPath, ['workload', 'list']);
    if (isWorkloadInstalled(output)) {
        if (process.env.CI || process.env.GITHUB_ACTIONS) {
            throw new Error(
                'wasm-tools workload is already installed before non-workload builds. '
                + 'The SDK should not have a workload pre-installed.\n'
                + `dotnet workload list output:\n${output}`
            );
        }
        console.error('⚠ wasm-tools workload is already installed (cached SDK). '
            + 'Non-workload build results may differ from CI.');
    } else {
        console.error('✓ Confirmed: wasm-tools workload is NOT installed');
    }
}

// ── Phase 3 / 5: Build apps ─────────────────────────────────────────────────

async function buildApps(apps, presets, phaseLabel, buildLabel) {
    console.error(`\n═══ ${phaseLabel} ═══`);
    const runtime = args.runtime;
    const succeeded = [];
    for (const app of apps) {
        for (const preset of presets) {
            // Apply preset filter
            if (effectivePresetFilter && !effectivePresetFilter.has(preset)) continue;

            // Skip invalid combinations
            try {
                validateCombination(runtime, preset);
            } catch {
                console.error(`  Skipping invalid combination: ${runtime} + ${preset}`);
                continue;
            }
            try {
                await buildApp({
                    app,
                    runtime,
                    preset,
                    buildLabel,
                    artifactsDir: ARTIFACTS_DIR,
                    dotnetBin: dotnet(),
                });
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

async function writeBuildManifest(builds, buildLabel) {
    console.error('\n═══ Phase 6: Write build manifest ═══');
    const label = buildLabel || 'local';
    const manifest = [];

    for (const { app, preset } of builds) {
        const publishDir = join(ARTIFACTS_DIR, 'publish', app, label, preset);
        const compileTimePath = join(publishDir, 'compile-time.json');

        let compileTimeMs = null;
        try {
            const ct = JSON.parse(await readFile(compileTimePath, 'utf-8'));
            compileTimeMs = typeof ct.compileTimeMs === 'number' ? ct.compileTimeMs : null;
        } catch {
            console.error(`  ⚠ Could not read compile-time.json for ${app}/${preset}`);
        }

        const integrity = await computeIntegrity(publishDir);
        console.error(`  ${app}/${preset}: ${integrity.fileCount} files, ${(integrity.totalBytes / 1024 / 1024).toFixed(1)} MB, compile ${compileTimeMs ?? '?'}ms`);

        manifest.push({ app, preset, compileTimeMs, integrity });
    }

    await mkdir(RESULTS_RUN_DIR, { recursive: true });
    const manifestPath = join(RESULTS_RUN_DIR, 'build-manifest.json');
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

    // Phase 0: Resolve runtime pack version and matching SDK (catalog lookup only, no download)
    let runtimePackVersion = null;
    let runtimeGitHash = null;
    if (args['runtime-pack'] || args['runtime-commit']) {
        console.error('\n═══ Phase 0: Resolve runtime pack version ═══');

        // Refresh artifacts/runtime-packs.json catalog
        try { await refreshRuntimePacks({ artifactsDir: ARTIFACTS_DIR }); } catch (e) {
            console.error(`  Warning: runtime packs refresh failed: ${e.message}`);
        }

        const packsData = JSON.parse(await readFile(join(ARTIFACTS_DIR, 'runtime-packs.json'), 'utf-8'));
        const versions = packsData.versions || [];

        if (args['runtime-pack']) {
            // Explicit --runtime-pack: look up by version
            runtimePackVersion = args['runtime-pack'];
            const entry = versions.find(e => e.runtimePackVersion === runtimePackVersion);
            if (entry) {
                runtimeGitHash = entry.runtimeGitHash || null;
                console.error(`  Using explicit runtime pack: ${runtimePackVersion}`);
                if (runtimeGitHash) console.error(`  Runtime commit: ${runtimeGitHash.substring(0, 12)}`);
            } else {
                console.error(`  ⚠ Pack ${runtimePackVersion} not in catalog (will attempt restore anyway)`);
            }
        } else {
            // --runtime-commit: look up by runtimeGitHash
            runtimeGitHash = args['runtime-commit'];
            const entry = versions.find(e => e.runtimeGitHash?.startsWith(runtimeGitHash));
            if (!entry) {
                throw new Error(
                    `Runtime commit ${runtimeGitHash.substring(0, 12)} not found in artifacts/runtime-packs.json. `
                    + `Run: node scripts/enumerate-runtime-packs.mjs`
                );
            }
            runtimePackVersion = entry.runtimePackVersion;
            console.error(`  Found pack for commit ${runtimeGitHash.substring(0, 12)}: ${runtimePackVersion}`);
        }

        // Look up matching SDK version
        if (!args['sdk-version']) {
            const packEntry = versions.find(e => e.runtimePackVersion === runtimePackVersion)
                || versions.find(e => runtimeGitHash && e.runtimeGitHash === runtimeGitHash);
            if (!packEntry?.sdkVersionOfTheRuntimeBuild) {
                throw new Error(
                    `Could not resolve SDK version for runtime pack ${runtimePackVersion}. `
                    + `No matching entry with sdkVersionOfTheRuntimeBuild found in artifacts/runtime-packs.json.`
                );
            }
            console.error(`  Matched SDK version: ${packEntry.sdkVersionOfTheRuntimeBuild}`);
            args['sdk-version'] = packEntry.sdkVersionOfTheRuntimeBuild;
            SDK_DIR = `${OS_PREFIX}.sdk${packEntry.sdkVersionOfTheRuntimeBuild}`;
            SDK_INFO_PATH = join(ARTIFACTS_DIR, 'sdks', SDK_DIR, 'sdk-info.json');
        }
    }

    // Phase 1: Install SDK (using pack-derived version when applicable)
    await resolveSDKPhase();

    // Phase 1b: Restore runtime pack via dotnet restore (requires SDK)
    if (runtimePackVersion) {
        console.error('\n═══ Phase 1b: Restore runtime pack ═══');
        const dotnetPath = dotnet();
        const nugetPkgsDir = join(ARTIFACTS_DIR, 'nuget-packages');
        const packDir = restoreRuntimePack(dotnetPath, runtimePackVersion, nugetPkgsDir);

        // Update sdk-info.json with runtime pack info
        const sdkInfo = JSON.parse(await readFile(SDK_INFO_PATH, 'utf-8'));
        if (runtimeGitHash) sdkInfo.runtimeGitHash = runtimeGitHash;
        sdkInfo.runtimePackVersion = runtimePackVersion;
        await writeFile(SDK_INFO_PATH, JSON.stringify(sdkInfo, null, 2) + '\n');

        // Set env var for build-app.mjs
        process.env.RUNTIME_PACK_DIR = packDir;
    }

    // Phase 2: Validate no workload pre-installed
    await validateNoWorkload();

    // Discover apps (apply --app filter and --dry-run)
    let apps = await discoverApps();
    if (appFilter) {
        apps = apps.filter(a => appFilter.has(a));
        console.error(`\nApp filter: building ${apps.join(', ')}`);
    } else if (args['dry-run']) {
        apps = apps.filter(a => a === 'empty-browser');
        console.error(`\nDry-run mode: building only ${apps.join(', ')}`);
    } else {
        console.error(`\nDiscovered apps: ${apps.join(', ')}`);
    }

    // Compute buildLabel from sdk-info.json: {sdkVersion}_{runtimePackVersion} or just {sdkVersion}
    const sdkInfoForLabel = JSON.parse(await readFile(SDK_INFO_PATH, 'utf-8'));
    const sdkVer = sdkInfoForLabel.sdkVersion || 'local';
    const buildLabel = sdkInfoForLabel.runtimePackVersion
        ? `${sdkVer}_${sdkInfoForLabel.runtimePackVersion}`
        : sdkVer;

    // Phase 3: Build non-workload presets
    const phase3 = await buildApps(apps, nonWorkload, 'Phase 3: Build non-workload presets', buildLabel);

    // Phase 4: Install workload + capture version
    // Skip workload install if preset filter excludes all workload presets
    const needWorkload = !effectivePresetFilter || workload.some(p => effectivePresetFilter.has(p));
    if (needWorkload) {
        await installWorkload();
    } else {
        console.error('\n═══ Phase 4: Skipping workload install (filtered out) ═══');
    }

    // Phase 5: Build workload/native presets
    const phase5 = needWorkload
        ? await buildApps(apps, workload, 'Phase 5: Build workload/native presets', buildLabel)
        : [];

    const allSucceeded = [...phase3, ...phase5];
    console.error(`\n✓ ${allSucceeded.length} builds succeeded`);

    if (allSucceeded.length === 0) {
        throw new Error('All builds failed — nothing to measure');
    }

    // Phase 6: Write build manifest
    await writeBuildManifest(allSucceeded, buildLabel);

    // Copy sdk-info.json to results run dir for discovery
    const finalSdkInfo = await readFile(SDK_INFO_PATH, 'utf-8');
    await writeFile(join(RESULTS_RUN_DIR, 'sdk-info.json'), finalSdkInfo);

    // Write run-id marker so callers can discover the timestamped dir
    await writeFile(join(ARTIFACTS_DIR, 'results', '.run-id'), RUN_TIMESTAMP);

    console.error(`\n✓ Build pipeline complete (run: ${RUN_TIMESTAMP})`);
}

main().catch(err => {
    console.error(`\n✗ Pipeline failed: ${err.message}`);
    process.exit(1);
});
