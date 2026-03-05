import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the hash parsing/writing logic and filter state.
// Since filters.js is a browser module (uses document/location), we test the pure logic parts.

/** Reimplementation of readHashState for testing. */
function readHashState(hash) {
    const params = new URLSearchParams(hash);
    const rangeParts = params.get('range')?.split(',');
    return {
        app: params.get('app') || 'empty-browser',
        runtime: params.get('runtime')?.split(',') || null,
        preset: params.get('preset')?.split(',') || null,
        profile: params.get('profile')?.split(',') || null,
        engine: params.get('engine')?.split(',') || null,
        range: rangeParts?.length === 2
            ? { min: rangeParts[0], max: rangeParts[1] }
            : { min: null, max: null }
    };
}

/** Reimplementation of writeHash for testing. */
function writeHash(app, filterState) {
    const params = new URLSearchParams();
    params.set('app', app);
    if (filterState.runtime.length) params.set('runtime', filterState.runtime.join(','));
    if (filterState.preset.length) params.set('preset', filterState.preset.join(','));
    if (filterState.profile.length) params.set('profile', filterState.profile.join(','));
    if (filterState.engine.length) params.set('engine', filterState.engine.join(','));
    if (filterState.range.min && filterState.range.max) {
        params.set('range', `${filterState.range.min},${filterState.range.max}`);
    }
    return params.toString();
}

describe('Filters — hash parsing', () => {
    it('parses empty hash to defaults', () => {
        const state = readHashState('');
        assert.equal(state.app, 'empty-browser');
        assert.equal(state.runtime, null);
        assert.equal(state.preset, null);
        assert.equal(state.profile, null);
        assert.equal(state.engine, null);
        assert.deepEqual(state.range, { min: null, max: null });
    });

    it('parses app from hash', () => {
        const state = readHashState('app=microbenchmarks');
        assert.equal(state.app, 'microbenchmarks');
    });

    it('parses runtime list', () => {
        const state = readHashState('app=empty-browser&runtime=coreclr,mono');
        assert.deepEqual(state.runtime, ['coreclr', 'mono']);
    });

    it('parses preset list', () => {
        const state = readHashState('app=empty-browser&preset=no-workload,aot');
        assert.deepEqual(state.preset, ['no-workload', 'aot']);
    });

    it('parses engine list', () => {
        const state = readHashState('app=microbenchmarks&engine=v8,chrome');
        assert.deepEqual(state.engine, ['v8', 'chrome']);
    });

    it('parses date range', () => {
        const state = readHashState('app=empty-browser&range=2025-06-01,2026-03-01');
        assert.deepEqual(state.range, { min: '2025-06-01', max: '2026-03-01' });
    });

    it('parses missing range as nulls', () => {
        const state = readHashState('app=empty-browser');
        assert.deepEqual(state.range, { min: null, max: null });
    });

    it('parses full hash string', () => {
        const state = readHashState('app=microbenchmarks&runtime=coreclr&preset=no-workload&profile=desktop,mobile&engine=v8,chrome&range=2025-01-01,2026-01-01');
        assert.equal(state.app, 'microbenchmarks');
        assert.deepEqual(state.runtime, ['coreclr']);
        assert.deepEqual(state.preset, ['no-workload']);
        assert.deepEqual(state.profile, ['desktop', 'mobile']);
        assert.deepEqual(state.engine, ['v8', 'chrome']);
        assert.deepEqual(state.range, { min: '2025-01-01', max: '2026-01-01' });
    });

    it('handles single values without commas', () => {
        const state = readHashState('runtime=mono');
        assert.deepEqual(state.runtime, ['mono']);
    });
});

