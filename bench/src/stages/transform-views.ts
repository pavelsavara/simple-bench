import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { type BenchContext } from '../context.js';
import { banner, info, debug } from '../log.js';
import { ensureBranchCheckout } from '../lib/branch-checkout.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface MonthResultEntry {
    runtime: string;
    preset: string;
    profile: string;
    engine: string;
    app: string;
    file: string;
    metrics: Record<string, number>;
}

interface MonthCommitEntry {
    runtimeGitHash: string;
    aspnetCoreGitHash: string;
    sdkGitHash: string;
    vmrGitHash: string;
    runtimeCommitDateTime: string;
    runtimeCommitAuthor: string;
    runtimeCommitMessage: string;
    aspnetCoreCommitDateTime: string;
    aspnetCoreVersion: string;
    sdkVersion: string;
    runtimePackVersion: string;
    workloadVersion: string;
    results: MonthResultEntry[];
}

interface MonthIndex {
    month: string;
    commits: MonthCommitEntry[];
}

interface ResultFile {
    meta: {
        runtimeCommitDateTime: string;
        sdkVersion: string;
        runtimeGitHash: string;
        sdkGitHash: string;
        vmrGitHash: string;
        runtime: string;
        preset: string;
        profile: string;
        engine: string;
        app: string;
        [key: string]: unknown;
    };
    metrics: Record<string, number>;
}

interface LoadedResult {
    runtimeGitHash: string;
    aspnetCoreGitHash: string;
    sdkGitHash: string;
    vmrGitHash: string;
    runtimeCommitDateTime: string;
    runtimeCommitAuthor: string;
    runtimeCommitMessage: string;
    aspnetCoreCommitDateTime: string;
    aspnetCoreVersion: string;
    sdkVersion: string;
    runtimePackVersion: string;
    workloadVersion: string;
    rowKey: string;
    app: string;
    metrics: Record<string, number>;
}

// ── Stage Entry ──────────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    // Ensure gh-pages is checked out (measure pipeline may not run check-out-data)
    if (!ctx.dataDir) {
        await ensureBranchCheckout(ctx.repoRoot, 'gh-pages', 'gh-pages', ctx.verbose);
    }

    const dataDir = ctx.dataDir || join(ctx.repoRoot, 'gh-pages', 'data');

    await consolidateResults(ctx, dataDir);
    await buildViews(ctx, dataDir);

    return ctx;
}

// ── Phase 1: Consolidate ─────────────────────────────────────────────────────

