# CI, Docker Images, Triggers & Self-Scheduling

## Workflows

### benchmark.yml — Daily Benchmark Pipeline

**Triggers:**
- `schedule`: daily 04:00 UTC
- `pull_request`: full run forced to `--dry-run`
- `workflow_dispatch` inputs: `sdk_version`, `sdk_channel` (default 11.0), `runtime_commit`, `runtime_pack`, `dry_run`

**Job: build** (container: `ghcr.io/{repo}/browser-bench-build:latest`, 60 min timeout)
1. Run `bench --stages acquire-sdk,build` with SDK/runtime args
2. Read `.run-id` from `artifacts/results/.run-id`
3. Compute matrix from `build-manifest.json` — one entry per `{app, preset}` with `buildLabel = sdkVersion[_runtimePackVersion]`
4. Upload artifacts: `sdk-info`, `build-manifest`, `all-builds` (3d retention)

**Job: measure** (container: `browser-bench-measure:latest`, uid 1001, 30 min timeout)
- Matrix: `include: fromJSON(needs.build.outputs.matrix)`, `fail-fast: false`
- Downloads build artifacts; links pre-installed `node_modules`
- Runs `bench --stages measure --app {app} --preset {preset} --publish-dir "artifacts/publish/{app}/{buildLabel}/{preset}" ...`
- Flags: `--retries 3 --timeout 300000 --ci-run-id ${{ github.run_id }}`
- Upload: `results-{app}-{preset}` with `if: always()` and `if-no-files-found: ignore`

**Dry-run mode** (PR or explicit):
- Build: only `empty-browser` + `devloop` preset
- Measure: only `chrome`, 1 warm run, timeout capped at 55s

### consolidate.yml — Publish Results to gh-pages

**Trigger:** `workflow_run` on Benchmark completion  
**Concurrency:** group `gh-pages-publish` (serialized, no cancel)  
**Condition:** `conclusion == 'success' && event != 'pull_request'`

1. Checkout `gh-pages` branch
2. Checkout `main` (sparse: `bench/`) into `repo/`
3. Download all artifacts from benchmark run
4. `node repo/bench/dist/bench.mjs --stages consolidate /tmp/artifacts/ data/`
5. Commit + push if changes detected

**Known issue — partial result loss:** If any measure job fails, benchmark.yml conclusion is `failure` → consolidate.yml does not trigger → successful partial results sit in GHA artifacts and never reach gh-pages. The consolidation script itself handles partial input gracefully (skips invalid JSONs), so the fix is to change the trigger condition to also consolidate on `failure`.

**Planned fix:** Change condition to `conclusion != 'cancelled' && event != 'pull_request'`. The consolidation script already validates each JSON independently — invalid/missing results are skipped, valid ones are processed. **Status: not yet implemented.**

### docker-build.yml — Weekly Image Rebuild

**Triggers:** weekly Sunday 00:00 UTC, push to `docker/**`, `workflow_dispatch`

Two parallel jobs push to `ghcr.io/{repo}/`:
- `browser-bench-build:latest` — target `browser-bench-build` from Dockerfile
- `browser-bench-measure:latest` — target `browser-bench-measure` from Dockerfile

Registry cache in max mode.

### test.yml — Unit Tests

**Triggers:** push to `main`, `pull_request`  
Single job: `npm ci` → `node --test tests/unit/*.test.mjs` on ubuntu-latest, Node 24.

## Docker Images

Both share a `base` stage (Ubuntu 24.04 + curl, git, jq, python3, Node.js 24).

### browser-bench-build

Adds: `libicu-dev`, `libssl-dev`, `zlib1g-dev`, `libatomic1` (SDK + Emscripten deps).  
Sets `DOTNET_ROOT=/opt/dotnet`. Pre-caches `npm ci`.

### browser-bench-measure

Adds: Playwright system deps (nss, atk, cups, drm, xkbcommon, gbm, pango, cairo, asound, etc).  
Creates non-root user `benchuser` (uid 1001) — Firefox refuses root when HOME owner ≠ uid.

**V8/d8:** Installed via `jsvu`, relocated to `/opt/jsvu/`, symlinked as `/usr/local/bin/d8`.  
**Playwright browsers:** chromium + firefox into `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, world-readable.  
Pre-caches `npm ci` (playwright 1.58.2). Runs as `benchuser`.

## Self-Scheduling (schedule-benchmarks.mjs)

Detects runtime commits with no benchmark results and dispatches `benchmark.yml` for them.

**Flow:**
1. Load `artifacts/runtime-packs.json` (optionally `--refresh` to re-enumerate from NuGet)
2. Fetch gh-pages `index.json` + last 6 months of month indexes
3. Collect all `runtimeGitHash` values into a "tested" set
4. Sort packs by `buildDate` DESC, take `--recent N` (default 30)
5. Filter: commits NOT in tested set (7-char prefix matching)
6. Deduplicate by `runtimeGitHash`
7. Dispatch `gh workflow run benchmark.yml -f runtime_commit={hash}` for up to `--max-dispatches N` (default 3)

**CLI:**
```bash
bench --stages schedule --refresh --max-dispatches 3 --dry-run
bench --stages schedule --recent 30 --repo user/repo --branch main
```

### Known issue — infinite retry of failing commits

The scheduler cannot distinguish "never tried" from "tried and always fails". If measurement always fails for a commit (timeout, crash), no result reaches gh-pages → the scheduler redispatches it every run indefinitely.

**Status: planned (priority).** Will be implemented as part of the `storage` branch work below.

### Storage branch — persistent CI state

A `storage` branch holds state that must survive across CI runs:
- `runtime-packs.json` and `sdk-list.json` — catalog caches (currently local-only; CI runs always start cold)
- `schedule-attempts.json` — tracks `{runtimeGitHash: {attempts: N, lastAttempt: ISO}}`

**Status: not yet implemented (priority).**

#### Flow

**1. Scheduler** (`schedule-benchmarks.mjs`):
1. Fetch `storage` branch → load `runtime-packs.json`, `schedule-attempts.json`
2. Fetch gh-pages `index.json` + month indexes → build "tested" set
3. Filter runtime packs: not in tested set AND `attempts < 3` in schedule-attempts
4. For each commit to dispatch: increment `attempts`, set `lastAttempt` in schedule-attempts
5. Push updated `schedule-attempts.json` to `storage` branch
6. Dispatch `benchmark.yml -f runtime_commit={hash}`

**2. Build pipeline** (`benchmark.yml` build job):
1. Fetch `storage` branch → load `runtime-packs.json`, `sdk-list.json` (warm cache)
2. Build apps, produce artifacts
3. Optionally push updated `sdk-list.json` if new SDK info was resolved

**3. Consolidation** (`consolidate.yml`):
1. Process result artifacts → push to `gh-pages`
2. Fetch `storage` branch → load `schedule-attempts.json`
3. For each runtime hash that produced results: set `lastStatus = "success"`
4. Push updated `schedule-attempts.json` to `storage` branch

#### Retry logic

- Attempt counter is incremented at **dispatch time** (step 1.4)
- Success status is recorded at **consolidation time** (step 3.3)
- If a commit fails and produces no results, `attempts` is already incremented but `lastStatus` remains absent (not "success")
- Scheduler skips commits where `attempts >= 3` AND `lastStatus != "success"`
- Commits where `lastStatus == "success"` are already in gh-pages → filtered by existing tested-set logic

This caps retries at 3 per commit and persists catalog files across CI runs.
