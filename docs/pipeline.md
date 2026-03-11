# Pipeline: Flow of a Single Benchmark Run

Entry point: `scripts/run-pipeline.mjs` (build) → `scripts/run-measure-job.mjs` (measure per app/preset).

In CI these run in separate containers. Locally `scripts/run-bench.mjs` orchestrates both.

## Build Phase (run-pipeline.mjs)

### Phase 0 — Resolve runtime pack (optional)

Activates when `--runtime-pack <version>` or `--runtime-commit <hash>` is provided.

1. Load `artifacts/runtime-packs.json`
2. `--runtime-commit`: find pack entry where `runtimeGitHash.startsWith(hash)` → extract `runtimePackVersion` + `sdkVersionOfTheRuntimeBuild`
3. `--runtime-pack`: direct version lookup → extract `runtimeGitHash`
4. If `--sdk-version` not explicit: override with `sdkVersionOfTheRuntimeBuild` from pack entry
5. Update `SDK_DIR` path to `{os}.sdk{sdkVersionOfTheRuntimeBuild}`

**Error:** commit not found in catalog → throws (user must run `enumerate-runtime-packs.mjs` first).

### Phase 1 — Resolve and install .NET SDK

1. Check cached `sdk-info.json` in SDK dir → skip download if valid
2. Refresh `artifacts/sdk-list.json` by probing Microsoft CDN for latest daily build on `--sdk-channel`
3. Look up SDK version (by channel or explicit `--sdk-version`)
4. Install via `dotnet-install.ps1`/`.sh` with exact version
5. Resolve git hashes: prefer catalog data, fall back to VMR `source-manifest.json`, then `dotnet --info`
6. Write `sdk-info.json` with `{sdkVersion, runtimeGitHash, sdkGitHash, vmrGitHash, runtimeCommitDateTime}`

### Phase 1b — Restore runtime pack (optional)

Only if `--runtime-pack` set:
1. `dotnet restore src/restore/restore-runtime-pack.proj /p:RuntimePackVersion={version}`
2. Update `sdk-info.json` with `runtimePackVersion` + `runtimeGitHash`
3. Set `RUNTIME_PACK_DIR` env → passed to builds as `/p:RuntimePackDir={dir}`

### Phase 2 — Validate no pre-installed workload

Warn if `dotnet workload list` shows `wasm-tools` already present (stale cached SDK).

### Phase 3 — Build non-workload presets

1. Discover apps: readdir `src/`, skip `*-v6v7` dirs, require `.csproj`
2. Filter: `--app` and `--dry-run` (dry-run → empty-browser only)
3. Filter presets: `--preset` and `--dry-run` (dry-run → devloop only)
4. For each app × {devloop, no-workload}: `dotnet publish` via `build-app.mjs`
5. MSBuild args: `/p:BenchmarkPreset={Preset} /p:RuntimeFlavor={Flavor} /p:BuildLabel={label} -c {Config} -bl:{binlog} -o {publishDir}`
6. If `RUNTIME_PACK_DIR` set: adds `/p:RuntimePackDir={dir}`
7. Record `compile-time.json` = wall-clock ms of `dotnet publish`

**Individual build failures** don't stop the pipeline — logged and skipped.

### Phase 4 — Install wasm-tools workload

`dotnet workload install wasm-tools`. Parse installed version from `dotnet workload list`. Update `sdk-info.json` with `workloadVersion`.

### Phase 5 — Build workload presets

Same as Phase 3 but for: `native-relink, aot, no-jiterp, invariant, no-reflection-emit`. Skipped entirely if all workload presets are filtered out.

### Phase 6 — Write build manifest

Writes `artifacts/results/{RUN_TIMESTAMP}/build-manifest.json`:
```json
[
  {
    "app": "empty-browser",
    "preset": "devloop",
    "compileTimeMs": 12345,
    "integrity": { "fileCount": 42, "totalBytes": 15046484 }
  }
]
```

Integrity = count + total size of files in publish dir. Used by measure job to verify artifact wasn't corrupted in transfer.

**Build label**: `{sdkVersion}_{runtimePackVersion}` if runtime pack override, else `{sdkVersion}`. Defaults to `local` if neither. Controls directory nesting under `artifacts/publish/{app}/{buildLabel}/{preset}/`.

**Run ID**: ISO timestamp with colons removed, e.g. `2026-03-05T10-30-45Z`. Written to `artifacts/results/.run-id`.

## Measure Phase (run-measure-job.mjs)

Runs once per `{app, preset}` pair (CI parallelizes via matrix).

### Integrity check

If `--build-manifest` provided: compute actual `{fileCount, totalBytes}` from `--publish-dir`, compare against manifest entry. Exit 1 on mismatch.

### Engine × profile iteration

