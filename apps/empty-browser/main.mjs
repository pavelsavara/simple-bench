import { dotnet } from './_framework/dotnet.mjs';

const { getConfig } = await dotnet
    .withDiagnosticTracing(false)
    .create();

// Signal that managed code is about to run — used by measure-external.mjs
// for the "time-to-reach-managed" metric (warm measurement on reload).
globalThis.__managedReachedTime = performance.now();

await dotnet.run();
