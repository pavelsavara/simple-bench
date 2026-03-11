# Stage: `transform-views`

Detailed design for the `transform-views` pipeline stage.

**Status: designed, not yet implemented.** The current stub is in `bench/src/stages/transform-views.ts`.

---

## Purpose

Build pre-aggregated view JSON files from consolidated benchmark data so the dashboard UI can load them efficiently. The transformer sits between consolidation (which stores raw per-result JSON files indexed by month) and the GitHub Pages deployment:

```
consolidate
  ↓ gh-pages/data/{YYYY-MM}.json  (month indexes)
  ↓ gh-pages/data/{year}/{date}/   (individual result files)
transform-views                    ← THIS STAGE
  ↓ gh-pages/data/views/index.json
  ↓ gh-pages/data/views/{week}/header.json + {app}_{metric}.json
  ↓ gh-pages/data/views/releases/{net}/header.json + {app}_{metric}.json
deploy to gh-pages branch
```

Without this stage the dashboard would have to fetch every individual result file (hundreds per week) and aggregate client-side. The transformer pre-computes the exact file structure the UI needs: one request per chart panel per week/release.

---

## Inputs

### From `BenchContext`

| Field | Usage |
|-------|-------|
| `ctx.dataDir` | Root of the `gh-pages/data/` directory (contains month indexes + result files + views/) |
| `ctx.verbose` | Controls progress logging |
| `ctx.dryRun` | *(reserved)* — could limit processing to most recent week only |

### From the filesystem (`gh-pages/data/`)

| Path | Format | Description |
|------|--------|-------------|
| `{YYYY-MM}.json` | Month index JSON | Commit metadata + `results[]` array with file references |
| `{year}/{date}/{result}.json` | Result JSON | `{ meta, metrics }` — full measurement data |
| `views/index.json` | Views global index | Previous transformer state (for incremental mode) |

#### Month Index Shape (produced by `consolidate-results.mjs`)

```json
{
  "month": "2026-03",
  "commits": [
    {
      "runtimeGitHash": "abc1234def567890...",
      "sdkGitHash": "111222333...",
      "vmrGitHash": "aaa111bbb...",
      "date": "2026-03-02",
      "time": "12-34-56-UTC",
      "sdkVersion": "11.0.100-preview.3.26153.117",
      "results": [
        {
          "runtime": "mono",
          "preset": "devloop",
          "profile": "desktop",
          "engine": "chrome",
          "app": "empty-browser",
          "file": "2026/2026-03-02/12-34-56-UTC_abc1234_mono_devloop_desktop_chrome_empty-browser.json",
          "metrics": ["compile-time", "disk-size-total", "time-to-reach-managed", ...]
        }
      ]
    }
  ]
}
```

#### Individual Result Shape

```json
{
  "meta": {
    "runtimeCommitDateTime": "2026-03-02",
    "sdkVersion": "11.0.100-preview.3.26153.117",
    "runtimeGitHash": "abc1234def567890...",
    "sdkGitHash": "111222333...",
    "vmrGitHash": "aaa111bbb...",
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
    "time-to-reach-managed": 289.15,
    "memory-peak": 52428800
  }
}
```

---

## Outputs

All output files go into `gh-pages/data/views/`.

### 1. Global Index — `views/index.json`

```json
{
  "lastUpdated": "2026-03-05T12:00:00Z",
  "activeRelease": "net11",
  "releases": ["net7", "net8", "net9", "net10"],
  "weeks": ["2026-03-02", "2026-02-23", "2026-02-16"],
  "apps": ["empty-browser", "empty-blazor", "blazing-pizza", "microbenchmarks"],
  "metrics": {
    "empty-browser": ["compile-time", "disk-size-total", ...],
    "microbenchmarks": ["js-interop-ops", "json-parse-ops", ...]
  },
  "dimensions": {
    "runtimes": ["mono"],
    "presets": ["devloop", "no-workload", "aot", ...],
    "profiles": ["desktop", "mobile"],
    "engines": ["chrome", "firefox", "v8", "node"]
  }
}
```

