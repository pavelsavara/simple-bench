// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { dotnet, exit } from './_framework/dotnet.js'

async function outer() {
    const isBrowser = typeof globalThis.window !== 'undefined';
    globalThis.js_loaded = performance.now();

    const { setModuleImports, getAssemblyExports, runMain } = await dotnet
        .withApplicationArguments("start")
        .create();

    setModuleImports('main.mjs', {
        bench: {
            setManagedReady: () => { globalThis.dotnet_managed_ready = performance.now(); }
        }
    });

    globalThis.dotnet_created = performance.now();
    globalThis.bench_results = {};

    await inner({ setModuleImports, getAssemblyExports, runMain, exit }, globalThis.bench_results);

    globalThis.dotnet_exit = performance.now();

    Object.assign(globalThis.bench_results, {
        'time-to-create-dotnet': Math.round(globalThis.dotnet_created - globalThis.js_loaded),
        'time-to-reach-managed': Math.round(globalThis.dotnet_managed_ready - globalThis.js_loaded),
        'time-to-exit': Math.round(globalThis.dotnet_exit - globalThis.js_loaded),
    });

    if (isBrowser) {
        const el = globalThis.document?.getElementById('status');
        if (el) {
            el.textContent = JSON.stringify(globalThis.bench_results, null, 2);
        }
    } else {
        console.log(JSON.stringify(globalThis.bench_results));
    }
}

async function inner({ setModuleImports, getAssemblyExports, runMain, exit }, results) {
    await runMain("EmptyBrowser", []);
    exit(0);
}

await outer();
