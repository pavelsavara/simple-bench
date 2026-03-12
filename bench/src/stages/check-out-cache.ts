import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { type BenchContext } from '../context.js';
import { exec, execCapture } from '../exec.js';
import { info, debug } from '../log.js';

// ── Stage: check-out-cache ───────────────────────────────────────────────────
//
// Ensures the gh-pages branch is available locally under <repoRoot>/gh-pages/.
//   • Locally (folder already exists): git pull
//   • CI (folder missing): git clone --branch gh-pages --single-branch --depth 1
//
// Then seeds artifacts/ with cached pack lists (only if the artifact files are
// missing), so that subsequent enumerate-daily-packs / enumerate-release-packs
// stages can perform incremental updates.

const CACHE_FILES = ['daily-packs-list.json', 'release-packs-list.json', 'commits-list.json'];

export async function run(ctx: BenchContext): Promise<BenchContext> {
    const ghPagesDir = join(ctx.repoRoot, 'gh-pages');

    if (existsSync(join(ghPagesDir, '.git'))) {
        // Locally: folder is already a clone / worktree — just pull
        info('gh-pages/ exists — pulling latest');
        await exec('git', ['-C', ghPagesDir, 'pull'], { throwOnError: false });
    } else {
        // CI or first local checkout — clone the gh-pages branch
        info('gh-pages/ not found — cloning gh-pages branch');
        const remoteUrl = await execCapture('git', ['remote', 'get-url', 'origin'], {
            cwd: ctx.repoRoot,
        });
        await exec('git', [
            'clone', '--branch', 'gh-pages', '--single-branch', '--depth', '1',
            remoteUrl, ghPagesDir,
        ]);
    }

    // Seed artifacts with cached pack lists (only when missing)
    await mkdir(ctx.artifactsDir, { recursive: true });

    for (const file of CACHE_FILES) {
        const src = join(ghPagesDir, 'cache', file);
        const dst = join(ctx.artifactsDir, file);
        if (!existsSync(dst) && existsSync(src)) {
            info(`Seeding ${file} from gh-pages cache`);
            await copyFile(src, dst);
        } else if (ctx.verbose) {
            debug(`${file}: ${existsSync(dst) ? 'already exists in artifacts' : 'no cache available'}`);
        }
    }

    return ctx;
}
