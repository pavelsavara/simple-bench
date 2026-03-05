/**
 * resolve-sdk.mjs — Download .NET SDK and resolve version + git hashes.
 *
 * Resolution algorithm:
 *   1. Look up exact SDK version from artifacts/sdk-list.json (channel → latest valid build)
 *   2. Cross-reference with artifacts/runtime-packs.json for git hashes (vmr, sdk, runtime)
 *   3. Install exact version via dotnet-install script (never channel-based guess)
 *   4. Fallback: if catalog lookup fails, install via channel and resolve
 *      hashes from dotnet --info + VMR source-manifest.json
 *   5. Write sdk-info.json
 *
 * Usage as script:
 *   node scripts/lib/resolve-sdk.mjs --channel 11.0 --install-dir artifacts/sdks/sdk
 *   node scripts/lib/resolve-sdk.mjs --sdk-version 11.0.100-preview.3.25130.1
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
    parseBuildDate,
    parseCommitHash,
    parseHostCommitHash,
    buildSdkInfo,
} from './sdk-info.mjs';
import {
    decodeBuildDate as decodePackBuildDate,
} from './runtime-pack-resolver.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..', '..');

/**
 * Download a URL and return the body as a string.
 */
async function download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

/**
 * Download a URL to a local file path.
 */
async function downloadToFile(url, dest) {
    const body = await download(url);
    await writeFile(dest, body);
}

/**
 * Run a command and return captured stdout (trimmed).
 */
function runCapture(cmd, args, opts = {}) {
    return execFileSync(cmd, args, {
        encoding: 'utf-8',
        ...opts,
    }).trim();
}

/**
 * Parse VMR source-manifest.json to extract repo commit hashes.
 */
function parseManifest(manifestJson) {
    const data = JSON.parse(manifestJson);
    const repos = data.repositories || [];
    const sdk = repos.find(r => r.path === 'sdk' || r.path === 'src/sdk');
    const runtime = repos.find(r => r.path === 'runtime' || r.path === 'src/runtime');
    return {
        sdkGitHash: sdk?.commitSha || '',
        runtimeGitHash: runtime?.commitSha || '',
    };
}

/**
 * Derive the runtime pack version from an SDK version.
 * e.g. "11.0.100-preview.3.26152.106" → "11.0.0-preview.3.26152.106"
 */
function deriveRuntimeVersion(sdkVersion) {
    return sdkVersion.replace(/^(\d+\.\d+\.)\d+/, (_, prefix) => prefix + '0');
}

/**
 * Refresh artifacts/sdk-list.json by checking the latest daily SDK from the CDN.
 * Fetches the productCommit endpoint with an ETag for conditional checks.
 * On 304 (unchanged) this is a single cheap HTTP round-trip.
 */
