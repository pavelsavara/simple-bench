# Stage: `enumerate-release-packs`

Implementation: `bench/src/stages/enumerate-release-packs.ts`

## Purpose

Enumerates all GA (General Availability) releases of .NET 8, 9, and 10, resolves full `SdkInfo` metadata for each, and writes `artifacts/release-packs-list.json`. Covers every monthly service-pack release. Previews and RCs are excluded.

This is the "released" counterpart to `enumerate-daily-packs` (which tracks daily CI builds of .NET 11).

## Prerequisites

None. This is an early pipeline stage that only requires network access.

## Data Flow

```
releases-index.json               builds.dotnet.microsoft.com          GitHub (raw + API)
───────────────────                ───────────────────────────          ──────────────────
 1. list channels (.NET 8/9/10)
    │
    ├─ 2. per channel: fetch releases.json
    │     └─ per release: extract runtime version + latest-band SDK
    │
    ├─ 3. fetch productCommit-win-x64.json → commit hashes
    │
    ├─ 4a. (.NET 10) fetch source-manifest.json → component SHAs
    │                fetch VMR global.json → bootstrap SDK
    │
    ├─ 4b. (.NET 8/9) commit hashes from productCommit directly
    │                  fetch runtime global.json → bootstrap SDK
    │
    ├─ 5. GitHub commits API → runtime + aspnetcore datetimes
    │
    └─ 6. check workload pack on nuget.org → validated
```

## Inputs

| Source | URL |
|--------|-----|
| Releases index | `https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json` |
| Channel releases | `https://builds.dotnet.microsoft.com/dotnet/release-metadata/{major}.0/releases.json` |
| SDK productCommit | `https://builds.dotnet.microsoft.com/dotnet/Sdk/{sdkVersion}/productCommit-win-x64.json` |
| VMR source manifest (.NET 10+) | `https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/src/source-manifest.json` |
| VMR global.json (.NET 10+) | `https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/global.json` |
| Runtime global.json (.NET 8/9) | `https://raw.githubusercontent.com/dotnet/runtime/{runtimeCommit}/global.json` |
| GitHub commits API | `https://api.github.com/repos/dotnet/{repo}/commits/{sha}` |
| nuget.org workload pack | `https://api.nuget.org/v3-flatcontainer/microsoft.net.sdk.webassembly.pack/{version}/microsoft.net.sdk.webassembly.pack.nuspec` |

## Enumeration Strategy

### Step 1: Discover channels

Fetch `releases-index.json`. Select channels where `channel-version` starts with `8.0`, `9.0`, or `10.0` (configurable via `--release-majors`, default: `8,9,10`).

### Step 2: Fetch releases per channel

For each channel, fetch `releases.json`. Each entry has:
- `release-date` — the GA release date
- `runtime.version` — the runtime version (e.g. `9.0.14`)
- `sdks[]` — array of SDK versions shipped with this release

### Step 3: Filter to GA only

Exclude any release where `runtime.version` contains `-` (preview/RC).

### Step 4: Select one SDK per release

Per the user's choice (option A), select the **latest-band** SDK — the SDK with the highest feature band (hundreds digit of patch). For example, if a release ships `9.0.312` and `9.0.115`, select `9.0.312`.

Rationale: this matches how most users upgrade (latest SDK band), and one entry per runtime version keeps the dataset focused on runtime changes.

## SdkInfo Resolution (per release)

### productCommit JSON

Fetch `https://builds.dotnet.microsoft.com/dotnet/Sdk/{sdkVersion}/productCommit-win-x64.json`.

Returns:
```json
{
  "runtime":      { "commit": "...", "version": "..." },
  "aspnetcore":   { "commit": "...", "version": "..." },
  "sdk":          { "commit": "...", "version": "..." },
  "windowsdesktop": { "commit": "...", "version": "..." }
}
```

### .NET 10+ (VMR-based)

For .NET 10+, all commits in productCommit are the **same VMR commit**. Resolution:

| Field | Source |
|-------|--------|
| `vmrGitHash` | `productCommit.sdk.commit` (= VMR commit) |
| `runtimeGitHash` | `source-manifest.json` → `repositories[path=runtime].commitSha` |
| `aspnetCoreGitHash` | `source-manifest.json` → `repositories[path=aspnetcore].commitSha` |
| `sdkGitHash` | `source-manifest.json` → `repositories[path=sdk].commitSha` |
| `bootstrapSdkVersion` | VMR `global.json` → `tools.dotnet` |

