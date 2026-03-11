# View Data Model

Pre-aggregated data files for the dashboard UI, produced by the transformer from consolidated benchmark results.

## Directory Structure

```
gh-pages/data/views/
  index.json                                    # global index
  2026-03-02/                                   # week dir (Monday date)
    header.json                                 # column metadata + file manifest
    empty-browser_compile-time.json             # data: rows × columns
    empty-browser_disk-size-total.json
    empty-browser_time-to-reach-managed.json
    blazing-pizza_pizza-walkthru.json
    microbenchmarks_js-interop-ops.json
    ...
  2026-02-23/
    header.json
    ...
  releases/
    net7/
      header.json
      empty-browser_time-to-reach-managed.json
      ...
    net8/
      header.json
      ...
```

### Naming Conventions

- **Week directory**: Monday date of the ISO week, `YYYY-MM-DD` format
- **Data file**: `{app}_{metric}.json` — app name and metric key joined by underscore
- **Release directory**: `net{major}` — e.g. `net7`, `net8`, `net9`, `net10`
- All JSON files are **minified** (no whitespace/indentation)

## Global Index

`views/index.json` — loaded once on page init. Tells the UI what data exists.

```json
{
  "lastUpdated": "2026-03-05T12:00:00Z",
  "activeRelease": "net11",
  "releases": ["net7", "net8", "net9", "net10"],
  "weeks": ["2026-03-02", "2026-02-23", "2026-02-16"],
  "apps": ["empty-browser", "empty-blazor", "blazing-pizza", "microbenchmarks"],
  "metrics": {
    "empty-browser": ["compile-time", "disk-size-total", "disk-size-wasm", "disk-size-dlls", "download-size-total", "time-to-reach-managed", "time-to-reach-managed-cold", "memory-peak"],
    "empty-blazor": ["compile-time", "disk-size-total", "disk-size-wasm", "disk-size-dlls", "download-size-total", "time-to-reach-managed", "time-to-reach-managed-cold", "memory-peak"],
    "blazing-pizza": ["compile-time", "disk-size-total", "disk-size-wasm", "disk-size-dlls", "download-size-total", "time-to-reach-managed", "time-to-reach-managed-cold", "memory-peak", "pizza-walkthru"],
    "microbenchmarks": ["compile-time", "memory-peak", "js-interop-ops", "json-parse-ops", "exception-ops"]
  },
  "dimensions": {
    "runtimes": ["mono"],
    "presets": ["devloop", "no-workload", "aot", "native-relink", "no-jiterp", "invariant", "no-reflection-emit"],
    "profiles": ["desktop", "mobile"],
    "engines": ["chrome", "firefox", "v8", "node"]
  }
}
```

| Field | Description |
|-------|-------------|
| `lastUpdated` | ISO timestamp of last transformer run |
| `activeRelease` | The .NET release getting daily builds (weekly files) |
| `releases` | Frozen .NET releases (sorted oldest→newest) |
| `weeks` | Available week directories (sorted newest→oldest) |
| `apps` | All application names (tab order) |
| `metrics` | Per-app list of metrics that have data (chart order) |
| `dimensions` | Union of all dimension values across all data |

## Week Header

`views/{week}/header.json` — column metadata and file manifest for one week.

```json
{
  "week": "2026-03-02",
  "columns": [
    {
      "sdk": "11.0.100-preview.3.26151.103",
      "runtimeHash": "abc1234def567890...",
      "sdkHash": "111222333444555...",
      "vmrHash": "aaa111bbb222...",
      "runtimeCommitDateTime": "2026-03-02T12:34:56Z"
    },
    {
      "sdk": "11.0.100-preview.3.26152.105",
      "runtimeHash": "...",
      "sdkHash": "...",
      "vmrHash": "...",
      "runtimeCommitDateTime": "2026-03-02T18:45:00Z"
    }
  ],
  "apps": {
    "empty-browser": ["compile-time", "disk-size-total", "time-to-reach-managed"],
    "blazing-pizza": ["compile-time", "pizza-walkthru"],
    "microbenchmarks": ["js-interop-ops", "json-parse-ops", "exception-ops"]
  }
}
```

| Field | Description |
|-------|-------------|
| `week` | Monday date identifying this week |
| `columns` | Ordered array of commit/build metadata. Position = column index in data arrays |
| `columns[].sdk` | SDK version string (e.g. `11.0.100-preview.3.26153.117`) |
| `columns[].runtimeHash` | Full runtime git hash |
| `columns[].sdkHash` | Full SDK git hash |
| `columns[].vmrHash` | VMR git hash |
| `columns[].runtimeCommitDateTime` | ISO UTC datetime of the runtime commit |
| `apps` | Map of app → list of metric file names that exist in this week directory |

The `apps` map prevents the UI from making 404 requests for missing data files.

Columns are sorted chronologically by `runtimeCommitDateTime`.

When multiple pipeline runs produce results for the same commit (same `runtimeHash`), the column is deduplicated — last-write wins for metric values.

## Data File

`views/{week}/{app}_{metric}.json` — measured values for one app × one metric × one week.

```json
{"mono/devloop/desktop/chrome":[56,51,48,null,52,55,49],"mono/devloop/mobile/chrome":[120,118,null,122,119,121,120],"mono/no-workload/desktop/chrome":[51,49,52,50,null,48,51]}
```

