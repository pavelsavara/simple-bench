using System.Runtime.InteropServices.JavaScript;

// Managed-side marker: set globalThis.dotnet_managed_ready to current timestamp.
// This fires when managed code actually executes (more accurate than JS-side marker).
Interop.SetGlobalProperty("dotnet_managed_ready", Interop.GetTimestamp());

Console.WriteLine("empty-browser loaded");

internal static partial class Interop
{
    [JSImport("getTimestamp", "main.mjs")]
    internal static partial double GetTimestamp();

    [JSImport("setGlobalProperty", "main.mjs")]
    internal static partial void SetGlobalProperty(string name, double value);
}
