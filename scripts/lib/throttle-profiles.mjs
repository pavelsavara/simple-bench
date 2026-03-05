/**
 * Throttle profile definitions for simulating different device/network conditions.
 *
 * Profiles are a measurement-time dimension orthogonal to build presets.
 * CDP (Chrome DevTools Protocol) is required for throttling — Chrome only.
 */

/** All known profile names. */
export const ALL_PROFILES = ['desktop', 'mobile'];

export const PROFILES = {
    /** Desktop: no throttling (default behavior). */
    desktop: null,

    /**
     * Mobile: simulates a 3-year-old Android phone on US 4G LTE.
     * - CPU: 3x slowdown (conservative for cloud CI machines)
     * - Network: 20 Mbps down / 5 Mbps up / 70ms RTT
     */
    mobile: {
        cpu: { rate: 3 },
        network: {
            offline: false,
            downloadThroughput: (20 * 1_000_000) / 8,  // 20 Mbps → bytes/s
            uploadThroughput: (5 * 1_000_000) / 8,     // 5 Mbps → bytes/s
            latency: 70,                                 // ms RTT
        },
    },
};

/**
 * Returns true if the given profile requires CDP (Chrome only).
 */
export function profileRequiresCDP(profile) {
    return PROFILES[profile] != null;
}
