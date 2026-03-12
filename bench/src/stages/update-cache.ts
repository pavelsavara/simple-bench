import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { type BenchContext } from '../context.js';
import { exec } from '../exec.js';
import { info, err } from '../log.js';

// ── Stage: update-cache ──────────────────────────────────────────────────────
//
// Copies updated pack/commit lists from artifacts/ back into the gh-pages
// branch's cache/ directory, then commits and pushes if anything changed.
//
// Requires check-out-cache to have run first (gh-pages/ must exist).

const CACHE_FILES = ['daily-packs-list.json', 'release-packs-list.json', 'commits-list.json'];

export async function run(ctx: BenchContext): Promise<BenchContext> {
    const ghPagesDir = join(ctx.repoRoot, 'gh-pages');

    if (!existsSync(join(ghPagesDir, '.git'))) {
        err('gh-pages/ not found — run check-out-cache stage first');
        return ctx;
    }

    const cacheDir = join(ghPagesDir, 'cache');
    await mkdir(cacheDir, { recursive: true });

    // Copy updated lists into gh-pages cache
    for (const file of CACHE_FILES) {
        const src = join(ctx.artifactsDir, file);
        if (existsSync(src)) {
            info(`Updating cache: ${file}`);
            await copyFile(src, join(cacheDir, file));
        }
    }

    // Stage, commit, and push if there are changes
    await exec('git', ['-C', ghPagesDir, 'add', 'cache/']);

    const { exitCode } = await exec('git', ['-C', ghPagesDir, 'diff', '--cached', '--quiet'], {
        throwOnError: false,
    });

    if (exitCode !== 0) {
        await exec('git', ['-C', ghPagesDir, 'config', 'user.name', 'github-actions[bot]']);
        await exec('git', ['-C', ghPagesDir, 'config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
        await exec('git', ['-C', ghPagesDir, 'commit', '-m', `Update cache ${new Date().toISOString().slice(0, 10)}`]);
        if (ctx.dryRun) {
            info('Cache committed locally (dry-run — skipping push)');
        } else {
            await exec('git', ['-C', ghPagesDir, 'push']);
            info('Cache updated and pushed to gh-pages');
        }
    } else {
        info('Cache unchanged — nothing to push');
    }

    return ctx;
}