async function refreshSdkList(channel) {
    const sdkListPath = join(REPO_DIR, 'artifacts', 'sdk-list.json');
    let sdkListData;
    try {
        sdkListData = JSON.parse(await readFile(sdkListPath, 'utf-8'));
    } catch {
        // Bootstrap empty catalog
        sdkListData = { versions: [] };
    }

    const productCommitUrl = `https://aka.ms/dotnet/${channel}/daily/productCommit-linux-x64.txt`;
    const headers = {};
    if (sdkListData._etag) {
        headers['If-None-Match'] = sdkListData._etag;
    }

    let res;
    try {
        res = await fetch(productCommitUrl, { headers, signal: AbortSignal.timeout(15000) });
    } catch (e) {
        console.error(`  SDK catalog refresh failed (network): ${e.message}`);
        return;
    }

    if (res.status === 304) {
        console.error('  SDK catalog is up to date (304)');
        return;
    }
    if (!res.ok) {
        console.error(`  SDK catalog refresh: HTTP ${res.status}`);
        return;
    }

    // Parse productCommit key="value" pairs (multiple per line)
    const body = await res.text();
    const fields = {};
    for (const [, key, value] of body.matchAll(/(\w+)="([^"]*)"/g)) {
        fields[key] = value;
    }

    const sdkVersion = fields.sdk_version;
    const runtimeVersion = fields.runtime_version;
    const vmrCommit = fields.sdk_commit || fields.runtime_commit;
    if (!sdkVersion) {
        console.error('  SDK catalog refresh: could not parse sdk_version from productCommit');
        return;
    }

    // Update ETag
    const etag = res.headers.get('etag');
    if (etag) sdkListData._etag = etag;
    sdkListData._lastRefreshed = new Date().toISOString();

    // Check if version already in catalog
    const versions = sdkListData.versions || [];
    if (versions.some(e => e.sdkVersion === sdkVersion)) {
        console.error(`  SDK ${sdkVersion} already in catalog, ETag updated`);
        await writeFile(sdkListPath, JSON.stringify(sdkListData, null, 2) + '\n');
        return;
    }

    // New version — resolve runtime git hash from VMR source-manifest
    console.error(`  New SDK ${sdkVersion} found, resolving git hashes...`);
    let runtimeGitHash = '';
    if (vmrCommit) {
        try {
            const manifestText = await download(
                `https://raw.githubusercontent.com/dotnet/dotnet/${vmrCommit}/src/source-manifest.json`
            );
            runtimeGitHash = parseManifest(manifestText).runtimeGitHash;
        } catch {
            console.error(`  Could not resolve runtime hash from VMR commit ${vmrCommit.slice(0, 10)}`);
        }
    }

    const buildDate = decodePackBuildDate(sdkVersion) || '';
    const bandDigit = sdkVersion.match(/^\d+\.\d+\.(\d)/)?.[1] || '1';
    versions.push({
        sdkVersion,
        channel,
        band: `${bandDigit}xx`,
        type: 'daily',
        buildDate,
        runtimeVersion: runtimeVersion || deriveRuntimeVersion(sdkVersion),
        url: `https://ci.dot.net/public/Sdk/${sdkVersion}/dotnet-sdk-${sdkVersion}-linux-x64.tar.gz`,
        runtimeGitHash,
        httpStatus: 200,
        valid: true,
    });
    sdkListData.versions = versions;
    sdkListData.totalVersions = versions.length;
    sdkListData.validVersions = versions.filter(e => e.valid).length;

    await writeFile(sdkListPath, JSON.stringify(sdkListData, null, 2) + '\n');
    console.error(`  Added SDK ${sdkVersion} to catalog (${versions.length} total)`);
}

/**
 * Look up SDK version + git hashes from pre-computed catalog files.
 *
 * When channel is given (no explicit version), finds the latest valid SDK
 * from artifacts/sdk-list.json. When a specific version is given, looks it up directly.
 *
 * Cross-references artifacts/runtime-packs.json for vmrCommit and sdkGitHash.
 *
 * @returns {{ sdkVersion, runtimeGitHash, sdkGitHash, vmrGitHash, buildDate } | null}
 */
