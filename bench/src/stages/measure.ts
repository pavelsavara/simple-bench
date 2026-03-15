import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { type BenchContext, type BuildManifestEntry } from '../context.js';
import {
    type Engine, type Profile,
    App as A, Engine as E,
    APP_CONFIG, BROWSER_ENGINES,
    MetricKey,
    getEnginesForApp, getProfilesForEngine,
    shouldSkipMeasurement,
    Preset,
} from '../enums.js';
import { isWindows } from '../exec.js';
import { banner, info, err, debug } from '../log.js';
import {
    startStaticServer, measureFileSizes, verifyIntegrity,
    buildResultJson, buildResultFilename,
    findEntryFile,
} from '../lib/measure-utils.js';
import { PROFILES } from '../lib/throttle-profiles.js';
import { getEngineCommand, parseCliOutput } from '../lib/internal-utils.js';
import { runPizzaWalkthrough } from '../lib/pizza-walkthrough.js';
import { runHavitWalkthrough } from '../lib/havit-walkthrough.js';
import { runMudWalkthrough } from '../lib/mud-walkthrough.js';
import { type SampleStats, computeStats, formatStats, sortedMedian } from '../lib/stats.js';
import type { CDPSession, Page, BrowserContext, Browser } from 'playwright';

// ── Stage Entry Point ────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    if (!ctx.buildManifest?.length) throw new Error('measure stage requires ctx.buildManifest (run build first)');
    if (!ctx.sdkInfo) throw new Error('measure stage requires ctx.sdkInfo (run resolve-sdk first)');
    if (!ctx.resultsDir) throw new Error('measure stage requires ctx.resultsDir (run build first)');

    const effectiveEngines = ctx.dryRun ? [E.Chrome] : ctx.engines;
    const effectiveProfiles = ctx.dryRun ? ['desktop' as Profile] : ctx.profiles;
    let totalMeasurements = 0;
    let totalFailures = 0;

    if (ctx.verbose) {
        debug(`Engines: ${effectiveEngines.join(', ')}`);
        debug(`Profiles: ${effectiveProfiles.join(', ')}`);
        debug(`Apps: ${ctx.apps.join(', ')}`);
        debug(`Presets: ${ctx.presets.join(', ')}`);
        debug(`Build manifest entries: ${ctx.buildManifest.length}`);
        debug(`Dry run: ${ctx.dryRun}, headless: ${ctx.headless}, timeout: ${ctx.timeout}ms, retries: ${ctx.retries}`);
    }

    for (const entry of ctx.buildManifest) {
        // Apply app/preset filters
        if (!ctx.apps.includes(entry.app)) continue;
        if (!ctx.presets.includes(entry.preset)) continue;

        const skipReason = shouldSkipMeasurement(entry.app, entry.preset, ctx);
        if (skipReason) {
            info(`Skipping ${entry.app}/${entry.preset}: ${skipReason}`);
            continue;
        }

        banner(`Measure ${entry.app} / ${entry.preset}`);
        if (ctx.verbose) {
            debug(`publishDir: ${entry.publishDir}`);
            debug(`runtime: ${entry.runtime}, compileTimeMs: ${entry.compileTimeMs}`);
        }

        // Integrity verification
        const integrityCheck = await verifyIntegrity(entry.publishDir, entry.integrity);
        if (!integrityCheck.valid) {
            err(
                `Integrity mismatch for ${entry.app}/${entry.preset}: ` +
                `expected ${JSON.stringify(entry.integrity)}, ` +
                `got ${JSON.stringify(integrityCheck.actual)}`,
            );
            totalFailures++;
            continue;
        }

        const webRoot = join(entry.publishDir, 'wwwroot');
        const isInternal = APP_CONFIG[entry.app].internal;
        if (ctx.verbose) debug(`webRoot: ${webRoot}, isInternal: ${isInternal}`);

        // Measure file sizes (once per app×preset, shared across engines)
        const fileSizes = isInternal ? null : await measureFileSizes(webRoot, entry.preset !== Preset.DevLoop);
        if (ctx.verbose && fileSizes) {
            debug(`File sizes — native: ${fileSizes.diskSizeNative}, assemblies: ${fileSizes.diskSizeAssemblies}`);
        }
        const compileTime = entry.compileTimeMs;

        // Engine × profile loop
        const engines = getEnginesForApp(entry.app, effectiveEngines);
        for (const engine of engines) {
            const profiles = getProfilesForEngine(engine, effectiveProfiles);
            for (const profile of profiles) {
                totalMeasurements++;
                try {
                    info(`  ${engine}/${profile}`);

                    let metrics: Partial<Record<MetricKey, number | null>>;

                    if (BROWSER_ENGINES.has(engine)) {
                        metrics = await measureBrowser(
                            engine, profile, entry, webRoot,
                            compileTime, fileSizes, isInternal, ctx,
                        );
                    } else {
                        metrics = await measureCli(
                            engine, entry, webRoot,
                            compileTime, fileSizes, isInternal, ctx,
                        );
                    }

                    // Build and write result JSON
                    const meta = buildMeta(ctx, entry, engine, profile);
                    const result = buildResultJson(meta, metrics);
                    const filename = buildResultFilename(
                        ctx.sdkInfo, ctx.runtime, entry.preset,
                        profile, engine, entry.app,
                    );
                    const outPath = join(ctx.resultsDir, filename);
                    await writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
                    info(`    → ${filename}`);
                } catch (e) {
                    totalFailures++;
                    err(`  Failed ${entry.app}/${entry.preset} ${engine}/${profile}: ${e instanceof Error ? e.message : e}`);
                }
            }
        }
    }

    banner(`Measurement complete: ${totalMeasurements - totalFailures}/${totalMeasurements} succeeded`);
    if (totalFailures > 0 && totalFailures === totalMeasurements) {
        throw new Error('All measurements failed');
    }

    return ctx;
}

