# Repository Directory Layout

```
simple-bench/
├── bench.ps1                  # Windows entry point — runs `tsx bench/src/main.ts`
├── bench.sh                   # Linux/macOS entry point — runs `tsx bench/src/main.ts`
├── package.json               # Root package.json (tsx, playwright devDependencies)
├── NuGet.config                # NuGet feeds for .NET restore (nuget.org + local artifacts)
├── LICENSE
├── README.md
│
├── bench/                      # ── Bench CLI (TypeScript) ──────────────────────
│   ├── package.json            # CLI dependencies (playwright, tsx)
│   ├── tsconfig.json           # TypeScript config (ESM, NodeNext, Node 24)
│   └── src/
│       ├── main.ts             # Entry point: buildContext() → runStages()
│       ├── args.ts             # CLI argument parsing (parseArgs) → BenchContext
│       ├── context.ts          # BenchContext type, save/load for cross-container handoff
│       ├── enums.ts            # All dimension enums: Runtime, Preset, Engine, Profile, App, Stage, MetricKey
│       ├── exec.ts             # Process spawning, Docker run, platform detection, WSL paths
│       ├── log.ts              # Logging helpers (banner, info, debug, err)
│       │
│       ├── lib/                # ── Shared Libraries ────────────────────────────
│       │   ├── metrics.ts      # Metric registry (displayName, unit, category per MetricKey)
│       │   ├── http.ts         # fetch wrappers, GitHub API helpers, NuGet URLs
│       │   ├── gh-pages-checkout.ts  # Git checkout/pull of gh-pages branch
│       │   ├── git-push.ts     # Git add/commit/push helpers for gh-pages
│       │   ├── measure-utils.ts     # File-size walking, Playwright helpers
│       │   ├── throttle-profiles.ts # CPU/network throttle settings (desktop, mobile)
│       │   ├── pizza-walkthrough.ts # Scripted UI interaction for blazing-pizza app
│       │   ├── internal-utils.ts    # Microbenchmark helpers
│       │   └── stats.ts        # Statistical helpers (median, etc.)
│       │
│       └── stages/             # ── Pipeline Stages ─────────────────────────────
│           ├── index.ts        # Stage registry + runStages() dispatcher
│           ├── check-out-cache.ts    # Checkout gh-pages, seed artifacts from cache
│           ├── enumerate-commits.ts  # Fetch dotnet/runtime commit history from GitHub
│           ├── enumerate-daily-packs.ts   # Discover nightly NuGet packs → daily-packs-list.json
│           ├── enumerate-release-packs.ts # Discover GA releases → release-packs-list.json
│           ├── update-cache.ts       # Copy pack lists back to gh-pages/cache/, push
│           ├── schedule.ts           # Dispatch GitHub Actions for untested SDK versions
│           ├── acquire-sdk.ts        # Resolve target pack, install SDK via dotnet-install
│           ├── build.ts              # dotnet publish for each app×preset combination
│           ├── measure.ts            # Browser/CLI measurement via Playwright/d8/node
│           ├── transform-views.ts    # Consolidate results into month indexes + pivot views
│           ├── update-views.ts       # Commit and push data/ to gh-pages
│           ├── docker-image.ts       # Build Docker images (build + measure)
│           ├── docker-wrapper.ts     # Orchestrate stage batches across Docker containers
│           └── consolidate.ts        # (placeholder — not yet implemented)
│
├── src/                        # ── .NET Sample Apps + MSBuild Config ───────────
│   ├── AllApps.proj            # Traversal project — builds all apps
│   ├── Directory.Build.props   # Common MSBuild properties (SDK version, feeds)
│   ├── Directory.Build.targets # Common MSBuild targets
│   ├── presets.props           # Preset definitions (DevLoop, NoWorkload, Aot, etc.)
│   ├── versions.props          # Pinned package versions
│   │
│   ├── empty-browser/          # Minimal Browser WASM app (JSImport/JSExport)
│   ├── empty-blazor/           # Empty Blazor WebAssembly app
│   ├── blazing-pizza/          # Full Blazor app (forms, navigation, auth)
│   ├── havit-bootstrap/        # Large Blazor app with Havit.Blazor components
│   ├── microbenchmarks/        # Internal perf benchmarks (JS interop, JSON, exceptions)
│   └── restore/                # Restore-only project for pre-caching NuGet packages
│
├── docker/                     # ── Docker Build System ─────────────────────────
│   ├── Dockerfile              # Multi-stage: base → browser-bench-build → browser-bench-measure
│   ├── entrypoint.sh           # Symlinks pre-installed node_modules at container start
│   ├── package-build.json      # npm dependencies for build container (tsx only)
│   └── package-measure.json    # npm dependencies for measure container (tsx + playwright)
│
├── .github/
│   └── workflows/
│       ├── benchmark.yml       # Daily CI: build → measure matrix → aggregate
│       ├── docker-build.yml    # Weekly Docker image rebuild + push to ghcr.io
│       └── schedule.yml        # Manual dispatch to schedule untested versions
│
├── artifacts/                  # ── Build/Run Artifacts (gitignored) ─────────────
│                               #    See docs/artifacts-layout.md
│
├── gh-pages/                   # ── Dashboard Data (gh-pages branch) ────────────
│   │                           #    See docs/gh-pages-layout.md
│   ├── index.html              # Dashboard entry point
│   ├── app/                    # Dashboard JS/CSS
│   ├── cache/                  # Cached pack lists for incremental enumeration
│   └── data/                   # Result data and pivot views
│
└── docs/                       # ── Documentation ───────────────────────────────
```
