/**
 * runtime-pack-resolver.mjs — Resolve and download a runtime pack for a specific
 * dotnet/runtime commit from the Azure Artifacts "dotnet11" NuGet feed.
 *
 * Strategy:
 *   1. List all available `Microsoft.NETCore.App.Runtime.Mono.browser-wasm` package versions
 *      from the public dotnet{major} feed.
 *   2. For each version, fetch the `.nuspec` metadata to find the VMR commit hash
 *      (stored in Microsoft.NETCore.App.versions.txt inside the package).
 *   3. For the VMR commit, read `src/source-manifest.json` to get the runtime commit.
 *   4. Select the closest package whose runtime commit is an ancestor of (or equal to)
 *      the target commit.
 *   5. Download and extract the `.nupkg` to a local directory.
 *
 * The extracted pack can be referenced via the UpdateRuntimePack MSBuild target:
 *   <ResolvedRuntimePack PackageDirectory="<extracted-path>"
 *                        Condition="'%(ResolvedRuntimePack.FrameworkName)' == 'Microsoft.NETCore.App'" />
 *
 * Public API:
 *   - listAvailablePackVersions(major)  — list all versions from the feed
 *   - getPackCommitInfo(flatBaseUrl, version)  — get VMR + runtime commit for a pack version
 *   - findBestPackForCommit(runtimeCommit, options)  — find the closest matching pack
 *   - downloadAndExtractPack(flatBaseUrl, version, destDir)  — download & unzip a nupkg
 *   - resolveRuntimePack(runtimeCommit, options)  — full end-to-end resolution
 */

import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Constants ───────────────────────────────────────────────────────────────

export const PACKAGE_ID = 'microsoft.netcore.app.runtime.mono.browser-wasm';

const FEED_URLS = {
    11: 'https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11/nuget/v3/index.json',
    10: 'https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet10/nuget/v3/index.json',
};

const DEFAULT_MAJOR = 11;

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp.json();
}

async function fetchText(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp.text();
}

async function fetchBuffer(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return Buffer.from(await resp.arrayBuffer());
}

/**
 * Try to fetch JSON; return null on 404/failure.
 */
async function tryFetchJSON(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
}

// ── Feed resolution ─────────────────────────────────────────────────────────

/**
 * Get the flat container (PackageBaseAddress) URL for a feed.
 */
export async function getFlatBaseUrl(major = DEFAULT_MAJOR) {
    const feedUrl = FEED_URLS[major];
    if (!feedUrl) throw new Error(`No feed URL configured for .NET ${major}`);
    const index = await fetchJSON(feedUrl);
    const resource = index.resources.find(r => r['@type'] === 'PackageBaseAddress/3.0.0');
    if (!resource) throw new Error(`No PackageBaseAddress found in feed index for .NET ${major}`);
    return resource['@id'];
}

/**
 * List all available package versions from the feed.
 * Returns versions sorted ascending (NuGet default).
 */
export async function listAvailablePackVersions(major = DEFAULT_MAJOR) {
    const flatBaseUrl = await getFlatBaseUrl(major);
    const data = await fetchJSON(`${flatBaseUrl}${PACKAGE_ID}/index.json`);
    const versions = data.versions || [];
    // Filter to only the target major version
    return {
        flatBaseUrl,
        versions: versions.filter(v => v.startsWith(`${major}.`)),
    };
}

// ── Version → commit mapping ────────────────────────────────────────────────

/**
 * Decode the SHORT_DATE from a NuGet version string.
 * Format: {major}.{minor}.{patch}-{prerelease}.{SHORT_DATE}.{revision}
 *
 * SHORT_DATE encoding:
 *   YY = SHORT_DATE / 1000
 *   MM = (SHORT_DATE % 1000) / 50
 *   DD = (SHORT_DATE % 1000) % 50
 */
