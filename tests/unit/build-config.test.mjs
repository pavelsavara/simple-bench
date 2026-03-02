import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    mapRuntimeFlavor,
    getConfigArgs,
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

    it('throws on llvm_naot (not buildable, legacy only)', () => {
        assert.throws(
            () => mapRuntimeFlavor('llvm_naot'),
            { message: /Unknown runtime/ }
        );
    });
});

describe('getConfigArgs', () => {
    it('release → -c Release', () => {
        assert.deepEqual(getConfigArgs('release'), ['-c', 'Release']);
    });

    it('aot → -c Release + AOT flag', () => {
        assert.deepEqual(getConfigArgs('aot'), ['-c', 'Release', '/p:RunAOTCompilation=true']);
    });

    it('native-relink → -c Release + relink flag', () => {
        assert.deepEqual(getConfigArgs('native-relink'), ['-c', 'Release', '/p:WasmNativeRelink=true']);
    });

    it('invariant → -c Release + globalization flag', () => {
        assert.deepEqual(getConfigArgs('invariant'), ['-c', 'Release', '/p:InvariantGlobalization=true']);
    });

    it('no-reflection-emit → -c Release + no-ref-emit flag', () => {
        assert.deepEqual(getConfigArgs('no-reflection-emit'), ['-c', 'Release', '/p:_WasmNoReflectionEmit=true']);
    });

    it('debug → -c Debug', () => {
        assert.deepEqual(getConfigArgs('debug'), ['-c', 'Debug']);
    });

    it('throws on unknown config', () => {
        assert.throws(
            () => getConfigArgs('invalid'),
            { message: /Unknown config/ }
        );
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

    it('allows coreclr + release', () => {
        assert.equal(validateCombination('coreclr', 'release'), true);
    });

    it('allows mono + release', () => {
        assert.equal(validateCombination('mono', 'release'), true);
    });

    it('allows coreclr + native-relink', () => {
        assert.equal(validateCombination('coreclr', 'native-relink'), true);
    });
});

describe('getPublishArgs', () => {
    it('builds full publish args for coreclr + release', () => {
        const args = getPublishArgs('coreclr', 'release', '/bench/apps/empty-browser', '/bench/artifacts/publish/empty-browser');
        assert.deepEqual(args, [
            'publish',
            '/bench/apps/empty-browser',
            '-c', 'Release',
            '/p:RuntimeFlavor=CoreCLR',
            '-o', '/bench/artifacts/publish/empty-browser'
        ]);
    });

    it('builds full publish args for mono + aot', () => {
        const args = getPublishArgs('mono', 'aot', '/bench/apps/empty-browser', '/out');
        assert.deepEqual(args, [
            'publish',
            '/bench/apps/empty-browser',
            '-c', 'Release',
            '/p:RunAOTCompilation=true',
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
});
