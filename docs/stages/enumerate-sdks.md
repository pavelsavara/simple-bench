# Stage: `enumerate-sdks`

Catalogs available .NET SDK versions from Microsoft's release metadata and daily build CDN, resolves runtime git hashes for each version, validates download URLs, and writes the result to `artifacts/sdk-list.json`.

## Pipeline Position

```
enumerate-sdks stage                     ← THIS
    ↓ artifacts/sdk-list.json
acquire-sdk stage
    ↓ reads sdk-list.json to pick the latest valid SDK for a channel
build stage → measure stage → consolidate
```

The `enumerate-sdks` stage runs independently — it is not part of the default `acquire-sdk,build,measure` pipeline. It is invoked explicitly via `--stages enumerate-sdks`.

The `acquire-sdk` stage consumes `sdk-list.json` at runtime: it uses `refreshSdkList()` (a lightweight probe of a single CDN endpoint) to append the newest daily build, then looks up the latest valid entry for the requested channel. The full enumeration performed by `enumerate-sdks` is a heavier batch operation that discovers all available versions over a configurable time window.

## Inputs

### BenchContext Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `major` | `number` | `11` | .NET major version to enumerate daily builds for |
| `months` | `number` | `3` | How many months of daily build history to scan |
| `forceEnumerate` | `boolean` | `false` | Re-resolve all versions (ignore cached hashes) |

### CLI Flags

```
bench --stages enumerate-sdks [--major 11] [--months 3] [--force-enumerate]
```

### Implicit Inputs

| Path | Description |
|------|-------------|
| `artifacts/sdk-list.json` | Existing catalog (if present) — used for incremental updates |
| Network access | Microsoft CDN, NuGet feeds, GitHub raw content |

## Outputs

### `artifacts/sdk-list.json`

The sole output artifact. Contains all discovered SDK versions with metadata and download URLs.

## Algorithm

The enumeration has two distinct paths depending on the SDK type:

### Path 1: Released SDKs (.NET 6–10)

Stable, shipped SDK versions from official Microsoft release metadata.

1. **Fetch releases index** from `https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json`
2. **For each release channel** (`6.0`, `7.0`, `8.0`, `9.0`, `10.0`):
   a. Look up the channel entry in the index to get the `releases.json` URL
   b. Fetch the per-channel `releases.json`
   c. Iterate all releases → collect all SDK versions
   d. **Group by band** (hundreds digit of patch: `100` → band 1, `200` → band 2, etc.)
   e. **Keep the latest version per band** (lexicographic comparison — version strings sort correctly due to consistent formatting)
   f. Emit one entry per band with: `sdkVersion`, `channel`, `band`, `type: 'release'`, `releaseDate`, `runtimeVersion`, download URL
3. **Result**: Typically 1–3 entries per channel (one per band), ~10–15 released entries total

### Path 2: Daily SDKs (.NET 11+)

Nightly CI builds published to the `ci.dot.net` CDN. These are not listed in any index — they must be **discovered by probing**.

1. **Generate date codes** for the last N months (from `ctx.months`):
   - Iterate every calendar day from `now - (months × 30 days)` to `now`
   - Encode each date as a SHORT_DATE using Formula A: `(year - 2000) × 1000 + month × 50 + day`
   - Example: 2026-03-04 → `26 × 1000 + 3 × 50 + 4` = `26154`

2. **Build probe matrix**: For each `(prerelease label, date code, revision)`:
   - Labels: `['alpha.1', 'preview.1', 'preview.2', 'preview.3', 'preview.4']`
   - Revisions: `101` through `125` (25 values)
   - Version template: `{major}.0.100-{label}.{dateCode}.{revision}`
   - Total probes: `~90 days × 5 labels × 25 revisions ≈ 11,250` candidates per run

3. **Probe CDN via HEAD requests** (30 concurrent workers, 8s timeout per request):
   - URL: `https://ci.dot.net/public/Sdk/{version}/dotnet-sdk-{version}-linux-x64.tar.gz`
   - HTTP 200 → version exists
   - Any other status or timeout → version does not exist
   - Progress: logs every 1000 probes

