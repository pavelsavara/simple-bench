# UI Plan — Blazor WASM Benchmark Dashboard

> **Status**: Phase 1+2+3 COMPLETE — all features implemented, deployment config remaining

## Goal

Replace the placeholder `gh-pages/index.html` dashboard with a Blazor WebAssembly application (`src/bench-viewer`) that visualizes benchmark results. Deployed to GitHub Pages at `/blazor_coreclr_demo/`.

---

## Decisions (Finalized)

| # | Question | Decision |
|---|----------|----------|
| 1 | **Data source URL** | JS fetches from remote views URL (currently hardcoded) |
| 2 | **Charting library** | Chart.js via `[JSImport]` interop — JS fetches data and renders charts |
| 3 | **Benchmark instrumentation** | Keep — bench-viewer is also a benchmarked app (secondary role) |
| 4 | **UI layout** | Left sidebar filters + center app tabs/charts + right detail panel (3-column) |
| 5 | **CSS framework** | Bootstrap 5 (CSS only, no JS components) |
| 6 | **Service worker** | Removed |
| 7 | **Build toolchain** | Existing `src/` folder arrangements, net8+ compatible |
| 8 | **Phasing** | Incremental — jumped from Phase 1 directly to Phase 2 |

---

## Architecture

### Data Flow

```
gh-pages/data/views/index.json          ← view catalog (apps, metrics, dimensions, weeks, releases)
gh-pages/data/views/{week}/header.json   ← column metadata per week bucket
gh-pages/data/views/{week}/{app}_{metric}.json  ← pivot data: rowKey → values[]
gh-pages/data/views/releases/{netN}/...  ← same structure for GA releases
```

Data is fetched entirely by JS (`chart-interop.mjs`) via `fetch()`. The C# side only receives serialized index metadata through `[JSImport]` interop — no `HttpClient` usage for data.

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

### Actual Project Structure

```
src/bench-viewer/
├── BenchViewer.csproj          # Targets net8+, Blazor WASM
├── Program.cs                  # Standard Blazor WASM bootstrap (HttpClient registered but unused)
├── App.razor                   # Router + Layout + NotFound
├── App.razor.cs                # OnInitialized → SetManagedReady() JSImport (benchmark timing)
├── _Imports.razor              # Namespace declarations
│
├── Models/                     # DTOs for deserialized view JSON
│   ├── ViewIndex.cs            # index.json: apps, metrics, dimensions, weeks, releases
│   ├── ViewHeader.cs           # header.json: columns (git hashes, dates, SDK versions)
│   └── MetricInfo.cs           # Hardcoded metric catalog (display names, units, categories)
│
├── Interop/
│   └── ChartInterop.cs         # C# [JSImport] facades → chart-interop.mjs functions
│
├── Layout/
│   ├── MainLayout.razor        # Minimal shell: <div class="page">@Body
│   └── MainLayout.razor.css    # Defers to wwwroot/css/app.css
│
├── Pages/
│   ├── Home.razor              # Dashboard: sidebar + app tabs + charts area (~130 lines)
│   ├── Home.razor.cs           # Page logic: data loading, filtering, formatting (~260 lines)
│   └── NotFound.razor          # Simple 404 fallback
│
├── Components/
│   ├── AppTabs.razor           # Bootstrap nav-tabs for app selection
│   └── FilterPanel.razor       # Collapsible filter groups with dynamic engine visibility
│
├── wwwroot/
│   ├── index.html              # SPA entry point (base href="/", Chart.js script tags)
│   ├── main.mjs                # Blazor startup, module registration, benchmark timing
│   ├── chart-interop.mjs       # ~600 lines: data fetching, Chart.js rendering, filtering
│   ├── css/app.css             # Full dashboard layout (sidebar, responsive, charts)
│   └── lib/
│       ├── bootstrap/          # Bootstrap 5 CSS
│       └── chartjs/            # Chart.js 4.x, zoom plugin, date-fns adapter, Hammer.js
│
└── Properties/
    └── launchSettings.json
```

