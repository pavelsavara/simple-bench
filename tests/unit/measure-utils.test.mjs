import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMimeType, startStaticServer, measureFileSizes, buildResultJson, readCompileTime } from '../../scripts/lib/measure-utils.mjs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── getMimeType ─────────────────────────────────────────────────────────────

describe('getMimeType', () => {
    it('returns correct MIME for .html', () => {
        assert.equal(getMimeType('index.html'), 'text/html');
    });

    it('returns correct MIME for .js', () => {
        assert.equal(getMimeType('app.js'), 'application/javascript');
    });

    it('returns correct MIME for .mjs', () => {
        assert.equal(getMimeType('dotnet.mjs'), 'application/javascript');
    });

    it('returns correct MIME for .wasm', () => {
        assert.equal(getMimeType('dotnet.native.wasm'), 'application/wasm');
    });

    it('returns correct MIME for .dll', () => {
        assert.equal(getMimeType('System.Runtime.dll'), 'application/octet-stream');
    });

    it('returns correct MIME for .json', () => {
        assert.equal(getMimeType('blazor.boot.json'), 'application/json');
    });

    it('returns correct MIME for .css', () => {
        assert.equal(getMimeType('style.css'), 'text/css');
    });

    it('returns correct MIME for .svg', () => {
        assert.equal(getMimeType('icon.svg'), 'image/svg+xml');
    });

    it('returns octet-stream for unknown extension', () => {
        assert.equal(getMimeType('file.xyz'), 'application/octet-stream');
    });

    it('is case-insensitive', () => {
        assert.equal(getMimeType('FILE.HTML'), 'text/html');
        assert.equal(getMimeType('dotnet.WASM'), 'application/wasm');
    });
});

// ── startStaticServer ───────────────────────────────────────────────────────

describe('startStaticServer', () => {
    let tmpDir;
    let srv;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `bench-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
        if (srv) await srv.close();
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('serves files with correct MIME types', async () => {
        await writeFile(join(tmpDir, 'index.html'), '<html></html>');
        srv = await startStaticServer(tmpDir);

        const res = await fetch(`http://127.0.0.1:${srv.port}/`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/html');
        const body = await res.text();
        assert.equal(body, '<html></html>');
    });

    it('returns 404 for missing files', async () => {
        srv = await startStaticServer(tmpDir);
        const res = await fetch(`http://127.0.0.1:${srv.port}/nonexistent.js`);
        assert.equal(res.status, 404);
    });

    it('sends COOP/COEP headers', async () => {
        await writeFile(join(tmpDir, 'index.html'), 'ok');
        srv = await startStaticServer(tmpDir);

        const res = await fetch(`http://127.0.0.1:${srv.port}/`);
        assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
    });

    it('blocks path traversal', async () => {
        srv = await startStaticServer(tmpDir);
        const res = await fetch(`http://127.0.0.1:${srv.port}/../../../etc/passwd`);
        // Should get 403 or 404 (not serve a file outside rootDir)
        assert.ok(res.status === 403 || res.status === 404);
    });

    it('auto-assigns port when port=0', async () => {
        srv = await startStaticServer(tmpDir, 0);
        assert.ok(srv.port > 0, `Expected a port > 0, got ${srv.port}`);
    });
});

// ── measureFileSizes ────────────────────────────────────────────────────────