### .NET 8/9 (pre-VMR)

For .NET 8/9, productCommit entries are **individual repo commits** (each different). Resolution:

| Field | Source |
|-------|--------|
| `vmrGitHash` | `productCommit.sdk.commit` (proxy — no true VMR commit exists) |
| `runtimeGitHash` | `productCommit.runtime.commit` (directly from dotnet/runtime) |
| `aspnetCoreGitHash` | `productCommit.aspnetcore.commit` (directly from dotnet/aspnetcore) |
| `sdkGitHash` | `productCommit.sdk.commit` (directly from dotnet/sdk) |
| `bootstrapSdkVersion` | `https://raw.githubusercontent.com/dotnet/runtime/{runtimeCommit}/global.json` → `sdk.version` |

### Common fields (all versions)

| Field | Source |
|-------|--------|
| `sdkVersion` | Selected SDK version from releases.json |
| `runtimeCommitDateTime` | GitHub API → `GET /repos/dotnet/runtime/commits/{sha}` → `commit.committer.date` |
| `aspnetCoreCommitDateTime` | GitHub API → `GET /repos/dotnet/aspnetcore/commits/{sha}` → `commit.committer.date` |
| `aspnetCoreVersion` | `productCommit.aspnetcore.version` |
| `runtimePackVersion` | `runtime.version` from releases.json (= NuGet package version) |
| `workloadVersion` | Same as `runtimePackVersion`, validated by HEAD on nuget.org workload pack |

### Additional fields (not in SdkInfo)

| Field | Source |
|-------|--------|
| `bootstrapSdkVersion` | See above (differs by major version) |
| `releaseDate` | `release-date` from releases.json |

## VMR Detection

The stage detects whether a release uses VMR or pre-VMR layout by checking if all productCommit entries share the same commit hash:

```typescript
const isVmr = pc.runtime.commit === pc.sdk.commit
            && pc.runtime.commit === pc.aspnetcore.commit;
```

- If `true` → .NET 10+ VMR path (fetch source-manifest.json)
- If `false` → .NET 8/9 pre-VMR path (use productCommit hashes directly)

## Bootstrap SDK Version

- **.NET 10+**: Read from VMR `global.json` at VMR commit → `tools.dotnet`
- **.NET 8/9**: Read from `dotnet/runtime` `global.json` at runtime commit → `sdk.version`

Both return the SDK version used to **build** the runtime/VMR (not the SDK produced by it).

## Workload Validation

For each release, HEAD `https://api.nuget.org/v3-flatcontainer/microsoft.net.sdk.webassembly.pack/{runtimePackVersion}/microsoft.net.sdk.webassembly.pack.nuspec`. If 200 → workload available. If 404 → skip with warning.

## Incremental Behavior

When `artifacts/release-packs-list.json` already exists:

1. Fetch `releases-index.json` and channel `releases.json` (lightweight).
2. Compare against releases already in the file.
3. Resolve `SdkInfo` only for new releases.
4. Merge new entries into the existing list.

Released versions are immutable — once resolved, they never need re-resolution. New entries appear only when Microsoft ships a new monthly service pack.

When `--force-enumerate` is set, re-resolve all releases from scratch.

## Concurrency

- Channel fetch: sequential (only 3 channels)
- Per-release resolution: **10 concurrent**
  - 1 GET productCommit JSON
  - 1 GET source-manifest.json (10+ only) or 0 (8/9)
  - 1 GET global.json (VMR or runtime repo)
  - 2 GET GitHub API (runtime + aspnetcore commit dates)
  - 1 HEAD nuget.org (workload validation)
  - = 5–6 HTTP requests per release
- GitHub API: respect rate limit (60/hr unauthenticated, 5000/hr with `GITHUB_TOKEN`)
- Total: ~70 releases across 3 channels × 5 requests = ~350 requests

## Fail-Fast Policy

If any required field cannot be resolved for a release, that release is **skipped with a warning** rather than stored with null values. Specific failures:

- productCommit JSON 404 → skip
- source-manifest.json fetch fails (10+) → skip
- global.json fetch fails → skip
- GitHub API returns 404 for a commit → skip
- Workload pack not found → skip

