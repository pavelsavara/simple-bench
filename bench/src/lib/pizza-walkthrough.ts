/**
 * Simplified pizza walkthrough: navigate to home page, wait for content to render.
 * Returns wall-clock duration in milliseconds.
 *
 * Playwright is imported dynamically to keep it external to the rollup bundle.
 */

// Playwright Page type — imported dynamically at runtime
type PlaywrightPage = {
    goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
    waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
};

/**
 * Navigate to the blazing-pizza home page and wait for the specials list to render.
 * Returns the wall-clock duration in ms.
 */
export async function runPizzaWalkthrough(page: PlaywrightPage, url: string, timeout: number): Promise<number> {
    const start = performance.now();

    await page.goto(url, { timeout, waitUntil: 'load' });

    // Wait for the pizza specials list to render (indicates Blazor app is interactive)
    await page.waitForSelector('[data-testid="pizza-specials"]', { timeout });

    return performance.now() - start;
}