| Field | Source |
|-------|--------|
| `lastUpdated` | ISO timestamp of current transformer run |
| `activeRelease` | Highest SDK major version across all data → `net{major}` |
| `releases` | All SDK major versions lower than the active → sorted ascending |
| `weeks` | Monday dates of all week buckets that contain data → sorted descending (newest first) |
| `apps` | Union of all app values found in data |
| `metrics` | Per-app: union of all metric keys found in data (discovery, not hardcoded) |
| `dimensions` | Union of all dimension values (runtime, preset, profile, engine) |

### 2. Week Header — `views/{week}/header.json`

```json
{
  "week": "2026-03-02",
  "columns": [
    {
      "sdk": "11.0.100-preview.3.26151.103",
      "runtimeHash": "abc1234def567890...",
      "sdkHash": "111222333...",
      "vmrHash": "aaa111bbb...",
      "date": "2026-03-02",
      "time": "10-00-00-UTC"
    },
    { "sdk": "...", "runtimeHash": "...", "date": "2026-03-03", "time": "..." }
  ],
  "apps": {
    "empty-browser": ["compile-time", "disk-size-total", "time-to-reach-managed"],
    "microbenchmarks": ["js-interop-ops", "json-parse-ops"]
  }
}
```

- `columns` sorted chronologically by `(date, time)`
- `apps` map lists only metric data files that actually exist in this week directory (prevents UI from making 404 requests)

### 3. Week Data File — `views/{week}/{app}_{metric}.json`

```json
{
  "mono/devloop/desktop/chrome": [56, 51, 48, null, 52],
  "mono/no-workload/desktop/chrome": [51, 49, 52, 50, null]
}
```

- Keys = row key strings: `{runtime}/{preset}/{profile}/{engine}`
- Values = arrays of numbers or `null`, length = number of columns in the week header
- Rows that are entirely `null` are **omitted**
- Values are integers (rounded) except timing which may be decimal ms
- File is **minified** (no whitespace)

### 4. Release Header — `views/releases/{net}/header.json`

```json
{
  "release": "net9",
  "sdkMajor": 9,
  "columns": [
    { "sdk": "9.0.100", "runtimeHash": "...", "date": "2024-11-12", ... },
    { "sdk": "9.0.101", "runtimeHash": "...", "date": "2024-12-10", ... }
  ],
  "apps": {
    "empty-browser": ["compile-time", "disk-size-total"]
  }
}
```

- `columns` sorted by SDK version (semver-aware), not by date
- Preview/RC versions sort before GA: `9.0.100-preview.1 < 9.0.100-rc.1 < 9.0.100 < 9.0.101`

### 5. Release Data File — `views/releases/{net}/{app}_{metric}.json`

Same format as weekly data files.

---

## Algorithm

The transformer runs in four sequential phases.

### Phase 1: Load Consolidated Data

```
inputs: dataDir (gh-pages/data/)
outputs: results[] — array of { commit metadata, row key, app, metric values }

for each month index file (data/{YYYY-MM}.json):
    for each commit in monthIndex.commits:
        sdkMajor = getSdkMajor(commit.sdkVersion)
        if sdkMajor is null: skip commit  // unknown SDK version
        weekMonday = getWeekMonday(commit.date)

        for each resultRef in commit.results:
            load result JSON from data/{resultRef.file}
            if load fails: skip (log warning)

            yield {
                sdkMajor,
                weekMonday,
                commit: { sdk, runtimeHash, sdkHash, vmrHash, date, time },
                rowKey: buildRowKey(result.meta),
                app: result.meta.app,
                metrics: result.metrics
            }
```

**Lazy loading**: Result JSON files are loaded on demand (not all at once) to bound memory. In practice, the transformer may need to hold one week's worth of results in memory at a time.

### Phase 2: Bucket Results

Each loaded result is assigned to exactly one bucket:

```
if sdkMajor < activeReleaseMajor:
    bucket = releaseBuckets[sdkMajor]      // frozen release
else:
    bucket = weekBuckets[weekMonday]        // active release, grouped by week
```

Where:
- **`activeReleaseMajor`** = the highest `sdkMajor` found across all data
- **Frozen releases** cover all lower SDK major versions

Within each bucket, results are organized into a 2D grid:

