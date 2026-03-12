// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

globalThis.js_loaded = performance.now();

navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' });

function setManagedReady() {
    globalThis.dotnet_managed_ready = performance.now();
    globalThis.timings = {
        'time-to-create-dotnet': globalThis.js_loaded - globalThis.dotnet_created,
        'time-to-reach-managed': globalThis.js_loaded - globalThis.dotnet_managed_ready
    }
}

await Blazor.start({
    configureRuntime: dotnet => {
        dotnet.withEnvironmentVariable("CONFIGURE_RUNTIME", "true");
    },
    onDotNetReady: () => {
        globalThis.dotnet_created = performance.now();
        const { setModuleImports } = globalThis.getDotnetRuntime(0);
        setModuleImports('main.js', {
            bench: {
                setManagedReady,
            }
        });
    }
});
