# Model: Data Dimensions, Metrics, and Storage

## Dimensions

Each benchmark run is identified by a combination of these dimensions:

| Dimension | Key | Possible Values | Description |
|-----------|-----|-----------------|-------------|
| **Date** | `date` | ISO date `YYYY-MM-DD` | Calendar date of the run |
| **SDK Version** | `sdkVersion` | e.g. `10.0.100-preview.3.25130.1` | Resolved .NET SDK version string |
| **Git Hash** | `gitHash` | 40-char SHA (display as 7-char) | Source commit of the SDK build |
| **Runtime Flavor** | `runtime` | `coreclr`, `mono` | Which .NET runtime VM |
| **Build Configuration** | `config` | `release`, `aot`, `native-relink` | MSBuild publish configuration |
| **Execution Engine** | `engine` | `v8`, `node`, `chrome`, `firefox` | JS/WASM execution environment |
| **Sample App** | `app` | `empty-browser`, `empty-blazor`, `blazing-pizza`, `microbenchmarks` | Which application was measured |

### Dimension constraints (valid combinations)

```
config=aot          → runtime=mono only      (AOT is Mono-specific)
config=native-relink → runtime=coreclr,mono  (both support native relink)
config=release      → runtime=coreclr,mono   (standard release build)

app=empty-browser,empty-blazor,blazing-pizza  → metrics: external only
app=microbenchmarks                           → metrics: internal only

engine=chrome       → all apps (external=CDP, internal=Playwright evaluate)
engine=firefox      → microbenchmarks only (no CDP for external metrics)
engine=v8,node      → microbenchmarks only (CLI engines, no browser)
```

### Matrix exclusion summary

| App | Engine | Config | Runtime |
|-----|--------|--------|---------|
| empty-browser | chrome | release, native-relink | coreclr, mono |
| empty-browser | chrome | aot | mono |
| empty-blazor | chrome | release, native-relink | coreclr, mono |
| empty-blazor | chrome | aot | mono |
| blazing-pizza | chrome | release, native-relink | coreclr, mono |
| blazing-pizza | chrome | aot | mono |
| microbenchmarks | v8, node, chrome, firefox | release, native-relink | coreclr, mono |
| microbenchmarks | v8, node, chrome, firefox | aot | mono |

**Total legs per daily run**: ~26 combinations (3 apps × 1 engine × 5 configs + 1 app × 4 engines × 5 configs)

---

## Metrics

### External Metrics
Measured via Playwright + Chrome DevTools Protocol on published sample apps (Chrome only).

| Metric Key | Display Name | Unit | How Measured |
|------------|-------------|------|-------------|
| `download-size` | Download Size | `bytes` | CDP Network events: sum of `encodedDataLength` for all resources |
| `time-to-first-render` | Time to First Render | `ms` | `PerformanceObserver` for `first-contentful-paint`, or `Performance.timing.domContentLoadedEventEnd - navigationStart` |
| `time-to-first-ui-change` | Time to First UI Change | `ms` | `MutationObserver` on document body, timestamp of first DOM mutation after initial render |
| `memory-peak` | Memory Peak | `bytes` | CDP `Performance.getMetrics` → `JSHeapUsedSize` peak, or `performance.measureUserAgentSpecificMemory()` |

### Internal Metrics
Measured via JS harness calling `[JSExport]` C# methods in tight loops.

| Metric Key | Display Name | Unit | How Measured |
|------------|-------------|------|-------------|
| `js-interop-ops` | JS Interop | `ops/min` | Tight loop: JS calls C# `[JSExport]` method, method returns value. Count iterations in fixed time window. |
| `json-parse-ops` | JSON Parsing | `ops/min` | Tight loop: JS passes JSON string to C# `[JSExport]` method that deserializes with `System.Text.Json`. Count iterations. |
| `exception-ops` | Exception Handling | `ops/min` | Tight loop: JS calls C# method that throws + catches exception. Count iterations. |

### Metric value representation

All metric values are stored as numbers (not strings). Units are stored alongside for display purposes.

```json
{
  "value": 2450000,
  "unit": "bytes"
}
```

---

## File Naming Convention

### Per-run result file
```
{date}_{runtime}_{config}_{engine}_{app}.json
```

Examples:
```
2026-03-02_coreclr_release_chrome_empty-browser.json
2026-03-02_mono_aot_v8_microbenchmarks.json
2026-03-02_coreclr_native-relink_chrome_blazing-pizza.json
2026-03-15_mono_release_firefox_microbenchmarks.json
```

All dimension values are lowercase, hyphens for multi-word.

### Artifact naming (CI upload)
Same filename, uploaded as individual GitHub Actions artifacts with the name:
```
result_{date}_{runtime}_{config}_{engine}_{app}
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
│   ├── manifest.json                   # Global index of all data points
│   └── {year}/
│       └── W{week}/                    # ISO week number (01-53)
│           ├── {date}_{runtime}_{config}_{engine}_{app}.json
│           └── ...
```

### Weekly directory examples
```
data/2026/W09/      # ISO week 9 of 2026 (Mar 2-8)
data/2026/W10/      # ISO week 10 of 2026 (Mar 9-15)
data/2026/W52/      # Last week of 2026
data/2027/W01/      # First week of 2027
```

### Why weekly sharding?
- Keeps directory sizes manageable (~26 files per day × 7 days ≈ 182 files per week)
- Enables lazy loading: UI only fetches weeks in the visible time range
- Easy to prune old data by deleting entire week directories
- ISO week numbers are deterministic from date

---

## JSON Schemas

### manifest.json

