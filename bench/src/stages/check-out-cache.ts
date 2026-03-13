import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { type BenchContext } from '../context.js';
import { info, debug } from '../log.js';
import { ensureGhPagesCheckout } from '../lib/gh-pages-checkout.js';

// ── Stage: check-out-cache ───────────────────────────────────────────────────
//
// Ensures the gh-pages branch is available locally under <repoRoot>/gh-pages/.
// Then seeds artifacts/ with cached pack lists (only if the artifact files are
// missing), so that subsequent enumerate-daily-packs / enumerate-release-packs
// stages can perform incremental updates.

const CACHE_FILES = ['daily-packs-list.json', 'release-packs-list.json', 'commits-list.json'];

export async function run(ctx: BenchContext): Promise<BenchContext> {
    const ghPagesDir = await ensureGhPagesCheckout(ctx.repoRoot, ctx.verbose);

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
