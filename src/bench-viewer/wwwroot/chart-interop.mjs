// Chart.js interop module for Blazor dashboard
// Called from C# via [JSImport] to fetch data and render charts

// ── State ────────────────────────────────────────────────────────────────────

let dataBaseUrl = '';
const cache = {};          // { url: json }
const charts = {};         // { canvasId: Chart instance }
let viewIndex = null;
let loadGeneration = 0;    // guards against concurrent loadAppCharts calls
let currentTimeRange = 'all';   // '7d', '30d', '90d', '1y', 'all'
let pointClickCallback = null;  // C# callback for chart point clicks
let showReleases = true;         // Whether to show GA release data on charts
let showDailyReleases = true;    // Whether to show daily week data on charts

// ── Series Encoding ──────────────────────────────────────────────────────────

const ENGINE_COLORS = {
    chrome: '#F4B400',
    firefox: '#EA4335',
    v8: '#4285F4',
    node: '#34A853',
};

const PRESET_DASH = {
    devloop: [5, 5],
    'no-workload': [],
    aot: [10, 5],
    'native-relink': [3, 3],
    'no-jiterp': [10, 3, 3, 3],
    invariant: [10, 3, 3, 3],
    'no-reflection-emit': [15, 5],
};

const RUNTIME_MARKER = {
    mono: 'triangle',
    coreclr: 'circle',
};

const PROFILE_LINE_WIDTH = {
    desktop: 1,
    mobile: 2,
};

const METRIC_UNITS = {
    'compile-time': 's',
    'disk-size-native': 'bytes',
    'disk-size-assemblies': 'bytes',
    'download-size-total': 'bytes',
    'time-to-reach-managed-warm': 'ms',
    'time-to-reach-managed-cold': 'ms',
    'time-to-create-dotnet-warm': 'ms',
    'time-to-create-dotnet-cold': 'ms',
    'time-to-exit-warm': 'ms',
    'time-to-exit-cold': 'ms',
    'wasm-memory-size': 'bytes',
    'memory-peak': 'bytes',
    'pizza-walkthrough': 'ms',
    'havit-walkthrough': 'ms',
    'mud-walkthrough': 'ms',
    'js-interop-ops': 'ops/sec',
    'json-parse-ops': 'ops/sec',
    'exception-ops': 'ops/sec',
};

const METRIC_DISPLAY = {
    'compile-time': 'Compile Time (s)',
    'disk-size-native': 'Naive runtime binary size - brotli (bytes)',
    'disk-size-assemblies': 'Assemblies size - brotli (bytes)',
    'download-size-total': 'Download Size (Total)',
    'time-to-reach-managed-warm': 'Time to Managed (Warm)',
    'time-to-reach-managed-cold': 'Time to Managed (Cold)',
    'time-to-create-dotnet-warm': 'Time to Create Dotnet (Warm)',
    'time-to-create-dotnet-cold': 'Time to Create Dotnet (Cold)',
    'time-to-exit-warm': 'Time to Exit (Warm)',
    'time-to-exit-cold': 'Time to Exit (Cold)',
    'wasm-memory-size': 'WASM Linear Memory Size',
    'memory-peak': 'Peak JS Heap',
    'pizza-walkthrough': 'Blazing Pizza Walkthrough',
    'havit-walkthrough': 'Havit Bootstrap Walkthrough',
    'mud-walkthrough': 'MudBlazor Walkthrough',
    'js-interop-ops': 'JS Interop',
    'json-parse-ops': 'JSON Parse',
    'exception-ops': 'Exception Handling',
};

// Build-time metrics are identical across engines/profiles — only show chrome/desktop
const BUILD_METRICS = new Set([
    'compile-time', 'disk-size-native', 'disk-size-assemblies', 'download-size-total',
]);

// Walkthrough metrics are only collected for chrome/desktop — same filtering as build metrics
const WALKTHROUGH_METRICS = new Set([
    'pizza-walkthrough', 'havit-walkthrough', 'mud-walkthrough',
]);

// Metrics to skip for micro-benchmarks (not meaningful for internal throughput tests)
const MICROBENCH_SKIP_METRICS = new Set([
    'compile-time', 'disk-size-native', 'disk-size-assemblies', 'download-size-total',
]);