- **Keys**: row key strings in `{runtime}/{preset}/{profile}/{engine}` format
- **Values**: arrays of numbers (or `null` for missing). Length = number of columns in the week header
- Rows with **no data at all** for a given metric are **omitted** (not present as all-nulls)
- Values are **integers** (rounded: ms, bytes, ops/sec)

### Row Key Format

Four dimensions joined by `/`:

```
{runtime}/{preset}/{profile}/{engine}
```

Examples:
- `mono/devloop/desktop/chrome`
- `mono/no-workload/mobile/chrome`
- `coreclr/aot/desktop/firefox`

The UI parses row keys to populate filter checkboxes and to match visibility toggles.

## Release Header

`views/releases/{net}/header.json` — column metadata for a frozen .NET release.

```json
{
  "release": "net9",
  "sdkMajor": 9,
  "columns": [
    {
      "sdk": "9.0.100",
      "runtimeHash": "...",
      "sdkHash": "...",
      "vmrHash": "...",
      "runtimeCommitDateTime": "2024-11-12T10:00:00Z"
    },
    {
      "sdk": "9.0.101",
      "runtimeHash": "...",
      "sdkHash": "...",
      "vmrHash": "...",
      "runtimeCommitDateTime": "2024-12-10T10:00:00Z"
    }
  ],
  "apps": {
    "empty-browser": ["compile-time", "disk-size-total", "time-to-reach-managed"],
    "microbenchmarks": ["js-interop-ops"]
  }
}
```

| Field | Description |
|-------|-------------|
| `release` | Release identifier (`net7`, `net8`, ...) |
| `sdkMajor` | Major version number for SDK version parsing |
| `columns` | Ordered by SDK version (GA first, then service packs `.0.101`, `.0.102`, ...) |
| `apps` | Map of app → metrics that have data files in this release |

Columns are sorted by **SDK version** (not date). Service packs follow the GA release.

## Release Data File

`views/releases/{net}/{app}_{metric}.json` — same format as weekly data files.

```json
{"mono/no-workload/desktop/chrome":[51,49,52],"mono/aot/desktop/chrome":[38,37,36]}
```

Array length = number of columns in the release header.

## Dimension Taxonomy

| Dimension | Values | Role |
|-----------|--------|------|
| **App** | `empty-browser`, `empty-blazor`, `blazing-pizza`, `microbenchmarks` | Tab selector — determines which charts to show |
| **Metric** | `compile-time`, `disk-size-total`, etc. | One chart per metric |
| **Runtime** | `mono`, `coreclr` (future) | Filter checkbox, encoded in row key |
| **Preset** | `devloop`, `no-workload`, `aot`, `native-relink`, `no-jiterp`, `invariant`, `no-reflection-emit` | Filter checkbox, encoded in row key |
| **Profile** | `desktop`, `mobile` | Filter checkbox, encoded in row key |
| **Engine** | `chrome`, `firefox`, `v8`, `node` | Filter checkbox, encoded in row key |

### Which Metrics Apply Where

Not all metric × engine × app combinations produce data. Omitted rows are not stored.

| Metric | Engines that produce it | Notes |
|--------|------------------------|-------|
| `compile-time` | all | Same value across engines for same preset (build-time metric) |
| `disk-size-total` | all | Same value across engines (filesystem measurement) |
| `disk-size-wasm` | all | Same value across engines |
| `disk-size-dlls` | all | Only present when preset produces DLLs (e.g. `devloop`) |
| `download-size-total` | chrome only | Requires CDP `Network.loadingFinished` |
| `time-to-reach-managed` | all | Warm load (min of N reloads) |
| `time-to-reach-managed-cold` | all | First navigation, no cache |
| `memory-peak` | chrome only | Requires CDP `Performance.getMetrics` |
| `pizza-walkthru` | chrome, firefox | Playwright walkthrough of pizza ordering flow |
| `js-interop-ops` | chrome, firefox, v8, node | Microbenchmark: JS↔C# interop throughput |
| `json-parse-ops` | chrome, firefox, v8, node | Microbenchmark: JSON deserialization throughput |
| `exception-ops` | chrome, firefox, v8, node | Microbenchmark: exception throw/catch throughput |

### Engine Availability per App

| App | chrome | firefox | v8 | node |
|-----|:------:|:-------:|:--:|:----:|
| `empty-browser` | ✓ | ✓ | ✓ | ✓ |
| `empty-blazor` | ✓ | ✓ | — | — |
| `blazing-pizza` | ✓ | ✓ | — | — |
| `microbenchmarks` | ✓ | ✓ | ✓ | ✓ |

### Profile Availability

- `desktop`: all engines
- `mobile`: chrome only (requires CDP for CPU/network throttling)

## Release Assignment

Determined by parsing the **SDK major version** from `sdkVersion`:

| Release | SDK Major | Example SDK Version |
|---------|-----------|-------------------|
| `net7` | 7 | `7.0.100`, `7.0.101` |
| `net8` | 8 | `8.0.100`, `8.0.101` |
| `net9` | 9 | `9.0.100`, `9.0.101` |
| `net10` | 10 | `10.0.100-preview.1.25101.1` |
| `net11` | 11 | `11.0.100-preview.3.26153.117` |

The **active release** is always the highest SDK major version present in the data. All lower major versions are frozen releases.

When Net12 development begins, Net11 becomes a frozen release automatically.

## Compression

GitHub Pages serves responses with transparent gzip content negotiation. No client-side decompression needed. Minified JSON (no whitespace) reduces pre-compression size.
