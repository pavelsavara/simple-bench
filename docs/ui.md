# Dashboard UI

Static site served from GitHub Pages. Loads pre-aggregated view JSON files and renders interactive charts.

## Technology Stack

- **Chart.js** with time axis adapter (date-fns) and zoom plugin
- **Vanilla JS** modules (no framework)
- **Static hosting** on GitHub Pages (gzip handled by CDN)

## Page Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  .NET WASM Benchmark Dashboard                    Updated: Mar 5   │
├───────────┬─────────────────────────────────────────────────────────┤
│           │  [ empty-browser | empty-blazor | blazing-pizza | µbench ]
│  Filters  │                                                         │
│           │  Timeline: [7d] [30d] [90d] [1y] [All]    ◄══════►     │
│  □ Runtime│  ┌─────────────────────────────────────────────────────┐│
│    ☑ mono │  │ Compile Time (ms)                                   ││
│    ☑ coreclr│ │                                                     ││
│           │  │  Net7│Net8│Net9│Net10│    Net11 timeline ──────►    ││
│  □ Preset │  │  ·  · · · · · · ·  │ · · ·  · · · ·  · · · · · · ││
│    ☑ devloop│ │     · · · · ·      │  · · ·  · ·  · · · ·  · ·   ││
│    ☑ no-wl│  │                     │                               ││
│    ☑ aot  │  └─────────────────────────────────────────────────────┘│
│    ...    │  ┌─────────────────────────────────────────────────────┐│
│           │  │ Disk Size Total (bytes)                             ││
│  □ Profile│  │  ...                                                ││
│    ☑ desktop│ └─────────────────────────────────────────────────────┘│
│    ☑ mobile│  ┌─────────────────────────────────────────────────────┐│
│           │  │ Time to Reach Managed (ms)                          ││
│  □ Engine │  │  ...                                                ││
│    ☑ chrome│ └─────────────────────────────────────────────────────┘│
│    ☑ firefox                                                        │
│    ☑ v8   │  ... more metric charts                                │
│    ☑ node │                                                         │
└───────────┴─────────────────────────────────────────────────────────┘
```

## App Tabs

One tab per application. Switching tabs:
1. Updates the chart area with metrics relevant to that app
2. Adjusts engine filter visibility (e.g. v8/node hidden for blazor apps)
3. Persists selection in URL hash

| Tab | Metrics Shown |
|-----|--------------|
| `empty-browser` | All external metrics |
| `empty-blazor` | All external metrics |
| `blazing-pizza` | All external metrics + `pizza-walkthru` |
| `microbenchmarks` | `compile-time`, `memory-peak`, `js-interop-ops`, `json-parse-ops`, `exception-ops` |

## Overview Tab

Deferred to a later phase. See [future.md](future.md) for the planned KPI tiles, sparklines, and delta-vs-release design.

The first-pass dashboard launches directly on the first app tab.

## Chart Layout: Two-Zone Graph

Each metric chart has two visual zones:

### Left Zone: Frozen Releases

- One **fixed-width block** per frozen .NET release (Net7, Net8, Net9, Net10)
- X axis: **SDK version labels** (not dates)
- No zoom or scroll — always fully visible
- Small number of data points (GA + service packs, typically 1–5)
- Blocks separated by thin vertical dividers with release labels

### Right Zone: Active Release Timeline

- Scrollable, zoomable time series for the active release (Net11)
- X axis: **commit date** (time scale)
- Connected to the timeline range selector
- Supports mouse-wheel zoom + drag pan

### Visual Separation

```
│ Net7  │ Net8   │ Net9   │ Net10 ┃      Net11 (scrollable)                │
│ 7.0   │ 8.0 8.1│ 9.0 9.1│ 10.0  ┃  Mar    Apr    May    Jun             │
│ ·     │ · ·   │ ·  ·  │ ·    ┃  · · · · · · · · · · · · · · · · ·   │
│       │       │       │       ┃                                         │
└───────┴───────┴───────┴───────┻─────────────────────────────────────────┘
 fixed width, no interaction       ← zoom/pan/select →
