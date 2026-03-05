#!/usr/bin/env node
/**
 * run-measure-job.mjs — Run measurements for one app×preset (all engines).
 *
 * Designed for CI matrix jobs. Given a single app+preset, determines the
 * applicable engines and runs measure-external.mjs or measure-internal.mjs
 * for each. No .NET SDK required — only the published binaries.
 *
 * When --build-manifest is provided, verifies the integrity of the downloaded
 * build artifacts (file count + total size) before measuring.
 *
 * Usage:
 *   node scripts/run-measure-job.mjs \
 *     --app empty-browser --preset devloop \
 *     --publish-dir artifacts/publish/empty-browser/devloop \
 *     --sdk-info artifacts/sdks/sdk-info.json \
 *     --build-manifest artifacts/results/build-manifest.json \
 *     --output-dir artifacts/results \
 *     --runtime mono \
 *     [--dry-run] [--timeout 300000] [--retries 3] \
 *     [--ci-run-id 123] [--ci-run-url https://...]
 */

import { parseArgs } from 'node:util';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ── Engine routing ──────────────────────────────────────────────────────────

/** Apps that require a browser (DOM, fetch, service workers). */
const BROWSER_ONLY_APPS = new Set(['empty-blazor', 'blazing-pizza', 'try-mud-blazor']);

/** Apps measured with measure-internal.mjs; everything else uses measure-external.mjs. */
const INTERNAL_APPS = new Set(['microbenchmarks']);

const ALL_BROWSER_ENGINES = ['chrome', 'firefox'];
const ALL_CLI_ENGINES = ['v8', 'node'];

function getEnginesForApp(app, isDryRun, engineFilter) {
    // If explicit engine filter provided, use it (comma-separated)
    if (engineFilter) {
        return engineFilter.split(',').map(s => s.trim());
    }
    if (isDryRun) return ['chrome'];
    if (BROWSER_ONLY_APPS.has(app)) return ALL_BROWSER_ENGINES;
    return [...ALL_BROWSER_ENGINES, ...ALL_CLI_ENGINES];
}

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'app': { type: 'string' },
        'preset': { type: 'string' },
        'publish-dir': { type: 'string' },
        'sdk-info': { type: 'string' },
        'build-manifest': { type: 'string', default: '' },
        'output-dir': { type: 'string' },
        'runtime': { type: 'string', default: 'mono' },
        'timeout': { type: 'string', default: '300000' },
        'retries': { type: 'string', default: '3' },
        'dry-run': { type: 'boolean', default: false },
        'engine': { type: 'string', default: '' },
        'ci-run-id': { type: 'string', default: '' },
        'ci-run-url': { type: 'string', default: '' },
    },
    strict: true,
});

const required = ['app', 'preset', 'publish-dir', 'sdk-info', 'output-dir'];
for (const name of required) {
    if (!args[name]) {
        console.error(`Missing required argument: --${name}`);
        process.exit(1);
    }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const app = args.app;
const preset = args.preset;
const runtime = args.runtime;
const publishDir = resolve(args['publish-dir']);
const sdkInfoPath = resolve(args['sdk-info']);
const outputDir = resolve(args['output-dir']);

// ── Integrity verification ──────────────────────────────────────────────────

async function computeIntegrity(dir) {
    let fileCount = 0;
    let totalBytes = 0;
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parentPath = entry.parentPath || entry.path;
        const fullPath = join(parentPath, entry.name);
        const fileStat = await stat(fullPath);
        fileCount++;
        totalBytes += fileStat.size;
    }
    return { fileCount, totalBytes };
}