1. Select engines for app (see model.md routing rules)
2. For each engine, select profiles (mobile only for chrome)
3. For each `{engine, profile}` pair:
   - Build output filename: `{runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json`
   - Call `measure-external.mjs` or `measure-internal.mjs`

### External measurement (measure-external.mjs)

#### Browser flow (Chrome/Firefox)

1. Start static HTTP server with `COOP: same-origin`, `COEP: require-corp` headers (SharedArrayBuffer requirement)
2. Resolve fingerprinted filenames via `.staticwebassets.endpoints.json`
3. Measure file sizes: walk publish dir for `disk-size-total`, `_framework/` for `wasm` + `dll`
4. Launch Playwright browser (chromium or firefox)
5. **Chrome only**: enable CDP — `Network` domain for download tracking, `Performance` domain for memory sampling (100ms interval)
6. **Chrome + mobile profile**: apply CDP `Network.emulateNetworkConditions` + `Emulation.setCPUThrottlingRate`
7. **Cold load**: navigate to page, wait for `globalThis.dotnet_managed_ready` (or timeout) → record `time-to-reach-managed-cold`
8. **Warm loads**: reload N times (default 3, dry-run 1), record each `time-to-reach-managed`, **take minimum**
9. **Chrome only**: sum `encodedDataLength` from all `Network.loadingFinished` events → `download-size-total`; max `JSHeapUsedSize` across samples → `memory-peak`
10. **blazing-pizza**: additionally run `pizza-walkthrough.mjs` — Playwright automates full order flow, returns wall-clock ms

**Retry logic**: catches timeout errors only, retries up to `--retries` (default 2). Non-timeout errors re-thrown immediately.

#### CLI flow (v8/node)

1. Find `main*.js` in publish dir (may be fingerprinted)
2. Run: `d8 --module main.js` or `node main.js` in publish dir
3. Parse stdout for JSON with `time-to-reach-managed` field
4. If marker absent: use wall-clock time as fallback
5. No download/memory metrics available

### Internal measurement (measure-internal.mjs)

For `microbenchmarks` app:
1. Browser navigates to page, waits for `globalThis.bench_complete = true`
2. Reads `globalThis.bench_results` → `{js-interop-ops, json-parse-ops, exception-ops}`
3. Chrome: also collects `memory-peak` via CDP
4. CLI: parses JSON from stdout

### Result JSON output

```json
{
  "meta": {
    "runtimeCommitDateTime": "2026-03-02T12-34-56",
    "sdkVersion": "11.0.100-preview.3.26153.117",
    "runtimeGitHash": "abc1234...",
    "sdkGitHash": "def5678...",
    "vmrGitHash": "aaa1111...",
    "runtime": "mono",
    "preset": "devloop",
    "profile": "desktop",
    "engine": "chrome",
    "app": "empty-browser"
  },
  "metrics": {
    "compile-time": 45200,
    "disk-size-total": 15046484,
    "disk-size-wasm": 8187744,
    "disk-size-dlls": 1758720,
    "download-size-total": 12100920,
    "time-to-reach-managed": 289.15,
    "time-to-reach-managed-cold": 7446,
    "memory-peak": 52428800
  }
}
```

Null metrics are omitted. Values rounded to integers except timing (decimal ms).

## Consolidation (consolidate-results.mjs)

Triggered by `consolidate.yml` after benchmark completion.

1. Scan artifacts dir recursively for `*.json`
2. Validate each via `parseResultJson()`: requires `meta.{runtimeCommitDateTime, runtimeGitHash (valid hex), runtime, preset, engine, app}` + `metrics` object
3. Per valid result:
   - Copy to `data/{year}/{YYYY-MM-DD}/{canonicalFilename}`
   - Upsert into month index (`data/{YYYY-MM}.json`)
4. Month index groups commits by `runtimeGitHash`, each commit has array of result entries (deduped by `runtime+preset+profile+engine+app` — latest wins)
5. Rebuild `data/index.json` with all dimensions and month keys

Invalid/missing JSONs are silently skipped. `compile-time.json`, `sdk-info.json`, `build-manifest.json` are skipped by validation (no `meta` field).

## Local Execution

`scripts/run-bench.mjs` unifies both phases:

| Mode | Flag | Steps |
|------|------|-------|
| Local (no Docker) | `--mode local` | run-pipeline → run-measure-job per manifest entry |
| Docker | `--mode docker` | Build images → run-pipeline in build container → run-measure-job in measure container |

**Skip flags**: `--skip-docker`, `--skip-build`, `--skip-measure`  
**Step override**: `--step {docker-build|build|measure}` runs only that step  
**Filtering**: `--app`, `--preset`, `--engine` (comma-separated)  
**Windows**: Docker commands routed through WSL (`toWslPath()` conversion)

Shell wrappers: `local-bench.sh`/`.ps1` (local mode), `local-docker-bench.sh`/`.ps1` (Docker mode). They check prerequisites (Node, Docker, Playwright browsers) and delegate.
