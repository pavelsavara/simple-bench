import { dotnet } from './_framework/dotnet.mjs';

// Helpers called from C# via [JSImport("getTimestamp", "main.mjs")] etc.
export function getTimestamp() {
    return performance.now();
}

export function setGlobalProperty(name, value) {
    globalThis[name] = value;
}

const { getConfig } = await dotnet
    .withDiagnosticTracing(false)
    .create();

// JS-side marker: WASM bootstrapped, about to enter managed code.
globalThis.dotnet_ready = performance.now();

await dotnet.run();
