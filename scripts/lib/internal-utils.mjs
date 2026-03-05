/**
 * Utility functions for measure-internal.mjs.
 * Extracted for testability — no Playwright or child_process dependency.
 */

import { INTERNAL_METRICS } from './metrics.mjs';

/**
 * Parse benchmark results JSON from CLI engine stdout.
 * Scans from the last line backwards for a valid JSON object,
 * since dotnet runtime may print diagnostic output before results.
 * @param {string} stdout Raw stdout from CLI engine
 * @returns {object} Parsed benchmark results
 */
export function parseCliOutput(stdout) {
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('{')) continue;
        try {
            const result = JSON.parse(line);
            if (typeof result === 'object' && result !== null) {
                return result;
            }
        } catch { continue; }
    }
    throw new Error('No valid JSON result found in CLI output:\n' + stdout.slice(-500));
}

/**
 * Get the CLI command and arguments for a given engine.
 * @param {string} engine Engine name ('v8' or 'node')
 * @returns {{ cmd: string, args: string[] }}
 */
export function getEngineCommand(engine) {
    switch (engine) {
        case 'v8': return { cmd: process.platform === 'win32' ? 'v8.cmd' : 'd8', args: ['--module'] };
        case 'node': return { cmd: 'node', args: [] };
        default: throw new Error(`CLI not supported for engine: ${engine}`);
    }
}

/**
 * Validate that benchmark results contain all expected internal metrics
 * as positive finite numbers.
 * @param {object} results Benchmark results object
 * @returns {true}
 * @throws {Error} If any metric is missing or invalid
 */
export function validateBenchResults(results) {
    for (const key of INTERNAL_METRICS) {
        const val = results[key];
        if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
            throw new Error(`Invalid benchmark result for '${key}': ${val}`);
        }
    }
    return true;
}
