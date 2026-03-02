#!/usr/bin/env node
/**
 * consolidate-results.mjs — Merge CI artifact result JSONs into gh-pages data/.
 *
 * Usage:
 *   node scripts/consolidate-results.mjs <artifacts-dir> <data-dir>
 *
 * - Scans artifacts-dir recursively for *.json result files
 * - Places each into data-dir/{year}/{YYYY-MM-DD}/ with canonical filename
 * - Updates month index files (data-dir/{YYYY-MM}.json)
 * - Updates top-level index (data-dir/index.json)
 */

import { readdir, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, basename } from 'node:path';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively find all .json files under a directory.
 */
export async function findJsonFiles(dir) {
    const results = [];
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
            const parentPath = entry.parentPath || entry.path;
            results.push(join(parentPath, entry.name));
        }
    }
    return results;
}

/**
 * Parse a result JSON file and validate it has the expected structure.
 * Returns null if the file is not a valid result JSON.
 */
export function parseResultJson(content) {
    let data;
    try {
        data = JSON.parse(content);
    } catch {
        return null;
    }
    if (!data.meta || !data.metrics) return null;
    const { commitDate, commitTime, gitHash, runtime, preset, engine, app } = data.meta;
    if (!commitDate || !commitTime || !gitHash || !runtime || !preset || !engine || !app) {
        return null;
    }
    return data;
}

/**
 * Compute the canonical filename for a result.
 */
export function computeResultFilename(meta) {
    const hash7 = meta.gitHash.slice(0, 7);
    return `${meta.commitTime}_${hash7}_${meta.runtime}_${meta.preset}_${meta.engine}_${meta.app}.json`;
}

/**
 * Compute the relative path from data-dir root for a result file.
 * e.g. "2026/2026-03-02/12-34-56-UTC_abc1234_coreclr_no-workload_chrome_empty-browser.json"
 */
export function computeResultRelPath(meta) {
    const year = meta.commitDate.slice(0, 4);
    const filename = computeResultFilename(meta);
    return `${year}/${meta.commitDate}/${filename}`;
}

/**
 * Compute the month key from a commit date.
 * "2026-03-02" → "2026-03"
 */
export function computeMonthKey(commitDate) {
    return commitDate.slice(0, 7);
}

// ── Month Index Operations ──────────────────────────────────────────────────

/**
 * Create an empty month index.
 */
export function createEmptyMonthIndex(month) {
    return { month, commits: [] };
}

/**
 * Build a result entry for the month index from a parsed result JSON.
 */
export function buildMonthResultEntry(meta, metrics) {
    return {
        runtime: meta.runtime,
        preset: meta.preset,
        engine: meta.engine,
        app: meta.app,
        file: computeResultRelPath(meta),
        metrics: Object.keys(metrics),
    };
}

/**
 * Upsert a result into a month index. Finds or creates the commit entry,
 * then adds or replaces the result (matched by runtime+preset+engine+app).
 */
export function upsertResult(monthIndex, resultJson) {
    const { meta, metrics } = resultJson;

    // Find or create commit entry
    let commit = monthIndex.commits.find(c => c.gitHash === meta.gitHash);
    if (!commit) {
        commit = {
            gitHash: meta.gitHash,
            date: meta.commitDate,
            time: meta.commitTime,
            sdkVersion: meta.sdkVersion || '',
            results: [],
        };
        monthIndex.commits.push(commit);
    }

    // Build result entry
    const entry = buildMonthResultEntry(meta, metrics);

    // Replace if same dimensions already exist
    const existingIdx = commit.results.findIndex(r =>
        r.runtime === meta.runtime &&
        r.preset === meta.preset &&
        r.engine === meta.engine &&
        r.app === meta.app
    );
    if (existingIdx >= 0) {
        commit.results[existingIdx] = entry;
    } else {
        commit.results.push(entry);
    }

    return monthIndex;
}

/**
 * Sort commits within a month index by date + time.
 */
export function sortMonthCommits(monthIndex) {
    monthIndex.commits.sort((a, b) => {
        const dateComp = a.date.localeCompare(b.date);
        if (dateComp !== 0) return dateComp;
        return a.time.localeCompare(b.time);
    });
    return monthIndex;
}

// ── Top-level Index Operations ──────────────────────────────────────────────

/**
 * Rebuild the top-level index.json from the set of known month keys
 * and all month indexes.
 */
