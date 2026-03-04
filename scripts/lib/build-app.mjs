/**
 * build-app.mjs — Build and publish a single sample app with MSBuild flags.
 *
 * JS port of build-app.sh. Can be imported as a library or run as a script.
 *
 * Output:
 *   - Published app in artifacts/publish/{app}/{commitDate}/{preset}/
 *   - Compile time in artifacts/publish/{app}/{commitDate}/{preset}/compile-time.json
 *
 * Usage as script:
 *   node scripts/lib/build-app.mjs --app empty-browser --runtime mono --preset devloop
 */

import { execFileSync } from 'node:child_process';
import { writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPublishArgs, validateCombination } from './build-config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..', '..');

/**
 * Detect the .NET SDK major version from `dotnet --version`.
 * Returns the major version number, or 0 on failure.
 */
function detectSdkMajor(dotnetBin) {
    try {
        const version = execFileSync(dotnetBin, ['--version'], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return parseInt(version.split('.')[0], 10) || 0;
    } catch {
        return 0;
    }
}

/**
 * Resolve the dotnet binary path.
 */
function findDotnet() {
    const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    const fromEnv = process.env.DOTNET_ROOT
        ? join(process.env.DOTNET_ROOT, exe)
        : null;
    if (fromEnv) {
        try {
            execFileSync(fromEnv, ['--version'], { stdio: 'ignore' });
            return fromEnv;
        } catch { /* fall through */ }
    }
    return 'dotnet';
}

/**
 * Resolve the app directory, handling v6v7 variant projects.
 */
function resolveAppDir(app, sdkMajor) {
    let appDir = join(REPO_DIR, 'src', app);
    // Microsoft.NET.Sdk.WebAssembly was introduced in .NET 8.
    // For .NET 6 and 7, some apps need the BlazorWebAssembly-based variant.
    if (sdkMajor > 0 && sdkMajor < 8) {
        if (app === 'empty-browser' || app === 'microbenchmarks') {
            const variantDir = join(REPO_DIR, 'src', `${app}-v6v7`);
            console.error(`SDK major ${sdkMajor}: using BlazorWebAssembly variant for ${app}`);
            appDir = variantDir;
        }
    }
    return appDir;
}

/**
 * Build and publish a single app.
 *
 * @param {object} options
 * @param {string} options.app           App name (e.g. 'empty-browser')
 * @param {string} options.runtime       Runtime flavor ('mono' or 'coreclr')
 * @param {string} options.preset        Build preset name (e.g. 'devloop', 'aot')
 * @param {string} [options.commitDate]  Commit date segment for artifact paths (e.g. '2026-06-02')
 * @param {string} [options.artifactsDir] Artifacts directory (default: env or ./artifacts)
 * @param {string} [options.customRuntimePackDir] Optional custom runtime pack directory
 * @returns {Promise<{compileTimeMs: number, publishDir: string}>}
 */
export async function buildApp({ app, runtime, preset, commitDate, artifactsDir, customRuntimePackDir }) {
    validateCombination(runtime, preset);

    const effectiveArtifactsDir = artifactsDir
        || process.env.ARTIFACTS_DIR
        || join(REPO_DIR, 'artifacts');

    const dateSegment = commitDate || 'local';
    const dotnetBin = findDotnet();
    const sdkMajor = detectSdkMajor(dotnetBin);
    const appDir = resolveAppDir(app, sdkMajor);
    const publishDir = join(effectiveArtifactsDir, 'publish', app, dateSegment, preset);

    // Get publish arguments from build-config
    const publishArgs = getPublishArgs(runtime, preset, appDir, publishDir);

    // Pass CommitDate to MSBuild so bin/obj paths match
    publishArgs.push(`/p:CommitDate=${dateSegment}`);

    // Append custom runtime pack if specified
    if (customRuntimePackDir || process.env.CUSTOM_RUNTIME_PACK_DIR) {
        const packDir = customRuntimePackDir || process.env.CUSTOM_RUNTIME_PACK_DIR;
        publishArgs.push(`/p:CustomRuntimePackDir=${packDir}`);
        console.error(`Using custom runtime pack: ${packDir}`);
    }

    // Clean publish directory for this combination
    await rm(publishDir, { recursive: true, force: true });
    await mkdir(publishDir, { recursive: true });

    console.error(`Building ${app} (runtime=${runtime}, preset=${preset})...`);
    console.error(`  dotnet ${publishArgs.join(' ')}`);

    // Record compile time
    const startTime = performance.now();

    execFileSync(dotnetBin, publishArgs, {
        stdio: 'inherit',
        env: process.env,
        cwd: REPO_DIR,
    });

    const compileTimeMs = Math.round(performance.now() - startTime);
    console.error(`Build completed in ${compileTimeMs}ms`);

    // Write compile-time.json for downstream consumption
    const compileTimeData = {
        compileTimeMs,
        app,
        runtime,
        preset,
    };
    await writeFile(
        join(publishDir, 'compile-time.json'),
        JSON.stringify(compileTimeData, null, 2) + '\n',
    );

    return { compileTimeMs, publishDir };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
    const { values } = parseArgs({
        options: {
            'app': { type: 'string' },
            'runtime': { type: 'string', default: 'mono' },
            'preset': { type: 'string' },
        },
        strict: true,
    });
    if (!values.app || !values.preset) {
        console.error('Usage: node scripts/lib/build-app.mjs --app <app> --runtime <runtime> --preset <preset>');
        process.exit(1);
    }
    await buildApp({
        app: values.app,
        runtime: values.runtime,
        preset: values.preset,
    });
}
