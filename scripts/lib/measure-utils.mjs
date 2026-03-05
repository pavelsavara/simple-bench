/**
 * Utility functions for measure-external.mjs.
 * Extracted for testability — no Playwright dependency.
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';

// ── Endpoints / fingerprint resolution ───────────────────────────────────────

/**
 * Load and parse a staticwebassets.endpoints.json file.
 * Returns a fingerprintMap: label (e.g. "main.js") → fingerprint (e.g. "gf82s7dqcs")
 * used to resolve #[.{fingerprint}] patterns in served HTML.
 * @param {string} endpointsJsonPath Absolute path to *.staticwebassets.endpoints.json
 * @returns {Promise<Map<string,string>>} label → fingerprint
 */
export async function loadEndpointsMap(endpointsJsonPath) {
    try {
        const data = JSON.parse(await readFile(endpointsJsonPath, 'utf-8'));
        const endpoints = data.Endpoints || [];
        const fingerprintMap = new Map();
        for (const ep of endpoints) {
            const props = ep.EndpointProperties || [];
            const fp = props.find(p => p.Name === 'fingerprint');
            const label = props.find(p => p.Name === 'label');
            if (fp && label) {
                fingerprintMap.set(label.Value, fp.Value);
            }
        }
        return fingerprintMap;
    } catch {
        return new Map();
    }
}

/**
 * Replace #[.{fingerprint}] patterns in HTML content using the fingerprint map.
 * Pattern: name#[.{fingerprint}].ext → name.{fp}.ext
 * @param {string} html HTML content
 * @param {Map<string,string>} fingerprintMap label → fingerprint
 * @returns {string} Resolved HTML
 */
export function resolveFingerprints(html, fingerprintMap) {
    if (!fingerprintMap || fingerprintMap.size === 0) return html;
    // Match patterns like: main#[.{fingerprint}].js  or  style#[.{fingerprint}].css
    return html.replace(/([\w.-]+)#\[\.\{fingerprint\}\](\.[\w]+)/g, (match, base, ext) => {
        const label = base + ext;
        const fp = fingerprintMap.get(label);
        if (fp) return `${base}.${fp}${ext}`;
        return match; // no mapping found, leave unchanged
    });
}

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
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
};

export function getMimeType(filePath) {
    return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── Static HTTP server ──────────────────────────────────────────────────────

/**
 * Start a static file server with COOP/COEP headers for SharedArrayBuffer support.
 * @param {string} rootDir Absolute path to the directory to serve
 * @param {number} port Port number (0 = auto-assign)
 * @param {object} [options] Options
 * @param {Map<string,string>} [options.fingerprintMap] label → fingerprint map from loadEndpointsMap()
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export function startStaticServer(rootDir, port = 0, options = {}) {
    const resolvedRoot = resolve(rootDir);
    const { fingerprintMap } = options;
    return new Promise((resolvePromise, reject) => {
        const server = createServer(async (req, res) => {
            // Cross-Origin-Isolation headers (required for SharedArrayBuffer / threading)
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            // Allow high-resolution Resource Timing data
            res.setHeader('Timing-Allow-Origin', '*');

            const urlPath = new URL(req.url, 'http://localhost').pathname;
            const filePath = normalize(join(resolvedRoot, urlPath === '/' ? 'index.html' : urlPath));

            // Path traversal protection
            if (!filePath.startsWith(resolvedRoot)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            try {
                let data = await readFile(filePath);
                const mime = getMimeType(filePath);
                // Resolve #[.{fingerprint}] patterns in HTML responses
                if (fingerprintMap && mime === 'text/html') {
                    data = Buffer.from(resolveFingerprints(data.toString('utf-8'), fingerprintMap));
                }
                res.writeHead(200, { 'Content-Type': mime });
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
 * Walk the publish directory and measure total, wasm, and dll sizes.
 * Total size covers the entire publish directory; wasm/dll are from _framework/.
 * @param {string} publishDir Path to published app directory
 * @returns {Promise<{totalSize: number, wasmSize: number, dllsSize: number}>}
 */
export async function measureFileSizes(publishDir) {
    // Total size of the entire publish directory
    let totalSize = 0;
    try {
        const allEntries = await readdir(publishDir, { recursive: true, withFileTypes: true });
        for (const entry of allEntries) {
            if (!entry.isFile()) continue;
            const parentPath = entry.parentPath || entry.path;
            const fullPath = join(parentPath, entry.name);
            const fileStat = await stat(fullPath);
            totalSize += fileStat.size;
        }
    } catch {
        // publishDir doesn't exist or can't be read
    }

    // WASM + DLL sizes from _framework/
    const frameworkDir = join(publishDir, '_framework');
    let wasmSize = 0;
    let dllsSize = 0;

    let entries;
    try {
        entries = await readdir(frameworkDir, { recursive: true, withFileTypes: true });
    } catch {
        return { totalSize, wasmSize: 0, dllsSize: 0 };
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

    return { totalSize, wasmSize, dllsSize };
}

// ── Result JSON builder ─────────────────────────────────────────────────────

/**
 * Assemble the per-run result JSON from meta info and metric values.
 * @param {object} meta  Dimension + traceability info
 * @param {object} metrics  Key → numeric value (only non-null entries)
 * @returns {object}
 */
export function buildResultJson(meta, metrics) {
    // Strip null/undefined metrics and round numbers to integers
    const cleanMetrics = {};
    for (const [k, v] of Object.entries(metrics)) {
        if (v != null && Number.isFinite(v)) {
            cleanMetrics[k] = Math.round(v);
        }
    }
    return { meta, metrics: cleanMetrics };
}

// ── Compile time reader ─────────────────────────────────────────────────────

/**
 * Read compile-time from the JSON produced by build-app.mjs.
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
 * Read sdk-info.json produced by resolve-sdk.mjs.
 * @param {string} filePath Path to sdk-info.json
 * @returns {Promise<{sdkVersion: string, runtimeGitHash: string, sdkGitHash: string, vmrGitHash: string, commitDate: string, commitTime: string}>}
 */
export async function readSdkInfo(filePath) {
    return JSON.parse(await readFile(filePath, 'utf-8'));
}
