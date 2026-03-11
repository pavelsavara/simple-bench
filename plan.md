# Plan: TypeScript CLI (`bench/`)

## Goal

.NET Browser WASM benchmark suite. Single TypeScript CLI entry point (`bench`), strongly typed context, stage-based pipeline, cross-platform exec helpers.

## Design Documents

| Document | Description |
|----------|-------------|
| [docs/pipeline-model.md](docs/pipeline-model.md) | Data dimensions, metric definitions, combination matrix |
| [docs/pipeline.md](docs/pipeline.md) | Build phases, measure phases, consolidation, local execution |
| [docs/structure.md](docs/structure.md) | Repository layout, artifact paths, key path patterns |
| [docs/ci.md](docs/ci.md) | CI workflows, Docker images, triggers, self-scheduling |
| [docs/transformer.md](docs/transformer.md) | View transformer algorithm, bucketing, incremental updates |
| [docs/ui.md](docs/ui.md) | Dashboard UI layout, chart zones, filter panel |
| [docs/view-model.md](docs/view-model.md) | Pre-aggregated view JSON file formats |

Stage-specific design docs in [docs/stages/](docs/stages/).

## Architecture

Single CLI entry point: `bench --stages <list> [options]`

`main.ts` → `parseArgs()` → `buildContext()` → `runStages()`. Each stage receives `BenchContext`, returns updated context.

Enums, routing, constraints: `bench/src/enums.ts`. CLI args + help: `bench/src/args.ts`. Types: `bench/src/context.ts`.

Runs via `tsx` (dev) or bundled `artifacts/bench/bench.mjs` (CI/Docker). Shell wrappers: `bench.sh` / `bench.ps1`.

## Stage Progress

| Stage | Status | Description |
|-------|--------|-------------|
| `enumerate-commits` | ✅ done | Enumerate dotnet/runtime commits via GitHub API |
| `enumerate-daily-packs` | ✅ done | Catalog .NET 11 daily runtime packs from NuGet feed |
| `enumerate-release-packs` | ✅ done | Catalog .NET 8/9/10 GA release packs from release metadata |
| `docker-image` | ✅ done | Build Docker images (browser-bench-build, browser-bench-measure) |
| `build` | ✅ done | Build all app×preset, write build-manifest |
| `acquire-sdk` | ✅ done | SDK download via dotnet-install, runtime pack override, sdk-info.json |
| `measure` | stub | Run measurements for all app×preset×engine×profile combinations |
| `consolidate` | stub | Merge result JSONs into gh-pages data/ directory |
| `schedule` | stub | Detect untested runtime commits, dispatch benchmark workflows |
| `transform-views` | stub | Build pre-aggregated view files for dashboard |

Shared HTTP utilities: `bench/src/lib/http.ts` (fetchJson, headOk, GitHub auth, mapConcurrent).

Default stages (no `--stages`): `acquire-sdk,build,measure`

## Implementation Steps

1. ✅ Scaffold `bench/` project (package.json, tsconfig, rollup)
2. ✅ Implement enums + context + args
3. ✅ Implement exec.ts (cross-platform, Docker/WSL, .NET helpers)
4. ✅ Implement stage skeleton (registry, runner, log)
5. ✅ Shell wrappers (bench.sh, bench.ps1)
6. Port stages:
   - [x] `enumerate-commits` — GitHub REST API, token auth, incremental
   - [x] `enumerate-daily-packs` — NuGet flat API, SDK CDN, VMR resolution, incremental
   - [x] `enumerate-release-packs` — release metadata, VMR/pre-VMR detection, incremental
   - [x] `docker-image` — build both images, skip logic
   - [x] `build` — app×preset iteration, dotnet publish, workload install, build-manifest
   - [x] `acquire-sdk` — dotnet-install scripts, pack catalog lookup, runtime pack override
   - [ ] `measure` — browser + CLI measurement, result JSON writing
   - [ ] `consolidate` — merge results into gh-pages data/
   - [ ] `schedule` — gap detection, workflow dispatch
   - [ ] `transform-views` — view file generation for dashboard
   - [ ] Unit tests
7. Update Dockerfile — bundle `artifacts/bench/bench.mjs`
8. Update CI workflows — replace old script invocations with `bench --stages ...`

## TODO

- [ ] Implement `dotnet_managed_ready` timing marker for Blazor apps (`empty-blazor`, `blazing-pizza`) via a Blazor startup hook so that `time-to-reach-managed` and `time-to-reach-managed-cold` are available for all apps
