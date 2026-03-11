# Stage: `schedule` — Gap Detection & Workflow Dispatch

## Purpose

The `schedule` stage detects .NET runtime commits that have no benchmark results and dispatches GitHub Actions `workflow_dispatch` events to trigger benchmark runs for those commits. It is the mechanism by which the system continuously and automatically tracks new runtime builds without manual intervention.

In CI, it runs on a daily cron schedule (04:00 UTC via `benchmark.yml`). It can also be run manually via the CLI for ad-hoc scheduling or dry-run inspection.

## Position in the Pipeline

```
enumerate-packs → schedule → [benchmark.yml dispatches] → build → measure → consolidate
                                 ↑                                              │
                                 └──────────────── (self-scheduling loop) ──────┘
```

The schedule stage sits outside the normal build→measure→consolidate flow. It is a **control-plane** operation that examines existing data and triggers new **data-plane** runs. It does not produce benchmark results itself — it triggers workflows that do.

## Inputs

### BenchContext Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxDispatches` | `number` | `3` | Maximum number of `workflow_dispatch` events to trigger per invocation |
| `recent` | `number` | `30` | Number of most-recent runtime pack entries to consider for scheduling |
| `repo` | `string?` | auto-detect | GitHub repository in `OWNER/NAME` format (e.g. `user/simple-bench`) |
| `branch` | `string` | `'main'` | Git branch ref for the dispatched workflow |
| `dryRun` | `boolean` | `false` | When true, log what would be dispatched without triggering |
| `verbose` | `boolean` | `false` | Enable detailed logging |
| `repoRoot` | `string` | — | Repository root path (for locating catalog files) |
| `artifactsDir` | `string` | — | Artifacts directory (contains `runtime-packs.json`, `sdk-list.json`) |

### File Inputs

| File | Location | Required | Description |
|------|----------|----------|-------------|
| `runtime-packs.json` | `{artifactsDir}/runtime-packs.json` | Yes | Catalog of runtime pack versions with resolved `runtimeGitHash`, `buildDate`, `runtimePackVersion` |
| `sdk-list.json` | `{artifactsDir}/sdk-list.json` | No | Catalog of SDK versions (used for optional deduplication) |
| `index.json` | gh-pages `data/index.json` (fetched via HTTPS) | No | Top-level index listing available month keys |
| `{YYYY-MM}.json` | gh-pages `data/{YYYY-MM}.json` (fetched via HTTPS) | No | Month indexes containing per-commit result metadata |

### External Dependencies

| Dependency | Purpose |
|------------|---------|
| GitHub CLI (`gh`) | Dispatching `workflow_dispatch` events. Must be installed and authenticated (`gh auth login`) |
| Network access | Fetching gh-pages data via `raw.githubusercontent.com` |
| `git` | Auto-detecting the repository `OWNER/NAME` from `git remote get-url origin` |

## Outputs

- **Primary**: Zero or more `workflow_dispatch` events triggered on `benchmark.yml` via the GitHub CLI
- **Side effect**: Console logs summarizing gaps found and dispatches made
- **Return value**: Unmodified `BenchContext` (this stage is read-only with respect to context)

Each dispatch passes a single input field:

```
-f runtime_commit={full_40_char_runtimeGitHash}
```

The dispatched `benchmark.yml` workflow then executes Phase 0 (runtime pack resolution by commit hash) → build → measure → consolidate.

## Algorithm

### Step 1: Load Runtime Packs Catalog

Read `artifacts/runtime-packs.json`. This file is produced by the `enumerate-packs` stage and contains an array of resolved pack entries:

```json
{
  "versions": [
    {
      "runtimePackVersion": "11.0.0-alpha.1.25614.102",
      "buildDate": "2025-12-14",
      "runtimeGitHash": "bce6119e...",
      "sdkVersionOfTheRuntimeBuild": "10.0.100-rc.2.25502.107"
    }
  ]
}
```

If the file does not exist, the stage throws an error instructing the user to run `enumerate-packs` first.

### Step 2: Load SDK List (Optional)

Read `artifacts/sdk-list.json` if present. The SDK list provides additional `runtimeGitHash` values that may already be covered by default SDK-version runs (not runtime-pack-override runs). This is used for deduplication but is not required.

### Step 3: Fetch Existing Results from gh-pages

Build the "tested set" — a `Set<string>` of `runtimeGitHash` values that already have benchmark results on gh-pages:

1. Fetch `https://raw.githubusercontent.com/{repo}/gh-pages/data/index.json`
2. If not found (404), treat all commits as untested (empty set)
3. Extract the `months` array from the index (e.g. `["2026-01", "2026-02", "2026-03"]`)
4. Select only the **last 6 months** to limit HTTP requests
5. Fetch each month index: `https://raw.githubusercontent.com/{repo}/gh-pages/data/{YYYY-MM}.json`
6. For each commit entry in each month index, add `runtimeGitHash` to the tested set

All fetches use a 30-second timeout via `AbortSignal.timeout(30000)`. Failed fetches return `null` and are silently skipped — the consequence is that some commits may be considered "untested" when they actually have results, causing at most a redundant dispatch (which is harmless because consolidation deduplicates).

### Step 4: Identify Gaps (Missing Commits)

Filter the runtime packs catalog to find commits that need benchmarking:

```
1. Take all entries from runtime-packs.json where runtimeGitHash is defined
2. Sort by buildDate descending (most recent first)
3. Take the first `ctx.recent` entries (default: 30)
4. For each entry, check against the tested set:
   a. Full hash match: if runtimeGitHash ∈ testedSet → skip
   b. 7-char prefix match: if any hash in testedSet starts with the same 7-char prefix → skip
      (Results use 7-char abbreviated hashes in filenames; this handles the prefix-matching convention)
5. Deduplicate by runtimeGitHash — multiple pack versions can share the same runtime commit
   (e.g. different NuGet package versions built from the same VMR commit).
   Keep the first occurrence (most recent pack version) for each unique commit.
```

The output is an ordered list of pack entries whose runtime commits have no corresponding benchmark results, sorted most-recent-first.

### Step 5: Dispatch Workflows

Take the first `ctx.maxDispatches` entries from the missing list and dispatch a benchmark workflow for each:

```
gh workflow run benchmark.yml \
    --repo {repo} \
    --ref {branch} \
    -f runtime_commit={runtimeGitHash}
```

Each dispatch is independent. If one fails (e.g. rate limit, network error), the error is logged and the next dispatch is attempted. The stage reports the count of successful dispatches vs. attempted.

In `--dry-run` mode, the `gh` command is printed but not executed.

### Summary Output

```
  3 runtime commits without results
  Missing commits (most recent first):
    2026-03-04 | bce6119e1234 | 11.0.0-alpha.1.26154.102
    2026-03-03 | abc1234def56 | 11.0.0-alpha.1.26153.109
    2026-03-02 | 999888777666 | 11.0.0-alpha.1.26152.105
  
  Scheduling 3 benchmark runs
  ✓ 3/3 workflows dispatched
```

## GitHub API Usage

### Dispatch Mechanism

The scheduler uses the **GitHub CLI** (`gh`) rather than direct REST API calls. This avoids managing OAuth tokens or PATs directly — `gh` handles authentication via `gh auth login`.

The CLI command:

```bash
gh workflow run benchmark.yml --repo OWNER/REPO --ref main -f runtime_commit=HASH
```

This translates to the GitHub REST API endpoint:

```
POST /repos/{owner}/{repo}/actions/workflows/benchmark.yml/dispatches
{
  "ref": "main",
  "inputs": {
    "runtime_commit": "abc1234def5678..."
  }
}
```

### Authentication

- `gh auth login` must have been run beforehand
- In CI, the `GITHUB_TOKEN` or a PAT must be available to `gh`
- The token needs `actions:write` scope on the target repository

### Pre-flight Check

Before attempting dispatches (unless `--dry-run`), the stage verifies `gh` is available:

```javascript
execFileSync('gh', ['--version'], { stdio: 'pipe' });
```

If `gh` is not found, the stage throws with an installation instruction.

## Rate Limiting

### maxDispatches Cap

The `maxDispatches` parameter (default: 3) is the primary rate-limiting mechanism. Even if 20 commits are missing results, only 3 workflows are dispatched per scheduler invocation. This prevents:

1. **GitHub Actions queue flooding** — each dispatch triggers a full build+measure pipeline consuming ~90 minutes of compute
2. **Concurrent run conflicts** — too many parallel runs could hit GitHub's concurrency limits
3. **Cascading failures** — if a commit is genuinely broken, flooding won't help

### Daily Execution Cadence

In CI, the scheduler runs once daily at 04:00 UTC (via `benchmark.yml` cron trigger). With `maxDispatches=3`, this means at most **3 new benchmark runs per day**. If there are more untested commits, they queue up and are dispatched on subsequent days in reverse-chronological order (most recent first).

