import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
    decodeBuildDate,
    PACKAGE_ID,
} from '../../scripts/lib/runtime-pack-resolver.mjs';

// ── decodeBuildDate ─────────────────────────────────────────────────────────

describe('decodeBuildDate', () => {
    it('decodes preview.3 version with date March 3, 2026', () => {
        assert.equal(decodeBuildDate('11.0.0-preview.3.26153.117'), '2026-03-03');
    });

    it('decodes alpha.1 version with date Dec 5, 2025', () => {
        // 25605 → YY=25, 605/50=12.1→12, 605%50=5
        assert.equal(decodeBuildDate('11.0.0-alpha.1.25605.110'), '2025-12-05');
    });

    it('decodes alpha.1 version with date Jan 10, 2026', () => {
        // 26060 → YY=26, 60/50=1.2→1, 60%50=10
        assert.equal(decodeBuildDate('11.0.0-alpha.1.26060.101'), '2026-01-10');
    });

    it('decodes date Feb 18, 2026', () => {
        // 26118 → YY=26, 118/50=2.36→2, 118%50=18
        assert.equal(decodeBuildDate('11.0.0-preview.3.26118.109'), '2026-02-18');
    });

    it('decodes date from the howto doc example', () => {
        // 25613 → YY=25, 613/50=12.26→12, 613%50=13
        assert.equal(decodeBuildDate('11.0.0-alpha.1.25613.101'), '2025-12-13');
    });

    it('returns null for malformed version', () => {
        assert.equal(decodeBuildDate('foo'), null);
    });

    it('returns null for version with too few parts', () => {
        assert.equal(decodeBuildDate('11.0.0'), null);
    });

    it('returns null for empty string', () => {
        assert.equal(decodeBuildDate(''), null);
    });
});

// ── PACKAGE_ID export ───────────────────────────────────────────────────────

describe('PACKAGE_ID constant', () => {
    it('is the browser-wasm mono runtime pack ID', () => {
        assert.equal(PACKAGE_ID, 'microsoft.netcore.app.runtime.mono.browser-wasm');
    });
});

// ── Integration-style tests (require network, skip in offline CI) ───────────
// These tests are guarded by an environment variable.
// Run with: RUNTIME_PACK_NETWORK_TESTS=1 node --test tests/unit/runtime-pack-resolver.test.mjs

const NETWORK_TESTS = process.env.RUNTIME_PACK_NETWORK_TESTS === '1';

describe('runtime-pack-resolver (network)', { skip: !NETWORK_TESTS }, () => {
    it('listAvailablePackVersions returns .NET 11 versions', async () => {
        const { listAvailablePackVersions } = await import('../../scripts/lib/runtime-pack-resolver.mjs');
        const { versions, flatBaseUrl } = await listAvailablePackVersions(11);
        assert.ok(versions.length > 0, 'Should have at least one version');
        assert.ok(versions.every(v => v.startsWith('11.')), 'All versions should be .NET 11');
        assert.ok(flatBaseUrl.includes('flat2'), 'flatBaseUrl should contain flat2');
    });

    it('getRuntimeCommitFromVMR resolves a known VMR commit', async () => {
        const { getRuntimeCommitFromVMR } = await import('../../scripts/lib/runtime-pack-resolver.mjs');
        // VMR commit 15ac4103 is known to contain runtime 9b46e582
        const runtimeCommit = await getRuntimeCommitFromVMR('15ac4103422d47f7c8f14fa98e813f315432d03b');
        assert.equal(runtimeCommit, '9b46e58206b2695ad7089ceea0db93cad22abbd7');
    });

    it('checkAncestry detects ancestor relationship', async () => {
        const { checkAncestry } = await import('../../scripts/lib/runtime-pack-resolver.mjs');
        // 17b089f9 is an ancestor of e524be69 (25 commits ahead)
        const result = await checkAncestry(
            '17b089f9dea34dff21e3417ab7ed53ef30a4f6b0',
            'e524be6928cdcd74bdbb79b389eeb31978b188ef'
        );
        assert.equal(result, 'ancestor');
    });

    it('getVmrCommitFromNuspec returns a commit hash', async () => {
        const { getVmrCommitFromNuspec, getFlatBaseUrl } = await import('../../scripts/lib/runtime-pack-resolver.mjs');
        const flatBaseUrl = await getFlatBaseUrl(11);
        // Use a known version — the latest on the feed
        const { listAvailablePackVersions } = await import('../../scripts/lib/runtime-pack-resolver.mjs');
        const { versions } = await listAvailablePackVersions(11);
        assert.ok(versions.length > 0);
        const vmrCommit = await getVmrCommitFromNuspec(flatBaseUrl, versions[versions.length - 1]);
        assert.ok(vmrCommit, 'Should return a VMR commit hash');
        assert.match(vmrCommit, /^[a-f0-9]{7,40}$/, 'Should be a valid hex hash');
    });

    it('getRepoCommitsFromVMR returns runtime and sdk commits', async () => {
        const { getRepoCommitsFromVMR } = await import('../../scripts/lib/runtime-pack-resolver.mjs');
        // Use the known VMR commit 15ac4103
        const result = await getRepoCommitsFromVMR('15ac4103422d47f7c8f14fa98e813f315432d03b');
        assert.ok(result, 'Should return a result');
        assert.ok(result.runtimeCommit, 'Should have runtimeCommit');
        assert.ok(result.sdkCommit, 'Should have sdkCommit');
        assert.equal(result.runtimeCommit, '9b46e58206b2695ad7089ceea0db93cad22abbd7');
        assert.match(result.sdkCommit, /^[a-f0-9]{7,40}$/);
    });

    it('getPackCommitInfo resolves full info for a version', async () => {
        const { getPackCommitInfo, getFlatBaseUrl, listAvailablePackVersions } =
            await import('../../scripts/lib/runtime-pack-resolver.mjs');
        const flatBaseUrl = await getFlatBaseUrl(11);
        const { versions } = await listAvailablePackVersions(11);
        const latest = versions[versions.length - 1];
        const info = await getPackCommitInfo(flatBaseUrl, latest);
        assert.equal(info.version, latest);
        assert.ok(info.buildDate, 'Should have buildDate');
        assert.ok(info.nupkgUrl.includes(latest), 'nupkgUrl should include version');
        // vmrCommit and runtimeGitHash may be null if resolution fails,
        // but for the latest version they should succeed
        assert.ok(info.vmrCommit, 'Should have vmrCommit');
        assert.ok(info.runtimeGitHash, 'Should have runtimeGitHash');
    });
});