// ── Meta Builder ─────────────────────────────────────────────────────────────

function buildMeta(
    ctx: BenchContext,
    entry: BuildManifestEntry,
    engine: Engine,
    profile: Profile,
): Record<string, unknown> {
    const { source: _source, ...sdkFields } = ctx.sdkInfo;
    const meta: Record<string, unknown> = {
        ...sdkFields,
        runtime: entry.runtime,
        preset: entry.preset,
        profile,
        engine,
        app: entry.app,
        benchmarkDateTime: new Date().toISOString(),
        warmRunCount: ctx.warmRuns,
    };
    if (ctx.ciRunId) {
        meta.ciRunId = ctx.ciRunId;
        meta.ciRunUrl = `https://github.com/${ctx.repo ?? 'dotnet/simple-bench'}/actions/runs/${ctx.ciRunId}`;
    }
    return meta;
}

// ── Shared Types & Helpers ───────────────────────────────────────────────────

interface BenchTimings {
    reachManaged: number | null;
    createDotnet: number | null;
    wasmMemory: number | null;
    exit: number | null;
}

function extractTimings(results: Record<string, number>): BenchTimings {
    return {
        reachManaged: results['time-to-reach-managed'] ?? null,
        createDotnet: results['time-to-create-dotnet'] ?? null,
        wasmMemory: results['wasm-memory-size'] ?? null,
        exit: results['time-to-exit'] ?? null,
    };
}

function pushTiming(arrays: TimingArrays, t: BenchTimings): void {
    if (t.reachManaged != null) arrays.reachManaged.push(t.reachManaged);
    if (t.createDotnet != null) arrays.createDotnet.push(t.createDotnet);
    if (t.exit != null) arrays.exit.push(t.exit);
    if (t.wasmMemory != null) arrays.wasmMemory.push(t.wasmMemory);
}

interface TimingArrays {
    reachManaged: number[];
    createDotnet: number[];
    exit: number[];
    wasmMemory: number[];
}

function emptyTimingArrays(): TimingArrays {
    return { reachManaged: [], createDotnet: [], exit: [], wasmMemory: [] };
}

// Walkthrough dispatch table — Chrome + desktop only
type WalkthroughFn = (page: Page, url: string, timeout: number, verbose: boolean) => Promise<number>;

const WALKTHROUGHS: { app: A; metric: MetricKey; fn: WalkthroughFn }[] = [
    { app: A.BlazingPizza, metric: MetricKey.PizzaWalkthrough, fn: runPizzaWalkthrough as WalkthroughFn },
    { app: A.HavitBootstrap, metric: MetricKey.HavitWalkthrough, fn: runHavitWalkthrough as WalkthroughFn },
    { app: A.MudBlazor, metric: MetricKey.MudWalkthrough, fn: runMudWalkthrough as WalkthroughFn },
];

const INTERNAL_KEYS = ['js-interop-ops', 'json-parse-ops', 'exception-ops'] as const;

