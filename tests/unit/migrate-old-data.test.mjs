import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    FLAVOR_MAP,
    TIMEOUT_THRESHOLD,
    MEASUREMENT_IDS,
    parseCommitTime,
    extractBrowserMetrics,
    extractBlazorMetrics,
    buildMigratedResult,
    convertEntry,
    migrate,
} from '../../scripts/migrate-old-data.mjs';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeIndexEntry(overrides = {}) {
    return {
        hash: 'abc1234def5678abc1234def5678abc1234def5678',
        flavorId: 0,  // aot.default.chrome
        commitTime: '2023-06-15T14:23:45+00:00',
        minTimes: {
            1: 459.85,    // Reach managed
            60: 7446.0,   // Reach managed cold
        },
        sizes: {
            24: 12100920, // AppBundle
            25: 1758720,  // managed
            26: 8187744,  // dotnet.wasm
        },
        ...overrides,
    };
}

function makeIndex(entries) {
    return {
        FlavorMap: {
            'aot.default.chrome': 0,
            'aot.default.firefox': 1,
            'interp.default.chrome': 2,
            'interp.default.firefox': 3,
            'aot.simd+wasm-eh.chrome': 9,
        },
        MeasurementMap: {
            'AppStart, Reach managed': 1,
            'AppStart, Reach managed cold': 60,
            'AppStart, Browser Reach managed': 101,
            'AppStart, Browser Reach managed cold': 102,
            'AppStart, Blazor Reach managed': 97,
            'AppStart, Blazor Reach managed cold': 98,
            'Size, AppBundle': 24,
            'Size, managed': 25,
            'Size, dotnet.wasm': 26,
            'Size, dotnet.native.wasm': 76,
        },
        Data: entries,
    };
}

// ── parseCommitTime ─────────────────────────────────────────────────────────

describe('parseCommitTime', () => {
    it('converts UTC time correctly', () => {
        const { commitDate, commitTime } = parseCommitTime('2023-06-15T14:23:45+00:00');
        assert.equal(commitDate, '2023-06-15');
        assert.equal(commitTime, '14-23-45-UTC');
    });

    it('converts positive timezone offset to UTC', () => {
        const { commitDate, commitTime } = parseCommitTime('2022-10-14T00:51:15+02:00');
        assert.equal(commitDate, '2022-10-13');
        assert.equal(commitTime, '22-51-15-UTC');
    });

    it('converts negative timezone offset to UTC', () => {
        const { commitDate, commitTime } = parseCommitTime('2023-03-01T20:30:00-07:00');
        assert.equal(commitDate, '2023-03-02');
        assert.equal(commitTime, '03-30-00-UTC');
    });

    it('handles midnight UTC', () => {
        const { commitDate, commitTime } = parseCommitTime('2023-01-01T00:00:00+00:00');
        assert.equal(commitDate, '2023-01-01');
        assert.equal(commitTime, '00-00-00-UTC');
    });

    it('pads single-digit values', () => {
        const { commitDate, commitTime } = parseCommitTime('2022-03-05T03:02:01+00:00');
        assert.equal(commitDate, '2022-03-05');
        assert.equal(commitTime, '03-02-01-UTC');
    });
});

// ── extractBrowserMetrics ───────────────────────────────────────────────────

