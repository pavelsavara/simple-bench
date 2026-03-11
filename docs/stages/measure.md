# Stage: `measure` — Design Document

## Purpose

The `measure` stage is the core data-collection phase of the benchmark pipeline. It takes the compiled .NET WebAssembly applications produced by the `build` stage and runs them against multiple JavaScript engines (Chrome, Firefox, V8/d8, Node) to collect performance metrics: load times, download sizes, memory consumption, and microbenchmark throughput.

Each app × preset × engine × profile combination produces one result JSON file under `artifacts/results/`. These files are later merged into the gh-pages timeline by the `consolidate` stage.

## Inputs from BenchContext

| Field | Type | Description |
|-------|------|-------------|
| `buildManifest` | `BuildManifestEntry[]` | Array of `{app, preset, runtime, compileTimeMs, integrity, publishDir}` from the build stage. Defines what was built and where the publish output lives. |
| `sdkInfo` | `SdkInfo` | Resolved SDK metadata: `sdkVersion`, `runtimeGitHash`, `sdkGitHash`, `vmrGitHash`, `runtimeCommitDateTime`. Populates the `meta` block of every result JSON. |
| `engines` | `Engine[]` | User-selected engine filter (default: all). Intersected with per-app routing rules. |
| `profiles` | `Profile[]` | User-selected profile filter (default: all). Intersected with per-engine constraints. |
| `headless` | `boolean` | Whether to launch browsers headlessly (`true` by default). Set `false` via `--no-headless` for debugging. |
| `warmRuns` | `number` | Number of warm reload iterations per browser measurement (default 3, dry-run 1). The minimum time across all warm runs is recorded. |
| `timeout` | `number` | Per-measurement timeout in milliseconds (default 300,000 for CI; capped at 55,000 for dry-run). |
| `retries` | `number` | Maximum retry attempts on timeout errors (default 3). Non-timeout errors are not retried. |
| `dryRun` | `boolean` | When true: only chrome engine, 1 warm run, reduced timeout. |
| `runtime` | `Runtime` | Runtime flavor (`mono` or `coreclr`). Stored in result metadata. |
| `resultsDir` | `string` | Path to `artifacts/results/` directory. |
| `runId` | `string` | Timestamp-based run ID (e.g. `2026-03-05T10-30-45Z`). |
| `buildLabel` | `string` | Directory nesting label for publish paths. |
| `ciRunId` | `string?` | GitHub Actions run ID, embedded in result metadata for traceability. |
| `apps` | `App[]` | User-selected app filter. |
| `presets` | `Preset[]` | User-selected preset filter. |

## Outputs

### Result JSON files

One file per `{app, preset, engine, profile}` combination, written to `artifacts/results/`:

**Filename pattern:**
```
{runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
```

Example: `2026-03-02T12-34-56-UTC_abc1234_mono_devloop_desktop_chrome_empty-browser.json`

Where:
- `runtimeCommitDateTime` = `sdkInfo.runtimeCommitDateTime`
- `hash7` = first 7 characters of `sdkInfo.runtimeGitHash`
- `runtime`, `preset`, `profile`, `engine`, `app` = dimension values for this run

### Result JSON schema

```json
{
  "meta": {
    "runtimeCommitDateTime": "2026-03-02T12:34:56Z",
    "sdkVersion": "11.0.100-preview.3.26153.117",
    "runtimeGitHash": "abc1234def5678...",
    "sdkGitHash": "def5678...",
    "vmrGitHash": "aaa1111...",
    "runtime": "mono",
    "preset": "devloop",
    "profile": "desktop",
    "engine": "chrome",
    "app": "empty-browser",
    "benchmarkDateTime": "2026-03-05T10:30:45.123Z",
    "warmRunCount": 3,
    "ciRunId": "12345678",
    "ciRunUrl": "https://github.com/.../actions/runs/12345678"
  },
  "metrics": {
    "compile-time": 45200,
    "disk-size-total": 15046484,
    "disk-size-wasm": 8187744,
    "disk-size-dlls": 1758720,
    "download-size-total": 12100920,
    "time-to-reach-managed": 289,
    "time-to-reach-managed-cold": 7446,
    "memory-peak": 52428800
  }
}
```

**Metric rounding**: All values are rounded to integers via `Math.round()`. Null/undefined metrics are stripped entirely (not stored as `null`).

**Optional CI fields**: `ciRunId` and `ciRunUrl` are only present when running in GitHub Actions.

