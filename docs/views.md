# Views: Dashboard UI Pages

## Overview

The dashboard is a static single-page application hosted on GitHub Pages. It presents benchmark data as time-series line charts, one page per sample app, with a shared filter sidebar. No app server — all data is fetched as JSON via `fetch()`.

**URL**: `https://<org>.github.io/simple-bench/`

---

## Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  .NET WASM Benchmark Dashboard                    [last updated]│
├───────────┬─────────────────────────────────────────────────────┤
│           │  ┌─────────────────────────────────────────────┐    │
│  FILTERS  │  │ empty-browser │ empty-blazor │ blazing-pizza│    │
│           │  │ microbenchmarks                             │    │
│  ☑ CoreCLR│  ├─────────────────────────────────────────────┤    │
│  ☑ Mono   │  │                                             │    │
│           │  │  Chart: Download Size (bytes)               │    │
│  CONFIG   │  │  ═══════════════════════════════════════     │    │
│  ☑ Release│  │   [time-series line chart]                  │    │
│  ☑ AOT    │  │                                             │    │
│  ☑ Relink │  ├─────────────────────────────────────────────┤    │
│           │  │                                             │    │
│  ENGINE   │  │  Chart: Time to First Render (ms)           │    │
│  ☑ V8     │  │  ═══════════════════════════════════════     │    │
│  ☑ Node   │  │   [time-series line chart]                  │    │
│  ☑ Chrome │  │                                             │    │
│  ☑ Firefox│  ├─────────────────────────────────────────────┤    │
│           │  │                                             │    │
│  TIME     │  │  Chart: Time to First UI Change (ms)        │    │
│  [30d ▼]  │  │  ═══════════════════════════════════════     │    │
│           │  │   [time-series line chart]                  │    │
│           │  │                                             │    │
│           │  ├─────────────────────────────────────────────┤    │
│           │  │                                             │    │
│           │  │  Chart: Memory Peak (bytes)                 │    │
│           │  │  ═══════════════════════════════════════     │    │
│           │  │   [time-series line chart]                  │    │
│           │  │                                             │    │
│           │  └─────────────────────────────────────────────┘    │
└───────────┴─────────────────────────────────────────────────────┘
```

---

## Navigation

### App Tabs
Horizontal tab bar at the top of the content area. Each tab corresponds to one sample app:

| Tab | App | Metrics shown |
|-----|-----|--------------|
| **empty-browser** | Empty browser template | External (download-size, TTFR, TTFUC, memory-peak) |
| **empty-blazor** | Empty Blazor WASM template | External (download-size, TTFR, TTFUC, memory-peak) |
| **blazing-pizza** | BlazingPizza Blazor app | External (download-size, TTFR, TTFUC, memory-peak) |
| **microbenchmarks** | Custom JSExport benchmarks | Internal (js-interop-ops, json-parse-ops, exception-ops) |

- Active tab is visually highlighted.
- Tab selection is persisted in URL hash: `#app=empty-browser`.
- Apps are **never compared to each other** — each has its own page with its own charts.

---

## Filter Sidebar

Fixed-width left sidebar (~220px). All filters are multi-select checkboxes. Changing any filter immediately re-renders all charts on the current page.

### Runtime Flavor
```
RUNTIME
☑ CoreCLR
☑ Mono
```

### Build Configuration
```
CONFIG
☑ Release
☑ AOT          (only shown when Mono is selected)
☑ NativeRelink
```
- AOT checkbox is hidden/disabled when Mono is deselected (AOT is Mono-only).

### Execution Engine
```
ENGINE
☑ V8
☑ Node
☑ Chrome
☑ Firefox
```
- For external metrics (app tabs: empty-browser, empty-blazor, blazing-pizza), only Chrome is applicable. The other engine checkboxes are hidden on those pages.
- For internal metrics (microbenchmarks tab), all 4 engines are shown.

### Time Range
```
TIME RANGE
[  30 days  ▼]
```
Dropdown with options: 7 days, 30 days, 90 days, 180 days, 1 year, All.
Controls the X-axis date range for all charts on the page.

### Filter state persistence
- All filter selections are encoded in the URL hash: `#app=microbenchmarks&runtime=coreclr,mono&config=release&engine=v8,chrome&range=30d`
- Bookmarkable and shareable.
- On page load, filters are restored from URL hash. If no hash, defaults: all checkboxes selected, 30d range.

---

## Charts

### Chart Type
Every chart is a **time-series line chart** (Chart.js `type: 'line'`).

### Axes
- **X-axis**: Date (time scale). Ticks show `YYYY-MM-DD`. Zoom/pan if possible (via chartjs-plugin-zoom, optional).
- **Y-axis**: Metric value. Label includes unit (e.g., "bytes", "ms", "ops/min"). Auto-scaled to visible data range.

