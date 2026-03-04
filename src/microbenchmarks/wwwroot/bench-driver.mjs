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
const SAMPLE_COUNT = 7;        // total samples (including 1 warm-up)
const SAMPLE_DURATION_MS = 2000; // duration per sample window

const { setModuleImports, getAssemblyExports, runMain } = await dotnet
    .withApplicationArguments("start")
    .create();

setModuleImports('bench-driver.mjs', {
    bench: {
        setBenchReady: () => { globalThis.bench_ready = performance.now(); }
    }
});

await runMain();

// ── Run benchmarks ──────────────────────────────────────────────────────────

const exports = await getAssemblyExports("MicroBenchmarks");
const results = {};

// JS Interop: tight loop calling [JSExport] Ping
results['js-interop-ops'] = runBenchSampled(() => exports.JsInteropBench.Ping(42));

// JSON Parse: tight loop calling [JSExport] ParseJson
const sampleJson = JSON.stringify({ count: 42, name: "benchmark", items: [1, 2, 3] });
results['json-parse-ops'] = runBenchSampled(() => exports.JsonBench.ParseJson(sampleJson));

// Exception Handling: recursive Fibonacci throw/catch (100 iterations per call)
results['exception-ops'] = runBenchSampled(() => exports.ExceptionBench.ThrowCatch(42));

// ── Report results ──────────────────────────────────────────────────────────

// Browser: set on globalThis for Playwright to read
globalThis.bench_results = results;
globalThis.bench_complete = performance.now();

// Update page (if in browser)
if (isBrowser) {
    const el = globalThis.document?.getElementById('status');
    if (el) {
        el.textContent = `Done: interop=${results['js-interop-ops']} ops/s, `
            + `json=${results['json-parse-ops']} ops/s, `
            + `exception=${results['exception-ops']} ops/s`;
    }
}

// CLI: output JSON to stdout (for d8, node)
if (!isBrowser) {
    console.log(JSON.stringify(results));
}

// ── Sampling & statistics ───────────────────────────────────────────────────

/**
 * Collect SAMPLE_COUNT samples, discard warm-up, filter outliers via IQR,
 * return median ops/sec.
 */
function runBenchSampled(fn) {
    const allSamples = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
        allSamples.push(runOneSample(fn, SAMPLE_DURATION_MS));
    }
    // Discard first sample (warm-up)
    const samples = allSamples.slice(1);
    const filtered = filterOutliersIQR(samples);
    return Math.round(median(filtered.length > 0 ? filtered : samples));
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
