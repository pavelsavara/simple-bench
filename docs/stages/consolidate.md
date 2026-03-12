# Stage: Consolidate

Merge per-run result JSONs from CI artifacts into the `gh-pages` data directory. This is the bridge between the measure stage (which produces individual result files) and the transform-views stage (which aggregates them for the dashboard).

## Pipeline Position

```
measure stage
    ↓ artifacts/results/{runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
consolidate stage                       ← THIS
    ↓ gh-pages/data/{year}/{YYYY-MM-DD}/*.json + month indexes + index.json
transform-views stage
    ↓ gh-pages/data/views/**/*.json
```

**Trigger in CI:** `consolidate.yml` workflow, fired by `workflow_run` after benchmark.yml completes. Only runs when benchmark conclusion is not `cancelled` and event is not `pull_request`.

**Trigger locally:** `bench --stages consolidate --artifacts-dir <path> --data-dir <path>`

## Inputs

### BenchContext Fields

| Field | Type | Description |
|-------|------|-------------|
| `artifactsInputDir` | `string` | Directory containing downloaded CI artifacts (or local `artifacts/results/`). Scanned recursively for `*.json` files. |
| `dataDir` | `string` | Target `gh-pages/data/` directory. Must exist; contains existing month indexes and result files. |

### Source Files

The artifacts directory contains result JSON files produced by the measure stage. These arrive in a flat or nested structure depending on the CI artifact download layout:

```
artifacts/
  results-empty-browser-devloop/
    2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json
    2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_firefox_empty-browser.json
  results-empty-browser-aot/
    2026-03-02T12-34-56Z_abc1234_mono_aot_desktop_chrome_empty-browser.json
  results-blazing-pizza-devloop/
    2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_blazing-pizza.json
    compile-time.json       ← skipped (no meta field)
    sdk-info.json           ← skipped (no meta field)
    build-manifest.json     ← skipped (no meta field)
```

Each valid result file has this structure:

