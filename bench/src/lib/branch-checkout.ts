import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { exec, execCapture } from '../exec.js';
import { info, debug } from '../log.js';

/**
 * Ensure a given branch is available locally under <repoRoot>/<localDir>/.
 *   • If the folder already contains a .git directory: git pull
 *   • Otherwise: git clone --branch <branch> --single-branch --depth 1
 *
 * Returns the path to the checkout directory.
 */
export async function ensureBranchCheckout(repoRoot: string, branch: string, localDir: string, verbose?: boolean): Promise<string> {
    const dir = join(repoRoot, localDir);

    if (existsSync(join(dir, '.git'))) {
        info(`${localDir}/ exists — pulling latest`);
        await exec('git', ['-C', dir, 'pull'], { throwOnError: false });
    } else {
        info(`${localDir}/ not found — cloning ${branch} branch`);
        await exec('git', ['config', '--global', '--add', 'safe.directory', repoRoot], { throwOnError: false });
        const remoteUrl = await execCapture('git', ['remote', 'get-url', 'origin'], {
            cwd: repoRoot,
        });
        await exec('git', [
            'clone', '--branch', branch, '--single-branch', '--depth', '1',
            remoteUrl, dir,
        ]);

        // Propagate any extraheader auth from the main checkout so push works in CI
        const extraHeader = await execCapture('git', [
            '-C', repoRoot, 'config', '--get', 'http.https://github.com/.extraheader',
        ], { throwOnError: false });
        if (extraHeader) {
            await exec('git', [
                '-C', dir, 'config',
                'http.https://github.com/.extraheader', extraHeader,
            ]);
        }
    }

    if (verbose) debug(`${branch} checkout ready at ${dir}`);
    return dir;
}