The stage itself does NOT fail — it produces as many complete entries as possible.

## Output

`artifacts/release-packs-list.json`:

```json
{
  "channels": ["8.0", "9.0", "10.0"],
  "fetchedAt": "2026-03-11T12:00:00.000Z",
  "totalPacks": 68,
  "packs": [
    {
      "runtimePackVersion": "10.0.4",
      "sdkVersion": "10.0.200",
      "bootstrapSdkVersion": "10.0.103",
      "vmrGitHash": "80d3e14f5e08b4888f464e3cd0d0b2445b63ec46",
      "runtimeGitHash": "081d220c0a77...",
      "sdkGitHash": "23179aa0b46b...",
      "aspnetCoreGitHash": "233fc7812a61...",
      "runtimeCommitDateTime": "2026-03-02T22:32:42Z",
      "aspnetCoreCommitDateTime": "2026-03-02T23:42:17Z",
      "aspnetCoreVersion": "10.0.4",
      "workloadVersion": "10.0.4",
      "releaseDate": "2026-03-10"
    },
    {
      "runtimePackVersion": "9.0.14",
      "sdkVersion": "9.0.312",
      "bootstrapSdkVersion": "9.0.113",
      "vmrGitHash": "c45411d3fd7049c50a8bd4391ecb9ff7080fc519",
      "runtimeGitHash": "19c07820cb72aafc554c3bc8fe3c54010f5123f0",
      "sdkGitHash": "c45411d3fd7049c50a8bd4391ecb9ff7080fc519",
      "aspnetCoreGitHash": "baa6b294e728e6171378b4e8c52e42e7c4d4ed63",
      "runtimeCommitDateTime": "2026-02-19T17:58:18Z",
      "aspnetCoreCommitDateTime": "2026-02-20T05:57:52Z",
      "aspnetCoreVersion": "9.0.14",
      "workloadVersion": "9.0.14",
      "releaseDate": "2026-03-10"
    },
    {
      "runtimePackVersion": "8.0.25",
      "sdkVersion": "8.0.419",
      "bootstrapSdkVersion": "8.0.122",
      "vmrGitHash": "9c30042786e42e6be80a6b107d13f51293740a4f",
      "runtimeGitHash": "b753199016332cbf257e70c417aa5d1d02202dc7",
      "sdkGitHash": "9c30042786e42e6be80a6b107d13f51293740a4f",
      "aspnetCoreGitHash": "ef18546e04f9b0127bbd7709b6af054cc18da98a",
      "runtimeCommitDateTime": "2026-02-20T18:22:00Z",
      "aspnetCoreCommitDateTime": "2026-02-21T01:15:33Z",
      "aspnetCoreVersion": "8.0.25",
      "workloadVersion": "8.0.25",
      "releaseDate": "2026-03-10"
    }
  ]
}
```

Packs are sorted by `runtimePackVersion` descending (newest first), grouped by major version.

## CLI Options Used

| Flag | Effect |
|------|--------|
| `--release-majors <list>` | Comma-separated major versions to enumerate (default: `8,9,10`) |
| `--force-enumerate` | Re-resolve all releases, ignoring cache |

## Differences from `enumerate-daily-packs`

| Aspect | `enumerate-daily-packs` | `enumerate-release-packs` |
|--------|------------------------|--------------------------|
| Source | NuGet daily feed flat index | `releases-index.json` + `releases.json` |
| CDN | `ci.dot.net` | `builds.dotnet.microsoft.com` |
| Versions | ~150 daily builds in last 3 months | ~70 GA releases across 3 majors |
| Filtering | Arcade date window (`--months`) | GA only (no prerelease) |
| SDK derivation | String manipulation (`.0-` → `.100-`) | releases.json provides mapping directly |
| SDKs per runtime | 1:1 | 1:N in data, but we pick latest band |
| VMR commits | All .NET 11 → VMR | .NET 10+ → VMR, .NET 8/9 → individual repo |
| `vmrGitHash` | True VMR commit | .NET 10+: true VMR; .NET 8/9: `sdk.commit` proxy |
| Bootstrap SDK | VMR `global.json` → `tools.dotnet` | .NET 10+: VMR; .NET 8/9: runtime `global.json` → `sdk.version` |
| Incremental | Date window prunes old entries | All GA releases are kept (immutable) |