async function consolidateResults(ctx: BenchContext, dataDir: string): Promise<void> {
    banner('Consolidate results');

    const resultsDir = ctx.artifactsInputDir || ctx.resultsDir;
    if (!resultsDir || !existsSync(resultsDir)) {
        info('No results directory — skipping consolidation');
        return;
    }

    const resultFiles = await findResultFiles(resultsDir);
    if (resultFiles.length === 0) {
        info('No result files found');
        return;
    }

    const commitGroups = new Map<string, {
        runtimeGitHash: string;
        aspnetCoreGitHash: string;
        sdkGitHash: string;
        vmrGitHash: string;
        runtimeCommitDateTime: string;
        runtimeCommitAuthor: string;
        runtimeCommitMessage: string;
        aspnetCoreCommitDateTime: string;
        aspnetCoreVersion: string;
        sdkVersion: string;
        runtimePackVersion: string;
        workloadVersion: string;
        results: { filename: string; data: ResultFile }[];
    }>();

    for (const { path: filepath, filename } of resultFiles) {
        const raw = await readFile(filepath, 'utf-8');
        const data: ResultFile = JSON.parse(raw);
        const m = data.meta;

        requireField(m.runtimeGitHash, 'runtimeGitHash', filename);
        requireField(m.runtimeCommitDateTime, 'runtimeCommitDateTime', filename);
        requireField(m.runtime, 'runtime', filename);
        requireField(m.preset, 'preset', filename);
        requireField(m.profile, 'profile', filename);
        requireField(m.engine, 'engine', filename);
        requireField(m.app, 'app', filename);
        if (!m.sdkVersion || m.sdkVersion === 'unknown') {
            throw new Error(`Missing or unknown sdkVersion in ${filename}`);
        }

        const key = m.runtimeGitHash;
        if (!commitGroups.has(key)) {
            commitGroups.set(key, {
                runtimeGitHash: m.runtimeGitHash,
                aspnetCoreGitHash: (m.aspnetCoreGitHash as string) || '',
                sdkGitHash: (m.sdkGitHash as string) || '',
                vmrGitHash: (m.vmrGitHash as string) || '',
                runtimeCommitDateTime: m.runtimeCommitDateTime,
                runtimeCommitAuthor: (m.runtimeCommitAuthor as string) || '',
                runtimeCommitMessage: (m.runtimeCommitMessage as string) || '',
                aspnetCoreCommitDateTime: (m.aspnetCoreCommitDateTime as string) || '',
                aspnetCoreVersion: (m.aspnetCoreVersion as string) || '',
                sdkVersion: m.sdkVersion,
                runtimePackVersion: (m.runtimePackVersion as string) || '',
                workloadVersion: (m.workloadVersion as string) || '',
                results: [],
            });
        }
        commitGroups.get(key)!.results.push({ filename, data });
    }

    await mkdir(dataDir, { recursive: true });

    for (const [, group] of commitGroups) {
        const date = group.runtimeCommitDateTime.slice(0, 10);
        const year = date.slice(0, 4);
        const month = date.slice(0, 7);

        const targetDir = join(dataDir, year, date);
        await mkdir(targetDir, { recursive: true });

        const indexResults: MonthResultEntry[] = [];
        for (const { filename, data } of group.results) {
            const resultPath = join(targetDir, filename);
            await writeFile(resultPath, JSON.stringify(data, null, 2), 'utf-8');
            if (ctx.verbose) debug(`  wrote ${year}/${date}/${filename}`);
            indexResults.push({
                runtime: data.meta.runtime,
                preset: data.meta.preset,
                profile: data.meta.profile,
                engine: data.meta.engine,
                app: data.meta.app,
                file: `${year}/${date}/${filename}`,
                metrics: data.metrics,
            });
        }

        const monthFile = join(dataDir, `${month}.json`);
        let monthIndex: MonthIndex;
        if (existsSync(monthFile)) {
            monthIndex = JSON.parse(await readFile(monthFile, 'utf-8'));
        } else {
            monthIndex = { month, commits: [] };
        }

        let commit = monthIndex.commits.find(c => c.runtimeGitHash === group.runtimeGitHash);
        if (!commit) {
            commit = {
                runtimeGitHash: group.runtimeGitHash,
                aspnetCoreGitHash: group.aspnetCoreGitHash,
                sdkGitHash: group.sdkGitHash,
                vmrGitHash: group.vmrGitHash,
                runtimeCommitDateTime: group.runtimeCommitDateTime,
                runtimeCommitAuthor: group.runtimeCommitAuthor,
                runtimeCommitMessage: group.runtimeCommitMessage,
                aspnetCoreCommitDateTime: group.aspnetCoreCommitDateTime,
                aspnetCoreVersion: group.aspnetCoreVersion,
                sdkVersion: group.sdkVersion,
                runtimePackVersion: group.runtimePackVersion,
                workloadVersion: group.workloadVersion,
                results: [],
            };
            monthIndex.commits.push(commit);
        }

        const existingFiles = new Set(commit.results.map(r => r.file));
        for (const r of indexResults) {
            if (!existingFiles.has(r.file)) {
                commit.results.push(r);
            }
        }

        monthIndex.commits.sort((a, b) =>
            a.runtimeCommitDateTime.localeCompare(b.runtimeCommitDateTime));

        await writeFile(monthFile, JSON.stringify(monthIndex, null, 2), 'utf-8');
        if (ctx.verbose) debug(`  wrote ${month}.json (${commit.results.length} results)`);
    }

    // Update data/index.json
    const monthNames = (await readdir(dataDir))
        .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
        .map(f => f.replace('.json', ''))
        .sort();

    const indexPath = join(dataDir, 'index.json');
    await writeFile(
        indexPath,
        JSON.stringify({ lastUpdated: new Date().toISOString(), months: monthNames }, null, 2),
        'utf-8',
    );
    if (ctx.verbose) debug(`  wrote index.json (${monthNames.length} months)`);

    info(`Consolidated ${resultFiles.length} results from ${commitGroups.size} commits`);
}