// Release tick spacing: feature band (hundreds digit × 100) × 12h + service release (last 2 digits) × 48h
// e.g. 8.0.100 → band=100, svc=0; 8.0.302 → band=300, svc=2; 8.0.406 → band=400, svc=6
const RELEASE_BAND_INTERVAL_MS = 12 * 3600000;     // 12 hours per band unit (band 100 = 50 days)
const RELEASE_SERVICE_INTERVAL_MS = 48 * 3600000;   // 48 hours per service release

function parseSdkPatch(sdkVersion) {
    const parts = sdkVersion.split('.');
    if (parts.length < 3) return 0;
    return parseInt(parts[2].split('-')[0], 10) || 0;
}

function releasePatchOffsetMs(patch) {
    const band = Math.floor(patch / 100) * 100;  // 100, 200, 300, 400
    const service = patch % 100;                   // 0, 1, 2, ...
    return band * RELEASE_BAND_INTERVAL_MS + service * RELEASE_SERVICE_INTERVAL_MS;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
    if (cache[url]) return cache[url];
    const resp = await fetch(url, {
        cache: 'no-cache',
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    cache[url] = data;
    return data;
}

function formatValue(value, unit) {
    if (value == null) return '—';
    if (unit === 'bytes') {
        if (value >= 1048576) return (value / 1048576).toFixed(2) + ' MB';
        if (value >= 1024) return (value / 1024).toFixed(2) + ' KB';
        return value + ' B';
    }
    if (unit === 's') {
        return Math.round(value / 1000) + ' s';
    }
    if (unit === 'ms') {
        return value >= 1000
            ? Math.round(value).toLocaleString() + ' ms'
            : value.toFixed(1) + ' ms';
    }
    if (unit === 'ops/sec') {
        return Math.round(value).toLocaleString() + ' ops/sec';
    }
    return String(value);
}

function parseRowKey(key) {
    const [runtime, preset, profile, engine] = key.split('/');
    return { runtime, preset, profile, engine };
}

function isRowVisible(rowKey, filters, metric) {
    const d = parseRowKey(rowKey);
    // Build-time and walkthrough metrics: only show chrome/desktop (values are identical or only collected there)
    if (BUILD_METRICS.has(metric) || WALKTHROUGH_METRICS.has(metric)) {
        if (d.engine !== 'chrome' || d.profile !== 'desktop') return false;
        // Skip engine/profile filters — always display if runtime and preset match
        return filters.runtimes.includes(d.runtime)
            && filters.presets.includes(d.preset);
    }
    return filters.runtimes.includes(d.runtime)
        && filters.presets.includes(d.preset)
        && filters.profiles.includes(d.profile)
        && filters.engines.includes(d.engine);
}

function formatRowLabel(rowKey, metric) {
    if (BUILD_METRICS.has(metric) || WALKTHROUGH_METRICS.has(metric)) {
        // Strip redundant /desktop/chrome for build-time, disk-size, and walkthrough metrics
        const d = parseRowKey(rowKey);
        return `${d.runtime}/${d.preset}`;
    }
    return rowKey;
}

function makeDatasetStyle(rowKey) {
    const d = parseRowKey(rowKey);
    return {
        borderColor: ENGINE_COLORS[d.engine] || '#999',
        backgroundColor: (ENGINE_COLORS[d.engine] || '#999') + '33',
        borderDash: PRESET_DASH[d.preset] || [],
        borderWidth: PROFILE_LINE_WIDTH[d.profile] || 1,
        pointStyle: RUNTIME_MARKER[d.runtime] || 'circle',
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0,
        fill: false,
    };
}

function getTimeRangeCutoff() {
    if (currentTimeRange === 'all') return null;
    const now = new Date();
    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[currentTimeRange];
    if (!days) return null;
    return new Date(now.getTime() - days * 86400000);
}

// ── Chart.js Plugin: Frozen release zone separator ───────────────────────────

const frozenZonePlugin = {
    id: 'frozenZone',
    beforeDraw(chart) {
        const meta = chart.options.plugins.frozenZone;
        if (!meta || !meta.dividerDates || !meta.dividerDates.length) return;
        const xScale = chart.scales.x;
        if (!xScale) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        for (const d of meta.dividerDates) {
            const x = xScale.getPixelForValue(new Date(d));
            if (x == null || isNaN(x)) continue;
            if (x < chartArea.left || x > chartArea.right) continue;
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
        }
        ctx.restore();
    }
};

Chart.register(frozenZonePlugin);

// ── Exported Functions ───────────────────────────────────────────────────────

/**
 * Initialize the dashboard. Fetches and returns the view index JSON.
 * @param {string} baseUrl - Base URL for data, e.g. "/blazor_coreclr_demo/data/views"
 * @returns {Promise<string>} - Serialized ViewIndex JSON
 */
export async function initDashboard(baseUrl) {
    dataBaseUrl = baseUrl.replace(/\/$/, '');
    const url = `${dataBaseUrl}/index.json`;
    viewIndex = await fetchJson(url);

    // Fetch all bucket headers and filter apps to only those with actual data
    const appsWithData = new Set();
    for (const rel of viewIndex.releases) {
        const header = await fetchJson(`${dataBaseUrl}/releases/${rel}/header.json`);
        if (header?.apps) Object.keys(header.apps).forEach(a => appsWithData.add(a));
    }
    for (const week of viewIndex.weeks) {
        const header = await fetchJson(`${dataBaseUrl}/${week}/header.json`);
        if (header?.apps) Object.keys(header.apps).forEach(a => appsWithData.add(a));
    }
    viewIndex.apps = viewIndex.apps.filter(a => appsWithData.has(a));

    return JSON.stringify(viewIndex);
}

/**
 * Load and render charts for a given app.
 * @param {string} app - App name (e.g. "empty-browser")
 * @param {string} filtersJson - JSON of filter state {runtimes:[], presets:[], profiles:[], engines:[]}
 * @returns {Promise<string>} - JSON array of metric keys that were rendered
 */
export async function loadAppCharts(app, filtersJson) {
    if (!viewIndex) return '[]';

    const filters = JSON.parse(filtersJson);
    const metrics = viewIndex.metrics[app] || [];

    // Destroy existing charts and mark this generation
    destroyAllCharts();
    const gen = ++loadGeneration;

    // Collect bucket data: releases + weeks
    const releaseBuckets = [];
    for (const rel of viewIndex.releases) {
        const path = `releases/${rel}`;
        const header = await fetchJson(`${dataBaseUrl}/${path}/header.json`);
        if (header) releaseBuckets.push({ path, header, type: 'release', label: rel });
    }
    // Sort release buckets by major version number (ascending: net8, net9, net10)
    releaseBuckets.sort((a, b) => {
        const numA = parseInt(a.label.replace('net', ''), 10) || 0;
        const numB = parseInt(b.label.replace('net', ''), 10) || 0;
        return numA - numB;
    });

    const weekBuckets = [];
    const cutoff = getTimeRangeCutoff();
    if (showDailyReleases) {
        for (const week of viewIndex.weeks) {
            // Filter week buckets by time range
            if (cutoff) {
                const weekDate = new Date(week);
                // Skip entire week bucket if its Monday is before the cutoff
                // (allow 7 days grace since the week spans Mon-Sun)
                if (weekDate < new Date(cutoff.getTime() - 7 * 86400000)) continue;
            }
            const header = await fetchJson(`${dataBaseUrl}/${week}/header.json`);
            if (header) weekBuckets.push({ path: week, header, type: 'week', label: week });
        }
    }

    // ── Pre-compute release anchor dates (once for all metrics) ──
    // Ensures: net8 < net9 < net10 < daily builds on the x-axis
    const RELEASE_BUCKET_GAP_MS = 30 * 86400000;   // 30-day gap between major release groups
    const DAILY_PAD_MS = 60 * 86400000;             // 60-day padding before daily builds
    const releaseAnchorMap = new Map();              // bucket.label → anchorMs

    {
        // Find earliest daily build date from week bucket headers
        let earliestDailyMs = null;
        for (const wb of weekBuckets) {
            for (const col of (wb.header.columns || [])) {
                if (col.runtimeCommitDateTime) {
                    const ms = new Date(col.runtimeCommitDateTime).getTime();
                    if (!earliestDailyMs || ms < earliestDailyMs) earliestDailyMs = ms;
                }
            }
        }

        // Compute natural anchor and span for each release bucket
        const bucketLayout = releaseBuckets.map(bucket => {
            const cols = bucket.header.columns || [];
            const firstCol = cols[0];
            const naturalAnchorMs = firstCol?.runtimeCommitDateTime
                ? new Date(firstCol.runtimeCommitDateTime).getTime() : null;
            const firstPatch = firstCol ? parseSdkPatch(firstCol.sdkVersion) : 0;
            const firstOffset = releasePatchOffsetMs(firstPatch);
            let maxOffset = firstOffset;
            for (const col of cols) {
                const offset = releasePatchOffsetMs(parseSdkPatch(col.sdkVersion));
                if (offset > maxOffset) maxOffset = offset;
            }
            return { label: bucket.label, naturalAnchorMs, firstOffset, span: maxOffset - firstOffset };
        });

        // Forward pass: ensure monotonic ordering with gaps
        let cursor = null;
        const anchors = bucketLayout.map(info => {
            let anchor = info.naturalAnchorMs;
            if (anchor == null) return null;
            if (cursor !== null && anchor < cursor + RELEASE_BUCKET_GAP_MS) {
                anchor = cursor + RELEASE_BUCKET_GAP_MS;
            }
            cursor = anchor + info.span;
            return anchor;
        });

        // Backward shift: if last release tick would overlap daily builds, shift everything back
        if (earliestDailyMs && cursor != null && cursor >= earliestDailyMs - DAILY_PAD_MS) {
            const overshoot = cursor - (earliestDailyMs - DAILY_PAD_MS);
            for (let i = 0; i < anchors.length; i++) {
                if (anchors[i] != null) anchors[i] -= overshoot;
            }
        }

        for (let i = 0; i < bucketLayout.length; i++) {
            if (anchors[i] != null) {
                releaseAnchorMap.set(bucketLayout[i].label, anchors[i]);
            }
        }
    }

    const rendered = [];

    for (const metric of metrics) {
        // Abort if a newer loadAppCharts call has started
        if (gen !== loadGeneration) return JSON.stringify(rendered);

        // Skip build/disk metrics for micro-benchmarks
        if (app === 'micro-benchmarks' && MICROBENCH_SKIP_METRICS.has(metric)) continue;

        const canvasId = `chart-${app}-${metric}`;
        const canvas = document.getElementById(canvasId);
        if (!canvas) continue;

        const datasets = [];
        const allRowKeys = new Set();

        // ── Release data (frozen zone) ──
        // Anchors are precomputed above to guarantee net8 < net9 < net10 < daily builds.
        const frozenPointsByRow = {};  // rowKey → points[]

        if (showReleases) {
            for (const bucket of releaseBuckets) {
                const bucketMetrics = bucket.header.apps?.[app];
                if (!bucketMetrics || !bucketMetrics.includes(metric)) continue;

                const dataUrl = `${dataBaseUrl}/${bucket.path}/${app}_${metric}.json`;
                const metricData = await fetchJson(dataUrl);
                if (!metricData) continue;

                const cols = bucket.header.columns || [];
                const firstCol = cols[0];
                const anchorMs = releaseAnchorMap.get(bucket.label);
                const anchorDate = anchorMs != null ? new Date(anchorMs) : null;
                const firstPatch = firstCol ? parseSdkPatch(firstCol.sdkVersion) : 0;
                const firstOffset = releasePatchOffsetMs(firstPatch);

                const tickDates = cols.map((col) => {
                    if (!anchorDate) return null;
                    const patch = parseSdkPatch(col.sdkVersion);
                    return new Date(anchorDate.getTime() + releasePatchOffsetMs(patch) - firstOffset).toISOString();
                });

                for (const [rowKey, values] of Object.entries(metricData)) {
                    allRowKeys.add(rowKey);

                    const points = values.map((v, i) => {
                        const col = cols[i];
                        const tickDate = tickDates[i];
                        if (!tickDate) return null;
                        return {
                            x: tickDate,
                            y: v,
                            _colIndex: i,
                            _bucket: bucket.path,
                            _bucketType: 'release',
                            _sdkVersion: col?.sdkVersion || bucket.label,
                            _releaseLabel: bucket.label,
                        };
                    }).filter(p => p != null && p.y != null);

                    if (points.length === 0) continue;

                    if (!frozenPointsByRow[rowKey]) frozenPointsByRow[rowKey] = [];
                    frozenPointsByRow[rowKey].push(...points);
                }
            }
        }

        // ── Week data (active zone) ──
        for (const bucket of weekBuckets) {
            // Skip if this bucket's header doesn't list this app+metric
            const bucketMetrics = bucket.header.apps?.[app];
            if (!bucketMetrics || !bucketMetrics.includes(metric)) continue;

            const dataUrl = `${dataBaseUrl}/${bucket.path}/${app}_${metric}.json`;
            const metricData = await fetchJson(dataUrl);
            if (!metricData) continue;

            for (const [rowKey, values] of Object.entries(metricData)) {
                allRowKeys.add(rowKey);

                const points = values.map((v, i) => {
                    const col = bucket.header.columns[i];
                    if (!col) return null;
                    // Filter by time range cutoff
                    if (cutoff && col.runtimeCommitDateTime) {
                        const ptDate = new Date(col.runtimeCommitDateTime);
                        if (ptDate < cutoff) return null;
                    }
                    return {
                        x: col.runtimeCommitDateTime,
                        y: v,
                        _colIndex: i,
                        _bucket: bucket.path,
                        _bucketType: 'week',
                        _sdkVersion: col.sdkVersion,
                    };
                }).filter(p => p != null && p.x != null && p.y != null);

                if (points.length === 0) continue;

                // Merge with existing dataset for same rowKey if present
                const existingIdx = datasets.findIndex(
                    d => d._rowKey === rowKey && d._zone === 'active'
                );
                if (existingIdx >= 0) {
                    datasets[existingIdx].data.push(...points);
                } else {
                    datasets.push({
                        label: formatRowLabel(rowKey, metric),
                        data: points,
                        ...makeDatasetStyle(rowKey),
                        _rowKey: rowKey,
                        _zone: 'active',
                    });
                }
            }
        }

        // ── Merge frozen (release) points into active datasets ──
        // For each rowKey with frozen data, prepend to matching active dataset
        // or create standalone dataset.
        const mergedDatasets = [];
        const consumedFrozenRows = new Set();

        for (const ds of datasets) {
            if (ds._zone !== 'active') continue;
            ds.data.sort((a, b) => new Date(a.x) - new Date(b.x));

            const frozenPts = frozenPointsByRow[ds._rowKey];
            if (frozenPts && frozenPts.length > 0) {
                frozenPts.sort((a, b) => new Date(a.x) - new Date(b.x));
                ds.data = [...frozenPts, ...ds.data];
                consumedFrozenRows.add(ds._rowKey);
            }
            mergedDatasets.push(ds);
        }

        // Add standalone datasets for frozen-only rows (no active data)
        for (const [rowKey, points] of Object.entries(frozenPointsByRow)) {
            if (consumedFrozenRows.has(rowKey)) continue;
            if (points.length === 0) continue;
            points.sort((a, b) => new Date(a.x) - new Date(b.x));
            mergedDatasets.push({
                label: formatRowLabel(rowKey, metric),
                data: points,
                ...makeDatasetStyle(rowKey),
                _rowKey: rowKey,
                _zone: 'frozen',
            });
        }

        if (mergedDatasets.length === 0) continue;

        const unit = METRIC_UNITS[metric] || '';
        const displayName = METRIC_DISPLAY[metric] || metric;

        // Compute divider dates between each major release bucket and between releases and daily
        // Group date ranges by _releaseLabel for release points
        const releaseLabelRanges = new Map(); // label → { min, max }
        let firstActiveDate = null;
        for (const ds of mergedDatasets) {
            for (const pt of ds.data) {
                if (pt.y == null) continue;
                if (pt._bucketType === 'release' && pt._releaseLabel) {
                    const d = new Date(pt.x).getTime();
                    const range = releaseLabelRanges.get(pt._releaseLabel);
                    if (!range) {
                        releaseLabelRanges.set(pt._releaseLabel, { min: d, max: d });
                    } else {
                        if (d < range.min) range.min = d;
                        if (d > range.max) range.max = d;
                    }
                } else if (pt._bucketType === 'week') {
                    const d = new Date(pt.x).getTime();
                    if (!firstActiveDate || d < firstActiveDate) firstActiveDate = d;
                }
            }
        }
        const dividerDates = [];
        const sortedLabels = [...releaseLabelRanges.entries()]
            .sort((a, b) => a[1].min - b[1].min);
        // Dividers between adjacent major release buckets
        for (let i = 0; i < sortedLabels.length - 1; i++) {
            const prevMax = sortedLabels[i][1].max;
            const nextMin = sortedLabels[i + 1][1].min;
            dividerDates.push(new Date((prevMax + nextMin) / 2).toISOString());
        }
        // Divider between last release and first daily
        if (sortedLabels.length > 0 && firstActiveDate) {
            const lastMax = sortedLabels[sortedLabels.length - 1][1].max;
            dividerDates.push(new Date((lastMax + firstActiveDate) / 2).toISOString());
        }

        const chartDatasets = mergedDatasets;

        // Build exact tick → sdkVersion map; warn and throw on duplicate ticks
        const tickToSdk = new Map();
        for (const ds of chartDatasets) {
            for (const pt of ds.data) {
                if (!pt._sdkVersion || !pt.x) continue;
                const ts = new Date(pt.x).getTime();
                const existing = tickToSdk.get(ts);
                if (existing && existing !== pt._sdkVersion) {
                    const msg = `Duplicate tick at ${pt.x}: existing '${existing}', new '${pt._sdkVersion}'`;
                    console.warn(msg);
                    throw new Error(msg);
                }
                tickToSdk.set(ts, pt._sdkVersion);
            }
        }

        const config = {
            type: 'line',
            data: { datasets: chartDatasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'nearest',
                    intersect: false,
                },
                plugins: {
                    title: {
                        display: true,
                        text: displayName,
                        font: { size: 14, weight: 'bold' },
                        align: 'start',
                    },
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            boxWidth: 8,
                            font: { size: 10 },
                        },
                    },
                    tooltip: {
                        callbacks: {
                            title(items) {
                                if (!items.length) return '';
                                const pt = items[0].raw;
                                if (pt._bucketType === 'release') {
                                    return `Release: ${pt._sdkVersion || pt._releaseLabel}`;
                                }
                                return `Date: ${new Date(pt.x).toLocaleDateString()}`;
                            },
                            afterTitle(items) {
                                if (!items.length) return '';
                                const pt = items[0].raw;
                                const header = cache[`${dataBaseUrl}/${pt._bucket}/header.json`];
                                if (!header) return '';
                                const col = header.columns[pt._colIndex];
                                if (!col) return '';
                                const lines = [];
                                lines.push(`SDK: ${col.sdkVersion}`);
                                lines.push(`Runtime: ${col.runtimeGitHash.substring(0, 7)}`);
                                return lines.join('\n');
                            },
                            label(ctx) {
                                return `${ctx.dataset.label}: ${formatValue(ctx.raw.y, unit)}`;
                            },
                        },
                    },
                    zoom: {
                        pan: { enabled: true, mode: 'x' },
                        zoom: {
                            wheel: { enabled: true, modifierKey: 'ctrl' },
                            pinch: { enabled: true },
                            mode: 'x',
                        },
                    },
                    frozenZone: dividerDates.length > 0 ? { dividerDates } : {},
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            tooltipFormat: 'MMM d, yyyy',
                        },
                        grid: { display: false },
                        title: { display: true, text: 'SDK Version' },
                        ticks: {
                            source: 'data',
                            callback(value) {
                                const ts = typeof value === 'number' ? value : new Date(value).getTime();
                                const ver = tickToSdk.get(ts);
                                if (!ver) return '';
                                // Shorten: e.g. "11.0.100-preview.3.26153.117" → "preview.3.26153"
                                const m = ver.match(/-(\w+\.\d+\.\d+)/);
                                return m ? m[1] : ver;
                            },
                            maxRotation: 90,
                            minRotation: 90,
                            autoSkip: true,
                        },
                    },
                    y: {
                        title: { display: true, text: unit },
                        ticks: {
                            callback(value) {
                                return formatValue(value, unit);
                            },
                        },
                    },
                },
                parsing: {
                    xAxisKey: 'x',
                    yAxisKey: 'y',
                },
                onClick(event, elements) {
                    if (!elements.length) return;
                    const el = elements[0];
                    const ds = config.data.datasets[el.datasetIndex];
                    const pt = ds.data[el.index];
                    const detail = {
                        rowKey: ds._rowKey || ds.label,
                        colIndex: pt._colIndex,
                        bucket: pt._bucket,
                        bucketType: pt._bucketType,
                        value: pt.y,
                        metric: metric,
                    };
                    const detailJson = JSON.stringify(detail);
                    // Call C# callback if registered, otherwise dispatch DOM event
                    if (pointClickCallback) {
                        try { pointClickCallback(detailJson); } catch (e) { console.warn('Point click callback error:', e); }
                    }
                    document.dispatchEvent(new CustomEvent('chartPointClick', {
                        detail: detailJson,
                    }));
                },
            },
        };

        // Destroy any existing chart on this canvas (safety net)
        const existing = Chart.getChart(canvas);
        if (existing) existing.destroy();

        const ctx = canvas.getContext('2d');
        const chart = new Chart(ctx, config);
        chart._metric = metric;
        charts[canvasId] = chart;

        // Apply initial filter visibility
        for (let i = 0; i < chart.data.datasets.length; i++) {
            const ds = chart.data.datasets[i];
            if (ds._rowKey) {
                chart.setDatasetVisibility(i, isRowVisible(ds._rowKey, filters, metric));
            }
        }
        chart.update('none');

        // Shift+wheel zoom (complement to Ctrl+wheel handled by plugin)
        canvas.addEventListener('wheel', (e) => {
            if (e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                const speed = 0.1;
                const amount = 1 + (e.deltaY >= 0 ? -speed : speed);
                chart.zoom(amount);
            }
        }, { passive: false });
        rendered.push(metric);
    }

    return JSON.stringify(rendered);
}

