import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { exec } from '../exec.js';
import { info, err } from '../log.js';

export interface GitPushOptions {
    repoRoot: string;
    dryRun: boolean;
    /** Paths to `git add` (relative to gh-pages/) */
    addPaths: string[];
    /** Commit message */
    commitMessage: string;
    /** Label for log messages (e.g. "Cache", "Views") */
    label: string;
}

/**
 * Stage, commit, and optionally push changes inside the gh-pages checkout.
 * Returns true if a commit was created.
 */
export async function commitAndPush(opts: GitPushOptions): Promise<boolean> {
    const ghPagesDir = join(opts.repoRoot, 'gh-pages');

    if (!existsSync(join(ghPagesDir, '.git'))) {
        err('gh-pages/ not found — run check-out-cache stage first');
        return false;
    }

    for (const p of opts.addPaths) {
        await exec('git', ['-C', ghPagesDir, 'add', p]);
    }

    const { exitCode } = await exec('git', ['-C', ghPagesDir, 'diff', '--cached', '--quiet'], {
        throwOnError: false,
    });

    if (exitCode === 0) {
        info(`${opts.label} unchanged — nothing to push`);
        return false;
    }

    await exec('git', ['-C', ghPagesDir, 'config', 'user.name', 'github-actions[bot]']);
    await exec('git', ['-C', ghPagesDir, 'config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
    await exec('git', ['-C', ghPagesDir, 'commit', '-m', opts.commitMessage]);

    if (opts.dryRun) {
        info(`${opts.label} committed locally (dry-run — skipping push)`);
    } else {
        await exec('git', ['-C', ghPagesDir, 'push']);
        info(`${opts.label} updated and pushed to gh-pages`);
    }
    return true;
}
