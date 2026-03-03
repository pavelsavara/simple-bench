import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    parseBuildDate,
    parseCommitHash,
    parseHostCommitHash,
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

describe('parseHostCommitHash', () => {
    it('extracts host commit hash from dotnet --info output', async () => {
        const info = await readFile(join(fixturesDir, 'dotnet-info-sample.txt'), 'utf-8');
        const hash = parseHostCommitHash(info);
        assert.equal(hash, 'a1b2c3d4e5');
    });

    it('returns null when no Host section present', () => {
        assert.equal(parseHostCommitHash('.NET SDK:\n  Commit:  abc123'), null);
    });

    it('returns different hash from SDK commit', async () => {
        const info = `.NET SDK:
 Version: 11.0.100
 Commit: aaaa1111bbbb2222cccc3333dddd4444eeee5555

Host:
  Version: 11.0.0
  Commit:  ffff6666`;
        assert.equal(parseCommitHash(info), 'aaaa1111bbbb2222cccc3333dddd4444eeee5555');
        assert.equal(parseHostCommitHash(info), 'ffff6666');
    });
});

describe('buildSdkInfo', () => {
    it('builds valid SDK info object with three hashes', () => {
        const info = buildSdkInfo(
            '11.0.100-preview.3.26062.1',
            'runtime_hash_abc',
            'sdk_hash_def',
            'vmr_hash_ghi',
            '2026-03-03',
            '14-30-00-UTC'
        );
        assert.deepEqual(info, {
            sdkVersion: '11.0.100-preview.3.26062.1',
            runtimeGitHash: 'runtime_hash_abc',
            sdkGitHash: 'sdk_hash_def',
            vmrGitHash: 'vmr_hash_ghi',
            commitDate: '2026-03-03',
            commitTime: '14-30-00-UTC'
        });
    });
});