4. **Build entries** for each discovered version:
   - Decode build date from the SHORT_DATE segment (Formula A)
   - Derive runtime version: replace patch `100` with `0` (e.g. `11.0.100-preview.3.26154.119` → `11.0.0-preview.3.26154.119`)
   - Sort entries by version string ascending

### Post-Discovery: Runtime Git Hash Resolution

After both released and daily versions are collected, the stage resolves the `dotnet/runtime` git hash for each entry. The resolution path differs by SDK type:

#### For released SDKs (`type: 'release'`)

```
SDK runtimeVersion (e.g. "8.0.12")
    ↓ nuget.org nuspec
    ↓ https://api.nuget.org/v3-flatcontainer/microsoft.netcore.app.runtime.linux-x64/{version}/{pkg}.nuspec
    ↓ parse <repository commit="..."> attribute
    → runtimeGitHash (this is the dotnet/runtime commit)
```

The nuspec `<repository>` tag for released packages points **directly to the dotnet/runtime commit** (not the VMR).

#### For daily SDKs (`type: 'daily'`)

```
SDK runtimeVersion (e.g. "11.0.0-preview.3.26154.119")
    ↓ AzDO NuGet feed nuspec
    ↓ https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet{major}/nuget/v3/...
    ↓ parse <repository commit="..."> attribute
    → vmrCommit (this is the dotnet/dotnet VMR commit)
        ↓ GitHub raw content
        ↓ https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/src/source-manifest.json
        ↓ find repository where path == "runtime"
        → runtimeGitHash (dotnet/runtime commit extracted from VMR)
```

Daily builds' nuspec `<repository>` tag points to the **VMR (dotnet/dotnet) commit**, which requires a second hop through `source-manifest.json` to get the actual runtime repo commit.

**Concurrency**: 10 workers for hash resolution. Both the `runtimeHashCache` and `vmrManifestCache` prevent redundant fetches.

### Post-Resolution: URL Validation

After hash resolution, every entry's download URL is validated:

1. **HEAD request** (15s timeout, follow redirects)
2. If HEAD fails or is blocked: **GET with `Range: bytes=0-0`** fallback (some CDNs block HEAD)
3. HTTP 200–399 → `valid: true`; otherwise → `valid: false`
4. **Concurrency**: 10 workers

Invalid entries are logged but still included in the output (with `valid: false` and `httpStatus` recorded).

### Caching & Incremental Updates

The existing `enumerate-sdks.mjs` does **not** implement incremental updates — it always does a full scan. The TypeScript rewrite should add:

- **Skip hash resolution** for versions already present in `sdk-list.json` with a non-null `runtimeGitHash` (unless `ctx.forceEnumerate` is `true`)
- **Preserve existing entries** for channels/dates outside the current scan window
- **ETag-based caching** for the releases index (already used by `refreshSdkList()` in `resolve-sdk.mjs`)

The `acquire-sdk` stage already implements lightweight ETag caching on the `productCommit-linux-x64.txt` endpoint to append a single new version. The full enumeration stage should complement this by handling the batch discovery of historical versions.

## Feed & CDN URLs

### Release Metadata

| URL | Purpose |
|-----|---------|
| `https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json` | Master index of all .NET release channels |
| `{channel-releases-url}` (from index) | Per-channel release details with SDK + runtime versions |

### SDK Downloads

| SDK Type | URL Pattern |
|----------|-------------|
| Released | `https://dotnetcli.azureedge.net/dotnet/Sdk/{version}/dotnet-sdk-{version}-linux-x64.tar.gz` |
| Daily | `https://ci.dot.net/public/Sdk/{version}/dotnet-sdk-{version}-linux-x64.tar.gz` |

### NuGet Package Metadata (for hash resolution)

