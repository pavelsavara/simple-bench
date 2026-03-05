/**
 * Canonical metric registry.
 * Unit is defined here, not in individual data files.
 * Shared by measurement scripts and dashboard.
 */
export const METRICS = {
    'compile-time': { displayName: 'Compile Time', unit: 'ms', category: 'external' },
    'disk-size-total': { displayName: 'Disk Size (Total)', unit: 'bytes', category: 'external' },
    'disk-size-wasm': { displayName: 'Disk Size (WASM)', unit: 'bytes', category: 'external' },
    'disk-size-dlls': { displayName: 'Disk Size (DLLs)', unit: 'bytes', category: 'external' },
    'download-size-total': { displayName: 'Download Size (Total)', unit: 'bytes', category: 'external' },
    'time-to-reach-managed': { displayName: 'Time to Reach Managed', unit: 'ms', category: 'external' },
    'time-to-reach-managed-cold': { displayName: 'Time to Reach Managed (Cold)', unit: 'ms', category: 'external' },
    'memory-peak': { displayName: 'Memory Peak', unit: 'bytes', category: 'external' },
    'pizza-walkthru': { displayName: 'Pizza Walkthrough', unit: 'ms', category: 'external' },
    'mud-blazor-walkthru': { displayName: 'MudBlazor Walkthrough', unit: 'ms', category: 'external' },
    'js-interop-ops': { displayName: 'JS Interop', unit: 'ops/sec', category: 'internal' },
    'json-parse-ops': { displayName: 'JSON Parsing', unit: 'ops/sec', category: 'internal' },
    'exception-ops': { displayName: 'Exception Handling', unit: 'ops/sec', category: 'internal' },
};

export const EXTERNAL_METRICS = Object.entries(METRICS)
    .filter(([, v]) => v.category === 'external')
    .map(([k]) => k);

export const INTERNAL_METRICS = Object.entries(METRICS)
    .filter(([, v]) => v.category === 'internal')
    .map(([k]) => k);
