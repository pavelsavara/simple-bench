# Model: Data Dimensions, Metrics, and Storage

## Dimensions

Each benchmark run is identified by a combination of these dimensions:

| Dimension | Key | Possible Values | Description |
|-----------|-----|-----------------|-------------|
| **Date** | `date` | ISO date `YYYY-MM-DD` | Calendar date of the run |
| **SDK Version** | `sdkVersion` | e.g. `10.0.100-preview.3.25130.1` | Resolved .NET SDK version string |
| **Git Hash** | `gitHash` | 40-char SHA (display as 7-char) | Source commit of the SDK build |
| **Runtime Flavor** | `runtime` | `coreclr`, `mono`, `llvm_naot` | Which .NET runtime VM |
| **Build Preset** | `preset` | `no-workload`, `aot`, `native-relink`, `invariant`, `no-reflection-emit`, `debug` | MSBuild publish preset |
| **Execution Engine** | `engine` | `v8`, `node`, `chrome`, `firefox` | JS/WASM execution environment |
| **Sample App** | `app` | `empty-browser`, `empty-blazor`, `blazing-pizza`, `microbenchmarks` | Which application was measured |

### Dimension constraints (valid combinations)

```
preset=aot               → runtime=mono only      (AOT is Mono-specific)
preset=*                 → runtime=llvm_naot      (NativeAOT via LLVM — legacy data only)
preset=native-relink     → runtime=coreclr,mono   (both support native relink)
preset=no-workload       → runtime=coreclr,mono   (standard release build)
preset=invariant         → runtime=coreclr,mono   (InvariantGlobalization=true)
preset=no-reflection-emit→ runtime=coreclr,mono   (no System.Reflection.Emit)
preset=debug             → runtime=coreclr,mono   (debug build of the app)

app=empty-browser,empty-blazor,blazing-pizza  → metrics: external only
app=microbenchmarks                           → metrics: internal only

engine=chrome       → all apps (external=CDP, internal=Playwright evaluate)
engine=firefox      → microbenchmarks only (no CDP for external metrics)
engine=v8,node      → microbenchmarks only (CLI engines, no browser)
```

### Matrix exclusion summary

| App | Engine | Preset | Runtime |
|-----|--------|--------|---------|
| empty-browser | chrome | no-workload, native-relink, invariant, no-reflection-emit, debug | coreclr, mono |
| empty-browser | chrome | aot | mono |
| empty-blazor | chrome | no-workload, native-relink, invariant, no-reflection-emit, debug | coreclr, mono |
| empty-blazor | chrome | aot | mono |
| blazing-pizza | chrome | no-workload, native-relink, invariant, no-reflection-emit, debug | coreclr, mono |
| blazing-pizza | chrome | aot | mono |
| microbenchmarks | v8, node, chrome, firefox | no-workload, native-relink, invariant, no-reflection-emit, debug | coreclr, mono |
| microbenchmarks | v8, node, chrome, firefox | aot | mono |

**Total legs per daily run**: ~44 combinations (3 apps × 1 engine × 11 configs + 1 app × 4 engines × 11 configs)

---

## Metrics

Metric definitions are part of the model — each metric has a fixed key, display name, and unit. The unit is a property of the metric dimension itself, **not** of individual data points. Result JSONs store only the numeric value.

### Metric Definitions