| Feed | URL | Used For |
|------|-----|----------|
| nuget.org | `https://api.nuget.org/v3-flatcontainer/microsoft.netcore.app.runtime.linux-x64/{ver}/{pkg}.nuspec` | Released SDK → runtime git hash |
| AzDO dotnet{N} | `https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet{major}/nuget/v3/index.json` | Daily SDK → VMR commit (via service index → flat container) |

### VMR Source Manifest

| URL | Purpose |
|-----|---------|
| `https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/src/source-manifest.json` | VMR commit → runtime + SDK repo commits |

### productCommit Endpoint (used by `acquire-sdk`, not by full enumeration)

| URL | Purpose |
|-----|---------|
| `https://aka.ms/dotnet/{channel}/daily/productCommit-linux-x64.txt` | Latest daily build metadata with ETag support |

## Output Format: `sdk-list.json`

```json
{
  "generated": "2026-03-05T10:00:00.000Z",
  "platform": "linux-x64",
  "totalVersions": 42,
  "validVersions": 40,
  "_etag": "\"0x8DE7A94AC0D8BDF\"",
  "_lastRefreshed": "2026-03-05T09:25:44.993Z",
  "versions": [
    {
      "sdkVersion": "8.0.404",
      "channel": "8.0",
      "band": "4xx",
      "type": "release",
      "releaseDate": "2024-11-12",
      "runtimeVersion": "8.0.11",
      "url": "https://dotnetcli.azureedge.net/dotnet/Sdk/8.0.404/dotnet-sdk-8.0.404-linux-x64.tar.gz",
      "runtimeGitHash": "abc123...",
      "httpStatus": 200,
      "valid": true
    },
    {
      "sdkVersion": "11.0.100-preview.3.26154.119",
      "channel": "11.0",
      "band": "1xx",
      "type": "daily",
      "buildDate": "2026-03-04",
      "runtimeVersion": "11.0.0-preview.3.26154.119",
      "url": "https://ci.dot.net/public/Sdk/11.0.100-preview.3.26154.119/dotnet-sdk-11.0.100-preview.3.26154.119-linux-x64.tar.gz",
      "runtimeGitHash": "e524be6928cdcd74bdbb79b389eeb31978b188ef",
      "httpStatus": 200,
      "valid": true
    }
  ]
}
```

### Entry Schema

| Field | Type | Present | Description |
|-------|------|---------|-------------|
| `sdkVersion` | `string` | Always | Full SDK version string |
| `channel` | `string` | Always | Release channel (e.g. `"8.0"`, `"11.0"`) |
| `band` | `string` | Always | SDK band (e.g. `"1xx"`, `"4xx"`) |
| `type` | `'release' \| 'daily'` | Always | Whether this is a shipped release or nightly build |
| `releaseDate` | `string` | Release only | ISO date of the official release (from releases.json) |
| `buildDate` | `string` | Daily only | ISO date decoded from SHORT_DATE in version string |
| `runtimeVersion` | `string` | Always | Corresponding runtime version (derived or from release metadata) |
| `url` | `string` | Always | Download URL for linux-x64 tar.gz |
| `runtimeGitHash` | `string \| null` | Always | dotnet/runtime commit hash (null if resolution failed) |
| `httpStatus` | `number` | Always | HTTP status from URL validation (0 if unreachable) |
| `valid` | `boolean` | Always | Whether the download URL returned 2xx/3xx |

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `generated` | `string` | ISO timestamp of when the file was generated |
| `platform` | `string` | Target platform (`"linux-x64"`) |
| `totalVersions` | `number` | Total entries in `versions` array |
| `validVersions` | `number` | Entries where `valid === true` |
| `_etag` | `string` | ETag from the productCommit endpoint (for `refreshSdkList()`) |
| `_lastRefreshed` | `string` | ISO timestamp of last lightweight refresh |

## SDK-to-Runtime Version Mapping

The SDK version and runtime pack version share a common suffix but differ in their patch segment:

```
SDK:     11.0.100-preview.3.26154.119     ← patch = 100 (band 1)
Runtime: 11.0.0-preview.3.26154.119       ← patch = 0
```

**Derivation**: Replace the patch number with `0`:

