// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

/**
 * Microbenchmark driver — collects multiple samples, filters outliers via IQR.
 *
 * Sampling strategy:
 *   - Each benchmark is run for SAMPLE_COUNT independent samples (default: 7).
 *   - Each sample runs the benchmark function in a tight loop for SAMPLE_DURATION_MS
 *     (default: 2000ms) and records ops/sec for that window.
 *   - The first sample is a warm-up and is always discarded (JIT, caches, etc).
 *
 * Outlier filtering (IQR method):
 *   - From the remaining samples, compute Q1 (25th percentile) and Q3 (75th percentile).
 *   - IQR = Q3 - Q1. Fences are [Q1 - 1.5×IQR, Q3 + 1.5×IQR].
 *   - Samples outside the fences are discarded as outliers.
 *   - The reported value is the median of the remaining (non-outlier) samples.
 *   - If all samples are outliers (degenerate case), median of all samples is used.
 *
 * With 7 samples (1 warm-up + 6 measured), typically 0-1 outliers are removed,
 * leaving 5-6 samples for a stable median. This balances runtime (~14s per benchmark)
 * against statistical robustness.
 */

import { dotnet } from './_framework/dotnet.js';

const isBrowser = typeof globalThis.window !== 'undefined';
const SAMPLE_COUNT = 100;       // total samples (including 1 warm-up) — temporarily raised from 7
const SAMPLE_DURATION_MS = 500;  // duration per sample window — temporarily reduced from 2000

const { setModuleImports, getAssemblyExports, runMain } = await dotnet
    .withApplicationArguments("start")
    .create();

setModuleImports('bench-driver.mjs', {
    bench: {
        setBenchReady: () => { globalThis.bench_ready = performance.now(); }
    }
});

await runMain("MicroBenchmarks", []);

// ── Run benchmarks ──────────────────────────────────────────────────────────

const exports = await getAssemblyExports("MicroBenchmarks");
const results = {};
const stats = {};

// JS Interop: tight loop calling [JSExport] Ping
({ value: results['js-interop-ops'], stats: stats['js-interop-ops'] } = runBenchSampled(() => exports.JsInteropBench.Ping(42)));

// JSON Parse: tight loop calling [JSExport] ParseJson
const sampleJson = JSON.stringify({ count: 42, name: "benchmark", items: [1, 2, 3] });
({ value: results['json-parse-ops'], stats: stats['json-parse-ops'] } = runBenchSampled(() => exports.JsonBench.ParseJson(sampleJson)));

// Exception Handling: recursive Fibonacci throw/catch (100 iterations per call)
({ value: results['exception-ops'], stats: stats['exception-ops'] } = runBenchSampled(() => exports.ExceptionBench.ThrowCatch(42)));

// ── Report results ──────────────────────────────────────────────────────────

// Browser: set on globalThis for Playwright to read
globalThis.bench_results = results;
globalThis.bench_stats = stats;
globalThis.bench_complete = performance.now();

// Print statistical summary
const log = isBrowser ? console.log.bind(console) : console.error.bind(console);
log('\n═══ Benchmark Statistical Summary ═══');
for (const [name, s] of Object.entries(stats)) {
    log(`\n  ${name}:`);
    log(`    samples (after outlier removal): ${s.n}`);
    log(`    median:   ${s.median.toFixed(1)} ops/s`);
    log(`    mean:     ${s.mean.toFixed(1)} ops/s`);
    log(`    stddev:   ${s.stddev.toFixed(1)} ops/s`);
    log(`    CV:       ${s.cv.toFixed(2)}%`);
    log(`    SE:       ${s.se.toFixed(1)} ops/s`);
    log(`    95% CI:   [${s.ci95lo.toFixed(1)}, ${s.ci95hi.toFixed(1)}] ops/s`);
    log(`    min:      ${s.min.toFixed(1)} ops/s`);
    log(`    max:      ${s.max.toFixed(1)} ops/s`);
    log(`    range:    ${(s.max - s.min).toFixed(1)} ops/s (${((s.max - s.min) / s.median * 100).toFixed(2)}% of median)`);
}
log('');

// Update page (if in browser)
if (isBrowser) {
    const el = globalThis.document?.getElementById('status');
    if (el) {
        el.textContent = `Done: interop=${results['js-interop-ops']} ops/s (CV ${stats['js-interop-ops'].cv.toFixed(2)}%), `
            + `json=${results['json-parse-ops']} ops/s (CV ${stats['json-parse-ops'].cv.toFixed(2)}%), `
            + `exception=${results['exception-ops']} ops/s (CV ${stats['exception-ops'].cv.toFixed(2)}%)`;
    }
}

// CLI: output JSON to stdout (for d8, node)
if (!isBrowser) {
    console.log(JSON.stringify({ results, stats }));
}

// ── Sampling & statistics ───────────────────────────────────────────────────

/**
 * Collect SAMPLE_COUNT samples, discard warm-up, filter outliers via IQR,
 * return { value: median ops/sec, stats: detailed statistics }.
 */
function runBenchSampled(fn) {
    const allSamples = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
        allSamples.push(runOneSample(fn, SAMPLE_DURATION_MS));
    }
    // Discard first sample (warm-up)
    const samples = allSamples.slice(1);
    const filtered = filterOutliersIQR(samples);
    const data = filtered.length > 0 ? filtered : samples;
    const med = median(data);
    const st = computeStats(data);
    return { value: Math.round(med), stats: st };
}

/** Run fn in a tight loop for durationMs; return ops/sec. */
function runOneSample(fn, durationMs) {
    const start = performance.now();
    let ops = 0;
    while (performance.now() - start < durationMs) {
        fn();
        ops++;
    }
    const elapsed = performance.now() - start;
    return ops / (elapsed / 1000);
}

/** Remove values outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]. */
function filterOutliersIQR(values) {
    if (values.length < 4) return values; // too few to compute quartiles meaningfully
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = percentile(sorted, 25);
    const q3 = percentile(sorted, 75);
    const iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    return values.filter(v => v >= lo && v <= hi);
}

/** Compute p-th percentile from a sorted array using linear interpolation. */
function percentile(sorted, p) {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Median of an array. */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compute descriptive statistics + 95% CI for a set of samples. */
function computeStats(values) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const med = median(values);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
    const stddev = Math.sqrt(variance);
    const se = stddev / Math.sqrt(n);     // standard error of the mean
    const cv = mean !== 0 ? (stddev / mean) * 100 : 0;  // coefficient of variation %
    // 95% CI using t-distribution approximation (z=1.96 for large n)
    const t95 = n >= 30 ? 1.96 : tCritical95(n - 1);
    const ci95lo = mean - t95 * se;
    const ci95hi = mean + t95 * se;
    return {
        n, median: med, mean, variance, stddev, se, cv,
        ci95lo, ci95hi,
        min: sorted[0], max: sorted[n - 1],
    };
}

/** Approximate t-critical value for 95% CI (two-tailed) for small df. */
function tCritical95(df) {
    // Lookup table for common small df values
    const table = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
        6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
        15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042,
    };
    if (table[df]) return table[df];
    // Find nearest lower
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i] <= df) return table[keys[i]];
    }
    return 1.96;
}
