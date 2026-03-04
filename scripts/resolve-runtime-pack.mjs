#!/usr/bin/env node
/**
 * resolve-runtime-pack.mjs — Download the browser-wasm runtime pack for a
 * specific dotnet/runtime commit from the public Azure Artifacts feed.
 *
 * Usage:
 *   node scripts/resolve-runtime-pack.mjs <runtime-commit> [options]
 *
 * Options:
 *   --major <n>          .NET major version (default: 11)
 *   --strategy <s>       'closest-after' (default), 'closest-before', 'exact'
 *   --dest <dir>         Destination directory for extracted packs
 *                        (default: artifacts/runtime-packs)
 *   --output-json        Print result as JSON to stdout
 *
 * Examples:
 *   node scripts/resolve-runtime-pack.mjs 17b089f9dea34dff21e3417ab7ed53ef30a4f6b0
 *   node scripts/resolve-runtime-pack.mjs e524be69 --strategy exact --output-json
 *
 * Output:
 *   Prints the path to the extracted runtime pack directory.
 *   With --output-json, prints a JSON object with:
 *     { packDir, version, runtimeCommit, vmrCommit, match }
 */

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { resolveRuntimePack } from './lib/runtime-pack-resolver.mjs';

const { values: opts, positionals } = parseArgs({
    options: {
        'major': { type: 'string', default: '11' },
        'strategy': { type: 'string', default: 'closest-after' },
        'dest': { type: 'string', default: '' },
        'output-json': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
});

const runtimeCommit = positionals[0];
if (!runtimeCommit) {
    console.error('Usage: resolve-runtime-pack.mjs <runtime-commit> [--major N] [--strategy S] [--dest DIR]');
    process.exit(1);
}

const REPO_DIR = resolve(new URL('.', import.meta.url).pathname, '..');
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || join(REPO_DIR, 'artifacts');

const destDir = opts.dest || join(ARTIFACTS_DIR, 'runtime-packs');
const major = parseInt(opts.major, 10);
const strategy = opts.strategy;

try {
    const result = await resolveRuntimePack(runtimeCommit, {
        major,
        destDir,
        strategy,
    });

    if (opts['output-json']) {
        // Clean output for piping
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(result.packDir);
    }
} catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
}
