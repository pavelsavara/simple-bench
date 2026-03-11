# Stage: `enumerate-packs`

Catalog runtime pack versions from Azure Artifacts NuGet feeds and resolve their git commit hashes.

## Purpose

The benchmark system's X-axis is **runtime commit date** — each data point corresponds to a specific `dotnet/runtime` build. To benchmark a particular runtime commit, the system needs a pre-built **runtime pack** (`Microsoft.NETCore.App.Runtime.Mono.browser-wasm`) matching that commit.

The `enumerate-packs` stage maintains `artifacts/runtime-packs.json` — a catalog of all available runtime pack versions with their resolved VMR, runtime, and SDK commit hashes. This catalog is consumed by:

- **`schedule` stage**: to detect untested runtime commits and dispatch benchmark workflows
- **Phase 0 of the build pipeline**: to look up a runtime pack version by `--runtime-commit` hash
- **`acquire-sdk` stage**: to determine which SDK version was used to build a given runtime pack (via `sdkVersionOfTheRuntimeBuild`)

Without this catalog, the system cannot map between runtime commit hashes and downloadable NuGet packages.

## Inputs

### BenchContext Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `major` | `number` | `11` | .NET major version — selects which AzDO NuGet feed to query |
| `months` | `number` | `3` | Sliding window — only process versions built within the last N months |
| `forceEnumerate` | `boolean` | `false` | When `true`, discard cached resolutions and re-resolve all versions |

### CLI Flags

```
bench --stages enumerate-packs [--major 11] [--months 3] [--force-enumerate]
```

### Existing Artifact (Incremental Input)

- `artifacts/runtime-packs.json` — if it exists and `forceEnumerate` is false, already-resolved versions are skipped

## Output

### File: `artifacts/runtime-packs.json`

A JSON catalog of all runtime pack versions within the date window, with resolved git hashes.

#### Top-Level Schema