---

## Measurement Matrix

The measure stage iterates a three-level nested loop driven by the build manifest and routing rules:

```
for each {app, preset} in buildManifest (filtered by ctx.apps, ctx.presets):
    engines = getEnginesForApp(app, ctx.engines)
    for each engine in engines:
        profiles = getProfilesForEngine(engine, ctx.profiles)
        for each profile in profiles:
            if APP_CONFIG[app].internal:
                measureInternal(app, preset, engine, profile)
            else:
                measureExternal(app, preset, engine, profile)
```

### Engine Routing Rules (`APP_CONFIG` + `getEnginesForApp`)

| App | Available Engines | Reason |
|-----|-------------------|--------|
| `empty-browser` | chrome, firefox, v8, node | Default — all 4 engines |
| `empty-blazor` | chrome, firefox | `browserOnly: true` — requires DOM |
| `blazing-pizza` | chrome, firefox | `browserOnly: true` — requires DOM |
| `microbenchmarks` | chrome, firefox, v8, node | Default — all 4 engines |

Dry-run override: only `['chrome']` regardless of app.

### Profile Routing Rules (`getProfilesForEngine`)

| Engine | Available Profiles | Reason |
|--------|--------------------|--------|
| `chrome` | desktop, mobile | Mobile requires CDP (Chromium-only) |
| `firefox` | desktop | No CDP → no throttling emulation |
| `v8` | desktop | CLI engine — no browser emulation |
| `node` | desktop | CLI engine — no browser emulation |

### Measurement Script Routing (`APP_CONFIG.internal`)

| App | Script | Marker |
|-----|--------|--------|
| `empty-browser` | `measure-external` | `dotnet_managed_ready` |
| `empty-blazor` | `measure-external` | `dotnet_managed_ready` |
| `blazing-pizza` | `measure-external` + pizza walkthrough | `dotnet_managed_ready` |
| `microbenchmarks` | `measure-internal` | `bench_complete` + `bench_results` |

### Full Combination Matrix (per preset × runtime)

| App | chrome desktop | chrome mobile | firefox desktop | v8 desktop | node desktop | Total |
|-----|:-:|:-:|:-:|:-:|:-:|:-:|
| empty-browser | ✓ | ✓ | ✓ | ✓ | ✓ | 5 |
| empty-blazor | ✓ | ✓ | ✓ | — | — | 3 |
| blazing-pizza | ✓ | ✓ | ✓ | — | — | 3 |
| microbenchmarks | ✓ | ✓ | ✓ | ✓ | ✓ | 5 |
| **Total** | | | | | | **16** |

With 7 mono presets: **112 total measurement runs per SDK commit.**

---

## Integrity Verification

Before measuring any app × preset pair, the stage verifies the published build artifacts haven't been corrupted in transfer (critical for CI where build and measure run in separate containers):

1. Read `build-manifest.json` — locate the entry matching `{app, preset}`
2. Walk the publish directory recursively, counting files and summing byte sizes
3. Compare `{fileCount, totalBytes}` against `integrity` field from manifest
4. **Mismatch → abort** that app/preset (exit code 1)

---

## External Measurement (`measure-external`)

Used for all apps except `microbenchmarks`. Splits into two code paths: **browser** and **CLI**.

### Common Setup (both paths)

1. **Read SDK info** — Load `sdk-info.json` for result metadata
2. **Read compile time** — Load `compile-time.json` written by the build stage
3. **Measure file sizes** — Walk the publish directory:
   - `disk-size-total`: recursive sum of all file sizes in publish dir
   - `disk-size-wasm`: sum of `*.wasm` files in `_framework/`
   - `disk-size-dlls`: sum of `*.dll` files in `_framework/`
4. **Load fingerprint map** — Parse `*.staticwebassets.endpoints.json` from publish parent dir. Maps `label` → `fingerprint` for resolving `#[.{fingerprint}]` patterns in HTML (e.g., `main#[.{fingerprint}].js` → `main.gf82s7dqcs.js`)

### Browser Flow (Chrome / Firefox)

#### 1. Static HTTP Server

Start a Node.js HTTP server on `127.0.0.1` (auto-assigned port) serving the publish directory with mandatory headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Timing-Allow-Origin: *
```

These headers enable `SharedArrayBuffer` (required for .NET threading support) and high-resolution Resource Timing data.

The server resolves `#[.{fingerprint}]` patterns in HTML responses using the fingerprint map, and includes path traversal protection (rejects paths escaping the root).