The global index. Fetched by the UI on page load. Contains metadata for every run, enabling the UI to determine which weekly files to fetch.

```json
{
  "lastUpdated": "2026-03-02T12:34:56Z",
  "dimensions": {
    "runtimes": ["coreclr", "mono"],
    "configs": ["release", "aot", "native-relink"],
    "engines": ["v8", "node", "chrome", "firefox"],
    "apps": ["empty-browser", "empty-blazor", "blazing-pizza", "microbenchmarks"]
  },
  "runs": [
    {
      "date": "2026-03-02",
      "week": "2026/W09",
      "sdkVersion": "10.0.100-preview.3.25130.1",
      "gitHash": "abc1234def5678abc1234def5678abc1234def56",
      "runtime": "coreclr",
      "config": "release",
      "engine": "chrome",
      "app": "empty-browser",
      "file": "2026/W09/2026-03-02_coreclr_release_chrome_empty-browser.json",
      "metrics": ["download-size", "time-to-first-render", "time-to-first-ui-change", "memory-peak"]
    },
    {
      "date": "2026-03-02",
      "week": "2026/W09",
      "sdkVersion": "10.0.100-preview.3.25130.1",
      "gitHash": "abc1234def5678abc1234def5678abc1234def56",
      "runtime": "mono",
      "config": "aot",
      "engine": "v8",
      "app": "microbenchmarks",
      "file": "2026/W09/2026-03-02_mono_aot_v8_microbenchmarks.json",
      "metrics": ["js-interop-ops", "json-parse-ops", "exception-ops"]
    }
  ]
}
```

**Fields**:
- `lastUpdated`: ISO timestamp of last consolidation
- `dimensions`: enumeration of all known dimension values (used by UI to build filter checkboxes)
- `runs[]`: one entry per result file
  - `date`: ISO date string
  - `week`: `{year}/W{week}` path segment for the weekly directory
  - `sdkVersion`: full SDK version string
  - `gitHash`: full 40-char SHA
  - `runtime`, `config`, `engine`, `app`: dimension values
  - `file`: relative path from `data/` to the result JSON file
  - `metrics`: array of metric keys present in this result (allows UI to know what's available without fetching the file)

### Per-run result JSON

```json
{
  "meta": {
    "date": "2026-03-02",
    "sdkVersion": "10.0.100-preview.3.25130.1",
    "gitHash": "abc1234def5678abc1234def5678abc1234def56",
    "runtime": "coreclr",
    "config": "release",
    "engine": "chrome",
    "app": "empty-browser",
    "ciRunId": "12345678",
    "ciRunUrl": "https://github.com/<org>/simple-bench/actions/runs/12345678"
  },
  "metrics": {
    "download-size": {
      "value": 2450000,
      "unit": "bytes"
    },
    "time-to-first-render": {
      "value": 320.5,
      "unit": "ms"
    },
    "time-to-first-ui-change": {
      "value": 580.2,
      "unit": "ms"
    },
    "memory-peak": {
      "value": 45000000,
      "unit": "bytes"
    }
  }
}
```

**Fields**:
- `meta`: all dimension values + CI traceability
  - `ciRunId`: GitHub Actions run ID for traceability
  - `ciRunUrl`: direct link to the CI run
- `metrics`: key-value map where key is the metric name
  - `value`: numeric measurement (integer or float)
  - `unit`: display unit string

### Internal microbenchmark result example

```json
{
  "meta": {
    "date": "2026-03-02",
    "sdkVersion": "10.0.100-preview.3.25130.1",
    "gitHash": "abc1234def5678abc1234def5678abc1234def56",
    "runtime": "coreclr",
    "config": "release",
    "engine": "v8",
    "app": "microbenchmarks",
    "ciRunId": "12345678",
    "ciRunUrl": "https://github.com/<org>/simple-bench/actions/runs/12345678"
  },
  "metrics": {
    "js-interop-ops": {
      "value": 1250000,
      "unit": "ops/min"
    },
    "json-parse-ops": {
      "value": 890000,
      "unit": "ops/min"
    },
    "exception-ops": {
      "value": 45000,
      "unit": "ops/min"
    }
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
        ├─▶ Places each JSON into data/{year}/W{week}/
        │
        ├─▶ Appends entries to manifest.json
        │
        └─▶ Commits + pushes to gh-pages branch
        
        │
        ▼
  GitHub Pages serves updated data/
        │
        ▼
  Dashboard fetches manifest.json → weekly JSONs → renders charts
```

---

## Manifest Update Logic (consolidate-results.mjs)

1. Read existing `manifest.json` from gh-pages checkout
2. For each new result JSON file:
   a. Parse the `meta` section
   b. Compute the `week` value from `date`: `{year}/W{isoWeek}`
   c. Compute the `file` path: `{year}/W{week}/{filename}`
   d. Check for duplicates: if a run with same date + runtime + config + engine + app already exists, **replace** it (re-run overwrites previous)
   e. Add entry to `runs[]` array
3. Update `lastUpdated` timestamp
4. Re-derive `dimensions` from all runs (in case new values appear)
5. Sort `runs[]` by date descending
6. Write updated `manifest.json`

---

## Size Estimates

| Item | Estimate |
|------|----------|
| Single result JSON | ~300-500 bytes |
| Daily run (26 legs) | ~10-13 KB |
| Weekly data | ~70-90 KB |
| Yearly manifest (365 × 26 entries) | ~500 KB |
| Yearly data files | ~3.5 MB |

The manifest will grow linearly. After 2+ years it may need pagination or summarization, but for the first year it's fine as a single file.
