import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { type BenchContext } from '../context.js';
import { commitAndPush } from '../lib/git-push.js';
import { info } from '../log.js';

// ── Stage: update-cache ──────────────────────────────────────────────────────
//
// Copies updated pack/commit lists from artifacts/ back into the gh-pages
// branch's cache/ directory, then commits and pushes if anything changed.
//
// Requires check-out-cache to have run first (gh-pages/ must exist).

const CACHE_FILES = ['daily-packs-list.json', 'release-packs-list.json', 'commits-list.json'];

export async function run(ctx: BenchContext): Promise<BenchContext> {
    const ghPagesDir = join(ctx.repoRoot, 'gh-pages');
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

    await commitAndPush({
        repoRoot: ctx.repoRoot,
        dryRun: ctx.dryRun,
        addPaths: ['cache/'],
        commitMessage: `Update cache ${new Date().toISOString().slice(0, 10)}`,
        label: 'Cache',
    });

    return ctx;
}
