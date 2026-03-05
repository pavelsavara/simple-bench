// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { dotnet } from './_framework/dotnet.js'

const { setModuleImports, runMain } = await dotnet
    .withApplicationArguments("start")
    .create();

setModuleImports('main.js', {
    bench: {
        setManagedReady: () => { globalThis.dotnet_managed_ready = performance.now(); }
    }
});

globalThis.dotnet_ready = performance.now();
await runMain("EmptyBrowser", []);

// CLI engines (v8/d8, node): output timing as JSON for measurement scripts.
// In a browser, `window` exists so this is skipped.
if (typeof window === 'undefined' && typeof globalThis.dotnet_managed_ready !== 'undefined') {
    console.log(JSON.stringify({
        'time-to-reach-managed': globalThis.dotnet_managed_ready
    }));
}