async function findResultFiles(dir: string): Promise<{ path: string; filename: string }[]> {
    const SKIP = new Set(['build-manifest.json', 'sdk-info.json', 'index.json']);
    const results: { path: string; filename: string }[] = [];

    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json') && !SKIP.has(entry.name)) {
            results.push({ path: join(dir, entry.name), filename: entry.name });
        } else if (entry.isDirectory()) {
            const sub = await findResultFiles(join(dir, entry.name));
            results.push(...sub);
        }
    }
    return results;
}

function requireField(value: unknown, name: string, filename: string): asserts value is string {
    if (!value || typeof value !== 'string') {
        throw new Error(`Missing ${name} in ${filename}`);
    }
}

// ── Phase 2: Build Views ─────────────────────────────────────────────────────

async function buildViews(ctx: BenchContext, dataDir: string): Promise<void> {
    banner('Build views');

    let monthFileNames: string[];
    try {
        monthFileNames = (await readdir(dataDir))
            .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
            .sort();
    } catch {
        info('No data directory — skipping view generation');
        return;
    }

    if (monthFileNames.length === 0) {
        info('No month indexes found — skipping view generation');
        return;
    }

    const allMonths: MonthIndex[] = [];
    for (const f of monthFileNames) {
        allMonths.push(JSON.parse(await readFile(join(dataDir, f), 'utf-8')));
    }

    const allResults: LoadedResult[] = [];
    for (const month of allMonths) {
        for (const commit of month.commits) {
            for (const result of commit.results) {
                // Skip legacy entries where metrics is a string[]
                if (Array.isArray(result.metrics)) continue;

                const profile = result.profile || 'desktop';
                allResults.push({
                    runtimeGitHash: commit.runtimeGitHash,
                    aspnetCoreGitHash: commit.aspnetCoreGitHash || '',
                    sdkGitHash: commit.sdkGitHash || '',
                    vmrGitHash: commit.vmrGitHash || '',
                    runtimeCommitDateTime: commit.runtimeCommitDateTime,
                    runtimeCommitAuthor: commit.runtimeCommitAuthor || '',
                    runtimeCommitMessage: commit.runtimeCommitMessage || '',
                    aspnetCoreCommitDateTime: commit.aspnetCoreCommitDateTime || '',
                    aspnetCoreVersion: commit.aspnetCoreVersion || '',
                    sdkVersion: commit.sdkVersion,
                    runtimePackVersion: commit.runtimePackVersion || '',
                    workloadVersion: commit.workloadVersion || '',
                    rowKey: `${result.runtime}/${result.preset}/${profile}/${result.engine}`,
                    app: result.app,
                    metrics: result.metrics,
                });
            }
        }
    }

    if (allResults.length === 0) {
        info('No results to build views from');
        return;
    }

    if (ctx.verbose) debug(`Loaded ${allResults.length} results from ${allMonths.length} months`);

    // Split results: daily builds (prerelease SDK) vs GA releases (stable SDK)
    const dailyResults = allResults.filter(r => isDailyBuild(r.sdkVersion));
    const releaseResults = allResults.filter(r => !isDailyBuild(r.sdkVersion));

    // Week views: only the highest-major daily builds
    const dailyMajors = [...new Set(dailyResults.map(r => getSdkMajor(r.sdkVersion)))];
    const activeDailyMajor = dailyMajors.length > 0 ? Math.max(...dailyMajors) : 0;
    const activeRelease = activeDailyMajor > 0 ? `net${activeDailyMajor}` : '';

    if (ctx.verbose) debug(`Active daily release: ${activeRelease || '(none)'}`);

    // Bucket results
    const weekBuckets = new Map<string, LoadedResult[]>();
    const releaseBuckets = new Map<string, LoadedResult[]>();

    for (const result of dailyResults) {
        if (getSdkMajor(result.sdkVersion) !== activeDailyMajor) continue;
        const week = getWeekMonday(result.runtimeCommitDateTime.slice(0, 10));
        if (!weekBuckets.has(week)) weekBuckets.set(week, []);
        weekBuckets.get(week)!.push(result);
    }

    for (const result of releaseResults) {
        const release = `net${getSdkMajor(result.sdkVersion)}`;
        if (!releaseBuckets.has(release)) releaseBuckets.set(release, []);
        releaseBuckets.get(release)!.push(result);
    }

    const viewsDir = join(dataDir, 'views');

    // Write week views
    const weekKeys = [...weekBuckets.keys()].sort().reverse();
    for (const week of weekKeys) {
        await writeBucketView(join(viewsDir, week), weekBuckets.get(week)!, 'week', week, ctx);
    }

    // Write release views
    const releaseKeys = [...releaseBuckets.keys()].sort();
    for (const release of releaseKeys) {
        await writeBucketView(
            join(viewsDir, 'releases', release),
            releaseBuckets.get(release)!, 'release', release, ctx,
        );
    }

    // Write global views index LAST (makes update atomic from UI perspective)
    const viewIndex = buildViewIndex(allResults, activeRelease, weekKeys, releaseKeys);
    await mkdir(viewsDir, { recursive: true });
    await writeFile(join(viewsDir, 'index.json'), JSON.stringify(viewIndex, null, 2), 'utf-8');
    if (ctx.verbose) debug(`  wrote views/index.json`);

    info(`Views: ${weekKeys.length} weeks, ${releaseKeys.length} releases`);
}

