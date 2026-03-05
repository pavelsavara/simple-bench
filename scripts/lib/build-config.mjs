/**
 * Build preset mapping utilities.
 * Maps runtime + preset dimension values to MSBuild publish arguments.
 */

/** Map our lowercase runtime dimension to MSBuild RuntimeFlavor value */
export function mapRuntimeFlavor(runtime) {
    switch (runtime) {
        case 'coreclr': return 'CoreCLR';
        case 'mono': return 'Mono';
        case 'naotllvm': return 'Mono';
        default:
            throw new Error(`Unknown runtime: ${runtime}. Expected 'coreclr' or 'mono'.`);
    }
}

/** Map our lowercase preset dimension to BenchmarkPreset property value.
 *  The csproj handles Configuration (Release/Debug) internally based on BenchmarkPreset.
 *  We also pass -c explicitly to override dotnet publish's default of Release. */
const PRESET_MAP = {
    'devloop': 'DevLoop',
    'no-workload': 'NoWorkload',
    'aot': 'Aot',
    'native-relink': 'NativeRelink',
    'no-jiterp': 'NoJiterp',
    'invariant': 'Invariant',
    'no-reflection-emit': 'NoReflectionEmit',
};

/** Map preset to MSBuild Configuration value. */
const PRESET_CONFIG = {
    'devloop': 'Debug',
    'no-workload': 'Release',
    'aot': 'Release',
    'native-relink': 'Release',
    'no-jiterp': 'Release',
    'invariant': 'Release',
    'no-reflection-emit': 'Release',
};

export { PRESET_MAP };

/** Presets that require the wasm-tools workload to be installed before build/publish.
 *  These presets set WasmBuildNative=true or RunAOTCompilation=true in the csproj,
 *  which needs the wasm-tools workload (Emscripten, wasm-opt, AOT compiler, etc). */
const WORKLOAD_PRESETS = new Set([
    'native-relink',
    'aot',
    'no-jiterp',
    'invariant',
    'no-reflection-emit',
]);

/** Presets that do NOT require the wasm-tools workload.
 *  These can be compiled with a bare SDK (no workload installed). */
const NON_WORKLOAD_PRESETS = new Set([
    'devloop',
    'no-workload',
]);

export { WORKLOAD_PRESETS, NON_WORKLOAD_PRESETS };

/**
 * Returns true if the given preset requires the wasm-tools workload.
 */
export function needsWorkload(preset) {
    return WORKLOAD_PRESETS.has(preset);
}

/**
 * Return sorted arrays of preset names split by workload requirement.
 * @returns {{ nonWorkload: string[], workload: string[] }}
 */
export function getPresetGroups() {
    return {
        nonWorkload: [...NON_WORKLOAD_PRESETS].sort(),
        workload: [...WORKLOAD_PRESETS].sort(),
    };
}

/**
 * Get MSBuild publish arguments for a given preset.
 * Passes /p:BenchmarkPreset — the csproj sets -c Release/Debug
 * and feature flags based on the BenchmarkPreset value.
 */
export function getPresetArgs(preset) {
    const benchPreset = PRESET_MAP[preset];
    if (!benchPreset) {
        throw new Error(`Unknown preset: ${preset}. Expected one of: ${Object.keys(PRESET_MAP).join(', ')}`);
    }
    const config = PRESET_CONFIG[preset] || 'Release';
    return [`/p:BenchmarkPreset=${benchPreset}`, '-c', config];
}

/** Apps that use Blazor (DOM-dependent, no CLI engine support). */
const BLAZOR_APPS = new Set(['empty-blazor', 'blazing-pizza']);
export { BLAZOR_APPS };

/**
 * Returns a reason string if measurement should be skipped for this app+preset,
 * or null if the combination is valid for measurement.
 */
export function shouldSkipMeasurement(app, preset) {
    if (BLAZOR_APPS.has(app) && preset === 'no-reflection-emit') {
        return `Blazor app '${app}' is not supported with preset 'no-reflection-emit'`;
    }
    return null;
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
        'publish',
        `-bl:${outputDir}/publish.binlog`,
        appDir,
        ...presetArgs,
        `/p:RuntimeFlavor=${runtimeFlavor}`,
        '-o', outputDir
    ];
}