export function decodeBuildDate(version) {
    const parts = version.split('.');
    // Find the SHORT_DATE — it's the 5th dot-separated segment
    // e.g. 11.0.0-preview.3.26153.117 → parts[4] = "26153"
    if (parts.length < 6) return null;
    const shortDate = parseInt(parts[4], 10);
    if (isNaN(shortDate)) return null;
    const yy = Math.floor(shortDate / 1000);
    const mm = Math.floor((shortDate % 1000) / 50);
    const dd = (shortDate % 1000) % 50;
    return `20${String(yy).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * For a given package version, download the Microsoft.NETCore.App.versions.txt
 * from the nupkg (without downloading the full package) to get the VMR commit hash.
 * Then resolve the runtime commit from the VMR source-manifest.json.
 *
 * Returns: { vmrCommit, runtimeCommit, version, buildDate }
 */
export async function getPackCommitInfo(flatBaseUrl, version) {
    const buildDate = decodeBuildDate(version);
    const vmrCommit = await getVmrCommitFromNuspec(flatBaseUrl, version);
    let runtimeGitHash = null;
    let sdkGitHash = null;
    if (vmrCommit) {
        const commits = await getRepoCommitsFromVMR(vmrCommit);
        runtimeGitHash = commits?.runtimeCommit || null;
        sdkGitHash = commits?.sdkCommit || null;
    }
    return {
        version,
        buildDate,
        vmrCommit,
        runtimeGitHash,
        sdkGitHash,
        nupkgUrl: `${flatBaseUrl}${PACKAGE_ID}/${version}/${PACKAGE_ID}.${version}.nupkg`,
    };
}

/**
 * Get the VMR commit hash from a NuGet package nuspec (small XML).
 * The nuspec contains a <repository> tag with the VMR commit:
 *   <repository type="git" url="..." commit="abc123..." />
 *
 * @param {string} flatBaseUrl - The NuGet flat container base URL
 * @param {string} version - Package version
 * @returns {string|null} VMR commit hash or null
 */
export async function getVmrCommitFromNuspec(flatBaseUrl, version) {
    const url = `${flatBaseUrl}${PACKAGE_ID}/${version}/${PACKAGE_ID}.nuspec`;
    try {
        const text = await fetchText(url);
        const m = text.match(/repository[^>]*commit=["']([a-f0-9]{7,40})/);
        return m?.[1] || null;
    } catch {
        return null;
    }
}

/**
 * Get repository commit hashes from a VMR (dotnet/dotnet) commit.
 * Reads src/source-manifest.json and returns both runtime and sdk commits.
 *
 * @param {string} vmrCommit - The VMR commit hash
 * @returns {{ runtimeCommit: string|null, sdkCommit: string|null }}
 */
export async function getRepoCommitsFromVMR(vmrCommit) {
    const url = `https://raw.githubusercontent.com/dotnet/dotnet/${vmrCommit}/src/source-manifest.json`;
    const manifest = await tryFetchJSON(url);
    if (!manifest) return null;
    const repos = manifest.repositories || [];
    const runtimeEntry = repos.find(r => r.path === 'runtime' || r.path === 'src/runtime');
    const sdkEntry = repos.find(r => r.path === 'sdk' || r.path === 'src/sdk');
    return {
        runtimeCommit: runtimeEntry?.commitSha || null,
        sdkCommit: sdkEntry?.commitSha || null,
    };
}

// ── VMR commit → runtime commit mapping ─────────────────────────────────────

/**
 * Get the runtime commit hash from a VMR (dotnet/dotnet) commit.
 * Reads src/source-manifest.json from the VMR repo at the given commit.
 */
export async function getRuntimeCommitFromVMR(vmrCommit) {
    const url = `https://raw.githubusercontent.com/dotnet/dotnet/${vmrCommit}/src/source-manifest.json`;
    const manifest = await tryFetchJSON(url);
    if (!manifest) return null;
    const runtimeEntry = (manifest.repositories || []).find(
        r => r.path === 'runtime' || r.path === 'src/runtime'
    );
    return runtimeEntry?.commitSha || null;
}

/**
 * Find VMR commits that sync from dotnet/runtime.
 * Scans recent VMR commits on main branch looking for runtime sync commits.
 * Returns array of { vmrCommit, date, runtimeCommit }.
 */
export async function findRecentVMRRuntimeSyncs(count = 100) {
    // Fetch recent VMR commits and look for runtime sync messages
    const url = `https://api.github.com/repos/dotnet/dotnet/commits?sha=main&per_page=${count}`;
    const commits = await fetchJSON(url);

    const results = [];
    for (const c of commits) {
        const msg = c.commit?.message?.split('\n')[0] || '';
        // VMR runtime syncs have messages like "[main] Source code updates from dotnet/runtime"
        // But we also need to check ALL commits since the runtime entry changes with each push
        results.push({
            vmrCommit: c.sha,
            date: c.commit?.committer?.date || '',
            message: msg,
            isRuntimeSync: msg.includes('dotnet/runtime'),
        });
    }
    return results;
}

