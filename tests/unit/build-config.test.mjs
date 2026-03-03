import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    mapRuntimeFlavor,
    getPresetArgs,
    PRESET_MAP,
    validateCombination,
    getPublishArgs
} from '../../scripts/lib/build-config.mjs';

describe('mapRuntimeFlavor', () => {
    it('maps coreclr to CoreCLR', () => {
        assert.equal(mapRuntimeFlavor('coreclr'), 'CoreCLR');
    });

    it('maps mono to Mono', () => {
        assert.equal(mapRuntimeFlavor('mono'), 'Mono');
    });

    it('throws on unknown runtime', () => {
        assert.throws(
            () => mapRuntimeFlavor('invalid'),
            { message: /Unknown runtime: invalid/ }
        );
    });

    it('maps naotllvm to Mono (legacy data only)', () => {
        assert.equal(mapRuntimeFlavor('naotllvm'), 'Mono');
    });
});

describe('getPresetArgs', () => {
    it('no-workload → /p:BenchmarkPreset=NoWorkload', () => {
        assert.deepEqual(getPresetArgs('no-workload'), ['/p:BenchmarkPreset=NoWorkload']);
    });

    it('aot → /p:BenchmarkPreset=Aot', () => {
        assert.deepEqual(getPresetArgs('aot'), ['/p:BenchmarkPreset=Aot']);
    });

    it('native-relink → /p:BenchmarkPreset=NativeRelink', () => {
        assert.deepEqual(getPresetArgs('native-relink'), ['/p:BenchmarkPreset=NativeRelink']);
    });

    it('invariant → /p:BenchmarkPreset=Invariant', () => {
        assert.deepEqual(getPresetArgs('invariant'), ['/p:BenchmarkPreset=Invariant']);
    });

    it('no-reflection-emit → /p:BenchmarkPreset=NoReflectionEmit', () => {
        assert.deepEqual(getPresetArgs('no-reflection-emit'), ['/p:BenchmarkPreset=NoReflectionEmit']);
    });

    it('no-jiterp → /p:BenchmarkPreset=NoJiterp', () => {
        assert.deepEqual(getPresetArgs('no-jiterp'), ['/p:BenchmarkPreset=NoJiterp']);
    });

    it('debug → /p:BenchmarkPreset=Debug', () => {
        assert.deepEqual(getPresetArgs('debug'), ['/p:BenchmarkPreset=Debug']);
    });

    it('throws on unknown preset', () => {
        assert.throws(
            () => getPresetArgs('invalid'),
            { message: /Unknown preset/ }
        );
    });

    it('PRESET_MAP covers all 7 presets', () => {
        assert.equal(Object.keys(PRESET_MAP).length, 7);
    });
});

describe('validateCombination', () => {
    it('allows mono + aot', () => {
        assert.equal(validateCombination('mono', 'aot'), true);
    });

    it('rejects coreclr + aot', () => {
        assert.throws(
            () => validateCombination('coreclr', 'aot'),
            { message: /only valid with runtime 'mono'/ }
        );
    });

    it('allows mono + no-jiterp', () => {
        assert.equal(validateCombination('mono', 'no-jiterp'), true);
    });

    it('rejects coreclr + no-jiterp', () => {
        assert.throws(
            () => validateCombination('coreclr', 'no-jiterp'),
            { message: /only valid with runtime 'mono'/ }
        );
    });

    it('allows coreclr + no-workload', () => {
        assert.equal(validateCombination('coreclr', 'no-workload'), true);
    });

    it('allows mono + no-workload', () => {
        assert.equal(validateCombination('mono', 'no-workload'), true);
    });

    it('allows coreclr + native-relink', () => {
        assert.equal(validateCombination('coreclr', 'native-relink'), true);
    });
});

describe('getPublishArgs', () => {
    it('builds full publish args for coreclr + no-workload', () => {
        const args = getPublishArgs('coreclr', 'no-workload', '/bench/apps/empty-browser', '/bench/artifacts/publish/empty-browser');
        assert.deepEqual(args, [
            'publish',
            '/bench/apps/empty-browser',
            '/p:BenchmarkPreset=NoWorkload',
            '/p:RuntimeFlavor=CoreCLR',
            '-o', '/bench/artifacts/publish/empty-browser'
        ]);
    });

    it('builds full publish args for mono + aot', () => {
        const args = getPublishArgs('mono', 'aot', '/bench/apps/empty-browser', '/out');
        assert.deepEqual(args, [
            'publish',
            '/bench/apps/empty-browser',
            '/p:BenchmarkPreset=Aot',
            '/p:RuntimeFlavor=Mono',
            '-o', '/out'
        ]);
    });

    it('rejects coreclr + aot combination', () => {
        assert.throws(
            () => getPublishArgs('coreclr', 'aot', '/app', '/out'),
            { message: /only valid with runtime 'mono'/ }
        );
    });

    it('builds publish args for debug preset (uses publish, not build)', () => {
        const args = getPublishArgs('coreclr', 'debug', '/app', '/out');
        assert.deepEqual(args, [
            'publish',
            '/app',
            '/p:BenchmarkPreset=Debug',
            '/p:RuntimeFlavor=CoreCLR',
            '-o', '/out'
        ]);
    });
});