#### 2. Browser Launch

Launch Playwright browser instance:
- **Chrome**: `pw.chromium.launch({ headless })` — Playwright's bundled Chromium
- **Firefox**: `pw.firefox.launch({ headless })` — Playwright's bundled Firefox

Create a new browser context and page.

#### 3. CDP Session Setup (Chrome Only)

Chrome DevTools Protocol enables advanced metrics collection. Firefox has no CDP — it collects timing only.

```
CDP Session → page
├── Network.enable          → track download sizes
├── Performance.enable      → sample memory metrics
├── Network.emulateNetworkConditions(...)  → mobile profile throttle
└── Emulation.setCPUThrottlingRate(...)    → mobile profile CPU slowdown
```

**Network tracking**: Listen for `Network.loadingFinished` events, accumulate `encodedDataLength` into `downloadSizeTotal`. This captures compressed-over-wire transfer sizes.

**Memory sampling**: An async poller loop runs every 100ms:
```javascript
while (memorySampling) {
    const metrics = await client.send('Performance.getMetrics');
    const heapUsed = metrics.metrics.find(m => m.name === 'JSHeapUsedSize');
    if (heapUsed.value > memoryPeak) memoryPeak = heapUsed.value;
    await sleep(100);
}
```

Records the **maximum** `JSHeapUsedSize` observed across the entire measurement lifecycle (cold + warm loads).

#### 4. Profile Emulation (mobile)

Applied via CDP before any navigation. Two profiles defined in `throttle-profiles`:

| Profile | CPU | Network | Engine |
|---------|-----|---------|--------|
| `desktop` | No throttle (null) | No throttle | All |
| `mobile` | 3x slowdown | 20 Mbps ↓ / 5 Mbps ↑ / 70ms RTT | Chrome only |

Mobile emulation simulates a ~3-year-old Android phone on US 4G LTE:
- `Emulation.setCPUThrottlingRate({ rate: 3 })` — CPU 3x slower
- `Network.emulateNetworkConditions({ downloadThroughput: 2500000, uploadThroughput: 625000, latency: 70 })` — network bytes/sec

#### 5. Cold Load

```javascript
await page.goto(pageUrl, { timeout, waitUntil: 'load' });
await page.waitForFunction(
    () => globalThis.dotnet_managed_ready !== undefined,
    null, { timeout }
);
const cold = await page.evaluate(() => globalThis.dotnet_managed_ready);
```