/**
 * Build a mapping of runtime commits to VMR commits by scanning recent VMR history.
 * Only resolves commits from runtime-sync VMR commits for efficiency.
 *
 * Returns Map<runtimeCommit, { vmrCommit, date }>
 */
export async function buildRuntimeToVMRMap(count = 50) {
    const syncs = await findRecentVMRRuntimeSyncs(count);
    const runtimeSyncs = syncs.filter(s => s.isRuntimeSync);

    const map = new Map();
    // Process in parallel (batches of 5 to avoid rate limiting)
    for (let i = 0; i < runtimeSyncs.length; i += 5) {
        const batch = runtimeSyncs.slice(i, i + 5);
        const results = await Promise.all(
            batch.map(async (sync) => {
                const runtimeCommit = await getRuntimeCommitFromVMR(sync.vmrCommit);
                return { ...sync, runtimeCommit };
            })
        );
        for (const r of results) {
            if (r.runtimeCommit) {
                map.set(r.runtimeCommit, {
                    vmrCommit: r.vmrCommit,
                    date: r.date,
                });
            }
        }
    }
    return map;
}

// ── GitHub ancestry check ───────────────────────────────────────────────────

/**
 * Check if `commit` is an ancestor of `descendant` in the runtime repo.
 * Uses GitHub compare API: if base...head returns status "ahead" or "identical" 
 * with behind_by=0, then base is an ancestor of head.
 *
 * Returns: 'ancestor' | 'descendant' | 'diverged' | 'identical'
 */
export async function checkAncestry(commit, descendant) {
    const url = `https://api.github.com/repos/dotnet/runtime/compare/${commit}...${descendant}`;
    const data = await fetchJSON(url);
    if (data.status === 'identical') return 'identical';
    if (data.status === 'ahead' && data.behind_by === 0) return 'ancestor';
    if (data.status === 'behind' && data.ahead_by === 0) return 'descendant';
    return 'diverged';
}

// ── Package download & extraction ───────────────────────────────────────────

/**
 * Download a .nupkg and extract it to a destination directory.
 * The nupkg is a zip file containing the runtime pack contents.
 *
 * @param {string} flatBaseUrl - The NuGet flat container base URL
 * @param {string} version - Package version to download
 * @param {string} destDir - Directory to extract to
 * @returns {string} Path to the extracted pack root
 */
