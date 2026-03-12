import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { type BenchContext, type BuildManifestEntry } from '../context.js';
import {
    type Engine, type Profile,
    App as A, Engine as E,
    APP_CONFIG, BROWSER_ENGINES,
    MetricKey,
    getEnginesForApp, getProfilesForEngine,
} from '../enums.js';
import { isWindows } from '../exec.js';
import { banner, info, err } from '../log.js';
import {
    startStaticServer, measureFileSizes, verifyIntegrity,
    buildResultJson, buildResultFilename,
    findEntryFile,
} from '../lib/measure-utils.js';
import { PROFILES } from '../lib/throttle-profiles.js';
import { getEngineCommand, parseCliOutput, validateBenchResults } from '../lib/internal-utils.js';
import { runPizzaWalkthrough } from '../lib/pizza-walkthrough.js';

// ── Stage Entry Point ────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    if (!ctx.buildManifest?.length) throw new Error('measure stage requires ctx.buildManifest (run build first)');
    if (!ctx.sdkInfo) throw new Error('measure stage requires ctx.sdkInfo (run acquire-sdk first)');
    if (!ctx.resultsDir) throw new Error('measure stage requires ctx.resultsDir (run build first)');

    const effectiveEngines = ctx.dryRun ? [E.Chrome] : ctx.engines;
    const effectiveProfiles = ctx.dryRun ? ['desktop' as Profile] : ctx.profiles;
    let totalMeasurements = 0;
    let totalFailures = 0;

    for (const entry of ctx.buildManifest) {
        // Apply app/preset filters
        if (!ctx.apps.includes(entry.app)) continue;
        if (!ctx.presets.includes(entry.preset)) continue;

        banner(`Measure ${entry.app} / ${entry.preset}`);

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

        // Measure file sizes (once per app×preset, shared across engines)
        const fileSizes = isInternal ? null : await measureFileSizes(webRoot);
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
    const meta: Record<string, unknown> = {
        runtimeCommitDateTime: ctx.sdkInfo.runtimeCommitDateTime,
        sdkVersion: ctx.sdkInfo.sdkVersion,
        runtimeGitHash: ctx.sdkInfo.runtimeGitHash,
        sdkGitHash: ctx.sdkInfo.sdkGitHash,
        vmrGitHash: ctx.sdkInfo.vmrGitHash,
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

// ── Browser Measurement ──────────────────────────────────────────────────────

async function measureBrowser(
    engine: Engine,
    profile: Profile,
    entry: BuildManifestEntry,
    webRoot: string,
    compileTime: number,
    fileSizes: { diskSizeTotal: number; diskSizeNative: number; diskSizeAssemblies: number } | null,
    isInternal: boolean,
    ctx: BenchContext,
): Promise<Partial<Record<MetricKey, number | null>>> {
    const pw = await import('playwright');
    const browserType = engine === E.Firefox ? pw.firefox : pw.chromium;
    const useCDP = engine !== E.Firefox;
    const warmRuns = ctx.dryRun ? 1 : ctx.warmRuns;
    const timeout = ctx.timeout;
    const maxRetries = ctx.retries;

    // Start static server (persists across retries)
    const srv = await startStaticServer(webRoot);
    const pageUrl = `http://127.0.0.1:${srv.port}/`;
    info(`    Serving on ${pageUrl}`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) info(`    Retry ${attempt}/${maxRetries}...`);

        const browser = await browserType.launch({ headless: ctx.headless });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();

            // Console error forwarding
            page.on('console', (msg: { type: () => string; text: () => string }) => {
                if (msg.type() === 'error') console.error(`    [page] ${msg.text()}`);
            });
            page.on('pageerror', (error: { message: string }) => {
                console.error(`    [page error] ${error.message}`);
            });

            // CDP setup (Chromium only)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let client: any = null;
            let downloadSizeTotal = 0;
            let memoryPeak = 0;
            let memorySampling = false;
            let memoryPoller: Promise<void> | null = null;

            if (useCDP) {
                client = await context.newCDPSession(page);
                await client.send('Performance.enable');
                await client.send('Network.enable');

                // Track download sizes
                client.on('Network.loadingFinished', (params: { encodedDataLength: number }) => {
                    downloadSizeTotal += params.encodedDataLength;
                });

                // Apply throttle profile
                const throttle = PROFILES[profile];
                if (throttle) {
                    if (throttle.network) {
                        await client.send('Network.emulateNetworkConditions', { ...throttle.network });
                    }
                    if (throttle.cpu) {
                        await client.send('Emulation.setCPUThrottlingRate', { ...throttle.cpu });
                    }
                }

                // Start memory sampling
                memorySampling = true;
                memoryPoller = (async () => {
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
            }

            // Cold load
            await page.goto(pageUrl, { timeout, waitUntil: 'load' });
            await page.waitForFunction(
                () => (globalThis as Record<string, unknown>).bench_complete !== undefined,
                null,
                { timeout },
            );

            const coldResults: Record<string, number> = await page.evaluate(
                () => (globalThis as Record<string, unknown>).bench_results as Record<string, number>,
            );
            const timeToReachManagedCold = coldResults['time-to-reach-managed'] ?? null;

            // Collect performance.timing for cold load
            const perfTiming = await page.evaluate(() => {
                const t = performance.timing;
                return {
                    navigationStart: t.navigationStart,
                    responseStart: t.responseStart,
                    domContentLoadedEventEnd: t.domContentLoadedEventEnd,
                    loadEventEnd: t.loadEventEnd,
                };
            });
            void perfTiming; // available for future diagnostic use

            // Warm loads (external apps only)
            let timeToReachManaged: number | null = null;
            if (!isInternal) {
                let warmMin = Infinity;
                for (let i = 0; i < warmRuns; i++) {
                    await page.reload({ timeout, waitUntil: 'load' });
                    await page.waitForFunction(
                        () => (globalThis as Record<string, unknown>).bench_complete !== undefined,
                        null,
                        { timeout },
                    );
                    const warmResults: Record<string, number> = await page.evaluate(
                        () => (globalThis as Record<string, unknown>).bench_results as Record<string, number>,
                    );
                    const warm = warmResults['time-to-reach-managed'];
                    if (warm != null && warm < warmMin) warmMin = warm;
                }
                timeToReachManaged = Number.isFinite(warmMin) ? warmMin : null;
            }

            // Pizza walkthrough (blazing-pizza only, browser engines, desktop profile)
            let pizzaWalkthru: number | null = null;
            if (entry.app === A.BlazingPizza && profile === 'desktop') {
                pizzaWalkthru = await runPizzaWalkthrough(page, pageUrl, timeout);
            }

            // Stop memory sampling + settle
            if (useCDP && client) {
                await sleep(2000);
                memorySampling = false;
                await memoryPoller;
                await client.send('Performance.disable');
                await client.send('Network.disable');
            }

            await page.close();
            await context.close();
            await srv.close();
            await browser.close();

            // Assemble metrics
            if (isInternal) {
                return {
                    [MetricKey.CompileTime]: compileTime,
                    [MetricKey.MemoryPeak]: useCDP ? (memoryPeak || null) : null,
                    [MetricKey.JsInteropOps]: coldResults['js-interop-ops'] ?? null,
                    [MetricKey.JsonParseOps]: coldResults['json-parse-ops'] ?? null,
                    [MetricKey.ExceptionOps]: coldResults['exception-ops'] ?? null,
                };
            }

            return {
                [MetricKey.CompileTime]: compileTime,
                [MetricKey.DiskSizeTotal]: fileSizes!.diskSizeTotal,
                [MetricKey.DiskSizeNative]: fileSizes!.diskSizeNative,
                [MetricKey.DiskSizeAssemblies]: fileSizes!.diskSizeAssemblies,
                [MetricKey.DownloadSizeTotal]: useCDP ? (downloadSizeTotal || null) : null,
                [MetricKey.TimeToReachManagedWarm]: timeToReachManaged,
                [MetricKey.TimeToReachManagedCold]: timeToReachManagedCold,
                [MetricKey.MemoryPeak]: useCDP ? (memoryPeak || null) : null,
                [MetricKey.PizzaWalkthru]: pizzaWalkthru,
            };
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            await browser.close();
            if (!isTimeoutError(lastError)) {
                await srv.close();
                throw lastError;
            }
            info(`    Timeout: ${lastError.message}`);
        }
    }

    await srv.close();
    throw lastError ?? new Error('All attempts failed');
}

// ── CLI Measurement ──────────────────────────────────────────────────────────

async function measureCli(
    engine: Engine,
    entry: BuildManifestEntry,
    webRoot: string,
    compileTime: number,
    fileSizes: { diskSizeTotal: number; diskSizeNative: number; diskSizeAssemblies: number } | null,
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

    const cliResults = parseCliOutput(stdout);

    if (isInternal) {
        validateBenchResults(cliResults, ['js-interop-ops', 'json-parse-ops', 'exception-ops']);
        return {
            [MetricKey.CompileTime]: compileTime,
            [MetricKey.MemoryPeak]: null,
            [MetricKey.JsInteropOps]: cliResults['js-interop-ops'],
            [MetricKey.JsonParseOps]: cliResults['json-parse-ops'],
            [MetricKey.ExceptionOps]: cliResults['exception-ops'],
        };
    }

    // External CLI: timing from bench_results or wall-clock fallback
    const timeToReachManaged = cliResults['time-to-reach-managed'] ?? wallTimeMs;

    return {
        [MetricKey.CompileTime]: compileTime,
        [MetricKey.DiskSizeTotal]: fileSizes!.diskSizeTotal,
        [MetricKey.DiskSizeNative]: fileSizes!.diskSizeNative,
        [MetricKey.DiskSizeAssemblies]: fileSizes!.diskSizeAssemblies,
        [MetricKey.DownloadSizeTotal]: null,
        [MetricKey.TimeToReachManagedWarm]: timeToReachManaged,
        [MetricKey.TimeToReachManagedCold]: timeToReachManaged,
        [MetricKey.MemoryPeak]: null,
        [MetricKey.PizzaWalkthru]: null,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isTimeoutError(e: Error): boolean {
    return e.name === 'TimeoutError'
        || e.message.includes('Timeout')
        || e.message.includes('timeout');
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