### Lines (Series)
Each line represents one **engine × config × runtime** combination. Lines are differentiated by:

| Visual | Maps to |
|--------|---------|
| **Color** | Engine (V8=blue, Node=green, Chrome=orange, Firefox=red) |
| **Dash pattern** | Config (Release=solid, AOT=dashed, NativeRelink=dotted) |
| **Line thickness** | Runtime (CoreCLR=2px, Mono=1.5px) — or use shape markers instead |
| **Point marker** | Runtime (CoreCLR=circle, Mono=triangle) |

### Legend
- Positioned below chart title, above the chart canvas.
- Clickable: clicking a legend item toggles that series on/off.
- Shows color swatch + pattern + label like "CoreCLR / Release / Chrome".

### Tooltips
On hover over a data point, show a tooltip with:
```
Date: 2026-03-02
SDK: 10.0.100-preview.3.25130.1
Git: abc1234
Runtime: CoreCLR
Config: Release
Engine: Chrome
────────────────
Download Size: 2,450,000 bytes
```
- Values are formatted with thousand separators.
- Git hash is truncated to 7 characters in display.

---

## App-Specific Page Details

### Empty Browser Page (`#app=empty-browser`)
4 charts stacked vertically:
1. **Download Size** (bytes) — total transferred bytes to load the app
2. **Time to First Render** (ms) — time from navigation to first contentful paint
3. **Time to First UI Change** (ms) — time from navigation to first interactive DOM update
4. **Memory Peak** (bytes) — peak JS heap size during load + initial interaction

Engine filter: Chrome only (CDP-based metrics).

### Empty Blazor Page (`#app=empty-blazor`)
Same 4 charts as empty-browser. Same engine constraint (Chrome only).

### Blazing Pizza Page (`#app=blazing-pizza`)
Same 4 charts as empty-browser. Same engine constraint (Chrome only).
May show larger download sizes and longer render times due to app complexity.

### Microbenchmarks Page (`#app=microbenchmarks`)
3 charts stacked vertically:
1. **JS Interop** (ops/min) — round-trip calls from JS to C# [JSExport] and back
2. **JSON Parsing** (ops/min) — System.Text.Json deserialize operations
3. **Exception Handling** (ops/min) — throw + catch cycle throughput

Engine filter: All 4 engines shown (V8, Node, Chrome, Firefox).
This is the page where engine comparison is most interesting — expect different perf characteristics per engine.

---

## Interactions

### URL-driven state
The entire view state is encoded in the URL hash. Changing tab or filters updates the hash. Browser back/forward navigates filter history.

### Lazy data loading
1. On initial load: fetch `data/manifest.json` (~small, index of all runs).
2. Based on selected time range and current app tab, determine which weekly JSON files are needed.
3. Fetch only those weekly files (parallel `fetch()` calls).
4. Cache fetched files in memory — don't re-fetch on filter change if data is already loaded.
5. On time range expansion, fetch only the newly-visible weeks.

### Loading states
- Spinner shown while manifest loads.
- Individual charts show "Loading..." placeholder while their data files are being fetched.
- If a fetch fails, show "Failed to load data" with a retry button.

### Empty states
- If no data matches current filters: "No data for selected filters. Try broadening your selection."
- If manifest is empty (fresh install): "No benchmark data yet. Run the CI pipeline to collect data."

### Responsive layout
- Sidebar collapses to a top-bar dropdown menu on narrow screens (<768px).
- Charts stack full-width on mobile.
- Chart height is fixed (300px desktop, 250px mobile).

---

## Header

```
┌─────────────────────────────────────────────────────────────────┐
│  📊 .NET WASM Benchmark Dashboard          Last updated: Mar 2 │
│                                             Data points: 1,247  │
└─────────────────────────────────────────────────────────────────┘
```

- Title with icon.
- "Last updated" from `manifest.lastUpdated`.
- "Data points" = total count of runs in manifest.
- Link to GitHub repo in top-right corner.

---

## Color Palette

| Engine | Color | Hex |
|--------|-------|-----|
| V8 | Blue | `#4285F4` |
| Node.js | Green | `#34A853` |
| Chrome | Orange | `#F4B400` |
| Firefox | Red | `#EA4335` |

| Config | Dash | CSS |
|--------|------|-----|
| Release | Solid | — |
| AOT | Dashed | `[10, 5]` |
| NativeRelink | Dotted | `[3, 3]` |

| Runtime | Marker |
|---------|--------|
| CoreCLR | ● Circle |
| Mono | ▲ Triangle |