describe('extractBrowserMetrics', () => {
    it('extracts timing from unprefixed Reach managed (id 1/60)', () => {
        const metrics = extractBrowserMetrics(
            { 1: 350.5, 60: 7200.0 },
            { 24: 12000000 }
        );
        assert.equal(metrics['time-to-reach-managed'], 350.5);
        assert.equal(metrics['time-to-reach-managed-cold'], 7200.0);
        assert.equal(metrics['download-size-total'], 12000000);
    });

    it('prefers Browser-prefixed (id 101/102) over unprefixed', () => {
        const metrics = extractBrowserMetrics(
            { 1: 450.0, 60: 8000.0, 101: 340.0, 102: 6500.0 },
            {}
        );
        assert.equal(metrics['time-to-reach-managed'], 340.0);
        assert.equal(metrics['time-to-reach-managed-cold'], 6500.0);
    });

    it('falls back to unprefixed when Browser-prefixed missing', () => {
        const metrics = extractBrowserMetrics(
            { 1: 450.0, 60: 8000.0 },
            {}
        );
        assert.equal(metrics['time-to-reach-managed'], 450.0);
        assert.equal(metrics['time-to-reach-managed-cold'], 8000.0);
    });

    it('extracts all three size metrics', () => {
        const metrics = extractBrowserMetrics(
            { 1: 350.0 },
            { 24: 12000000, 25: 1750000, 26: 8000000 }
        );
        assert.equal(metrics['download-size-total'], 12000000);
        assert.equal(metrics['download-size-dlls'], 1750000);
        assert.equal(metrics['download-size-wasm'], 8000000);
    });

    it('prefers dotnet.native.wasm (id 76) over dotnet.wasm (id 26)', () => {
        const metrics = extractBrowserMetrics(
            { 1: 350.0 },
            { 26: 8000000, 76: 7500000 }
        );
        assert.equal(metrics['download-size-wasm'], 7500000);
    });

    it('falls back to dotnet.wasm (id 26) when native.wasm missing', () => {
        const metrics = extractBrowserMetrics(
            { 1: 350.0 },
            { 26: 8000000 }
        );
        assert.equal(metrics['download-size-wasm'], 8000000);
    });

    it('filters out timeout values >= 20000', () => {
        const metrics = extractBrowserMetrics(
            { 1: 20006.0, 60: 20007.0 },
            {}
        );
        assert.equal(metrics, null);
    });

    it('filters timeout on one metric but keeps the other', () => {
        const metrics = extractBrowserMetrics(
            { 1: 350.0, 60: 20006.0 },
            {}
        );
        assert.equal(metrics['time-to-reach-managed'], 350.0);
        assert.equal(metrics['time-to-reach-managed-cold'], undefined);
    });

    it('returns null when no metrics found', () => {
        assert.equal(extractBrowserMetrics({}, {}), null);
        assert.equal(extractBrowserMetrics(null, null), null);
    });

    it('handles sizes without timing', () => {
        const metrics = extractBrowserMetrics(null, { 24: 12000000 });
        assert.equal(metrics['download-size-total'], 12000000);
        assert.equal(metrics['time-to-reach-managed'], undefined);
    });
});

// ── extractBlazorMetrics ────────────────────────────────────────────────────

describe('extractBlazorMetrics', () => {
    it('extracts Blazor timing (id 97/98)', () => {
        const metrics = extractBlazorMetrics(
            { 97: 520.0, 98: 9500.0 },
            {}
        );
        assert.equal(metrics['time-to-reach-managed'], 520.0);
        assert.equal(metrics['time-to-reach-managed-cold'], 9500.0);
    });

    it('filters out Blazor timeout values', () => {
        const metrics = extractBlazorMetrics(
            { 97: 20006.0, 98: 20007.0 },
            {}
        );
        assert.equal(metrics, null);
    });

    it('returns null when no Blazor metrics present', () => {
        // Entry with only browser metrics (no Blazor)
        assert.equal(extractBlazorMetrics({ 1: 350.0 }, {}), null);
    });
});

// ── buildMigratedResult ─────────────────────────────────────────────────────

describe('buildMigratedResult', () => {
    it('builds result with correct meta fields', () => {
        const result = buildMigratedResult(
            '2023-06-15', '14-23-45-UTC',
            'abc1234def5678abc1234def5678abc1234def5678',
            'mono', 'aot', 'chrome', 'empty-browser',
            { 'time-to-reach-managed': 350.0 }
        );
        assert.equal(result.meta.commitDate, '2023-06-15');
        assert.equal(result.meta.commitTime, '14-23-45-UTC');
        assert.equal(result.meta.sdkVersion, 'unknown');
        assert.equal(result.meta.runtime, 'mono');
        assert.equal(result.meta.preset, 'aot');
        assert.equal(result.meta.engine, 'chrome');
        assert.equal(result.meta.app, 'empty-browser');
        assert.equal(result.meta.ciRunId, 'migrated');
        assert.ok(result.meta.ciRunUrl.includes('WasmPerformanceMeasurements'));
        assert.equal(result.metrics['time-to-reach-managed'], 350.0);
    });
});

// ── convertEntry ────────────────────────────────────────────────────────────

