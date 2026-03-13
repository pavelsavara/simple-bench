# Agent Instructions

## Project Overview

This is **simple-bench**, a .NET Browser WebAssembly benchmark suite. It builds sample apps against nightly .NET SDK builds, measures performance across browsers and CLI JS engines, and publishes results to a GitHub Pages dashboard.

## Tech Stack

- **Pipeline CLI**: TypeScript in `bench/src/`, run via `tsx` (Node.js ≥24)
- **Sample apps**: C# / .NET 10+ in `src/` — Blazor and raw Browser WASM
- **Build system**: MSBuild with custom props files (`src/presets.props`, `src/versions.props`)
- **Measurement**: Playwright (Chrome/Firefox) with CDP for network/memory/throttling, V8 d8 and Node for CLI
- **CI**: GitHub Actions — daily benchmark run, weekly Docker image rebuild
- **Docker**: Multi-stage — `browser-bench-build` (SDK + emscripten) and `browser-bench-measure` (Playwright + d8)
- **Data storage**: `gh-pages` branch — JSON result files, month indexes, pivot-table views
- **Dashboard**: Static HTML + Svelte app in `gh-pages/app/`

## Key Directories

- `bench/src/stages/` — One file per pipeline stage (12 stages). Start here for pipeline logic.
- `bench/src/lib/` — Shared utilities: metrics definitions, throttle profiles, stats, measure helpers.
- `bench/src/enums.ts` — All dimension enums (Runtime, Preset, Engine, Profile, App) and constraint logic.
- `src/presets.props` — MSBuild preset definitions that control how apps are compiled.
- `.github/workflows/benchmark.yml` — Main CI workflow (daily build → measure matrix → aggregate).
- `docker/Dockerfile` — Build and measure container definitions.
- `docs/` — Detailed documentation on directory layout, data structures, pipeline stages, and measurement matrix.

## Running Locally

```bash
# Install dependencies
cd bench && npm install

# Run specific stages (e.g., build + measure for one SDK)
npx tsx src/main.ts --stage resolve-sdk,download-sdk,build,measure --runtime mono --preset no-workload --engine chrome --app empty-browser

# Dry run (single quick measurement)
npx tsx src/main.ts --stage measure --dry-run
```

On Windows, use `bench.ps1` wrapper; on Linux, use `bench.sh`.

## Conventions

- Pipeline stages are in `bench/src/stages/*.ts`. Each exports a `run(ctx: BenchContext)` function.
- Enums and constraints live in `bench/src/enums.ts`. When adding a new app, preset, or engine, update enums first.
- `shouldSkipMeasurement()` in enums.ts controls which app×preset combinations are skipped.
- MSBuild presets are defined in `src/presets.props` and mapped via `PRESET_MAP` in enums.ts.
- Result JSON files follow the schema in `docs/data-structures.md`.
- The build stage runs in two phases: non-workload presets first, then workload presets after installing `wasm-tools`.

## Testing Changes

- Build changes: run the `build` stage locally with `--app` and `--preset` filters.
- Measurement changes: run `measure` stage with `--dry-run` for a quick single-measurement pass.
- View/data changes: run `transform-views` and inspect the output JSON in `artifacts/results/`.

## Documentation

See the `docs/` folder for detailed reference:
- [directory-layout.md](../docs/directory-layout.md) — Full repo tree
- [artifacts-layout.md](../docs/artifacts-layout.md) — Build artifacts structure
- [gh-pages-layout.md](../docs/gh-pages-layout.md) — Dashboard and data storage
- [data-structures.md](../docs/data-structures.md) — JSON schemas with examples
- [pipeline-stages.md](../docs/pipeline-stages.md) — All 12 pipeline stages in detail
- [measurement-matrix.md](../docs/measurement-matrix.md) — Dimension matrix and constraints
