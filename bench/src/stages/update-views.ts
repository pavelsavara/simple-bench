import { type BenchContext } from '../context.js';
import { commitAndPush } from '../lib/git-push.js';

// ── Stage: update-views ──────────────────────────────────────────────────────
//
// Commits and pushes everything that transform-views wrote into gh-pages/data/
// (month indexes, result files, and view JSON files).
//
// Requires check-out-cache (gh-pages/ must exist) and transform-views to have
// run first.

export async function run(ctx: BenchContext): Promise<BenchContext> {
    await commitAndPush({
        repoRoot: ctx.repoRoot,
        dryRun: ctx.dryRun,
        addPaths: ['data/'],
        commitMessage: `Update views ${new Date().toISOString().slice(0, 10)}`,
        label: 'Views',
    });

    return ctx;
}
