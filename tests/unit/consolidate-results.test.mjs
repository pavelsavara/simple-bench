import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    parseResultJson,
    computeResultFilename,
    computeResultRelPath,
    computeMonthKey,
    createEmptyMonthIndex,
    buildMonthResultEntry,
    upsertResult,
    sortMonthCommits,
    rebuildTopLevelIndex,
    findJsonFiles,
    consolidate,
} from '../../scripts/consolidate-results.mjs';

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeMeta(overrides = {}) {
    return {
        commitDate: '2026-03-02',
        commitTime: '12-34-56-UTC',
        sdkVersion: '11.0.100-preview.3.26061.1',
        runtimeGitHash: 'abc1234def5678abc1234def5678abc1234def567',
        sdkGitHash: '1111111222222233333334444444555555566666ab',
        vmrGitHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee555566',
        runtime: 'coreclr',
        preset: 'no-workload',
        engine: 'chrome',
        app: 'empty-browser',
        ciRunId: '12345678',
        ciRunUrl: 'https://github.com/test/simple-bench/actions/runs/12345678',
        ...overrides,
    };
}

function makeResult(metaOverrides = {}, metrics = null) {
    return {
        meta: makeMeta(metaOverrides),
        metrics: metrics || {
            'compile-time': 45200,
            'disk-size-total': 15046484,
            'disk-size-wasm': 8187744,
            'disk-size-dlls': 1758720,
            'download-size-total': 12100920,
            'time-to-reach-managed': 289.15,
            'time-to-reach-managed-cold': 7446,
            'memory-peak': 45000000,
        },
    };
}

// ── parseResultJson ─────────────────────────────────────────────────────────

describe('parseResultJson', () => {
    it('parses a valid result JSON string', () => {
        const result = makeResult();
        const parsed = parseResultJson(JSON.stringify(result));
        assert.deepEqual(parsed, result);
    });

    it('returns null for invalid JSON', () => {
        assert.equal(parseResultJson('not json'), null);
    });

    it('returns null for JSON without meta', () => {
        assert.equal(parseResultJson(JSON.stringify({ metrics: {} })), null);
    });

    it('returns null for JSON without metrics', () => {
        assert.equal(parseResultJson(JSON.stringify({ meta: makeMeta() })), null);
    });

    it('returns null for meta missing required fields', () => {
        const bad = makeResult();
        delete bad.meta.commitDate;
        assert.equal(parseResultJson(JSON.stringify(bad)), null);
    });

    it('returns null for compile-time.json (no meta/metrics)', () => {
        const compileTime = { compileTimeMs: 45200, app: 'empty-browser', runtime: 'coreclr', preset: 'no-workload' };
        assert.equal(parseResultJson(JSON.stringify(compileTime)), null);
    });

    it('returns null for non-hex runtimeGitHash like "unknown"', () => {
        const bad = makeResult({ runtimeGitHash: 'unknown' });
        assert.equal(parseResultJson(JSON.stringify(bad)), null);
    });
});

// ── computeResultFilename ───────────────────────────────────────────────────

describe('computeResultFilename', () => {
    it('builds canonical filename from meta', () => {
        const meta = makeMeta();
        assert.equal(
            computeResultFilename(meta),
            '12-34-56-UTC_abc1234_coreclr_no-workload_desktop_chrome_empty-browser.json'
        );
    });

    it('truncates runtime git hash to 7 chars', () => {
        const meta = makeMeta({ runtimeGitHash: '0123456789abcdef0123456789abcdef01234567' });
        assert.ok(computeResultFilename(meta).includes('0123456'));
        assert.ok(!computeResultFilename(meta).includes('01234567'));
    });

    it('includes profile in filename', () => {
        const meta = makeMeta({ profile: 'mobile' });
        assert.ok(computeResultFilename(meta).includes('_mobile_'));
    });

    it('defaults to desktop when profile is missing', () => {
        const meta = makeMeta();
        delete meta.profile;
        assert.ok(computeResultFilename(meta).includes('_desktop_'));
    });
});

// ── computeResultRelPath ────────────────────────────────────────────────────