/**
 * Apply filter changes by showing/hiding datasets.
 * @param {string} filtersJson - JSON of filter state
 */
export function applyFilters(filtersJson) {
    const filters = JSON.parse(filtersJson);
    for (const [canvasId, chart] of Object.entries(charts)) {
        // Extract metric from chart._metric stored during creation
        const metric = chart._metric || '';
        for (let i = 0; i < chart.data.datasets.length; i++) {
            const ds = chart.data.datasets[i];
            const key = ds._rowKey;
            if (key) {
                const visible = isRowVisible(key, filters, metric);
                chart.setDatasetVisibility(i, visible);
            }
        }
        chart.update('none');
    }
}

/**
 * Get column metadata for a specific bucket and column index.
 * @param {string} bucket - Bucket path
 * @param {number} colIndex - Column index
 * @returns {string} - JSON of column metadata
 */
export function getColumnMetadata(bucket, colIndex) {
    const header = cache[`${dataBaseUrl}/${bucket}/header.json`];
    if (!header || !header.columns[colIndex]) return '{}';
    return JSON.stringify(header.columns[colIndex]);
}

/**
 * Get all metric values for a given row key at a column index in a bucket.
 * @param {string} app - App name
 * @param {string} bucket - Bucket path
 * @param {string} rowKey - Row key
 * @param {number} colIndex - Column index
 * @returns {Promise<string>} - JSON of { metric: value } pairs
 */
