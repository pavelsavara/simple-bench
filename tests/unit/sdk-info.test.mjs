import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    parseBuildDate,
    parseCommitHash,
    parseSdkVersion,
    buildSdkInfo
} from '../../scripts/lib/sdk-info.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

describe('parseBuildDate', () => {
    it('parses YYDDD from preview version string', () => {
        assert.equal(parseBuildDate('11.0.100-preview.3.26062.1'), '2026-03-03');
    });

    it('parses YYDDD from another preview version', () => {
        assert.equal(parseBuildDate('10.0.100-preview.3.25130.1'), '2025-05-10');
    });

    it('parses day 1 (Jan 1)', () => {
        assert.equal(parseBuildDate('11.0.100-preview.1.26001.1'), '2026-01-01');
    });

    it('parses day 365 (Dec 31 non-leap)', () => {
        assert.equal(parseBuildDate('25.0.100-preview.1.25365.1'), '2025-12-31');
    });

    it('parses day 366 (Dec 31 leap year)', () => {
        assert.equal(parseBuildDate('24.0.100-preview.1.24366.1'), '2024-12-31');
    });

    it('returns null for RTM version without build number', () => {
        assert.equal(parseBuildDate('10.0.100'), null);
    });

    it('returns null for malformed version', () => {
        assert.equal(parseBuildDate('foo'), null);
    });

    it('returns null for empty string', () => {
        assert.equal(parseBuildDate(''), null);
    });

    it('returns null for day 0', () => {
        assert.equal(parseBuildDate('11.0.100-preview.1.26000.1'), null);
    });

    it('returns null for day 367', () => {
        assert.equal(parseBuildDate('11.0.100-preview.1.26367.1'), null);
    });
});

describe('parseCommitHash', () => {
    it('extracts commit hash from dotnet --info output', async () => {
        const info = await readFile(join(fixturesDir, 'dotnet-info-sample.txt'), 'utf-8');
        const hash = parseCommitHash(info);
        assert.equal(hash, 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    });

    it('returns null when no commit line present', () => {
        assert.equal(parseCommitHash('Version: 10.0.100'), null);
    });

    it('handles varying whitespace', () => {
        assert.equal(
            parseCommitHash('  Commit:   abc123def456'),
            'abc123def456'
        );
    });
});

describe('parseSdkVersion', () => {
    it('trims whitespace from version output', () => {
        assert.equal(parseSdkVersion('  11.0.100-preview.3.26062.1\n'), '11.0.100-preview.3.26062.1');
    });

    it('handles clean version string', () => {
        assert.equal(parseSdkVersion('10.0.100'), '10.0.100');
    });
});

describe('buildSdkInfo', () => {
    it('builds valid SDK info object', () => {
        const info = buildSdkInfo(
            '11.0.100-preview.3.26062.1',
            'a1b2c3d4e5f6',
            '2026-03-03',
            '14-30-00-UTC'
        );
        assert.deepEqual(info, {
            sdkVersion: '11.0.100-preview.3.26062.1',
            gitHash: 'a1b2c3d4e5f6',
            commitDate: '2026-03-03',
            commitTime: '14-30-00-UTC'
        });
    });
});