```json
{
  "generated": "2026-03-05T09:25:44.004Z",
  "feed": "dotnet11",
  "packageId": "microsoft.netcore.app.runtime.mono.browser-wasm",
  "totalVersions": 137,
  "resolvedVersions": 137,
  "versions": [ ... ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `generated` | `string` (ISO 8601) | Timestamp when the file was written |
| `feed` | `string` | NuGet feed name, e.g. `"dotnet11"` |
| `packageId` | `string` | Always `"microsoft.netcore.app.runtime.mono.browser-wasm"` |
| `totalVersions` | `number` | Count of version entries in the `versions` array |
| `resolvedVersions` | `number` | Count of entries where `runtimeGitHash` is non-null |
| `versions` | `array` | Version entries, ordered ascending by version string |

#### Version Entry Schema

```json
{
  "runtimePackVersion": "11.0.0-preview.3.26154.119",
  "buildDate": "2026-03-04",
  "vmrCommit": "dc803dea8a5917a87a812a05bae596c299368a43",
  "runtimeGitHash": "bce6119e41ecfbcf630c369836770669604c22c6",
  "sdkGitHash": "6a6992f5fc42dbd06cd24f3a7db40013035d3965",
  "sdkVersionOfTheRuntimeBuild": "10.0.100-rc.2.25502.107",
  "nupkgUrl": "https://pkgs.dev.azure.com/dnceng/.../microsoft.netcore.app.runtime.mono.browser-wasm.11.0.0-preview.3.26154.119.nupkg"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `runtimePackVersion` | `string` | NuGet package version (e.g. `11.0.0-alpha.1.25605.110`) |
| `buildDate` | `string` | Decoded build date `YYYY-MM-DD` from the version's SHORT_DATE segment |
| `vmrCommit` | `string \| null` | `dotnet/dotnet` VMR commit — extracted from the nuspec `<repository commit="..."/>` |
| `runtimeGitHash` | `string \| null` | `dotnet/runtime` commit — resolved from VMR `source-manifest.json` |
| `sdkGitHash` | `string \| null` | `dotnet/sdk` commit — resolved from VMR `source-manifest.json` |
| `sdkVersionOfTheRuntimeBuild` | `string \| null` | SDK version from `dotnet/runtime`'s `global.json` at `runtimeGitHash` — used to install a compatible SDK for building with this runtime pack |
| `nupkgUrl` | `string` | Direct download URL for the `.nupkg` file on the flat container |

**Null fields** indicate resolution failure — the nuspec was unavailable, GitHub raw content API returned an error, or the `global.json` didn't contain a `tools.dotnet` entry.

## Algorithm

### Step 1: Compute Date Cutoff

```
cutoff = today - months
cutoffDate = cutoff formatted as YYYY-MM-DD
```

Only versions whose decoded `buildDate` is ≥ `cutoffDate` are processed. This keeps the catalog focused on recent builds while allowing the window to be widened via `--months`.

### Step 2: Load Existing Catalog (Incremental)

If `forceEnumerate` is `false` and `artifacts/runtime-packs.json` exists:
- Parse the file and build a `Map<runtimePackVersion, entry>` of already-resolved versions
- These are reused without re-querying NuGet or GitHub

If `forceEnumerate` is `true`:
- Start with an empty map — all versions will be freshly resolved

### Step 3: Query NuGet Feed for Available Versions

1. **Resolve flat container URL**: Fetch the NuGet V3 service index → find the `PackageBaseAddress/3.0.0` resource → extract its `@id` URL
2. **List all versions**: GET `{flatBaseUrl}{packageId}/index.json` → the `versions` array contains every published version of the package
3. **Filter by major**: Keep only versions starting with `{major}.` (e.g. `11.`)
4. **Filter by date window**: For each version, decode the SHORT_DATE and keep only those with `buildDate >= cutoffDate`

### Step 4: Identify New Versions

```
newVersions = versions.filter(v => !existing.has(v))
```

Only versions not already in the cache are processed. In force mode, all versions are "new".

### Step 5: Resolve Commit Hashes (Concurrent)

For each new version, run the following resolution chain with bounded concurrency (5 workers):

#### 5a. Decode Build Date

Parse the SHORT_DATE segment from the version string using **Formula A** (Arcade month×50+day encoding):

```
version: 11.0.0-preview.3.26154.119
parts:   [11, 0, 0-preview, 3, 26154, 119]
SHORT_DATE = 26154

yy  = floor(26154 / 1000)      = 26
rem = 26154 % 1000              = 154
mm  = floor(154 / 50)           = 3
dd  = 154 % 50                  = 4

buildDate = "2026-03-04"
```

#### 5b. Get VMR Commit from Nuspec

```
GET {flatBaseUrl}{packageId}/{version}/{packageId}.nuspec
```

The nuspec XML contains a `<repository>` element:
```xml
<repository type="git" url="https://github.com/dotnet/dotnet" commit="dc803dea..." />
```

Extract the `commit` attribute via regex: `/repository[^>]*commit=["']([a-f0-9]{7,40})/`

**Failure**: If the nuspec fetch fails or the regex doesn't match → `vmrCommit = null` → remaining fields also null.

#### 5c. Get Runtime + SDK Commits from VMR

```
GET https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/src/source-manifest.json
```

Parse the `repositories` array and find:
- Entry with `path === "runtime"` (or `"src/runtime"`) → `runtimeGitHash = commitSha`
- Entry with `path === "sdk"` (or `"src/sdk"`) → `sdkGitHash = commitSha`

**Failure**: If GitHub returns 404 or the manifest doesn't contain the expected entries → null.

#### 5d. Get SDK Version from Runtime Commit

```
GET https://raw.githubusercontent.com/dotnet/runtime/{runtimeGitHash}/global.json
```

Extract `tools.dotnet` → this is the SDK version that was used to build this runtime commit. The `schedule` stage and Phase 0 use this to install a compatible SDK when benchmarking via `--runtime-commit`.

**Failure**: If `global.json` doesn't exist or lacks `tools.dotnet` → null.

#### 5e. Build nupkg URL

```
nupkgUrl = {flatBaseUrl}{packageId}/{version}/{packageId}.{version}.nupkg
```

This URL can be used for direct download without authentication (public feed).

### Step 6: Merge and Write Output

- Combine cached entries with newly resolved entries
- Sort by version ascending
- Compute `totalVersions` and `resolvedVersions` counts
- Write `artifacts/runtime-packs.json` with `generated` timestamp

The file is always rewritten even when nothing new was resolved (to update the `generated` timestamp).

## NuGet Feed URLs

The package `microsoft.netcore.app.runtime.mono.browser-wasm` is published to Azure DevOps public NuGet feeds (no authentication required):

| Major | Feed Name | Service Index URL |
|-------|-----------|-------------------|
| 11 | `dotnet11` | `https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11/nuget/v3/index.json` |
| 10 | `dotnet10` | `https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet10/nuget/v3/index.json` |

### Feed Protocol: NuGet V3 Flat Container

The enumeration uses the **NuGet V3 flat container** protocol (also known as PackageBaseAddress), not the search or registration APIs. This is efficient for listing all versions and fetching individual nuspec files.

**Discovery flow:**
1. Fetch the service index (the feed URL above) → JSON with `resources` array
2. Find the resource with `@type === "PackageBaseAddress/3.0.0"` → its `@id` is the flat container base URL
3. Use the flat container for all subsequent operations:
   - Version listing: `GET {baseUrl}{packageId}/index.json`
   - Nuspec: `GET {baseUrl}{packageId}/{version}/{packageId}.nuspec`
   - Package: `GET {baseUrl}{packageId}/{version}/{packageId}.{version}.nupkg`

The flat container URLs use the GUID-based Azure Artifacts internal paths (e.g. `https://pkgs.dev.azure.com/dnceng/9ee6d478-.../_packaging/2303eb2b-.../nuget/v3/flat2/`), which are stable and publicly accessible.

These same feeds are declared in the repository's `NuGet.config` for `dotnet restore` operations.

## Caching Strategy

### Incremental Resolution (Default)

The primary caching mechanism is **version-level deduplication**:
- On startup, load `artifacts/runtime-packs.json` into a `Map<version, entry>`
- Only versions not present in the map are resolved
- Resolution involves 3–4 HTTP requests per version (nuspec + source-manifest.json + global.json + optional fallback)
- With 5 concurrent workers processing ~90 days of daily builds, a typical incremental run resolves 1–5 new versions in seconds

This means the stage is idempotent and cheap to re-run.

### Force Refresh (`--force-enumerate`)

When `forceEnumerate` is `true`:
- The existing map is discarded
- All versions within the date window are re-resolved from scratch
- Use this when GitHub's raw content API has been updated (e.g. VMR commits amended) or to repair corrupted entries

### Quick Refresh (`refreshRuntimePacks`)

The `runtime-pack-resolver.mjs` library also exports a lightweight `refreshRuntimePacks()` function used by the `schedule` stage:
- Checks only if the **newest feed version** is already in the cache
- If yes → no work done (the catalog is up to date)
- If no → resolves only the missing versions (prepends to the array)
- Updates the `_lastRefreshed` timestamp

This is cheaper than the full enumeration because it skips date filtering and only resolves truly new packages.

### No HTTP-Level Caching

The current implementation does not use ETags, If-Modified-Since, or local HTTP caches. Each nuspec/manifest fetch is a fresh GET. The GitHub raw content API is rate-limited to 60 req/min for unauthenticated users, which is why concurrency is capped at 5 workers.

## Error Handling

### Feed Unavailable

If the NuGet service index or flat container URL fails to respond:
- `listAvailablePackVersions()` throws → the stage fails with a descriptive error
- In `refreshRuntimePacks()` (lightweight mode): caught and logged, returns without updating the catalog

### Individual Version Resolution Failures

Per-version errors are **non-fatal**:
- If the nuspec cannot be fetched → the entry is stored with all commit fields as `null`
- If `source-manifest.json` is not found on GitHub → `runtimeGitHash` and `sdkGitHash` are `null`
- If `global.json` is unavailable → `sdkVersionOfTheRuntimeBuild` is `null`
- The entry is still written to the catalog (with a valid `runtimePackVersion`, `buildDate`, and `nupkgUrl`)

This means partial data is preserved — a version with `vmrCommit` but no `runtimeGitHash` can still be identified and potentially re-resolved on a future `--force-enumerate` run.

### GitHub Rate Limiting

GitHub's raw content CDN (`raw.githubusercontent.com`) has a rate limit of ~60 requests per minute for unauthenticated access. With 5 concurrent workers each making 2–3 GitHub requests per version, resolving 90 versions sequentially would take ~5 minutes. The bounded concurrency (5 workers) naturally throttles to stay under the limit.

If rate-limited (HTTP 429), the current implementation treats it as a fetch failure → the affected version gets null commit hashes and can be retried later.

### Timeout

No explicit per-request timeout is configured in the current `fetch()` calls. The Node.js default applies. For the TypeScript rewrite, consider adding a configurable timeout (e.g. 15s per HTTP request) to prevent indefinite hangs on network issues.

## Existing Code Reference

### Entry Point: `scripts/enumerate-runtime-packs.mjs`

The main orchestration script:
- Parses `--major`, `--months`, `--force` CLI args
- Computes the date cutoff from `months`
- Loads existing catalog for incremental mode
- Calls `listAvailablePackVersions(major)` to get all feed versions
- Filters by date window and deduplicates against cache
- Runs `mapConcurrent()` with 5 workers to resolve new versions
- Writes output via `writeOutput()`

### Library: `scripts/lib/runtime-pack-resolver.mjs`

The resolution logic, exposing:

| Export | Purpose |
|--------|---------|
| `PACKAGE_ID` | Constant: `"microsoft.netcore.app.runtime.mono.browser-wasm"` |
| `getFlatBaseUrl(major)` | Discover flat container URL from the feed service index |
| `listAvailablePackVersions(major)` | List + filter versions from the feed |
| `decodeBuildDate(version)` | SHORT_DATE → `YYYY-MM-DD` using Formula A |
| `getVmrCommitFromNuspec(flatBaseUrl, version)` | Fetch nuspec XML → extract `repository/@commit` |
| `getRepoCommitsFromVMR(vmrCommit)` | Fetch `source-manifest.json` → extract runtime + SDK commits |
| `getSdkVersionFromRuntimeCommit(runtimeGitHash)` | Fetch `global.json` → extract `tools.dotnet` |
| `getPackCommitInfo(flatBaseUrl, version)` | All-in-one: combines 5b–5d into a single call |
| `restoreRuntimePack(dotnetPath, version, nugetPackagesDir)` | `dotnet restore` to download a specific pack (used by build phase, not enumeration) |
| `refreshRuntimePacks({ major, artifactsDir })` | Lightweight incremental refresh (used by schedule stage) |
| `deriveSdkVersion(packVersion, band)` | Convert runtime pack version → SDK version string |

### Current TypeScript Stub: `bench/src/stages/enumerate-packs.ts`

```typescript
import { type BenchContext } from '../context.js';

export async function run(ctx: BenchContext): Promise<BenchContext> {
    // TODO: list runtime packs from NuGet feeds
    console.log('[enumerate-packs] not yet implemented');
    return ctx;
}
```

The implementation should follow the same `run(ctx) → ctx` signature, reading enumeration parameters from `ctx.major`, `ctx.months`, and `ctx.forceEnumerate`, and writing to `{ctx.artifactsDir}/runtime-packs.json`.

## Implementation Notes for TypeScript Rewrite

### Concurrency Utility

The existing `mapConcurrent()` helper (bounded worker pool) should be extracted to a shared utility in `bench/src/utils/` since other stages (e.g. `enumerate-sdks`) also need bounded concurrency.

### Type Definitions

```typescript
interface RuntimePackEntry {
    runtimePackVersion: string;
    buildDate: string;
    vmrCommit: string | null;
    runtimeGitHash: string | null;
    sdkGitHash: string | null;
    sdkVersionOfTheRuntimeBuild: string | null;
    nupkgUrl: string;
}

interface RuntimePacksCatalog {
    generated: string;
    feed: string;
    packageId: string;
    totalVersions: number;
    resolvedVersions: number;
    versions: RuntimePackEntry[];
}
```

### Context Flow

The stage is stateless with respect to `BenchContext` — it reads configuration from `ctx` but does not mutate it beyond I/O to the artifacts directory. It returns `ctx` unchanged:

```
ctx.major         → determines which NuGet feed to query
ctx.months        → determines the date window
ctx.forceEnumerate → determines whether to skip the cache
ctx.artifactsDir  → determines where to write runtime-packs.json
```

### Progress Reporting

The existing script writes progress to stdout every 10 resolved versions. The TypeScript version should use the same pattern or integrate with a `ctx.verbose` check:
- Always log: total versions on feed, versions within window, new vs cached count
- With `--verbose`: per-version resolution status
- On completion: summary of resolved vs failed

### Relationship to Other Stages

```
enumerate-packs ──writes──→ artifacts/runtime-packs.json
                                      │
         ┌────────────────────────────┘
         │
         ├──read by──→ schedule (gap detection → dispatch benchmark workflows)
         ├──read by──→ build Phase 0 (--runtime-commit → resolve pack version)
         └──read by──→ refreshRuntimePacks() (lightweight top-up by schedule)
```

The `enumerate-packs` stage can run independently of all other stages — it only needs network access to Azure Artifacts and GitHub.
