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
└── data/                       # ── Published Benchmark Views ───────────────────
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
2. Merges them with any existing `data/views/` buckets already present in `gh-pages/`
3. Writes refreshed pivot views under `data/views/` for the dashboard

## Cache Flow

1. **check-out-cache** seeds `artifacts/` from `cache/` (if artifact files are missing)
2. Enumerate stages update files in `artifacts/`
3. **update-cache** copies updated pack/commit lists back to `cache/` and pushes

## View Types

### Week Views (`views/{YYYY-MM-DD}/`)

One view per ISO week (keyed by Monday date) for **daily/nightly builds** of the highest-major SDK (e.g., net11 previews). Only SDK versions with a prerelease tag (e.g., `11.0.100-preview.3.26162.108`) are included. Each week bucket contains all commits whose `runtimeCommitDateTime` falls within that week. Lower-major daily builds are filtered out.

### Release Views (`views/releases/{netN}/`)

One view per **GA release major** (e.g., net9, net10). Contains all GA releases (SDK versions without a prerelease tag) for that major version, sorted by semver (major.minor.patch).

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