```json
{
  "meta": {
    "runtimeCommitDateTime": "2026-03-02T12:34:56Z",
    "sdkVersion": "11.0.100-preview.3.26153.117",
    "runtimeGitHash": "abc1234def5678abc1234def5678abc1234def567",
    "sdkGitHash": "111222333444555666777888999aaabbbcccdddee",
    "vmrGitHash": "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
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

## Outputs

### Individual Result Files

Each valid result is written to:

```
data/{year}/{YYYY-MM-DD}/{canonicalFilename}.json
```

Example:
```
data/2026/2026-03-02/2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json
```

The file content is the full `{ meta, metrics }` object, pretty-printed with 2-space indent.

### Month Index Files

One per calendar month, at `data/{YYYY-MM}.json`:

```json
{
  "month": "2026-03",
  "commits": [
    {
      "runtimeGitHash": "abc1234def5678...",
      "sdkGitHash": "111222333...",
      "vmrGitHash": "aaaa1111...",
      "runtimeCommitDateTime": "2026-03-02T12:34:56Z",
      "sdkVersion": "11.0.100-preview.3.26153.117",
      "results": [
        {
          "runtime": "mono",
          "preset": "devloop",
          "profile": "desktop",
          "engine": "chrome",
          "app": "empty-browser",
          "file": "2026/2026-03-02/2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json",
          "metrics": ["compile-time", "disk-size-total", "disk-size-wasm", "time-to-reach-managed", "memory-peak"]
        }
      ]
    }
  ]
}
```

Commits within a month index are **sorted chronologically** by `runtimeCommitDateTime`.

### Top-Level Index

At `data/index.json`:

```json
{
  "lastUpdated": "2026-03-05T12:00:00.000Z",
  "dimensions": {
    "runtimes": ["coreclr", "mono"],
    "presets": ["aot", "devloop", "no-workload"],
    "profiles": ["desktop", "mobile"],
    "engines": ["chrome", "firefox", "node", "v8"],
    "apps": ["blazing-pizza", "empty-blazor", "empty-browser", "microbenchmarks"]
  },
  "months": ["2026-01", "2026-02", "2026-03"]
}
```

Dimensions are the **union** of all values found across all month indexes. All arrays are sorted alphabetically. Months are sorted chronologically.

## Data Directory Structure

After consolidation, the `gh-pages/data/` directory has this layout:

```
data/
├── index.json                           # Global index: dimensions, months list
├── 2026-01.json                         # Month index for January 2026
├── 2026-02.json                         # Month index for February 2026
├── 2026-03.json                         # Month index for March 2026
├── 2026/
│   ├── 2026-01-15/
│   │   ├── 2026-01-15T10-00-00Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json
│   │   ├── 2026-01-15T10-00-00Z_abc1234_mono_devloop_mobile_chrome_empty-browser.json
│   │   └── ...
│   ├── 2026-02-03/
│   │   └── ...
│   └── 2026-03-02/
│       ├── 2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json
│       ├── 2026-03-02T12-34-56Z_abc1234_mono_aot_desktop_chrome_empty-browser.json
│       └── ...
└── views/                               # Produced by transform-views stage (not by consolidate)
```

## Algorithm

### Step 1: Discover Result Files

Recursively scan `artifactsInputDir` for all `*.json` files:

```typescript
findJsonFiles(dir) → string[]
```

Uses `readdir({ recursive: true, withFileTypes: true })`. Returns absolute paths to every `.json` file found at any depth. The directory structure of the artifacts input doesn't matter — all JSONs are discovered regardless of nesting.

### Step 2: Validate and Parse Each File

For each `.json` file, read its content and pass through `parseResultJson()`:

```typescript
parseResultJson(content: string) → ResultJson | null
```

Validation rules:
1. Must be valid JSON (parse doesn't throw)
2. Must have top-level `meta` object
3. Must have top-level `metrics` object
4. `meta` must contain **all** of: `runtimeCommitDateTime`, `runtime`, `preset`, `engine`, `app`
5. `meta.runtimeGitHash` (or legacy `meta.gitHash`) must be present and match `/^[0-9a-f]+$/i` — rejects placeholders like `"unknown"`

Files that fail validation are **silently skipped** with an incremented `skipped` counter. This naturally filters out non-result files that appear in the artifacts directory:
- `compile-time.json` — has no `meta` field
- `sdk-info.json` — has no `meta`/`metrics` structure
- `build-manifest.json` — array, not `{meta, metrics}`

**Legacy field migration:** If a result has `meta.gitHash` but no `meta.runtimeGitHash`, the parser normalizes by copying `gitHash → runtimeGitHash`. This handles results produced by older versions of the measurement scripts.

### Step 3: Place Result Files

For each valid result, compute the canonical target path and write:

```
Canonical filename: {runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
Relative path:      {year}/{YYYY-MM-DD}/{canonicalFilename}
Absolute path:      {dataDir}/{relPath}
```

Where:
- `{runtimeCommitDateTime}` = path-safe form of `meta.runtimeCommitDateTime` (colons replaced with dashes, e.g. `2026-03-02T12:34:56Z` → `2026-03-02T12-34-56Z`)
- `{hash7}` = first 7 characters of `meta.runtimeGitHash`
- `{profile}` = `meta.profile` or `'desktop'` if absent
- `{year}` = `meta.runtimeCommitDateTime.slice(0, 4)` (e.g. `2026`)
- `{YYYY-MM-DD}` = `meta.runtimeCommitDateTime.slice(0, 10)` (e.g. `2026-03-02`)

The target directory is created with `mkdir({ recursive: true })`. The result file is written as pretty-printed JSON with a trailing newline.

**Overwrite behavior:** If a file already exists at the target path (re-run of same data), it is overwritten. The canonical filename is deterministic so duplicate inputs produce identical output paths.

### Step 4: Update Month Indexes

Each result is assigned to a month via:

```
monthKey = runtimeCommitDateTime.slice(0, 7)    // "2026-03-02T12:34:56Z" → "2026-03"
```

For each affected month:

1. **Load** existing `data/{YYYY-MM}.json`, or create an empty index `{ month, commits: [] }`
2. **Upsert** the result into the month index:
   - Find or create a **commit entry** keyed by `runtimeGitHash`
   - Within the commit, find or replace a **result entry** matched by the 5-tuple `(runtime, preset, profile, engine, app)`
   - If an existing result matches the same 5-tuple → **replace** (last write wins)
   - Otherwise → **append** to the commit's results array
3. After all results are processed, **sort** commits within each month by `runtimeCommitDateTime`
4. **Write** updated month index files

### Step 5: Rebuild Top-Level Index

1. Collect all known month keys: existing from `data/index.json` plus any newly created months
2. Load all month indexes (from disk or from the in-memory cache of modified months)
3. Scan every result entry across all month indexes to derive dimension unions:
   - `runtimes`: all unique `runtime` values
   - `presets`: all unique `preset` values
   - `profiles`: all unique `profile` values (defaulting to `'desktop'`)
   - `engines`: all unique `engine` values
   - `apps`: all unique `app` values
4. Write `data/index.json` with `lastUpdated` = current ISO timestamp, sorted dimension arrays, and sorted months list

## File Naming Convention

### Result Filename Format

```
{runtimeCommitDateTime}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
```

| Component | Source | Example |
|-----------|--------|---------|
| `runtimeCommitDateTime` | `meta.runtimeCommitDateTime` (path-safe) | `2026-03-02T12-34-56Z` |
| `hash7` | `meta.runtimeGitHash[0:7]` | `abc1234` |
| `runtime` | `meta.runtime` | `mono`, `coreclr` |
| `preset` | `meta.preset` | `devloop`, `aot`, `no-workload` |
| `profile` | `meta.profile \|\| 'desktop'` | `desktop`, `mobile` |
| `engine` | `meta.engine` | `chrome`, `firefox`, `v8`, `node` |
| `app` | `meta.app` | `empty-browser`, `blazing-pizza` |

Full example:
```
2026-03-02T12-34-56Z_abc1234_mono_devloop_desktop_chrome_empty-browser.json
```

### Directory Path Components

- **Year**: `runtimeCommitDateTime.slice(0, 4)` → `2026`
- **Date directory**: `runtimeCommitDateTime.slice(0, 10)` → `2026-03-02`
- **Month key**: `runtimeCommitDateTime.slice(0, 7)` → `2026-03` (used for month index filename)

## Deduplication

### Within a Single Consolidation Run

If two input files produce the same canonical filename (same commit + same dimension tuple), the **last one processed wins**. Since `findJsonFiles` returns files in directory-traversal order, the outcome is deterministic but depends on artifact layout.

### Across Multiple Consolidation Runs

When consolidation runs again (e.g. a re-benchmarked SDK), the same canonical filename is computed and the file in `data/{year}/{date}/` is **overwritten**.

In the month index, the upsert logic finds the existing commit entry by `runtimeGitHash` and replaces the matching result entry by the 5-tuple `(runtime, preset, profile, engine, app)`. This ensures:

- **Same measurement re-run** → replaces the old entry (updated metrics)
- **New engine/profile for same commit** → added alongside existing entries
- **Different commit hash** → creates a new commit entry entirely

### Deduplication Key Summary

| Level | Key | Behavior |
|-------|-----|----------|
| Result file on disk | Canonical filename (deterministic from meta) | Overwrite |
| Commit in month index | `runtimeGitHash` | Find-or-create |
| Result within commit | `(runtime, preset, profile, engine, app)` tuple | Find-or-replace |

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Invalid JSON file (parse error) | Silently skipped, `skipped` counter incremented |
| JSON without `meta` or `metrics` | Silently skipped (not a result file) |
| `runtimeGitHash` is `"unknown"` or non-hex | Silently skipped (regex validation fails) |
| Missing required meta fields | Silently skipped |
| Result file placement fails (disk full, permissions) | Exception propagates — consolidation aborts |
| Month index file is corrupted | `readJsonFile` returns `null` → treated as empty month, existing data lost for that month |
| Artifacts directory is empty | Returns `{ processed: 0, skipped: 0 }` — no-op |
| Data directory doesn't exist | Caller must ensure it exists; `mkdir` calls are for subdirectories only |

The consolidation script is designed for **partial-input resilience**: if some measure jobs failed and produced no artifacts, the valid results from successful jobs are still processed. The script itself handles any mix of valid and invalid inputs gracefully.

### CI Trigger Gap (Known Issue)

The `consolidate.yml` workflow currently triggers only when benchmark.yml concludes with `success`. If any measure job fails, the whole workflow concludes as `failure` and consolidation doesn't run — meaning even the **successful** partial results are lost and sit in GHA artifacts until they expire. The planned fix is to change the trigger condition to `conclusion != 'cancelled'`.

## Existing Code Reference

### TypeScript Implementation

The current implementation is [bench/src/stages/consolidate.ts](../../bench/src/stages/consolidate.ts). Key exported functions:

| Function | Purpose |
|----------|---------|
| `findJsonFiles(dir)` | Recursive `*.json` discovery |
| `parseResultJson(content)` | Validation + legacy field normalization |
| `computeResultFilename(meta)` | Canonical filename from meta fields |
| `computeResultRelPath(meta)` | Full relative path: `{year}/{date}/{filename}` |
| `computeMonthKey(runtimeCommitDateTime)` | `"2026-03-02"` → `"2026-03"` |
| `createEmptyMonthIndex(month)` | `{ month, commits: [] }` |
| `buildMonthResultEntry(meta, metrics)` | Dimension tuple + file path + metric key list |
| `upsertResult(monthIndex, resultJson)` | Find-or-create commit, find-or-replace result |
| `sortMonthCommits(monthIndex)` | Sort commits by `runtimeCommitDateTime` |
| `rebuildTopLevelIndex(monthKeys, monthIndexes)` | Derive dimensions union, assemble index.json |
| `consolidate(artifactsDir, dataDir)` | Main orchestrator — returns `{ processed, skipped }` |

### TypeScript Stub

The stage handler is at [bench/src/stages/consolidate.ts](../bench/src/stages/consolidate.ts). Currently a stub that logs `[consolidate] not yet implemented` and passes through `BenchContext`.

### BenchContext Integration

The consolidate stage reads two fields from `BenchContext`:

```typescript
ctx.artifactsInputDir   // replaces CLI arg <artifacts-dir>
ctx.dataDir             // replaces CLI arg <data-dir>
```

The stage does **not** require `sdkInfo`, `buildManifest`, or any resolved SDK paths — it operates purely on the result JSON files found in the artifacts directory.

### Unit Tests

Comprehensive tests exist at [tests/unit/consolidate-results.test.mjs](../tests/unit/consolidate-results.test.mjs) covering:

- `parseResultJson`: valid input, invalid JSON, missing fields, non-hex hash rejection, compile-time.json filtering
- `computeResultFilename`: hash truncation, profile inclusion, desktop default
- `computeResultRelPath`: year extraction, date directory
- `upsertResult`: new commit, new result on existing commit, replacement of same-dimension result, profile differentiation, separate commits for different hashes
- `sortMonthCommits`: chronological ordering
- `rebuildTopLevelIndex`: dimension derivation, month sorting
- `findJsonFiles`: nested directories, empty dirs, non-JSON filtering
- `consolidate` (integration): single result, multiple results for same commit, non-result file skipping, merging into existing month index

## Implementation Notes for TypeScript Port

1. **Direct port**: The algorithm is straightforward — all functions from `consolidate-results.mjs` map 1:1 to the TypeScript stage. The function signatures and logic can be preserved.

2. **Context wiring**: Replace CLI `process.argv` parsing with `ctx.artifactsInputDir` and `ctx.dataDir`. Validate both are present at stage entry; throw if missing.

3. **Return value**: The stage function should return `ctx` unchanged (consolidation doesn't modify pipeline state). Log `processed` and `skipped` counts.

4. **File I/O**: Use the same `node:fs/promises` APIs. No platform-specific concerns — paths are all within the data directory.

5. **Idempotency**: The stage is safe to re-run. Identical inputs produce identical outputs. Running consolidation twice with the same artifacts is a no-op (files overwritten with same content, indexes re-derived to same state).

6. **No streaming**: All result files are small (< 1 KB each). The entire artifacts directory is scanned in memory. For the current scale (~100–200 results per benchmark run), this is well within limits.