```
            column 0          column 1          column 2
row 0 (mono/devloop/…/chrome)    42 ms            44 ms           null
row 1 (mono/aot/…/chrome)       38 ms            37 ms           36 ms
row 2 (mono/devloop/…/firefox)  null             55 ms           53 ms
```

- **Column** = unique commit, identified by `runtimeHash` (weekly buckets) or `runtimeHash + sdkVersion` (release buckets)
- **Row** = unique combination `{runtime}/{preset}/{profile}/{engine}`

### Phase 3: Build Output Structures

For each bucket:

1. **Sort columns**:
   - Weekly: by `(date, time)` ascending (chronological)
   - Release: by `sdkVersion` (semver-aware comparison, see below)

2. **Build column index**: `Map<columnKey, columnPosition>`

3. **For each (app, metric) pair** found in the bucket:
   - Collect all row keys that have at least one non-null value for this metric
   - For each row key: create an array of length = column count
   - Fill positions from matching results; `null` for gaps
   - Skip rows that are entirely null

4. **Build file manifest** (`apps` map in header): for each app, list the metric keys that produced at least one non-null row

### Phase 4: Write Files

For each bucket, write output files using **write-to-temp-then-rename** for atomicity:

```typescript
async function safeWrite(targetPath: string, content: string): Promise<void> {
    const tmp = targetPath + '.tmp';
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, targetPath);
}
```

