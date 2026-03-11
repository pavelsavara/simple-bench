# SDK Version Resolution, Git Hashes & Runtime Packs

## Why We Track All This

The benchmark's X-axis is **runtime commit date** — each data point represents a specific build of the .NET runtime. To place results on the timeline and avoid re-benchmarking, we need to resolve the chain: **SDK version → VMR commit → runtime commit → build date**.

The build date is embedded in version strings as a SHORT_DATE code, but there are **two different encodings** (see below). We also need git hashes to deduplicate results and link them to source.

## Version String Anatomy

### SDK version

```
11.0.100-preview.3.26154.119
│   │ │          │ │     │
│   │ │          │ │     └── revision
│   │ │          │ └──────── SHORT_DATE (build date encoded)
│   │ │          └────────── preview label
│   │ └──────────────────── band (1xx = band 1)
│   └────────────────────── minor
└─────────────────────────── major
```

**Band**: hundreds digit of patch — `100` = band 1, `200` = band 2, `300` = band 3.

| Band | Source-builds | Prebuilds |
|------|-------------|-----------|
| 1xx | All: runtime, SDK, aspnetcore, roslyn, etc. | Nothing |
| 2xx/3xx | SDK, tools only | Runtime, aspnetcore (from 1xx) |

### Runtime pack version

```
11.0.0-preview.3.26153.109
│   │ │         │ │     │
│   │ │         │ │     └── revision
│   │ │         │ └──────── SHORT_DATE (build date encoded)
│   │ │         └────────── preview label
│   │ └──────────────────── patch (always 0 for preview)
│   └────────────────────── minor
└─────────────────────────── major
```

### Deriving one from the other

SDK → runtime: replace patch with `0` — `11.0.100-preview.3.X.Y` → `11.0.0-preview.3.X.Y`  
Runtime → SDK: replace `0` with `{band}00` — `11.0.0-...` → `11.0.100-...` (band 1)

## SHORT_DATE Encoding — Two Formulas

### Formula A: Month+Day encoding (Arcade convention)

Used by: **runtime packs**, **daily SDK versions** (recent .NET)

```
encode(year, month, day) = (year - 2000) × 1000 + month × 50 + day
decode(code):
  yy  = floor(code / 1000)           → 26
  rem = code % 1000                   → 154
  mm  = floor(rem / 50)              → 3
  dd  = rem % 50                     → 4
  → 2026-03-04
```

Example: `26154` → 2026-03-04

### Formula B: Day-of-year encoding (older SDKs)

Used by: **released SDK versions** (.NET 6–10 stable)

```
encode(year, dayOfYear) = (year - 2000) × 1000 + dayOfYear
decode(code):
  yy  = first 2 digits               → 25
  ddd = last 3 digits                → 130
  → 2025, day 130 of year = May 10
```

Example: `25130` → 2025-05-10

**Why two formulas?** The Arcade build system switched from day-of-year to month×50+day. The codebase handles both: `sdk-info.mjs` uses Formula B for released versions, `runtime-pack-resolver.mjs` uses Formula A for daily packs. Both are called "SHORT_DATE" in .NET infrastructure.

## Git Hash Chain

```
SDK Version (or channel)
   ↓ resolve-sdk.mjs
   ├── sdkVersion
   ├── vmrGitHash (dotnet/dotnet commit)
   │      ↓ src/source-manifest.json at that VMR commit
   │      ├── runtimeGitHash (dotnet/runtime commit)
   │      └── sdkGitHash (dotnet/sdk commit)
   └── runtimeCommitDateTime (from SHORT_DATE)

Runtime Pack Version
   ↓ enumerate-runtime-packs.mjs
   ├── runtimePackVersion
   ├── vmrCommit (from NuGet nuspec repository/@commit)
   │      ↓ source-manifest.json
   │      ├── runtimeGitHash
   │      └── sdkGitHash
   └── sdkVersionOfTheRuntimeBuild (from dotnet/runtime global.json)
```

## SDK Resolution (resolve-sdk.mjs)

### Catalog refresh

Probes `https://aka.ms/dotnet/{channel}/daily/productCommit-linux-x64.txt` — key-value pairs: `sdk_version`, `runtime_version`, `sdk_commit`, `runtime_commit`. Uses ETag/304 for caching.

### Lookup strategies

- **By channel**: latest valid SDK in `artifacts/sdk-list.json` for channel, sorted descending
- **By version**: exact match in catalog

### Install

Downloads via `dotnet-install.ps1` (Windows) or `dotnet-install.sh` (*nix) with exact version. Installs to `artifacts/sdks/{os}.sdk{version_or_channel}/`.

### Hash resolution priority

1. Catalog match (sdk-list.json has version with pre-resolved hashes) → use directly
2. VMR `source-manifest.json` at catalog's vmrGitHash → parse `runtime` and `sdk` entries
3. Fallback: `dotnet --info` → regex `Commit:\s+([a-f0-9]+)` (first = SDK, second = host/runtime)

### Output