function assembleInternalMetrics(
    statsMap: Record<string, SampleStats>,
    compileTime: number,
    memoryPeak: number | null,
    timeToCreateDotnetCold: number | null,
    timeToExitCold: number | null,
    wasmMemorySize: number | null,
): Partial<Record<MetricKey, number | null>> {
    info('    ═══ Benchmark Statistical Summary ═══');
    for (const [name, s] of Object.entries(statsMap)) {
        info(formatStats(name, s));
    }
    if (timeToCreateDotnetCold != null) info(`    time-to-create-dotnet-cold: ${Math.round(timeToCreateDotnetCold)} ms`);
    if (timeToExitCold != null) info(`    time-to-exit-cold: ${Math.round(timeToExitCold)} ms`);
    if (wasmMemorySize != null) info(`    wasm-memory-size: ${wasmMemorySize} bytes`);

    return {
        [MetricKey.CompileTime]: compileTime,
        [MetricKey.MemoryPeak]: memoryPeak,
        [MetricKey.TimeToCreateDotnetCold]: timeToCreateDotnetCold,
        [MetricKey.TimeToExitCold]: timeToExitCold,
        [MetricKey.WasmMemorySize]: wasmMemorySize,
        [MetricKey.JsInteropOps]: statsMap['js-interop-ops'] ? Math.round(statsMap['js-interop-ops'].median) : null,
        [MetricKey.JsonParseOps]: statsMap['json-parse-ops'] ? Math.round(statsMap['json-parse-ops'].median) : null,
        [MetricKey.ExceptionOps]: statsMap['exception-ops'] ? Math.round(statsMap['exception-ops'].median) : null,
    };
}

function computeInternalStats(samples: Record<string, number[]>): Record<string, SampleStats> {
    const statsMap: Record<string, SampleStats> = {};
    for (const key of INTERNAL_KEYS) {
        if (samples[key]?.length > 0) {
            statsMap[key] = computeStats(samples[key]);
        }
    }
    return statsMap;
}

// ── CDP Setup ────────────────────────────────────────────────────────────────

interface CDPState {
    client: CDPSession;
    downloadSizeTotal: number;
    memoryPeak: number;
    stopMemorySampling: () => Promise<void>;
}

async function setupCDP(
    context: BrowserContext,
    page: Page,
    profile: Profile,
): Promise<CDPState> {
    const client = await context.newCDPSession(page);
    await client.send('Performance.enable');
    await client.send('Network.enable');

    let downloadSizeTotal = 0;
    let memoryPeak = 0;
    let memorySampling = true;

    client.on('Network.loadingFinished', (params: { encodedDataLength: number }) => {
        downloadSizeTotal += params.encodedDataLength;
    });

    const throttle = PROFILES[profile];
    if (throttle) {
        if (throttle.network) {
            await client.send('Network.emulateNetworkConditions', { ...throttle.network });
        }
        if (throttle.cpu) {
            await client.send('Emulation.setCPUThrottlingRate', { ...throttle.cpu });
        }
    }

    const memoryPoller = (async () => {
        while (memorySampling) {
            try {
                const perfMetrics = await client.send('Performance.getMetrics');
                const heapUsed = perfMetrics.metrics.find(
                    (m: { name: string; value: number }) => m.name === 'JSHeapUsedSize',
                );
                if (heapUsed && heapUsed.value > memoryPeak) {
                    memoryPeak = heapUsed.value;
                }
            } catch {
                break;
            }
            await sleep(100);
        }
    })();

    return {
        get downloadSizeTotal() { return downloadSizeTotal; },
        get memoryPeak() { return memoryPeak; },
        client,
        stopMemorySampling: async () => {
            await sleep(2000);
            memorySampling = false;
            await memoryPoller;
            await client.send('Performance.disable');
            await client.send('Network.disable');
        },
    };
}

// ── Page Load Helpers ────────────────────────────────────────────────────────

async function waitForBenchComplete(page: Page, timeout: number): Promise<Record<string, number>> {
    await page.waitForFunction(
        () => (globalThis as Record<string, unknown>).bench_complete !== undefined,
        null,
        { timeout },
    );
    return page.evaluate(
        () => (globalThis as Record<string, unknown>).bench_results as Record<string, number>,
    );
}

