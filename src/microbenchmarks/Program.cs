// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;

partial class MicroBenchmarkApp
{
    public static Task<int> Main()
    {
        Console.WriteLine("Microbenchmarks ready");
        SetBenchReady();
        return Task.FromResult(0);
    }

    [JSImport("bench.setBenchReady", "bench-driver.mjs")]
    internal static partial void SetBenchReady();
}
