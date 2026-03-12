// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { dotnet, exit } from './_framework/dotnet.js'

async function outer() {
    const isBrowser = typeof globalThis.window !== 'undefined';
    globalThis.js_loaded = performance.now();

    const { setModuleImports, getAssemblyExports, runMain } = await dotnet
        .withApplicationArguments("start")
        .create();

    setModuleImports('main.js', {
        bench: {
            setManagedReady: () => { globalThis.dotnet_managed_ready = performance.now(); }
        }
    });

    globalThis.dotnet_created = performance.now();
    globalThis.bench_results = {};

    await inner({ setModuleImports, getAssemblyExports, runMain, exit }, globalThis.bench_results);

    globalThis.dotnet_exit = performance.now();

    Object.assign(globalThis.bench_results, {
        'time-to-create-dotnet': Math.round(globalThis.dotnet_created - globalThis.js_loaded),
        'time-to-reach-managed': Math.round(globalThis.dotnet_managed_ready - globalThis.js_loaded),
        'time-to-exit': Math.round(globalThis.dotnet_exit - globalThis.js_loaded),
    });

    if (isBrowser) {
        const el = globalThis.document?.getElementById('status');
        if (el) {
            el.textContent = JSON.stringify(globalThis.bench_results, null, 2);
        }
    } else {
        console.log(JSON.stringify(globalThis.bench_results));
    }
}

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
const SAMPLE_COUNT = 7;        // total samples (including 1 warm-up)
const SAMPLE_DURATION_MS = 2000; // duration per sample window

async function inner({ setModuleImports, getAssemblyExports, runMain, exit }, results) {
    await runMain("MicroBenchmarks", []);

    const exports = await getAssemblyExports("MicroBenchmarks");

    // JS Interop: tight loop calling [JSExport] Ping
    results['js-interop-ops'] = runBenchSampled(() => exports.JsInteropBench.Ping(42));

    // JSON Parse: tight loop calling [JSExport] ParseJson
    const sampleJson = JSON.stringify({ count: 42, name: "benchmark", items: [1, 2, 3] });
    results['json-parse-ops'] = runBenchSampled(() => exports.JsonBench.ParseJson(sampleJson));

    // Exception Handling: recursive Fibonacci throw/catch (100 iterations per call)
    results['exception-ops'] = runBenchSampled(() => exports.ExceptionBench.ThrowCatch(42));

    exit(0);
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

await outer();
