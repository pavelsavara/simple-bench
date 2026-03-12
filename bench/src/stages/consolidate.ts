import { type BenchContext } from '../context.js';

export async function run(ctx: BenchContext): Promise<BenchContext> {
    // TODO: merge per-run JSON into canonical result file
    console.log('[consolidate] not yet implemented');
    return ctx;
}