```typescript
function deriveRuntimeVersion(sdkVersion: string): string {
    return sdkVersion.replace(/^(\d+\.\d+\.)\d+/, (_, prefix) => prefix + '0');
}
```

This mapping is reliable for daily builds where SDK and runtime are built from the same VMR commit. For released SDKs, the runtime version comes directly from `releases.json` metadata and may not follow the same SHORT_DATE pattern (e.g. SDK `8.0.404` → runtime `8.0.11`).

### Band Extraction

The SDK band is the hundreds digit of the patch version:

```typescript
function getBand(sdkVersion: string): number {
    const m = sdkVersion.match(/^\d+\.\d+\.(\d)/);
    return m ? parseInt(m[1]) : -1;
}
```

| Patch | Band | Source-builds | Prebuilds |
|-------|------|---------------|-----------|
| `100` | `1xx` | All components | Nothing |
| `200` | `2xx` | SDK + tools only | Runtime, aspnetcore |
| `300` | `3xx` | SDK + tools only | Runtime, aspnetcore |
| `400` | `4xx` | SDK + tools only | Runtime, aspnetcore |

## SHORT_DATE Encoding

Two different formulas are used depending on context:

### Formula A: Month × 50 + Day (Arcade convention)

Used by: **daily SDKs** (.NET 11+), **runtime pack versions**

```
encode(year, month, day) = (year - 2000) × 1000 + month × 50 + day
decode(code):
    yy = floor(code / 1000)
    mm = floor((code % 1000) / 50)
    dd = (code % 1000) % 50
```

Example: `26154` → yy=26, mm=3, dd=4 → 2026-03-04

This is what `enumerate-sdks.mjs` uses for generating daily probe candidates and for decoding discovered versions via `decodeDateCode()`.

### Formula B: Day-of-year (older convention)

Used by: **released SDK versions** (.NET 6–10 stable)

```
encode(year, dayOfYear) = (year - 2000) × 1000 + dayOfYear
decode(code):
    yy = code[0:2]
    ddd = code[2:5]
    → year 20YY, day DDD of year
```

Example: `25130` → 2025, day 130 → 2025-05-10

This is what `sdk-info.mjs#parseBuildDate()` uses for parsing stable SDK versions.

The TypeScript rewrite should support both formulas, selecting the correct one based on `entry.type`.

## Error Handling

### CDN / Network Failures

| Scenario | Behavior |
|----------|----------|
| Releases index fetch fails | Entire released-SDK path skipped; daily path unaffected |
| Individual channel releases.json fails | That channel skipped; other channels continue |
| HEAD probe times out (8s) | Version treated as non-existent (expected for ~99% of probes) |
| URL validation fails | Entry marked `valid: false`, still included in output |
| AzDO feed service index unreachable | Hash resolution returns `null` for affected versions |
| GitHub raw content 404 | VMR manifest unavailable → `runtimeGitHash` set to `null` |
| nuget.org nuspec 404 | Released hash resolution fails → `runtimeGitHash` set to `null` |

### Data Quality

| Scenario | Behavior |
|----------|----------|
| Version string doesn't match expected pattern | `parseBuildDate()` returns `null`; entry still created with `buildDate: null` |
| Nuspec has no `<repository>` tag | `runtimeGitHash` remains `null` |
| VMR `source-manifest.json` missing `runtime` entry | `runtimeGitHash` remains `null` |
| Duplicate versions discovered | Deduplicated via `new Set()` on version strings |

### Timeouts

| Operation | Timeout |
|-----------|---------|
| JSON/text fetch (releases, nuspec, manifest) | 30s |
| HEAD probes (daily CDN) | 8s |
| URL validation HEAD | 15s |
| URL validation GET+Range fallback | 15s |

All requests use `AbortSignal.timeout()` for cancellation.

## Existing Code Reference

### `scripts/enumerate-sdks.mjs` — Key Patterns

The existing implementation is a standalone script (~400 lines) with these notable patterns:

1. **Concurrent worker pool** (`mapConcurrent`): Generic utility that dispatches items across N workers (configurable concurrency). Used for HEAD probing (30 workers), hash resolution (10 workers), and URL validation (10 workers).

2. **Three-level caching for hash resolution**:
   - `runtimeHashCache`: `Map<runtimeVersion, gitHash>` — avoids re-resolving the same runtime version
   - `vmrManifestCache`: `Map<vmrCommit, runtimeCommit>` — avoids re-fetching `source-manifest.json`
   - `azDoFlatBaseCache`: `Map<feedName, flatBaseUrl>` — avoids re-resolving NuGet service indexes

3. **Released SDKs**: Groups by band, keeps latest per band per channel. Uses `localeCompare` for version comparison (safe because version strings have consistent formatting).

4. **Daily probing**: Generates all candidate version strings upfront, then mass-probes via HEAD requests. The CDN (`ci.dot.net`) does not provide a listing endpoint, so brute-force probing is the only discovery mechanism.

5. **HEAD + Range fallback**: Some CDNs block HEAD requests. The validation step tries HEAD first, then falls back to `GET` with `Range: bytes=0-0` header.

6. **No incremental mode**: The current script always does a full scan. The `_etag` and `_lastRefreshed` fields in `sdk-list.json` are maintained by `resolve-sdk.mjs#refreshSdkList()`, not by the enumeration script.

### `scripts/lib/resolve-sdk.mjs` — Catalog Consumer

The `acquire-sdk` stage calls `refreshSdkList(channel)` before looking up an SDK version. This function:

1. Reads existing `sdk-list.json`
2. Fetches `https://aka.ms/dotnet/{channel}/daily/productCommit-linux-x64.txt` with `If-None-Match` (ETag)
3. On 304: no update needed (cheap round-trip)
4. On 200: parses `sdk_version`, `runtime_version`, `sdk_commit` from key-value pairs
5. Resolves `runtimeGitHash` from VMR `source-manifest.json`
6. Appends the new version to the `versions` array
7. Writes updated `sdk-list.json` with new `_etag`

This lightweight refresh is **complementary** to the full enumeration — it ensures the catalog has the latest daily build even if `enumerate-sdks` hasn't run recently.

### `scripts/lib/runtime-pack-resolver.mjs` — Shared Utilities

The `decodeBuildDate()` function (Formula A) is exported from this module and reused by `resolve-sdk.mjs` for daily builds. The TypeScript rewrite should consolidate date-coding utilities into a shared module.

### `scripts/lib/sdk-info.mjs` — Version Parsing

Provides `parseBuildDate()` (Formula B, day-of-year) for released SDK version strings. Also provides `parseCommitHash()` and `parseHostCommitHash()` for extracting hashes from `dotnet --info` output (used by `resolve-sdk.mjs` fallback path, not by enumeration).

## TypeScript Implementation Notes

### Current State

[bench/src/stages/enumerate-sdks.ts](../bench/src/stages/enumerate-sdks.ts) is a stub:

```typescript
export async function run(ctx: BenchContext): Promise<BenchContext> {
    console.log('[enumerate-sdks] not yet implemented');
    return ctx;
}
```

### Suggested Structure

```typescript
// bench/src/stages/enumerate-sdks.ts

export async function run(ctx: BenchContext): Promise<BenchContext> {
    const sdkListPath = join(ctx.artifactsDir, 'sdk-list.json');
    const existing = await loadExistingCatalog(sdkListPath);

    // Path 1: Released SDKs
    const released = await getReleasedSdks(RELEASE_CHANNELS);

    // Path 2: Daily SDKs
    const daily = await getDailyBuilds(ctx.major, ctx.months);

    // Merge, resolve hashes, validate URLs
    const all = [...released, ...daily];
    await resolveRuntimeHashes(all, { force: ctx.forceEnumerate, existing });
    await validateDownloadUrls(all);

    // Write output
    await writeSdkList(sdkListPath, all);
    return ctx;
}
```

### Key Types