### What Changed From the Original Plan

| Planned | Actual | Reason |
|---------|--------|--------|
| `Services/BenchDataService.cs` (HttpClient) | `chart-interop.mjs` (JS fetch) | All data loading moved to JS side for efficiency |
| `Pages/Dashboard.razor` | `Pages/Home.razor` | Renamed to Home |
| `Components/MetricChart.razor` | Canvas elements in Home.razor | Charts managed entirely by JS, no per-chart Blazor component |
| `Components/TimeRangeSelector.razor` | Inline buttons in tabs-header | Simple enough to embed in Home.razor |
| `Components/MetricTable.razor` | Not implemented | Skipped table view, went straight to charts |
| `Models/ViewData.cs` | Not needed | Data parsed and rendered entirely in JS |

### Design Decisions (Resolved)

1. **Metric display name mapping** — Hardcoded in `Models/MetricInfo.cs` as a static dictionary (13 metrics with display name, unit, category).

2. **Row key parsing** — Done in JS (`parseRowKey()` in `chart-interop.mjs`). Splits `"runtime/preset/profile/engine"` into 4 fields. C# receives filter state as serialized JSON.

3. **Column alignment** — Handled entirely in JS. `chart-interop.mjs` merges data arrays from multiple buckets, aligning each value with its corresponding column's datetime/SDK version.

4. **Multi-bucket view** — Loads ALL week headers and ALL release headers upfront during `initDashboard()`. Per-metric data files loaded on demand per app. Release data shown as a "frozen zone" (category axis) and weekly data as an "active zone" (time axis), separated by a dashed vertical line.

### Chart.js Integration Details

**Visual encoding** — Each dataset (dimension combination) is styled by 4 properties:
- **Border color** → engine: chrome=#F4B400, firefox=#EA4335, v8=#4285F4, node=#34A853
- **Dash pattern** → preset: no-workload=solid, aot=[10,5], devloop=[5,5], etc.
- **Point marker** → runtime: mono=triangle, coreclr=circle
- **Line width** → profile: desktop=1, mobile=2

**Two-zone charts** — Release data (frozen zone, left) + weekly nightly data (active zone, right), separated by a custom `frozenZonePlugin` vertical dashed line.

**Interactivity** — Zoom (Ctrl+scroll, pinch), pan (Shift+scroll), tooltips (SDK version + date + value), chart point click → C# callback → right-side detail panel with commit links and all metric values. Timeline range selector (7d/30d/90d/1y/All) filters week data by cutoff date.

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

## Metric Display Metadata (ported to C#)

Implemented in `Models/MetricInfo.cs`. All 13 metrics ported:

| Key | Display Name | Unit | Category | Status |
|-----|-------------|------|----------|--------|
| `compile-time` | Compile Time | ms | time | ✅ |
| `disk-size-total` | Disk Size (Total) | bytes | size | ✅ |
| `disk-size-native` | Disk Size (WASM) | bytes | size | ✅ |
| `disk-size-assemblies` | Disk Size (DLLs) | bytes | size | ✅ |
| `download-size-total` | Download Size (Total) | bytes | size | ✅ |
| `time-to-reach-managed-warm` | Time to Managed (Warm) | ms | time | ✅ |
| `time-to-reach-managed-cold` | Time to Managed (Cold) | ms | time | ✅ |
| `memory-peak` | Peak JS Heap | bytes | memory | ✅ |
| `pizza-walkthrough` | Pizza Walkthrough | ms | time | ✅ |
| `js-interop-ops` | JS Interop | ops/sec | throughput | ✅ |
| `json-parse-ops` | JSON Parse | ops/sec | throughput | ✅ |
| `exception-ops` | Exception Handling | ops/sec | throughput | ✅ |
| `havit-walkthrough` | Havit Walkthrough | ms | time | ✅ |

