// Chart.js interop module for Blazor dashboard
// Called from C# via [JSImport] to fetch data and render charts

// ── State ────────────────────────────────────────────────────────────────────

let dataBaseUrl = '';
const cache = {};          // { url: json }
const charts = {};         // { canvasId: Chart instance }
let viewIndex = null;
let loadGeneration = 0;    // guards against concurrent loadAppCharts calls

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
    'disk-size-total': 'bytes',
    'disk-size-native': 'bytes',
    'disk-size-assemblies': 'bytes',
    'download-size-total': 'bytes',
    'time-to-reach-managed-warm': 'ms',
    'time-to-reach-managed-cold': 'ms',
    'memory-peak': 'bytes',
    'pizza-walkthrough': 'ms',
    'js-interop-ops': 'ops/sec',
    'json-parse-ops': 'ops/sec',
    'exception-ops': 'ops/sec',
};

const METRIC_DISPLAY = {
    'compile-time': 'Compile Time (s)',
    'disk-size-total': 'Disk Size (Total)',
    'disk-size-native': 'Disk Size (WASM)',
    'disk-size-assemblies': 'Disk Size (DLLs)',
    'download-size-total': 'Download Size (Total)',
    'time-to-reach-managed-warm': 'Time to Managed (Warm)',
    'time-to-reach-managed-cold': 'Time to Managed (Cold)',
    'memory-peak': 'Peak JS Heap',
    'pizza-walkthrough': 'Pizza Walkthrough',
    'js-interop-ops': 'JS Interop',
    'json-parse-ops': 'JSON Parse',
    'exception-ops': 'Exception Handling',
};

// Build-time metrics are identical across engines/profiles — only show chrome/desktop
const BUILD_METRICS = new Set([
    'compile-time', 'disk-size-total', 'disk-size-native', 'disk-size-assemblies', 'download-size-total',
]);