export async function downloadAndExtractPack(flatBaseUrl, version, destDir) {
    const nupkgUrl = `${flatBaseUrl}${PACKAGE_ID}/${version}/${PACKAGE_ID}.${version}.nupkg`;
    const packDir = join(destDir, `${PACKAGE_ID}.${version}`);

    if (existsSync(packDir)) {
        console.error(`  Pack already extracted at ${packDir}, skipping download`);
        return packDir;
    }

    console.error(`  Downloading ${PACKAGE_ID} v${version}...`);
    const buffer = await fetchBuffer(nupkgUrl);

    console.error(`  Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

    // Extract using unzip (nupkg is a zip file)
    await mkdir(packDir, { recursive: true });
    const zipPath = join(destDir, `${PACKAGE_ID}.${version}.nupkg`);
    await writeFile(zipPath, buffer);

    const { execFileSync } = await import('node:child_process');
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', packDir], { stdio: 'pipe' });

    // Clean up the zip
    await rm(zipPath);

    // Read the versions.txt to report what we got
    const versionsTxt = join(packDir, 'Microsoft.NETCore.App.versions.txt');
    try {
        const content = await readFile(versionsTxt, 'utf-8');
        const lines = content.trim().split('\n');
        console.error(`  Extracted pack: VMR commit ${lines[0]?.substring(0, 12)}, version ${lines[1]}`);
    } catch {
        console.error(`  Extracted pack (no versions.txt found)`);
    }

    return packDir;
}

/**
 * Read the VMR commit and version from an extracted pack's versions.txt.
 */
export async function readPackVersionInfo(packDir) {
    const versionsTxt = join(packDir, 'Microsoft.NETCore.App.versions.txt');
    try {
        const content = await readFile(versionsTxt, 'utf-8');
        const lines = content.trim().split('\n');
        return {
            vmrCommit: lines[0]?.trim() || '',
            packVersion: lines[1]?.trim() || '',
        };
    } catch {
        return { vmrCommit: '', packVersion: '' };
    }
}

// ── End-to-end resolver ─────────────────────────────────────────────────────

/**
 * Resolve and download the best matching runtime pack for a given runtime commit.
 *
 * Algorithm:
 *   1. List available package versions from the NuGet feed
 *   2. Pick recent versions (by build date) as candidates
 *   3. For each candidate, download and check the VMR commit → runtime commit
 *   4. Use GitHub compare API to check if the target commit is included
 *   5. Download the best match
 *
 * @param {string} runtimeCommit - The dotnet/runtime commit hash to resolve
 * @param {object} options
 * @param {number} [options.major=11] - .NET major version
 * @param {string} [options.destDir] - Directory for extracted packs
 * @param {string} [options.strategy='closest-after'] - Resolution strategy:
 *   - 'closest-after': First pack whose runtime commit includes the target (default)
 *   - 'closest-before': Last pack before the target commit
 *   - 'exact': Only match if the pack was built from exactly this commit
 * @returns {{ packDir, version, runtimeCommit, vmrCommit, strategy }}
 */
export async function resolveRuntimePack(runtimeCommit, options = {}) {
    const {
        major = DEFAULT_MAJOR,
        destDir = join(process.cwd(), 'artifacts', 'runtime-packs'),
        strategy = 'closest-after',
    } = options;

    console.error(`\nResolving runtime pack for commit ${runtimeCommit.substring(0, 12)}...`);
    console.error(`  Strategy: ${strategy}, .NET ${major}`);

    // Step 1: List available versions
    const { flatBaseUrl, versions } = await listAvailablePackVersions(major);
    console.error(`  Found ${versions.length} package versions on dotnet${major} feed`);

    if (versions.length === 0) {
        throw new Error(`No package versions found for .NET ${major}`);
    }

    // Step 2: Sort by build date descending and take recent candidates
    const candidates = versions
        .map(v => ({ version: v, buildDate: decodeBuildDate(v) }))
        .filter(c => c.buildDate)
        .sort((a, b) => b.buildDate.localeCompare(a.buildDate));

    // Step 3: Download recent candidates and check their runtime commits
    // Start with the most recent and work backwards
    const MAX_CANDIDATES = 10;
    const recentCandidates = candidates.slice(0, MAX_CANDIDATES);

    console.error(`  Checking ${recentCandidates.length} recent candidates...`);

    await mkdir(destDir, { recursive: true });

    for (const candidate of recentCandidates) {
        // Download the pack to check its commit info
        const packDir = await downloadAndExtractPack(flatBaseUrl, candidate.version, destDir);
        const { vmrCommit } = await readPackVersionInfo(packDir);

        if (!vmrCommit) {
            console.error(`  ${candidate.version}: no VMR commit info, skipping`);
            continue;
        }

        // Get the runtime commit from the VMR
        const packRuntimeCommit = await getRuntimeCommitFromVMR(vmrCommit);
        if (!packRuntimeCommit) {
            console.error(`  ${candidate.version}: could not resolve runtime commit from VMR ${vmrCommit.substring(0, 12)}`);
            continue;
        }

        // Check if target commit is included in this pack's runtime commit
        if (packRuntimeCommit === runtimeCommit) {
            console.error(`  ${candidate.version}: EXACT MATCH`);
            return {
                packDir,
                version: candidate.version,
                runtimeCommit: packRuntimeCommit,
                vmrCommit,
                match: 'exact',
            };
        }

        const ancestry = await checkAncestry(runtimeCommit, packRuntimeCommit);
        console.error(`  ${candidate.version}: runtime=${packRuntimeCommit.substring(0, 12)} ancestry=${ancestry}`);

        if (strategy === 'exact') continue;

        if (strategy === 'closest-after' && (ancestry === 'ancestor' || ancestry === 'identical')) {
            // This pack includes our target commit (pack is same or ahead)
            return {
                packDir,
                version: candidate.version,
                runtimeCommit: packRuntimeCommit,
                vmrCommit,
                match: 'closest-after',
            };
        }

        if (strategy === 'closest-before' && (ancestry === 'descendant' || ancestry === 'identical')) {
            // This pack is before our target commit
            return {
                packDir,
                version: candidate.version,
                runtimeCommit: packRuntimeCommit,
                vmrCommit,
                match: 'closest-before',
            };
        }
    }

    throw new Error(
        `Could not find a matching runtime pack for commit ${runtimeCommit.substring(0, 12)} `
        + `(strategy=${strategy}, checked ${recentCandidates.length} candidates)`
    );
}
