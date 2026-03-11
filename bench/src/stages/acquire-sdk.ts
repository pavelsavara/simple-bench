import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type BenchContext, type SdkInfo } from '../context.js';
import { exec } from '../exec.js';
import { banner, info } from '../log.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Pack entry from daily-packs-list.json or release-packs-list.json */
interface PackListEntry extends SdkInfo {
    bootstrapSdkVersion: string;
}

interface TaggedPack {
    entry: PackListEntry;
    source: 'daily' | 'release';
}

interface ResolvedTarget {
    /** Pack entry for the runtime being tested */
    runtimeEntry: TaggedPack;
    /** Pack entry for the SDK to install (may equal runtimeEntry) */
    sdkEntry: TaggedPack;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DAILY_AZURE_FEED = 'https://ci.dot.net/public';
const INSTALL_SCRIPT_PS1 = 'https://dot.net/v1/dotnet-install.ps1';
const INSTALL_SCRIPT_SH = 'https://dot.net/v1/dotnet-install.sh';
const RUNTIME_PACK_ID = 'microsoft.netcore.app.runtime.mono.browser-wasm';

// ── Pack list loading ────────────────────────────────────────────────────────

async function loadPacks(artifactsDir: string): Promise<TaggedPack[]> {
    const result: TaggedPack[] = [];

    const dailyPath = join(artifactsDir, 'daily-packs-list.json');
    if (existsSync(dailyPath)) {
        const data = JSON.parse(await readFile(dailyPath, 'utf-8')) as { packs: PackListEntry[] };
        for (const entry of data.packs) {
            result.push({ entry, source: 'daily' });
        }
    }

    const releasePath = join(artifactsDir, 'release-packs-list.json');
    if (existsSync(releasePath)) {
        const data = JSON.parse(await readFile(releasePath, 'utf-8')) as { packs: PackListEntry[] };
        for (const entry of data.packs) {
            result.push({ entry, source: 'release' });
        }
    }

    if (result.length === 0) {
        throw new Error(
            'No pack catalogs found. Run enumerate stages first:\n'
            + '  bench --stages enumerate-daily-packs,enumerate-release-packs',
        );
    }

    return result;
}

// ── Target resolution ────────────────────────────────────────────────────────

function resolveTarget(ctx: BenchContext, packs: TaggedPack[]): ResolvedTarget {
    let runtimeTarget: TaggedPack | undefined;
    let sdkTarget: TaggedPack | undefined;

    if (ctx.runtimeCommit && ctx.runtimePack) {
        throw new Error('Cannot specify both --runtime-commit and --runtime-pack');
    }

    // ── Resolve runtime target ───────────────────────────────────────────

    if (ctx.runtimeCommit) {
        const hash = ctx.runtimeCommit;
        const matches = packs.filter(p => p.entry.runtimeGitHash.startsWith(hash));
        if (matches.length === 0) {
            throw new Error(
                `Runtime commit '${hash}' not found in pack catalogs.\n`
                + 'Run enumerate stages to refresh:\n'
                + '  bench --stages enumerate-daily-packs,enumerate-release-packs',
            );
        }
        // First match = latest (lists are sorted newest-first)
        runtimeTarget = matches[0];
    }

    if (ctx.runtimePack) {
        const ver = ctx.runtimePack;
        const match = packs.find(p => p.entry.runtimePackVersion === ver);
        if (!match) {
            throw new Error(
                `Runtime pack version '${ver}' not found in pack catalogs.\n`
                + 'Run enumerate stages to refresh:\n'
                + '  bench --stages enumerate-daily-packs,enumerate-release-packs',
            );
        }
        runtimeTarget = match;
    }

    // ── Resolve SDK target ───────────────────────────────────────────────

    if (ctx.sdkVersion) {
        const ver = ctx.sdkVersion;
        const match = packs.find(p => p.entry.sdkVersion === ver);
        if (!match) {
            throw new Error(
                `SDK version '${ver}' not found in pack catalogs.\n`
                + 'Run enumerate stages to refresh:\n'
                + '  bench --stages enumerate-daily-packs,enumerate-release-packs',
            );
        }
        sdkTarget = match;
    } else if (runtimeTarget) {
        sdkTarget = runtimeTarget;
    } else {
        // Latest for channel
        const channelMajor = parseInt(ctx.sdkChannel.split('.')[0], 10);
        const match = packs.find(p => {
            const major = parseInt(p.entry.sdkVersion.split('.')[0], 10);
            return major === channelMajor;
        });
        if (!match) {
            throw new Error(
                `No SDK found for channel '${ctx.sdkChannel}' in pack catalogs.\n`
                + 'Run enumerate stages first:\n'
                + '  bench --stages enumerate-daily-packs,enumerate-release-packs',
            );
        }
        sdkTarget = match;
    }

    return {
        runtimeEntry: runtimeTarget ?? sdkTarget,
        sdkEntry: sdkTarget,
    };
}

// ── SDK Installation via dotnet-install scripts ──────────────────────────────

async function downloadInstallScript(platform: string): Promise<string> {
    const isWin = platform === 'windows';
    const url = isWin ? INSTALL_SCRIPT_PS1 : INSTALL_SCRIPT_SH;
    const scriptPath = join(tmpdir(), isWin ? 'dotnet-install.ps1' : 'dotnet-install.sh');

    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to download dotnet-install script from ${url}: HTTP ${resp.status}`);
    }
    await writeFile(scriptPath, await resp.text(), 'utf-8');

    if (!isWin) {
        await chmod(scriptPath, 0o755);
    }

    return scriptPath;
}

async function installSdk(
    sdkVersion: string,
    sdkDir: string,
    platform: string,
    source: 'daily' | 'release',
): Promise<void> {
    await mkdir(sdkDir, { recursive: true });
    const scriptPath = await downloadInstallScript(platform);
    info(`Install script: ${scriptPath}`);

    if (platform === 'windows') {
        const args = [
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-Version', sdkVersion,
            '-InstallDir', sdkDir,
        ];
        if (source === 'daily') {
            args.push('-AzureFeed', DAILY_AZURE_FEED);
        }
        await exec('powershell', args, { label: 'dotnet-install.ps1' });
    } else {
        const args = [
            scriptPath,
            '--version', sdkVersion,
            '--install-dir', sdkDir,
        ];
        if (source === 'daily') {
            args.push('--azure-feed', DAILY_AZURE_FEED);
        }
        await exec('bash', args, { label: 'dotnet-install.sh' });
    }
}

// ── Bundled Version Detection ────────────────────────────────────────────────

async function detectBundledRuntimeVersion(sdkDir: string, sdkVersion: string): Promise<string> {
    const propsPath = join(sdkDir, 'sdk', sdkVersion, 'Microsoft.NETCoreSdk.BundledVersions.props');
    if (!existsSync(propsPath)) {
        throw new Error(`BundledVersions.props not found at ${propsPath}`);
    }
    const content = await readFile(propsPath, 'utf-8');
    const match = content.match(/<BundledNETCoreAppPackageVersion>([^<]+)<\/BundledNETCoreAppPackageVersion>/);
    if (!match) {
        throw new Error('Could not parse BundledNETCoreAppPackageVersion from BundledVersions.props');
    }
    return match[1];
}

// ── Runtime Pack Restore ─────────────────────────────────────────────────────

async function restoreRuntimePack(
    dotnetBin: string,
    repoRoot: string,
    artifactsDir: string,
    runtimePackVersion: string,
): Promise<string> {
    const nugetPackagesDir = join(artifactsDir, 'nuget-packages');
    await mkdir(nugetPackagesDir, { recursive: true });

    const restoreProj = join(repoRoot, 'src', 'restore', 'restore-runtime-pack.proj');
    await exec(dotnetBin, [
        'restore', restoreProj,
        `/p:RuntimePackVersion=${runtimePackVersion}`,
        '--packages', nugetPackagesDir,
    ], {
        cwd: repoRoot,
        label: 'restore runtime pack',
        suppressStdout: true,
    });

    const packDir = join(nugetPackagesDir, RUNTIME_PACK_ID, runtimePackVersion);
    if (!existsSync(packDir)) {
        throw new Error(
            `Runtime pack not found after restore at: ${packDir}\n`
            + `Package: ${RUNTIME_PACK_ID} ${runtimePackVersion}`,
        );
    }

    return packDir;
}

// ── Stage Entry Point ────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    banner('Acquire SDK');

    // ── Step 1: Load pack catalogs ───────────────────────────────────────
    const packs = await loadPacks(ctx.artifactsDir);
    info(`Loaded ${packs.length} pack entries`);

    // ── Step 2: Resolve target ───────────────────────────────────────────
    const { runtimeEntry, sdkEntry } = resolveTarget(ctx, packs);

    const sdkVersion = sdkEntry.entry.sdkVersion;
    const runtimePackVersion = runtimeEntry.entry.runtimePackVersion;

    info(`SDK: ${sdkVersion} (${sdkEntry.source})`);
    info(`Runtime pack: ${runtimePackVersion}`);
    info(`Runtime commit: ${runtimeEntry.entry.runtimeGitHash.slice(0, 10)}`);

    // ── Step 3: Paths ────────────────────────────────────────────────────
    const platform = ctx.platform;
    const sdkDirName = `${platform}.sdk${sdkVersion}`;
    const sdkDir = join(ctx.artifactsDir, 'sdks', sdkDirName);
    const dotnetBin = join(sdkDir, platform === 'windows' ? 'dotnet.exe' : 'dotnet');
    const sdkInfoPath = join(sdkDir, 'sdk-info.json');

    // ── Step 4: Check cache ──────────────────────────────────────────────
    let skipInstall = false;
    if (existsSync(sdkInfoPath) && existsSync(dotnetBin)) {
        const existing = JSON.parse(await readFile(sdkInfoPath, 'utf-8')) as SdkInfo;
        if (existing.sdkVersion === sdkVersion) {
            info(`SDK ${sdkVersion} already installed — skipping download`);
            skipInstall = true;
        }
    }

    // ── Step 5: Install SDK ──────────────────────────────────────────────
    if (!skipInstall) {
        info(`Installing SDK ${sdkVersion}...`);
        await installSdk(sdkVersion, sdkDir, platform, sdkEntry.source);
        info(`SDK installed to ${sdkDir}`);
    }

    // ── Step 6: Detect bundled runtime version ───────────────────────────
    const bundledVersion = await detectBundledRuntimeVersion(sdkDir, sdkVersion);
    info(`Bundled runtime pack: ${bundledVersion}`);

    // ── Step 7: Runtime pack override ────────────────────────────────────
    let runtimePackDir: string | undefined;
    if (runtimePackVersion !== bundledVersion) {
        info(`Runtime pack override: ${runtimePackVersion} (bundled: ${bundledVersion})`);
        runtimePackDir = await restoreRuntimePack(
            dotnetBin, ctx.repoRoot, ctx.artifactsDir, runtimePackVersion,
        );
        info(`Runtime pack restored to ${runtimePackDir}`);
    } else {
        info('Runtime pack matches bundled — no override needed');
    }

    // ── Step 8: Build SdkInfo ────────────────────────────────────────────
    const sdkInfo: SdkInfo = {
        sdkVersion,
        runtimeGitHash: runtimeEntry.entry.runtimeGitHash,
        aspnetCoreGitHash: sdkEntry.entry.aspnetCoreGitHash,
        sdkGitHash: sdkEntry.entry.sdkGitHash,
        vmrGitHash: sdkEntry.entry.vmrGitHash,
        runtimeCommitDateTime: runtimeEntry.entry.runtimeCommitDateTime,
        aspnetCoreCommitDateTime: sdkEntry.entry.aspnetCoreCommitDateTime,
        aspnetCoreVersion: sdkEntry.entry.aspnetCoreVersion,
        runtimePackVersion,
        workloadVersion: sdkEntry.entry.workloadVersion,
    };

    await writeFile(sdkInfoPath, JSON.stringify(sdkInfo, null, 2) + '\n');
    info(`SDK info written to ${sdkInfoPath}`);

    // ── Step 9: Build label ──────────────────────────────────────────────
    const buildLabel = runtimePackDir
        ? `${sdkVersion}_${runtimePackVersion}`
        : sdkVersion;

    // ── Step 10: Update context ──────────────────────────────────────────
    return {
        ...ctx,
        sdkDir,
        dotnetBin,
        sdkInfo,
        buildLabel,
        runtimePackDir,
        publishDir: join(ctx.artifactsDir, 'publish'),
        resultsDir: join(ctx.artifactsDir, 'results'),
    };
}
