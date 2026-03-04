#!/usr/bin/env node
/**
 * measure-external.mjs — Measure external metrics for browser-wasm apps.
 *
 * Supports four JS engines:
 *   chrome   — Playwright Chromium + CDP (full metrics)
 *   firefox  — Playwright Firefox (timing only, no CDP)
 *   v8       — d8 --module (timing only)
 *   node     — node (timing only)
 *
 * Collects: compile-time, disk-size-total/wasm/dlls, download-size-total,
 *           time-to-reach-managed (warm), time-to-reach-managed-cold, memory-peak
 *
 * Usage:
 *   node scripts/measure-external.mjs \
 *     --app empty-browser \
 *     --publish-dir artifacts/publish/empty-browser/wwwroot \
 *     --output artifacts/results/result.json \
 *     --engine chrome \
 *     --runtime coreclr --preset no-workload \
 *     --sdk-info artifacts/sdk/sdk-info.json \
 *     --compile-time-file artifacts/results/compile-time.json
 */

import { parseArgs } from 'node:util';
import { writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    startStaticServer,
    measureFileSizes,
    buildResultJson,
    readCompileTime,
    readSdkInfo,
    loadEndpointsMap,
} from './lib/measure-utils.mjs';
import { getEngineCommand } from './lib/internal-utils.mjs';
import { runPizzaWalkthrough } from './lib/pizza-walkthrough.mjs';
import { runMudBlazorWalkthrough } from './lib/mud-blazor-walkthrough.mjs';

const BROWSER_ENGINES = new Set(['chrome', 'firefox']);
const CLI_ENGINES = new Set(['v8', 'node']);

const measureStartTime = performance.now();
function ts() {
    const elapsed = ((performance.now() - measureStartTime) / 1000).toFixed(1);
    return `[+${elapsed}s]`;
}

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        'app': { type: 'string' },
        'publish-dir': { type: 'string' },
        'output': { type: 'string' },
        'runtime': { type: 'string' },
        'preset': { type: 'string' },
        'sdk-info': { type: 'string' },
        'compile-time-file': { type: 'string' },
        'engine': { type: 'string', default: 'chrome' },
        'timeout': { type: 'string', default: '60000' },
        'warm-runs': { type: 'string', default: '3' },
        'retries': { type: 'string', default: '2' },
        'ci-run-id': { type: 'string', default: '' },
        'ci-run-url': { type: 'string', default: '' },
    },
    strict: true,
});

const requiredArgs = ['app', 'publish-dir', 'output', 'runtime', 'preset', 'sdk-info'];
for (const name of requiredArgs) {
    if (!args[name]) {
        console.error(`Missing required argument: --${name}`);
        process.exit(1);
    }
}

const engine = args.engine;
if (!BROWSER_ENGINES.has(engine) && !CLI_ENGINES.has(engine)) {
    console.error(`Unknown engine: ${engine}. Expected: chrome, firefox, v8, node`);
    process.exit(1);
}

const timeout = parseInt(args.timeout, 10);
const warmRuns = parseInt(args['warm-runs'], 10);
const maxRetries = parseInt(args.retries, 10);

// ── Read inputs ─────────────────────────────────────────────────────────────

const sdkInfo = await readSdkInfo(args['sdk-info']);
const compileTime = args['compile-time-file']
    ? await readCompileTime(args['compile-time-file'])
    : null;

// File-system sizes (uncompressed wasm + dlls)
const fileSizes = await measureFileSizes(args['publish-dir']);

// Load static web asset fingerprint map (for resolving #[.{fingerprint}] in HTML)
const publishParentDir = resolve(args['publish-dir'], '..');
let fingerprintMap;
try {
    const parentFiles = await readdir(publishParentDir);
    const endpointsFile = parentFiles.find(f => f.endsWith('.staticwebassets.endpoints.json'));
    if (endpointsFile) {
        fingerprintMap = await loadEndpointsMap(join(publishParentDir, endpointsFile));
        console.error(`Loaded ${fingerprintMap.size} fingerprint mappings from ${endpointsFile}`);
    }
} catch {
    // No endpoints file — serve without fingerprint resolution
}

// ── Run measurement ─────────────────────────────────────────────────────────

const benchmarkDateTime = new Date().toISOString();

let result;

