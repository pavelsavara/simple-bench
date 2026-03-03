// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Runtime.InteropServices.JavaScript;

/// <summary>
/// Exception handling benchmark.
/// Throws and catches an exception in a tight loop to measure overhead.
/// </summary>
public static partial class ExceptionBench
{
    [JSExport]
    public static int ThrowCatch(int value)
    {
        try
        {
            throw new InvalidOperationException("bench");
        }
        catch
        {
            return value;
        }
    }
}
