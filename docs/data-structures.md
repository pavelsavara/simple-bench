# JSON Data Structures

All JSON schemas used throughout the pipeline. Types are defined in TypeScript source; this document summarizes each structure and links to the source of truth.

---

## SdkInfo

Resolved identity of a .NET SDK build. Produced by enumerate stages, consumed everywhere.

**Fields**: sdkVersion, runtimeGitHash, aspnetCoreGitHash, sdkGitHash, vmrGitHash, runtimeCommitDateTime, aspnetCoreCommitDateTime, aspnetCoreVersion, runtimePackVersion, workloadVersion.

Defined in [`bench/src/context.ts`](../bench/src/context.ts#L7).

---

## DailyPacksList (`daily-packs-list.json`)

Nightly runtime packs discovered from the Azure DevOps NuGet feed. Each pack extends `SdkInfo` with a `bootstrapSdkVersion` field.

**Fields**: feed, major, months (lookback window), fetchedAt, totalPacks, packs (array of `SdkInfo & { bootstrapSdkVersion }`). Sorted newest-first by Arcade SHORT_DATE.

Defined in [`bench/src/stages/enumerate-daily-packs.ts`](../bench/src/stages/enumerate-daily-packs.ts#L17).

---

## ReleasePacksList (`release-packs-list.json`)

GA release packs discovered from the official .NET releases index. Each pack extends `SdkInfo` with `bootstrapSdkVersion` and `releaseDate`.

**Fields**: channels, fetchedAt, totalPacks, packs (array of `SdkInfo & { bootstrapSdkVersion, releaseDate }`). Sorted by major descending, then release date descending.

Defined in [`bench/src/stages/enumerate-release-packs.ts`](../bench/src/stages/enumerate-release-packs.ts#L18).

---

## CommitsList (`commits-list.json`)

Recent dotnet/runtime commit history from the GitHub API.

**Fields**: repo, since, until, fetchedAt, totalCommits, commits (array with sha, message, authorDate, committerDate, author, url).

Defined in [`bench/src/stages/enumerate-commits.ts`](../bench/src/stages/enumerate-commits.ts#L19).

---

## BuildManifestEntry (`build-manifest.json`)

Produced by the `build` stage, consumed by `measure`. One entry per app×preset built.

**Fields**: app, preset, runtime, compileTimeMs, integrity (fileCount + totalBytes), publishDir. Wrapped in `{ runId, entries[] }`.

Defined in [`bench/src/context.ts`](../bench/src/context.ts#L22).

---

## Result File (individual measurement)

Written to `artifacts/results/{runId}/` and copied to `gh-pages/data/{YYYY}/{YYYY-MM-DD}/`.

**Filename**: `{runtimeCommitDateTime}_{hash:7}_{runtime}_{preset}_{profile}_{engine}_{app}.json`

**Structure**: `{ meta, metrics }` where `meta` contains SDK identity + dimension values (runtime, preset, profile, engine, app, benchmarkDateTime, warmRunCount) and `metrics` contains measured values keyed by `MetricKey`.

Built by [`buildResultJson()`](../bench/src/lib/measure-utils.ts#L174) and [`buildResultFilename()`](../bench/src/lib/measure-utils.ts#L208). Metric keys defined in [`bench/src/enums.ts`](../bench/src/enums.ts#L62).

---

## MonthIndex (`data/{YYYY-MM}.json`)

Groups all measurement results for one calendar month. Each commit entry contains SDK identity fields plus a `results[]` array of per-measurement summaries (dimension values + file path + inline metrics).

Defined in [`bench/src/stages/transform-views.ts`](../bench/src/stages/transform-views.ts#L29) and [`bench/src/stages/schedule.ts`](../bench/src/stages/schedule.ts#L16).

---

## DataIndex (`data/index.json`)

Master index: `{ lastUpdated, months[] }` listing all month files with data.

Defined in [`bench/src/stages/schedule.ts`](../bench/src/stages/schedule.ts#L25).

---

## ViewIndex (`data/views/index.json`)

Describes all available views and their dimensions: `{ lastUpdated, activeRelease, releases[], weeks[], apps[], metrics (per-app metric lists), dimensions (runtimes, presets, profiles, engines) }`.

Built by the `transform-views` stage in [`bench/src/stages/transform-views.ts`](../bench/src/stages/transform-views.ts).

---

## ViewHeader (`data/views/{bucket}/header.json`)

Column definitions for a specific view (week or release): `{ columns[] (each with runtimeGitHash, runtimeCommitDateTime, sdkVersion), apps (per-app metric lists), week|release }`.

Built by the `transform-views` stage in [`bench/src/stages/transform-views.ts`](../bench/src/stages/transform-views.ts).

---

## ViewData (`data/views/{bucket}/{app}_{metric}.json`)

Pivot data. Keys are dimension combinations (`{runtime}/{preset}/{profile}/{engine}`), values are arrays aligned 1:1 with `header.json` columns. `null` entries indicate missing data.

Built by the `transform-views` stage in [`bench/src/stages/transform-views.ts`](../bench/src/stages/transform-views.ts).
