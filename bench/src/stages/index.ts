import { type BenchContext } from '../context.js';
import { Stage } from '../enums.js';
import { banner } from '../log.js';

// ── Stage Function Type ──────────────────────────────────────────────────────

export type StageFn = (ctx: BenchContext) => Promise<BenchContext>;

// ── Registry ─────────────────────────────────────────────────────────────────

const stageHandlers = new Map<Stage, StageFn>();

export function registerStage(stage: Stage, handler: StageFn): void {
    stageHandlers.set(stage, handler);
}

// ── Register All Stages ──────────────────────────────────────────────────────

import { run as dockerImage } from './docker-image.js';
import { run as acquireSdk } from './acquire-sdk.js';
import { run as build } from './build.js';
import { run as measure } from './measure.js';
import { run as consolidate } from './consolidate.js';
import { run as schedule } from './schedule.js';
import { run as enumerateCommits } from './enumerate-commits.js';
import { run as enumeratePacks } from './enumerate-packs.js';
import { run as enumerateSdks } from './enumerate-sdks.js';
import { run as transformViews } from './transform-views.js';

registerStage(Stage.EnumerateCommits, enumerateCommits);
registerStage(Stage.EnumeratePacks, enumeratePacks);
registerStage(Stage.EnumerateSdks, enumerateSdks);
registerStage(Stage.DockerImage, dockerImage);
registerStage(Stage.AcquireSdk, acquireSdk);
registerStage(Stage.Build, build);
registerStage(Stage.Measure, measure);
registerStage(Stage.Consolidate, consolidate);
registerStage(Stage.Schedule, schedule);
registerStage(Stage.TransformViews, transformViews);

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runStages(ctx: BenchContext): Promise<BenchContext> {
    let current = ctx;
    for (const stage of current.stages) {
        const handler = stageHandlers.get(stage);
        if (!handler) {
            throw new Error(`Stage '${stage}' has no registered handler.`);
        }
        if (current.verbose) {
            banner(`Stage: ${stage}`);
        }
        current = await handler(current);
    }
    return current;
}