async function resolveFromCatalog({ channel, sdkVersion }) {
    let sdkListData, runtimePacksData;
    try {
        sdkListData = JSON.parse(await readFile(join(REPO_DIR, 'artifacts', 'sdk-list.json'), 'utf-8'));
    } catch {
        sdkListData = { versions: [] };
    }
    try {
        runtimePacksData = JSON.parse(await readFile(join(REPO_DIR, 'artifacts', 'runtime-packs.json'), 'utf-8'));
    } catch {
        runtimePacksData = { versions: [] };
    }

    const sdkEntries = (sdkListData.versions || []).filter(e => e.valid);

    let entry;
    if (sdkVersion) {
        // Look up specific version
        entry = sdkEntries.find(e => e.sdkVersion === sdkVersion);
        if (!entry) {
            console.error(`  SDK ${sdkVersion} not found in artifacts/sdk-list.json`);
            return null;
        }
    } else {
        // Find latest valid SDK for the channel
        const channelEntries = sdkEntries.filter(e => e.channel === channel);
        if (channelEntries.length === 0) {
            console.error(`  No valid SDKs found for channel ${channel} in artifacts/sdk-list.json`);
            return null;
        }
        // Sort descending by version string — daily builds sort correctly since
        // they share the same major.minor.patch-label prefix and the date+rev suffix
        // is monotonically increasing.
        channelEntries.sort((a, b) => b.sdkVersion.localeCompare(a.sdkVersion));
        entry = channelEntries[0];
    }

    // Cross-reference with artifacts/runtime-packs.json using the derived runtime version
    const runtimeVersion = entry.runtimeVersion || deriveRuntimeVersion(entry.sdkVersion);
    const packEntry = (runtimePacksData.versions || []).find(e => e.runtimePackVersion === runtimeVersion);

    const result = {
        sdkVersion: entry.sdkVersion,
        runtimeGitHash: packEntry?.runtimeGitHash || entry.runtimeGitHash || '',
        sdkGitHash: packEntry?.sdkGitHash || '',
        vmrGitHash: packEntry?.vmrCommit || '',
        buildDate: entry.buildDate || '',
    };

    console.error(`  Catalog resolved: SDK ${result.sdkVersion}`);
    if (result.runtimeGitHash) console.error(`    runtimeGitHash: ${result.runtimeGitHash}`);
    if (result.sdkGitHash) console.error(`    sdkGitHash:     ${result.sdkGitHash}`);
    if (result.vmrGitHash) console.error(`    vmrGitHash:     ${result.vmrGitHash}`);
    if (result.buildDate) console.error(`    buildDate:      ${result.buildDate}`);

    return result;
}

/**
 * Resolve hashes by running dotnet --info and fetching VMR source-manifest.json.
 * Used as fallback when catalog data is incomplete.
 */
async function resolveHashesFromInstall(installDir) {
    const isWindows = process.platform === 'win32';
    const dotnetBin = join(installDir, isWindows ? 'dotnet.exe' : 'dotnet');
    const resolvedVersion = runCapture(dotnetBin, ['--version']);
    const dotnetInfo = runCapture(dotnetBin, ['--info']);

    const dotnetCommit = parseCommitHash(dotnetInfo) || '0'.repeat(40);
    const hostCommit = parseHostCommitHash(dotnetInfo) || '';

    let vmrGitHash = '';
    let sdkGitHash = '';
    let runtimeGitHash = '';

    const manifestUrl = `https://raw.githubusercontent.com/dotnet/dotnet/${dotnetCommit}/src/source-manifest.json`;
    console.error(`Trying VMR resolution at ${dotnetCommit.substring(0, 10)}...`);

    try {
        const manifestText = await download(manifestUrl);
        const hashes = parseManifest(manifestText);
        vmrGitHash = dotnetCommit;
        sdkGitHash = hashes.sdkGitHash;
        runtimeGitHash = hashes.runtimeGitHash;
        console.error('VMR commit confirmed.');
        console.error(`  vmrGitHash:     ${vmrGitHash}`);
        console.error(`  sdkGitHash:     ${sdkGitHash}`);
        console.error(`  runtimeGitHash: ${runtimeGitHash}`);
    } catch {
        console.error('VMR resolution failed (non-VMR build or network error). Using fallback.');
    }

    if (!sdkGitHash) {
        sdkGitHash = dotnetCommit;
        console.error(`  sdkGitHash (fallback from SDK Commit): ${sdkGitHash}`);
    }
    if (!runtimeGitHash) {
        runtimeGitHash = hostCommit || dotnetCommit;
        console.error(`  runtimeGitHash (fallback from Host Commit): ${runtimeGitHash}`);
    }

    return { resolvedVersion, vmrGitHash, sdkGitHash, runtimeGitHash };
}