### Remaining Gap Reporting

After dispatching, the stage reports how many commits still need benchmarking:

```
  ✓ 3/3 workflows dispatched
  12 more commits still need benchmarking
```

This allows operators to increase `maxDispatches` or run manually if a backlog develops.

### Network-Level Throttling

- gh-pages fetches are limited to 7 HTTP requests max (1 index + 6 month indexes)
- All fetches have 30-second timeouts to avoid hanging on slow responses
- `gh` CLI rate limits are handled by the CLI itself (exponential backoff)

## Self-Scheduling Loop

The schedule stage creates a **closed loop** where the system continuously benchmarks new runtime builds:

```
Daily cron (04:00 UTC)
    ↓
benchmark.yml fires
    ↓ (default: no runtime_commit input)
schedule stage runs
    ↓
Detects N missing commits via gh-pages gap analysis
    ↓
Dispatches up to maxDispatches workflow_dispatch events
    ↓
Each dispatched workflow runs: build → measure
    ↓
consolidate.yml triggers on completion
    ↓
Results published to gh-pages
    ↓
Next daily cron → schedule sees new results, finds next gaps
```

### How the Schedule Stage Gets Invoked in CI

The `benchmark.yml` workflow has two trigger modes:

1. **Cron / manual (no `runtime_commit` input)**: The build job runs `run-pipeline.mjs` with the default SDK channel. After build+measure, a final schedule step could drive additional dispatches. In practice, the daily cron itself can run the schedule stage standalone.

2. **Dispatched (with `runtime_commit` input)**: The build job runs with `--runtime-commit {hash}`, resolving a specific runtime pack from the catalog. The schedule stage is **not** run in this mode — it's a pure build+measure pipeline for a specific commit.

### Convergence

Given a constant stream of ~1 new runtime build per day and `maxDispatches=3`, the system converges:

- **Steady state**: 1 new commit/day, 3 dispatches/day → always caught up
- **Backlog** (e.g. after downtime): catches up at 3 commits/day until `recent` window is fully covered
- **Burst** (e.g. many builds in a day): prioritizes most recent commits, older ones queue

## Error Handling

### Catalog Missing

If `artifacts/runtime-packs.json` does not exist:

```
Error: artifacts/runtime-packs.json not found. Run: node scripts/enumerate-runtime-packs.mjs
```

The stage cannot proceed without pack data. The user must run `enumerate-packs` first.

### Repository Detection Failure

If `--repo` is not provided and `git remote get-url origin` fails:

```
Error: Could not detect GitHub repo. Use --repo OWNER/NAME or run from a git checkout.
```

### GitHub CLI Not Available

If `gh --version` fails (not installed or not in PATH):

```
Error: GitHub CLI (gh) is not installed or not authenticated.
Install from https://cli.github.com/ and run: gh auth login
```

This check is skipped in `--dry-run` mode since no actual dispatches are made.

### gh-pages Index Not Found

If `data/index.json` returns 404 (e.g. fresh repo, gh-pages not yet initialized):

- Log: `No gh-pages index.json found — treating all commits as new`
- The tested set is empty → all recent commits are considered "missing"
- Dispatches proceed normally (capped by `maxDispatches`)

### Individual Dispatch Failure

If a specific `gh workflow run` invocation fails (network error, auth issue, rate limit):

- Error is logged: `Failed to dispatch: {message}`
- The loop continues to the next commit
- Final summary reports `dispatched/attempted` ratio

The stage does **not** throw on partial dispatch failure — it dispatches what it can and reports the outcome.

### Network Timeout on gh-pages Fetch

Month index fetches that fail or timeout return `null` and are silently skipped. This may cause some already-tested commits to appear as "missing", resulting in redundant dispatches — but consolidation handles duplicate results gracefully (last-write-wins dedup).

## Known Issue: Infinite Retry of Failing Commits

The scheduler cannot currently distinguish "never tested" from "tested but always fails (no results reached gh-pages)". If a specific runtime commit consistently causes build or measurement failures, it will never produce results → the scheduler will re-dispatch it every day until it ages out of the `--recent` window.

### Planned Fix: `storage` Branch with Attempt Tracking

A `storage` branch will persist a `schedule-attempts.json` file tracking dispatch history:

