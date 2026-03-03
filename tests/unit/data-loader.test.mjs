import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures');

async function loadFixture(name) {
    return JSON.parse(await readFile(join(fixtureDir, name), 'utf-8'));
}

// Lightweight DataLoader reimplementation for unit testing
// (The real DataLoader uses browser fetch; we test the filtering logic directly)
class TestableDataLoader {
    #index;
    #monthCache;
    #resultCache;

    constructor() {
        this.#index = null;
        this.#monthCache = new Map();
        this.#resultCache = new Map();
    }

    setIndex(index) {
        this.#index = index;
    }

    getIndex() {
        return this.#index;
    }

    addMonth(monthKey, monthData) {
        this.#monthCache.set(monthKey, monthData);
    }

    addResult(filePath, resultData) {
        this.#resultCache.set(filePath, resultData);
    }

    /** Same logic as DataLoader.loadMonths but determines which months are needed. */
    getNeededMonths(range) {
        if (!this.#index) throw new Error('Index not loaded');
        const cutoffMonth = range?.min
            ? range.min.slice(0, 7)
            : '0000-00';
        return this.#index.months.filter(m => m >= cutoffMonth);
    }

    /** Same filterRuns logic as the real DataLoader. */
    filterRuns(app, filterState) {
        const cutoffMin = filterState.range?.min || '1970-01-01';
        const cutoffMax = filterState.range?.max || '9999-12-31';

        const runs = [];
        for (const monthIndex of this.#monthCache.values()) {
            for (const commit of monthIndex.commits) {
                if (commit.date < cutoffMin || commit.date > cutoffMax) continue;
                for (const result of commit.results) {
                    if (result.app === app &&
                        filterState.runtime.includes(result.runtime) &&
                        filterState.preset.includes(result.preset) &&
                        filterState.engine.includes(result.engine)) {
                        runs.push({
                            ...result,
                            date: commit.date,
                            time: commit.time,
                            sdkVersion: commit.sdkVersion,
                            gitHash: commit.gitHash
                        });
                    }
                }
            }
        }
        return runs;
    }

    getResult(filePath) {
        return this.#resultCache.get(filePath);
    }

    countDataPoints() {
        let count = 0;
        for (const monthIndex of this.#monthCache.values()) {
            for (const commit of monthIndex.commits) {
                count += commit.results.length;
            }
        }
        return count;
    }
}

describe('DataLoader', () => {
    let loader;
    let indexFixture;
    let month03;
    let month02;
    let result1;
    let result2;

    beforeEach(async () => {
        loader = new TestableDataLoader();
        indexFixture = await loadFixture('dashboard-index.json');
        month03 = await loadFixture('dashboard-month-2026-03.json');
        month02 = await loadFixture('dashboard-month-2026-02.json');
        result1 = await loadFixture('dashboard-result-1.json');
        result2 = await loadFixture('dashboard-result-2.json');

        loader.setIndex(indexFixture);
        loader.addMonth('2026-03', month03);
        loader.addMonth('2026-02', month02);
    });

    describe('getIndex()', () => {
        it('returns loaded index', () => {
            const idx = loader.getIndex();
            assert.equal(idx.lastUpdated, '2026-03-02T12:34:56Z');
            assert.deepEqual(idx.dimensions.runtimes, ['coreclr', 'mono']);
        });
    });

    describe('getNeededMonths()', () => {
        it('returns all months for null range (All)', () => {
            const months = loader.getNeededMonths({ min: null, max: null });
            assert.deepEqual(months, ['2026-02', '2026-03']);
        });

        it('filters months by min date', () => {
            const months = loader.getNeededMonths({ min: '2026-03-01', max: '2026-03-31' });
            assert.deepEqual(months, ['2026-03']);
        });
    });

    describe('filterRuns()', () => {
        it('filters by app', () => {
            const runs = loader.filterRuns('empty-browser', {
                runtime: ['coreclr', 'mono'],
                preset: ['no-workload', 'aot'],
                engine: ['chrome', 'firefox'],
                range: { min: null, max: null }
            });
            // March has 3 empty-browser results, Feb has 1
            assert.equal(runs.length, 4);
        });

        it('filters by runtime', () => {
            const runs = loader.filterRuns('empty-browser', {
                runtime: ['coreclr'],
                preset: ['no-workload', 'aot'],
                engine: ['chrome', 'firefox'],
                range: { min: null, max: null }
            });
            // Only coreclr results for empty-browser: Mar 1 + Mar 2 + Feb 15 = 3
            assert.equal(runs.length, 3);
        });

        it('filters by preset', () => {
            const runs = loader.filterRuns('empty-browser', {
                runtime: ['coreclr', 'mono'],
                preset: ['aot'],
                engine: ['chrome', 'firefox'],
                range: { min: null, max: null }
            });
            // Only mono/aot on Mar 1
            assert.equal(runs.length, 1);
            assert.equal(runs[0].runtime, 'mono');
            assert.equal(runs[0].preset, 'aot');
        });

        it('filters by engine', () => {
            const runs = loader.filterRuns('empty-browser', {
                runtime: ['coreclr', 'mono'],
                preset: ['no-workload', 'aot'],
                engine: ['firefox'],
                range: { min: null, max: null }
            });
            // No empty-browser results with firefox engine in our fixtures
            assert.equal(runs.length, 0);
        });

        it('filters by date range', () => {
            const allRuns = loader.filterRuns('empty-browser', {
                runtime: ['coreclr', 'mono'],
                preset: ['no-workload', 'aot'],
                engine: ['chrome', 'firefox'],
                range: { min: null, max: null }
            });
            assert.equal(allRuns.length, 4);

            // Only March data
            const marchRuns = loader.filterRuns('empty-browser', {
                runtime: ['coreclr', 'mono'],
                preset: ['no-workload', 'aot'],
                engine: ['chrome', 'firefox'],
                range: { min: '2026-03-01', max: '2026-03-31' }
            });
            assert.equal(marchRuns.length, 3);
        });

        it('returns empty for non-existent app', () => {
            const runs = loader.filterRuns('blazing-pizza', {
                runtime: ['coreclr', 'mono'],
                preset: ['no-workload', 'aot'],
                engine: ['chrome', 'firefox'],
                range: { min: null, max: null }
            });
            assert.equal(runs.length, 0);
        });

        it('enriches runs with commit metadata', () => {
            const runs = loader.filterRuns('empty-browser', {
                runtime: ['coreclr'],
                preset: ['no-workload'],
                engine: ['chrome'],
                range: { min: null, max: null }
            });
            assert.ok(runs.length >= 1);
            const run = runs[0];
            assert.ok(run.date);
            assert.ok(run.time);
            assert.ok(run.sdkVersion);
            assert.ok(run.gitHash);
            assert.ok(run.file);
        });

        it('filters microbenchmarks by engine', () => {
            const runs = loader.filterRuns('microbenchmarks', {
                runtime: ['mono'],
                preset: ['no-workload'],
                engine: ['firefox'],
                range: { min: null, max: null }
            });
            assert.equal(runs.length, 1);
            assert.equal(runs[0].app, 'microbenchmarks');
            assert.equal(runs[0].engine, 'firefox');
        });
    });

    describe('countDataPoints()', () => {
        it('counts all result entries across months', () => {
            const count = loader.countDataPoints();
            // March has 4 results (2 commits × 2 results), Feb has 1
            assert.equal(count, 5);
        });
    });

    describe('result caching', () => {
        it('stores and retrieves result data', () => {
            loader.addResult('test-file.json', result1);
            const cached = loader.getResult('test-file.json');
            assert.deepEqual(cached, result1);
        });

        it('returns undefined for uncached result', () => {
            const cached = loader.getResult('nonexistent.json');
            assert.equal(cached, undefined);
        });
    });
});