/**
 * Install .NET SDK via dotnet-install script.
 * Always uses --version for exact install when version is known.
 * Falls back to --channel/--quality when version is not known.
 */
async function installSdk({ sdkVersion, channel, installDir }) {
    const isWindows = process.platform === 'win32';
    const installScript = join(installDir, isWindows ? 'dotnet-install.ps1' : 'dotnet-install.sh');
    const installUrl = isWindows
        ? 'https://dot.net/v1/dotnet-install.ps1'
        : 'https://dot.net/v1/dotnet-install.sh';
    console.error(`Downloading ${isWindows ? 'dotnet-install.ps1' : 'dotnet-install.sh'}...`);
    await downloadToFile(installUrl, installScript);
    if (!isWindows) await chmod(installScript, 0o755);

    const installArgs = isWindows
        ? ['-InstallDir', installDir]
        : ['--install-dir', installDir];

    if (sdkVersion) {
        console.error(`Installing .NET SDK ${sdkVersion}...`);
        installArgs.push(isWindows ? '-Version' : '--version', sdkVersion);
    } else {
        console.error(`Installing latest .NET SDK from channel ${channel} (daily quality)...`);
        installArgs.push(
            isWindows ? '-Channel' : '--channel', channel,
            isWindows ? '-Quality' : '--quality', 'daily',
        );
    }

    if (isWindows) {
        execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', installScript, ...installArgs], {
            stdio: 'inherit',
            env: { ...process.env, DOTNET_ROOT: installDir },
        });
    } else {
        execFileSync('bash', [installScript, ...installArgs], {
            stdio: 'inherit',
            env: { ...process.env, DOTNET_ROOT: installDir },
        });
    }
}

/**
 * Resolve and install .NET SDK, returning sdk-info object + setting env vars.
 *
 * @param {object} options
 * @param {string} options.channel      SDK channel (e.g. '11.0')
 * @param {string} [options.sdkVersion] Specific SDK version (overrides channel)
 * @param {string} options.installDir   Directory to install SDK into
 * @returns {Promise<object>}           sdk-info object (also written to disk)
 */
