#!/usr/bin/env node
/**
 * measure-internal.mjs — Run internal microbenchmarks on V8/Node/Chrome/Firefox.
 *
 * For browser engines (chrome, firefox): Playwright serves the app and reads results.
 * For CLI engines (v8, node): Runs bench-driver.mjs directly and parses stdout.
 *
 * Usage:
 *   node scripts/measure-internal.mjs \
 *     --publish-dir artifacts/publish/microbenchmarks/wwwroot \
 *     --engine chrome \
 *     --output artifacts/results/result.json \
 *     --runtime mono --preset no-workload \
 *     --sdk-info artifacts/sdk/sdk-info.json \
 *     --compile-time-file artifacts/results/compile-time.json
 *
 * Engines:
 *   chrome   — Playwright Chromium (serves app, reads globalThis.bench_results)
 *   firefox  — Playwright Firefox  (same)
 *   v8       — d8 --module bench-driver.mjs (parses stdout JSON)
 *   node     — node bench-driver.mjs (parses stdout JSON)
 */

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    startStaticServer,
    buildResultJson,
    readCompileTime,
    readSdkInfo,
    loadEndpointsMap,
} from './lib/measure-utils.mjs';
import {
    parseCliOutput,
    getEngineCommand,
    validateBenchResults,
} from './lib/internal-utils.mjs';

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'publish-dir': { type: 'string' },
        'engine': { type: 'string' },
        'output': { type: 'string' },
        'runtime': { type: 'string' },
        'preset': { type: 'string' },
        'sdk-info': { type: 'string' },
        'compile-time-file': { type: 'string', default: '' },
        'timeout': { type: 'string', default: '120000' },
        'retries': { type: 'string', default: '2' },
        'ci-run-id': { type: 'string', default: '' },
        'ci-run-url': { type: 'string', default: '' },
    },
    strict: true,
});

const required = ['publish-dir', 'engine', 'output', 'runtime', 'preset', 'sdk-info'];
for (const name of required) {
    if (!args[name]) {
        console.error(`Missing required argument: --${name}`);
        process.exit(1);
    }
}

const BROWSER_ENGINES = new Set(['chrome', 'firefox']);
const CLI_ENGINES = new Set(['v8', 'node']);

const timeout = parseInt(args.timeout, 10);
const maxRetries = parseInt(args.retries, 10);
const engine = args.engine;
const publishDir = resolve(args['publish-dir']);

if (!BROWSER_ENGINES.has(engine) && !CLI_ENGINES.has(engine)) {
    console.error(`Unknown engine: ${engine}. Expected: chrome, firefox, v8, node`);
    process.exit(1);
}

// ── Read inputs ─────────────────────────────────────────────────────────────

const sdkInfo = await readSdkInfo(args['sdk-info']);
const compileTime = args['compile-time-file']
    ? await readCompileTime(args['compile-time-file'])
    : null;

// ── Run benchmarks ──────────────────────────────────────────────────────────

let benchResults;

if (BROWSER_ENGINES.has(engine)) {
    benchResults = await measureBrowser(engine, publishDir, timeout, maxRetries);
} else {
    benchResults = await measureCli(engine, publishDir, timeout);
}

validateBenchResults(benchResults);

// ── Assemble output ─────────────────────────────────────────────────────────

const meta = {
    commitDate: sdkInfo.commitDate,
    commitTime: sdkInfo.commitTime,
    sdkVersion: sdkInfo.sdkVersion,
    runtimeGitHash: sdkInfo.runtimeGitHash,
    sdkGitHash: sdkInfo.sdkGitHash,
    vmrGitHash: sdkInfo.vmrGitHash,
    runtime: args.runtime,
    preset: args.preset,
    engine,
    app: 'microbenchmarks',
    ...(args['ci-run-id'] && { ciRunId: args['ci-run-id'] }),
    ...(args['ci-run-url'] && { ciRunUrl: args['ci-run-url'] }),
};