export function rebuildTopLevelIndex(monthKeys, monthIndexes) {
    const runtimes = new Set();
    const presets = new Set();
    const engines = new Set();
    const apps = new Set();

    for (const mi of monthIndexes) {
        for (const commit of mi.commits) {
            for (const r of commit.results) {
                runtimes.add(r.runtime);
                presets.add(r.preset);
                engines.add(r.engine);
                apps.add(r.app);
            }
        }
    }

    return {
        lastUpdated: new Date().toISOString(),
        dimensions: {
            runtimes: [...runtimes].sort(),
            presets: [...presets].sort(),
            engines: [...engines].sort(),
            apps: [...apps].sort(),
        },
        months: [...monthKeys].sort(),
    };
}

// ── File I/O ────────────────────────────────────────────────────────────────

/**
 * Read a JSON file, returning null if it doesn't exist.
 */
async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, 'utf-8'));
    } catch {
        return null;
    }
}

// ── Main consolidation ─────────────────────────────────────────────────────

/**
 * Run the consolidation: scan artifacts, place result files, update indexes.
 * @param {string} artifactsDir  Directory containing downloaded CI artifacts
 * @param {string} dataDir       gh-pages data/ directory
 * @returns {Promise<{processed: number, skipped: number}>}
 */
export async function consolidate(artifactsDir, dataDir) {
    // 1. Find all JSON files in the artifacts directory
    const jsonFiles = await findJsonFiles(artifactsDir);

    // Track which month indexes were modified
    const modifiedMonths = new Map(); // monthKey → monthIndex

    let processed = 0;
    let skipped = 0;

    // 2. Process each result file
    for (const filePath of jsonFiles) {
        const content = await readFile(filePath, 'utf-8');
        const resultJson = parseResultJson(content);
        if (!resultJson) {
            // Not a valid result file (e.g. compile-time.json) — skip
            skipped++;
            continue;
        }

        const { meta } = resultJson;

        // 2a. Compute target path and copy file
        const relPath = computeResultRelPath(meta);
        const targetPath = join(dataDir, relPath);
        const targetDir = join(dataDir, meta.commitDate.slice(0, 4), meta.commitDate);
        await mkdir(targetDir, { recursive: true });
        await writeFile(targetPath, JSON.stringify(resultJson, null, 2) + '\n');

        // 2b. Update month index
        const monthKey = computeMonthKey(meta.commitDate);
        if (!modifiedMonths.has(monthKey)) {
            // Load existing month index or create new
            const existing = await readJsonFile(join(dataDir, `${monthKey}.json`));
            modifiedMonths.set(monthKey, existing || createEmptyMonthIndex(monthKey));
        }
        const monthIndex = modifiedMonths.get(monthKey);
        upsertResult(monthIndex, resultJson);

        processed++;
    }

    // 3. Write updated month indexes
    for (const [monthKey, monthIndex] of modifiedMonths) {
        sortMonthCommits(monthIndex);
        const monthPath = join(dataDir, `${monthKey}.json`);
        await writeFile(monthPath, JSON.stringify(monthIndex, null, 2) + '\n');
    }

    // 4. Update top-level index.json
    // Collect all month keys: existing + newly modified
    const existingIndex = await readJsonFile(join(dataDir, 'index.json'));
    const existingMonths = new Set(existingIndex?.months || []);
    for (const key of modifiedMonths.keys()) {
        existingMonths.add(key);
    }

    // Load all month indexes for dimension derivation
    const allMonthIndexes = [];
    for (const mk of existingMonths) {
        if (modifiedMonths.has(mk)) {
            allMonthIndexes.push(modifiedMonths.get(mk));
        } else {
            const mi = await readJsonFile(join(dataDir, `${mk}.json`));
            if (mi) allMonthIndexes.push(mi);
        }
    }

    const topIndex = rebuildTopLevelIndex(existingMonths, allMonthIndexes);
    await writeFile(join(dataDir, 'index.json'), JSON.stringify(topIndex, null, 2) + '\n');

    return { processed, skipped };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const [, , artifactsDir, dataDir] = process.argv;

if (artifactsDir && dataDir) {
    const { processed, skipped } = await consolidate(artifactsDir, dataDir);
    console.log(`Consolidation complete: ${processed} results processed, ${skipped} files skipped.`);
}
