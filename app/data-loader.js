/**
 * Data fetching and caching for benchmark results.
 * Loads index.json, month indexes, and individual result JSON files.
 */
export class DataLoader {
    #baseUrl;
    #index;
    #monthCache;
    #resultCache;

    constructor(baseUrl) {
        this.#baseUrl = baseUrl;
        this.#index = null;
        this.#monthCache = new Map();
        this.#resultCache = new Map();
    }

    /** Fetch and parse index.json. Called once on init. */
    async loadIndex() {
        const resp = await fetch(`${this.#baseUrl}index.json`);
        if (!resp.ok) throw new Error(`Failed to load index: ${resp.status}`);
        this.#index = await resp.json();
        return this.#index;
    }

    /** Get the cached index (must call loadIndex first). */
    getIndex() {
        return this.#index;
    }

    /** Load month index files needed for the given date range. range = { min, max } ISO date strings, or nulls for all. */
    async loadMonths(range) {
        if (!this.#index) throw new Error('Index not loaded');

        const cutoffMonth = range?.min
            ? range.min.slice(0, 7) // "2025-06-01" → "2025-06"
            : '0000-00';

        const neededMonths = this.#index.months.filter(m => m >= cutoffMonth);
        const toFetch = neededMonths.filter(m => !this.#monthCache.has(m));

        await Promise.all(toFetch.map(async (month) => {
            try {
                const resp = await fetch(`${this.#baseUrl}${month}.json`);
                if (resp.ok) {
                    this.#monthCache.set(month, await resp.json());
                }
            } catch (e) {
                console.warn(`Failed to fetch month index ${month}:`, e);
            }
        }));
    }

    /** Filter runs across loaded month indexes by app + filter state + date range. */
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
                            runtimeGitHash: commit.runtimeGitHash || commit.gitHash,
                            sdkGitHash: commit.sdkGitHash || '',
                            vmrGitHash: commit.vmrGitHash || ''
                        });
                    }
                }
            }
        }
        return runs;
    }

    /** Load result JSON files for the given run entries. Returns array of { meta, metrics } objects. */
    async loadRunData(runs) {
        const toFetch = runs.filter(r => !this.#resultCache.has(r.file));

        await Promise.all(toFetch.map(async (run) => {
            try {
                const resp = await fetch(`${this.#baseUrl}${run.file}`);
                if (resp.ok) {
                    this.#resultCache.set(run.file, await resp.json());
                }
            } catch (e) {
                console.warn(`Failed to fetch ${run.file}:`, e);
            }
        }));

        return runs
            .map(r => this.#resultCache.get(r.file))
            .filter(Boolean);
    }

    /** Count total result entries across loaded month indexes. */
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