// ── Unified Bucket Writer ────────────────────────────────────────────────────

async function writeBucketView(
    dir: string,
    results: LoadedResult[],
    type: 'week' | 'release',
    label: string,
    ctx: BenchContext,
): Promise<void> {
    await mkdir(dir, { recursive: true });

    interface Column {
        runtimeGitHash: string;
        aspnetCoreGitHash: string;
        sdkGitHash: string;
        vmrGitHash: string;
        runtimeCommitDateTime: string;
        runtimeCommitAuthor: string;
        runtimeCommitMessage: string;
        aspnetCoreCommitDateTime: string;
        aspnetCoreVersion: string;
        sdkVersion: string;
        runtimePackVersion: string;
        workloadVersion: string;
    }

    const columnKey = type === 'week'
        ? (r: LoadedResult) => r.runtimeGitHash
        : (r: LoadedResult) => r.sdkVersion;

    // Deduplicate columns
    const columnMap = new Map<string, Column>();
    for (const r of results) {
        const key = columnKey(r);
        if (!columnMap.has(key)) {
            columnMap.set(key, {
                runtimeGitHash: r.runtimeGitHash,
                aspnetCoreGitHash: r.aspnetCoreGitHash,
                sdkGitHash: r.sdkGitHash,
                vmrGitHash: r.vmrGitHash,
                runtimeCommitDateTime: r.runtimeCommitDateTime,
                runtimeCommitAuthor: r.runtimeCommitAuthor,
                runtimeCommitMessage: r.runtimeCommitMessage,
                aspnetCoreCommitDateTime: r.aspnetCoreCommitDateTime,
                aspnetCoreVersion: r.aspnetCoreVersion,
                sdkVersion: r.sdkVersion,
                runtimePackVersion: r.runtimePackVersion,
                workloadVersion: r.workloadVersion,
            });
        }
    }

    // Sort columns
    const columns: Column[] = type === 'week'
        ? [...columnMap.values()].sort((a, b) =>
            a.runtimeCommitDateTime.localeCompare(b.runtimeCommitDateTime))
        : [...columnMap.values()].sort((a, b) =>
            compareSdkVersion(a.sdkVersion, b.sdkVersion));

    const colIndex = new Map(columns.map((c, i) => [
        type === 'week' ? c.runtimeGitHash : c.sdkVersion, i,
    ]));

    // Build grid: app → metric → rowKey → values[]
    // For build-time and size metrics, only keep chrome/desktop to avoid redundant rows
    const BUILD_SIZE_METRICS = new Set([
        'compile-time', 'disk-size-native',
        'disk-size-assemblies', 'download-size-total',
    ]);
    const grid = new Map<string, Map<string, Map<string, (number | null)[]>>>();

    for (const r of results) {
        const ci = colIndex.get(columnKey(r))!;
        for (const [metricKey, value] of Object.entries(r.metrics)) {
            // Only include chrome/desktop for build-time and size metrics
            if (BUILD_SIZE_METRICS.has(metricKey) && !r.rowKey.endsWith('/desktop/chrome')) continue;

            if (!grid.has(r.app)) grid.set(r.app, new Map());
            const metricMap = grid.get(r.app)!;
            if (!metricMap.has(metricKey)) metricMap.set(metricKey, new Map());
            const rowMap = metricMap.get(metricKey)!;
            if (!rowMap.has(r.rowKey)) {
                rowMap.set(r.rowKey, new Array(columns.length).fill(null));
            }
            rowMap.get(r.rowKey)![ci] = Math.round(value);
        }
    }

    // Write data files and collect app manifest
    const appsManifest: Record<string, string[]> = {};

    for (const [app, metricMap] of grid) {
        const metricKeys: string[] = [];
        for (const [metricKey, rowMap] of metricMap) {
            const data: Record<string, (number | null)[]> = {};
            for (const [rowKey, values] of rowMap) {
                if (values.some(v => v !== null)) {
                    data[rowKey] = values;
                }
            }
            if (Object.keys(data).length > 0) {
                const dataFile = `${app}_${metricKey}.json`;
                await writeFile(join(dir, dataFile), JSON.stringify(data), 'utf-8');
                if (ctx.verbose) debug(`  wrote ${dataFile}`);
                metricKeys.push(metricKey);
            }
        }
        if (metricKeys.length > 0) {
            appsManifest[app] = metricKeys.sort();
        }
    }

    // Write header AFTER data files
    const header: Record<string, unknown> = { columns, apps: appsManifest };
    if (type === 'week') header.week = label;
    else header.release = label;

    await writeFile(join(dir, 'header.json'), JSON.stringify(header), 'utf-8');
    if (ctx.verbose) debug(`  wrote header.json`);

    if (ctx.verbose) {
        debug(`${type} ${label}: ${columns.length} cols, ${Object.keys(appsManifest).length} apps`);
    }
}