- Navigate to the page URL
- Wait for the `load` event
- Wait for `globalThis.dotnet_managed_ready` to be set (a `performance.now()` timestamp set by C#→JS interop when managed code starts executing)
- Record `time-to-reach-managed-cold` = value of the marker

**Apps without timing marker** (empty-blazor, blazing-pizza): The `waitForFunction` will timeout. The current code does not have a fallback for browser-based apps without the marker — these apps rely on the timeout/retry mechanism and the cold load value may be unavailable.

**TODO:** Implement `dotnet_managed_ready` timing marker for all Blazor apps via a Blazor startup hook, so `time-to-reach-managed` and `time-to-reach-managed-cold` are available for all apps.

#### 6. Warm Loads

```javascript
for (let i = 0; i < warmRunCount; i++) {
    await page.reload({ timeout, waitUntil: 'load' });
    await page.waitForFunction(
        () => globalThis.dotnet_managed_ready !== undefined,
        null, { timeout }
    );
    const warm = await page.evaluate(() => globalThis.dotnet_managed_ready);
    if (warm < warmMin) warmMin = warm;
}
```

- Reload the page N times (default 3)
- Each reload preserves the browser cache → measures **warm** load time
- Record the **minimum** `time-to-reach-managed` across all warm runs (most representative, filters noise)

#### 7. App-Specific Walkthroughs

**blazing-pizza** only: After warm loads, runs `runPizzaWalkthrough()` — a Playwright automation script that:

1. Navigates to home page, waits for specials to render
2. Clicks first pizza, configures toppings + size
3. Adds to cart, proceeds to checkout
4. Fills delivery address form
5. Places order, waits for tracking page

Returns wall-clock duration (`performance.now()` delta) as `pizza-walkthru` metric.

#### 8. CDP Cleanup

```javascript
await sleep(2000);           // let memory settle for final peak reading
memorySampling = false;       // stop the poller loop
await memoryPoller;           // wait for poller to exit
await client.send('Performance.disable');
await client.send('Network.disable');
```

The 2-second sleep before stopping memory sampling ensures the peak includes any post-load GC or settle activity.

#### 9. Result Assembly

```javascript
return {
    downloadSizeTotal: useCDP ? downloadSizeTotal : null,     // Chrome only
    timeToReachManagedCold,                                    // All browsers
    timeToReachManaged: Number.isFinite(warmMin) ? warmMin : null,  // All browsers
    memoryPeak: useCDP ? (memoryPeak || null) : null,          // Chrome only
    pizzaWalkthru,                                             // blazing-pizza only
};
```

### CLI Flow (V8/d8, Node)

For apps not requiring a DOM. No browser launched — runs the entry script directly.

#### 1. Find Entry Script

Scan the publish directory for `main*.js` (may be fingerprinted, e.g. `main.z43bqdwb86.js`):
```javascript
const entryFile = files.find(f => f.startsWith('main') && f.endsWith('.js'));
```

#### 2. Execute Engine

| Engine | Command | Arguments |
|--------|---------|-----------|
| `v8` | `d8` (Linux) / `v8.cmd` (Windows) | `--module main.js` |
| `node` | `node` | `main.js` |

Runs synchronously via `execFileSync` with `cwd` set to the publish directory and the configured timeout.

#### 3. Parse stdout

The `main.js` entry script detects non-browser environments and outputs timing as JSON to stdout:

```javascript
// In main.js (app code):
if (typeof window === 'undefined' && typeof globalThis.dotnet_managed_ready !== 'undefined') {
    console.log(JSON.stringify({ 'time-to-reach-managed': globalThis.dotnet_managed_ready }));
}
```

The measurement script scans stdout lines for a JSON object with `time-to-reach-managed`:
```javascript
for (const line of stdout.split('\n')) {
    try { 
        const parsed = JSON.parse(trimmed);
        if (parsed['time-to-reach-managed'] != null) timeToReachManaged = parsed[...];
    } catch { /* not JSON */ }
}
```

#### 4. CLI Result

```javascript
return {
    downloadSizeTotal: null,             // Not available in CLI
    timeToReachManagedCold: timeToReachManaged ?? wallTimeMs,  // Fallback to wall-clock
    timeToReachManaged: timeToReachManaged ?? wallTimeMs,      // Same for CLI (single run)
    memoryPeak: null,                    // Not available in CLI
    pizzaWalkthru: null,                 // Not applicable
};
```

CLI engines report the same value for both cold and warm (only one execution). If the timing marker is absent, falls back to `performance.now()` wall-clock time.

---

## Internal Measurement (`measure-internal`)

Used exclusively for the `microbenchmarks` app. Collects throughput metrics (ops/sec) rather than load times.

### Browser Flow

1. **Static server + browser launch** — Same as external (COOP/COEP headers, fingerprint resolution, CDP for Chrome)
2. **Navigate and wait** — Instead of `dotnet_managed_ready`, waits for `bench_complete`:
   ```javascript
   await page.waitForFunction(
       () => globalThis.bench_complete !== undefined,
       null, { timeout }
   );
   ```
3. **Read results** — `const results = await page.evaluate(() => globalThis.bench_results)`
4. **CDP memory** — Same polling as external; `memory-peak` is appended to results
5. **Throttle profiles** — Same mobile emulation applies (CDP network + CPU throttling for Chrome)

### CLI Flow

1. **Find driver script** — Looks for `bench-driver*.mjs` (not `main.js`):
   ```javascript
   const driverFile = files.find(f => f.startsWith('bench-driver') && f.endsWith('.mjs'));
   ```
2. **Execute** — Same `execFileSync` with `d8 --module` or `node`
3. **Parse output** — Uses `parseCliOutput()` which scans from the **last line backwards** for valid JSON (handles .NET diagnostic output that may precede benchmark results)
4. **Validate** — `validateBenchResults()` ensures all three internal metrics are positive finite numbers

### Internal Metrics

| Metric | Key | What It Measures |
|--------|-----|-----------------|
| JS Interop | `js-interop-ops` | ops/sec — tight loop: JS calls C# `[JSExport]` method |
| JSON Parsing | `json-parse-ops` | ops/sec — JS passes JSON to C# method that deserializes |
| Exception Handling | `exception-ops` | ops/sec — JS calls C# method that throws/catches exception |

Plus `memory-peak` (Chrome only) from CDP sampling.

### Result JSON (Internal)

```json
{
  "meta": { "...same dimensions as external..." },
  "metrics": {
    "compile-time": 23000,
    "memory-peak": 42000000,
    "js-interop-ops": 1250000,
    "json-parse-ops": 890000,
    "exception-ops": 45000
  }
}
```

Note: No disk-size or download-size metrics for internal measurement. Only compile-time (from build stage), memory-peak (Chrome only), and the three ops/sec metrics.

---

## Retry Logic

Retry applies per `{engine, profile}` measurement attempt, wrapping the entire browser lifecycle:

```
for attempt = 0 to maxRetries:
    try:
        launch browser → cold load → warm loads → collect → close
        return results
    catch err:
        if isTimeoutError(err):
            log "Retry {attempt}/{maxRetries}..."
            continue
        else:
            throw err  // non-timeout errors propagate immediately
throw lastError  // all retries exhausted
```

**Timeout detection**: An error is considered a timeout if:
- `err.name === 'TimeoutError'` (Playwright native)
- `err.message` contains `'Timeout'` or `'timeout'`

**Default retry counts**:
- CI: `--retries 3`
- Dry-run: `--retries 1`

**Non-timeout errors** (browser crash, missing files, network failure) are rethrown immediately — no retry.

**Per app×preset failure**: If one `{engine, profile}` pair fails after all retries, the failure is logged and counted. The stage continues with remaining engines/profiles for that app×preset, then continues to the next manifest entry. Only if **all** measurements fail does the stage exit with code 1.

---

## Error Handling

### Browser Crashes

Playwright wraps browser crashes as regular errors. These are **not** timeout errors, so they propagate immediately without retry. The `finally` block ensures `browser.close()` is called.

### Missing Timing Marker

For apps **with** a marker (empty-browser, microbenchmarks): `waitForFunction` waits up to the timeout. If the marker is never set (e.g. managed code fails to start), this times out → retry logic kicks in.

For apps **without** a marker (empty-blazor, blazing-pizza): The `waitForFunction` for `dotnet_managed_ready` will timeout since these apps don't set it. This is handled by the retry/timeout mechanism — in practice these apps rely on the cold load completing within the timeout.

### Missing Entry Script (CLI)

If `main*.js` (external) or `bench-driver*.mjs` (internal) cannot be found in the publish directory, throws immediately with the file listing for debugging.

### Server Cleanup

The static HTTP server is closed in all code paths:
- Successful measurement: closed after page/context close
- Timeout retry: server persists across retries (started once, closed after all attempts)
- Non-timeout error: `await srv.close()` called before rethrow

### Console Error Logging

Browser page errors are forwarded to stderr for debugging:
```javascript
page.on('console', msg => {
    if (msg.type() === 'error') console.error(`  [page] ${msg.text()}`);
});
page.on('pageerror', err => console.error(`  [page error] ${err.message}`));
```

---

## Metric Availability Matrix

Not all metrics are available from all engines:

| Metric | Chrome | Firefox | V8 | Node |
|--------|:------:|:-------:|:--:|:----:|
| `compile-time` | ✓ | ✓ | ✓ | ✓ |
| `disk-size-total` | ✓ | ✓ | ✓ | ✓ |
| `disk-size-wasm` | ✓ | ✓ | ✓ | ✓ |
| `disk-size-dlls` | ✓ | ✓ | ✓ | ✓ |
| `download-size-total` | ✓ | — | — | — |
| `time-to-reach-managed` | ✓ | ✓ | ✓ | ✓ |
| `time-to-reach-managed-cold` | ✓ | ✓ | ✓ | ✓ |
| `memory-peak` | ✓ | — | — | — |
| `pizza-walkthru` | ✓ | — | — | — |
| `js-interop-ops` | ✓ | ✓ | ✓ | ✓ |
| `json-parse-ops` | ✓ | ✓ | ✓ | ✓ |
| `exception-ops` | ✓ | ✓ | ✓ | ✓ |

`download-size-total` and `memory-peak` require CDP → Chrome only.
`pizza-walkthru` uses Playwright automation → Chrome only (runs after warm loads, desktop profile).
File-size metrics (`disk-size-*`) are measured from the filesystem, not from browser APIs — available for all engines.
`compile-time` comes from the build stage's `compile-time.json` — engine-independent.

---

## Fingerprint Resolution

Modern .NET SDK produces fingerprinted static assets (e.g. `main.z43bqdwb86.js`) with a mapping in `*.staticwebassets.endpoints.json`. The measurement system resolves these at two levels:

1. **Static server**: Replaces `#[.{fingerprint}]` patterns in HTML responses — so `<script src="main#[.{fingerprint}].js">` becomes `<script src="main.z43bqdwb86.js">`
2. **CLI measurement**: Finds the entry script by glob (`main*.js` or `bench-driver*.mjs`) since the exact fingerprint is unknown ahead of time

---

## Orchestration: How the Stage is Invoked

### In CI (benchmark.yml)

The build job writes a matrix from `build-manifest.json`. Each `{app, preset}` pair becomes a separate GitHub Actions matrix job, running in the `browser-bench-measure` Docker container:

```yaml
# Conceptual CI flow:
build:
  - dotnet publish all app×preset combinations
  - write build-manifest.json with matrix output

measure (matrix: app × preset):
  - download build artifacts
  - node run-measure-job.mjs --app {app} --preset {preset} ...
```

`run-measure-job.mjs` handles the engine × profile inner loop for one `{app, preset}`.

### In the TypeScript CLI (`bench --stages measure`)

The `measure` stage function receives the full `BenchContext` including `buildManifest`. It iterates all manifest entries, applying app/preset/engine/profile filters, and launches measurements. The current stub at `bench/src/stages/measure.ts` is a placeholder.

### Via `run-bench.mjs` (local orchestrator)

`run-bench.mjs` reads the build manifest, applies filters, and calls `run-measure-job.mjs` per manifest entry:

```
stepMeasure():
  manifest = readFile(build-manifest.json)
  for entry in manifest (filtered):
      execFile('node', ['run-measure-job.mjs', '--app', entry.app, '--preset', entry.preset, ...])
```

In Docker mode, each measurement runs inside the `browser-bench-measure` container via `docker run`.

---

## Existing Code Reference

### Key Files

| File | Role |
|------|------|
| `bench/src/stages/measure.ts` | Primary measurement stage — browser + CLI measurement for all external apps, microbenchmark measurement |
| `bench/src/lib/measure-utils.ts` | Static server, file size walker, result JSON builder, compile-time/SDK-info readers |
| `bench/src/lib/internal-utils.ts` | CLI engine commands, stdout JSON parser, benchmark result validation |
| `bench/src/lib/throttle-profiles.ts` | Desktop/mobile profile definitions (CPU + network throttle params) |
| `bench/src/lib/metrics.ts` | Canonical metric registry (names, units, categories) |
| `bench/src/lib/pizza-walkthrough.ts` | Playwright automation for blazing-pizza order walkthrough |
| `bench/src/enums.ts` | `APP_CONFIG`, `getEnginesForApp()`, `getProfilesForEngine()`, engine/profile routing logic |
| `bench/src/context.ts` | `BenchContext`, `BuildManifestEntry`, `SdkInfo` type definitions |

### Key Patterns to Preserve

1. **Static server with COOP/COEP** — Required for SharedArrayBuffer; without these headers, threading won't work and measurements will be invalid.

2. **Fingerprint resolution** — The static server resolves `#[.{fingerprint}]` only in HTML responses. CLI engines find the entry by glob matching.

3. **CDP memory poller as async loop** — Not a setInterval; it's a `while(memorySampling)` loop with `await sleep(100)`. Stops cleanly by setting the flag to false and awaiting the poller promise.

4. **Network.loadingFinished accumulation** — Download size is the sum of `encodedDataLength` from all `Network.loadingFinished` CDP events. This captures compressed transfer sizes including all sub-resources.

5. **Warm-load minimum** — Not average. The minimum of N warm reloads is the reported value (most representative, filters out GC pauses and other noise).

6. **2-second settle before final memory read** — After warm loads complete, a 2-second sleep before stopping the memory poller ensures the peak captures post-load GC pressure.

7. **Result file naming convention** — Must match the pattern `{runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json` for consolidation to work.

8. **Null metric stripping** — `buildResultJson()` removes `null`/`undefined` metrics and rounds all numeric values to integers. The result JSON only contains metrics that were actually measured.

9. **CLI fallback to wall-clock** — When CLI engines (`v8`, `node`) can't find the `time-to-reach-managed` marker in stdout, they use the total wall-clock execution time as a fallback for both cold and warm values.

10. **Internal CLI parsing from last line** — `parseCliOutput()` scans stdout backwards because .NET may emit diagnostic output before the benchmark results JSON line.