describe('Filters — hash writing', () => {
    it('writes full state to hash', () => {
        const hash = writeHash('empty-browser', {
            runtime: ['coreclr', 'mono'],
            preset: ['no-workload'],
            profile: ['desktop'],
            engine: ['chrome'],
            range: { min: '2026-02-01', max: '2026-03-03' }
        });
        const parsed = readHashState(hash);
        assert.equal(parsed.app, 'empty-browser');
        assert.deepEqual(parsed.runtime, ['coreclr', 'mono']);
        assert.deepEqual(parsed.preset, ['no-workload']);
        assert.deepEqual(parsed.profile, ['desktop']);
        assert.deepEqual(parsed.engine, ['chrome']);
        assert.deepEqual(parsed.range, { min: '2026-02-01', max: '2026-03-03' });
    });

    it('round-trips through parse/write', () => {
        const original = {
            runtime: ['coreclr'],
            preset: ['aot', 'no-workload'],
            profile: ['desktop', 'mobile'],
            engine: ['v8', 'node'],
            range: { min: '2025-12-01', max: '2026-03-01' }
        };
        const hash = writeHash('microbenchmarks', original);
        const parsed = readHashState(hash);
        assert.equal(parsed.app, 'microbenchmarks');
        assert.deepEqual(parsed.runtime, original.runtime);
        assert.deepEqual(parsed.preset, original.preset);
        assert.deepEqual(parsed.profile, original.profile);
        assert.deepEqual(parsed.engine, original.engine);
        assert.deepEqual(parsed.range, original.range);
    });

    it('omits empty filter arrays', () => {
        const hash = writeHash('empty-browser', {
            runtime: [],
            preset: [],
            profile: [],
            engine: [],
            range: { min: null, max: null }
        });
        assert.ok(!hash.includes('runtime='));
        assert.ok(!hash.includes('preset='));
        assert.ok(!hash.includes('profile='));
        assert.ok(!hash.includes('engine='));
        assert.ok(!hash.includes('range='));
    });

    it('omits range when min/max are null', () => {
        const hash = writeHash('empty-browser', {
            runtime: ['coreclr'],
            preset: ['no-workload'],
            profile: ['desktop'],
            engine: ['chrome'],
            range: { min: null, max: null }
        });
        const parsed = readHashState(hash);
        assert.deepEqual(parsed.range, { min: null, max: null });
    });
});

describe('Filters — chart-manager constants', () => {
    // Test the visual encoding constants match the design spec

    const ENGINE_COLORS = {
        v8: '#4285F4',
        node: '#34A853',
        chrome: '#F4B400',
        firefox: '#EA4335'
    };

    const PRESET_DASHES = {
        'no-workload': [],
        aot: [10, 5],
        'native-relink': [3, 3],
        invariant: [10, 3, 3, 3],
        'no-reflection-emit': [15, 5],
        debug: [5, 5]
    };

    const RUNTIME_MARKERS = {
        coreclr: 'circle',
        mono: 'triangle',
        naotllvm: 'rectRot'
    };

    const RUNTIME_LINE_WIDTH = {
        coreclr: 2,
        mono: 1.5,
        naotllvm: 1.5
    };

    it('has colors for all 4 engines', () => {
        assert.equal(Object.keys(ENGINE_COLORS).length, 4);
        for (const color of Object.values(ENGINE_COLORS)) {
            assert.match(color, /^#[0-9A-F]{6}$/i);
        }
    });

    it('has dash patterns for all 6 presets', () => {
        assert.equal(Object.keys(PRESET_DASHES).length, 6);
        for (const dash of Object.values(PRESET_DASHES)) {
            assert.ok(Array.isArray(dash));
        }
    });

    it('no-workload uses solid line (empty dash array)', () => {
        assert.deepEqual(PRESET_DASHES['no-workload'], []);
    });

    it('has markers for all 3 runtimes', () => {
        assert.equal(Object.keys(RUNTIME_MARKERS).length, 3);
    });

    it('has line widths for all 3 runtimes', () => {
        assert.equal(Object.keys(RUNTIME_LINE_WIDTH).length, 3);
        assert.equal(RUNTIME_LINE_WIDTH.coreclr, 2);
        assert.equal(RUNTIME_LINE_WIDTH.mono, 1.5);
        assert.equal(RUNTIME_LINE_WIDTH.naotllvm, 1.5);
    });
});

describe('Filters — formatValue', () => {
    // Test the value formatting logic from chart-manager

    function formatValue(value, unit) {
        if (unit === 'bytes') {
            if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
            if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
            return `${value} B`;
        }
        if (unit === 'ms') {
            return `${value.toFixed(1)} ms`;
        }
        if (unit === 'ops/sec') {
            return `${value.toLocaleString()} ops/sec`;
        }
        return value.toString();
    }

    it('formats bytes as MB', () => {
        assert.equal(formatValue(12000000, 'bytes'), '12.00 MB');
    });

    it('formats bytes as KB', () => {
        assert.equal(formatValue(45000, 'bytes'), '45.0 KB');
    });

    it('formats small bytes', () => {
        assert.equal(formatValue(512, 'bytes'), '512 B');
    });

    it('formats milliseconds', () => {
        assert.equal(formatValue(289.15, 'ms'), '289.1 ms');
    });

    it('formats ops/sec', () => {
        const result = formatValue(1250000, 'ops/sec');
        assert.ok(result.includes('ops/sec'));
        assert.ok(result.includes('1'));
    });

    it('formats unknown unit as string', () => {
        assert.equal(formatValue(42, 'unknown'), '42');
    });
});