```typescript
interface SdkListEntry {
    sdkVersion: string;
    channel: string;
    band: string;
    type: 'release' | 'daily';
    releaseDate?: string;     // release only
    buildDate?: string;       // daily only
    runtimeVersion: string;
    url: string;
    runtimeGitHash: string | null;
    httpStatus: number;
    valid: boolean;
}

interface SdkList {
    generated: string;
    platform: string;
    totalVersions: number;
    validVersions: number;
    _etag?: string;
    _lastRefreshed?: string;
    versions: SdkListEntry[];
}
```

### Constants to Extract

```typescript
const PLATFORM = 'linux-x64';
const CDN = 'https://dotnetcli.azureedge.net/dotnet';
const DAILY_CDN = 'https://ci.dot.net/public';
const BLOB = 'https://dotnetcli.blob.core.windows.net/dotnet';
const RELEASES_INDEX_URL = `${BLOB}/release-metadata/releases-index.json`;
const NUGET_FLAT = 'https://api.nuget.org/v3-flatcontainer';
const RUNTIME_PKG = 'microsoft.netcore.app.runtime.linux-x64';
const RELEASE_CHANNELS = ['6.0', '7.0', '8.0', '9.0', '10.0'];

const DAILY_LABELS = ['alpha.1', 'preview.1', 'preview.2', 'preview.3', 'preview.4'];
const DAILY_REVISION_RANGE = [101, 125];  // inclusive
const PROBE_CONCURRENCY = 30;
const HASH_CONCURRENCY = 10;
const VALIDATE_CONCURRENCY = 10;
const PROBE_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 30000;
const VALIDATE_TIMEOUT_MS = 15000;
```

### Shared Utilities to Reuse

The following should be extracted into `bench/src/lib/` shared modules:

- `mapConcurrent(items, fn, concurrency)` — generic concurrent worker pool
- `encodeDateCode(year, month, day)` / `decodeDateCode(code)` — Formula A (daily builds)
- `parseBuildDate(sdkVersion)` — Formula B (released SDKs)
- `deriveRuntimeVersion(sdkVersion)` — SDK → runtime version derivation
- `getBand(sdkVersion)` — extract band from SDK version
- `fetchJson(url)` / `fetchText(url)` — timeout-aware HTTP helpers
- `validateUrl(url)` — HEAD + Range fallback validation

## Relationship to Other Stages

| Stage | Relationship |
|-------|-------------|
| `acquire-sdk` | **Consumer**: reads `sdk-list.json` to find the SDK version to install. Also has its own lightweight `refreshSdkList()` for single-version updates. |
| `enumerate-packs` | **Sibling**: similar enumeration job for runtime packs (writes `runtime-packs.json`). The `acquire-sdk` stage cross-references both catalogs. |
| `schedule` | **Consumer**: uses `runtime-packs.json` (not `sdk-list.json` directly) to find untested commits. However, `sdk-list.json` entries with `runtimeGitHash` provide an alternative source of commit-to-version mappings. |

## Planned Enhancements (from `docs/ci.md`)

### Storage Branch Persistence

Currently `sdk-list.json` only exists locally — CI runs start with an empty catalog. The planned `storage` branch will persist `sdk-list.json` across CI runs:

1. Build job fetches `sdk-list.json` from `storage` branch (warm cache)
2. After `acquire-sdk` resolves a new version, push updated file back to `storage`
3. Eliminates cold-start overhead where every CI run must re-enumerate

### Interaction with `refreshSdkList()`

The full enumeration and the lightweight refresh serve different purposes:

| Aspect | `enumerate-sdks` stage | `refreshSdkList()` in `acquire-sdk` |
|--------|----------------------|--------------------------------------|
| Scope | All channels, all dates in window | Single channel, latest build only |
| Method | Brute-force HEAD probing | ETag-based productCommit endpoint |
| Concurrency | 30 workers for probing | Single request |
| Duration | Minutes (thousands of probes) | Milliseconds (one HTTP round-trip) |
| When | Explicit `--stages enumerate-sdks` | Automatically before every SDK install |
| Coverage | Historical + current | Current only |
