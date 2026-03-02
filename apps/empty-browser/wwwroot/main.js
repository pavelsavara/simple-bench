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
await runMain();