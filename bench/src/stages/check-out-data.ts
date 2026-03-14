import { type BenchContext } from '../context.js';
import { ensureBranchCheckout } from '../lib/branch-checkout.js';

// ── Stage: check-out-data ────────────────────────────────────────────────────
//
// Ensures the gh-pages branch is available locally under <repoRoot>/gh-pages/.
// This provides access to the published data/views/ directory containing
// benchmark pivot views.

export async function run(ctx: BenchContext): Promise<BenchContext> {
    await ensureBranchCheckout(ctx.repoRoot, 'gh-pages', 'gh-pages', ctx.verbose);
    return ctx;
}
