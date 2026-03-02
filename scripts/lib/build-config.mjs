/**
 * Build configuration mapping utilities.
 * Maps runtime + config dimension values to MSBuild publish arguments.
 */

/** Map our lowercase runtime dimension to MSBuild RuntimeFlavor value */
export function mapRuntimeFlavor(runtime) {
    switch (runtime) {
        case 'coreclr': return 'CoreCLR';
        case 'mono': return 'Mono';
        default:
            throw new Error(`Unknown runtime: ${runtime}. Expected 'coreclr' or 'mono'.`);
    }
}

/**
 * Get MSBuild publish arguments for a given config.
 * Returns an array of argument strings (without the leading -c flag).
 */
export function getConfigArgs(config) {
    switch (config) {
        case 'release':
            return ['-c', 'Release'];
        case 'aot':
            return ['-c', 'Release', '/p:RunAOTCompilation=true'];
        case 'native-relink':
            return ['-c', 'Release', '/p:WasmNativeRelink=true'];
        case 'invariant':
            return ['-c', 'Release', '/p:InvariantGlobalization=true'];
        case 'no-reflection-emit':
            return ['-c', 'Release', '/p:_WasmNoReflectionEmit=true'];
        case 'debug':
            return ['-c', 'Debug'];
        default:
            throw new Error(`Unknown config: ${config}. Expected one of: release, aot, native-relink, invariant, no-reflection-emit, debug`);
    }
}

/**
 * Validate that the runtime + config combination is valid.
 * AOT is Mono-only.
 */
export function validateCombination(runtime, config) {
    if (config === 'aot' && runtime !== 'mono') {
        throw new Error(`Config 'aot' is only valid with runtime 'mono', got '${runtime}'`);
    }
    return true;
}

/**
 * Build the full dotnet publish argument list.
 */
export function getPublishArgs(runtime, config, appDir, outputDir) {
    validateCombination(runtime, config);

    const runtimeFlavor = mapRuntimeFlavor(runtime);
    const configArgs = getConfigArgs(config);

    return [
        'publish',
        appDir,
        ...configArgs,
        `/p:RuntimeFlavor=${runtimeFlavor}`,
        '-o', outputDir
    ];
}
