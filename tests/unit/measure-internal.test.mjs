import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseCliOutput,
    getEngineCommand,
    validateBenchResults,
} from '../../scripts/lib/internal-utils.mjs';

// ── parseCliOutput ──────────────────────────────────────────────────────────

describe('parseCliOutput', () => {
    it('parses JSON from a single line', () => {
        const result = parseCliOutput('{"js-interop-ops":100000,"json-parse-ops":50000,"exception-ops":10000}\n');
        assert.deepEqual(result, {
            'js-interop-ops': 100000,
            'json-parse-ops': 50000,
            'exception-ops': 10000,
        });
    });

    it('finds JSON on the last line after diagnostic output', () => {
        const stdout = [
            'Microbenchmarks ready',
            'Some dotnet diagnostic info',
            'Loading assemblies...',
            '{"js-interop-ops":99999,"json-parse-ops":45000,"exception-ops":8000}',
        ].join('\n');
        const result = parseCliOutput(stdout);
        assert.equal(result['js-interop-ops'], 99999);
        assert.equal(result['json-parse-ops'], 45000);
        assert.equal(result['exception-ops'], 8000);
    });

    it('scans backwards past non-JSON trailing lines', () => {
        const stdout = [
            '{"js-interop-ops":50000,"json-parse-ops":25000,"exception-ops":5000}',
            'Some trailing log line',
            'Another trailing line',
        ].join('\n');
        const result = parseCliOutput(stdout);
        assert.equal(result['js-interop-ops'], 50000);
    });

    it('throws on empty output', () => {
        assert.throws(() => parseCliOutput(''), /No valid JSON/);
    });

    it('throws on output with no JSON', () => {
        assert.throws(() => parseCliOutput('just text\nmore text\n'), /No valid JSON/);
    });

    it('throws on malformed JSON', () => {
        assert.throws(() => parseCliOutput('{not-json}\n'), /No valid JSON/);
    });

    it('handles whitespace around JSON line', () => {
        const stdout = '  \n  {"js-interop-ops":1,"json-parse-ops":2,"exception-ops":3}  \n  \n';
        const result = parseCliOutput(stdout);
        assert.equal(result['js-interop-ops'], 1);
    });

    it('ignores non-object JSON values', () => {
        const stdout = '"just a string"\n42\n{"js-interop-ops":100}\n';
        const result = parseCliOutput(stdout);
        assert.equal(result['js-interop-ops'], 100);
    });

    it('prefers later JSON lines over earlier ones', () => {
        const stdout = [
            '{"partial":true}',
            '{"js-interop-ops":999,"json-parse-ops":888,"exception-ops":777}',
        ].join('\n');
        const result = parseCliOutput(stdout);
        assert.equal(result['js-interop-ops'], 999);
    });
});

// ── getEngineCommand ────────────────────────────────────────────────────────

describe('getEngineCommand', () => {
    it('returns d8 --module for v8 engine', () => {
        const { cmd, args } = getEngineCommand('v8');
        assert.equal(cmd, 'd8');
        assert.deepEqual(args, ['--module']);
    });

    it('returns node (no extra args) for node engine', () => {
        const { cmd, args } = getEngineCommand('node');
        assert.equal(cmd, 'node');
        assert.deepEqual(args, []);
    });

    it('throws for unsupported browser engines', () => {
        assert.throws(() => getEngineCommand('chrome'), /CLI not supported/);
        assert.throws(() => getEngineCommand('firefox'), /CLI not supported/);
    });

    it('throws for unknown engine names', () => {
        assert.throws(() => getEngineCommand('spidermonkey'), /CLI not supported/);
        assert.throws(() => getEngineCommand(''), /CLI not supported/);
    });
});

// ── validateBenchResults ────────────────────────────────────────────────────

describe('validateBenchResults', () => {
    it('accepts valid results with all three metrics', () => {
        const results = {
            'js-interop-ops': 100000,
            'json-parse-ops': 50000,
            'exception-ops': 10000,
        };
        assert.equal(validateBenchResults(results), true);
    });

    it('accepts results with extra keys', () => {
        const results = {
            'js-interop-ops': 100000,
            'json-parse-ops': 50000,
            'exception-ops': 10000,
            'extra-metric': 42,
        };
        assert.equal(validateBenchResults(results), true);
    });

    it('rejects missing js-interop-ops', () => {
        assert.throws(
            () => validateBenchResults({ 'json-parse-ops': 50000, 'exception-ops': 10000 }),
            /js-interop-ops/
        );
    });

    it('rejects missing json-parse-ops', () => {
        assert.throws(
            () => validateBenchResults({ 'js-interop-ops': 100000, 'exception-ops': 10000 }),
            /json-parse-ops/
        );
    });

    it('rejects missing exception-ops', () => {
        assert.throws(
            () => validateBenchResults({ 'js-interop-ops': 100000, 'json-parse-ops': 50000 }),
            /exception-ops/
        );
    });

    it('rejects zero values', () => {
        assert.throws(
            () => validateBenchResults({
                'js-interop-ops': 0,
                'json-parse-ops': 50000,
                'exception-ops': 10000,
            }),
            /js-interop-ops/
        );
    });

    it('rejects negative values', () => {
        assert.throws(
            () => validateBenchResults({
                'js-interop-ops': -1,
                'json-parse-ops': 50000,
                'exception-ops': 10000,
            }),
            /js-interop-ops/
        );
    });

    it('rejects NaN values', () => {
        assert.throws(
            () => validateBenchResults({
                'js-interop-ops': NaN,
                'json-parse-ops': 50000,
                'exception-ops': 10000,
            }),
            /js-interop-ops/
        );
    });

    it('rejects Infinity values', () => {
        assert.throws(
            () => validateBenchResults({
                'js-interop-ops': Infinity,
                'json-parse-ops': 50000,
                'exception-ops': 10000,
            }),
            /js-interop-ops/
        );
    });

    it('rejects string values', () => {
        assert.throws(
            () => validateBenchResults({
                'js-interop-ops': '100000',
                'json-parse-ops': 50000,
                'exception-ops': 10000,
            }),
            /js-interop-ops/
        );
    });

    it('rejects null values', () => {
        assert.throws(
            () => validateBenchResults({
                'js-interop-ops': null,
                'json-parse-ops': 50000,
                'exception-ops': 10000,
            }),
            /js-interop-ops/
        );
    });
});