export async function getPointMetrics(app, bucket, rowKey, colIndex) {
    const header = cache[`${dataBaseUrl}/${bucket}/header.json`];
    if (!header) return '{}';

    const appMetrics = header.apps[app] || [];
    const result = {};

    for (const metric of appMetrics) {
        const dataUrl = `${dataBaseUrl}/${bucket}/${app}_${metric}.json`;
        const metricData = await fetchJson(dataUrl);
        if (metricData && metricData[rowKey] && metricData[rowKey][colIndex] != null) {
            result[metric] = metricData[rowKey][colIndex];
        }
    }

    return JSON.stringify(result);
}

/**
 * Destroy all chart instances.
 */
export function destroyAllCharts() {
    const ids = Object.keys(charts);
    for (const id of ids) {
        if (charts[id]) {
            charts[id].destroy();
            delete charts[id];
        }
    }
}

/**
 * Destroy a specific chart.
 * @param {string} canvasId
 */
export function destroyChart(canvasId) {
    if (charts[canvasId]) {
        charts[canvasId].destroy();
        delete charts[canvasId];
    }
}

/**
 * Set the time range filter for week data.
 * @param {string} range - '7d', '30d', '90d', '1y', or 'all'
 */
export function setTimeRange(range) {
    currentTimeRange = range;
}

/**
 * Register a callback from C# to be invoked when a chart point is clicked.
 * @param {Function} callback - C# [JSExport] callback: (detailJson: string) => void
 */
export function registerPointClickCallback(callback) {
    pointClickCallback = callback;
}

/**
 * Get the currently active time range.
 * @returns {string}
 */
export function getTimeRange() {
    return currentTimeRange;
}

/**
 * Set whether to show GA release data on charts.
 * @param {boolean} show
 */
export function setShowReleases(show) {
    showReleases = !!show;
}

/**
 * Set whether to show daily week data on charts.
 * @param {boolean} show
 */
export function setShowDailyReleases(show) {
    showDailyReleases = !!show;
}
