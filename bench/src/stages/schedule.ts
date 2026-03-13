import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { type BenchContext } from '../context.js';
import { exec } from '../exec.js';
import { banner, info, debug } from '../log.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface PackEntry {
    sdkVersion: string;
    runtimeGitHash: string;
    [key: string]: unknown;
}

interface MonthIndex {
    month: string;
    commits: Array<{
        runtimeGitHash: string;
        sdkVersion: string;
        [key: string]: unknown;
    }>;
}

interface DataIndex {
    months: string[];
}

// ── Stage Entry ──────────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    banner('Schedule');

    // 1. Build the set of already-tested SDK versions from gh-pages data
    const dataDir = join(ctx.repoRoot, 'gh-pages', 'data');
    const testedSdkVersions = await buildTestedSet(dataDir, ctx.verbose);
    info(`Found ${testedSdkVersions.size} already-tested SDK versions`);

    // 2. Load pack lists from artifacts (populated by enumerate stages)
    const releasePacks = await loadPacks(join(ctx.artifactsDir, 'release-packs-list.json'));
    const dailyPacks = await loadPacks(join(ctx.artifactsDir, 'daily-packs-list.json'));

    // 3. Filter to untested packs
    const untestedReleases = releasePacks.filter(p => !testedSdkVersions.has(p.sdkVersion));
    const untestedDaily = dailyPacks.filter(p => !testedSdkVersions.has(p.sdkVersion));

    if (ctx.verbose) {
        debug(`Release packs: ${releasePacks.length} total, ${untestedReleases.length} untested`);
        debug(`Daily packs: ${dailyPacks.length} total, ${untestedDaily.length} untested`);
    }

    // 4. Priority: releases oldest→newest, then daily builds latest→oldest
    //    (release-packs-list already has newest first; daily-packs-list has newest first)
    const candidates = [
        ...untestedReleases.reverse(),   // oldest → newest
        ...untestedDaily,                 // already latest → oldest
    ];

    if (candidates.length === 0) {
        info('All packs already tested — nothing to dispatch');
        return ctx;
    }

    const toDispatch = candidates.slice(0, ctx.maxDispatches);
    info(`Will dispatch ${toDispatch.length} of ${candidates.length} untested packs`);

    // 5. Dispatch
    const repo = ctx.repo || 'pavelsavara/simple-bench';

    for (const pack of toDispatch) {
        const ghArgs = [
            'workflow', 'run', 'benchmark.yml',
            '--repo', repo,
            '--ref', ctx.branch,
            '-f', `sdk_version=${pack.sdkVersion}`,
        ];

        if (ctx.dryRun) {
            info(`[dry-run] gh ${ghArgs.join(' ')}`);
            continue;
        }

        info(`Dispatching benchmark for sdk_version=${pack.sdkVersion}`);
        await exec('gh', ghArgs);
    }

    return ctx;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildTestedSet(dataDir: string, verbose?: boolean): Promise<Set<string>> {
    const tested = new Set<string>();

    const indexPath = join(dataDir, 'index.json');
    if (!existsSync(indexPath)) {
        if (verbose) debug('No data/index.json found — treating all packs as untested');
        return tested;
    }

    const index: DataIndex = JSON.parse(await readFile(indexPath, 'utf-8'));

    for (const monthName of index.months) {
        const monthPath = join(dataDir, `${monthName}.json`);
        if (!existsSync(monthPath)) continue;

        const month: MonthIndex = JSON.parse(await readFile(monthPath, 'utf-8'));
        for (const commit of month.commits) {
            if (commit.sdkVersion) {
                tested.add(commit.sdkVersion);
            }
        }
    }

    return tested;
}

async function loadPacks(path: string): Promise<PackEntry[]> {
    if (!existsSync(path)) return [];
    const data = JSON.parse(await readFile(path, 'utf-8'));
    return (data.packs ?? []) as PackEntry[];
}