**Write order**:
1. Data files (`{app}_{metric}.json`) — minified JSON
2. Header files (`header.json`) — minified JSON
3. Global `views/index.json` — written last (makes the update atomic from the UI's perspective)

---

## Key Helper Functions

### `getSdkMajor` — Parse SDK Major Version

```typescript
function getSdkMajor(sdkVersion: string): number | null {
    if (!sdkVersion || sdkVersion === 'unknown') return null;
    const major = parseInt(sdkVersion.split('.')[0], 10);
    return Number.isFinite(major) ? major : null;
}
```

Results with unparseable or `'unknown'` SDK versions are **skipped entirely** (legacy data that predates SDK tracking).

### `getWeekMonday` — Map Date to ISO Week Monday

```typescript
function getWeekMonday(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();                   // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = (day === 0 ? -6 : 1) - day;     // offset to Monday
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);          // "YYYY-MM-DD"
}
```

Example: `2026-03-05` (Thursday) → `2026-03-02` (Monday).

### `buildRowKey` — Construct Row Key

```typescript
function buildRowKey(meta: ResultMeta): string {
    const profile = meta.profile || 'desktop';
    return `${meta.runtime}/${meta.preset}/${profile}/${meta.engine}`;
}
```

The UI parses row keys back into four dimensions for filter matching.

### `compareSdkVersion` — Semver-Aware SDK Sorting

For frozen release columns, sort by SDK version string:

```typescript
function compareSdkVersion(a: string, b: string): number {
    // Split into (major, minor, patch, prerelease) parts
    // Preview/RC sorts before GA: presence of '-' makes it earlier
    // Within prerelease: compare label then numeric build numbers
    // GA versions: compare major.minor.patch numerically
    ...
}
```

Ordering guarantees:
```
9.0.100-preview.1.xxx < 9.0.100-rc.1.xxx < 9.0.100 < 9.0.101 < 9.0.102
```

---

## Bucketing Strategy

### Weekly Buckets (Active Release)

All results whose `sdkMajor` equals the active release major are grouped into weekly buckets keyed by Monday date. This provides a rolling timeline view of daily builds for the in-development .NET release.

**Rationale**: Daily builds of the active release produce 1–7 data points per week. Grouping by week keeps the number of view files manageable while giving enough granularity for trend detection.

**Week boundary**: ISO weeks starting Monday. A result on Sunday 2026-03-08 is grouped into the week starting 2026-03-02.

### Release Buckets (Frozen Releases)

All results whose `sdkMajor` is lower than the active release are grouped into release buckets keyed by `net{major}`. These represent GA releases and their service packs (e.g., 9.0.100, 9.0.101, 9.0.102).

**Rationale**: Frozen releases receive infrequent updates (service packs every ~1 month). Grouping all data for a major version into one bucket keeps it compact and always visible in the dashboard's left zone.

### Active Release Detection

```typescript
function detectActiveRelease(allSdkMajors: number[]): number {
    return Math.max(...allSdkMajors);
}
```

The highest SDK major version across all data is the active release. Everything below is frozen. This is fully automatic — when .NET 12 previews start appearing in data, they become the active release and .NET 11 freezes.

### Transition Handling

When the active release changes (e.g., 11 → 12):
- All existing weekly buckets for the old active release (Net11) are **discarded** from the weekly view
- Net11 results are now bucketed as a frozen release
- A full rebuild regenerates all view files to reflect the new bucketing

In practice, the transition happens naturally as new data arrives with a higher major version.

---

## Column Deduplication

Multiple pipeline runs may produce results for the same runtime commit (e.g., re-runs after transient failures).

### Within a Bucket

Columns are keyed by:
- **Weekly buckets**: `runtimeHash` (a commit produces one column regardless of how many times it was measured)
- **Release buckets**: `runtimeHash + sdkVersion` (in theory the same runtime hash could appear in two different SDK versions within a release, though this is rare)

### Last-Write-Wins

If two results map to the same column + row key:
- The result with the later `benchmarkDateTime`
- The header stores one column entry per unique commit — metadata from the latest result

### Implementation

```typescript
// During Phase 2
const columnMap = new Map<string, ColumnEntry>();  // columnKey → column metadata

for (const result of bucketResults) {
    const key = result.commit.runtimeHash;  // or + sdkVersion for releases
    if (!columnMap.has(key)) {
        columnMap.set(key, {
            sdk: result.commit.sdk,
            runtimeHash: result.commit.runtimeHash,
            sdkHash: result.commit.sdkHash,
            vmrHash: result.commit.vmrHash,
            date: result.commit.date,
            time: result.commit.time,
        });
    }
    // For metric values: later write overwrites earlier
}
```

---

## Metrics Discovery

The transformer does **not** use a hardcoded list of metrics per app. It discovers metrics dynamically from the data:

```typescript
// Per bucket: app → Set<metricKey>
const appMetrics = new Map<string, Set<string>>();

for (const result of bucketResults) {
    let metrics = appMetrics.get(result.app);
    if (!metrics) {
        metrics = new Set();
        appMetrics.set(result.app, metrics);
    }
    for (const [key, value] of Object.entries(result.metrics)) {
        if (value !== null && value !== undefined) {
            metrics.add(key);
        }
    }
}
```

This automatically handles:
- `pizza-walkthru` appearing only for `blazing-pizza`
- Internal metrics (`js-interop-ops`, etc.) appearing only for `microbenchmarks`
- `download-size-total` missing for non-Chrome engines
- `disk-size-dlls` missing for certain presets
- Future new metrics being picked up without code changes

The global index merges all per-bucket metric sets to produce the complete `metrics` map.

---

## Incremental Updates

The transformer supports incremental operation to avoid re-processing all historical data on every run.

### Determining What Changed

1. Read existing `views/index.json` → get `lastUpdated` timestamp
2. Scan month indexes: compare each file's `mtime` against `lastUpdated`
3. Only process commits from months whose index file was modified

### Determining Affected Buckets

```typescript
const affectedWeeks = new Set<string>();
const affectedReleases = new Set<number>();

for (const result of newOrUpdatedResults) {
    const sdkMajor = getSdkMajor(result.commit.sdkVersion);
    if (sdkMajor === activeReleaseMajor) {
        affectedWeeks.add(getWeekMonday(result.commit.date));
    } else if (sdkMajor !== null) {
        affectedReleases.add(sdkMajor);
    }
}
```

### Regeneration Scope

For each affected bucket:
- **Reload ALL results** for that bucket (not just new ones) from the month indexes
- Regenerate the complete header + all data files for that bucket

This ensures consistency — even if only one new result arrived, the header column list and all data arrays are rebuilt from the full dataset.

### Full Rebuild

Delete `views/` and run the transformer on all data:

```bash
rm -rf gh-pages/data/views/
bench --stages transform-views --data-dir gh-pages/data/
```

### When Incremental Is Not Possible

The transformer falls back to full rebuild if:
- `views/index.json` does not exist
- `views/index.json` has no `lastUpdated` field
- The active release major changed (e.g., new .NET version detected)

---

## Dashboard Integration

The UI (defined in `gh-pages/index.html` and `gh-pages/app/`) consumes view files following the loading flow described in `docs/ui.md`:

### On Page Load

1. **Fetch `views/index.json`** — one request, small file (~1 KB)
2. Read URL hash state (selected app, active filters, date range)
3. Initialize sidebar filter checkboxes from `index.dimensions`
4. Set active app tab (default: `empty-browser`)
5. **Fetch release headers** (`views/releases/{net}/header.json`) for all frozen releases
6. **Fetch release data** (`views/releases/{net}/{app}_{metric}.json`) for the selected app
7. Determine visible week range from timeline selector
8. **Fetch week headers** (`views/{week}/header.json`) for visible weeks
9. **Fetch week data** (`views/{week}/{app}_{metric}.json`) as listed in `header.apps[selectedApp]`
10. Assemble Chart.js datasets and render

### On App Tab Change

- Fetch release + week data files for the new app (if not cached)
- Re-render charts; no header re-fetch needed

### On Filter Change

- Pure client-side: toggle series visibility based on row key matching
- No network requests — data already loaded

### On Timeline Range Change

- Determine newly-visible weeks
- Fetch headers + data for new weeks only
- Re-render charts with expanded datasets

### Caching Strategy

| File Type | Cache Duration | Invalidation |
|-----------|---------------|-------------|
| `views/index.json` | Page lifetime | Only on full page reload |
| Release headers + data | Page lifetime | Never changes (frozen releases) |
| Week headers + data | Page lifetime, keyed by week | Full page reload |

### Two-Zone Chart Layout

The UI renders each metric chart with two visual zones:

**Left zone (fixed)**: Frozen release data — one block per release, X-axis = SDK version labels. Data from `views/releases/{net}/` files.

**Right zone (scrollable)**: Active release timeline — X-axis = commit date, supports zoom/pan. Data from `views/{week}/` files, merged across visible weeks.

The transformer's separation of data into release vs. weekly files directly maps to these two chart zones.

### Row Key → Filter Matching

The UI parses row key strings to apply sidebar filters:

```javascript
function isRowVisible(rowKey, filterState) {
    const [runtime, preset, profile, engine] = rowKey.split('/');
    return filterState.runtimes.includes(runtime)
        && filterState.presets.includes(preset)
        && filterState.profiles.includes(profile)
        && filterState.engines.includes(engine);
}
```

### File Manifest Prevents 404s

The `apps` map in header files tells the UI exactly which `{app}_{metric}.json` files exist for each week/release. The UI only fetches listed files, avoiding 404s for missing combinations (e.g., `microbenchmarks_pizza-walkthru.json` does not exist).

---

## Error Handling

### Missing or Corrupt Result Files

If a result JSON file referenced in a month index cannot be loaded (missing, corrupt, or invalid JSON):
- **Log a warning** (with the file path)
- **Skip that result** — do not include it in any bucket
- Continue processing remaining results

The month index reference is not removed — the consolidation script owns the index. The transformer is read-only with respect to consolidated data.

### Missing SDK Version in Commit Metadata

Results with `sdkVersion === 'unknown'`, `sdkVersion === ''`, or unparseable major version:
- **Skipped entirely** — not assigned to any bucket
- Logged as a warning if `--verbose` is set

These represent legacy data before SDK version tracking was added.

### Empty Buckets

If a bucket has zero valid results after filtering:
- **Do not write** the header or any data files for that bucket
- **Do not create** the week/release directory
- If the directory previously existed (from a prior run), it remains on disk but is not listed in the global index

### Partial Data Within a Bucket

If some results in a bucket loaded successfully but others failed:
- Process what is available
- Data arrays will have `null` values in positions where the failed results would have contributed
- The header lists all columns for which at least one result loaded successfully

### Filesystem Errors

Write failures (permissions, disk full) on output files:
- The temp-then-rename pattern means a failed write leaves the previous version intact
- The error propagates up the call stack (no silent swallowing)
- Global `index.json` is written last, so a crash mid-run leaves the index pointing to the previous valid state

---

## Existing Code Reference

### Consolidation Script (`scripts/consolidate-results.mjs`)

Key patterns the transformer reuses:

- **`parseResultJson(content)`** — validates result structure, normalizes `runtimeGitHash` vs legacy `gitHash`, returns `null` for non-result files
- **`computeResultRelPath(meta)`** — `{year}/{date}/{filename}.json` path from metadata
- **`upsertResult(monthIndex, resultJson)`** — deduplication by `(runtime, preset, profile, engine, app)` within a commit; last-write wins
- **`rebuildTopLevelIndex()`** — dimension union across all month indexes

The transformer follows the same month index traversal pattern but instead of writing *into* the consolidated store, it reads *from* it and writes to `views/`.

### Metrics Registry (`scripts/lib/metrics.mjs`)

Defines display names and units for all metrics. The transformer does **not** import this (it discovers metrics from data), but the dashboard uses it for chart labels and formatting.

### Enums & Types (`bench/src/enums.ts`)

The transformer uses the TypeScript enums for type safety but does **not** restrict processing to only known enum values. This ensures forward compatibility — if a new app or metric appears in the data, the transformer processes it even if the enum hasn't been updated yet.

### Context & Stage Interface (`bench/src/context.ts`, `bench/src/stages/index.ts`)

The stage follows the standard `(ctx: BenchContext) => Promise<BenchContext>` contract. It reads `ctx.dataDir` for the data directory path and returns `ctx` unchanged (the transformer has no context mutations to propagate).

---

## TypeScript Interface Sketch

Types the implementation will define in `bench/src/stages/transform-views.ts` or a companion `bench/src/lib/views.ts`:

```typescript
// ── Column metadata (shared between weekly and release headers) ──

interface ViewColumn {
    sdk: string;
    runtimeHash: string;
    sdkHash: string;
    vmrHash: string;
    date: string;
    time: string;
}

// ── Week header ──

interface WeekHeader {
    week: string;                                    // Monday date "YYYY-MM-DD"
    columns: ViewColumn[];                           // sorted by (date, time)
    apps: Record<string, string[]>;                  // app → metric keys with data files
}

// ── Release header ──

interface ReleaseHeader {
    release: string;                                 // "net9"
    sdkMajor: number;
    columns: ViewColumn[];                           // sorted by SDK version
    apps: Record<string, string[]>;
}

// ── Data file (JSON object maps row key → values array) ──

type DataFile = Record<string, (number | null)[]>;

// ── Global index ──

interface ViewIndex {
    lastUpdated: string;                             // ISO timestamp
    activeRelease: string;                           // "net11"
    releases: string[];                              // sorted ascending
    weeks: string[];                                 // sorted descending (newest first)
    apps: string[];
    metrics: Record<string, string[]>;               // app → metric keys
    dimensions: {
        runtimes: string[];
        presets: string[];
        profiles: string[];
        engines: string[];
    };
}

// ── Internal working structures ──

interface BucketResult {
    commit: ViewColumn;
    rowKey: string;
    app: string;
    metrics: Record<string, number | null>;
}

interface Bucket {
    type: 'week' | 'release';
    key: string;                                     // Monday date or "net{major}"
    sdkMajor?: number;                               // for release buckets
    results: BucketResult[];
}
```

---

## Processing Pseudocode (Complete)

```
function transformViews(ctx: BenchContext):
    dataDir = ctx.dataDir ?? join(ctx.repoRoot, 'gh-pages', 'data')
    viewsDir = join(dataDir, 'views')

    // ── Phase 0: Determine incremental scope ──
    existingIndex = readJson(join(viewsDir, 'index.json'))  // null if missing
    lastUpdated = existingIndex?.lastUpdated ?? null
    isFullRebuild = !existingIndex || !lastUpdated

    // ── Phase 1: Load month indexes ──
    monthFiles = glob(dataDir, '{YYYY-MM}.json')
    monthIndexes = []
    for each monthFile in monthFiles:
        if !isFullRebuild and mtime(monthFile) <= lastUpdated:
            continue  // skip unmodified months
        monthIndexes.push(readJson(monthFile))

    if isFullRebuild:
        // Load ALL month indexes
        monthIndexes = [readJson(f) for f in monthFiles]

    // ── Phase 1b: Collect all sdkMajors to detect active release ──
    // NOTE: even in incremental mode, scan all month indexes for this
    allMajors = set()
    for each monthFile in glob(dataDir, '{YYYY-MM}.json'):
        mi = readJson(monthFile)
        for each commit in mi.commits:
            m = getSdkMajor(commit.sdkVersion)
            if m != null: allMajors.add(m)

    activeMajor = max(allMajors)

    if existingIndex and existingIndex.activeRelease != 'net' + activeMajor:
        isFullRebuild = true  // active release changed → full rebuild
        monthIndexes = [readJson(f) for f in monthFiles]

    // ── Phase 2: Load results and assign to buckets ──
    weekBuckets = Map<string, Bucket>      // weekMonday → bucket
    releaseBuckets = Map<number, Bucket>   // sdkMajor → bucket

    for each mi in monthIndexes:
        for each commit in mi.commits:
            sdkMajor = getSdkMajor(commit.sdkVersion)
            if sdkMajor == null: continue

            for each resultRef in commit.results:
                resultJson = readJson(join(dataDir, resultRef.file))
                if resultJson == null: log warning; continue

                bucketResult = {
                    commit: { sdk: commit.sdkVersion, runtimeHash: commit.runtimeGitHash,
                              sdkHash: commit.sdkGitHash, vmrHash: commit.vmrGitHash,
                              date: commit.date, time: commit.time },
                    rowKey: buildRowKey(resultJson.meta),
                    app: resultJson.meta.app,
                    metrics: resultJson.metrics
                }

                if sdkMajor < activeMajor:
                    getOrCreate(releaseBuckets, sdkMajor).results.push(bucketResult)
                else:
                    weekMonday = getWeekMonday(commit.date)
                    getOrCreate(weekBuckets, weekMonday).results.push(bucketResult)

    // ── Phase 3: Generate output files per bucket ──
    allWeeks = []
    allReleases = []
    globalApps = set()
    globalMetrics = Map<string, Set<string>>  // app → metric keys
    globalDimensions = { runtimes: set(), presets: set(), profiles: set(), engines: set() }

    // -- Weekly buckets --
    for each (weekMonday, bucket) in weekBuckets:
        { header, dataFiles } = buildBucketOutput(bucket, 'week')
        ensureDir(join(viewsDir, weekMonday))
        for each (filename, content) in dataFiles:
            safeWrite(join(viewsDir, weekMonday, filename), minify(content))
        safeWrite(join(viewsDir, weekMonday, 'header.json'), minify(header))
        allWeeks.push(weekMonday)
        mergeIntoGlobal(header.apps, globalApps, globalMetrics, globalDimensions, bucket)

    // -- Release buckets --
    for each (sdkMajor, bucket) in releaseBuckets:
        releaseName = 'net' + sdkMajor
        { header, dataFiles } = buildBucketOutput(bucket, 'release')
        ensureDir(join(viewsDir, 'releases', releaseName))
        for each (filename, content) in dataFiles:
            safeWrite(join(viewsDir, 'releases', releaseName, filename), minify(content))
        safeWrite(join(viewsDir, 'releases', releaseName, 'header.json'), minify(header))
        allReleases.push(releaseName)
        mergeIntoGlobal(header.apps, globalApps, globalMetrics, globalDimensions, bucket)

    // -- Incremental: preserve existing weeks/releases not rebuilt --
    if !isFullRebuild and existingIndex:
        for week in existingIndex.weeks:
            if week not in allWeeks: allWeeks.push(week)
        for rel in existingIndex.releases:
            if rel not in allReleases: allReleases.push(rel)
        // Merge existing dimensions/metrics if needed
        ...

    // ── Phase 4: Write global index ──
    viewIndex = {
        lastUpdated: new Date().toISOString(),
        activeRelease: 'net' + activeMajor,
        releases: sort(allReleases, ascending),
        weeks: sort(allWeeks, descending),
        apps: sort([...globalApps]),
        metrics: mapToSortedArrays(globalMetrics),
        dimensions: sortEachSet(globalDimensions)
    }
    safeWrite(join(viewsDir, 'index.json'), minify(viewIndex))

    return ctx
```

### `buildBucketOutput` Subroutine

```
function buildBucketOutput(bucket, type):
    // 1. Deduplicate and sort columns
    columnMap = Map<string, ViewColumn>()
    for each result in bucket.results:
        key = result.commit.runtimeHash
        if type == 'release': key += '|' + result.commit.sdk
        columnMap.set(key, result.commit)  // last-write for metadata

    columns = [...columnMap.values()]
    if type == 'week':
        sort columns by (date, time)
    else:
        sort columns by compareSdkVersion(sdk)

    columnIndex = Map<string, number>()
    columns.forEach((col, i) => columnIndex.set(columnKey(col), i))

    // 2. Build data files: one per (app, metric)
    // Grid: { app → { metric → { rowKey → values[] } } }
    grid = nested Map
    for each result in bucket.results:
        colIdx = columnIndex.get(columnKey(result.commit))
        for each (metricKey, value) in result.metrics:
            if value == null or value == undefined: continue
            row = grid[result.app][metricKey][result.rowKey] ??= new Array(columns.length).fill(null)
            row[colIdx] = value

    // 3. Build output
    dataFiles = []
    appsManifest = {}
    for each (app, metricMap) in grid:
        metricKeys = []
        for each (metricKey, rowMap) in metricMap:
            dataFile = {}
            for each (rowKey, values) in rowMap:
                if values.some(v => v !== null):
                    dataFile[rowKey] = values
            if Object.keys(dataFile).length > 0:
                filename = `${app}_${metricKey}.json`
                dataFiles.push({ filename, content: dataFile })
                metricKeys.push(metricKey)
        if metricKeys.length > 0:
            appsManifest[app] = metricKeys

    // 4. Build header
    header = {
        ...(type == 'week' ? { week: bucket.key } : { release: bucket.key, sdkMajor: bucket.sdkMajor }),
        columns,
        apps: appsManifest
    }

    return { header, dataFiles }
```

---

## Performance Considerations

### Data Volume Estimates

- **Active release**: ~7 commits/week × ~112 results/commit ≈ 784 results/week
- **Per week**: ~4 apps × ~12 metrics ≈ 48 data files + 1 header
- **Per frozen release**: ~5 service packs × 112 results ≈ 560 results, with same ~48 data files
- **Total (1 year)**: ~52 week dirs + ~4 release dirs ≈ 2,600 files

### Memory

Phase 1 loads month indexes (small — metadata only, ~50 KB each). Individual result files (~1 KB each) are loaded per-bucket in Phase 2. Peak memory is bounded by the largest bucket, typically one week (~784 results × ~1 KB ≈ 800 KB).

### I/O

The main cost is reading individual result JSON files. For a full rebuild with 1 year of data (~40,000 results), this is ~40,000 small reads. For incremental runs, typically 100–800 reads (one week's worth).

### Minification

All output JSON is written with `JSON.stringify(obj)` (no indentation). This reduces file sizes significantly for the sparse data matrices typical of weekly data.

---

## Testing Strategy

Unit tests (`bench/tests/transform-views.test.ts`):

1. **`getSdkMajor`** — standard versions, preview, unknown, empty, invalid
2. **`getWeekMonday`** — various days of week, year boundary, leap year
3. **`buildRowKey`** — with/without profile, all runtimes
4. **`compareSdkVersion`** — preview < RC < GA < service pack ordering
5. **`buildBucketOutput`** — column sorting, deduplication, null filling, empty row omission
6. **End-to-end** — create mock month indexes + result files in a temp directory, run the transformer, verify output file structure and content

---

## File Listing

| File | Status | Role |
|------|--------|------|
| `bench/src/stages/transform-views.ts` | Stub exists | Stage entry point — calls the phases |
| `bench/src/lib/views.ts` | To be created | Helper functions: bucketing, column sorting, file generation |
| `bench/tests/transform-views.test.ts` | To be created | Unit tests for helpers + integration test |
| `docs/stages/transform-views.md` | This file | Design document |