export async function resolveSDK({ channel, sdkVersion, installDir }) {
    await mkdir(installDir, { recursive: true });

    const isWindows = process.platform === 'win32';
    const pathSep = isWindows ? ';' : ':';

    // ── Skip download if SDK is already installed ────────────────────────
    const sdkInfoPath = join(installDir, 'sdk-info.json');
    try {
        const existing = JSON.parse(await readFile(sdkInfoPath, 'utf-8'));
        if (existing.sdkVersion) {
            console.error(`SDK already installed at ${installDir} (${existing.sdkVersion}), skipping download.`);
            process.env.DOTNET_ROOT = installDir;
            process.env.PATH = `${installDir}${pathSep}${process.env.PATH}`;
            process.env.DOTNET_NOLOGO = 'true';
            const nugetDir = join(installDir, '..', '..', 'nuget-packages');
            await mkdir(nugetDir, { recursive: true });
            process.env.NUGET_PACKAGES = resolve(nugetDir);
            return existing;
        }
    } catch { /* sdk-info.json missing or invalid — proceed with install */ }

    // ── Refresh catalogs before lookup ──────────────────────────────────
    const refreshChannel = channel || sdkVersion?.match(/^(\d+\.\d+)\./)?.[1];
    if (refreshChannel) {
        try {
            await refreshSdkList(refreshChannel);
        } catch (e) {
            console.error(`  SDK catalog refresh warning: ${e.message}`);
        }
    }

    // ── Resolve version from catalog ─────────────────────────────────────
    console.error('Resolving SDK version from catalog...');
    const catalog = await resolveFromCatalog({ channel, sdkVersion });
    const resolvedSdkVersion = catalog?.sdkVersion || sdkVersion || '';

    // ── Install SDK ──────────────────────────────────────────────────────
    await installSdk({ sdkVersion: resolvedSdkVersion, channel, installDir });

    // Update env for subsequent calls
    process.env.DOTNET_ROOT = installDir;
    process.env.PATH = `${installDir}${pathSep}${process.env.PATH}`;
    process.env.DOTNET_NOLOGO = 'true';

    const nugetDir = join(installDir, '..', '..', 'nuget-packages');
    await mkdir(nugetDir, { recursive: true });
    process.env.NUGET_PACKAGES = resolve(nugetDir);

    // Persist for GitHub Actions
    if (process.env.GITHUB_ENV) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_ENV,
            `DOTNET_ROOT=${installDir}\nPATH=${installDir}:${process.env.PATH}\n`);
    }

    // ── Resolve git hashes ───────────────────────────────────────────────
    // Use catalog data when available, otherwise fall back to dotnet --info
    const dotnetBin = join(installDir, isWindows ? 'dotnet.exe' : 'dotnet');
    const finalVersion = runCapture(dotnetBin, ['--version']);
    let vmrGitHash, sdkGitHash, runtimeGitHash;

    // Check if the installed version matches the catalog version. If not (e.g.
    // the install dir already had a newer SDK), the catalog hashes won't match.
    const catalogValid = catalog?.runtimeGitHash && finalVersion === catalog.sdkVersion;

    if (catalogValid) {
        vmrGitHash = catalog.vmrGitHash;
        sdkGitHash = catalog.sdkGitHash;
        runtimeGitHash = catalog.runtimeGitHash;
    } else {
        if (catalog?.runtimeGitHash && finalVersion !== catalog.sdkVersion) {
            console.error(`Installed version ${finalVersion} differs from catalog ${catalog.sdkVersion}, resolving hashes from install...`);
        } else {
            console.error('Catalog data incomplete, resolving hashes from installed SDK...');
        }
        const resolved = await resolveHashesFromInstall(installDir);
        vmrGitHash = resolved.vmrGitHash;
        sdkGitHash = resolved.sdkGitHash;
        runtimeGitHash = resolved.runtimeGitHash;
    }

    // ── Build date from version string ───────────────────────────────────
    let commitDate = (catalogValid && catalog.buildDate) || parseBuildDate(finalVersion);
    if (!commitDate) {
        console.error('Warning: Could not parse build date from version, using current date');
        commitDate = new Date().toISOString().slice(0, 10);
    }

    const now = new Date();
    const commitTime = [
        String(now.getUTCHours()).padStart(2, '0'),
        String(now.getUTCMinutes()).padStart(2, '0'),
        String(now.getUTCSeconds()).padStart(2, '0'),
        'UTC',
    ].join('-');

    // ── Write sdk-info.json ──────────────────────────────────────────────
    const info = buildSdkInfo(
        finalVersion, runtimeGitHash, sdkGitHash,
        vmrGitHash, commitDate, commitTime, null,
    );
    const infoPath = join(installDir, 'sdk-info.json');
    await writeFile(infoPath, JSON.stringify(info, null, 2) + '\n');

    console.error(JSON.stringify(info, null, 2));
    return info;
}

// ── CLI entry point ─────────────────────────────────────────────────────────
// Allow running directly: node scripts/lib/resolve-sdk.mjs --channel 11.0

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
    const { values } = parseArgs({
        options: {
            'channel': { type: 'string', default: '11.0' },
            'sdk-version': { type: 'string', default: '' },
            'install-dir': { type: 'string', default: '' },
        },
        strict: true,
    });
    const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || join(resolve('.'), 'artifacts');
    const osPrefix = process.platform === 'win32' ? 'windows' : 'linux';
    const sdkDir = `${osPrefix}.sdk${values['sdk-version'] || ''}`;
    const installDir = values['install-dir'] || join(ARTIFACTS_DIR, 'sdks', sdkDir);
    await resolveSDK({
        channel: values.channel,
        sdkVersion: values['sdk-version'],
        installDir,
    });
}
