import { join } from 'node:path';
import { type BenchContext } from '../context.js';
import { dockerBuild } from '../exec.js';
import { banner, info } from '../log.js';

// ── Image Constants ──────────────────────────────────────────────────────────

export const BUILD_IMAGE = 'browser-bench-build:latest';
export const MEASURE_IMAGE = 'browser-bench-measure:latest';

// ── Stage ────────────────────────────────────────────────────────────────────

export async function run(ctx: BenchContext): Promise<BenchContext> {
    if (ctx.skipDockerBuild) {
        info('[docker-image] skipped (--skip-docker-build)');
        return ctx;
    }
    if (ctx.isDocker) {
        info('[docker-image] skipped (already inside a container)');
        return ctx;
    }

    banner('Docker image build');

    const dockerfile = join(ctx.repoRoot, 'docker', 'Dockerfile');
    const buildContext = ctx.repoRoot;

    info(`Building ${BUILD_IMAGE}...`);
    await dockerBuild(BUILD_IMAGE, 'browser-bench-build', dockerfile, buildContext);

    info(`Building ${MEASURE_IMAGE}...`);
    await dockerBuild(MEASURE_IMAGE, 'browser-bench-measure', dockerfile, buildContext);

    info('Docker images ready');
    return ctx;
}
