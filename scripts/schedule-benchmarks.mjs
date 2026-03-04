#!/usr/bin/env node
/**
 * schedule-benchmarks.mjs — Self-scheduling script that finds runtime commits
 * without benchmark results and triggers CI workflow runs.
 *
 * Flow:
 *   1. Optionally refresh runtime-packs.json and sdk-list.json
 *   2. Fetch gh-pages index + month data via GitHub raw URLs
 *   3. Identify runtime commits from packs that have no results
 *   4. Trigger benchmark.yml workflow_dispatch for each missing commit
 *
 * Usage:
 *   node scripts/schedule-benchmarks.mjs [options]
 *
 * Options:
 *   --refresh             Re-run enumerate-runtime-packs.mjs first
 *   --max-dispatches N    Maximum workflows to trigger (default: 3)
 *   --dry-run             Show what would be scheduled without triggering
 *   --repo OWNER/NAME     GitHub repo (default: from git remote)
 *   --branch BRANCH       Branch to trigger on (default: main)
 *   --recent N            Only consider the N most recent packs (default: 30)
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RUNTIME_PACKS_PATH = resolve(REPO_ROOT, 'runtime-packs.json');
const SDK_LIST_PATH = resolve(REPO_ROOT, 'sdk-list.json');

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseCliArgs() {
    const args = {
        refresh: false,
        maxDispatches: 3,
        dryRun: false,
        repo: '',
        branch: 'main',
        recent: 30,
    };
    for (let i = 2; i < process.argv.length; i++) {
        switch (process.argv[i]) {
            case '--refresh': args.refresh = true; break;
            case '--max-dispatches': args.maxDispatches = parseInt(process.argv[++i], 10); break;
            case '--dry-run': args.dryRun = true; break;
            case '--repo': args.repo = process.argv[++i]; break;
            case '--branch': args.branch = process.argv[++i]; break;
            case '--recent': args.recent = parseInt(process.argv[++i], 10); break;
        }
    }
    return args;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson(url) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) return null;
    return resp.json();
}

function detectRepo() {
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
            encoding: 'utf-8',
            cwd: REPO_ROOT,
        }).trim();
        // Parse github.com/OWNER/REPO from HTTPS or SSH URL
        const m = url.match(/github\.com[/:](.+?)(?:\.git)?$/);
        return m?.[1] || null;
    } catch {
        return null;
    }
}

function ghCliAvailable() {
    try {
        execFileSync('gh', ['--version'], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

// ── Step 1: Load / refresh runtime packs data ───────────────────────────────

async function loadRuntimePacks(refresh) {
    if (refresh) {
        console.log('Refreshing runtime-packs.json...');
        execFileSync('node', [resolve(__dirname, 'enumerate-runtime-packs.mjs')], {
            stdio: 'inherit',
            cwd: REPO_ROOT,
        });
    }

    if (!existsSync(RUNTIME_PACKS_PATH)) {
        throw new Error(
            'runtime-packs.json not found. Run: node scripts/enumerate-runtime-packs.mjs'
        );
    }

    return JSON.parse(readFileSync(RUNTIME_PACKS_PATH, 'utf-8'));
}

// ── Step 2: Load SDK list data ──────────────────────────────────────────────

function loadSdkList() {
    if (!existsSync(SDK_LIST_PATH)) return null;
    try {
        return JSON.parse(readFileSync(SDK_LIST_PATH, 'utf-8'));
    } catch {
        return null;
    }
}

// ── Step 3: Fetch gh-pages results index ────────────────────────────────────

/**
 * Fetch the gh-pages data/index.json and relevant month indexes
 * to build a Set of runtimeGitHash values that already have results.
 */
async function fetchExistingResults(repo) {
    const baseUrl = `https://raw.githubusercontent.com/${repo}/gh-pages/data`;

    // Fetch top-level index
    const index = await fetchJson(`${baseUrl}/index.json`);
    if (!index) {
        console.log('  No gh-pages index.json found — treating all commits as new');
        return new Set();
    }

    console.log(`  gh-pages has ${index.months?.length || 0} months of data`);

    // Fetch month indexes to collect all runtimeGitHash values
    const existingHashes = new Set();
    const months = index.months || [];

    // Only fetch recent months (last 6 months) to limit HTTP calls
    const recentMonths = months.slice(-6);
    console.log(`  Fetching ${recentMonths.length} recent month indexes...`);

    const results = await Promise.all(
        recentMonths.map(async (monthKey) => {
            const monthData = await fetchJson(`${baseUrl}/${monthKey}.json`);
            return monthData;
        })
    );

    for (const monthData of results) {
        if (!monthData?.commits) continue;
        for (const commit of monthData.commits) {
            const hash = commit.runtimeGitHash || commit.gitHash;
            if (hash) existingHashes.add(hash);
        }
    }

    console.log(`  Found ${existingHashes.size} runtime commits with existing results`);
    return existingHashes;
}

// ── Step 4: Find gaps ───────────────────────────────────────────────────────

/**
 * Find runtime pack entries whose runtimeGitHash has no existing results.
 * Returns entries sorted by buildDate descending (most recent first).
 */
