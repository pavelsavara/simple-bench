#!/usr/bin/env node
// enumerate-sdks.mjs — Enumerate .NET SDK versions and validate download URLs
//
// Sources:
//   - Released SDKs (.NET 6–10): releases-index.json → per-channel releases.json
//   - Daily SDKs (.NET 11):      HEAD-probe ci.dot.net/public blob storage
//
// Output: sdk-list.json in repo root

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '..', 'sdk-list.json');

const PLATFORM = 'linux-x64';
const CDN = 'https://dotnetcli.azureedge.net/dotnet';
const DAILY_CDN = 'https://ci.dot.net/public';
const BLOB = 'https://dotnetcli.blob.core.windows.net/dotnet';
const RELEASES_INDEX_URL = `${BLOB}/release-metadata/releases-index.json`;

const RELEASE_CHANNELS = ['6.0', '7.0', '8.0', '9.0', '10.0'];
const DAILY_CHANNEL = '11.0';
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date(Date.now() - THREE_MONTHS_MS);

const NUGET_FLAT = 'https://api.nuget.org/v3-flatcontainer';
const RUNTIME_PKG = 'microsoft.netcore.app.runtime.linux-x64';

// ── Helpers ─────────────────────────────────────────────────────────────────

function sdkDownloadUrl(version) {
    return `${CDN}/Sdk/${version}/dotnet-sdk-${version}-${PLATFORM}.tar.gz`;
}

function getBand(version) {
    const m = version.match(/^\d+\.\d+\.(\d)/);
    return m ? parseInt(m[1]) : -1;
}

function parseBuildDate(version) {
    const m = version.match(/\.(\d{5})\.\d+$/);
    if (!m) return null;
    const yy = parseInt(m[1].slice(0, 2));
    const ddd = parseInt(m[1].slice(2));
    if (yy < 20 || yy > 40 || ddd < 1 || ddd > 366) return null;
    return new Date(Date.UTC(2000 + yy, 0, ddd));
}

async function fetchJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return r.json();
}

async function fetchText(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    const text = (await r.text()).trim();
    // Guard against aka.ms redirecting to Bing search (returns HTML)
    if (text.startsWith('<') || text.startsWith('<!')) {
        throw new Error(`Got HTML instead of text from ${url}`);
    }
    return text;
}

function isValidVersion(v) {
    return /^\d+\.\d+\.\d+/.test(v) && v.length < 80;
}

