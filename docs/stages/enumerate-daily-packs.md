# Stage: `enumerate-daily-packs`

Implementation: `bench/src/stages/enumerate-daily-packs.ts`

## Purpose

Enumerates all `Microsoft.NETCore.App.Runtime.Mono.browser-wasm` packages published to the dotnet daily NuGet feed within a configurable time window, and resolves full `SdkInfo` metadata for each. Produces `artifacts/daily-packs-list.json` — the input for the `schedule` stage to decide which commits need benchmarking.

## Prerequisites

None. This is an early pipeline stage that only requires network access.

## Data Flow

```
NuGet Feed (flat API)          ci.dot.net CDN              GitHub (raw + API)
────────────────────           ──────────────              ──────────────────
 1. version index ──────┐
                        ├─ 2. derive SDK version (11.0.0 → 11.0.100)
                        │
                        ├─ 3. HEAD SDK zip to validate existence
                        │
                        ├─ 4. fetch productCommit-win-x64.json → VMR commit
                        │
                        ├─ 5. fetch source-manifest.json → component SHAs
                        │
                        ├─ 6. fetch global.json → bootstrap SDK version
                        │
                        ├─ 7. GitHub commits API → runtime + aspnetcore datetimes
                        │
                        └─ 8. check sdk.webassembly.pack version exists → workload validated
```

## Inputs

| Source | URL |
|--------|-----|
| NuGet v3 service index | `https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet{major}/nuget/v3/index.json` |
| NuGet flat package index | `{flatBaseUrl}/microsoft.netcore.app.runtime.mono.browser-wasm/index.json` |
| SDK CDN (daily builds) | `https://ci.dot.net/public/Sdk/{sdkVersion}/dotnet-sdk-{sdkVersion}-win-x64.zip` |
| SDK productCommit | `https://ci.dot.net/public/Sdk/{sdkVersion}/productCommit-win-x64.json` |
| VMR source manifest | `https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/src/source-manifest.json` |
| VMR global.json | `https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/global.json` |
| GitHub commits API | `https://api.github.com/repos/dotnet/{repo}/commits/{sha}` |
| Workload package index | `{flatBaseUrl}/microsoft.net.sdk.webassembly.pack/index.json` |

## Version Filtering

Versions are filtered by two criteria:

1. **Major version**: Only versions matching `--major` (default: 11) are included. Parsed from the version string prefix `{major}.0.0-`.

2. **Arcade date window**: The prerelease suffix encodes a build date using the Arcade formula:
   - Version format: `{major}.{minor}.{patch}-{label}.{iteration}.{SHORT_DATE}.{revision}`
   - `SHORT_DATE` decoding: `YY = floor(SHORT_DATE / 1000)`, `MM = floor((SHORT_DATE % 1000) / 50)`, `DD = (SHORT_DATE % 1000) % 50`
   - Example: `26153` → YY=26, MM=3, DD=3 → 2026-03-03
   - Versions older than `--months` (default: 3) from today are excluded.

## SDK Version Derivation

The SDK version is derived from the runtime pack version by replacing the version prefix:
- Runtime pack: `11.0.0-preview.3.26153.117`
- SDK version: `11.0.100-preview.3.26153.117`

Rule: Replace `{major}.{minor}.0` with `{major}.{minor}.100`.

Validated with HEAD request to `https://ci.dot.net/public/Sdk/{sdkVersion}/dotnet-sdk-{sdkVersion}-win-x64.zip`.

## SdkInfo Resolution (per version)

Each version resolves to a complete `SdkInfo`:

| Field | Source |
|-------|--------|
| `sdkVersion` | Derived from runtime pack version (`11.0.0` → `11.0.100`) |
| `runtimeGitHash` | `source-manifest.json` → `repositories[path=runtime].commitSha` |
| `aspnetCoreGitHash` | `source-manifest.json` → `repositories[path=aspnetcore].commitSha` |
| `sdkGitHash` | `source-manifest.json` → `repositories[path=sdk].commitSha` |
| `vmrGitHash` | `productCommit-win-x64.json` → `sdk.commit` (= nuspec `<repository>` commit) |
| `runtimeCommitDateTime` | GitHub API → `GET /repos/dotnet/runtime/commits/{sha}` → `commit.committer.date` |
| `aspnetCoreCommitDateTime` | GitHub API → `GET /repos/dotnet/aspnetcore/commits/{sha}` → `commit.committer.date` |
| `aspnetCoreVersion` | `productCommit-win-x64.json` → `aspnetcore.version` |
| `runtimePackVersion` | The runtime pack version itself (e.g. `11.0.0-preview.3.26153.117`) |
| `workloadVersion` | Same as runtime pack version, validated by checking `microsoft.net.sdk.webassembly.pack` exists |