async function applyColdThrottle(
    browser: Browser,
    coldPage: Page,
    coldCtx: BrowserContext,
    profile: Profile,
    useCDP: boolean,
): Promise<void> {
    const throttle = PROFILES[profile];
    if (!useCDP || !throttle) return;
    const coldClient = await coldCtx.newCDPSession(coldPage);
    if (throttle.network) {
        await coldClient.send('Network.emulateNetworkConditions', { ...throttle.network });
    }
    if (throttle.cpu) {
        await coldClient.send('Emulation.setCPUThrottlingRate', { ...throttle.cpu });
    }
}

async function runColdLoads(
    browser: Browser,
    pageUrl: string,
    warmRuns: number,
    timeout: number,
    profile: Profile,
    useCDP: boolean,
    verbose: boolean,
): Promise<TimingArrays> {
    const arrays = emptyTimingArrays();
    for (let i = 0; i < warmRuns; i++) {
        if (verbose) debug(`Cold load ${i + 1}/${warmRuns}: fresh context...`);
        const coldCtx = await browser.newContext();
        const coldPage = await coldCtx.newPage();
        try {
            await applyColdThrottle(browser, coldPage, coldCtx, profile, useCDP);
            await coldPage.goto(pageUrl, { timeout, waitUntil: 'load' });
            const results = await waitForBenchComplete(coldPage, timeout);
            const t = extractTimings(results);
            if (verbose) debug(`Cold load ${i + 1}/${warmRuns}: time-to-reach-managed=${t.reachManaged}`);
            pushTiming(arrays, t);
        } finally {
            await coldPage.close();
            await coldCtx.close();
        }
    }
    return arrays;
}

async function runWarmLoads(
    page: Page,
    warmRuns: number,
    timeout: number,
    verbose: boolean,
): Promise<TimingArrays> {
    const arrays = emptyTimingArrays();
    for (let i = 0; i < warmRuns; i++) {
        if (verbose) debug(`Warm load ${i + 1}/${warmRuns}: reloading...`);
        await page.reload({ timeout, waitUntil: 'load' });
        if (verbose) debug(`Warm load ${i + 1}/${warmRuns}: waiting for bench_complete...`);
        const results = await waitForBenchComplete(page, timeout);
        const t = extractTimings(results);
        if (verbose) debug(`Warm load ${i + 1}/${warmRuns}: time-to-reach-managed=${t.reachManaged}`);
        pushTiming(arrays, t);
    }
    return arrays;
}

async function runWalkthroughs(
    page: Page,
    pageUrl: string,
    entry: BuildManifestEntry,
    engine: Engine,
    profile: Profile,
    warmRuns: number,
    timeout: number,
    verbose: boolean,
): Promise<Partial<Record<MetricKey, number | null>>> {
    const results: Partial<Record<MetricKey, number | null>> = {};
    for (const wt of WALKTHROUGHS) {
        // Walkthroughs are Chrome-only + desktop-only (CDP required for reliable timing)
        if (entry.app !== wt.app || profile !== 'desktop' || engine !== E.Chrome) continue;
        const times: number[] = [];
        for (let i = 0; i < warmRuns; i++) {
            if (verbose) debug(`${wt.metric} ${i + 1}/${warmRuns}...`);
            const t = await wt.fn(page, pageUrl, timeout, verbose);
            times.push(t);
            if (verbose) debug(`${wt.metric} ${i + 1}/${warmRuns}: ${t}ms`);
        }
        const med = sortedMedian(times);
        results[wt.metric] = med != null ? Math.round(med) : null;
        if (verbose) debug(`${wt.metric} times: [${times.join(', ')}] → median=${results[wt.metric]}ms`);
    }
    return results;
}

// ── Browser Measurement ──────────────────────────────────────────────────────

