#!/usr/bin/env node
/**
 * enumerate-runtime-packs.mjs — Enumerate runtime pack versions from the
 * Azure Artifacts NuGet feed and resolve VMR → runtime + SDK commit hashes.
 *
 * Incremental: loads existing runtime-packs.json and only resolves new versions.
 *
 * Sources:
 *   - NuGet flat container on dotnet{major} feed (public, no auth)
 *   - GitHub raw URLs for VMR source-manifest.json
 *
 * Output: runtime-packs.json in repo root
 *
 * Usage:
 *   node scripts/enumerate-runtime-packs.mjs [--major 11] [--months 3] [--force]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    PACKAGE_ID,
    getFlatBaseUrl,
    listAvailablePackVersions,
    decodeBuildDate,
    getVmrCommitFromNuspec,
    getRepoCommitsFromVMR,
} from './lib/runtime-pack-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '..', 'runtime-packs.json');

const DEFAULT_MAJOR = 11;

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseCliArgs() {
    const args = { major: DEFAULT_MAJOR, months: 3, force: false };
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === '--major' && process.argv[i + 1]) {
            args.major = parseInt(process.argv[++i], 10);
        } else if (process.argv[i] === '--months' && process.argv[i + 1]) {
            args.months = parseInt(process.argv[++i], 10);
        } else if (process.argv[i] === '--force') {
            args.force = true;
        }
    }
    return args;
}

/**
 * Run async tasks with bounded concurrency.
 */
async function mapConcurrent(items, fn, concurrency = 5) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
    );
    return results;
}

/**
 * Load existing runtime-packs.json (for incremental mode).
 * Returns Map<version, entry> for already-resolved versions.
 */
function loadExisting() {
    if (!existsSync(OUTPUT)) return new Map();
    try {
        const data = JSON.parse(readFileSync(OUTPUT, 'utf-8'));
        const map = new Map();
        for (const entry of data.versions || []) {
            map.set(entry.version, entry);
        }
        return map;
    } catch {
        return new Map();
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseCliArgs();
    const major = args.major;
    const force = args.force;
    const months = args.months;

    // Compute cutoff date for filtering
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    console.log(`Enumerating runtime packs for .NET ${major} (last ${months} months, since ${cutoffDate})...`);

    // Step 1: Load existing data for incremental resolution
    const existing = force ? new Map() : loadExisting();
    if (existing.size > 0) {
        console.log(`  Loaded ${existing.size} previously resolved versions`);
    }

    // Step 2: List all versions from the NuGet feed, filtered to last N months
    const { flatBaseUrl, versions: allVersions } = await listAvailablePackVersions(major);
    const versions = allVersions.filter(v => {
        const d = decodeBuildDate(v);
        return d && d >= cutoffDate;
    });
    console.log(`  Feed has ${allVersions.length} versions, ${versions.length} within last ${months} months`);

    // Step 3: Identify new versions that need resolution
    const newVersions = versions.filter(v => !existing.has(v));
    const cachedVersions = versions.filter(v => existing.has(v));
    console.log(`  ${cachedVersions.length} already resolved, ${newVersions.length} new`);

    if (newVersions.length === 0) {
        console.log('  Nothing new to resolve');
        // Still rewrite output to update generated timestamp
        writeOutput(major, flatBaseUrl, versions, existing);
        return;
    }

    // Step 4: Resolve VMR → runtime + SDK commits for new versions
    console.log(`  Resolving commits for ${newVersions.length} new versions (concurrency=5)...`);
    let resolved = 0;
    let failed = 0;

    await mapConcurrent(newVersions, async (version, i) => {
        const buildDate = decodeBuildDate(version);

        // Step 4a: Get VMR commit from nuspec
        const vmrCommit = await getVmrCommitFromNuspec(flatBaseUrl, version);
        if (!vmrCommit) {
            failed++;
            existing.set(version, {
                version,
                buildDate,
                vmrCommit: null,
                runtimeGitHash: null,
                sdkGitHash: null,
                nupkgUrl: `${flatBaseUrl}${PACKAGE_ID}/${version}/${PACKAGE_ID}.${version}.nupkg`,
            });
            return;
        }

        // Step 4b: Resolve runtime + SDK commits from VMR
        const commits = await getRepoCommitsFromVMR(vmrCommit);
        const entry = {
            version,
            buildDate,
            vmrCommit,
            runtimeGitHash: commits?.runtimeCommit || null,
            sdkGitHash: commits?.sdkCommit || null,
            nupkgUrl: `${flatBaseUrl}${PACKAGE_ID}/${version}/${PACKAGE_ID}.${version}.nupkg`,
        };
        existing.set(version, entry);

        if (commits?.runtimeCommit) resolved++;
        else failed++;

        if ((resolved + failed) % 10 === 0) {
            process.stdout.write(`  ${resolved + failed}/${newVersions.length} done\r`);
        }
    }, 5);

    console.log(`  Resolved ${resolved} new versions, ${failed} failed/partial`);

    // Step 5: Write output
    writeOutput(major, flatBaseUrl, versions, existing);
}

function writeOutput(major, flatBaseUrl, allVersions, entryMap) {
    // Build sorted entries list (by version ascending)
    const entries = allVersions.map(v => entryMap.get(v)).filter(Boolean);

    const fullyResolved = entries.filter(e => e.runtimeGitHash).length;

    const output = {
        generated: new Date().toISOString(),
        feed: `dotnet${major}`,
        packageId: PACKAGE_ID,
        totalVersions: entries.length,
        resolvedVersions: fullyResolved,
        versions: entries,
    };

    writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n');
    console.log(`\nWritten ${OUTPUT}`);
    console.log(`  ${entries.length} total, ${fullyResolved} fully resolved`);
}

main().catch(e => { console.error(e); process.exit(1); });