async function validateUrl(url) {
    // Try HEAD first
    try {
        const r = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
        if (r.status >= 200 && r.status < 400) return r.status;
    } catch { /* fall through */ }
    // Fallback: GET with Range header (some CDNs block HEAD)
    try {
        const r = await fetch(url, {
            headers: { Range: 'bytes=0-0' },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
        return (r.status === 206 || r.status === 200) ? 200 : r.status;
    } catch {
        return 0;
    }
}

async function mapConcurrent(items, fn, concurrency = 10) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

// ── Runtime Git Hash Resolution ─────────────────────────────────────────────

const runtimeHashCache = new Map();   // runtimeVersion → gitHash
const vmrManifestCache = new Map();   // vmrCommit → runtimeCommit
const azDoFlatBaseCache = new Map();  // feedName → flatBaseUrl

function deriveRuntimeVersion(sdkVersion) {
    // Daily SDK 11.0.100-preview.3.26152.106 → Runtime 11.0.0-preview.3.26152.106
    return sdkVersion.replace(/^(\d+\.\d+\.)\d+/, (m, prefix) => prefix + '0');
}

async function getAzDoFlatBase(feedName) {
    if (azDoFlatBaseCache.has(feedName)) return azDoFlatBaseCache.get(feedName);
    try {
        const url = `https://pkgs.dev.azure.com/dnceng/public/_packaging/${feedName}/nuget/v3/index.json`;
        const data = await fetchJson(url);
        const entry = (data.resources || []).find(r => r['@type'] === 'PackageBaseAddress/3.0.0');
        const base = entry?.['@id'] || null;
        azDoFlatBaseCache.set(feedName, base);
        return base;
    } catch {
        azDoFlatBaseCache.set(feedName, null);
        return null;
    }
}

async function getVmrRuntimeCommit(vmrCommit) {
    if (vmrManifestCache.has(vmrCommit)) return vmrManifestCache.get(vmrCommit);
    try {
        const url = `https://raw.githubusercontent.com/dotnet/dotnet/${vmrCommit}/src/source-manifest.json`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) { vmrManifestCache.set(vmrCommit, null); return null; }
        const data = await r.json();
        const rt = (data.repositories || []).find(r => r.path === 'runtime' || r.path === 'src/runtime');
        const hash = rt?.commitSha || null;
        vmrManifestCache.set(vmrCommit, hash);
        return hash;
    } catch {
        vmrManifestCache.set(vmrCommit, null);
        return null;
    }
}

async function resolveRuntimeHash(entry) {
    const rv = entry.runtimeVersion;
    if (!rv) return null;
    if (runtimeHashCache.has(rv)) return runtimeHashCache.get(rv);

    let hash = null;
    try {
        if (entry.type === 'release') {
            // nuget.org nuspec has <repository commit="..."> pointing to dotnet/runtime
            const url = `${NUGET_FLAT}/${RUNTIME_PKG}/${rv.toLowerCase()}/${RUNTIME_PKG}.nuspec`;
            const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (r.ok) {
                const text = await r.text();
                const m = text.match(/repository[^>]*commit=.([a-f0-9]{7,40})/);
                hash = m?.[1] || null;
            }
        } else {
            // Daily: AzDO nuspec → VMR commit → source-manifest.json → runtime commit
            const major = parseInt(entry.channel);
            const feedBase = await getAzDoFlatBase(`dotnet${major}`);
            if (feedBase) {
                const url = `${feedBase}${RUNTIME_PKG}/${rv.toLowerCase()}/${RUNTIME_PKG}.nuspec`;
                const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (r.ok) {
                    const text = await r.text();
                    const m = text.match(/repository[^>]*commit=.([a-f0-9]{7,40})/);
                    const vmrCommit = m?.[1];
                    if (vmrCommit) hash = await getVmrRuntimeCommit(vmrCommit);
                }
            }
        }
    } catch { /* leave hash as null */ }

    runtimeHashCache.set(rv, hash);
    return hash;
}

// ── Released SDKs (.NET 6–10) ───────────────────────────────────────────────

async function getReleasedSdks() {
    console.log('Fetching releases index...');
    const index = await fetchJson(RELEASES_INDEX_URL);
    const entries = [];

    for (const ch of RELEASE_CHANNELS) {
        const info = (index['releases-index'] || []).find(c => c['channel-version'] === ch);
        if (!info) {
            console.log(`  ${ch}: not found in releases-index, skipping`);
            continue;
        }

        const releasesUrl = info['releases.json'];
        console.log(`  ${ch}: fetching releases from ${releasesUrl}`);

        let data;
        try {
            data = await fetchJson(releasesUrl);
        } catch (e) {
            console.log(`    ERROR: ${e.message}`);
            continue;
        }

        // Collect all SDK versions across all releases, group by band, keep latest
        const byBand = new Map(); // band -> { version, releaseDate, runtimeVersion }
        for (const rel of data.releases || []) {
            const sdks = rel.sdks || (rel.sdk ? [rel.sdk] : []);
            const rv = rel.runtime?.version || '';
            for (const sdk of sdks) {
                const v = sdk.version;
                if (!v) continue;
                const band = getBand(v);
                if (band < 0) continue;
                const existing = byBand.get(band);
                if (!existing || v.localeCompare(existing.sdkVersion) > 0) {
                    byBand.set(band, { sdkVersion: v, releaseDate: rel['release-date'] || '', runtimeVersion: rv });
                }
            }
        }

        for (const [band, { sdkVersion, releaseDate, runtimeVersion }] of [...byBand.entries()].sort((a, b) => a[0] - b[0])) {
            entries.push({
                sdkVersion,
                channel: ch,
                band: `${band}xx`,
                type: 'release',
                releaseDate,
                runtimeVersion,
                url: sdkDownloadUrl(sdkVersion)
            });
            console.log(`    band ${band}xx: ${sdkVersion} (${releaseDate})`);
        }
    }

    return entries;
}

// ── Daily SDKs (.NET 11) ────────────────────────────────────────────────────

function dailySdkUrl(version) {
    return `${DAILY_CDN}/Sdk/${version}/dotnet-sdk-${version}-${PLATFORM}.tar.gz`;
}

function encodeDateCode(year, month, day) {
    return (year - 2000) * 1000 + month * 50 + day;
}

function decodeDateCode(code) {
    const yy = Math.floor(code / 1000);
    const rem = code % 1000;
    const mm = Math.floor(rem / 50);
    const dd = rem % 50;
    return new Date(2000 + yy, mm - 1, dd);
}

async function checkDailyExists(version) {
    const url = dailySdkUrl(version);
    try {
        const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'follow' });
        return r.status === 200;
    } catch { return false; }
}