describe('computeResultRelPath', () => {
    it('builds relative path with year/date/filename', () => {
        const meta = makeMeta();
        assert.equal(
            computeResultRelPath(meta),
            '2026/2026-03-02/12-34-56-UTC_abc1234_coreclr_no-workload_desktop_chrome_empty-browser.json'
        );
    });

    it('handles different years', () => {
        const meta = makeMeta({ commitDate: '2027-01-15' });
        assert.ok(computeResultRelPath(meta).startsWith('2027/2027-01-15/'));
    });
});

// ── computeMonthKey ─────────────────────────────────────────────────────────

describe('computeMonthKey', () => {
    it('extracts YYYY-MM from date', () => {
        assert.equal(computeMonthKey('2026-03-02'), '2026-03');
    });

    it('handles end of year', () => {
        assert.equal(computeMonthKey('2026-12-31'), '2026-12');
    });
});

// ── createEmptyMonthIndex ───────────────────────────────────────────────────

describe('createEmptyMonthIndex', () => {
    it('creates index with month and empty commits', () => {
        const idx = createEmptyMonthIndex('2026-03');
        assert.deepEqual(idx, { month: '2026-03', commits: [] });
    });
});

// ── buildMonthResultEntry ───────────────────────────────────────────────────

describe('buildMonthResultEntry', () => {
    it('builds entry with dimensions, file path, and metric keys', () => {
        const result = makeResult();
        const entry = buildMonthResultEntry(result.meta, result.metrics);
        assert.equal(entry.runtime, 'coreclr');
        assert.equal(entry.preset, 'no-workload');
        assert.equal(entry.profile, 'desktop');
        assert.equal(entry.engine, 'chrome');
        assert.equal(entry.app, 'empty-browser');
        assert.ok(entry.file.includes('2026/2026-03-02/'));
        assert.ok(entry.metrics.includes('compile-time'));
        assert.ok(entry.metrics.includes('disk-size-total'));
        assert.equal(entry.metrics.length, 8);
    });
});

// ── upsertResult ────────────────────────────────────────────────────────────

describe('upsertResult', () => {
    it('adds a new commit entry to empty month index', () => {
        const mi = createEmptyMonthIndex('2026-03');
        const result = makeResult();
        upsertResult(mi, result);
        assert.equal(mi.commits.length, 1);
        assert.equal(mi.commits[0].runtimeGitHash, result.meta.runtimeGitHash);
        assert.equal(mi.commits[0].results.length, 1);
    });

    it('adds result to existing commit entry', () => {
        const mi = createEmptyMonthIndex('2026-03');
        const result1 = makeResult();
        const result2 = makeResult({ runtime: 'mono' });
        upsertResult(mi, result1);
        upsertResult(mi, result2);
        assert.equal(mi.commits.length, 1);
        assert.equal(mi.commits[0].results.length, 2);
    });

    it('replaces result with same dimensions', () => {
        const mi = createEmptyMonthIndex('2026-03');
        const result1 = makeResult({}, { 'compile-time': 45200 });
        const result2 = makeResult({}, { 'compile-time': 50000 });
        upsertResult(mi, result1);
        upsertResult(mi, result2);
        assert.equal(mi.commits.length, 1);
        assert.equal(mi.commits[0].results.length, 1);
        // Metrics list should reflect the replacement
        assert.deepEqual(mi.commits[0].results[0].metrics, ['compile-time']);
    });

    it('treats different profiles as different results', () => {
        const mi = createEmptyMonthIndex('2026-03');
        const result1 = makeResult({ profile: 'desktop' });
        const result2 = makeResult({ profile: 'mobile' });
        upsertResult(mi, result1);
        upsertResult(mi, result2);
        assert.equal(mi.commits.length, 1);
        assert.equal(mi.commits[0].results.length, 2);
    });

    it('creates separate commit entries for different hashes', () => {
        const mi = createEmptyMonthIndex('2026-03');
        const result1 = makeResult();
        const result2 = makeResult({
            runtimeGitHash: 'def5678abc1234def5678abc1234def5678abc123',
            commitDate: '2026-03-15',
            commitTime: '08-12-00-UTC',
        });
        upsertResult(mi, result1);
        upsertResult(mi, result2);
        assert.equal(mi.commits.length, 2);
    });
});

