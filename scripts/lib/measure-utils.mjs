/**
 * Utility functions for measure-external.mjs.
 * Extracted for testability — no Playwright dependency.
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';

// ── MIME types ──────────────────────────────────────────────────────────────

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.dll': 'application/octet-stream',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.dat': 'application/octet-stream',
    '.pdb': 'application/octet-stream',
    '.blat': 'application/octet-stream',
};

export function getMimeType(filePath) {
    return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── Static HTTP server ──────────────────────────────────────────────────────

/**
 * Start a static file server with COOP/COEP headers for SharedArrayBuffer support.
 * @param {string} rootDir Absolute path to the directory to serve
 * @param {number} port Port number (0 = auto-assign)
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export function startStaticServer(rootDir, port = 0) {
    const resolvedRoot = resolve(rootDir);
    return new Promise((resolvePromise, reject) => {
        const server = createServer(async (req, res) => {
            // Cross-Origin-Isolation headers (required for SharedArrayBuffer / threading)
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

            const urlPath = new URL(req.url, 'http://localhost').pathname;
            const filePath = normalize(join(resolvedRoot, urlPath === '/' ? 'index.html' : urlPath));

            // Path traversal protection
            if (!filePath.startsWith(resolvedRoot)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            try {
                const data = await readFile(filePath);
                res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
                res.end(data);
            } catch {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        server.listen(port, '127.0.0.1', () => {
            const assignedPort = server.address().port;
            resolvePromise({
                server,
                port: assignedPort,
                close: () => new Promise((r) => server.close(r)),
            });
        });
        server.on('error', reject);
    });
}

// ── File size measurement ───────────────────────────────────────────────────

/**
 * Walk the publish directory's _framework/ folder and measure wasm + dll sizes.
 * @param {string} publishDir Path to published app directory
 * @returns {Promise<{wasmSize: number, dllsSize: number}>}
 */
export async function measureFileSizes(publishDir) {
    const frameworkDir = join(publishDir, '_framework');
    let wasmSize = 0;
    let dllsSize = 0;

    let entries;
    try {
        entries = await readdir(frameworkDir, { recursive: true, withFileTypes: true });
    } catch {
        return { wasmSize: 0, dllsSize: 0 };
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parentPath = entry.parentPath || entry.path;
        const fullPath = join(parentPath, entry.name);
        const fileStat = await stat(fullPath);
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.wasm') wasmSize += fileStat.size;
        else if (ext === '.dll') dllsSize += fileStat.size;
    }

    return { wasmSize, dllsSize };
}

// ── Result JSON builder ─────────────────────────────────────────────────────

/**
 * Assemble the per-run result JSON from meta info and metric values.
 * @param {object} meta  Dimension + traceability info
 * @param {object} metrics  Key → numeric value (only non-null entries)
 * @returns {object}
 */
export function buildResultJson(meta, metrics) {
    // Strip null/undefined metrics
    const cleanMetrics = {};
    for (const [k, v] of Object.entries(metrics)) {
        if (v != null && Number.isFinite(v)) {
            cleanMetrics[k] = v;
        }
    }
    return { meta, metrics: cleanMetrics };
}

// ── Compile time reader ─────────────────────────────────────────────────────

/**
 * Read compile-time from the JSON produced by build-app.sh.
 * @param {string} filePath Path to compile-time.json
 * @returns {Promise<number|null>} Compile time in ms, or null if not found
 */
export async function readCompileTime(filePath) {
    try {
        const data = JSON.parse(await readFile(filePath, 'utf-8'));
        return typeof data.compileTimeMs === 'number' ? data.compileTimeMs : null;
    } catch {
        return null;
    }
}

// ── SDK info reader ─────────────────────────────────────────────────────────

/**
 * Read sdk-info.json produced by resolve-sdk.sh.
 * @param {string} filePath Path to sdk-info.json
 * @returns {Promise<{sdkVersion: string, gitHash: string, commitDate: string, commitTime: string}>}
 */
export async function readSdkInfo(filePath) {
    return JSON.parse(await readFile(filePath, 'utf-8'));
}
