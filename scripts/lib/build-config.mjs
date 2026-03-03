/**
 * Build preset mapping utilities.
 * Maps runtime + preset dimension values to MSBuild publish arguments.
 */

/** Map our lowercase runtime dimension to MSBuild RuntimeFlavor value */
export function mapRuntimeFlavor(runtime) {
    switch (runtime) {
        case 'coreclr': return 'CoreCLR';
        case 'mono': return 'Mono';
        case 'naot_llvm': return 'Mono';
        default:
            throw new Error(`Unknown runtime: ${runtime}. Expected 'coreclr' or 'mono'.`);
    }
}

/** Map our lowercase preset dimension to BenchmarkPreset property value.
 *  The csproj handles Configuration (Release/Debug) internally based on BenchmarkPreset. */
const PRESET_MAP = {
    'debug': 'Debug',
    'no-workload': 'NoWorkload',
    'aot': 'Aot',
    'native-relink': 'NativeRelink',
    'no-jiterp': 'NoJiterp',
    'invariant': 'Invariant',
    'no-reflection-emit': 'NoReflectionEmit',
};

export { PRESET_MAP };

/**
 * Get MSBuild publish arguments for a given preset.
 * Only passes /p:BenchmarkPreset — the csproj sets -c Release/Debug
 * and feature flags based on the BenchmarkPreset value.
 */
export function getPresetArgs(preset) {
    const benchPreset = PRESET_MAP[preset];
    if (!benchPreset) {
        throw new Error(`Unknown preset: ${preset}. Expected one of: ${Object.keys(PRESET_MAP).join(', ')}`);
    }
    return [`/p:BenchmarkPreset=${benchPreset}`];
}

/**
 * Validate that the runtime + preset combination is valid.
 * AOT is Mono-only.
 */
export function validateCombination(runtime, preset) {
    if (preset === 'aot' && runtime !== 'mono') {
        throw new Error(`Preset 'aot' is only valid with runtime 'mono', got '${runtime}'`);
    }
    if (preset === 'no-jiterp' && runtime !== 'mono') {
        throw new Error(`Preset 'no-jiterp' is only valid with runtime 'mono', got '${runtime}'`);
    }
    return true;
}

/**
 * Build the full dotnet publish argument list.
 */
export function getPublishArgs(runtime, preset, appDir, outputDir) {
    validateCombination(runtime, preset);

    const runtimeFlavor = mapRuntimeFlavor(runtime);
    const presetArgs = getPresetArgs(preset);

    return [
        preset !== 'debug' ? 'publish' : 'build',
        appDir,
        ...presetArgs,
        `/p:RuntimeFlavor=${runtimeFlavor}`,
        '-o', outputDir
    ];
}
