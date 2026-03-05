/**
 * runtime-pack-resolver.mjs — Resolve and download a runtime pack for a specific
 * dotnet/runtime commit from the Azure Artifacts "dotnet11" NuGet feed.
 *
 * Public API:
 *   - listAvailablePackVersions(major)  — list all versions from the feed
 *   - getPackCommitInfo(flatBaseUrl, version)  — get VMR + runtime commit for a pack version
 *   - restoreRuntimePack(dotnetPath, version, nugetPackagesDir)  — download via dotnet restore
 *   - refreshRuntimePacks(major)  — update artifacts/runtime-packs.json catalog
 */

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..', '..');

// ── Constants ───────────────────────────────────────────────────────────────

export const PACKAGE_ID = 'microsoft.netcore.app.runtime.mono.browser-wasm';

/**
 * Derive the corresponding SDK version from a runtime pack version.
 * Runtime pack: 11.0.0-preview.3.26127.120
 * SDK (1xx band): 11.0.100-preview.3.26127.120
 */
export function deriveSdkVersion(packVersion, band = 1) {
    const m = packVersion.match(/^(\d+\.\d+)\.\d+(-.+)$/);
    if (!m) return null;
    return `${m[1]}.${band}00${m[2]}`;
}

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
 * Returns: { vmrCommit, runtimeCommit, runtimePackVersion, buildDate }
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
    const sdkVersionOfTheRuntimeBuild = runtimeGitHash
        ? await getSdkVersionFromRuntimeCommit(runtimeGitHash)
        : null;
    return {
        runtimePackVersion: version,
        buildDate,
        vmrCommit,
        runtimeGitHash,
        sdkGitHash,
        sdkVersionOfTheRuntimeBuild,
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

/**
 * Get the SDK version used to build a given dotnet/runtime commit.
 * Reads `global.json` from the runtime repo at the given commit and
 * extracts the `tools.dotnet` value.
 *
 * @param {string} runtimeGitHash - The dotnet/runtime commit hash
 * @returns {string|null} SDK version string or null
 */
export async function getSdkVersionFromRuntimeCommit(runtimeGitHash) {
    const url = `https://raw.githubusercontent.com/dotnet/runtime/${runtimeGitHash}/global.json`;
    const globalJson = await tryFetchJSON(url);
    return globalJson?.tools?.dotnet ?? null;
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



// ── Runtime pack restore via dotnet ─────────────────────────────────────────

/**
 * Restore a specific runtime pack version into the NuGet packages cache using
 * `dotnet restore` with src/restore/restore-runtime-pack.proj.
 *
 * @param {string} dotnetPath - Path to the dotnet executable
 * @param {string} version - Runtime pack version to download
 * @param {string} nugetPackagesDir - NuGet packages directory (NUGET_PACKAGES)
 * @returns {string} Path to the restored pack root
 */
export function restoreRuntimePack(dotnetPath, version, nugetPackagesDir) {
    const packDir = join(nugetPackagesDir, PACKAGE_ID, version);
    if (existsSync(packDir)) {
        console.error(`  Pack already restored at ${packDir}, skipping`);
        return packDir;
    }

    const projPath = join(REPO_DIR, 'src', 'restore', 'restore-runtime-pack.proj');
    console.error(`  Restoring ${PACKAGE_ID} v${version} via dotnet restore...`);
    execFileSync(dotnetPath, [
        'restore', projPath,
        `/p:RuntimePackVersion=${version}`,
    ], {
        stdio: ['inherit', process.stderr, 'inherit'],
        env: { ...process.env, NUGET_PACKAGES: nugetPackagesDir },
        cwd: REPO_DIR,
    });
    console.error(`  Restored pack to ${packDir}`);
    return packDir;
}
/**
 * Refresh artifacts/runtime-packs.json by fetching the NuGet feed index and checking
 * if the newest version is already cached. If not, resolves new versions.
 */
export async function refreshRuntimePacks(major = DEFAULT_MAJOR) {
    const packsPath = join(REPO_DIR, 'artifacts', 'runtime-packs.json');
    let packsData;
    try {
        packsData = JSON.parse(await readFile(packsPath, 'utf-8'));
    } catch {
        // Bootstrap empty catalog
        packsData = { versions: [] };
    }

    let flatBaseUrl, allVersions;
    try {
        ({ flatBaseUrl, versions: allVersions } = await listAvailablePackVersions(major));
    } catch (e) {
        console.error(`  Runtime packs refresh failed (network): ${e.message}`);
        return;
    }

    if (allVersions.length === 0) {
        console.error('  Runtime packs feed returned no versions');
        return;
    }

    // Check if the newest version on the feed is already in our cache
    const newestFeedVersion = allVersions[0];
    const existingVersions = new Set((packsData.versions || []).map(e => e.runtimePackVersion));
    if (existingVersions.has(newestFeedVersion)) {
        console.error(`  Runtime packs catalog is up to date (newest: ${newestFeedVersion})`);
        return;
    }

    // New versions found — resolve only those missing from cache
    const newVersions = allVersions.filter(v => !existingVersions.has(v));
    console.error(`  Runtime packs: ${newVersions.length} new versions (newest: ${newestFeedVersion})`);

    for (const version of newVersions) {
        const buildDate = decodeBuildDate(version);
        const vmrCommit = await getVmrCommitFromNuspec(flatBaseUrl, version);
        let runtimeGitHash = null;
        let sdkGitHash = null;
        if (vmrCommit) {
            const commits = await getRepoCommitsFromVMR(vmrCommit);
            runtimeGitHash = commits?.runtimeCommit || null;
            sdkGitHash = commits?.sdkCommit || null;
        }
        const sdkVersionOfTheRuntimeBuild = runtimeGitHash
            ? await getSdkVersionFromRuntimeCommit(runtimeGitHash)
            : null;
        packsData.versions.unshift({
            runtimePackVersion: version,
            buildDate,
            vmrCommit,
            runtimeGitHash,
            sdkGitHash,
            sdkVersionOfTheRuntimeBuild,
            nupkgUrl: `${flatBaseUrl}${PACKAGE_ID}/${version}/${PACKAGE_ID}.${version}.nupkg`,
        });
    }

    packsData._lastRefreshed = new Date().toISOString();
    packsData.totalVersions = packsData.versions.length;
    packsData.resolvedVersions = packsData.versions.filter(e => e.runtimeGitHash).length;
    packsData.generated = new Date().toISOString();

    await writeFile(packsPath, JSON.stringify(packsData, null, 2) + '\n');
    console.error(`  Runtime packs updated (${packsData.versions.length} total, ${newVersions.length} new)`);
}