describe('convertEntry', () => {
    it('converts aot.default.chrome entry to browser result', () => {
        const entry = makeIndexEntry();
        const results = convertEntry(entry);
        assert.equal(results.length, 1);
        assert.equal(results[0].meta.runtime, 'mono');
        assert.equal(results[0].meta.preset, 'aot');
        assert.equal(results[0].meta.engine, 'chrome');
        assert.equal(results[0].meta.app, 'empty-browser');
    });

    it('converts interp.default.firefox entry', () => {
        const entry = makeIndexEntry({ flavorId: 3 });
        const results = convertEntry(entry);
        assert.equal(results.length, 1);
        assert.equal(results[0].meta.runtime, 'mono');
        assert.equal(results[0].meta.preset, 'no-workload');
        assert.equal(results[0].meta.engine, 'firefox');
    });

    it('produces both browser and blazor results when both metrics present', () => {
        const entry = makeIndexEntry({
            minTimes: { 1: 350.0, 60: 7200.0, 97: 520.0, 98: 9500.0 },
        });
        const results = convertEntry(entry);
        assert.equal(results.length, 2);
        const apps = results.map(r => r.meta.app).sort();
        assert.deepEqual(apps, ['empty-blazor', 'empty-browser']);
    });

    it('skips unknown flavor IDs', () => {
        const entry = makeIndexEntry({ flavorId: 9 }); // aot.simd+wasm-eh.chrome
        assert.deepEqual(convertEntry(entry), []);
    });

    it('skips entry with all timeout values', () => {
        const entry = makeIndexEntry({
            minTimes: { 1: 20006.0, 60: 20007.0 },
            sizes: {},
        });
        assert.deepEqual(convertEntry(entry), []);
    });

    it('handles entry with sizes but no timing', () => {
        const entry = makeIndexEntry({
            minTimes: {},
            sizes: { 24: 12000000, 25: 1750000, 26: 8000000 },
        });
        const results = convertEntry(entry);
        assert.equal(results.length, 1);
        assert.equal(results[0].meta.app, 'empty-browser');
        assert.equal(results[0].metrics['download-size-total'], 12000000);
        assert.equal(results[0].metrics['time-to-reach-managed'], undefined);
    });

    it('converts commitTime timezone to UTC date', () => {
        const entry = makeIndexEntry({ commitTime: '2022-10-14T00:51:15+02:00' });
        const results = convertEntry(entry);
        assert.equal(results[0].meta.commitDate, '2022-10-13');
        assert.equal(results[0].meta.commitTime, '22-51-15-UTC');
    });
});

// ── FLAVOR_MAP ──────────────────────────────────────────────────────────────

describe('FLAVOR_MAP', () => {
    it('maps flavor 0 to aot chrome', () => {
        assert.deepEqual(FLAVOR_MAP[0], { runtime: 'mono', preset: 'aot', engine: 'chrome' });
    });

    it('maps flavor 1 to aot firefox', () => {
        assert.deepEqual(FLAVOR_MAP[1], { runtime: 'mono', preset: 'aot', engine: 'firefox' });
    });

    it('maps flavor 2 to no-workload chrome', () => {
        assert.deepEqual(FLAVOR_MAP[2], { runtime: 'mono', preset: 'no-workload', engine: 'chrome' });
    });

    it('maps flavor 3 to no-workload firefox', () => {
        assert.deepEqual(FLAVOR_MAP[3], { runtime: 'mono', preset: 'no-workload', engine: 'firefox' });
    });

    it('has exactly 4 entries', () => {
        assert.equal(Object.keys(FLAVOR_MAP).length, 4);
    });
});

// ── migrate (integration) ───────────────────────────────────────────────────

