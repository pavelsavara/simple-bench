# Stage: `acquire-sdk`

Download, install, and configure a .NET SDK for the benchmark run. Resolve all git hashes (runtime, SDK, VMR) so that benchmark results can be placed on the timeline and deduplicated.

## When It Runs

- **Default stages**: `acquire-sdk,build,measure` — always runs before `build`.
- **Container**: Runs inside the **build container** (or natively on the host in local mode).
- **Prerequisite**: None (first real work stage after optional `docker-image`).
- **Downstream**: The `build` stage reads `ctx.sdkInfo`, `ctx.sdkDir`, `ctx.dotnetBin`, and `ctx.buildLabel`.

---

## Inputs (BenchContext fields read)

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `sdkChannel` | `string` | CLI `--sdk-channel` (default `"11.0"`) | SDK release channel for latest-daily lookup |
| `sdkVersion` | `string?` | CLI `--sdk-version` | Exact SDK version; overrides channel-based resolution |
| `runtimePack` | `string?` | CLI `--runtime-pack` | Specific runtime pack version (triggers Phase 0) |
| `runtimeCommit` | `string?` | CLI `--runtime-commit` | Specific `dotnet/runtime` commit hash (triggers Phase 0) |
| `runtime` | `Runtime` | CLI `--runtime` (default `mono`) | Runtime flavor (`mono` / `coreclr`) — not directly used by acquire-sdk but stored in metadata |
| `dryRun` | `boolean` | CLI `--dry-run` | No behavioral change in this stage (affects `build`) |
| `verbose` | `boolean` | CLI `--verbose` | Enables detailed logging |
| `platform` | `'windows' \| 'linux' \| 'darwin'` | Auto-detected | Controls dotnet-install script selection and binary name |
| `isCI` | `boolean` | Auto-detected | Enables GitHub Actions env file persistence |
| `repoRoot` | `string` | Auto-detected | Repository root path |
| `artifactsDir` | `string` | Auto-detected | `{repoRoot}/artifacts` |

---

## Outputs (BenchContext fields written)

| Field | Type | Description |
|-------|------|-------------|
| `sdkDir` | `string` | Absolute path to SDK installation directory |
| `dotnetBin` | `string` | Absolute path to `dotnet` / `dotnet.exe` binary |
| `buildLabel` | `string` | Directory nesting label: `{sdkVersion}` or `{sdkVersion}_{runtimePackVersion}` |
| `sdkInfo` | `SdkInfo` | Full resolved SDK metadata (see below) |

### Persisted artifact

Written to `artifacts/sdks/{sdkDirName}/sdk-info.json`. Also copied to `artifacts/results/{runId}/sdk-info.json` by the `build` stage.

---

## Algorithm

The stage is organized into sub-phases mirroring the current `run-pipeline.mjs` Phases 0–1b.

### Phase 0 — Resolve runtime pack (conditional)

**Trigger**: `ctx.runtimePack` or `ctx.runtimeCommit` is set.

This phase runs before SDK download because the runtime pack catalog entry determines which SDK version to install (the SDK that was used to build that runtime).

#### 0a. Load runtime packs catalog

Load `artifacts/runtime-packs.json` (pre-computed by the `enumerate-packs` stage). If stale, refresh by probing the newest version from the AzDO NuGet feed (same as `refreshRuntimePacks()` in the existing code).

#### 0b. Resolve pack entry

| Input | Lookup | Key |
|-------|--------|-----|
| `--runtime-pack <ver>` | `versions.find(e => e.runtimePackVersion === ver)` | Exact match |
| `--runtime-commit <hash>` | `versions.find(e => e.runtimeGitHash?.startsWith(hash))` | Prefix match |

**Error if `--runtime-commit` not found**: The commit hasn't been enumerated yet. Throw with a message directing the user to run `enumerate-packs`.

**Warning if `--runtime-pack` not found**: Log warning but continue — the pack may still be restorable from the NuGet feed even if not in the local catalog.

#### 0c. Derive SDK version