const metrics = {
    'compile-time': compileTime,
    'js-interop-ops': benchResults['js-interop-ops'],
    'json-parse-ops': benchResults['json-parse-ops'],
    'exception-ops': benchResults['exception-ops'],
};

const output = buildResultJson(meta, metrics);
await writeFile(args.output, JSON.stringify(output, null, 2) + '\n');
console.error(`Result written to ${args.output}`);

// ── Browser engine measurement ──────────────────────────────────────────────

async function measureBrowser(browserEngine, publishDirPath, timeoutMs, retries) {
    const pw = await import('playwright');
    const browserType = browserEngine === 'firefox' ? pw.firefox : pw.chromium;

    // Load fingerprint map for resolving #[.{fingerprint}] in HTML
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const publishParentDir = resolve(publishDirPath, '..');
    let fingerprintMap;
    try {
        const parentFiles = await readdir(publishParentDir);
        const endpointsFile = parentFiles.find(f => f.endsWith('.staticwebassets.endpoints.json'));
        if (endpointsFile) {
            fingerprintMap = await loadEndpointsMap(join(publishParentDir, endpointsFile));
            console.error(`Loaded ${fingerprintMap.size} fingerprint mappings`);
        }
    } catch { /* no endpoints file */ }

    const srv = await startStaticServer(publishDirPath, 0, { fingerprintMap });
    const pageUrl = `http://127.0.0.1:${srv.port}/`;
    console.error(`Serving ${publishDirPath} on ${pageUrl}`);

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) console.error(`Retry ${attempt}/${retries}...`);
        try {
            const browser = await browserType.launch();
            try {
                const context = await browser.newContext();
                const page = await context.newPage();

                // Log console messages for debugging
                page.on('console', msg => {
                    if (msg.type() === 'error') console.error(`  [page] ${msg.text()}`);
                });
                page.on('pageerror', err => console.error(`  [page error] ${err.message}`));

                await page.goto(pageUrl, { timeout: timeoutMs, waitUntil: 'load' });

                // Wait for benchmarks to complete (bench_complete is set after all benchmarks run)
                // Note: waitForFunction(fn, arg, options) — timeout goes in 3rd param
                await page.waitForFunction(
                    () => globalThis.bench_complete !== undefined,
                    null,
                    { timeout: timeoutMs }
                );

                const results = await page.evaluate(() => globalThis.bench_results);
                await page.close();
                await context.close();
                await srv.close();
                return results;
            } finally {
                await browser.close();
            }
        } catch (err) {
            lastError = err;
            if (!isTimeoutError(err)) {
                await srv.close();
                throw err;
            }
            console.error(`Timeout: ${err.message}`);
        }
    }

    await srv.close();
    throw lastError || new Error('All attempts failed');
}

// ── CLI engine measurement ──────────────────────────────────────────────────

async function measureCli(cliEngine, publishDirPath, timeoutMs) {
    const { readdir } = await import('node:fs/promises');
    const { cmd, args: engineArgs } = getEngineCommand(cliEngine);

    // Find the bench-driver script (may be fingerprinted, e.g. bench-driver.abc123.mjs)
    const files = await readdir(publishDirPath);
    const driverFile = files.find(f => f.startsWith('bench-driver') && f.endsWith('.mjs'));
    if (!driverFile) {
        throw new Error(`bench-driver.mjs not found in ${publishDirPath}. Files: ${files.join(', ')}`);
    }

    console.error(`Running: ${cmd} ${engineArgs.join(' ')} ${driverFile}`);
    console.error(`  cwd: ${publishDirPath}`);

    const stdout = execFileSync(cmd, [...engineArgs, driverFile], {
        encoding: 'utf-8',
        cwd: publishDirPath,
        timeout: timeoutMs,
        env: { ...process.env },
    });

    return parseCliOutput(stdout);
}

function isTimeoutError(err) {
    return err?.name === 'TimeoutError'
        || err?.message?.includes('Timeout')
        || err?.message?.includes('timeout');
}
