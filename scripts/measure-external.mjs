#!/usr/bin/env node
/**
 * measure-external.mjs — Measure external metrics via Playwright + CDP.
 *
 * Collects: compile-time, download-size-total/wasm/dlls,
 *           time-to-reach-managed (warm), time-to-reach-managed-cold, memory-peak
 *
 * Usage:
 *   node scripts/measure-external.mjs \
 *     --app empty-browser \
 *     --publish-dir artifacts/publish/empty-browser \
 *     --output artifacts/results/result.json \
 *     --runtime coreclr --preset no-workload \
 *     --sdk-info artifacts/sdk/sdk-info.json \
 *     --compile-time-file artifacts/results/compile-time.json
 */

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import {
    startStaticServer,
    measureFileSizes,
    buildResultJson,
    readCompileTime,
    readSdkInfo,
    loadEndpointsMap,
} from './lib/measure-utils.mjs';

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

// ── Start server & measure ──────────────────────────────────────────────────

let result;
let srv;

srv = await startStaticServer(args['publish-dir'], 0, { fingerprintMap });
const pageUrl = `http://127.0.0.1:${srv.port}/`;
console.error(`Serving ${args['publish-dir']} on ${pageUrl}`);

{
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            console.error(`Retry ${attempt}/${maxRetries}...`);
        }
        try {
            result = await runMeasurement(pageUrl, timeout, warmRuns);
            break;
        } catch (err) {
            lastError = err;
            // Only retry on timeout errors
            if (!isTimeoutError(err)) {
                throw err;
            }
            console.error(`Timeout: ${err.message}`);
        }
    }

    if (!result) {
        console.error(`All ${maxRetries + 1} attempts failed. Last error: ${lastError?.message}`);
        await srv.close();
        process.exit(1);
    }
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
    engine: 'chrome',
    app: args.app,
    ...(args['ci-run-id'] && { ciRunId: args['ci-run-id'] }),
    ...(args['ci-run-url'] && { ciRunUrl: args['ci-run-url'] }),
};

const metrics = {
    'compile-time': compileTime,
    'download-size-total': result.downloadSizeTotal,
    'download-size-wasm': fileSizes.wasmSize || null,
    'download-size-dlls': fileSizes.dllsSize || null,
    'time-to-reach-managed': result.timeToReachManaged,
    'time-to-reach-managed-cold': result.timeToReachManagedCold,
    'memory-peak': result.memoryPeak,
};

const output = buildResultJson(meta, metrics);
await writeFile(args.output, JSON.stringify(output, null, 2) + '\n');
console.error(`Result written to ${args.output}`);

await srv.close();

// ── Measurement core ────────────────────────────────────────────────────────

async function runMeasurement(url, timeoutMs, warmRunCount) {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const client = await context.newCDPSession(page);

        await client.send('Network.enable');
        await client.send('Performance.enable');

        // Track compressed download sizes via CDP
        let downloadSizeTotal = 0;
        const networkResponses = new Map(); // requestId → url for logging
        client.on('Network.requestWillBeSent', (evt) => {
            networkResponses.set(evt.requestId, evt.request.url);
        });
        client.on('Network.loadingFinished', (evt) => {
            downloadSizeTotal += evt.encodedDataLength;
        });

        // Periodic memory sampling — track JSHeapUsedSize peak
        let memoryPeak = 0;
        let memorySampling = true;
        const memoryPoller = (async () => {
            while (memorySampling) {
                try {
                    const perfMetrics = await client.send('Performance.getMetrics');
                    const heapUsed = perfMetrics.metrics.find(m => m.name === 'JSHeapUsedSize');
                    if (heapUsed && heapUsed.value > memoryPeak) {
                        memoryPeak = heapUsed.value;
                    }
                } catch {
                    // CDP session may be closing — stop polling
                    break;
                }
                await sleep(100);
            }
        })();

        // ── Cold load ───────────────────────────────────────────────────
        await page.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
        await page.waitForFunction(
            () => globalThis.dotnet_managed_ready !== undefined,
            { timeout: timeoutMs }
        );

        const coldMetrics = await page.evaluate(() => ({
            dotnetReady: globalThis.dotnet_ready,
            dotnetManagedReady: globalThis.dotnet_managed_ready,
        }));
        const timeToReachManagedCold = coldMetrics.dotnetManagedReady;

        // ── Warm loads (3 reloads, take minimum) ────────────────────────
        let warmMin = Infinity;
        for (let i = 0; i < warmRunCount; i++) {
            await page.reload({ timeout: timeoutMs, waitUntil: 'load' });
            await page.waitForFunction(
                () => globalThis.dotnet_managed_ready !== undefined,
                { timeout: timeoutMs }
            );
            const warm = await page.evaluate(() => globalThis.dotnet_managed_ready);
            if (warm < warmMin) warmMin = warm;
        }
        const timeToReachManaged = Number.isFinite(warmMin) ? warmMin : null;

        // Let memory settle after warm loads
        await sleep(2000);

        // Stop memory sampling
        memorySampling = false;
        await memoryPoller;

        await client.send('Performance.disable');
        await client.send('Network.disable');
        await page.close();
        await context.close();

        return {
            downloadSizeTotal,
            timeToReachManagedCold,
            timeToReachManaged,
            memoryPeak: memoryPeak || null,
        };
    } finally {
        await browser.close();
    }
}

function isTimeoutError(err) {
    return err?.name === 'TimeoutError'
        || err?.message?.includes('Timeout')
        || err?.message?.includes('timeout');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
