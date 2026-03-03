#!/usr/bin/env node
/**
 * migrate-old-data.mjs — Import historical data from WasmPerformanceMeasurements index.json.
 *
 * Usage:
 *   node scripts/migrate-old-data.mjs <index-json-path> <data-dir>
 *
 * Example:
 *   node scripts/migrate-old-data.mjs d:/bench-data/temp_index/index.json d:/simple-bench/data
 *
 * Reads the extracted index.json from index2.zip, filters to aot.default and
 * interp.default flavors, maps to simple-bench schema, writes per-run result
 * JSONs, month indexes, and top-level index.json.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    computeResultRelPath,
    createEmptyMonthIndex,
    upsertResult,
    sortMonthCommits,
    rebuildTopLevelIndex,
    computeMonthKey,
} from './consolidate-results.mjs';

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Mapping from old flavorId → { runtime, preset, engine }.
 * Only default configs for aot and interp, both chrome and firefox.
 */
export const FLAVOR_MAP = {
    0: { runtime: 'mono', preset: 'aot', engine: 'chrome' },         // aot.default.chrome
    1: { runtime: 'mono', preset: 'aot', engine: 'firefox' },        // aot.default.firefox
    2: { runtime: 'mono', preset: 'no-workload', engine: 'chrome' }, // interp.default.chrome
    3: { runtime: 'mono', preset: 'no-workload', engine: 'firefox' }, // interp.default.firefox
};

/** Timeout threshold — values >= this are treated as failed measurements. */
export const TIMEOUT_THRESHOLD = 20000;

/** Measurement IDs from the old MeasurementMap. */
export const MEASUREMENT_IDS = {
    // Timing — browser-template (empty-browser)
    REACH_MANAGED: 1,                  // "AppStart, Reach managed"
    REACH_MANAGED_COLD: 60,            // "AppStart, Reach managed cold"
    BROWSER_REACH_MANAGED: 101,        // "AppStart, Browser Reach managed"
    BROWSER_REACH_MANAGED_COLD: 102,   // "AppStart, Browser Reach managed cold"
    // Timing — blazor-template (empty-blazor)
    BLAZOR_REACH_MANAGED: 97,          // "AppStart, Blazor Reach managed"
    BLAZOR_REACH_MANAGED_COLD: 98,     // "AppStart, Blazor Reach managed cold"
    // Sizes
    SIZE_APP_BUNDLE: 24,               // "Size, AppBundle"
    SIZE_MANAGED: 25,                  // "Size, managed"
    SIZE_DOTNET_WASM: 26,              // "Size, dotnet.wasm"
    SIZE_DOTNET_NATIVE_WASM: 76,       // "Size, dotnet.native.wasm"
};

const CI_RUN_ID = 'migrated';
const CI_RUN_URL = 'https://github.com/radekdoulik/WasmPerformanceMeasurements';

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Parse an ISO 8601 commitTime with timezone offset into UTC date and time.
 * Input examples: "2022-10-14T00:51:15+02:00", "2023-06-15T14:23:45-07:00"
 * @returns {{ commitDate: string, commitTime: string }} e.g. { commitDate: "2022-10-13", commitTime: "22-51-15-UTC" }
 */
export function parseCommitTime(isoString) {
    const d = new Date(isoString);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const seconds = String(d.getUTCSeconds()).padStart(2, '0');
    return {
        commitDate: `${year}-${month}-${day}`,
        commitTime: `${hours}-${minutes}-${seconds}-UTC`,
    };
}

/**
 * Extract a timing metric from minTimes, returning undefined if missing or timeout.
 */
function extractTiming(minTimes, measurementId) {
    if (!minTimes) return undefined;
    const val = minTimes[measurementId];
    if (val === undefined || val === null) return undefined;
    if (val >= TIMEOUT_THRESHOLD) return undefined;
    return val;
}

/**
 * Extract a size metric from sizes, returning undefined if missing.
 */
function extractSize(sizes, measurementId) {
    if (!sizes) return undefined;
    const val = sizes[measurementId];
    if (val === undefined || val === null) return undefined;
    return val;
}

/**
 * Extract browser-template (empty-browser) metrics from an index entry.
 * Prefers "Browser Reach managed" (101) over "Reach managed" (1) when both exist.
 */
export function extractBrowserMetrics(minTimes, sizes) {
    const M = MEASUREMENT_IDS;
    const metrics = {};

    // Timing: prefer Browser-prefixed (id 101/102), fall back to unprefixed (id 1/60)
    const warm = extractTiming(minTimes, M.BROWSER_REACH_MANAGED)
        ?? extractTiming(minTimes, M.REACH_MANAGED);
    const cold = extractTiming(minTimes, M.BROWSER_REACH_MANAGED_COLD)
        ?? extractTiming(minTimes, M.REACH_MANAGED_COLD);

    if (warm !== undefined) metrics['time-to-reach-managed'] = warm;
    if (cold !== undefined) metrics['time-to-reach-managed-cold'] = cold;

    // Sizes
    const sizeTotal = extractSize(sizes, M.SIZE_APP_BUNDLE);
    const sizeDlls = extractSize(sizes, M.SIZE_MANAGED);
    const sizeWasm = extractSize(sizes, M.SIZE_DOTNET_NATIVE_WASM)
        ?? extractSize(sizes, M.SIZE_DOTNET_WASM);

    if (sizeTotal !== undefined) metrics['download-size-total'] = sizeTotal;
    if (sizeDlls !== undefined) metrics['download-size-dlls'] = sizeDlls;
    if (sizeWasm !== undefined) metrics['download-size-wasm'] = sizeWasm;

    return Object.keys(metrics).length > 0 ? metrics : null;
}

