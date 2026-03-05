/**
 * pizza-walkthrough.mjs — Playwright smoke-test walkthrough for Blazing Pizza.
 *
 * Measures total wall-clock time from fresh navigation to order tracking page.
 *
 * Steps: load home → pick pizza → configure (resize + topping) → add to cart
 *      → checkout → fill address → place order → verify tracking page.
 */

/**
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 * @param {number} timeoutMs
 * @param {{ ts: () => string }} opts
 * @returns {Promise<number>} wall-clock duration in ms
 */
export async function runPizzaWalkthrough(page, baseUrl, timeoutMs, { ts }) {
    const sel = (id) => `[data-testid="${id}"]`;
    const t = timeoutMs;

    const startTime = await page.evaluate(() => performance.now());

    // Fresh navigation for walkthrough
    console.error(`  ${ts()} Pizza: navigating to home...`);
    await page.goto(baseUrl, { timeout: t, waitUntil: 'load' });
    await page.waitForFunction(
        () => globalThis.dotnet_managed_ready !== undefined,
        null, { timeout: t }
    );
    console.error(`  ${ts()} Pizza: home loaded`);

    // Wait for pizza specials to render
    await page.waitForSelector(sel('pizza-cards'), { timeout: t });
    await page.waitForSelector(sel('pizza-special-1'), { timeout: t });
    console.error(`  ${ts()} Pizza: specials rendered`);

    // Click first pizza (Basic Cheese Pizza)
    await page.click(sel('pizza-special-1'));
    await page.waitForSelector(sel('dialog-container'), { state: 'visible', timeout: t });
    console.error(`  ${ts()} Pizza: dialog opened`);

    // Adjust size slider to 15
    await page.fill(sel('size-slider'), '15');
    await page.dispatchEvent(sel('size-slider'), 'input');

    // Add a topping
    await page.waitForSelector(sel('topping-select'), { timeout: t });
    await page.selectOption(sel('topping-select'), { index: 1 });

    // Confirm pizza → add to cart
    await page.click(sel('confirm-pizza-button'));
    await page.waitForSelector(sel('dialog-container'), { state: 'hidden', timeout: t });
    console.error(`  ${ts()} Pizza: pizza confirmed, added to cart`);

    // Verify cart has item
    await page.waitForSelector(sel('cart-item'), { timeout: t });

    // Click "Order >" to go to checkout
    await page.click(sel('order-button'));
    await page.waitForSelector(sel('checkout-main'), { timeout: t });
    console.error(`  ${ts()} Pizza: checkout loaded`);

    // Fill delivery address
    await page.fill(sel('address-name'), 'Test User');
    await page.fill(sel('address-line1'), '123 Pizza Street');
    await page.fill(sel('address-city'), 'London');
    await page.fill(sel('address-region'), 'Greater London');
    await page.fill(sel('address-postalcode'), 'EC1A 1BB');

    // Place order
    await page.click(sel('place-order-button'));
    console.error(`  ${ts()} Pizza: order placed`);

    // Wait for order tracking page
    await page.waitForSelector(sel('track-order'), { timeout: t });
    await page.waitForSelector(sel('order-status'), { timeout: t });
    console.error(`  ${ts()} Pizza: tracking page loaded`);

    const endTime = await page.evaluate(() => performance.now());
    return endTime - startTime;
}