// ── sortMonthCommits ────────────────────────────────────────────────────────

describe('sortMonthCommits', () => {
    it('sorts commits by date then time', () => {
        const mi = {
            month: '2026-03',
            commits: [
                { runtimeGitHash: 'b', date: '2026-03-15', time: '08-12-00-UTC', sdkVersion: '', results: [] },
                { runtimeGitHash: 'a', date: '2026-03-02', time: '12-34-56-UTC', sdkVersion: '', results: [] },
                { runtimeGitHash: 'c', date: '2026-03-02', time: '06-00-00-UTC', sdkVersion: '', results: [] },
            ],
        };
        sortMonthCommits(mi);
        assert.equal(mi.commits[0].runtimeGitHash, 'c');
        assert.equal(mi.commits[1].runtimeGitHash, 'a');
        assert.equal(mi.commits[2].runtimeGitHash, 'b');
    });

    it('handles empty commits array', () => {
        const mi = { month: '2026-03', commits: [] };
        sortMonthCommits(mi);
        assert.equal(mi.commits.length, 0);
    });
});

// ── rebuildTopLevelIndex ────────────────────────────────────────────────────

describe('rebuildTopLevelIndex', () => {
    it('derives dimensions from month indexes', () => {
        const months = new Set(['2026-03']);
        const mi = {
            month: '2026-03',
            commits: [{
                runtimeGitHash: 'abc', date: '2026-03-02', time: '12-34-56-UTC', sdkVersion: '11.0.0',
                results: [
                    { runtime: 'coreclr', preset: 'no-workload', profile: 'desktop', engine: 'chrome', app: 'empty-browser', file: '', metrics: [] },
                    { runtime: 'mono', preset: 'aot', profile: 'desktop', engine: 'chrome', app: 'empty-browser', file: '', metrics: [] },
                ],
            }],
        };
        const idx = rebuildTopLevelIndex(months, [mi]);
        assert.deepEqual(idx.months, ['2026-03']);
        assert.deepEqual(idx.dimensions.runtimes, ['coreclr', 'mono']);
        assert.deepEqual(idx.dimensions.presets, ['aot', 'no-workload']);
        assert.deepEqual(idx.dimensions.profiles, ['desktop']);
        assert.deepEqual(idx.dimensions.engines, ['chrome']);
        assert.deepEqual(idx.dimensions.apps, ['empty-browser']);
        assert.ok(idx.lastUpdated);
    });

    it('sorts months chronologically', () => {
        const months = new Set(['2026-03', '2026-01', '2026-02']);
        const idx = rebuildTopLevelIndex(months, []);
        assert.deepEqual(idx.months, ['2026-01', '2026-02', '2026-03']);
    });

    it('handles empty data', () => {
        const idx = rebuildTopLevelIndex(new Set(), []);
        assert.deepEqual(idx.months, []);
        assert.deepEqual(idx.dimensions.runtimes, []);
    });
});

// ── findJsonFiles ───────────────────────────────────────────────────────────

