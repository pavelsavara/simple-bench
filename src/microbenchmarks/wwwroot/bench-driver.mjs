// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { dotnet } from './_framework/dotnet.js';

const isBrowser = typeof globalThis.window !== 'undefined';
const BENCH_DURATION_MS = 3000;

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
results['js-interop-ops'] = runBench(() => exports.JsInteropBench.Ping(42), BENCH_DURATION_MS);

// JSON Parse: tight loop calling [JSExport] ParseJson
const sampleJson = JSON.stringify({ count: 42, name: "benchmark", items: [1, 2, 3] });
results['json-parse-ops'] = runBench(() => exports.JsonBench.ParseJson(sampleJson), BENCH_DURATION_MS);

// Exception Handling: tight loop calling [JSExport] ThrowCatch
results['exception-ops'] = runBench(() => exports.ExceptionBench.ThrowCatch(42), BENCH_DURATION_MS);

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function runBench(fn, durationMs) {
    const start = performance.now();
    let ops = 0;
    while (performance.now() - start < durationMs) {
        fn();
        ops++;
    }
    const elapsed = performance.now() - start;
    return Math.round(ops / (elapsed / 1000));
}
