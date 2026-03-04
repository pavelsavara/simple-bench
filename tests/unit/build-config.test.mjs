import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    mapRuntimeFlavor,
    getPresetArgs,
    PRESET_MAP,
    validateCombination,
    getPublishArgs,
    needsWorkload,
    WORKLOAD_PRESETS,
    NON_WORKLOAD_PRESETS,
    getPresetGroups
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
        assert.deepEqual(getPresetArgs('no-workload'), ['/p:BenchmarkPreset=NoWorkload', '-c', 'Release']);
    });

    it('aot → /p:BenchmarkPreset=Aot', () => {
        assert.deepEqual(getPresetArgs('aot'), ['/p:BenchmarkPreset=Aot', '-c', 'Release']);
    });

    it('native-relink → /p:BenchmarkPreset=NativeRelink', () => {
        assert.deepEqual(getPresetArgs('native-relink'), ['/p:BenchmarkPreset=NativeRelink', '-c', 'Release']);
    });

    it('invariant → /p:BenchmarkPreset=Invariant', () => {
        assert.deepEqual(getPresetArgs('invariant'), ['/p:BenchmarkPreset=Invariant', '-c', 'Release']);
    });

    it('no-reflection-emit → /p:BenchmarkPreset=NoReflectionEmit', () => {
        assert.deepEqual(getPresetArgs('no-reflection-emit'), ['/p:BenchmarkPreset=NoReflectionEmit', '-c', 'Release']);
    });

    it('no-jiterp → /p:BenchmarkPreset=NoJiterp', () => {
        assert.deepEqual(getPresetArgs('no-jiterp'), ['/p:BenchmarkPreset=NoJiterp', '-c', 'Release']);
    });

    it('debug → /p:BenchmarkPreset=Debug', () => {
        assert.deepEqual(getPresetArgs('debug'), ['/p:BenchmarkPreset=Debug', '-c', 'Debug']);
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
        const args = getPublishArgs('coreclr', 'no-workload', '/bench/src/empty-browser', '/bench/artifacts/publish/empty-browser');
        assert.deepEqual(args, [
            'publish',
            '/bench/src/empty-browser',
            '/p:BenchmarkPreset=NoWorkload',
            '-c', 'Release',
            '/p:RuntimeFlavor=CoreCLR',
            '-o', '/bench/artifacts/publish/empty-browser'
        ]);
    });

    it('builds full publish args for mono + aot', () => {
        const args = getPublishArgs('mono', 'aot', '/bench/src/empty-browser', '/out');
        assert.deepEqual(args, [
            'publish',
            '/bench/src/empty-browser',
            '/p:BenchmarkPreset=Aot',
            '-c', 'Release',
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
            '-c', 'Debug',
            '/p:RuntimeFlavor=CoreCLR',
            '-o', '/out'
        ]);
    });
});

describe('needsWorkload', () => {
    it('returns true for native-relink', () => {
        assert.equal(needsWorkload('native-relink'), true);
    });

    it('returns true for aot', () => {
        assert.equal(needsWorkload('aot'), true);
    });

    it('returns true for no-jiterp', () => {
        assert.equal(needsWorkload('no-jiterp'), true);
    });

    it('returns true for invariant', () => {
        assert.equal(needsWorkload('invariant'), true);
    });

    it('returns true for no-reflection-emit', () => {
        assert.equal(needsWorkload('no-reflection-emit'), true);
    });

    it('returns false for no-workload', () => {
        assert.equal(needsWorkload('no-workload'), false);
    });

    it('returns false for debug', () => {
        assert.equal(needsWorkload('debug'), false);
    });

    it('returns false for unknown preset', () => {
        assert.equal(needsWorkload('unknown'), false);
    });

    it('all PRESET_MAP presets with WasmBuildNative=true need workload', () => {
        // The five presets that set WasmBuildNative=true in the csproj
        const workloadPresets = ['native-relink', 'aot', 'no-jiterp', 'invariant', 'no-reflection-emit'];
        for (const preset of workloadPresets) {
            assert.equal(needsWorkload(preset), true, `Expected needsWorkload('${preset}') to be true`);
        }
    });

    it('presets without WasmBuildNative do not need workload', () => {
        const noWorkloadPresets = ['debug', 'no-workload'];
        for (const preset of noWorkloadPresets) {
            assert.equal(needsWorkload(preset), false, `Expected needsWorkload('${preset}') to be false`);
        }
    });
});

describe('NON_WORKLOAD_PRESETS', () => {
    it('contains debug and no-workload', () => {
        assert.ok(NON_WORKLOAD_PRESETS.has('debug'));
        assert.ok(NON_WORKLOAD_PRESETS.has('no-workload'));
    });

    it('has exactly 2 entries', () => {
        assert.equal(NON_WORKLOAD_PRESETS.size, 2);
    });

    it('does not overlap with WORKLOAD_PRESETS', () => {
        for (const preset of NON_WORKLOAD_PRESETS) {
            assert.ok(!WORKLOAD_PRESETS.has(preset), `${preset} should not be in WORKLOAD_PRESETS`);
        }
    });
});

describe('WORKLOAD_PRESETS', () => {
    it('contains all 5 workload presets', () => {
        assert.ok(WORKLOAD_PRESETS.has('native-relink'));
        assert.ok(WORKLOAD_PRESETS.has('aot'));
        assert.ok(WORKLOAD_PRESETS.has('no-jiterp'));
        assert.ok(WORKLOAD_PRESETS.has('invariant'));
        assert.ok(WORKLOAD_PRESETS.has('no-reflection-emit'));
    });

    it('has exactly 5 entries', () => {
        assert.equal(WORKLOAD_PRESETS.size, 5);
    });
});

describe('getPresetGroups', () => {
    it('returns sorted non-workload presets', () => {
        const { nonWorkload } = getPresetGroups();
        assert.deepEqual(nonWorkload, ['debug', 'no-workload']);
    });

    it('returns sorted workload presets', () => {
        const { workload } = getPresetGroups();
        assert.deepEqual(workload, ['aot', 'invariant', 'native-relink', 'no-jiterp', 'no-reflection-emit']);
    });

    it('all presets from both groups are in PRESET_MAP', () => {
        const { nonWorkload, workload } = getPresetGroups();
        const allPresets = [...nonWorkload, ...workload];
        for (const preset of allPresets) {
            assert.ok(PRESET_MAP[preset], `Preset '${preset}' should be in PRESET_MAP`);
        }
    });

    it('both groups together cover all PRESET_MAP keys', () => {
        const { nonWorkload, workload } = getPresetGroups();
        const allPresets = new Set([...nonWorkload, ...workload]);
        for (const key of Object.keys(PRESET_MAP)) {
            assert.ok(allPresets.has(key), `PRESET_MAP key '${key}' should be in a preset group`);
        }
    });
});
