# Stage: `docker-image`

Builds the Docker images used by subsequent `acquire-sdk`, `build`, and `measure` stages when running in `--via-docker` mode.

## When It Runs

- **Explicitly**: included in `--stages docker-image,...`
- **Typically paired with**: `--via-docker` flag, which causes later stages to `docker run` inside these images
- **Skipped when**: `--skip-docker-build` is set, or when running inside a container (`ctx.isDocker === true`)

In CI (`docker-build.yml`), the images are built and pushed to `ghcr.io` weekly. The benchmark workflow (`benchmark.yml`) pulls pre-built images — it never runs this stage.

## What It Does

1. Guards: returns early if `ctx.skipDockerBuild` or `ctx.isDocker`
2. Builds `browser-bench-build:latest` — SDK build prerequisites (used by `acquire-sdk` and `build`)
3. Builds `browser-bench-measure:latest` — JS engines + browsers (used by `measure`)

Both targets come from `docker/Dockerfile` (multi-stage: `base` → `browser-bench-build` | `browser-bench-measure`). Builds are sequential; the shared `base` stage is reused via Docker layer cache.

## Docker Images

| Image | Target | Purpose |
|-------|--------|---------|
| `browser-bench-build:latest` | `browser-bench-build` | Ubuntu 24.04 + Node.js + .NET SDK native deps. Runs as root. |
| `browser-bench-measure:latest` | `browser-bench-measure` | Ubuntu 24.04 + Node.js + Playwright browsers + V8/d8. Runs as `benchuser`. |

## Platform Handling

On Windows, all Docker commands route through `wsl.exe` automatically (handled by `dockerBuild()` in `exec.ts`). On Linux, Docker runs directly.

## Exports

- `BUILD_IMAGE` / `MEASURE_IMAGE` — image tag constants, importable by `build` and `measure` stages.

