namespace BenchViewer.Models;

public class MetricInfo
{
    public string Key { get; }
    public string DisplayName { get; }
    public string Unit { get; }
    public string Category { get; }

    public MetricInfo(string key, string displayName, string unit, string category)
    {
        Key = key;
        DisplayName = displayName;
        Unit = unit;
        Category = category;
    }

    public static readonly Dictionary<string, MetricInfo> All = new()
    {
        ["compile-time"] = new("compile-time", "Compile Time", "ms", "time"),
        ["disk-size-native"] = new("disk-size-native", "Disk Size (dotnet.native.wasm.br)", "bytes", "size"),
        ["disk-size-assemblies"] = new("disk-size-assemblies", "Disk Size (*.dll.br)", "bytes", "size"),
        ["download-size-total"] = new("download-size-total", "Download Size (Total)", "bytes", "size"),
        ["time-to-reach-managed-warm"] = new("time-to-reach-managed-warm", "Time to Managed (Warm)", "ms", "time"),
        ["time-to-reach-managed-cold"] = new("time-to-reach-managed-cold", "Time to Managed (Cold)", "ms", "time"),
        ["memory-peak"] = new("memory-peak", "Peak JS Heap", "bytes", "memory"),
        ["pizza-walkthrough"] = new("pizza-walkthrough", "Pizza Walkthrough", "ms", "time"),
        ["js-interop-ops"] = new("js-interop-ops", "JS Interop", "ops/sec", "throughput"),
        ["json-parse-ops"] = new("json-parse-ops", "JSON Parse", "ops/sec", "throughput"),
        ["exception-ops"] = new("exception-ops", "Exception Handling", "ops/sec", "throughput"),
        ["havit-walkthrough"] = new("havit-walkthrough", "Havit Walkthrough", "ms", "time"),
    };
}