If `ctx.sdkVersion` is **not** explicitly set:
- Read `sdkVersionOfTheRuntimeBuild` from the pack catalog entry (the SDK recorded in `dotnet/runtime`'s `global.json` at that commit).
- Override `ctx.sdkVersion` with this value.

This ensures the SDK used for building is the same one the runtime was built with, avoiding version skew.

#### 0d. Extract runtime git hash

Store `runtimeGitHash` from the pack entry for later injection into `sdk-info.json`.

---

### Phase 1 — Resolve and install .NET SDK

#### 1a. Compute SDK directory name

```
sdkDirName = "{platform}.sdk{sdkVersion || ''}.{sdkChannel}"
```

- With explicit version: `linux.sdk11.0.100-preview.3.26154.119`
- With channel only: `linux.sdk.11.0`

The directory lives at `artifacts/sdks/{sdkDirName}/`.

#### 1b. Check for cached installation

Read `{sdkDir}/sdk-info.json`. If it exists and contains a valid `sdkVersion`:
- Validate `runtimeGitHash` is hex (clean up legacy invalid values).
- Set `ctx.sdkDir`, `ctx.dotnetBin`, environment variables.
- **Skip download** — return the cached info.

This makes repeat runs fast and avoids redundant network traffic.

#### 1c. Refresh SDK catalog

Call the equivalent of `refreshSdkList(channel)`:
1. Fetch `https://aka.ms/dotnet/{channel}/daily/productCommit-linux-x64.txt` with `If-None-Match: {etag}`.
2. On **304**: catalog is current, no-op.
3. On **200**: parse key-value pairs (`sdk_version`, `runtime_version`, `sdk_commit`, `runtime_commit`).
4. If the version is new: fetch VMR `src/source-manifest.json` at the `sdk_commit` to resolve `runtimeGitHash`.
5. Append to `artifacts/sdk-list.json` with build date, band, and URL.

The ETag-based conditional request makes this extremely cheap (single round-trip) when nothing has changed.

#### 1d. Resolve version from catalog

If `sdkVersion` is set: exact lookup in `artifacts/sdk-list.json`.
If only `sdkChannel` is set: find the latest valid entry for the channel (sorted descending by version string).

Cross-reference with `artifacts/runtime-packs.json` to enrich with `vmrGitHash`, `sdkGitHash`, `runtimeGitHash` from the pack entry whose `runtimePackVersion` matches the derived runtime version.

**Catalog result** (if found):
```typescript
{ sdkVersion, runtimeGitHash, sdkGitHash, vmrGitHash, buildDate }
```

If catalog returns `null` (version not in `sdk-list.json`), proceed to install via channel/quality and resolve hashes from the installed SDK.

#### 1e. Download and install SDK

Use the official `dotnet-install` script:

| Platform | Script | Download URL |
|----------|--------|-------------|
| Windows | `dotnet-install.ps1` | `https://dot.net/v1/dotnet-install.ps1` |
| Linux/macOS | `dotnet-install.sh` | `https://dot.net/v1/dotnet-install.sh` |

1. Download the install script to `{sdkDir}/dotnet-install.{ps1|sh}`.
2. On Linux/macOS: `chmod +x`.
3. Run with appropriate flags:

**With exact version** (preferred path):
```bash
# Linux
bash dotnet-install.sh --install-dir {sdkDir} --version {sdkVersion}

# Windows
powershell -ExecutionPolicy Bypass -File dotnet-install.ps1 -InstallDir {sdkDir} -Version {sdkVersion}
```

**With channel only** (fallback when no version resolved):
```bash
bash dotnet-install.sh --install-dir {sdkDir} --channel {channel} --quality daily
```

4. Set environment:
   - `DOTNET_ROOT={sdkDir}`
   - `DOTNET_NOLOGO=true`
   - `NUGET_PACKAGES={artifactsDir}/nuget-packages`
5. On CI: append `DOTNET_ROOT` to `$GITHUB_ENV` file.

#### 1f. Verify installed version

```bash
{sdkDir}/dotnet --version
```

Capture the actual installed version string. This may differ from the catalog version if the install directory already contained a newer SDK.

#### 1g. Resolve git hashes

**Priority chain:**

1. **Catalog data valid** (catalog returned a `runtimeGitHash` AND the installed version matches the catalog's `sdkVersion`):
   - Use `vmrGitHash`, `sdkGitHash`, `runtimeGitHash` directly from catalog.

2. **Catalog data invalid or missing** (version mismatch, or no catalog entry):
   - Run `dotnet --info` → parse two `Commit:` lines:
     - First `Commit:` → SDK commit (this is actually the VMR commit in post-VMR builds)
     - Second `Commit:` → Host commit (short hash of `dotnet/runtime`)
   - Attempt VMR resolution: fetch `https://raw.githubusercontent.com/dotnet/dotnet/{sdkCommit}/src/source-manifest.json`
     - If fetch succeeds: `vmrGitHash = sdkCommit`, parse `runtimeGitHash` and `sdkGitHash` from `repositories[]`
     - If fetch fails (non-VMR build or network error): fall back to using the parsed commits as-is

3. **Fallback assignments** (when VMR resolution fails):
   - `sdkGitHash` = the first Commit hash from `dotnet --info`
   - `runtimeGitHash` = the second Commit hash (Host), or the first if only one exists

#### 1h. Decode build date

Parse the build date from the SDK version string. Two encoding schemes exist:

**Formula A** (Arcade month×50+day — used by daily builds):
```
SHORT_DATE = 26154
YY  = 26154 / 1000        = 26
rem = 26154 % 1000         = 154
MM  = 154 / 50             = 3
DD  = 154 % 50             = 4
→ 2026-03-04
```

**Formula B** (day-of-year — used by released SDKs):
```
SHORT_DATE = 25130
YY  = first 2 digits       = 25
DDD = last 3 digits        = 130
→ 2025, day 130 = May 10
```

The current `sdk-info.mjs` uses Formula B (`parseBuildDate`), while `runtime-pack-resolver.mjs` uses Formula A (`decodeBuildDate`). The TypeScript implementation should use Formula A for daily SDK versions (which are the primary use case) and fall back to Formula B for released versions.

**Fallback**: If neither formula produces a valid date, use `new Date().toISOString().slice(0, 10)` and log a warning.

#### 1i. Generate commit time

Current wall-clock UTC time formatted as `HH-MM-SS-UTC`. This is **not** the actual commit time — it's the timestamp of when this benchmark run resolved the SDK. Combined with `runtimeCommitDateTime`, it forms the result filename prefix.

#### 1j. Write sdk-info.json

```json
{
  "sdkVersion": "11.0.100-preview.3.26154.119",
  "runtimeGitHash": "e524be69...",
  "sdkGitHash": "d65136bf...",
  "vmrGitHash": "dc803dea...",
  "runtimeCommitDateTime": "2026-03-04T00-00-00",
}
```

Written to `{sdkDir}/sdk-info.json`.

---

### Phase 1b — Restore runtime pack (conditional)

**Trigger**: `runtimePackVersion` was resolved in Phase 0.

#### 1b-1. Download pack via `dotnet restore`

```bash
dotnet restore src/restore/restore-runtime-pack.proj \
  /p:RuntimePackVersion={version}
```

The `restore-runtime-pack.proj` is a minimal project that references `Microsoft.NETCore.App.Runtime.Mono.browser-wasm` at the specified version. The NuGet feeds in `NuGet.config` include the AzDO `dotnet11` feed where daily packs are published.

The restored pack lands at `{artifactsDir}/nuget-packages/microsoft.netcore.app.runtime.mono.browser-wasm/{version}/`.

Skip if the pack directory already exists.

#### 1b-2. Update sdk-info.json

Inject `runtimePackVersion` and (if available from Phase 0) override `runtimeGitHash` in the existing `sdk-info.json`.

#### 1b-3. Set build label

When a runtime pack override is active:
```
buildLabel = "{sdkVersion}_{runtimePackVersion}"
```

Otherwise:
```
buildLabel = "{sdkVersion}"
```

This ensures different runtime pack versions under the same SDK don't collide in the artifacts directory.

---

## SDK Resolution Logic — Input Precedence

The four SDK/runtime-related CLI options interact as follows:

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Entry Point                                    │
│  --runtime-commit OR --runtime-pack  →  Phase 0 (resolve pack)      │
│  Neither  →  Skip Phase 0                                            │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Was --sdk-version explicitly passed?                                │
│  YES → use it as-is                                                  │
│  NO + Phase 0 ran → use sdkVersionOfTheRuntimeBuild from pack entry  │
│  NO + Phase 0 skipped → resolve latest daily from --sdk-channel      │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 1: Download exact version (or channel+quality=daily)          │
│  Resolve hashes: catalog → VMR source-manifest → dotnet --info       │
└──────────────────────────────────────────────────────────────────────┘
```

### Scenario matrix

| Scenario | `--sdk-channel` | `--sdk-version` | `--runtime-pack` | `--runtime-commit` | SDK installed | Hashes from |
|----------|:-:|:-:|:-:|:-:|---|---|
| Default daily | `11.0` | — | — | — | Latest daily for channel | Catalog → VMR → `dotnet --info` |
| Explicit SDK | — | `11.0.100-preview.3.26154.119` | — | — | Exact version | Catalog → VMR → `dotnet --info` |
| Runtime commit | `11.0` | — | — | `e524be69` | SDK from pack's `sdkVersionOfTheRuntimeBuild` | Pack catalog entry + VMR |
| Runtime pack | `11.0` | — | `11.0.0-preview.3.26153.109` | — | SDK from pack's `sdkVersionOfTheRuntimeBuild` | Pack catalog entry + VMR |
| Pack + explicit SDK | — | `10.0.100-rc.2.25502.107` | — | `e524be69` | Exact version as given | Pack catalog + catalog + VMR |

---

## Git Hash Resolution — Detailed Flows

The benchmark timeline depends on correct git hash resolution. Three hashes are tracked, each identifying a commit in a different repository:

### How `runtimeGitHash` is discovered

1. **From `runtime-packs.json`**: When `--runtime-commit` or `--runtime-pack` is given, the pack catalog already contains `runtimeGitHash` (resolved during `enumerate-packs` by reading VMR `source-manifest.json` → `repositories[path=runtime].commitSha`).

2. **From `sdk-list.json`**: The SDK catalog may contain `runtimeGitHash` if it was enriched during enumeration. Cross-referenced by matching the runtime pack version derived from the SDK version.

3. **From VMR `source-manifest.json`**: When the SDK's VMR commit is known (either from catalog or from `dotnet --info` Commit line), fetch `https://raw.githubusercontent.com/dotnet/dotnet/{vmrCommit}/src/source-manifest.json` and extract `repositories[path=runtime].commitSha`.

4. **From `dotnet --info` Host section**: Last resort — the second `Commit:` line in `dotnet --info` output gives a short (10-char) host commit hash. This is the `dotnet/runtime` commit but only a prefix, not the full 40 chars.

### How `sdkGitHash` is discovered

1. **From VMR `source-manifest.json`**: `repositories[path=sdk].commitSha` at the VMR commit.
2. **From `dotnet --info` SDK section**: First `Commit:` line. In post-VMR builds, this is the **VMR commit**, not the SDK repo commit. Used as fallback.

### How `vmrGitHash` is discovered

1. **From `runtime-packs.json`**: The `vmrCommit` field (extracted from NuGet nuspec `<repository commit="..."/>`).
2. **From `dotnet --info`**: The first `Commit:` line in post-VMR builds is the VMR commit. Confirmed by successfully fetching `source-manifest.json` at that hash.
3. **Empty/unknown**: If neither works, `vmrGitHash` may be empty. This isn't fatal — results still have `runtimeGitHash` for deduplication.

---

## Workload Installation

Workload installation is **not** part of `acquire-sdk`. It is handled by the `build` stage between the non-workload and workload build phases:

1. `build` stage runs non-workload preset builds (`devloop`, `no-workload`).
2. `build` stage runs `dotnet workload install wasm-tools`.
3. `build` stage captures `workloadVersion` from `dotnet workload list` output and updates `sdk-info.json`.
4. `build` stage runs workload preset builds (`native-relink`, `aot`, `no-jiterp`, `invariant`, `no-reflection-emit`).

The `acquire-sdk` stage ensures the SDK is installed **without** the workload, which is a requirement for accurately measuring non-workload preset behavior.

---

## Platform Handling

### dotnet-install script differences

| Aspect | Windows | Linux / macOS |
|--------|---------|---------------|
| Script | `dotnet-install.ps1` | `dotnet-install.sh` |
| Runner | `powershell -ExecutionPolicy Bypass -File` | `bash` |
| Binary | `dotnet.exe` | `dotnet` |
| Flag style | `-InstallDir`, `-Version`, `-Channel`, `-Quality` | `--install-dir`, `--version`, `--channel`, `--quality` |
| Permissions | N/A | `chmod +x` the install script |

### SDK directory naming

The OS prefix in the directory name prevents collisions when artifacts are shared (e.g., in a mounted volume):
- Windows: `windows.sdk{version}`
- Linux: `linux.sdk{version}`
- macOS: `darwin.sdk{version}`

### exec.ts integration

All process spawning goes through `exec()` from `bench/src/exec.ts`, which handles:
- `stdio: 'inherit'` for install scripts (user sees progress)
- `stdio: 'pipe'` for `dotnet --version` / `dotnet --info` (captured output)
- `throwOnError` for required commands
- `suppressStdout` to prevent polluting `$GITHUB_OUTPUT` on CI
- `label` for verbose logging

---

## Error Handling

### Network failures

| Failure | Impact | Recovery |
|---------|--------|----------|
| `productCommit-linux-x64.txt` unreachable | Cannot refresh SDK catalog | Continue with stale `sdk-list.json`. Log warning. |
| `dotnet-install` script download fails | Cannot install SDK | **Fatal** — throw. No meaningful fallback. |
| `dotnet-install` script execution fails | SDK not installed | **Fatal** — throw with the install script's stderr. |
| VMR `source-manifest.json` fetch fails | Missing git hashes | Fall back to `dotnet --info` parsing. Log warning. |
| `runtime-packs.json` refresh fails | Stale pack catalog | Continue with existing file. Log warning. |
| Pack `dotnet restore` fails | Runtime pack not available | **Fatal** — throw. The user-requested pack version must be restorable. |

### Missing / invalid data

| Condition | Action |
|-----------|--------|
| `--runtime-commit` not found in `runtime-packs.json` | **Fatal** — throw with message to run `enumerate-packs` first |
| `--runtime-pack` not found in catalog | **Warning** — continue; restore may still work from the feed |
| No `sdkVersionOfTheRuntimeBuild` in pack entry | **Fatal** — cannot determine which SDK to install |
| `runtimeGitHash` is not valid hex | Clean up (set to `''`) and re-resolve |
| `parseBuildDate` returns null | Use current date as fallback, log warning |
| Installed version differs from catalog version | Re-resolve hashes from installed SDK (not catalog) |

### Idempotency

The stage is designed to be safely re-run:
- If `sdk-info.json` exists with a valid `sdkVersion`, the download is skipped entirely.
- The NuGet package restore skips if the pack directory already exists.
- Catalog refresh uses HTTP ETags for conditional fetching.

---

## Existing Code Reference

### Key functions to port from `scripts/lib/resolve-sdk.mjs`

| Function | Lines | Purpose |
|----------|-------|---------|
| `resolveSDK()` | Main entry point | Orchestrates: cache check → catalog refresh → catalog lookup → install → hash resolution → write sdk-info |
| `refreshSdkList()` | Catalog refresh | ETag-based `productCommit-linux-x64.txt` fetch, parse key-value, update `sdk-list.json` |
| `resolveFromCatalog()` | Version lookup | Channel → latest valid SDK; cross-reference with `runtime-packs.json` for hashes |
| `installSdk()` | SDK download | Download install script, run with platform-appropriate flags |
| `resolveHashesFromInstall()` | Hash fallback | `dotnet --info` parsing + VMR `source-manifest.json` fetch |
| `parseManifest()` | VMR manifest | Extract `runtime` and `sdk` commits from `source-manifest.json` |
| `deriveRuntimeVersion()` | Version math | SDK `11.0.100-...` → runtime `11.0.0-...` |

### Key functions to port from `scripts/lib/sdk-info.mjs`

| Function | Purpose |
|----------|---------|
| `parseBuildDate()` | Decode SHORT_DATE (Formula B: day-of-year) from SDK version |
| `parseCommitHash()` | Regex first `Commit:` from `dotnet --info` |
| `parseHostCommitHash()` | Regex second `Commit:` from `dotnet --info` |
| `buildSdkInfo()` | Construct the `SdkInfo` JSON object |
| `parseWorkloadVersion()` | Parse wasm-tools version from `dotnet workload list` (used by `build` stage) |

### Key functions from `scripts/lib/runtime-pack-resolver.mjs`

| Function | Purpose |
|----------|---------|
| `decodeBuildDate()` | Decode SHORT_DATE (Formula A: month×50+day) from runtime pack version |
| `restoreRuntimePack()` | `dotnet restore` the runtime pack NuGet package |
| `refreshRuntimePacks()` | Check if newest feed version is in catalog, resolve new ones |
| `getRepoCommitsFromVMR()` | Fetch VMR `source-manifest.json` → `{runtimeCommit, sdkCommit}` |

### Key patterns from `scripts/run-pipeline.mjs`

| Pattern | Where | Notes |
|---------|-------|-------|
| Phase 0 runtime pack resolution | `main()` before `resolveSDKPhase()` | Modifies `args['sdk-version']`, `SDK_DIR`, `SDK_INFO_PATH` |
| Phase 1b runtime pack restore | `main()` after `resolveSDKPhase()` | Updates `sdk-info.json` with `runtimePackVersion`, `runtimeGitHash` |
| `RUNTIME_PACK_DIR` env var | Phase 1b | Set for `build-app.mjs` to pass `/p:RuntimePackDir=...` to MSBuild |

---

## TypeScript Implementation Sketch

```typescript
// bench/src/stages/acquire-sdk.ts

export async function run(ctx: BenchContext): Promise<BenchContext> {
    let runtimePackVersion: string | undefined;
    let runtimeGitHash: string | undefined;

    // ── Phase 0: Resolve runtime pack ────────────────────────
    if (ctx.runtimePack || ctx.runtimeCommit) {
        // Load + optional refresh of runtime-packs.json
        // Lookup pack entry → extract runtimePackVersion, runtimeGitHash
        // Derive sdkVersion if not explicitly set
    }

    // ── Phase 1: Resolve + install SDK ───────────────────────
    const sdkDirName = computeSdkDirName(ctx);
    const sdkDir = join(ctx.artifactsDir, 'sdks', sdkDirName);

    // 1b. Cache check
    const cached = await tryLoadCachedSdkInfo(sdkDir);
    if (cached) {
        return applyToContext(ctx, cached, sdkDir, runtimePackVersion);
    }

    // 1c. Refresh SDK catalog
    await refreshSdkCatalog(ctx.sdkChannel || channelFrom(ctx.sdkVersion));

    // 1d. Catalog lookup
    const catalog = await resolveFromCatalog(ctx.sdkChannel, ctx.sdkVersion);

    // 1e. Install
    await installSdk(catalog?.sdkVersion || ctx.sdkVersion, ctx.sdkChannel, sdkDir, ctx.platform);

    // 1f. Verify
    const installedVersion = await execCapture(dotnetBin(sdkDir, ctx.platform), ['--version']);

    // 1g. Resolve git hashes
    const hashes = catalogValid(catalog, installedVersion)
        ? hashesFromCatalog(catalog)
        : await resolveHashesFromInstall(sdkDir, ctx.platform);

    // 1h-i. Date + time
    const runtimeCommitDateTime = decodeBuildDate(installedVersion) || parseBuildDate(installedVersion) || today();

    // 1j. Write sdk-info.json
    const sdkInfo = { sdkVersion: installedVersion, ...hashes, runtimeCommitDateTime };
    await writeSdkInfo(sdkDir, sdkInfo);

    // ── Phase 1b: Restore runtime pack ───────────────────────
    if (runtimePackVersion) {
        await restoreRuntimePack(dotnetBin(sdkDir, ctx.platform), runtimePackVersion, ctx.artifactsDir);
        sdkInfo.runtimePackVersion = runtimePackVersion;
        if (runtimeGitHash) sdkInfo.runtimeGitHash = runtimeGitHash;
        await writeSdkInfo(sdkDir, sdkInfo);
    }

    // ── Update context ───────────────────────────────────────
    return {
        ...ctx,
        sdkDir,
        dotnetBin: dotnetBin(sdkDir, ctx.platform),
        buildLabel: runtimePackVersion
            ? `${sdkInfo.sdkVersion}_${runtimePackVersion}`
            : sdkInfo.sdkVersion,
        sdkInfo,
    };
}
```

### Suggested module decomposition

| File | Contents |
|------|----------|
| `bench/src/stages/acquire-sdk.ts` | Stage orchestration (Phase 0, 1, 1b) |
| `bench/src/lib/sdk-catalog.ts` | `refreshSdkList()`, `resolveFromCatalog()`, catalog I/O |
| `bench/src/lib/sdk-install.ts` | `installSdk()`, dotnet-install script download + execution |
| `bench/src/lib/sdk-info.ts` | `parseBuildDate()`, `decodeBuildDate()`, `parseCommitHash()`, `parseHostCommitHash()`, `buildSdkInfo()`, `parseWorkloadVersion()` |
| `bench/src/lib/vmr.ts` | `parseManifest()`, `resolveHashesFromInstall()`, VMR source-manifest fetching |
| `bench/src/lib/runtime-pack-resolver.ts` | `restoreRuntimePack()`, `refreshRuntimePacks()`, pack catalog I/O |