### Additional fields (not in SdkInfo)

| Field | Source |
|-------|--------|
| `bootstrapSdkVersion` | VMR `global.json` → `tools.dotnet` |
| `publishedAt` | NuGet registration leaf → `published` field |

## Bootstrap SDK Version

The SDK version used to **build** the VMR (not produced by it). Read from `global.json` at the VMR commit:
```json
{ "tools": { "dotnet": "11.0.100-preview.1.26104.118" } }
```

## Workload Validation

Instead of resolving the complex workload manifest band naming (which differs from the prerelease label), we validate that `microsoft.net.sdk.webassembly.pack` exists at the same version. This package is always published alongside the runtime pack (verified: 268/268 match in the dotnet11 feed) and is required for workload builds.

## Incremental Behavior

When `artifacts/daily-packs-list.json` already exists:

1. Fetch only the NuGet flat index (lightweight — returns version strings only).
2. Compare against versions already in the file.
3. Resolve `SdkInfo` only for new versions.
4. Merge new entries into the existing list.
5. Re-apply the date filter to prune versions that have aged out of the window.

When `--force-enumerate` is set, re-resolve all versions from scratch.

## Concurrency

- NuGet index fetch: single request
- Per-version resolution: **10 concurrent** (configurable)
  - 1 HEAD to SDK CDN (validate)
  - 1 GET to productCommit JSON
  - 1 GET to source-manifest.json
  - 1 GET to global.json
  - 2 GET to GitHub API (runtime + aspnetcore commit dates)
  - = 6 HTTP requests per version
- GitHub API: respect rate limit (60/hr unauthenticated, 5000/hr with `GITHUB_TOKEN`)
- Total for ~150 versions: ~900 requests, ~30s with concurrency 10

## Fail-Fast Policy

If any required field cannot be resolved for a version, that version is **skipped with a warning** rather than stored with null values. Specific failures:

- SDK HEAD returns 404 → skip (SDK not published for this version)
- productCommit JSON 404 → skip
- source-manifest.json fetch fails → skip
- GitHub API returns 404 for a commit → skip
- Workload package not found → skip

The stage itself does NOT fail — it produces as many complete entries as possible. But no entry is emitted with missing data.

## Output

`artifacts/daily-packs-list.json`:

```json
{
  "feed": "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11/nuget/v3/index.json",
  "major": 11,
  "months": 3,
  "fetchedAt": "2026-03-11T12:00:00.000Z",
  "totalPacks": 142,
  "packs": [
    {
      "runtimePackVersion": "11.0.0-preview.3.26153.117",
      "sdkVersion": "11.0.100-preview.3.26153.117",
      "bootstrapSdkVersion": "11.0.100-preview.1.26104.118",
      "vmrGitHash": "15ac4103422d47f7c8f14fa98e813f315432d03b",
      "runtimeGitHash": "9b46e58206b2695ad7089ceea0db93cad22abbd7",
      "sdkGitHash": "166668d7c7c0...",
      "aspnetCoreGitHash": "5f2a8c66ade1d6e171be089d0d01cdc6d54a41a7",
      "runtimeCommitDateTime": "2026-03-01T22:32:42Z",
      "aspnetCoreCommitDateTime": "2026-03-02T23:42:17Z",
      "aspnetCoreVersion": "11.0.0-preview.3.26153.117",
      "runtimePackVersion": "11.0.0-preview.3.26153.117",
      "workloadVersion": "11.0.0-preview.3.26153.117",
      "publishedAt": "2026-03-04T07:44:22Z"
    }
  ]
}
```

Packs are sorted by `runtimePackVersion` descending (newest first).

## CLI Options Used

| Flag | Effect |
|------|--------|
| `--major <n>` | Filter to this .NET major version (default: 11) |
| `--months <n>` | Time window in months (default: 3) |
| `--force-enumerate` | Re-resolve all versions, ignoring cache |
| `--verbose` | Log each version resolution step |

## Error Scenarios

| Scenario | Behavior |
|----------|----------|
| NuGet feed unreachable | Stage fails with error |
| All versions fail resolution | Stage fails (0 packs) |
| GitHub rate limit hit | Pause and retry after reset, or fail if no token |
| Partial resolution failure | Skip version, log warning, continue |
| Existing file has corrupted JSON | Treat as absent, full re-enumerate |