| Metric Key | Display Name | Unit | Category | How Measured |
|------------|-------------|------|----------|-------------|
| `compile-time` | Compile Time | `ms` | External | Wall-clock time of `dotnet publish` (measured in build-app.sh, included in result JSON) |
| `download-size-total` | Download Size (Total) | `bytes` | External | Total published app bundle size |
| `download-size-wasm` | Download Size (WASM) | `bytes` | External | Size of dotnet.native.wasm (or dotnet.wasm for older builds) |
| `download-size-dlls` | Download Size (DLLs) | `bytes` | External | Total size of managed DLL assemblies |
| `time-to-reach-managed` | Time to Reach Managed | `ms` | External | `globalThis.dotnet_managed_ready` (C# via JSImport) — warm (minimum of 3 reloads) |
| `time-to-reach-managed-cold` | Time to Reach Managed (Cold) | `ms` | External | Same marker, first navigation (no cache) |
| `memory-peak` | Memory Peak | `bytes` | External | CDP `JSHeapUsedSize` sampled every 100ms, peak value across cold+warm loads |
| `js-interop-ops` | JS Interop | `ops/sec` | Internal | Tight loop: JS calls C# `[JSExport]` method, method returns value. Count iterations in fixed time window. |
| `json-parse-ops` | JSON Parsing | `ops/sec` | Internal | Tight loop: JS passes JSON string to C# `[JSExport]` method that deserializes with `System.Text.Json`. Count iterations. |
| `exception-ops` | Exception Handling | `ops/sec` | Internal | Tight loop: JS calls C# method that throws + catches exception. Count iterations. |

### Metric registry (in code)

The metric definitions are maintained as a shared constant, used by both measurement scripts and the dashboard:

```javascript
// Canonical metric registry — unit is defined here, not in data files
const METRICS = {
    'compile-time':           { displayName: 'Compile Time',           unit: 'ms',      category: 'external' },
    'download-size-total':    { displayName: 'Download Size (Total)',   unit: 'bytes',   category: 'external' },
    'download-size-wasm':     { displayName: 'Download Size (WASM)',    unit: 'bytes',   category: 'external' },
    'download-size-dlls':     { displayName: 'Download Size (DLLs)',    unit: 'bytes',   category: 'external' },
    'time-to-reach-managed':  { displayName: 'Time to Reach Managed',  unit: 'ms',      category: 'external' },
    'time-to-reach-managed-cold': { displayName: 'Time to Reach Managed (Cold)', unit: 'ms', category: 'external' },
    'memory-peak':            { displayName: 'Memory Peak',            unit: 'bytes',   category: 'external' },
    'js-interop-ops':         { displayName: 'JS Interop',             unit: 'ops/sec', category: 'internal' },
    'json-parse-ops':         { displayName: 'JSON Parsing',           unit: 'ops/sec', category: 'internal' },
    'exception-ops':          { displayName: 'Exception Handling',     unit: 'ops/sec', category: 'internal' }
};
```

### Metric value representation

Result data stores only the numeric value — the unit is looked up from the metric registry:

```json
{
  "compile-time": 45200,
  "download-size-total": 12100920,
  "download-size-wasm": 8187744,
  "download-size-dlls": 1758720,
  "time-to-reach-managed": 289.15,
  "time-to-reach-managed-cold": 7446
}
```

---

## File Naming Convention

### Per-run result file

The filename encodes the **commit time** (UTC), **short git hash** (7 chars), and all dimension values:

```
{HH-MM-SS-UTC}_{githash7}_{runtime}_{preset}_{engine}_{app}.json
```

The file lives inside a date directory derived from the **commit date** (not the CI run date):

```
data/{year}/{YYYY-MM-DD}/{HH-MM-SS-UTC}_{githash7}_{runtime}_{preset}_{engine}_{app}.json
```

Examples:
```
data/2026/2026-03-02/12-34-56-UTC_abc1234_coreclr_no-workload_chrome_empty-browser.json
data/2026/2026-03-02/12-34-56-UTC_abc1234_mono_aot_v8_microbenchmarks.json
data/2026/2026-03-15/08-12-00-UTC_def5678_coreclr_native-relink_chrome_blazing-pizza.json
data/2026/2026-03-15/08-12-00-UTC_def5678_mono_no-workload_firefox_microbenchmarks.json
```

All dimension values are lowercase, hyphens for multi-word. The commit time uses dashes instead of colons for filesystem compatibility.

### Why commit-time + hash in filename?
- **Commit hash** is the primary identity of a result (borrowed from radekdoulik/bench-results). Allows re-measuring the same commit.
- **Commit time** provides natural chronological sort when listing a directory.
- **Date directory** groups results by commit date, not CI run date — if a backfill benchmarks an old commit, the result goes into the original commit's date directory.

### Artifact naming (CI upload)
Uploaded as individual GitHub Actions artifacts with the name:
```
result_{githash7}_{runtime}_{preset}_{engine}_{app}
```

---

## Directory Structure (gh-pages branch)

```
gh-pages branch root/
├── index.html                          # Dashboard entry point
├── app/                                # Dashboard JS/CSS assets
│   ├── app.js
│   ├── data-loader.js
│   ├── chart-manager.js
│   ├── filters.js
│   └── style.css
├── data/
│   ├── index.json                      # Lightweight top-level index (available months)
│   ├── 2026-03.json                    # Month index: all commits + result paths for March 2026
│   ├── 2026-04.json                    # Month index for April 2026
│   └── {year}/
│       └── {YYYY-MM-DD}/              # One directory per commit date
│           ├── {HH-MM-SS-UTC}_{githash7}_{runtime}_{preset}_{engine}_{app}.json
│           └── ...
```

### Daily directory examples
```
data/2026/2026-03-02/    # All results for commits dated March 2, 2026
data/2026/2026-03-15/    # All results for commits dated March 15, 2026
data/2027/2027-01-05/    # A date in 2027
```

### Why daily sharding by commit date?
- Keeps directory sizes manageable (~44 files per commit date)
- Groups results by the commit they benchmark, not the CI run date
- Backfill runs for old commits land in the correct historical directory
- Easy to prune old data by deleting date directories
- Human-readable: `ls data/2026/2026-03-02/` shows all results for that day's commits

---

## JSON Schemas

### index.json (top-level)

Lightweight top-level index. Fetched by the UI on page load. Lists available months and global dimension values.

```json
{
  "lastUpdated": "2026-03-02T12:34:56Z",
  "dimensions": {
    "runtimes": ["coreclr", "mono", "llvm_naot"],
    "presets": ["no-workload", "aot", "native-relink", "invariant", "no-reflection-emit", "debug"],
    "engines": ["v8", "node", "chrome", "firefox"],
    "apps": ["empty-browser", "empty-blazor", "blazing-pizza", "microbenchmarks"]
  },
  "months": ["2026-01", "2026-02", "2026-03"]
}
```

**Fields**:
- `lastUpdated`: ISO timestamp of last consolidation
- `dimensions`: enumeration of all known dimension values (used by UI to build filter checkboxes)
- `months[]`: sorted list of `YYYY-MM` strings for which month index files exist

### Month index: `{YYYY-MM}.json`

One file per month, e.g. `data/2026-03.json`. Maps all commits benchmarked that month to their result file paths.

```json
{
  "month": "2026-03",
  "commits": [
    {
      "gitHash": "abc1234def5678abc1234def5678abc1234def56",
      "date": "2026-03-02",
      "time": "12-34-56-UTC",
      "sdkVersion": "10.0.100-preview.3.25130.1",
      "results": [
        {
          "runtime": "coreclr",
          "preset": "no-workload",
          "engine": "chrome",
          "app": "empty-browser",
          "file": "2026/2026-03-02/12-34-56-UTC_abc1234_coreclr_no-workload_chrome_empty-browser.json",
          "metrics": ["compile-time", "download-size-total", "download-size-wasm", "download-size-dlls", "time-to-reach-managed", "time-to-reach-managed-cold", "memory-peak"]
        },
        {
          "runtime": "mono",
          "preset": "aot",
          "engine": "v8",
          "app": "microbenchmarks",
          "file": "2026/2026-03-02/12-34-56-UTC_abc1234_mono_aot_v8_microbenchmarks.json",
          "metrics": ["js-interop-ops", "json-parse-ops", "exception-ops"]
        }
      ]
    },
    {
      "gitHash": "def5678abc1234def5678abc1234def5678abc123",
      "date": "2026-03-15",
      "time": "08-12-00-UTC",
      "sdkVersion": "10.0.100-preview.3.25140.5",
      "results": [
        {
          "runtime": "coreclr",
          "preset": "no-workload",
          "engine": "chrome",
          "app": "empty-browser",
          "file": "2026/2026-03-15/08-12-00-UTC_def5678_coreclr_no-workload_chrome_empty-browser.json",
          "metrics": ["compile-time", "download-size-total", "download-size-wasm", "download-size-dlls", "time-to-reach-managed", "time-to-reach-managed-cold", "memory-peak"]
        }
      ]
    }
  ]
}
```

**Fields**:
- `month`: `YYYY-MM` identifier
- `commits[]`: one entry per git commit benchmarked that month, sorted by date+time
  - `gitHash`: full 40-char SHA
  - `date`: commit date `YYYY-MM-DD`
  - `time`: commit time `HH-MM-SS-UTC`
  - `sdkVersion`: full SDK version string
  - `results[]`: all benchmark results for this commit
    - `runtime`, `preset`, `engine`, `app`: dimension values
    - `file`: relative path from `data/` to the result JSON file
    - `metrics`: array of metric keys present (allows UI to know what's available without fetching the file)

### Why month indexes instead of a single manifest?
- The global manifest grows linearly (~10 KB/month). After 2 years it becomes ~250 KB.
- Month indexes keep each file small and bounded (~10-15 KB per month).
- The dashboard fetches only the months visible in the current time range.
- Adding new results touches only the current month file — less merge conflict risk.
- Inspired by radekdoulik/bench-results sliced index approach ("last 14 days" slice for fast initial load).

### Per-run result JSON

Metric values are bare numbers. The unit for each metric is defined in the metric registry (see above), not repeated in every data file.

```json
{
  "meta": {
    "commitDate": "2026-03-02",
    "commitTime": "12-34-56-UTC",
    "sdkVersion": "10.0.100-preview.3.25130.1",
    "gitHash": "abc1234def5678abc1234def5678abc1234def56",
    "runtime": "coreclr",
    "preset": "no-workload",
    "engine": "chrome",
    "app": "empty-browser",
    "ciRunId": "12345678",
    "ciRunUrl": "https://github.com/<org>/simple-bench/actions/runs/12345678"
  },
  "metrics": {
    "compile-time": 45200,
    "download-size-total": 12100920,
    "download-size-wasm": 8187744,
    "download-size-dlls": 1758720,
    "time-to-reach-managed": 289.15,
    "time-to-reach-managed-cold": 7446,
    "memory-peak": 45000000
  }
}
```

**Fields**:
- `meta`: all dimension values + CI traceability
  - `commitDate`: commit date from git log (determines directory placement)
  - `commitTime`: commit time UTC from git log (part of filename)
  - `ciRunId`: GitHub Actions run ID for traceability
  - `ciRunUrl`: direct link to the CI run
- `metrics`: key-value map where key is the metric name, value is the numeric measurement (integer or float)

### Internal microbenchmark result example

```json
{
  "meta": {
    "commitDate": "2026-03-02",
    "commitTime": "12-34-56-UTC",
    "sdkVersion": "10.0.100-preview.3.25130.1",
    "gitHash": "abc1234def5678abc1234def5678abc1234def56",
    "runtime": "coreclr",
    "preset": "no-workload",
    "engine": "v8",
    "app": "microbenchmarks",
    "ciRunId": "12345678",
    "ciRunUrl": "https://github.com/<org>/simple-bench/actions/runs/12345678"
  },
  "metrics": {
    "js-interop-ops": 1250000,
    "json-parse-ops": 890000,
    "exception-ops": 45000
  }
}
```

---

## Data Flow

```
CI benchmark job (per matrix leg)
        │
        ▼
  Produces one result JSON file
        │
        ▼
  Uploads as GH Actions artifact
        │
        ▼
  Consolidation job (runs after all legs complete)
        │
        ├─▶ Downloads all artifacts
        │
        ├─▶ Places each JSON into data/{year}/{YYYY-MM-DD}/
        │
        ├─▶ Updates month index data/{YYYY-MM}.json
        │
        ├─▶ Updates data/index.json (months list)
        │
        └─▶ Commits + pushes to gh-pages branch
        
        │
        ▼
  GitHub Pages serves updated data/
        │
        ▼
  Dashboard fetches index.json → month indexes → result JSONs → renders charts
```

---

## Consolidation Logic (consolidate-results.mjs)

1. Read existing `data/index.json` from gh-pages checkout (or create empty if first run)
2. For each new result JSON file:
   a. Parse the `meta` section to get `commitDate`, `commitTime`, `gitHash`, dimensions
   b. Compute target directory: `data/{year}/{commitDate}/`
   c. Compute filename: `{commitTime}_{gitHash7}_{runtime}_{preset}_{engine}_{app}.json`
   d. Copy file to target path
   e. Compute month key: `YYYY-MM` from `commitDate`
   f. Load or create the month index file `data/{YYYY-MM}.json`
   g. Find or create the commit entry (by `gitHash`)
   h. Add result entry to the commit's `results[]` (replace if same dimensions already exist)
3. For each modified month index:
   a. Sort commits by `date` + `time`
   b. Write updated `data/{YYYY-MM}.json`
4. Update `data/index.json`:
   a. Re-derive `months[]` from all existing month files
   b. Re-derive `dimensions` from all month files (in case new values appear)
   c. Update `lastUpdated` timestamp
   d. Write `data/index.json`

---

## Size Estimates

| Item | Estimate |
|------|----------|
| Single result JSON | ~300-500 bytes |
| Daily run (~44 legs) | ~15-22 KB |
| `index.json` (top-level) | ~200-400 bytes (grows by ~15 bytes/month) |
| Single month index (`YYYY-MM.json`) | ~10-15 KB |
| Monthly data files (result JSONs) | ~450-650 KB |
| Yearly data files | ~5-8 MB |

Month indexes are bounded and small. The top-level `index.json` grows by one entry per month — negligible. After years of operation, old month indexes can be archived or removed without affecting recent data.