async function measureBrowser(
    engine: Engine,
    profile: Profile,
    entry: BuildManifestEntry,
    webRoot: string,
    compileTime: number,
    fileSizes: { diskSizeNative: number; diskSizeAssemblies: number } | null,
    isInternal: boolean,
    ctx: BenchContext,
): Promise<Partial<Record<MetricKey, number | null>>> {
    const pw = await import('playwright');
    const browserType = engine === E.Firefox ? pw.firefox : pw.chromium;
    const useCDP = engine !== E.Firefox;
    const warmRuns = ctx.dryRun ? 1 : ctx.warmRuns;
    const timeout = ctx.timeout;
    const maxRetries = ctx.retries;

    const srv = await startStaticServer(webRoot);
    const pageUrl = `http://127.0.0.1:${srv.port}/`;
    info(`    Serving on ${pageUrl}`);
    if (ctx.verbose) {
        debug(`Browser: ${engine}, CDP: ${useCDP}, warmRuns: ${warmRuns}, timeout: ${timeout}ms, retries: ${maxRetries}`);
    }

    let lastError: Error | null = null;

    try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) info(`    Retry ${attempt}/${maxRetries}...`);

            if (ctx.verbose) debug(`Launching browser (headless=${ctx.headless})...`);
            const browser = await browserType.launch({ headless: ctx.headless });
            try {
                const context = await browser.newContext();
                const page = await context.newPage();

                page.on('console', (msg) => {
                    if (msg.type() === 'error') console.error(`    [page] ${msg.text()}`);
                });
                page.on('pageerror', (error) => {
                    console.error(`    [page error] ${error.message}`);
                });

                // CDP setup (Chromium only)
                let cdp: CDPState | null = null;
                if (useCDP) {
                    cdp = await setupCDP(context, page, profile);
                }

                // Cold load (first one uses the main context)
                if (ctx.verbose) debug(`Cold load: navigating to ${pageUrl}`);
                await page.goto(pageUrl, { timeout, waitUntil: 'load' });
                if (ctx.verbose) debug(`Cold load: page loaded, waiting for bench_complete...`);
                const coldResults = await waitForBenchComplete(page, timeout);
                const firstCold = extractTimings(coldResults);
                if (ctx.verbose) debug(`Cold results: ${JSON.stringify(coldResults)}`);

                // Collect cold + warm timing arrays
                const coldArrays = emptyTimingArrays();
                pushTiming(coldArrays, firstCold);

                // Additional cold loads + warm loads (external apps only)
                if (!isInternal) {
                    // Additional cold loads in fresh contexts
                    if (warmRuns > 1) {
                        const extraCold = await runColdLoads(
                            browser, pageUrl, warmRuns - 1, timeout, profile, useCDP, ctx.verbose,
                        );
                        for (const key of Object.keys(coldArrays) as (keyof TimingArrays)[]) {
                            coldArrays[key].push(...extraCold[key]);
                        }
                    }
                    if (ctx.verbose && coldArrays.reachManaged.length > 1) {
                        debug(`Cold times: [${coldArrays.reachManaged.join(', ')}] → median=${sortedMedian(coldArrays.reachManaged)}`);
                    }
                }

                const warmArrays = !isInternal
                    ? await runWarmLoads(page, warmRuns, timeout, ctx.verbose)
                    : emptyTimingArrays();

                if (ctx.verbose && warmArrays.reachManaged.length > 1) {
                    debug(`Warm times: [${warmArrays.reachManaged.join(', ')}] → median=${sortedMedian(warmArrays.reachManaged)}`);
                }

                const wasmMemorySize = [...coldArrays.wasmMemory, ...warmArrays.wasmMemory].length > 0
                    ? Math.max(...coldArrays.wasmMemory, ...warmArrays.wasmMemory)
                    : null;

                // Walkthroughs (external apps only)
                const walkthroughMetrics = !isInternal
                    ? await runWalkthroughs(page, pageUrl, entry, engine, profile, warmRuns, timeout, ctx.verbose)
                    : {};

                // Collect internal benchmark samples before closing the page
                let benchSamples: Record<string, number[]> | null = null;
                if (isInternal) {
                    benchSamples = await page.evaluate(
                        () => (globalThis as Record<string, unknown>).bench_samples as Record<string, number[]>,
                    );
                }

                // Stop memory sampling + settle
                if (cdp) {
                    await cdp.stopMemorySampling();
                }

                if (ctx.verbose) debug(`Closing browser...`);
                await page.close();
                await context.close();
                await browser.close();
                if (ctx.verbose) debug(`Cleanup complete`);

                // Assemble metrics
                if (isInternal) {
                    const statsMap = computeInternalStats(benchSamples!);
                    return assembleInternalMetrics(
                        statsMap, compileTime,
                        useCDP ? (cdp!.memoryPeak || null) : null,
                        sortedMedian(coldArrays.createDotnet),
                        sortedMedian(coldArrays.exit),
                        wasmMemorySize,
                    );
                }

                return {
                    [MetricKey.CompileTime]: compileTime,
                    [MetricKey.DiskSizeNative]: fileSizes!.diskSizeNative,
                    [MetricKey.DiskSizeAssemblies]: fileSizes!.diskSizeAssemblies,
                    [MetricKey.DownloadSizeTotal]: useCDP ? (cdp!.downloadSizeTotal || null) : null,
                    [MetricKey.TimeToReachManagedWarm]: sortedMedian(warmArrays.reachManaged),
                    [MetricKey.TimeToReachManagedCold]: sortedMedian(coldArrays.reachManaged),
                    [MetricKey.TimeToCreateDotnetWarm]: sortedMedian(warmArrays.createDotnet),
                    [MetricKey.TimeToCreateDotnetCold]: sortedMedian(coldArrays.createDotnet),
                    [MetricKey.TimeToExitWarm]: sortedMedian(warmArrays.exit),
                    [MetricKey.TimeToExitCold]: sortedMedian(coldArrays.exit),
                    [MetricKey.WasmMemorySize]: wasmMemorySize,
                    [MetricKey.MemoryPeak]: useCDP ? (cdp!.memoryPeak || null) : null,
                    ...walkthroughMetrics,
                };
            } catch (e) {
                lastError = e instanceof Error ? e : new Error(String(e));
                try { await browser.close(); } catch { /* ignore */ }
                if (attempt >= maxRetries) throw lastError;
                info(`    Attempt ${attempt + 1} failed: ${lastError.message}`);
            }
        }

        throw lastError ?? new Error('All attempts failed');
    } finally {
        await srv.close();
    }
}