describe('findJsonFiles', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `bench-consolidate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('finds JSON files in nested artifact directories', async () => {
        // Simulate download-artifact structure: each artifact in its own subdirectory
        const artifactDir = join(tmpDir, 'result_coreclr_no-workload_chrome_empty-browser');
        await mkdir(artifactDir, { recursive: true });
        await writeFile(join(artifactDir, 'result.json'), '{}');
        await writeFile(join(artifactDir, 'compile-time.json'), '{}');

        const files = await findJsonFiles(tmpDir);
        assert.equal(files.length, 2);
    });

    it('returns empty array for empty directory', async () => {
        const files = await findJsonFiles(tmpDir);
        assert.equal(files.length, 0);
    });

    it('ignores non-JSON files', async () => {
        await writeFile(join(tmpDir, 'readme.txt'), 'hello');
        await writeFile(join(tmpDir, 'data.json'), '{}');
        const files = await findJsonFiles(tmpDir);
        assert.equal(files.length, 1);
    });
});

// ── consolidate (integration) ───────────────────────────────────────────────

describe('consolidate', () => {
    let tmpDir;
    let artifactsDir;
    let dataDir;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `bench-consolidate-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        artifactsDir = join(tmpDir, 'artifacts');
        dataDir = join(tmpDir, 'data');
        await mkdir(artifactsDir, { recursive: true });
        await mkdir(dataDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('processes a single result file end-to-end', async () => {
        const result = makeResult();
        const artifactSubDir = join(artifactsDir, 'result_coreclr_no-workload_chrome_empty-browser');
        await mkdir(artifactSubDir, { recursive: true });
        await writeFile(join(artifactSubDir, 'result.json'), JSON.stringify(result));

        const { processed, skipped } = await consolidate(artifactsDir, dataDir);
        assert.equal(processed, 1);
        assert.equal(skipped, 0);

        // Verify result file was placed correctly
        const expectedPath = join(dataDir, '2026', '2026-03-02',
            '12-34-56-UTC_abc1234_coreclr_no-workload_desktop_chrome_empty-browser.json');
        const placed = JSON.parse(await readFile(expectedPath, 'utf-8'));
        assert.equal(placed.meta.runtime, 'coreclr');

        // Verify month index
        const monthIndex = JSON.parse(await readFile(join(dataDir, '2026-03.json'), 'utf-8'));
        assert.equal(monthIndex.month, '2026-03');
        assert.equal(monthIndex.commits.length, 1);
        assert.equal(monthIndex.commits[0].results.length, 1);

        // Verify top-level index
        const topIndex = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf-8'));
        assert.deepEqual(topIndex.months, ['2026-03']);
        assert.ok(topIndex.dimensions.runtimes.includes('coreclr'));
    });

    it('processes multiple results for the same commit', async () => {
        const result1 = makeResult();
        const result2 = makeResult({ runtime: 'mono', preset: 'aot' });

        const dir1 = join(artifactsDir, 'result_coreclr_no-workload_chrome_empty-browser');
        const dir2 = join(artifactsDir, 'result_mono_aot_chrome_empty-browser');
        await mkdir(dir1, { recursive: true });
        await mkdir(dir2, { recursive: true });
        await writeFile(join(dir1, 'result.json'), JSON.stringify(result1));
        await writeFile(join(dir2, 'result.json'), JSON.stringify(result2));

        const { processed } = await consolidate(artifactsDir, dataDir);
        assert.equal(processed, 2);

        const monthIndex = JSON.parse(await readFile(join(dataDir, '2026-03.json'), 'utf-8'));
        assert.equal(monthIndex.commits.length, 1);
        assert.equal(monthIndex.commits[0].results.length, 2);
    });

    it('skips non-result JSON files (compile-time.json)', async () => {
        const result = makeResult();
        const dir = join(artifactsDir, 'result_coreclr_no-workload_chrome_empty-browser');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'result.json'), JSON.stringify(result));
        await writeFile(join(dir, 'compile-time.json'), JSON.stringify({
            compileTimeMs: 45200, app: 'empty-browser', runtime: 'coreclr', preset: 'no-workload',
        }));

        const { processed, skipped } = await consolidate(artifactsDir, dataDir);
        assert.equal(processed, 1);
        assert.equal(skipped, 1);
    });

    it('merges into existing month index', async () => {
        // Pre-populate month index with an existing commit
        const existingMi = {
            month: '2026-03',
            commits: [{
                runtimeGitHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                date: '2026-03-01',
                time: '00-00-00-UTC',
                sdkVersion: '11.0.100-preview.3.26060.1',
                results: [{
                    runtime: 'coreclr', preset: 'no-workload', profile: 'desktop', engine: 'chrome', app: 'empty-browser',
                    file: '2026/2026-03-01/00-00-00-UTC_aaaaaaa_coreclr_no-workload_desktop_chrome_empty-browser.json',
                    metrics: ['compile-time'],
                }],
            }],
        };
        await writeFile(join(dataDir, '2026-03.json'), JSON.stringify(existingMi));
        await writeFile(join(dataDir, 'index.json'), JSON.stringify({ months: ['2026-03'], lastUpdated: null, dimensions: {} }));

        const result = makeResult();
        const dir = join(artifactsDir, 'result_coreclr_no-workload_chrome_empty-browser');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'result.json'), JSON.stringify(result));

        await consolidate(artifactsDir, dataDir);

        const monthIndex = JSON.parse(await readFile(join(dataDir, '2026-03.json'), 'utf-8'));
        assert.equal(monthIndex.commits.length, 2);
        // Verify sorted: 2026-03-01 before 2026-03-02
        assert.equal(monthIndex.commits[0].date, '2026-03-01');
        assert.equal(monthIndex.commits[1].date, '2026-03-02');
    });

    it('replaces duplicate result for same commit + dimensions', async () => {
        const result1 = makeResult({}, { 'compile-time': 45000 });
        const dir1 = join(artifactsDir, 'run1');
        await mkdir(dir1, { recursive: true });
        await writeFile(join(dir1, 'result.json'), JSON.stringify(result1));

        await consolidate(artifactsDir, dataDir);

        // Now consolidate again with updated value
        const artifactsDir2 = join(tmpDir, 'artifacts2');
        const result2 = makeResult({}, { 'compile-time': 50000 });
        const dir2 = join(artifactsDir2, 'run2');
        await mkdir(dir2, { recursive: true });
        await writeFile(join(dir2, 'result.json'), JSON.stringify(result2));

        await consolidate(artifactsDir2, dataDir);

        const monthIndex = JSON.parse(await readFile(join(dataDir, '2026-03.json'), 'utf-8'));
        assert.equal(monthIndex.commits.length, 1);
        assert.equal(monthIndex.commits[0].results.length, 1);
    });

    it('handles results across multiple months', async () => {
        const result1 = makeResult({ commitDate: '2026-03-02' });
        const result2 = makeResult({
            commitDate: '2026-04-15',
            commitTime: '08-00-00-UTC',
            runtimeGitHash: 'def5678abc1234def5678abc1234def5678abc123',
        });

        const dir1 = join(artifactsDir, 'r1');
        const dir2 = join(artifactsDir, 'r2');
        await mkdir(dir1, { recursive: true });
        await mkdir(dir2, { recursive: true });
        await writeFile(join(dir1, 'result.json'), JSON.stringify(result1));
        await writeFile(join(dir2, 'result.json'), JSON.stringify(result2));

        await consolidate(artifactsDir, dataDir);

        const topIndex = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf-8'));
        assert.deepEqual(topIndex.months, ['2026-03', '2026-04']);

        // Both month indexes should exist
        const mi3 = JSON.parse(await readFile(join(dataDir, '2026-03.json'), 'utf-8'));
        const mi4 = JSON.parse(await readFile(join(dataDir, '2026-04.json'), 'utf-8'));
        assert.equal(mi3.commits.length, 1);
        assert.equal(mi4.commits.length, 1);
    });

    it('handles empty artifacts directory', async () => {
        const { processed, skipped } = await consolidate(artifactsDir, dataDir);
        assert.equal(processed, 0);
        assert.equal(skipped, 0);

        // Should still write index.json
        const topIndex = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf-8'));
        assert.deepEqual(topIndex.months, []);
    });

    it('preserves existing months in index when adding new ones', async () => {
        // Pre-populate with an existing month
        await writeFile(join(dataDir, 'index.json'), JSON.stringify({
            months: ['2026-01'], lastUpdated: null, dimensions: {},
        }));
        await writeFile(join(dataDir, '2026-01.json'), JSON.stringify({
            month: '2026-01', commits: [{
                runtimeGitHash: 'aaa', date: '2026-01-10', time: '10-00-00-UTC', sdkVersion: '11.0.0',
                results: [{ runtime: 'coreclr', preset: 'no-workload', profile: 'desktop', engine: 'chrome', app: 'empty-browser', file: '', metrics: [] }],
            }],
        }));

        const result = makeResult();
        const dir = join(artifactsDir, 'r1');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'result.json'), JSON.stringify(result));

        await consolidate(artifactsDir, dataDir);

        const topIndex = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf-8'));
        assert.deepEqual(topIndex.months, ['2026-01', '2026-03']);
    });
});