```

The frozen zone takes up a **fixed pixel width** (~200px total). The active zone fills the remaining chart width. This ensures frozen data is always visible at the same scale regardless of how much active data is loaded.

## Sidebar Filter Panel

Checkboxes for each filter dimension. Toggling a checkbox hides/shows all chart lines whose row key matches.

### Filter Groups

| Group | Values | Default |
|-------|--------|---------|
| Runtime | `mono`, `coreclr` | all checked |
| Preset | `devloop`, `no-workload`, `aot`, `native-relink`, `no-jiterp`, `invariant`, `no-reflection-emit` | all checked |
| Profile | `desktop`, `mobile` | all checked |
| Engine | `chrome`, `firefox`, `v8`, `node` | all checked |

### Dynamic Visibility

- When app tab is `empty-blazor` or `blazing-pizza`: hide `v8`, `node` engine checkboxes (browser-only apps)
- All four engines (chrome, firefox, v8, node) are available for `empty-browser` and `microbenchmarks`
- Firefox produces timing metrics (ops/sec) for microbenchmarks but not `memory-peak` (no CDP)
- `mobile` profile: only produces data for `chrome` engine — if `mobile` is checked and `chrome` is unchecked, those lines disappear naturally
- `aot` and `no-jiterp` presets: only valid for `mono` runtime — if `mono` is unchecked, those lines disappear

### Filtering Logic

A chart line (series) is **visible** if ALL of its row key dimensions pass the filter:

```javascript
function isRowVisible(rowKey, filterState) {
    const [runtime, preset, profile, engine] = rowKey.split('/');
    return filterState.runtimes.includes(runtime)
        && filterState.presets.includes(preset)
        && filterState.profiles.includes(profile)
        && filterState.engines.includes(engine);
}
```

## Data Loading Flow

### On page load:

1. Fetch `views/index.json`
2. Read URL hash state (app, filters, date range)
3. Initialize sidebar filters from `index.dimensions`
4. Set active app tab
5. Fetch release headers + data for selected app (all frozen releases)
6. Determine visible weeks from timeline range
7. Fetch week headers for visible weeks
8. For each week: fetch data files listed in `header.apps[currentApp]`
9. Assemble chart datasets and render

### On app tab change:

1. Update URL hash
2. Fetch release data files for new app (if not cached)
3. Fetch week data files for new app in visible weeks
4. Re-render all charts

### On filter change:

1. Update URL hash
2. Re-render charts with visibility filter (no fetch needed — data already loaded)

### On timeline range change:

1. Update URL hash
2. Determine which weeks are newly visible
3. Fetch headers + data files for newly visible weeks
4. Re-render charts with updated datasets

### Caching

- `index.json`: cached for page lifetime
- Release headers + data: cached for page lifetime (frozen, never changes)
- Week headers + data: cached by week key. Invalidated only on full page reload

## Chart Series Encoding

Each visible row key becomes a Chart.js dataset (line). Visual encoding:

| Dimension | Encoding | Values |
|-----------|----------|--------|
| Engine | **Color** | chrome=#F4B400, firefox=#EA4335, v8=#4285F4, node=#34A853 |
| Preset | **Dash pattern** | devloop=[5,5], no-workload=solid, aot=[10,5], native-relink=[3,3], invariant=[10,3,3,3], no-reflection-emit=[15,5] |
| Runtime | **Marker shape** | mono=triangle, coreclr=circle |
| Profile | **Line width** | desktop=1px, mobile=2px |

This gives each combination a unique visual signature — e.g. "mono/aot/desktop/chrome" is a yellow dashed line with triangle markers at 1px width.

### Legend

The chart legend shows series labels in `{runtime} / {preset} / {profile} / {engine}` format. Clicking a legend item toggles that series.

## Tooltip Content

Hovering a data point shows:

```
Date: 2026-03-03
SDK: 11.0.100-preview.3.26152.105
Runtime hash: abc1234
────────────────
Compile Time: 4,443 ms
```

For frozen releases, shows SDK version instead of date:
```
SDK: 9.0.101
Runtime hash: def5678
────────────────
Compile Time: 5,200 ms
```

Tooltip data comes from the week/release header's `columns` array (matched by position).

## Timeline Range Selector

Interactive bar below the tabs showing the full date extent:

```
[7d] [30d] [90d] [1y] [All]     ⌂
 ═══════════════╣████████████╠═══
                ← drag →
