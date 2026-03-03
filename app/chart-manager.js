/**
 * Chart.js chart creation and update for benchmark metrics.
 */

const ENGINE_COLORS = {
    v8: '#4285F4',
    node: '#34A853',
    chrome: '#F4B400',
    firefox: '#EA4335'
};

const PRESET_DASHES = {
    'no-workload': [],
    aot: [10, 5],
    'native-relink': [3, 3],
    invariant: [10, 3, 3, 3],
    'no-reflection-emit': [15, 5],
    debug: [5, 5]
};

const RUNTIME_MARKERS = {
    coreclr: 'circle',
    mono: 'triangle',
    llvm_naot: 'rectRot'
};

const RUNTIME_LINE_WIDTH = {
    coreclr: 2,
    mono: 1.5,
    llvm_naot: 1.5
};

const METRICS = {
    'compile-time': { display: 'Compile Time', unit: 'ms' },
    'disk-size-total': { display: 'Disk Size — Total', unit: 'bytes' },
    'disk-size-wasm': { display: 'Disk Size — dotnet.wasm', unit: 'bytes' },
    'disk-size-dlls': { display: 'Disk Size — DLLs', unit: 'bytes' },
    'download-size-total': { display: 'Download Size — Total', unit: 'bytes' },
    'download-size-wasm': { display: 'Download Size — dotnet.wasm', unit: 'bytes' },
    'download-size-dlls': { display: 'Download Size — DLLs', unit: 'bytes' },
    'time-to-reach-managed': { display: 'Time to Reach Managed', unit: 'ms' },
    'time-to-reach-managed-cold': { display: 'Time to Reach Managed (Cold)', unit: 'ms' },
    'memory-peak': { display: 'Memory Peak', unit: 'bytes' },
    'js-interop-ops': { display: 'JS Interop', unit: 'ops/sec' },
    'json-parse-ops': { display: 'JSON Parsing', unit: 'ops/sec' },
    'exception-ops': { display: 'Exception Handling', unit: 'ops/sec' }
};

function formatValue(value, unit) {
    if (unit === 'bytes') {
        if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
        if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
        return `${value} B`;
    }
    if (unit === 'ms') {
        return `${value.toFixed(1)} ms`;
    }
    if (unit === 'ops/sec') {
        return `${value.toLocaleString()} ops/sec`;
    }
    return value.toString();
}

export class ChartManager {
    #container;
    #charts;
    #onZoomPan;

    constructor(container) {
        this.#container = container;
        this.#charts = new Map();
        this.#onZoomPan = null;
    }

    /** Register a callback for zoom/pan events: callback({ min, max }) */
    onZoomPan(callback) {
        this.#onZoomPan = callback;
    }

    /** Render (or update) one chart per metric. Removes charts for metrics no longer needed. */
    renderCharts(metricKeys, data, filterState) {
        // Remove charts for metrics no longer displayed
        for (const [key, chart] of this.#charts) {
            if (!metricKeys.includes(key)) {
                chart.destroy();
                chart.canvas.parentElement.remove();
                this.#charts.delete(key);
            }
        }

        for (const metricKey of metricKeys) {
            const datasets = this.#buildDatasets(metricKey, data);

            if (this.#charts.has(metricKey)) {
                const chart = this.#charts.get(metricKey);
                chart.data.datasets = datasets;
                chart.update();
            } else {
                const wrapper = document.createElement('div');
                wrapper.className = 'chart-wrapper';
                wrapper.dataset.metric = metricKey;
                const canvas = document.createElement('canvas');
                wrapper.appendChild(canvas);
                this.#container.appendChild(wrapper);

                const chart = new Chart(canvas, {
                    type: 'line',
                    data: { datasets },
                    options: this.#getChartOptions(metricKey)
                });
                this.#charts.set(metricKey, chart);
            }
        }
    }

    /** Destroy all charts and clear the container. */
    clear() {
        for (const [key, chart] of this.#charts) {
            chart.destroy();
        }
        this.#charts.clear();
        this.#container.innerHTML = '';
    }

    /** Set the x-axis range on all charts (called from timeline sync). */
    setXRange(minDate, maxDate) {
        for (const chart of this.#charts.values()) {
            chart.options.scales.x.min = minDate;
            chart.options.scales.x.max = maxDate;
            chart.update('none');
        }
    }

    #buildDatasets(metricKey, data) {
        const seriesMap = new Map();

        for (const result of data) {
            const value = result.metrics[metricKey];
            if (value == null) continue;

            const { runtime, preset, engine, commitDate, sdkVersion, gitHash } = result.meta;
            const seriesKey = `${runtime}/${preset}/${engine}`;

            if (!seriesMap.has(seriesKey)) {
                seriesMap.set(seriesKey, []);
            }
            seriesMap.get(seriesKey).push({
                x: commitDate,
                y: value,
                meta: result.meta
            });
        }

        return Array.from(seriesMap.entries()).map(([seriesKey, points]) => {
            const [runtime, preset, engine] = seriesKey.split('/');
            return {
                label: `${runtime} / ${preset} / ${engine}`,
                data: points.sort((a, b) => a.x.localeCompare(b.x)),
                borderColor: ENGINE_COLORS[engine] || '#999',
                borderWidth: RUNTIME_LINE_WIDTH[runtime] || 1.5,
                borderDash: PRESET_DASHES[preset] || [],
                pointStyle: RUNTIME_MARKERS[runtime] || 'circle',
                tension: 0.1,
                fill: false
            };
        });
    }

    #getChartOptions(metricKey) {
        const metric = METRICS[metricKey] || { display: metricKey, unit: '' };
        const onZoomPan = this.#onZoomPan;
        const syncCallback = ({ chart }) => {
            if (!onZoomPan) return;
            const scale = chart.scales.x;
            onZoomPan({ min: new Date(scale.min).toISOString().slice(0, 10), max: new Date(scale.max).toISOString().slice(0, 10) });
        };
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: metric.display,
                    font: { size: 16 }
                },
                tooltip: {
                    callbacks: {
                        title: (items) => {
                            const meta = items[0]?.raw?.meta;
                            return meta ? `Date: ${meta.commitDate}` : '';
                        },
                        label: (ctx) => {
                            const meta = ctx.raw.meta;
                            const lines = [];
                            if (meta) {
                                lines.push(`SDK: ${meta.sdkVersion || 'unknown'}`);
                                lines.push(`Git: ${(meta.gitHash || '').slice(0, 7)}`);
                                lines.push(`Runtime: ${meta.runtime}`);
                                lines.push(`Preset: ${meta.preset}`);
                                lines.push(`Engine: ${meta.engine}`);
                                lines.push(`────────────────`);
                            }
                            lines.push(`${metric.display}: ${formatValue(ctx.raw.y, metric.unit)}`);
                            return lines;
                        }
                    }
                },
                legend: {
                    position: 'top'
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',
                        onPanComplete: syncCallback
                    },
                    zoom: {
                        wheel: { enabled: true },
                        pinch: { enabled: true },
                        mode: 'x',
                        onZoomComplete: syncCallback
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'day', tooltipFormat: 'yyyy-MM-dd' },
                    title: { display: true, text: 'Date' }
                },
                y: {
                    title: {
                        display: true,
                        text: `${metric.display} (${metric.unit})`
                    },
                    beginAtZero: false
                }
            }
        };
    }
}

// Expose for testing
export { ENGINE_COLORS, PRESET_DASHES, RUNTIME_MARKERS, METRICS, formatValue };
