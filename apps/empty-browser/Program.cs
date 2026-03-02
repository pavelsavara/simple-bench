using System;
using System.Runtime.InteropServices.JavaScript;

// Minimal browser-wasm app entry point.
// The __managedReachedTime marker is set by main.mjs after dotnet.run() completes.
Console.WriteLine("empty-browser loaded");
