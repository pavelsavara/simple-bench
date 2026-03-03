/**
 * Dashboard orchestrator — wires data loading, filtering, chart rendering, and timeline.
 */
import { DataLoader } from './data-loader.js';
import { ChartManager } from './chart-manager.js';
import { Filters, readHashState, writeHash, pushHash } from './filters.js';
import { Timeline } from './timeline.js';

const EXTERNAL_METRICS = [
    'compile-time', 'disk-size-total', 'disk-size-wasm', 'disk-size-dlls',
    'download-size-total', 'download-size-wasm', 'download-size-dlls',
    'time-to-reach-managed', 'time-to-reach-managed-cold', 'memory-peak'
];
const INTERNAL_METRICS = ['js-interop-ops', 'json-parse-ops', 'exception-ops'];
const APP_METRICS = {
    'empty-browser': EXTERNAL_METRICS,
    'empty-blazor': EXTERNAL_METRICS,
    'blazing-pizza': EXTERNAL_METRICS,
    'microbenchmarks': INTERNAL_METRICS
};

const dataLoader = new DataLoader('data/');
const chartManager = new ChartManager(document.getElementById('charts-container'));
const filters = new Filters(document.getElementById('sidebar'));
const timeline = new Timeline(document.getElementById('timeline-container'));

let currentApp = 'empty-browser';

async function init() {
    showLoading(true);

    try {
        const index = await dataLoader.loadIndex();

        document.getElementById('last-updated').textContent =
            `Updated: ${new Date(index.lastUpdated).toLocaleDateString()}`;

        if (!index.months || index.months.length === 0) {
            document.getElementById('empty-state').textContent =
                'No benchmark data yet. Run the CI pipeline to collect data.';
            document.getElementById('empty-state').classList.remove('hidden');
            showLoading(false);
            return;
        }

        // Compute full data extent from month keys
        const firstMonth = index.months[0]; // e.g. "2022-03"
        const lastMonth = index.months[index.months.length - 1];
        const dataMin = `${firstMonth}-01`;
        // Last day of last month
        const [y, m] = lastMonth.split('-').map(Number);
        const dataMax = new Date(y, m, 0).toISOString().slice(0, 10);
        timeline.setDataExtent(dataMin, dataMax);

        const hashState = readHashState();
        if (hashState.app && APP_METRICS[hashState.app]) {
            currentApp = hashState.app;
        }

        // Apply hash range to timeline, or default to last 30 days
        if (hashState.range?.min && hashState.range?.max) {
            timeline.setViewRange(hashState.range.min, hashState.range.max);
        } else {
            // Default: last 90 days
            const defaultMin = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
            timeline.setViewRange(defaultMin, dataMax);
        }
        filters.setRange(timeline.getRange());

        filters.init(index.dimensions, hashState);

        setActiveTab(currentApp);

        await dataLoader.loadMonths(filters.getState().range);
        await renderCurrentView();

        // Home/reset button → reset to default 90 days
        timeline.onReset(async () => {
            const defaultMin = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
            timeline.setViewRange(defaultMin, dataMax);
            const range = timeline.getRange();
            filters.setRange(range);
            writeHash(currentApp, filters.getState());
            await dataLoader.loadMonths(range);
            await renderCurrentView();
            chartManager.setXRange(range.min, range.max);
        });

        // Timeline changes → update data range
        timeline.onChange(async (range) => {
            filters.setRange(range);
            writeHash(currentApp, filters.getState());
            await dataLoader.loadMonths(range);
            await renderCurrentView();
            // Sync chart x-axis to match timeline
            chartManager.setXRange(range.min, range.max);
        });

        // Chart zoom/pan → sync all charts + timeline
        chartManager.onZoomPan((range) => {
            chartManager.setXRange(range.min, range.max);
            timeline.setViewRange(range.min, range.max);
            filters.setRange(range);
            writeHash(currentApp, filters.getState());
        });

        filters.onChange(async () => {
            writeHash(currentApp, filters.getState());
            await dataLoader.loadMonths(filters.getState().range);
            await renderCurrentView();
        });

        setupTabListeners();
        window.addEventListener('hashchange', onHashChange);
    } catch (e) {
        console.error('Dashboard init failed:', e);
        showFetchError();
    } finally {
        showLoading(false);
    }
}

async function renderCurrentView() {
    const filterState = filters.getState();
    const metrics = APP_METRICS[currentApp] || EXTERNAL_METRICS;

    const isExternal = currentApp !== 'microbenchmarks';
    filters.setEngineVisibility(
        isExternal ? ['chrome', 'firefox'] : ['v8', 'node', 'chrome', 'firefox']
    );

    updatePresetVisibility();

    const matchingRuns = dataLoader.filterRuns(currentApp, filterState);
    const emptyState = document.getElementById('empty-state');
    const container = document.getElementById('charts-container');

    if (matchingRuns.length === 0) {
        chartManager.clear();
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    const data = await dataLoader.loadRunData(matchingRuns);

    // Filter metrics to only those present in the data
    const presentMetrics = metrics.filter(m =>
        data.some(d => d.metrics[m] != null)
    );

    chartManager.renderCharts(presentMetrics, data, filterState);

    const count = dataLoader.countDataPoints();
    document.getElementById('data-points').textContent = `Data points: ${count.toLocaleString()}`;
}

function updatePresetVisibility() {
    const state = filters.getState();
    const sidebar = document.getElementById('sidebar');
    const aotLabel = sidebar.querySelector('input[value="aot"]')?.closest('.filter-option');
    if (aotLabel) {
        const monoSelected = state.runtime.includes('mono');
        aotLabel.style.display = monoSelected ? '' : 'none';
        if (!monoSelected) {
            const cb = aotLabel.querySelector('input');
            if (cb) cb.checked = false;
        }
    }
}

function setupTabListeners() {
    for (const tab of document.querySelectorAll('#app-tabs .tab')) {
        tab.addEventListener('click', async () => {
            const app = tab.dataset.app;
            if (app === currentApp) return;
            currentApp = app;
            setActiveTab(app);
            pushHash(app, filters.getState());
            chartManager.clear();
            await dataLoader.loadMonths(filters.getState().range);
            await renderCurrentView();
        });
    }
}

function setActiveTab(app) {
    for (const tab of document.querySelectorAll('#app-tabs .tab')) {
        tab.classList.toggle('active', tab.dataset.app === app);
    }
}

async function onHashChange() {
    const hashState = readHashState();
    if (hashState.app && hashState.app !== currentApp && APP_METRICS[hashState.app]) {
        currentApp = hashState.app;
        setActiveTab(currentApp);
    }
    if (hashState.range?.min && hashState.range?.max) {
        timeline.setViewRange(hashState.range.min, hashState.range.max);
        filters.setRange(hashState.range);
    }
    await dataLoader.loadMonths(filters.getState().range);
    await renderCurrentView();
}

function showLoading(visible) {
    const el = document.getElementById('loading-indicator');
    if (el) el.classList.toggle('hidden', !visible);
}

function showFetchError() {
    const container = document.getElementById('charts-container');
    container.innerHTML = `
        <div class="error-state">
            <p>Failed to load benchmark data.</p>
            <button onclick="location.reload()">Retry</button>
        </div>
    `;
}

document.addEventListener('DOMContentLoaded', init);
