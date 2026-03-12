import { type BenchContext } from '../context.js';

export async function run(ctx: BenchContext): Promise<BenchContext> {
    // TODO: discover SDKs, enqueue benchmark jobs
    console.log('[schedule] not yet implemented');
    return ctx;
}