describe('measureFileSizes', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `bench-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(join(tmpDir, '_framework'), { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('measures total, wasm and dll sizes', async () => {
        await writeFile(join(tmpDir, 'index.html'), Buffer.alloc(100));
        await writeFile(join(tmpDir, '_framework', 'dotnet.native.wasm'), Buffer.alloc(1024));
        await writeFile(join(tmpDir, '_framework', 'System.Runtime.dll'), Buffer.alloc(512));
        await writeFile(join(tmpDir, '_framework', 'App.dll'), Buffer.alloc(256));

        const sizes = await measureFileSizes(tmpDir);
        assert.equal(sizes.wasmSize, 1024);
        assert.equal(sizes.dllsSize, 768); // 512 + 256
        assert.equal(sizes.totalSize, 100 + 1024 + 512 + 256); // all files
    });

    it('returns zeros when _framework directory missing', async () => {
        const emptyDir = join(tmpdir(), `bench-empty-${Date.now()}`);
        await mkdir(emptyDir, { recursive: true });
        const sizes = await measureFileSizes(emptyDir);
        assert.equal(sizes.totalSize, 0);
        assert.equal(sizes.wasmSize, 0);
        assert.equal(sizes.dllsSize, 0);
        await rm(emptyDir, { recursive: true, force: true });
    });

    it('handles nested directories', async () => {
        await mkdir(join(tmpDir, '_framework', 'sub'), { recursive: true });
        await writeFile(join(tmpDir, '_framework', 'dotnet.wasm'), Buffer.alloc(2048));
        await writeFile(join(tmpDir, '_framework', 'sub', 'Nested.dll'), Buffer.alloc(100));

        const sizes = await measureFileSizes(tmpDir);
        assert.equal(sizes.wasmSize, 2048);
        assert.equal(sizes.dllsSize, 100);
    });

    it('ignores non-wasm non-dll files', async () => {
        await writeFile(join(tmpDir, '_framework', 'dotnet.native.wasm'), Buffer.alloc(500));
        await writeFile(join(tmpDir, '_framework', 'blazor.boot.json'), Buffer.alloc(300));
        await writeFile(join(tmpDir, '_framework', 'dotnet.js'), Buffer.alloc(200));

        const sizes = await measureFileSizes(tmpDir);
        assert.equal(sizes.wasmSize, 500);
        assert.equal(sizes.dllsSize, 0);
    });
});

// ── buildResultJson ─────────────────────────────────────────────────────────

describe('buildResultJson', () => {
    it('assembles meta + metrics', () => {
        const meta = { commitDate: '2026-03-02', runtime: 'coreclr', preset: 'no-workload', engine: 'chrome', app: 'empty-browser' };
        const metrics = { 'compile-time': 45200, 'disk-size-total': 12100920 };

        const result = buildResultJson(meta, metrics);
        assert.deepEqual(result.meta, meta);
        assert.deepEqual(result.metrics, metrics);
    });

    it('strips null metrics', () => {
        const meta = { runtime: 'mono' };
        const metrics = { 'compile-time': 1000, 'memory-peak': null, 'disk-size-wasm': undefined };

        const result = buildResultJson(meta, metrics);
        assert.deepEqual(result.metrics, { 'compile-time': 1000 });
    });

    it('strips NaN and Infinity', () => {
        const meta = {};
        const metrics = { 'compile-time': NaN, 'memory-peak': Infinity, 'disk-size-total': 500 };

        const result = buildResultJson(meta, metrics);
        assert.deepEqual(result.metrics, { 'disk-size-total': 500 });
    });

    it('rounds fractional values to integers', () => {
        const meta = {};
        const metrics = { 'time-to-reach-managed': 100.315, 'memory-peak': 6777276.8, 'disk-size-total': 22930236 };

        const result = buildResultJson(meta, metrics);
        assert.deepEqual(result.metrics, {
            'time-to-reach-managed': 100,
            'memory-peak': 6777277,
            'disk-size-total': 22930236,
        });
    });
});

// ── readCompileTime ─────────────────────────────────────────────────────────

describe('readCompileTime', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = join(tmpdir(), `bench-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('reads compileTimeMs from JSON', async () => {
        const file = join(tmpDir, 'compile-time.json');
        await writeFile(file, JSON.stringify({ compileTimeMs: 45200, app: 'empty-browser' }));

        const ms = await readCompileTime(file);
        assert.equal(ms, 45200);
    });

    it('returns null for missing file', async () => {
        const ms = await readCompileTime(join(tmpDir, 'nonexistent.json'));
        assert.equal(ms, null);
    });

    it('returns null when compileTimeMs is not a number', async () => {
        const file = join(tmpDir, 'bad.json');
        await writeFile(file, JSON.stringify({ compileTimeMs: 'fast' }));

        const ms = await readCompileTime(file);
        assert.equal(ms, null);
    });
});
