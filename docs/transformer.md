# View Transformer

Reads consolidated benchmark data and produces pre-aggregated view files for the dashboard.

**Status: designed, not yet implemented.** The `transform-views.mjs` script does not exist yet. The dashboard will consume raw month indexes until this layer is built.

## Pipeline Position

```
benchmark pipeline (build + measure)
    ↓ artifacts/results/*.json
consolidate-results.mjs
    ↓ gh-pages/data/{year}/{date}/*.json + month indexes
transform-views.mjs                          ← THIS
    ↓ gh-pages/data/views/**/*.json
deploy to gh-pages branch
```

Runs after consolidation, before gh-pages deployment. Currently part of the same pipeline; may become a separate job later.

## Inputs

From `gh-pages/data/`:

1. **Month index files** (`{YYYY-MM}.json`) — commit metadata + result file references
2. **Individual result files** (`{year}/{date}/{file}.json`) — full `{ meta, metrics }` objects
3. **Existing view index** (`views/index.json`) — previous state (for incremental updates)

## Outputs

Into `gh-pages/data/views/`:

1. `index.json` — global index
2. `{week}/header.json` — per-week column metadata + file manifest
3. `{week}/{app}_{metric}.json` — per-week data files
4. `releases/{net}/header.json` — per-release column metadata
5. `releases/{net}/{app}_{metric}.json` — per-release data files

See [pipeline-model.md](pipeline-model.md) for file format details.

## Algorithm

### Phase 1: Load consolidated data

```
for each month index in data/:
    for each commit in month.commits:
        parse SDK major version from commit.sdkVersion
        compute week Monday from commit.date
        for each result in commit.results:
            load result JSON file (data/{result.file})
            extract (app, metric keys, row key, values)
```

### Phase 2: Bucket results

Each result is assigned to a **bucket** identified by:
- **Release bucket** (frozen): `(sdkMajor, app, metric)` → if sdkMajor < activeReleaseMajor
- **Week bucket** (active): `(week, app, metric)` → if sdkMajor == activeReleaseMajor

Within each bucket, results are organized into:
- **Column** — identified by commit (runtimeHash or commit date+time)
- **Row** — identified by row key (`{runtime}/{preset}/{profile}/{engine}`)

### Phase 3: Build output structures

For each bucket:

1. Sort columns:
   - Weekly buckets: by `runtimeCommitDateTime` (chronological)
   - Release buckets: by `sdkVersion` (version ordering)
2. Build column index: map commit → column position
3. For each row key that has at least one non-null value:
   - Create array of length = column count
   - Fill positions from matching results, `null` for gaps
4. Omit rows that are entirely null

### Phase 4: Write files

1. Write data files (minified JSON)
2. Build and write header files (column metadata + apps manifest)
3. Rebuild global `index.json`

## Release Detection

Parse SDK major version from the `sdkVersion` string in commit metadata:

```javascript
function getSdkMajor(sdkVersion) {
    if (!sdkVersion || sdkVersion === 'unknown') return null;
    const major = parseInt(sdkVersion.split('.')[0], 10);
    return Number.isFinite(major) ? major : null;
}
```

The **active release** is the highest SDK major version found across all data. All lower majors become frozen releases.

Results with `sdkVersion === 'unknown'` or unparseable major are **skipped** (old data that needs re-measurement).

## Week Computation

Map a commit date to its week's Monday:

```javascript
function getWeekMonday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday = 1
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
}
```

Example: `2026-03-05` (Thursday) → `2026-03-02` (Monday).

## Column Deduplication

Multiple pipeline runs may produce results for the same commit (same `runtimeHash`). Within a bucket:

- Columns are keyed by `runtimeHash` (or `runtimeHash + sdkVersion` for releases)
- If two results map to the same column and same row key, **last-write wins** (later `benchmarkDateTime` takes precedence)
- The header stores one column entry per unique commit

## Service Pack Ordering (Frozen Releases)

Within a frozen release, columns are sorted by **SDK version string** using semver-aware comparison:

```
9.0.100 < 9.0.101 < 9.0.102
```

Service packs naturally sort after the GA release. No date manipulation needed.

Preview and RC versions within a major sort before GA:
```
9.0.100-preview.1.xxx < 9.0.100-rc.1.xxx < 9.0.100 < 9.0.101
```

## Incremental Updates

The transformer supports incremental operation:

1. Read existing `views/index.json` to get current state
2. Determine which month indexes have been modified since `lastUpdated`
3. Process only commits from modified months
4. Regenerate only affected week/release files
5. Update global index

For a full rebuild, delete `views/` and run the transformer on all data.

### Determining affected weeks

```
affected_weeks = set()
for each new/updated result:
    week = getWeekMonday(result.meta.runtimeCommitDateTime)
    affected_weeks.add(week)

for each affected week:
    regenerate header + all data files for that week
```

The weekly regeneration reads ALL results for that week (not just new ones) to ensure consistency.

## Row Key Construction

From a result's metadata:

```javascript
function buildRowKey(meta) {
    const profile = meta.profile || 'desktop';
    return `${meta.runtime}/${meta.preset}/${profile}/${meta.engine}`;
}
```

## Metrics Discovery

The transformer does NOT use a hardcoded list of metrics per app. It discovers metrics from the actual result data:

```
for each result in a bucket:
    for each (metricKey, value) in result.metrics:
        if value !== null and value !== undefined:
            register metricKey for this app
```

This automatically handles:
- `pizza-walkthru` appearing only for `blazing-pizza`
- Internal metrics appearing only for `microbenchmarks`
- `disk-size-dlls` missing for certain presets
- Future new metrics being picked up without code changes

## File Write Strategy

All writes use **write-to-temp-then-rename** pattern:

```javascript
await writeFile(targetPath + '.tmp', content);
await rename(targetPath + '.tmp', targetPath);
```

This ensures readers never see partial files.

### Open Question: Concurrent Pipeline Access

Multiple benchmark pipelines may run in parallel and trigger consolidation + transformation concurrently. The current design writes view files directly. Potential solutions when this becomes an issue:

- File-level locking (OS-dependent)
- Separate transformation job with serialized execution
- Pipeline-level coordination (only one consolidation at a time)

Deferred until the pipeline rework.

## CLI Interface

```
bench --stages transform-views [options]

Options:
  --data-dir <path> Path to gh-pages/data/ directory
  --full            Full rebuild (ignore incremental state)
  --dry-run         Print what would be written without writing
  --verbose         Log progress details
```

## Example Run

Given consolidated data with:
- 3 commits in week 2026-03-02 for Net11
- 2 apps (empty-browser, microbenchmarks)
- 2 presets × 1 runtime × 2 profiles × 2 engines

The transformer produces:

```
views/
  index.json
  2026-03-02/
    header.json                                    (3 columns)
    empty-browser_compile-time.json                (up to 8 rows × 3 cols)
    empty-browser_disk-size-total.json
    empty-browser_disk-size-wasm.json
    empty-browser_disk-size-dlls.json
    empty-browser_download-size-total.json
    empty-browser_time-to-reach-managed.json
    empty-browser_time-to-reach-managed-cold.json
    empty-browser_memory-peak.json
    microbenchmarks_compile-time.json
    microbenchmarks_memory-peak.json
    microbenchmarks_js-interop-ops.json
    microbenchmarks_json-parse-ops.json
    microbenchmarks_exception-ops.json
```

Each data file is a few hundred bytes minified. The entire `views/` directory for a year of daily data is estimated at ~5–10 MB before gzip.
