# UI Plan — Blazor WASM Benchmark Dashboard

> **Status**: IN PROGRESS — decisions finalized, incremental implementation underway

## Goal

Replace the placeholder `gh-pages/index.html` dashboard with a Blazor WebAssembly application (`src/bench-viewer`) that visualizes benchmark results. Deployed to GitHub Pages at `/blazor_coreclr_demo/`.

---

## Open Questions

| # | Question | Options | Decision |
|---|----------|---------|----------|
| 1 | **Data source URL** | Data at `/blazor_coreclr_demo/data` (copied/symlinked into app subfolder) | **B** |
| 2 | **Charting library** | Chart.js via JS functions called from C# `[JSImport]` interop. JS fetches raw data segments and renders charts. | **A — JS interop** |
| 3 | **Benchmark instrumentation** | Keep — bench-viewer is also a benchmarked app (secondary role) | **A — Keep both** |
| 4 | **UI layout** | Replicate the `docs/ui.md` mockup (sidebar filters, app tabs, two-zone charts) | **A — Replicate mockup** |
| 5 | **CSS framework** | Bootstrap (already scaffolded) | **A — Bootstrap** |
| 6 | **Service worker** | Remove | **B — Remove** |
| 7 | **Build toolchain** | Use existing arrangements in `src/` folder. net8+ compatible. | **Existing setup** |
| 8 | **Phasing** | Incremental | **B — Incremental** |

---

## Architecture (Preliminary)

### Data Flow

```
gh-pages/data/views/index.json          ← view catalog (apps, metrics, dimensions, weeks, releases)
gh-pages/data/views/{week}/header.json   ← column metadata per week bucket
gh-pages/data/views/{week}/{app}_{metric}.json  ← pivot data: rowKey → values[]
gh-pages/data/views/releases/{netN}/...  ← same structure for GA releases
```

The Blazor app fetches these JSON files via `HttpClient` at runtime.

### View JSON Schema Summary

**`views/index.json`**:
```json
{
  "lastUpdated": "...",
  "activeRelease": "net10",
  "releases": ["net9"],
  "weeks": ["2026-02-16"],
  "apps": ["empty-browser"],
  "metrics": { "empty-browser": ["compile-time", "disk-size-total", ...] },
  "dimensions": {
    "runtimes": ["mono"],
    "presets": ["no-workload"],
    "profiles": ["desktop", "mobile"],
    "engines": ["chrome", "firefox", "node", "v8"]
  }
}
```

**`views/{bucket}/header.json`**:
```json
{
  "columns": [
    { "runtimeGitHash": "081d220...", "runtimeCommitDateTime": "2026-02-18T18:36:50Z", "sdkVersion": "10.0.200" }
  ],
  "apps": { "empty-browser": ["compile-time", "disk-size-total", ...] },
  "week": "2026-02-16"   // or "release": "net9"
}
```

**`views/{bucket}/{app}_{metric}.json`**:
```json
{
  "mono/no-workload/desktop/chrome": [1991],
  "mono/no-workload/desktop/firefox": [1947],
  "mono/no-workload/mobile/chrome": [1947]
}
```

Row keys are `{runtime}/{preset}/{profile}/{engine}`. Values array is parallel to `header.columns[]`.

### Proposed Project Structure

```
src/bench-viewer/
├── BenchViewer.csproj
├── Program.cs
├── App.razor / App.razor.cs
├── _Imports.razor
│
├── Models/                    # DTOs for deserialized view JSON
│   ├── ViewIndex.cs
│   ├── ViewHeader.cs
│   └── ViewData.cs
│
├── Services/
│   └── BenchDataService.cs    # HttpClient wrapper — fetches & caches view JSON
│
├── Layout/
│   ├── MainLayout.razor       # App shell (sidebar + content area)
│   └── MainLayout.razor.css
│
├── Pages/
│   ├── Dashboard.razor        # Main page — app tabs, metric charts/tables
│   └── Dashboard.razor.cs     # Code-behind with filter state, data loading
│
├── Components/                # Reusable UI components
│   ├── AppTabs.razor          # Tab bar for switching apps
│   ├── FilterPanel.razor      # Sidebar: runtime/preset/profile/engine checkboxes
│   ├── MetricChart.razor      # Single metric visualization (chart or table)
│   ├── TimeRangeSelector.razor # Week/release bucket selector
│   └── MetricTable.razor      # Tabular fallback for metric data
│
├── wwwroot/
│   ├── index.html             # Entry point with <base href="/blazor_coreclr_demo/">
│   ├── css/app.css
│   └── ...
│
└── Properties/
    └── launchSettings.json
```

### Key Design Decisions (Pending)

1. **Metric display name mapping** — The TypeScript `metrics.ts` defines display names and units. These need to be duplicated in C# or fetched as a static JSON resource.

2. **Row key parsing** — Each data row key like `mono/no-workload/desktop/chrome` must be parsed into 4 dimension values for filtering.

3. **Column alignment** — Values arrays are positionally aligned to `header.columns[]`. The UI must join these for rendering.

4. **Multi-bucket view** — Timeline charts need to load data across multiple week buckets. The UI should either:
   - Load all week headers + merge columns (expensive for many weeks)
   - Load one bucket at a time (simpler, paginated)

---

## Deployment

### Base Href

```html
<base href="/blazor_coreclr_demo/" />
```

### GitHub Pages

- Published output goes into `gh-pages/blazor_coreclr_demo/` subfolder
- `_framework/` and static assets served from there
- Data stays at `gh-pages/data/` (shared with any other consumers)

### Build Command

```bash
dotnet publish src/bench-viewer/BenchViewer.csproj -c Release -o gh-pages/blazor_coreclr_demo
```

### 404 Handling

GitHub Pages needs a `404.html` that redirects to `index.html` for client-side routing (Blazor Router). Either:
- Copy `index.html` as `404.html` in the publish output
- Or use a redirect script in `404.html`

---

## Metric Display Metadata (to port from TypeScript)

| Key | Display Name | Unit | Category |
|-----|-------------|------|----------|
| `compile-time` | Compile Time | ms | time |
| `disk-size-total` | Disk Size (Total) | bytes | size |
| `disk-size-native` | Disk Size (WASM) | bytes | size |
| `disk-size-assemblies` | Disk Size (DLLs) | bytes | size |
| `download-size-total` | Download Size (Total) | bytes | size |
| `time-to-reach-managed-warm` | Time to Managed (Warm) | ms | time |
| `time-to-reach-managed-cold` | Time to Managed (Cold) | ms | time |
| `memory-peak` | Peak JS Heap | bytes | memory |
| `pizza-walkthru` | Pizza Walkthrough | ms | time |
| `js-interop-ops` | JS Interop | ops/sec | throughput |
| `json-parse-ops` | JSON Parse | ops/sec | throughput |
| `exception-ops` | Exception Handling | ops/sec | throughput |

---

## Phased Implementation (Proposed)

### Phase 1: Data Loading + Table View
- Create `Models/` DTOs, `BenchDataService`
- Fetch `views/index.json` on startup
- Single-page dashboard: dropdown for app, dropdown for week/release bucket
- Load header + metric data files
- Render metric values in simple HTML tables
- Filter by dimension checkboxes (runtime, preset, profile, engine)

### Phase 2: Charts
- Integrate charting (Chart.js interop or Blazor-native)
- Time-series charts across multiple week buckets
- Proper axis labels, units, formatting

### Phase 3: Polish
- App tab bar matching docs/ui.md layout
- Sidebar filter panel
- Timeline range selector (7d/30d/90d/1y/All)
- Responsive layout
- URL-driven state (query params for filters)
