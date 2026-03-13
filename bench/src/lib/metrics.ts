import { MetricKey } from '../enums.js';

// ── Metric Metadata ──────────────────────────────────────────────────────────

export interface MetricInfo {
    displayName: string;
    unit: string;
    category: 'size' | 'time' | 'throughput' | 'memory';
}

export const METRICS: Record<MetricKey, MetricInfo> = {
    [MetricKey.CompileTime]: { displayName: 'Compile Time', unit: 'ms', category: 'time' },
    [MetricKey.DiskSizeTotal]: { displayName: 'Disk Size (Total)', unit: 'bytes', category: 'size' },
    [MetricKey.DiskSizeNative]: { displayName: 'Disk Size (WASM)', unit: 'bytes', category: 'size' },
    [MetricKey.DiskSizeAssemblies]: { displayName: 'Disk Size (DLLs)', unit: 'bytes', category: 'size' },
    [MetricKey.DownloadSizeTotal]: { displayName: 'Download Size (Total)', unit: 'bytes', category: 'size' },
    [MetricKey.TimeToReachManagedWarm]: { displayName: 'Time to Managed (Warm)', unit: 'ms', category: 'time' },
    [MetricKey.TimeToReachManagedCold]: { displayName: 'Time to Managed (Cold)', unit: 'ms', category: 'time' },
    [MetricKey.MemoryPeak]: { displayName: 'Peak JS Heap', unit: 'bytes', category: 'memory' },
    [MetricKey.PizzaWalkthrough]: { displayName: 'Pizza Walkthrough', unit: 'ms', category: 'time' },
    [MetricKey.JsInteropOps]: { displayName: 'JS Interop', unit: 'ops/sec', category: 'throughput' },
    [MetricKey.JsonParseOps]: { displayName: 'JSON Parse', unit: 'ops/sec', category: 'throughput' },
    [MetricKey.ExceptionOps]: { displayName: 'Exception Handling', unit: 'ops/sec', category: 'throughput' },
    [MetricKey.HavitWalkthrough]: { displayName: 'Havit Walkthrough', unit: 'ms', category: 'time' },
};

export const EXTERNAL_METRICS: MetricKey[] = [
    MetricKey.CompileTime,
    MetricKey.DiskSizeTotal,
    MetricKey.DiskSizeNative,
    MetricKey.DiskSizeAssemblies,
    MetricKey.DownloadSizeTotal,
    MetricKey.TimeToReachManagedWarm,
    MetricKey.TimeToReachManagedCold,
    MetricKey.MemoryPeak,
    MetricKey.PizzaWalkthrough,
    MetricKey.HavitWalkthrough,
];

export const INTERNAL_METRICS: MetricKey[] = [
    MetricKey.CompileTime,
    MetricKey.MemoryPeak,
    MetricKey.JsInteropOps,
    MetricKey.JsonParseOps,
    MetricKey.ExceptionOps,
];