```json
{
  "bce6119e...": { "attempts": 2, "lastAttempt": "2026-03-04T04:15:00Z" },
  "abc1234d...": { "attempts": 3, "lastAttempt": "2026-03-03T04:12:00Z", "lastStatus": "success" }
}
```

**Enhanced scheduling flow** (not yet implemented):

1. Fetch `storage` branch → load `schedule-attempts.json`
2. Filter runtime packs: not in tested set **AND** `attempts < 3`
3. For each dispatched commit: increment `attempts`, set `lastAttempt`
4. Push updated `schedule-attempts.json` to `storage` branch

**Enhanced consolidation flow** (not yet implemented):

1. After publishing results to gh-pages, fetch `storage` branch
2. For each runtime hash with successful results: set `lastStatus = "success"`
3. Push updated `schedule-attempts.json`

This caps retries at 3 per commit and avoids wasting CI capacity on permanently broken commits.

## Existing Code Reference

### `scripts/schedule-benchmarks.mjs` — Original Implementation

The TypeScript `schedule.ts` will be a direct port of the existing JavaScript implementation. Key patterns to preserve:

**CLI argument mapping** (mjs → BenchContext):
| `schedule-benchmarks.mjs` arg | `BenchContext` field |
|-------------------------------|---------------------|
| `--refresh` | (handled by running `enumerate-packs` stage before `schedule`) |
| `--max-dispatches N` | `ctx.maxDispatches` (default: 3) |
| `--dry-run` | `ctx.dryRun` |
| `--repo OWNER/NAME` | `ctx.repo` |
| `--branch BRANCH` | `ctx.branch` (default: `'main'`) |
| `--recent N` | `ctx.recent` (default: 30) |

**Core functions to port**:

1. **`loadRuntimePacks(refresh)`** → Read from `{ctx.artifactsDir}/runtime-packs.json`. The `--refresh` flag becomes a separate stage (`enumerate-packs`) run before `schedule` in the stage list.

2. **`fetchExistingResults(repo)`** → Fetch gh-pages index + last 6 month indexes via HTTPS. Build `Set<string>` of runtimeGitHash values. Uses `fetch()` with 30s timeout, gracefully handles 404/errors.

3. **`findMissingCommits(packs, existingHashes, sdkList, maxRecent)`** → Sort packs by `buildDate` DESC, take top N, filter against tested set with 7-char prefix matching, deduplicate by `runtimeGitHash`.

4. **`dispatchWorkflow(repo, branch, runtimeCommit, dryRun)`** → Execute `gh workflow run benchmark.yml --repo {repo} --ref {branch} -f runtime_commit={hash}`. In dry-run mode, log the command without executing.

5. **`detectRepo()`** → Parse `OWNER/NAME` from `git remote get-url origin`. Handles both HTTPS (`https://github.com/OWNER/REPO.git`) and SSH (`git@github.com:OWNER/REPO.git`) URL formats.

6. **`ghCliAvailable()`** → Pre-flight check that `gh --version` succeeds.

### Prefix Matching Logic

The existing code performs bidirectional 7-character prefix matching:

```javascript
const short = hash.substring(0, 7);
for (const existing of existingHashes) {
    if (existing.startsWith(short) || short.startsWith(existing)) return false;
}
```

This handles the case where the catalog has full 40-character hashes but gh-pages results may store abbreviated hashes (7-character). The TypeScript port should preserve this behavior.

### TypeScript Stub

The current stub at `bench/src/stages/schedule.ts`:

```typescript
import { type BenchContext } from '../context.js';

export async function run(ctx: BenchContext): Promise<BenchContext> {
    // TODO: discover SDKs, enqueue benchmark jobs
    console.log('[schedule] not yet implemented');
    return ctx;
}
```

The implementation should follow the same `run(ctx) → Promise<BenchContext>` signature, using `ctx` fields instead of parsing CLI args directly.

### Execution via `exec.ts`

External commands (`gh`, `git`) should be spawned via the `exec.ts` helpers already established in the TypeScript codebase, rather than using `execFileSync` directly. This ensures consistent error handling, logging, and cross-platform behavior.

## CLI Usage Examples

```bash
# Dry-run: see what would be scheduled
bench --stages schedule --dry-run --verbose

# Schedule with custom repo and limits
bench --stages schedule --repo user/simple-bench --max-dispatches 5 --recent 50

# Enumerate packs first (refresh catalog), then schedule
bench --stages enumerate-packs,schedule --max-dispatches 3

# CI daily cron invocation
bench --stages schedule --max-dispatches 3 --recent 30
```