if (BROWSER_ENGINES.has(engine)) {
    result = await runBrowserMeasurement(engine, args.app, args['publish-dir'], fingerprintMap, timeout, warmRuns, maxRetries);
} else {
    result = await runCliMeasurement(engine, args['publish-dir'], timeout);
}

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
    app: args.app,
    benchmarkDateTime,
    warmRunCount: warmRuns,
    ...(args['ci-run-id'] && { ciRunId: args['ci-run-id'] }),
    ...(args['ci-run-url'] && { ciRunUrl: args['ci-run-url'] }),
};

const metrics = {
    'compile-time': compileTime,
    'disk-size-total': fileSizes.totalSize || null,
    'disk-size-wasm': fileSizes.wasmSize || null,
    'disk-size-dlls': fileSizes.dllsSize || null,
    'download-size-total': result.downloadSizeTotal,
    'time-to-reach-managed': result.timeToReachManaged,
    'time-to-reach-managed-cold': result.timeToReachManagedCold,
    'memory-peak': result.memoryPeak,
    'pizza-walkthru': result.pizzaWalkthru,
    'mud-blazor-walkthru': result.mudBlazorWalkthru,
};

const output = buildResultJson(meta, metrics);
await writeFile(args.output, JSON.stringify(output, null, 2) + '\n');
console.error(`Result written to ${args.output}`);

// ── Browser measurement (chrome / firefox) ─────────────────────────────────

async function runBrowserMeasurement(browserEngine, app, publishDirPath, fpMap, timeoutMs, warmRunCount, maxRetries) {
    const pw = await import('playwright');
    const browserType = browserEngine === 'firefox' ? pw.firefox : pw.chromium;
    const useCDP = browserEngine !== 'firefox'; // CDP is Chromium-only

    const srv = await startStaticServer(publishDirPath, 0, { fingerprintMap: fpMap });
    const pageUrl = `http://127.0.0.1:${srv.port}/`;
    console.error(`Serving ${publishDirPath} on ${pageUrl}`);

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) console.error(`Retry ${attempt}/${maxRetries}...`);
        try {
            const browser = await browserType.launch();
            try {
                const context = await browser.newContext();
                const page = await context.newPage();

                // ── CDP setup (Chromium only) ───────────────────────────
                let client, downloadSizeTotal = 0, memoryPeak = 0;
                let memorySampling = false;
                let memoryPoller;

                if (useCDP) {
                    client = await context.newCDPSession(page);
                    await client.send('Network.enable');
                    await client.send('Performance.enable');

                    client.on('Network.loadingFinished', (evt) => {
                        downloadSizeTotal += evt.encodedDataLength;
                    });

                    memorySampling = true;
                    memoryPoller = (async () => {
                        while (memorySampling) {
                            try {
                                const perfMetrics = await client.send('Performance.getMetrics');
                                const heapUsed = perfMetrics.metrics.find(m => m.name === 'JSHeapUsedSize');
                                if (heapUsed && heapUsed.value > memoryPeak) {
                                    memoryPeak = heapUsed.value;
                                }
                            } catch { break; }
                            await sleep(100);
                        }
                    })();
                }

                // Log errors for debugging
                page.on('console', msg => {
                    if (msg.type() === 'error') console.error(`  [page] ${msg.text()}`);
                });
                page.on('pageerror', err => console.error(`  [page error] ${err.message}`));

                // ── Cold load ───────────────────────────────────────────
                console.error(`  ${ts()} Cold load starting...`);
                await page.goto(pageUrl, { timeout: timeoutMs, waitUntil: 'load' });
                await page.waitForFunction(
                    () => globalThis.dotnet_managed_ready !== undefined,
                    null, { timeout: timeoutMs }
                );

                const coldMetrics = await page.evaluate(() => ({
                    dotnetReady: globalThis.dotnet_ready,
                    dotnetManagedReady: globalThis.dotnet_managed_ready,
                }));
                const timeToReachManagedCold = coldMetrics.dotnetManagedReady;
                console.error(`  ${ts()} Cold load done: ${timeToReachManagedCold?.toFixed(0)} ms`);

                // ── Warm loads (reloads, take minimum) ──────────────────
                let warmMin = Infinity;
                for (let i = 0; i < warmRunCount; i++) {
                    console.error(`  ${ts()} Warm load ${i + 1}/${warmRunCount} starting...`);
                    await page.reload({ timeout: timeoutMs, waitUntil: 'load' });
                    await page.waitForFunction(
                        () => globalThis.dotnet_managed_ready !== undefined,
                        null, { timeout: timeoutMs }
                    );
                    const warm = await page.evaluate(() => globalThis.dotnet_managed_ready);
                    console.error(`  ${ts()} Warm load ${i + 1}/${warmRunCount} done: ${warm?.toFixed(0)} ms`);
                    if (warm < warmMin) warmMin = warm;
                }
                const timeToReachManaged = Number.isFinite(warmMin) ? warmMin : null;

                // ── App-specific walkthroughs ──────────────────────────
                let pizzaWalkthru = null;
                if (app === 'blazing-pizza') {
                    console.error('  Running pizza walkthrough...');
                    pizzaWalkthru = await runPizzaWalkthrough(page, pageUrl, timeoutMs, { ts });
                    console.error(`  Pizza walkthrough: ${pizzaWalkthru?.toFixed(0)} ms`);
                }

                let mudBlazorWalkthru = null;
                if (app === 'try-mud-blazor') {
                    console.error('  Running MudBlazor walkthrough...');
                    mudBlazorWalkthru = await runMudBlazorWalkthrough(page, pageUrl, timeoutMs, { ts });
                    console.error(`  MudBlazor walkthrough: ${mudBlazorWalkthru?.toFixed(0)} ms`);
                }

                // ── Cleanup CDP ─────────────────────────────────────────
                if (useCDP) {
                    await sleep(2000); // let memory settle
                    memorySampling = false;
                    await memoryPoller;
                    await client.send('Performance.disable');
                    await client.send('Network.disable');
                }

                await page.close();
                await context.close();
                await srv.close();
                return {
                    downloadSizeTotal: useCDP ? downloadSizeTotal : null,
                    timeToReachManagedCold,
                    timeToReachManaged,
                    memoryPeak: useCDP ? (memoryPeak || null) : null,
                    pizzaWalkthru,
                    mudBlazorWalkthru,
                };
            } finally {
                await browser.close();
                console.error(`  ${ts()} Browser closed`);
            }
        } catch (err) {
            lastError = err;
            if (!isTimeoutError(err)) { await srv.close(); throw err; }
            console.error(`${ts()} Timeout: ${err.message}`);
        }
    }

    await srv.close();
    throw lastError || new Error('All attempts failed');
}