`artifacts/sdks/{dir}/sdk-info.json`:
```json
{
  "sdkVersion": "11.0.100-preview.3.26154.119",
  "runtimeGitHash": "e524be69...",
  "sdkGitHash": "d65136bf...",
  "vmrGitHash": "dc803dea...",
  "runtimeCommitDateTime": "2026-03-04T09-25-44",
  "runtimePackVersion": "11.0.0-alpha.1.25605.110",  // if --runtime-pack
  "workloadVersion": "9.0.0-preview.1.24080.9"        // after Phase 4
}
```

## Runtime Pack Resolution (enumerate-runtime-packs.mjs)

### Source feed

`Microsoft.NETCore.App.Runtime.Mono.browser-wasm` from AzDO:
- `dotnet11`: `https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11/nuget/v3/index.json`
- `dotnet10`: similarly for other majors

### Resolution per version

1. Decode build date from SHORT_DATE (Formula A)
2. Fetch nuspec from NuGet flat container → extract VMR commit from `repository/@commit`
3. Fetch VMR `source-manifest.json` → extract `runtimeGitHash`, `sdkGitHash`
4. Fetch `dotnet/runtime` `global.json` at `runtimeGitHash` → extract `tools.dotnet` as `sdkVersionOfTheRuntimeBuild`

**Concurrency**: 5 workers (GitHub rate limit). Incremental: skips versions already in catalog.

### Output

`artifacts/runtime-packs.json`:
```json
{
  "feed": "dotnet11",
  "packageId": "microsoft.netcore.app.runtime.mono.browser-wasm",
  "versions": [
    {
      "runtimePackVersion": "11.0.0-alpha.1.25614.102",
      "buildDate": "2025-12-14",
      "vmrCommit": "dc803dea...",
      "runtimeGitHash": "bce6119e...",
      "sdkGitHash": "6a6992f5...",
      "sdkVersionOfTheRuntimeBuild": "10.0.100-rc.2.25502.107",
      "nupkgUrl": "https://pkgs.dev.azure.com/..."
    }
  ]
}
```

## SDK Enumeration (enumerate-sdks.mjs)

### Released SDKs (.NET 6–10)

Fetches `releases-index.json` → per-channel `releases.json`. Groups by band, keeps latest per band. Gets runtime hash from nuget.org nuspec.

### Daily SDKs (.NET 11+)

Generates date codes for last 3 months. Probes ~6750 candidate URLs (`https://ci.dot.net/public/Sdk/{version}/`) via HEAD requests (30 workers, 8s timeout, GET+Range fallback for CDNs blocking HEAD). Validates existence, resolves runtime hash from AzDO NuGet feeds.

### Output

`artifacts/sdk-list.json`:
```json
{
  "versions": [
    {
      "sdkVersion": "11.0.100-preview.3.26154.119",
      "channel": "11.0",
      "band": "1xx",
      "type": "daily",
      "buildDate": "2026-03-04",
      "runtimeVersion": "11.0.0-preview.3.26154.119",
      "url": "https://ci.dot.net/public/Sdk/...",
      "runtimeGitHash": "e524be69...",
      "httpStatus": 200,
      "valid": true
    }
  ],
  "_etag": "...",
  "_lastRefreshed": "2026-03-05T09:25:44Z"
}
```

## NuGet Feeds

All public, no authentication needed.

| Feed | URL | Purpose |
|------|-----|---------|
| nuget.org | `https://api.nuget.org/v3/index.json` | Released packages |
| dotnet-public | `https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-public/nuget/v3/index.json` | Public previews |
| dotnet10 | `.../dotnet10/nuget/v3/index.json` | .NET 10 dailies |
| dotnet11 | `.../dotnet11/nuget/v3/index.json` | .NET 11 dailies |

Configured in `NuGet.config` at repo root.

## Runtime Pack Override in Builds

When `--runtime-pack` is used:
1. Pipeline restores the NuGet package via `src/restore/restore-runtime-pack.proj`
2. Sets `RUNTIME_PACK_DIR` env → build-app.mjs passes `/p:RuntimePackDir={dir}`
3. `Directory.Build.targets` target `UpdateRuntimePack` (AfterTargets="ResolveFrameworkReferences") overrides `ResolvedRuntimePack` item with the custom directory
4. This allows benchmarking a specific runtime build against a different SDK version

## Error Handling & Fallbacks

| Step | Failure | Behavior |
|------|---------|----------|
| Catalog refresh | Network error | Use existing catalog, log warning |
| SDK lookup by version | Not found | Throw (pipeline stops) |
| SDK install | Script fails | Throw (pipeline stops) |
| Hash from VMR manifest | Network/parse error | Fall back to `dotnet --info` |
| Build date parse | Invalid code | Use current date, log warning |
| Runtime pack lookup by commit | Not in catalog | Throw (user must enumerate first) |
| Nuspec VMR commit extraction | Not found in nuspec | Mark version with null hashes, skip further resolution |
| Individual version in enumeration | Any network error | Log, continue with nulls, mark incomplete |