```

- Preset buttons: 7d, 30d, 90d, 1y, All
- Home button: reset to default 90 days
- Draggable window: pan the visible range
- Mouse wheel: zoom in/out
- Changes propagate to all charts via `setXRange()`

The timeline only controls the **active release zone**. Frozen releases are always fully visible.

## URL Hash State

Filter state persisted in URL hash for bookmarking/sharing:

```
#app=empty-browser&runtime=mono&preset=devloop,no-workload&profile=desktop&engine=chrome,firefox&range=2026-02-01,2026-03-05
```

| Parameter | Format | Default |
|-----------|--------|---------|
| `app` | app name | `empty-browser` |
| `runtime` | comma-separated | all |
| `preset` | comma-separated | all |
| `profile` | comma-separated | all |
| `engine` | comma-separated | all |
| `range` | `min,max` ISO dates | last 90 days |

Changing any filter or tab updates the hash via `history.replaceState`. Tab changes use `history.pushState` for back/forward navigation.

## Value Formatting

| Unit | Format | Example |
|------|--------|---------|
| `ms` | `{n} ms` or `{n.f} ms` | `4,443 ms`, `56.2 ms` |
| `bytes` | `{n} MB` / `{n} KB` / `{n} B` | `8.39 MB`, `1.95 KB` |
| `ops/sec` | `{n} ops/sec` | `3,267,221 ops/sec` |

Y-axis labels share the same formatting. Auto-scaling based on value range.

## Empty States

| Condition | Message |
|-----------|---------|
| No data at all | "No benchmark data yet. Run the CI pipeline to collect data." |
| Filters exclude everything | "No data for selected filters. Try broadening your selection." |
| Metric has no data for current app | Chart not rendered (skipped) |

## Commit Detail Panel

Clicking a data point on any chart opens a **commit detail panel** in the sidebar below the filters.

### Single Selection (First Click)

Clicking a data point shows:

```
┌─ Commit A ──────────────────────┐
│  Date: 2026-03-03               │
│  SDK: 11.0.100-preview.3.261... │
│                                 │
│  🔗 VMR @ aaa111b               │
│  🔗 Runtime @ abc1234            │
│  🔗 SDK @ 111222a               │
│                                 │
│  Metrics (this series):         │
│  compile-time: 4,443 ms         │
│  disk-size-total: 8.84 MB       │
│  time-to-managed: 56 ms         │
│  ...                            │
│                          [Clear]│
└─────────────────────────────────┘
```

| Field | Content |
|-------|---------|
| Date | Commit date from column metadata |
| SDK | Full SDK version string |
| VMR link | `https://github.com/dotnet/dotnet/commit/{vmrHash}` |
| Runtime link | `https://github.com/dotnet/runtime/commit/{runtimeHash}` |
| SDK link | `https://github.com/dotnet/sdk/commit/{sdkHash}` |
| Metrics | All metric values for the clicked series at this column position |

Links open in new tabs. Hash values are truncated to 7 chars in display but use full hash in URLs.

### Comparison (Second Click)

Clicking a second data point (same or different chart) opens a **side-by-side comparison panel**:

```
┌─ Commit A ──────────┬─ Commit B ──────────┐
│  2026-03-03         │  2026-03-05         │
│  SDK: ...26152.105  │  SDK: ...26153.117  │
│  🔗 VMR @ aaa111b   │  🔗 VMR @ bbb222c   │
│  🔗 Runtime @ abc1234│ 🔗 Runtime @ def5678│
│  🔗 SDK @ 111222a   │  🔗 SDK @ 333444b   │
├─────────────────────┴─────────────────────┤
│  📊 Diff A → B:                           │
│  🔗 VMR diff                               │
│  🔗 Runtime diff                           │
│  🔗 SDK diff                               │
├───────────────────────────────────────────┤
│  Metric          A         B      Δ      │
│  compile-time    4,443 ms  4,501  +1.3%  │
│  disk-size-total 8.84 MB   8.85   +0.1%  │
│  time-to-managed 56 ms     52     -7.1%  │
│                          [Clear] [Swap]  │
└───────────────────────────────────────────┘
```

| Diff link | URL |
|-----------|-----|
| VMR diff | `https://github.com/dotnet/dotnet/compare/{vmrHashA}...{vmrHashB}` |
| Runtime diff | `https://github.com/dotnet/runtime/compare/{runtimeHashA}...{runtimeHashB}` |
| SDK diff | `https://github.com/dotnet/sdk/compare/{sdkHashA}...{sdkHashB}` |

Diff links are always A→B (chronological order). The **Swap** button reverses A and B.

### Interaction Rules

- **First click** on a data point: sets commit A, shows single panel
- **Second click** on a different point: sets commit B, shows comparison panel
- **Third click**: replaces commit A with the new point, clears commit B (back to single panel)
- **Clear button**: dismisses the panel entirely
- **Clicking same point again**: deselects it
- Selected points are highlighted on all charts (larger marker, ring outline) so you can see both points across metrics
- The panel scrolls independently from the chart area

### Data Source

Commit metadata (hashes, SDK version, date) comes from the week/release header `columns` array. Metric values come from the loaded data files at the corresponding column index for the clicked series' row key.

## Responsive Design

- Sidebar collapses to a top-bar dropdown on viewports < 768px
- Commit detail panel moves to a bottom sheet on mobile
- Charts stack vertically, full width
- Timeline remains full width below tabs
- Touch: pinch-to-zoom on charts, drag on timeline