// ── CLI Measurement ──────────────────────────────────────────────────────────

async function measureCli(
    engine: Engine,
    entry: BuildManifestEntry,
    webRoot: string,
    compileTime: number,
    fileSizes: { diskSizeNative: number; diskSizeAssemblies: number } | null,
    isInternal: boolean,
    ctx: BenchContext,
): Promise<Partial<Record<MetricKey, number | null>>> {
    const { cmd, args: engineArgs } = getEngineCommand(engine);
    const entryFile = await findEntryFile(webRoot);

    info(`    Running: ${cmd} ${engineArgs.join(' ')} ${entryFile}`);
    info(`    cwd: ${webRoot}`);

    const useShell = isWindows() && /\.(cmd|bat)$/i.test(cmd);

    const startTime = performance.now();
    const stdout = execFileSync(cmd, [...engineArgs, entryFile], {
        encoding: 'utf-8',
        cwd: webRoot,
        timeout: ctx.timeout,
        env: { ...process.env },
        ...(useShell && { shell: true }),
    });
    const wallTimeMs = performance.now() - startTime;

    const cliParsed = parseCliOutput(stdout);

    if (isInternal) {
        const { results: cliInternalResults, samples: cliSamples } = cliParsed as { results: Record<string, number>; samples: Record<string, number[]> };
        const t = extractTimings(cliInternalResults);

        const statsMap = computeInternalStats(cliSamples);

        for (const key of INTERNAL_KEYS) {
            if (!statsMap[key]) {
                throw new Error(`No samples found for '${key}' in CLI output. Output:\n${stdout}`);
            }
        }

        return assembleInternalMetrics(
            statsMap, compileTime, null,
            t.createDotnet, t.exit, t.wasmMemory,
        );
    }

    // External CLI: timing from bench_results or wall-clock fallback
    const cliResults = cliParsed as Record<string, number>;
    const timeToReachManaged = cliResults['time-to-reach-managed'] ?? wallTimeMs;
    const t = extractTimings(cliResults);

    return {
        [MetricKey.CompileTime]: compileTime,
        [MetricKey.DiskSizeNative]: fileSizes!.diskSizeNative,
        [MetricKey.DiskSizeAssemblies]: fileSizes!.diskSizeAssemblies,
        [MetricKey.DownloadSizeTotal]: null,
        [MetricKey.TimeToReachManagedWarm]: timeToReachManaged,
        [MetricKey.TimeToReachManagedCold]: timeToReachManaged,
        [MetricKey.TimeToCreateDotnetWarm]: t.createDotnet,
        [MetricKey.TimeToCreateDotnetCold]: t.createDotnet,
        [MetricKey.TimeToExitWarm]: t.exit,
        [MetricKey.TimeToExitCold]: t.exit,
        [MetricKey.WasmMemorySize]: t.wasmMemory,
        [MetricKey.MemoryPeak]: null,
        [MetricKey.PizzaWalkthrough]: null,
        [MetricKey.HavitWalkthrough]: null,
        [MetricKey.MudWalkthrough]: null,
    };
}
