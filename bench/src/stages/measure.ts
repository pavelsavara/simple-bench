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
    shouldSkipMeasurement,
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
import { type SampleStats, computeStats, formatStats } from '../lib/stats.js';

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

        const skipReason = shouldSkipMeasurement(entry.app, entry.preset);
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
        const fileSizes = isInternal ? null : await measureFileSizes(webRoot);
        if (ctx.verbose && fileSizes) {
            debug(`File sizes — total: ${fileSizes.diskSizeTotal}, native: ${fileSizes.diskSizeNative}, assemblies: ${fileSizes.diskSizeAssemblies}`);
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
    const meta: Record<string, unknown> = {
        runtimeCommitDateTime: ctx.sdkInfo.runtimeCommitDateTime,
        runtimeCommitAuthor: ctx.sdkInfo.runtimeCommitAuthor,
        runtimeCommitMessage: ctx.sdkInfo.runtimeCommitMessage,
        sdkVersion: ctx.sdkInfo.sdkVersion,
        runtimeGitHash: ctx.sdkInfo.runtimeGitHash,
        aspnetCoreGitHash: ctx.sdkInfo.aspnetCoreGitHash,
        sdkGitHash: ctx.sdkInfo.sdkGitHash,
        vmrGitHash: ctx.sdkInfo.vmrGitHash,
        aspnetCoreCommitDateTime: ctx.sdkInfo.aspnetCoreCommitDateTime,
        aspnetCoreVersion: ctx.sdkInfo.aspnetCoreVersion,
        runtimePackVersion: ctx.sdkInfo.runtimePackVersion,
        workloadVersion: ctx.sdkInfo.workloadVersion,
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
    if (ctx.verbose) {
        debug(`Browser: ${engine}, CDP: ${useCDP}, warmRuns: ${warmRuns}, timeout: ${timeout}ms, retries: ${maxRetries}`);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) info(`    Retry ${attempt}/${maxRetries}...`);

        if (ctx.verbose) debug(`Launching browser (headless=${ctx.headless})...`);
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
            if (ctx.verbose) debug(`Cold load: navigating to ${pageUrl}`);
            await page.goto(pageUrl, { timeout, waitUntil: 'load' });
            if (ctx.verbose) debug(`Cold load: page loaded, waiting for bench_complete...`);
            await page.waitForFunction(
                () => (globalThis as Record<string, unknown>).bench_complete !== undefined,
                null,
                { timeout },
            );
            if (ctx.verbose) debug(`Cold load: bench_complete detected`);

            const coldResults: Record<string, number> = await page.evaluate(
                () => (globalThis as Record<string, unknown>).bench_results as Record<string, number>,
            );
            const timeToReachManagedCold = coldResults['time-to-reach-managed'] ?? null;
            if (ctx.verbose) debug(`Cold results: ${JSON.stringify(coldResults)}`);

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
                    if (ctx.verbose) debug(`Warm load ${i + 1}/${warmRuns}: reloading...`);
                    await page.reload({ timeout, waitUntil: 'load' });
                    if (ctx.verbose) debug(`Warm load ${i + 1}/${warmRuns}: waiting for bench_complete...`);
                    await page.waitForFunction(
                        () => (globalThis as Record<string, unknown>).bench_complete !== undefined,
                        null,
                        { timeout },
                    );
                    const warmResults: Record<string, number> = await page.evaluate(
                        () => (globalThis as Record<string, unknown>).bench_results as Record<string, number>,
                    );
                    const warm = warmResults['time-to-reach-managed'];
                    if (ctx.verbose) debug(`Warm load ${i + 1}/${warmRuns}: time-to-reach-managed=${warm}`);
                    if (warm != null && warm < warmMin) warmMin = warm;
                }
                timeToReachManaged = Number.isFinite(warmMin) ? warmMin : null;
            }

            // Pizza walkthrough (blazing-pizza only, chrome, desktop profile)
            let pizzaWalkthrough: number | null = null;
            if (entry.app === A.BlazingPizza && profile === 'desktop' && engine === E.Chrome) {
                if (ctx.verbose) debug(`Running pizza walkthrough...`);
                pizzaWalkthrough = await runPizzaWalkthrough(page, pageUrl, timeout, ctx.verbose);
                if (ctx.verbose) debug(`Pizza walkthrough completed: ${pizzaWalkthrough}ms`);
            }

            // Havit walkthrough (havit-bootstrap only, chrome, desktop profile)
            let havitWalkthrough: number | null = null;
            if (entry.app === A.HavitBootstrap && profile === 'desktop' && engine === E.Chrome) {
                if (ctx.verbose) debug(`Running havit walkthrough...`);
                havitWalkthrough = await runHavitWalkthrough(page, pageUrl, timeout, ctx.verbose);
                if (ctx.verbose) debug(`Havit walkthrough completed: ${havitWalkthrough}ms`);
            }

            // Collect internal benchmark samples before closing the page
            let benchSamples: Record<string, number[]> | null = null;
            if (isInternal) {
                benchSamples = await page.evaluate(
                    () => (globalThis as Record<string, unknown>).bench_samples as Record<string, number[]>,
                );
            }

            // Stop memory sampling + settle
            if (useCDP && client) {
                await sleep(2000);
                memorySampling = false;
                await memoryPoller;
                await client.send('Performance.disable');
                await client.send('Network.disable');
            }

            if (ctx.verbose) debug(`Closing browser and server...`);
            await page.close();
            await context.close();
            await srv.close();
            await browser.close();
            if (ctx.verbose) debug(`Cleanup complete`);

            // Assemble metrics
            if (isInternal) {

                const internalKeys = ['js-interop-ops', 'json-parse-ops', 'exception-ops'] as const;
                const statsMap: Record<string, SampleStats> = {};
                for (const key of internalKeys) {
                    if (benchSamples![key]?.length > 0) {
                        statsMap[key] = computeStats(benchSamples![key]);
                    }
                }

                info('    ═══ Benchmark Statistical Summary ═══');
                for (const [name, s] of Object.entries(statsMap)) {
                    info(formatStats(name, s));
                }

                return {
                    [MetricKey.CompileTime]: compileTime,
                    [MetricKey.MemoryPeak]: useCDP ? (memoryPeak || null) : null,
                    [MetricKey.JsInteropOps]: statsMap['js-interop-ops'] ? Math.round(statsMap['js-interop-ops'].median) : null,
                    [MetricKey.JsonParseOps]: statsMap['json-parse-ops'] ? Math.round(statsMap['json-parse-ops'].median) : null,
                    [MetricKey.ExceptionOps]: statsMap['exception-ops'] ? Math.round(statsMap['exception-ops'].median) : null,
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
                [MetricKey.PizzaWalkthrough]: pizzaWalkthrough,
                [MetricKey.HavitWalkthrough]: havitWalkthrough,
            };
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            try { await browser.close(); } catch { /* ignore */ }
            if (attempt >= maxRetries) {
                await srv.close();
                throw lastError;
            }
            info(`    Attempt ${attempt + 1} failed: ${lastError.message}`);
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

    const cliParsed = parseCliOutput(stdout);

    if (isInternal) {
        const { samples: cliSamples } = cliParsed as { results: Record<string, number>; samples: Record<string, number[]> };

        const internalKeys = ['js-interop-ops', 'json-parse-ops', 'exception-ops'] as const;
        const statsMap: Record<string, SampleStats> = {};
        for (const key of internalKeys) {
            if (cliSamples[key]?.length > 0) {
                statsMap[key] = computeStats(cliSamples[key]);
            }
        }

        info('    ═══ Benchmark Statistical Summary ═══');
        for (const [name, s] of Object.entries(statsMap)) {
            info(formatStats(name, s));
        }

        for (const key of internalKeys) {
            if (!statsMap[key]) {
                throw new Error(`No samples found for '${key}' in CLI output. Output:\n${stdout}`);
            }
        }

        return {
            [MetricKey.CompileTime]: compileTime,
            [MetricKey.MemoryPeak]: null,
            [MetricKey.JsInteropOps]: Math.round(statsMap['js-interop-ops'].median),
            [MetricKey.JsonParseOps]: Math.round(statsMap['json-parse-ops'].median),
            [MetricKey.ExceptionOps]: Math.round(statsMap['exception-ops'].median),
        };
    }

    // External CLI: timing from bench_results or wall-clock fallback
    const cliResults = cliParsed as Record<string, number>;
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
        [MetricKey.PizzaWalkthrough]: null,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