// Metrics to skip for microbenchmarks (not meaningful for internal throughput tests)
const MICROBENCH_SKIP_METRICS = new Set([
    'compile-time', 'disk-size-total', 'disk-size-native', 'disk-size-assemblies', 'download-size-total',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
    if (cache[url]) return cache[url];
    const resp = await fetch(url);
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
    // Build-time metrics: only show chrome/desktop (values are identical across engines)
    if (BUILD_METRICS.has(metric)) {
        if (d.engine !== 'chrome' || d.profile !== 'desktop') return false;
    }
    return filters.runtimes.includes(d.runtime)
        && filters.presets.includes(d.preset)
        && filters.profiles.includes(d.profile)
        && filters.engines.includes(d.engine);
}

function formatRowLabel(rowKey, metric) {
    if (BUILD_METRICS.has(metric)) {
        // Strip redundant /desktop/chrome for build-time and disk-size metrics
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

// ── Chart.js Plugin: Frozen release zone separator ───────────────────────────

const frozenZonePlugin = {
    id: 'frozenZone',
    beforeDraw(chart) {
        const meta = chart.options.plugins.frozenZone;
        if (!meta || !meta.dividerX) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(meta.dividerX, chartArea.top);
        ctx.lineTo(meta.dividerX, chartArea.bottom);
        ctx.stroke();
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

    const weekBuckets = [];
    for (const week of viewIndex.weeks) {
        const header = await fetchJson(`${dataBaseUrl}/${week}/header.json`);
        if (header) weekBuckets.push({ path: week, header, type: 'week', label: week });
    }

    const rendered = [];

    for (const metric of metrics) {
        // Abort if a newer loadAppCharts call has started
        if (gen !== loadGeneration) return JSON.stringify(rendered);

        // Skip build/disk metrics for microbenchmarks
        if (app === 'microbenchmarks' && MICROBENCH_SKIP_METRICS.has(metric)) continue;

        const canvasId = `chart-${app}-${metric}`;
        const canvas = document.getElementById(canvasId);
        if (!canvas) continue;

        const datasets = [];
        const allRowKeys = new Set();

        // ── Release data (frozen zone) ──
        for (const bucket of releaseBuckets) {
            // Skip if this bucket's header doesn't list this app+metric
            const bucketMetrics = bucket.header.apps?.[app];
            if (!bucketMetrics || !bucketMetrics.includes(metric)) continue;

            const dataUrl = `${dataBaseUrl}/${bucket.path}/${app}_${metric}.json`;
            const metricData = await fetchJson(dataUrl);
            if (!metricData) continue;

            for (const [rowKey, values] of Object.entries(metricData)) {
                allRowKeys.add(rowKey);
                if (!isRowVisible(rowKey, filters, metric)) continue;

                const points = values.map((v, i) => {
                    const col = bucket.header.columns[i];
                    return {
                        x: col ? col.sdkVersion : `${bucket.label}-${i}`,
                        y: v,
                        _colIndex: i,
                        _bucket: bucket.path,
                        _bucketType: 'release',
                    };
                }).filter(p => p.y != null);

                if (points.length === 0) continue;

                datasets.push({
                    label: `${formatRowLabel(rowKey, metric)} (${bucket.label})`,
                    data: points,
                    ...makeDatasetStyle(rowKey),
                    _rowKey: rowKey,
                    _zone: 'frozen',
                });
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
                if (!isRowVisible(rowKey, filters, metric)) continue;

                const points = values.map((v, i) => {
                    const col = bucket.header.columns[i];
                    return {
                        x: col ? col.runtimeCommitDateTime : null,
                        y: v,
                        _colIndex: i,
                        _bucket: bucket.path,
                        _bucketType: 'week',
                    };
                }).filter(p => p.x != null && p.y != null);

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

        if (datasets.length === 0) continue;

        // Sort active zone data by date
        for (const ds of datasets) {
            if (ds._zone === 'active') {
                ds.data.sort((a, b) => new Date(a.x) - new Date(b.x));
            }
        }

        const unit = METRIC_UNITS[metric] || '';
        const displayName = METRIC_DISPLAY[metric] || metric;

        // Determine if we have both zones
        const hasFrozen = datasets.some(d => d._zone === 'frozen');
        const hasActive = datasets.some(d => d._zone === 'active');

        // For simplicity in Phase 1: render active zone as time chart,
        // frozen zone as category points on the left
        // We use a single linear chart with all data converted to dates
        // Release data uses synthetic dates before the active range

        let chartDatasets;
        let xAxisType;

        if (hasActive && !hasFrozen) {
            // Pure time chart
            chartDatasets = datasets.filter(d => d._zone === 'active');
            xAxisType = 'time';
        } else if (hasFrozen && !hasActive) {
            // Pure category chart
            chartDatasets = datasets.filter(d => d._zone === 'frozen');
            xAxisType = 'category';
        } else {
            // Both: use time for active, show frozen separately
            // Phase 1: just show active data as time chart
            chartDatasets = datasets.filter(d => d._zone === 'active');
            if (chartDatasets.length === 0) chartDatasets = datasets.filter(d => d._zone === 'frozen');
            xAxisType = chartDatasets[0]?._zone === 'active' ? 'time' : 'category';
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
                                    return `SDK: ${pt.x}`;
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
                    frozenZone: {},
                },
                scales: {
                    x: xAxisType === 'time' ? {
                        type: 'time',
                        time: {
                            unit: 'day',
                            tooltipFormat: 'MMM d, yyyy',
                        },
                        title: { display: true, text: 'Date' },
                    } : {
                        type: 'category',
                        title: { display: true, text: 'SDK Version' },
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
                    // Dispatch custom event for Blazor to pick up
                    document.dispatchEvent(new CustomEvent('chartPointClick', {
                        detail: JSON.stringify(detail),
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
        for (const ds of chart.data.datasets) {
            const key = ds._rowKey;
            if (key) {
                ds.hidden = !isRowVisible(key, filters, metric);
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
