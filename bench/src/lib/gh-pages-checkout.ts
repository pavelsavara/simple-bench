import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { exec, execCapture } from '../exec.js';
import { info, debug } from '../log.js';

/**
 * Ensure the gh-pages branch is available locally under <repoRoot>/gh-pages/.
 *   • If the folder already contains a .git directory: git pull
 *   • Otherwise: git clone --branch gh-pages --single-branch --depth 1
 *
 * Returns the path to the gh-pages directory.
 */
export async function ensureGhPagesCheckout(repoRoot: string, verbose?: boolean): Promise<string> {
    const ghPagesDir = join(repoRoot, 'gh-pages');

    if (existsSync(join(ghPagesDir, '.git'))) {
        info('gh-pages/ exists — pulling latest');
        await exec('git', ['-C', ghPagesDir, 'pull'], { throwOnError: false });
    } else {
        info('gh-pages/ not found — cloning gh-pages branch');
        await exec('git', ['config', '--global', '--add', 'safe.directory', repoRoot], { throwOnError: false });
        const remoteUrl = await execCapture('git', ['remote', 'get-url', 'origin'], {
            cwd: repoRoot,
        });
        await exec('git', [
            'clone', '--branch', 'gh-pages', '--single-branch', '--depth', '1',
            remoteUrl, ghPagesDir,
        ]);

        // Propagate any extraheader auth from the main checkout so push works in CI
        const extraHeader = await execCapture('git', [
            '-C', repoRoot, 'config', '--get', 'http.https://github.com/.extraheader',
        ], { throwOnError: false });
        if (extraHeader) {
            await exec('git', [
                '-C', ghPagesDir, 'config',
                'http.https://github.com/.extraheader', extraHeader,
            ]);
        }
    }

    if (verbose) debug(`gh-pages checkout ready at ${ghPagesDir}`);
    return ghPagesDir;
}
