/**
 * havit-walkthrough.ts — Playwright walkthrough for Havit Bootstrap documentation app.
 *
 * Measures total wall-clock time from fresh navigation to completion.
 *
 * Steps: load home → click Documentation → visit one component page per sidebar category
 *      → visit a concept page → navigate to showcase → navigate home.
 */

import { debug } from '../log.js';

// Minimal Playwright Page type surface used by the walkthrough
type PlaywrightPage = {
    goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
    waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
    waitForFunction(fn: (() => boolean) | string, arg: unknown, options?: { timeout?: number }): Promise<unknown>;
    waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<unknown>;
    click(selector: string, options?: { timeout?: number }): Promise<void>;
    fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
    selectOption(selector: string, values: { index: number }, options?: { timeout?: number }): Promise<unknown>;
    dispatchEvent(selector: string, type: string): Promise<void>;
    evaluate<T>(fn: (() => T) | ((arg: string) => T), arg?: string): Promise<T>;
    on(event: string, handler: (...args: unknown[]) => void): void;
};

/**
 * Pages to visit via sidebar navigation.
 * Each entry: [sidebar link href suffix, URL pattern to wait for, selector to confirm page loaded].
 */
const SIDEBAR_PAGES: Array<[string, RegExp, string]> = [
    // Forms category
    ['/components/HxInputText', /\/components\/HxInputText/, 'h1'],
    // Buttons & Indicators
    ['/components/HxButton', /\/components\/HxButton/, 'h1'],
    // Data & Grid
    ['/components/HxGrid', /\/components\/HxGrid/, 'h1'],
    // Layout & Typography
    ['/components/HxAccordion', /\/components\/HxAccordion/, 'h1'],
    // Navigation
    ['/components/HxSidebar', /\/components\/HxSidebar/, 'h1'],
    // Modals & Interactions
    ['/components/HxModal', /\/components\/HxModal/, 'h1'],
    // Concepts
    ['/concepts/defaults-and-settings', /\/concepts\/defaults-and-settings/, 'h1'],
];

/**
 * Full walkthrough: navigates to home, then visits representative pages from each
 * sidebar category. Returns wall-clock duration in ms.
 */
export async function runHavitWalkthrough(
    page: PlaywrightPage,
    url: string,
    timeout: number,
    verbose = false,
): Promise<number> {
    const t = timeout;
    const log = verbose ? (msg: string) => debug(`Havit: ${msg}`) : () => { };

    const startTime: number = await page.evaluate(() => performance.now());

    // ── Step 0: Load home ────────────────────────────────────────────────
    log('navigating to home...');
    await page.goto(url, { timeout: t, waitUntil: 'load' });
    await page.waitForFunction(
        () => (globalThis as Record<string, unknown>).bench_complete !== undefined,
        null, { timeout: t },
    );
    await page.waitForSelector('h1.fw-bold.display-3', { timeout: t });
    log('home loaded');

    // ── Step 1: Click "Documentation" to go to /getting-started ──────────
    await page.click('a[href="/getting-started"].btn', { timeout: t });
    await page.waitForURL(/\/getting-started/, { timeout: t });
    await page.waitForSelector('.doc-content h1', { timeout: t });
    log('getting-started loaded');

    // ── Step 2: Visit pages via sidebar links ────────────────────────────
    for (const [href, urlPattern, contentSelector] of SIDEBAR_PAGES) {
        log(`clicking sidebar link: ${href}`);
        await page.click(`.doc-sidebar a[href="${href}"]`, { timeout: t });
        await page.waitForURL(urlPattern, { timeout: t });
        await page.waitForSelector(`.doc-content ${contentSelector}`, { timeout: t });
        log(`loaded: ${href}`);
    }

    // ── Step 3: Navigate to Showcase via navbar ──────────────────────────
    log('navigating to showcase via navbar...');
    await page.click('.nav-container a[href="showcase"]', { timeout: t });
    await page.waitForURL(/\/showcase/, { timeout: t });
    await page.waitForSelector('.showcase-list', { timeout: t });
    log('showcase loaded');

    // ── Step 4: Navigate back home via navbar ────────────────────────────
    log('navigating home via navbar...');
    await page.click('.nav-container a[href=""]', { timeout: t });
    await page.waitForSelector('h1.fw-bold.display-3', { timeout: t });
    log('home loaded again');

    const endTime: number = await page.evaluate(() => performance.now());
    return endTime - startTime;
}
