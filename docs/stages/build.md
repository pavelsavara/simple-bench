# Stage: `build`

Implementation: `bench/src/stages/build.ts`

## Purpose

Compiles all sample apps for every applicable preset × runtime combination using `dotnet publish`. Produces published application bundles under `artifacts/publish/` and writes a `build-manifest.json` that the downstream `measure` stage consumes.

## Prerequisites

The `acquire-sdk` stage must run first, populating `ctx.sdkDir`, `ctx.dotnetBin`, `ctx.sdkInfo`, `ctx.buildLabel`, and optionally `ctx.runtimePackDir`.

## Two-Phase Build

Non-workload presets (`devloop`, `no-workload`) are built **before** the `wasm-tools` workload is installed to ensure they reflect an unmodified SDK. Workload presets (`aot`, `native-relink`, `no-jiterp`, `invariant`, `no-reflection-emit`) are built after. This prevents workload contamination of the "out-of-box" build configurations.

## Skipped Combinations

- `aot` + `coreclr` — AOT compilation is mono-only
- `no-jiterp` + `coreclr` — Jiterpreter is a mono-only JIT tier

## Outputs

- `artifacts/publish/{app}/{buildLabel}/{preset}/` — published app bundles
- `artifacts/results/{runId}/build-manifest.json` — array of `BuildManifestEntry`
- `artifacts/results/{runId}/sdk-info.json` — SDK metadata copy
- `artifacts/results/.run-id` — run timestamp marker

Each `BuildManifestEntry` contains: `app`, `preset`, `runtime`, `compileTimeMs`, `integrity` (fileCount + totalBytes), `publishDir`.
