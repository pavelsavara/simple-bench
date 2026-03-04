import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, EXTERNAL_METRICS, INTERNAL_METRICS } from '../../scripts/lib/metrics.mjs';

describe('METRICS registry', () => {
    it('has 12 metric definitions', () => {
        assert.equal(Object.keys(METRICS).length, 12);
    });

    it('all entries have displayName, unit, and category', () => {
        for (const [key, def] of Object.entries(METRICS)) {
            assert.ok(def.displayName, `${key} missing displayName`);
            assert.ok(def.unit, `${key} missing unit`);
            assert.ok(def.category === 'external' || def.category === 'internal',
                `${key} has invalid category: ${def.category}`);
        }
    });

    it('external metrics have ms or bytes units', () => {
        for (const key of EXTERNAL_METRICS) {
            const { unit } = METRICS[key];
            assert.ok(unit === 'ms' || unit === 'bytes',
                `External metric ${key} has unexpected unit: ${unit}`);
        }
    });

    it('internal metrics have ops/sec unit', () => {
        for (const key of INTERNAL_METRICS) {
            assert.equal(METRICS[key].unit, 'ops/sec', `Internal metric ${key} should be ops/sec`);
        }
    });

    it('EXTERNAL_METRICS has 9 entries', () => {
        assert.equal(EXTERNAL_METRICS.length, 9);
    });

    it('INTERNAL_METRICS has 3 entries', () => {
        assert.equal(INTERNAL_METRICS.length, 3);
    });

    it('contains all expected external metric keys', () => {
        const expected = [
            'compile-time', 'disk-size-total', 'disk-size-wasm',
            'disk-size-dlls', 'download-size-total', 'time-to-reach-managed', 'time-to-reach-managed-cold',
            'memory-peak', 'pizza-walkthru',
        ];
        for (const key of expected) {
            assert.ok(EXTERNAL_METRICS.includes(key), `Missing external metric: ${key}`);
        }
    });

    it('contains all expected internal metric keys', () => {
        const expected = ['js-interop-ops', 'json-parse-ops', 'exception-ops'];
        for (const key of expected) {
            assert.ok(INTERNAL_METRICS.includes(key), `Missing internal metric: ${key}`);
        }
    });
});
