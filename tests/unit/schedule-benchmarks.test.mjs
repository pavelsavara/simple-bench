import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Gap detection logic tests ───────────────────────────────────────────────
// These test the core gap-detection algorithm inline since schedule-benchmarks.mjs
// doesn't export its functions (it's a CLI script).

/**
 * Replicate the findMissingCommits logic from schedule-benchmarks.mjs
 * for unit testing.
 */
function findMissingCommits(packs, existingHashes, sdkList, maxRecent) {
    const resolved = (packs.versions || [])
        .filter(e => e.runtimeGitHash)
        .sort((a, b) => (b.buildDate || '').localeCompare(a.buildDate || ''));
    const recent = resolved.slice(0, maxRecent);
    const sdkHashes = new Set();
    if (sdkList?.versions) {
        for (const entry of sdkList.versions) {
            if (entry.runtimeGitHash) sdkHashes.add(entry.runtimeGitHash);
        }
    }
    return recent.filter(e => {
        const hash = e.runtimeGitHash;
        if (existingHashes.has(hash)) return false;
        const short = hash.substring(0, 7);
        for (const existing of existingHashes) {
            if (existing.startsWith(short) || short.startsWith(existing)) return false;
        }
        return true;
    });
}

describe('schedule-benchmarks gap detection', () => {
    const makePack = (version, buildDate, runtimeGitHash) => ({
        version,
        buildDate,
        runtimeGitHash,
        vmrCommit: 'vmr_' + runtimeGitHash,
        nupkgUrl: `https://example.com/${version}.nupkg`,
    });

    it('finds all packs when no results exist', () => {
        const packs = {
            versions: [
                makePack('11.0.0-preview.3.26153.101', '2026-03-03', 'aaa1111222233334444'),
                makePack('11.0.0-preview.3.26154.101', '2026-03-04', 'bbb1111222233334444'),
            ],
        };
        const missing = findMissingCommits(packs, new Set(), null, 30);
        assert.equal(missing.length, 2);
    });

    it('filters out packs with existing results (full hash)', () => {
        const packs = {
            versions: [
                makePack('11.0.0-preview.3.26153.101', '2026-03-03', 'aaa1111222233334444'),
                makePack('11.0.0-preview.3.26154.101', '2026-03-04', 'bbb1111222233334444'),
            ],
        };
        const existing = new Set(['aaa1111222233334444']);
        const missing = findMissingCommits(packs, existing, null, 30);
        assert.equal(missing.length, 1);
        assert.equal(missing[0].runtimeGitHash, 'bbb1111222233334444');
    });

    it('filters out packs matching by 7-char prefix', () => {
        const packs = {
            versions: [
                makePack('11.0.0-preview.3.26153.101', '2026-03-03', 'aaa1111222233334444'),
            ],
        };
        // Existing has only 7-char prefix match
        const existing = new Set(['aaa1111']);
        const missing = findMissingCommits(packs, existing, null, 30);
        assert.equal(missing.length, 0);
    });

    it('skips packs without runtimeGitHash', () => {
        const packs = {
            versions: [
                makePack('11.0.0-preview.3.26153.101', '2026-03-03', null),
                makePack('11.0.0-preview.3.26154.101', '2026-03-04', 'bbb1111222233334444'),
            ],
        };
        const missing = findMissingCommits(packs, new Set(), null, 30);
        assert.equal(missing.length, 1);
    });

    it('returns most recent first', () => {
        const packs = {
            versions: [
                makePack('11.0.0-preview.3.26153.101', '2026-03-03', 'aaa1111222233334444'),
                makePack('11.0.0-preview.3.26155.101', '2026-03-05', 'ccc1111222233334444'),
                makePack('11.0.0-preview.3.26154.101', '2026-03-04', 'bbb1111222233334444'),
            ],
        };
        const missing = findMissingCommits(packs, new Set(), null, 30);
        assert.equal(missing.length, 3);
        assert.equal(missing[0].buildDate, '2026-03-05');
        assert.equal(missing[1].buildDate, '2026-03-04');
        assert.equal(missing[2].buildDate, '2026-03-03');
    });

    it('respects maxRecent limit', () => {
        const packs = {
            versions: [
                makePack('11.0.0-preview.3.26153.101', '2026-03-03', 'aaa1111222233334444'),
                makePack('11.0.0-preview.3.26154.101', '2026-03-04', 'bbb1111222233334444'),
                makePack('11.0.0-preview.3.26155.101', '2026-03-05', 'ccc1111222233334444'),
            ],
        };
        const missing = findMissingCommits(packs, new Set(), null, 2);
        assert.equal(missing.length, 2);
        // Should be the 2 most recent
        assert.equal(missing[0].buildDate, '2026-03-05');
        assert.equal(missing[1].buildDate, '2026-03-04');
    });

    it('handles empty packs list', () => {
        const missing = findMissingCommits({ versions: [] }, new Set(), null, 30);
        assert.equal(missing.length, 0);
    });
});