async function verifyIntegrity() {
    if (!args['build-manifest']) return;

    let manifest;
    try {
        manifest = JSON.parse(await readFile(resolve(args['build-manifest']), 'utf-8'));
    } catch (err) {
        console.error(`⚠ Could not read build manifest: ${err.message}`);
        return;
    }

    const entry = manifest.find(e => e.app === app && e.preset === preset);
    if (!entry || !entry.integrity) {
        console.error(`⚠ No integrity data in manifest for ${app}/${preset}`);
        return;
    }

    const expected = entry.integrity;
    const actual = await computeIntegrity(publishDir);

    console.error(`Integrity check: expected ${expected.fileCount} files / ${expected.totalBytes} bytes`);
    console.error(`Integrity check: actual   ${actual.fileCount} files / ${actual.totalBytes} bytes`);

    if (actual.fileCount !== expected.fileCount || actual.totalBytes !== expected.totalBytes) {
        console.error(`✗ INTEGRITY MISMATCH for ${app}/${preset}!`);
        console.error(`  File count: expected=${expected.fileCount} actual=${actual.fileCount}`);
        console.error(`  Total bytes: expected=${expected.totalBytes} actual=${actual.totalBytes}`);
        process.exit(1);
    }
    console.error(`✓ Integrity verified for ${app}/${preset}`);
}

// ── Read SDK info for result filenames ──────────────────────────────────────

const sdkInfo = JSON.parse(await readFile(sdkInfoPath, 'utf-8'));
const rawHash = sdkInfo.runtimeGitHash || sdkInfo.gitHash || '';
const runtimeHash7 = /^[0-9a-f]+$/i.test(rawHash) ? rawHash.slice(0, 7) : '0000000';
const commitTime = sdkInfo.commitTime;

await mkdir(outputDir, { recursive: true });

// ── Verify build artifact integrity ─────────────────────────────────────────

await verifyIntegrity();

// ── Determine engines and script ────────────────────────────────────────────

const engines = getEnginesForApp(app, args['dry-run'], args.engine);
const isInternal = INTERNAL_APPS.has(app);
const measureScript = isInternal ? 'measure-internal.mjs' : 'measure-external.mjs';

console.error(`App: ${app}, Preset: ${preset}, Engines: ${engines.join(', ')}`);
console.error(`Script: ${measureScript}`);

// ── Run measurements for each engine ────────────────────────────────────────

const wwwrootDir = join(publishDir, 'wwwroot');
const compileTimeFile = join(publishDir, 'compile-time.json');
let failCount = 0;

for (const engine of engines) {
    const filename = `${commitTime}_${runtimeHash7}_${runtime}_${preset}_${engine}_${app}.json`;
    const outputFile = join(outputDir, filename);

    const isDryRun = args['dry-run'];
    const retries = isDryRun ? '1' : args.retries;
    const timeoutVal = isDryRun ? String(Math.min(parseInt(args.timeout, 10), 55000)) : args.timeout;

    const scriptArgs = [
        join(SCRIPT_DIR, measureScript),
        '--publish-dir', wwwrootDir,
        '--engine', engine,
        '--output', outputFile,
        '--runtime', runtime,
        '--preset', preset,
        '--sdk-info', sdkInfoPath,
        '--compile-time-file', compileTimeFile,
        '--retries', retries,
        '--timeout', timeoutVal,
        ...(isDryRun && !isInternal ? ['--warm-runs', '1'] : []),
        ...(args['ci-run-id'] ? ['--ci-run-id', args['ci-run-id']] : []),
        ...(args['ci-run-url'] ? ['--ci-run-url', args['ci-run-url']] : []),
    ];

    // measure-external.mjs also needs --app
    if (!isInternal) {
        scriptArgs.push('--app', app);
    }

    console.error(`\n▶ measure ${app} (${runtime}/${preset}/${engine})`);
    try {
        execFileSync('node', scriptArgs, {
            stdio: 'inherit',
            env: process.env,
        });
    } catch (err) {
        console.error(`✗ Measurement failed for ${engine}: ${err.message}`);
        failCount++;
    }
}

console.error(`\n✓ Measurements complete: ${engines.length - failCount}/${engines.length} engines succeeded`);
if (failCount > 0) {
    process.exit(1);
}