// ── View Index Builder ───────────────────────────────────────────────────────

function buildViewIndex(
    results: LoadedResult[],
    activeRelease: string,
    weeks: string[],
    releases: string[],
): Record<string, unknown> {
    const apps = new Set<string>();
    const runtimes = new Set<string>();
    const presets = new Set<string>();
    const profiles = new Set<string>();
    const engines = new Set<string>();
    const appMetrics = new Map<string, Set<string>>();

    for (const r of results) {
        apps.add(r.app);
        const [runtime, preset, profile, engine] = r.rowKey.split('/');
        runtimes.add(runtime);
        presets.add(preset);
        profiles.add(profile);
        engines.add(engine);

        if (!appMetrics.has(r.app)) appMetrics.set(r.app, new Set());
        for (const key of Object.keys(r.metrics)) {
            appMetrics.get(r.app)!.add(key);
        }
    }

    const metrics: Record<string, string[]> = {};
    for (const [app, metricSet] of appMetrics) {
        metrics[app] = [...metricSet].sort();
    }

    return {
        lastUpdated: new Date().toISOString(),
        activeRelease,
        releases,
        weeks,
        apps: [...apps].sort(),
        metrics,
        dimensions: {
            runtimes: [...runtimes].sort(),
            presets: [...presets].sort(),
            profiles: [...profiles].sort(),
            engines: [...engines].sort(),
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isDailyBuild(sdkVersion: string): boolean {
    return sdkVersion.includes('-');
}

function getSdkMajor(sdkVersion: string): number {
    const major = parseInt(sdkVersion.split('.')[0], 10);
    if (!Number.isFinite(major)) {
        throw new Error(`Cannot parse SDK major version from '${sdkVersion}'`);
    }
    return major;
}

function getWeekMonday(dateStr: string): string {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString().slice(0, 10);
}

function compareSdkVersion(a: string, b: string): number {
    const parse = (v: string) => {
        const dashIdx = v.indexOf('-');
        const mainPart = dashIdx === -1 ? v : v.slice(0, dashIdx);
        const pre = dashIdx === -1 ? '' : v.slice(dashIdx + 1);
        const [major, minor, patch] = mainPart.split('.').map(Number);
        const preOrder = pre === '' ? 2 : pre.startsWith('rc') ? 1 : 0;
        return { major, minor, patch, preOrder, pre };
    };
    const pa = parse(a), pb = parse(b);
    return (pa.major - pb.major)
        || (pa.minor - pb.minor)
        || (pa.patch - pb.patch)
        || (pa.preOrder - pb.preOrder)
        || pa.pre.localeCompare(pb.pre);
}
