# Artifacts Directory Layout

The `artifacts/` directory holds all intermediate and output files from benchmark runs. It is gitignored and populated at runtime.

```
artifacts/
├── daily-packs-list.json       # Discovered nightly NuGet packs with resolved SdkInfo
├── release-packs-list.json     # Discovered GA release packs with resolved SdkInfo
├── sdk-list.json               # Legacy SDK list (predecessor format)
├── commits-list.json           # dotnet/runtime commit history (from enumerate-commits)
├── docker-context.json         # Serialized BenchContext for cross-container handoff
│
├── sdks/                       # ── Installed .NET SDKs ─────────────────────────
│   └── {sdkVersion}/           # One directory per installed SDK
│       ├── dotnet(.exe)        # SDK entry point
│       ├── sdk/                # SDK tools
│       ├── packs/              # Runtime packs + targeting packs
│       └── ...
│
├── nuget-packages/             # ── NuGet Package Cache ─────────────────────────
│   └── {package-id}/           # Lowercased package ID
│       └── {version}/          # Package version directory
│
├── bin/                        # ── Build Intermediates ──────────────────────────
│   └── {App}/                  # Per-app build output (e.g., EmptyBrowser/)
│       └── ...
│
├── obj/                        # ── Restore / Build Object Files ────────────────
│   ├── {App}/                  # Per-app (e.g., EmptyBrowser/, HavitBootstrap/)
│   └── restore-runtime-pack/   # Runtime pack restore artifacts
│
├── publish/                    # ── Published App Bundles ───────────────────────
│   └── {App}/
│       └── {Preset}/           # One subdirectory per build preset
│           └── wwwroot/
│               ├── index.html
│               └── _framework/
│                   ├── dotnet.js
│                   ├── dotnet.native.wasm
│                   ├── *.dll
│                   └── ...
│
└── results/                    # ── Measurement Results ──────────────────────────
    ├── .run-id                 # Current run ID (ISO timestamp)
    └── {runId}/                # One directory per benchmark run
        ├── build-manifest.json # Build manifest (app×preset entries with compileTime, integrity)
        ├── sdk-info.json       # Resolved SdkInfo for this run
        └── {timestamp}_{hash7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
                                # Individual measurement result files
```

## Key Files

### daily-packs-list.json

Produced by the `enumerate-daily-packs` stage. Contains nightly runtime pack versions discovered from the Azure DevOps NuGet feed, with fully resolved git hashes and commit datetimes.

### release-packs-list.json

Produced by the `enumerate-release-packs` stage. Contains GA release versions discovered from the official .NET releases index, with resolved git hashes.

### results/{runId}/

Each benchmark run writes to a timestamped subdirectory. The `build-manifest.json` links each app×preset combination to its publish directory and compile-time. Individual result JSON files follow the naming pattern:

```
{runtimeCommitDateTime}_{runtimeGitHash:7}_{runtime}_{preset}_{profile}_{engine}_{app}.json
```

Example: `2026-02-18T18-36-50Z_081d220_mono_no-workload_desktop_chrome_empty-browser.json`
