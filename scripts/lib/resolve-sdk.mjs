/**
 * resolve-sdk.mjs — Download .NET SDK and resolve version + git hashes.
 *
 * JS port of resolve-sdk.sh. Can be imported as a library or run as a script.
 *
 * Resolution algorithm:
 *   1. Download dotnet-install.sh, install SDK
 *   2. Run `dotnet --info`, extract commit hashes
 *   3. Fetch src/source-manifest.json from dotnet/dotnet VMR at that commit
 *   4. If found → parse sdk + runtime hashes from manifest
 *   5. Fallback: SDK Commit → sdkGitHash, Host Commit → runtimeGitHash
 *   6. Write sdk-info.json
 *
 * Usage as script:
 *   node scripts/lib/resolve-sdk.mjs --channel 11.0 --install-dir artifacts/sdk
 *   node scripts/lib/resolve-sdk.mjs --sdk-version 11.0.100-preview.3.25130.1
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
    parseBuildDate,
    parseCommitHash,
    parseHostCommitHash,
    buildSdkInfo,
} from './sdk-info.mjs';

/**
 * Download a URL and return the body as a string.
 * Uses native fetch (Node 18+).
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
 * Run a command, inheriting stderr, suppressing stdout.
 */
function runQuiet(cmd, args, opts = {}) {
    execFileSync(cmd, args, {
        stdio: ['inherit', 'pipe', 'inherit'],
        ...opts,
    });
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
            // Still set env vars so subsequent steps find the SDK
            process.env.DOTNET_ROOT = installDir;
            process.env.PATH = `${installDir}${pathSep}${process.env.PATH}`;
            process.env.DOTNET_NOLOGO = 'true';
            const nugetDir = join(installDir, '..', 'nuget-packages');
            await mkdir(nugetDir, { recursive: true });
            process.env.NUGET_PACKAGES = resolve(nugetDir);
            return existing;
        }
    } catch { /* sdk-info.json missing or invalid — proceed with install */ }

    // ── Download and run dotnet-install script ─────────────────────────
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

    // Update env for subsequent calls
    process.env.DOTNET_ROOT = installDir;
    process.env.PATH = `${installDir}${pathSep}${process.env.PATH}`;
    process.env.DOTNET_NOLOGO = 'true';

    // Place NuGet cache inside artifacts so it's isolated and reproducible
    const nugetDir = join(installDir, '..', 'nuget-packages');
    await mkdir(nugetDir, { recursive: true });
    process.env.NUGET_PACKAGES = resolve(nugetDir);

    // Persist for GitHub Actions
    if (process.env.GITHUB_ENV) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_ENV,
            `DOTNET_ROOT=${installDir}\nPATH=${installDir}:${process.env.PATH}\n`);
    }

    // ── Extract version and commit info ──────────────────────────────────
    const dotnetBin = join(installDir, isWindows ? 'dotnet.exe' : 'dotnet');
    const resolvedVersion = runCapture(dotnetBin, ['--version']);
    const dotnetInfo = runCapture(dotnetBin, ['--info']);

    const dotnetCommit = parseCommitHash(dotnetInfo) || '0'.repeat(40);
    const hostCommit = parseHostCommitHash(dotnetInfo) || '';

    // ── Resolve three git hashes via VMR manifest ────────────────────────
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

        console.error('VMR commit confirmed. Extracting repo hashes from source-manifest.json...');
        console.error(`  vmrGitHash:     ${vmrGitHash}`);
        console.error(`  sdkGitHash:     ${sdkGitHash}`);
        console.error(`  runtimeGitHash: ${runtimeGitHash}`);
    } catch {
        console.error('VMR resolution failed (non-VMR build or network error). Using fallback.');
    }

    // Fallbacks
    if (!sdkGitHash) {
        sdkGitHash = dotnetCommit;
        console.error(`  sdkGitHash (fallback from SDK Commit): ${sdkGitHash}`);
    }
    if (!runtimeGitHash) {
        runtimeGitHash = hostCommit || dotnetCommit;
        console.error(`  runtimeGitHash (fallback from Host Commit): ${runtimeGitHash}`);
    }

    // ── Build date from version string ───────────────────────────────────
    let commitDate = parseBuildDate(resolvedVersion);
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
        resolvedVersion, runtimeGitHash, sdkGitHash,
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
    const installDir = values['install-dir'] || join(ARTIFACTS_DIR, sdkDir);
    await resolveSDK({
        channel: values.channel,
        sdkVersion: values['sdk-version'],
        installDir,
    });
}
