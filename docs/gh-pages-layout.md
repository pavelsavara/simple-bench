# gh-pages Directory Layout

The `gh-pages/` directory is a checkout of the `gh-pages` branch, used both as the live dashboard and as persistent data storage for benchmark results and views.

```
gh-pages/
├── .gitignore
├── .nojekyll                   # Disable Jekyll processing on GitHub Pages
├── index.html                  # Dashboard entry point (loads app/)
│
├── app/                        # ── Dashboard Application ───────────────────────
│   └── vendor/                 # Third-party JS/CSS for the dashboard UI
│
├── cache/                      # ── Cached Pack Lists ───────────────────────────
│   ├── daily-packs-list.json   # Cached copy of artifacts/daily-packs-list.json
│   ├── release-packs-list.json # Cached copy of artifacts/release-packs-list.json
│   └── commits-list.json       # Cached copy of artifacts/commits-list.json
│
└── data/                       # ── Benchmark Data ──────────────────────────────
    ├── index.json              # Master index: lastUpdated + list of months
    ├── {YYYY-MM}.json          # Month index (one per month with results)
    │
    ├── {YYYY}/                 # ── Per-Date Result Files ───────────────────────
    │   └── {YYYY-MM-DD}/       # Date directory
    │       └── {timestamp}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
    │
    └── views/                  # ── Pre-computed Pivot Views ────────────────────
        ├── index.json          # View index: activeRelease, weeks, releases, apps, metrics, dimensions
        │
        ├── {YYYY-MM-DD}/       # Week view (Monday of the week, active release major)
        │   ├── header.json     # Column definitions + app→metric mapping
        │   └── {app}_{metric}.json  # Pivot data: rowKey → values[]
        │
        └── releases/           # Release views (older GA majors)
            └── {netN}/         # e.g., net9/
                ├── header.json
                └── {app}_{metric}.json
```

## Data Flow

1. **transform-views** reads `artifacts/results/` JSON files
2. Copies them to `data/{YYYY}/{YYYY-MM-DD}/`
3. Updates the month index `data/{YYYY-MM}.json` with new commits and results
4. Updates `data/index.json` with the list of active months
5. Builds pivot views under `data/views/` for the dashboard

## Cache Flow

1. **check-out-cache** seeds `artifacts/` from `cache/` (if artifact files are missing)
2. Enumerate stages update files in `artifacts/`
3. **update-cache** copies updated pack/commit lists back to `cache/` and pushes

## View Types

### Week Views (`views/{YYYY-MM-DD}/`)

One view per ISO week (keyed by Monday date) for the **active release major** (e.g., net10 daily builds). Each week bucket contains all commits whose `runtimeCommitDateTime` falls within that week.

### Release Views (`views/releases/{netN}/`)

One view per **older GA release major** (e.g., net9). Contains all GA releases for that major version, ordered by release date.

### View File Format

Each view directory contains:

- **header.json** — Column metadata (one entry per commit/release in the bucket) and the set of apps×metrics available.
- **{app}\_{metric}.json** — Pivot data where each key is a dimension combination (`runtime/preset/profile/engine`) and the value is an array aligned with the header columns.

Example file: `empty-browser_compile-time.json`
```json
{
  "mono/no-workload/desktop/chrome": [1991],
  "mono/no-workload/desktop/firefox": [1947],
  "mono/no-workload/mobile/chrome": [1947]
}
```
