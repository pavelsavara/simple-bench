#!/usr/bin/env node
/**
 * run-measure-job.mjs — Run measurements for one app×preset (all engines).
 *
 * Designed for CI matrix jobs. Given a single app+preset, determines the
 * applicable engines and runs measure-external.mjs or measure-internal.mjs
 * for each. No .NET SDK required — only the published binaries.
 *
 * Usage:
 *   node scripts/run-measure-job.mjs \
 *     --app empty-browser --preset debug \
 *     --publish-dir artifacts/publish/empty-browser/debug \
 *     --sdk-info artifacts/sdk/sdk-info.json \
 *     --output-dir artifacts/results \
 *     --runtime mono \
 *     [--dry-run] [--timeout 300000] [--retries 3] \
 *     [--ci-run-id 123] [--ci-run-url https://...]
 */

import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ── Engine routing ──────────────────────────────────────────────────────────

/** Apps that require a browser (DOM, fetch, service workers). */
const BROWSER_ONLY_APPS = new Set(['empty-blazor']);

/** Apps measured with measure-internal.mjs; everything else uses measure-external.mjs. */
const INTERNAL_APPS = new Set(['microbenchmarks']);

const ALL_BROWSER_ENGINES = ['chrome', 'firefox'];
const ALL_CLI_ENGINES = ['v8', 'node'];

function getEnginesForApp(app, isDryRun) {
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
        'output-dir': { type: 'string' },
        'runtime': { type: 'string', default: 'mono' },
        'timeout': { type: 'string', default: '300000' },
        'retries': { type: 'string', default: '3' },
        'dry-run': { type: 'boolean', default: false },
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

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const app = args.app;
const preset = args.preset;
const runtime = args.runtime;
const publishDir = resolve(args['publish-dir']);
const sdkInfoPath = resolve(args['sdk-info']);
const outputDir = resolve(args['output-dir']);

// ── Read SDK info for result filenames ──────────────────────────────────────

const sdkInfo = JSON.parse(await readFile(sdkInfoPath, 'utf-8'));
const runtimeHash7 = (sdkInfo.runtimeGitHash || sdkInfo.gitHash || '').slice(0, 7);
const commitTime = sdkInfo.commitTime;

await mkdir(outputDir, { recursive: true });

// ── Determine engines and script ────────────────────────────────────────────

const engines = getEnginesForApp(app, args['dry-run']);
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

    const scriptArgs = [
        join(SCRIPT_DIR, measureScript),
        '--publish-dir', wwwrootDir,
        '--engine', engine,
        '--output', outputFile,
        '--runtime', runtime,
        '--preset', preset,
        '--sdk-info', sdkInfoPath,
        '--compile-time-file', compileTimeFile,
        '--retries', args.retries,
        '--timeout', args.timeout,
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