function findMissingCommits(packs, existingHashes, sdkList, maxRecent) {
    // Get resolved pack entries with runtime hashes
    const resolved = (packs.versions || [])
        .filter(e => e.runtimeGitHash)
        .sort((a, b) => (b.buildDate || '').localeCompare(a.buildDate || ''));

    // Take only the N most recent
    const recent = resolved.slice(0, maxRecent);

    // Also collect SDK-based runtimeGitHash values from sdk-list.json
    const sdkHashes = new Set();
    if (sdkList?.versions) {
        for (const entry of sdkList.versions) {
            if (entry.runtimeGitHash) sdkHashes.add(entry.runtimeGitHash);
        }
    }

    // Filter to those not in existing results AND not already covered by SDK runs
    const missing = recent.filter(e => {
        const hash = e.runtimeGitHash;
        // Skip if we already have results for this commit
        if (existingHashes.has(hash)) return false;
        // Skip if a 7-char prefix match exists (results use 7-char hashes)
        const short = hash.substring(0, 7);
        for (const existing of existingHashes) {
            if (existing.startsWith(short) || short.startsWith(existing)) return false;
        }
        return true;
    });

    return missing;
}

// ── Step 5: Dispatch workflows ──────────────────────────────────────────────

function dispatchWorkflow(repo, branch, runtimeCommit, dryRun) {
    const args = [
        'workflow', 'run', 'benchmark.yml',
        '--repo', repo,
        '--ref', branch,
        '-f', `runtime_commit=${runtimeCommit}`,
    ];

    if (dryRun) {
        console.log(`  [dry-run] gh ${args.join(' ')}`);
        return true;
    }

    try {
        execFileSync('gh', args, { stdio: 'inherit', cwd: REPO_ROOT });
        return true;
    } catch (err) {
        console.error(`  Failed to dispatch: ${err.message}`);
        return false;
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseCliArgs();

    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║     Benchmark Scheduler                       ║');
    console.log('╚═══════════════════════════════════════════════╝');

    // Detect repo
    const repo = args.repo || detectRepo();
    if (!repo) {
        throw new Error(
            'Could not detect GitHub repo. Use --repo OWNER/NAME or run from a git checkout.'
        );
    }
    console.log(`\nRepo: ${repo}`);
    console.log(`Branch: ${args.branch}`);
    console.log(`Max dispatches: ${args.maxDispatches}`);
    console.log(`Recent packs to check: ${args.recent}`);
    if (args.dryRun) console.log('Mode: DRY RUN');

    // Check gh CLI availability (unless dry-run)
    if (!args.dryRun && !ghCliAvailable()) {
        throw new Error(
            'GitHub CLI (gh) is not installed or not authenticated. '
            + 'Install from https://cli.github.com/ and run: gh auth login'
        );
    }

    // Step 1: Load runtime packs
    console.log('\n── Loading runtime packs ──');
    const packs = await loadRuntimePacks(args.refresh);
    console.log(`  ${packs.totalVersions} versions, ${packs.resolvedVersions} resolved`);

    // Step 2: Load SDK list (optional, for dedup)
    const sdkList = loadSdkList();
    if (sdkList) {
        console.log(`  SDK list: ${sdkList.totalVersions} versions`);
    }

    // Step 3: Fetch existing results from gh-pages
    console.log('\n── Checking existing results ──');
    const existingHashes = await fetchExistingResults(repo);

    // Step 4: Find missing commits
    console.log('\n── Finding gaps ──');
    const missing = findMissingCommits(packs, existingHashes, sdkList, args.recent);
    console.log(`  ${missing.length} runtime commits without results`);

    if (missing.length === 0) {
        console.log('\n✓ All recent runtime commits have benchmark results');
        return;
    }

    // Show what we found
    console.log('\n  Missing commits (most recent first):');
    for (const entry of missing.slice(0, 10)) {
        console.log(`    ${entry.buildDate} | ${entry.runtimeGitHash?.substring(0, 12)} | ${entry.version}`);
    }
    if (missing.length > 10) {
        console.log(`    ... and ${missing.length - 10} more`);
    }

    // Step 5: Dispatch workflows (up to maxDispatches)
    const toDispatch = missing.slice(0, args.maxDispatches);
    console.log(`\n── Scheduling ${toDispatch.length} benchmark runs ──`);

    let dispatched = 0;
    for (const entry of toDispatch) {
        console.log(`\n  Dispatching: ${entry.runtimeGitHash?.substring(0, 12)} (${entry.buildDate}, pack ${entry.version})`);
        const ok = dispatchWorkflow(repo, args.branch, entry.runtimeGitHash, args.dryRun);
        if (ok) dispatched++;
    }

    console.log(`\n✓ ${dispatched}/${toDispatch.length} workflows ${args.dryRun ? 'would be ' : ''}dispatched`);
    if (missing.length > toDispatch.length) {
        console.log(`  ${missing.length - toDispatch.length} more commits still need benchmarking`);
    }
}

main().catch(err => {
    console.error(`\n✗ Scheduler failed: ${err.message}`);
    process.exit(1);
});