/**
 * Extract blazor-template (empty-blazor) metrics from an index entry.
 */
export function extractBlazorMetrics(minTimes, sizes) {
    const M = MEASUREMENT_IDS;
    const metrics = {};

    const warm = extractTiming(minTimes, M.BLAZOR_REACH_MANAGED);
    const cold = extractTiming(minTimes, M.BLAZOR_REACH_MANAGED_COLD);

    if (warm !== undefined) metrics['time-to-reach-managed'] = warm;
    if (cold !== undefined) metrics['time-to-reach-managed-cold'] = cold;

    // Blazor app doesn't have separate size entries in old data at the aggregate level
    // (only per-file Size entries which we skip)

    return Object.keys(metrics).length > 0 ? metrics : null;
}

/**
 * Build a per-run result JSON object from mapped values.
 */
export function buildMigratedResult(commitDate, commitTime, gitHash, runtime, preset, engine, app, metrics) {
    return {
        meta: {
            commitDate,
            commitTime,
            sdkVersion: 'unknown',
            runtimeGitHash: gitHash,
            sdkGitHash: gitHash,
            vmrGitHash: '',
            runtime,
            preset,
            engine,
            app,
            ciRunId: CI_RUN_ID,
            ciRunUrl: CI_RUN_URL,
        },
        metrics,
    };
}

/**
 * Convert a single index entry into 0-2 result JSON objects (browser + blazor).
 * Returns an array of result objects.
 */
export function convertEntry(entry) {
    const flavor = FLAVOR_MAP[entry.flavorId];
    if (!flavor) return [];

    const { commitDate, commitTime } = parseCommitTime(entry.commitTime);
    const { runtime, preset, engine } = flavor;
    const results = [];

    const browserMetrics = extractBrowserMetrics(entry.minTimes, entry.sizes);
    if (browserMetrics) {
        results.push(buildMigratedResult(
            commitDate, commitTime, entry.hash, runtime, preset, engine, 'empty-browser', browserMetrics
        ));
    }

    const blazorMetrics = extractBlazorMetrics(entry.minTimes, entry.sizes);
    if (blazorMetrics) {
        results.push(buildMigratedResult(
            commitDate, commitTime, entry.hash, runtime, preset, engine, 'empty-blazor', blazorMetrics
        ));
    }

    return results;
}

// ── Main migration ──────────────────────────────────────────────────────────

/**
 * Run the migration: read index.json, filter, transform, write data files.
 * @param {string} indexPath  Path to extracted index.json
 * @param {string} dataDir   Output data/ directory
 * @returns {Promise<{ entries: number, results: number, months: number }>}
 */
export async function migrate(indexPath, dataDir) {
    // 1. Read and parse index
    const raw = await readFile(indexPath, 'utf-8');
    const index = JSON.parse(raw);

    // 2. Convert all matching entries
    const allResults = [];
    for (const entry of index.Data) {
        const converted = convertEntry(entry);
        allResults.push(...converted);
    }

    // 3. Write per-run result JSONs and build month indexes
    const monthIndexes = new Map(); // monthKey → monthIndex

    for (const resultJson of allResults) {
        const { meta } = resultJson;

        // Write result file
        const relPath = computeResultRelPath(meta);
        const targetPath = join(dataDir, relPath);
        const year = meta.commitDate.slice(0, 4);
        const targetDir = join(dataDir, year, meta.commitDate);
        await mkdir(targetDir, { recursive: true });
        await writeFile(targetPath, JSON.stringify(resultJson, null, 2) + '\n');

        // Upsert into month index
        const monthKey = computeMonthKey(meta.commitDate);
        if (!monthIndexes.has(monthKey)) {
            monthIndexes.set(monthKey, createEmptyMonthIndex(monthKey));
        }
        upsertResult(monthIndexes.get(monthKey), resultJson);
    }

    // 4. Sort and write month indexes
    for (const [monthKey, monthIndex] of monthIndexes) {
        sortMonthCommits(monthIndex);
        const monthPath = join(dataDir, `${monthKey}.json`);
        await writeFile(monthPath, JSON.stringify(monthIndex, null, 2) + '\n');
    }

    // 5. Build and write top-level index.json
    const monthKeys = new Set(monthIndexes.keys());
    const topIndex = rebuildTopLevelIndex(monthKeys, [...monthIndexes.values()]);
    await writeFile(join(dataDir, 'index.json'), JSON.stringify(topIndex, null, 2) + '\n');

    return {
        entries: index.Data.filter(e => FLAVOR_MAP[e.flavorId] !== undefined).length,
        results: allResults.length,
        months: monthIndexes.size,
    };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const isMain = process.argv[1] && (
    process.argv[1].endsWith('migrate-old-data.mjs') ||
    process.argv[1].endsWith('migrate-old-data')
);

if (isMain) {
    const [indexPath, dataDir] = process.argv.slice(2);
    if (!indexPath || !dataDir) {
        console.error('Usage: node scripts/migrate-old-data.mjs <index-json-path> <data-dir>');
        process.exit(1);
    }
    const stats = await migrate(indexPath, dataDir);
    console.log(`Migration complete:`);
    console.log(`  Source entries matched: ${stats.entries}`);
    console.log(`  Result files written:  ${stats.results}`);
    console.log(`  Month indexes:         ${stats.months}`);
}