---

## Implementation Progress

### Phase 1: Data Loading + Table View — ✅ COMPLETE (table view skipped)
- ✅ Create `Models/` DTOs (`ViewIndex`, `ViewHeader`, `MetricInfo`)
- ✅ Fetch `views/index.json` on startup (via JS `initDashboard()`)
- ✅ Single-page dashboard with app tabs
- ✅ Load header + metric data files (all buckets, all metrics per app)
- ⏭️ Render metric values in HTML tables — **Skipped**, went directly to charts
- ✅ Filter by dimension checkboxes (runtime, preset, profile, engine)

### Phase 2: Charts — ✅ COMPLETE
- ✅ Chart.js integration via `[JSImport]` interop (~600 lines JS)
- ✅ Time-series line charts across all week + release buckets
- ✅ Proper axis labels, units, value formatting
- ✅ Legend with dimension-aware styling (color/dash/marker/width)
- ✅ Tooltips with SDK version, commit date, metric value
- ✅ Zoom (Ctrl+scroll, pinch) and pan (Shift+scroll)
- ✅ Two-zone layout: frozen releases (left) + active weekly (right)
- ✅ Custom frozen-zone separator plugin

### Phase 3: Polish — ✅ COMPLETE
- ✅ App tab bar (Bootstrap nav-tabs)
- ✅ Sidebar filter panel with collapsible groups
- ✅ Dynamic engine visibility (hide v8/node for Blazor apps)
- ✅ Responsive layout (sidebar collapses at 768px)
- ✅ Metric filtering (hide build metrics for microbenchmarks)
- ✅ Chart point click → right-side detail panel (JS callback → C# → panel with commit links + all metrics)
- ✅ Timeline range selector (7d/30d/90d/1y/All)
- ✅ 404.html for SPA routing fallback
- ✅ All 13 metrics in MetricInfo.cs catalog

### Remaining Work

| Item | Priority | Description |
|------|----------|-------------|
| Configure base href | High | `index.html` uses `<base href="/">` — needs `/blazor_coreclr_demo/` for GitHub Pages |
| Make data URL configurable | Medium | Currently hardcoded to `pavelsavara.github.io/simple-bench/data/views` in `Home.razor.cs` |

---

## E2E Integration Test Scenarios

Tests use Playwright against the built bench-viewer app served locally.

### Build Command
```bash
.\bench.ps1 --verbose --sdk-channel 10.0 --app bench-viewer --preset devloop --stages acquire-sdk,build
```

### Test Scenarios

| # | Scenario | Steps | Assertions |
|---|----------|-------|------------|
| 1 | **Dashboard loads** | Navigate to `/` | Loading spinner appears, then app tabs visible; at least one chart canvas rendered |
| 2 | **Data fetched from remote** | Navigate to `/` and wait for charts | Network requests to `pavelsavara.github.io/simple-bench/data/views/index.json` succeed; `viewIndex` populated |
| 3 | **App tab switching** | Click different app tab | Previous charts destroyed; new charts rendered for selected app |
| 4 | **Filter checkboxes** | Uncheck "mono" runtime | Chart datasets for mono hidden; re-check restores them |
| 5 | **Time range selector** | Click "30d" button | Charts reload with only data from last 30 days; "30d" button has active styling |
| 6 | **Chart zoom** | Ctrl+scroll on a chart | Chart x-axis range narrows (zoom in) or widens (zoom out) |
| 7 | **Chart point click** | Click a data point on a chart | Right-side detail panel appears with commit hash links, SDK version, date, and all metric values |
| 8 | **Detail panel dismiss** | Click "✕" on detail panel | Panel disappears |
| 9 | **Scrolling** | Scroll main content vertically | Sidebar and tabs-header remain sticky; charts scroll |
| 10 | **Engine visibility** | Switch to a Blazor app (empty-blazor) | v8 and node checkboxes hidden in filter panel |
