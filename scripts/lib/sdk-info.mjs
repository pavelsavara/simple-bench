/**
 * SDK version parsing and info extraction utilities.
 * Shared between resolve-sdk.sh (via node -e) and unit tests.
 */

/**
 * Parse YYDDD build date from an SDK version string.
 * e.g. "11.0.100-preview.3.25130.1" → { year: 2025, dayOfYear: 130 } → "2025-05-10"
 * Returns null if the pattern is not found.
 */
export function parseBuildDate(sdkVersion) {
    // Match 5-digit build number before the final .N segment
    // Patterns: X.Y.Z-preview.N.YYDDD.R  or  X.Y.ZNN (RTM with band)
    const match = sdkVersion.match(/\.(\d{5})\.\d+$/);
    if (!match) return null;

    const buildNum = match[1];
    const yy = parseInt(buildNum.slice(0, 2), 10);
    const ddd = parseInt(buildNum.slice(2), 10);

    if (yy < 20 || yy > 40 || ddd < 1 || ddd > 366) return null;

    const year = 2000 + yy;
    // Day 1 = Jan 1
    const date = new Date(Date.UTC(year, 0, ddd));
    if (isNaN(date.getTime())) return null;

    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parse git commit hash from `dotnet --info` output — SDK section.
 * Looks for "Commit:  <hex>" line in the ".NET SDK:" section.
 */
export function parseCommitHash(dotnetInfoOutput) {
    const match = dotnetInfoOutput.match(/Commit:\s+([a-f0-9]+)/i);
    return match ? match[1] : null;
}

/**
 * Parse host commit hash from `dotnet --info` output — Host section.
 * The Host section appears after ".NET SDK:" and has its own "Commit:" line.
 * This is the dotnet/runtime (host) commit, often a short hash (~10 chars).
 * We pick the second "Commit:" line (first is SDK, second is Host).
 */
export function parseHostCommitHash(dotnetInfoOutput) {
    const commits = [...dotnetInfoOutput.matchAll(/Commit:\s+([a-f0-9]+)/gi)];
    return commits.length >= 2 ? commits[1][1] : null;
}

/**
 * Parse SDK version from `dotnet --version` output (just trims whitespace).
 */
export function parseSdkVersion(dotnetVersionOutput) {
    return dotnetVersionOutput.trim();
}

/**
 * Build the SDK info JSON object from parsed components.
 */
export function buildSdkInfo(sdkVersion, runtimeGitHash, sdkGitHash, vmrGitHash, commitDate, commitTime) {
    return {
        sdkVersion,
        runtimeGitHash,
        sdkGitHash,
        vmrGitHash,
        commitDate,   // "YYYY-MM-DD"
        commitTime    // "HH-MM-SS-UTC"
    };
}