describe('migrate', () => {
    let tmpDir;
    let indexPath;
    let dataDir;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `bench-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        indexPath = join(tmpDir, 'index.json');
        dataDir = join(tmpDir, 'data');
        await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('writes result files to correct paths', async () => {
        const index = makeIndex([makeIndexEntry()]);
        await writeFile(indexPath, JSON.stringify(index));

        const stats = await migrate(indexPath, dataDir);
        assert.equal(stats.results, 1);

        // Check that the result file exists
        const resultPath = join(dataDir, '2023/2023-06-15/14-23-45-UTC_abc1234_mono_aot_chrome_empty-browser.json');
        const content = JSON.parse(await readFile(resultPath, 'utf-8'));
        assert.equal(content.meta.runtime, 'mono');
        assert.equal(content.meta.preset, 'aot');
        assert.equal(content.metrics['time-to-reach-managed'], 459.85);
    });

    it('creates month index files', async () => {
        const index = makeIndex([makeIndexEntry()]);
        await writeFile(indexPath, JSON.stringify(index));

        await migrate(indexPath, dataDir);

        const monthIndex = JSON.parse(await readFile(join(dataDir, '2023-06.json'), 'utf-8'));
        assert.equal(monthIndex.month, '2023-06');
        assert.equal(monthIndex.commits.length, 1);
        assert.equal(monthIndex.commits[0].results.length, 1);
    });

    it('creates top-level index.json', async () => {
        const index = makeIndex([makeIndexEntry()]);
        await writeFile(indexPath, JSON.stringify(index));

        await migrate(indexPath, dataDir);

        const topIndex = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf-8'));
        assert.deepEqual(topIndex.months, ['2023-06']);
        assert.ok(topIndex.dimensions.runtimes.includes('mono'));
        assert.ok(topIndex.dimensions.presets.includes('aot'));
        assert.ok(topIndex.dimensions.engines.includes('chrome'));
        assert.ok(topIndex.dimensions.apps.includes('empty-browser'));
    });

    it('groups multiple entries for same commit into one commit entry', async () => {
        const entry1 = makeIndexEntry({ flavorId: 0 }); // aot.default.chrome
        const entry2 = makeIndexEntry({ flavorId: 2 }); // interp.default.chrome
        const index = makeIndex([entry1, entry2]);
        await writeFile(indexPath, JSON.stringify(index));

        await migrate(indexPath, dataDir);

        const monthIndex = JSON.parse(await readFile(join(dataDir, '2023-06.json'), 'utf-8'));
        assert.equal(monthIndex.commits.length, 1);
        assert.equal(monthIndex.commits[0].results.length, 2);
    });

    it('filters out non-target flavors', async () => {
        const target = makeIndexEntry({ flavorId: 0 });
        const ignored = makeIndexEntry({ flavorId: 9, hash: 'def5678abc1234def5678abc1234def5678abc123' });
        const index = makeIndex([target, ignored]);
        await writeFile(indexPath, JSON.stringify(index));

        const stats = await migrate(indexPath, dataDir);
        assert.equal(stats.entries, 1);
        assert.equal(stats.results, 1);
    });

    it('produces both browser and blazor result files', async () => {
        const entry = makeIndexEntry({
            minTimes: { 1: 350.0, 60: 7200.0, 97: 520.0, 98: 9500.0 },
        });
        const index = makeIndex([entry]);
        await writeFile(indexPath, JSON.stringify(index));

        const stats = await migrate(indexPath, dataDir);
        assert.equal(stats.results, 2);

        const monthIndex = JSON.parse(await readFile(join(dataDir, '2023-06.json'), 'utf-8'));
        const apps = monthIndex.commits[0].results.map(r => r.app).sort();
        assert.deepEqual(apps, ['empty-blazor', 'empty-browser']);
    });

    it('spans multiple months', async () => {
        const entry1 = makeIndexEntry({ commitTime: '2023-06-15T12:00:00+00:00' });
        const entry2 = makeIndexEntry({
            hash: 'def5678abc1234def5678abc1234def5678abc123',
            commitTime: '2023-07-20T09:00:00+00:00',
        });
        const index = makeIndex([entry1, entry2]);
        await writeFile(indexPath, JSON.stringify(index));

        const stats = await migrate(indexPath, dataDir);
        assert.equal(stats.months, 2);

        const topIndex = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf-8'));
        assert.deepEqual(topIndex.months, ['2023-06', '2023-07']);
    });

    it('returns correct stats', async () => {
        const entries = [
            makeIndexEntry({ flavorId: 0 }),
            makeIndexEntry({ flavorId: 2 }),
            makeIndexEntry({ flavorId: 9 }), // filtered out
        ];
        const index = makeIndex(entries);
        await writeFile(indexPath, JSON.stringify(index));

        const stats = await migrate(indexPath, dataDir);
        assert.equal(stats.entries, 2);   // only flavorId 0 and 2
        assert.equal(stats.results, 2);   // one result each
        assert.equal(stats.months, 1);
    });
});