async function getDailyBuilds() {
    console.log(`\nDiscovering .NET ${DAILY_CHANNEL} daily builds (last 3 months)...`);
    console.log(`  CDN: ${DAILY_CDN}`);

    // Generate date codes for the last 3 months
    const dateCodes = [];
    const d = new Date(CUTOFF);
    const now = new Date();
    while (d <= now) {
        dateCodes.push(encodeDateCode(d.getFullYear(), d.getMonth() + 1, d.getDate()));
        d.setDate(d.getDate() + 1);
    }

    // Prerelease labels to probe
    const labels = ['alpha.1', 'preview.1', 'preview.2', 'preview.3', 'preview.4'];

    // Probe all date+label+revision combos via HEAD requests
    const probes = [];
    for (const label of labels) {
        for (const code of dateCodes) {
            for (let rev = 101; rev <= 125; rev++) {
                probes.push(`11.0.100-${label}.${code}.${rev}`);
            }
        }
    }

    console.log(`  Probing ${probes.length} candidates (${dateCodes.length} dates x ${labels.length} labels x 25 revisions)...`);

    let checked = 0;
    const found = [];
    await mapConcurrent(probes, async (version) => {
        const exists = await checkDailyExists(version);
        checked++;
        if (exists) found.push(version);
        if (checked % 1000 === 0) {
            process.stdout.write(`  ${checked}/${probes.length} checked, ${found.length} found\r`);
        }
    }, 30);
    console.log(`  ${checked}/${probes.length} checked, ${found.length} found`);

    // Build entries
    const unique = [...new Set(found)];
    const entries = unique.map(v => {
        const m = v.match(/\.(\d{5})\./);
        const buildDate = m ? decodeDateCode(parseInt(m[1])) : null;
        return {
            sdkVersion: v,
            channel: DAILY_CHANNEL,
            band: `${getBand(v)}xx`,
            type: 'daily',
            buildDate: buildDate ? buildDate.toISOString().slice(0, 10) : null,
            runtimeVersion: deriveRuntimeVersion(v),
            url: dailySdkUrl(v)
        };
    });

    entries.sort((a, b) => a.sdkVersion.localeCompare(b.sdkVersion));
    console.log(`  ${entries.length} daily builds discovered`);
    return entries;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const released = await getReleasedSdks();
    const daily = await getDailyBuilds();
    const all = [...released, ...daily];

    // Resolve runtime git hashes
    console.log(`\nResolving runtime git hashes for ${all.length} entries...`);
    let hashResolved = 0;
    await mapConcurrent(all, async (entry) => {
        entry.runtimeGitHash = await resolveRuntimeHash(entry);
        if (entry.runtimeGitHash) hashResolved++;
    }, 10);
    console.log(`  ${hashResolved}/${all.length} hashes resolved`);

    console.log(`\nValidating ${all.length} download URLs (concurrency=10)...`);
    let valid = 0, invalid = 0;

    const validated = await mapConcurrent(all, async (entry) => {
        const status = await validateUrl(entry.url);
        const ok = status >= 200 && status < 400;
        if (ok) { valid++; process.stdout.write('.'); }
        else { invalid++; process.stdout.write('X'); }
        return { ...entry, httpStatus: status, valid: ok };
    }, 10);

    console.log(`\n\nResults: ${valid} valid, ${invalid} invalid out of ${all.length} total`);

    // Log invalid entries
    for (const e of validated) {
        if (!e.valid) console.log(`  INVALID: ${e.sdkVersion} → HTTP ${e.httpStatus}`);
    }

    const output = {
        generated: new Date().toISOString(),
        platform: PLATFORM,
        totalVersions: validated.length,
        validVersions: valid,
        versions: validated
    };

    writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log(`\nWritten ${OUTPUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
