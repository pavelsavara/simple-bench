import { type BenchContext } from '../context.js';
import { ensureBranchCheckout } from '../lib/branch-checkout.js';

// ── Stage: check-out-data ────────────────────────────────────────────────────
//
// Ensures the gh-pages branch is available locally under <repoRoot>/gh-pages/.
// This provides access to the data/ directory containing benchmark results,
// month indexes, and pivot views.

export async function run(ctx: BenchContext): Promise<BenchContext> {
    await ensureBranchCheckout(ctx.repoRoot, 'gh-pages', 'gh-pages', ctx.verbose);
    return ctx;
}