// ── CLI measurement (v8 / node) ─────────────────────────────────────────────

async function runCliMeasurement(cliEngine, publishDirPath, timeoutMs) {
    const { cmd, args: engineArgs } = getEngineCommand(cliEngine);

    // Find the entry script (may be fingerprinted, e.g. main.abc123.js)
    const files = await readdir(publishDirPath);
    const entryFile = files.find(f => f.startsWith('main') && f.endsWith('.js'));
    if (!entryFile) {
        throw new Error(`main.js not found in ${publishDirPath}. Files: ${files.join(', ')}`);
    }

    console.error(`${ts()} Running: ${cmd} ${engineArgs.join(' ')} ${entryFile}`);
    console.error(`  cwd: ${publishDirPath}`);

    console.error(`  ${ts()} CLI engine starting...`);
    const startTime = performance.now();
    const stdout = execFileSync(cmd, [...engineArgs, entryFile], {
        encoding: 'utf-8',
        cwd: publishDirPath,
        timeout: timeoutMs,
        env: { ...process.env },
    });
    const wallTimeMs = performance.now() - startTime;
    console.error(`  ${ts()} CLI engine finished in ${wallTimeMs.toFixed(0)} ms`);

    // Parse JSON timing output from main.js
    let timeToReachManaged = null;
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed['time-to-reach-managed'] != null) {
                timeToReachManaged = parsed['time-to-reach-managed'];
            }
        } catch { /* not JSON */ }
    }

    console.error(`  ${ts()} time-to-reach-managed: ${timeToReachManaged?.toFixed(0) ?? 'N/A'} ms`);

    return {
        downloadSizeTotal: null,
        timeToReachManagedCold: timeToReachManaged ?? wallTimeMs,
        timeToReachManaged: timeToReachManaged ?? wallTimeMs,
        memoryPeak: null,
        pizzaWalkthru: null,
        mudBlazorWalkthru: null,
    };
}

function isTimeoutError(err) {
    return err?.name === 'TimeoutError'
        || err?.message?.includes('Timeout')
        || err?.message?.includes('timeout');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
