import { execCapture } from '../exec.js';
import { info } from '../log.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';
export const NUGET_FLAT = 'https://api.nuget.org/v3-flatcontainer';
export const PRODUCT_COMMIT_BASE = 'https://builds.dotnet.microsoft.com/dotnet/Sdk';
export const RELEASES_INDEX_URL = 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json';

// ── GitHub token resolution ──────────────────────────────────────────────────

let cachedToken: string | undefined;
let tokenResolved = false;

/**
 * Resolve a GitHub token. Checks GITHUB_TOKEN / GH_TOKEN env vars first,
 * then falls back to `gh auth token` (gh CLI).
 */
export async function resolveGitHubToken(): Promise<string | undefined> {
    if (tokenResolved) return cachedToken;
    tokenResolved = true;

    const envToken = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'];
    if (envToken) {
        cachedToken = envToken;
        return cachedToken;
    }

    try {
        const token = await execCapture('gh', ['auth', 'token'], { throwOnError: false });
        if (token && token.length > 0 && !token.includes(' ')) {
            cachedToken = token;
        }
    } catch {
        // gh CLI not installed or not logged in — no token
    }

    return cachedToken;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export function githubHeaders(token?: string): Record<string, string> {
    const h: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'simple-bench-cli',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
}

/**
 * Fetch JSON from a URL. Returns null on 404.
 * Throws on rate-limit (403/429) and other server errors.
 */
export async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
    const resp = await fetch(url, { headers });
    if (resp.ok) return await resp.json() as T;

    if (resp.status === 404) return null;

    if (resp.status === 403 || resp.status === 429) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Rate limited (${resp.status}) fetching ${url}: ${body.slice(0, 200)}`);
    }

    // Other errors — return null (transient / unknown)
    return null;
}

/**
 * HEAD request — returns true if the URL exists (2xx).
 */
export async function headOk(url: string): Promise<boolean> {
    const resp = await fetch(url, { method: 'HEAD' });
    return resp.ok;
}

// ── Concurrency limiter ──────────────────────────────────────────────────────

/**
 * Map an array through an async function with bounded concurrency.
 */
export async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;

    async function worker(): Promise<void> {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
