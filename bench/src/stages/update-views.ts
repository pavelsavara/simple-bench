import { type BenchContext } from '../context.js';
import { commitAndPush } from '../lib/git-push.js';
import { info } from '../log.js';

// ── Stage: update-views ──────────────────────────────────────────────────────
//
// Commits and pushes everything that transform-views wrote into gh-pages/data/
// (month indexes, result files, and view JSON files).
//
// Requires check-out-data (gh-pages/ must exist) and transform-views to have
// run first.

export async function run(ctx: BenchContext): Promise<BenchContext> {
    if (ctx.dryRun) {
        info('Skipping update-views (dry-run)');
        return ctx;
    }

    await commitAndPush({
        repoRoot: ctx.repoRoot,
        dryRun: false,
        checkoutDir: 'gh-pages',
        addPaths: ['data/views/'],
        commitMessage: `Update views ${new Date().toISOString().slice(0, 10)}`,
        label: 'Views',
    });

    return ctx;
}
