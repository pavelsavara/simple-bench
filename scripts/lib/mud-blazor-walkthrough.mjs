/**
 * mud-blazor-walkthrough.mjs — Playwright smoke-test walkthrough for TryMudBlazor.
 *
 * Measures total wall-clock time from Index page load through REPL interactions.
 *
 * Steps: load Index → navigate to REPL → run default code → toggle dark mode
 *      → add/switch/close tabs → type code with errors → run → diagnostics
 *      → restore valid code → run → verify output → open/close save popup
 *      → navigate back to Index.
 */

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 * @param {number} timeoutMs
 * @param {{ ts: () => string }} opts
 * @returns {Promise<number>} wall-clock duration in ms
 */
export async function runMudBlazorWalkthrough(page, baseUrl, timeoutMs, { ts }) {
    const sel = (id) => `[data-testid="${id}"]`;
    const t = timeoutMs;

    const startTime = await page.evaluate(() => performance.now());

    // ── Step 0: Index page loads ────────────────────────────────────────
    console.error(`  ${ts()} MudBlazor: navigating to Index...`);
    await page.goto(baseUrl, { timeout: t, waitUntil: 'load' });
    await page.waitForFunction(
        () => globalThis.dotnet_managed_ready !== undefined,
        null, { timeout: t }
    );
    await page.waitForSelector(sel('index-app-bar'), { timeout: t });
    await page.waitForSelector(sel('play-now-button'), { timeout: t });
    console.error(`  ${ts()} MudBlazor: Index loaded`);

    // ── Step 1: Navigate to REPL via "Play now" ─────────────────────────
    await page.click(sel('play-now-button'));
    await page.waitForSelector(sel('editor-container'), { timeout: t });
    await page.waitForSelector('#user-code-editor', { timeout: t });
    console.error(`  ${ts()} MudBlazor: REPL loaded`);

    // ── Step 2: Run the default code ────────────────────────────────────
    await page.click(sel('run-button'));
    // Wait for compilation overlay to appear and then disappear
    try {
        await page.waitForSelector(sel('loading-overlay') + '.mud-overlay-visible',
            { state: 'visible', timeout: 5000 });
    } catch { /* overlay may appear and disappear too fast */ }
    // Wait for loading overlay to vanish (compilation done)
    await page.waitForFunction(
        () => {
            const overlay = document.querySelector('[data-testid="loading-overlay"]');
            return !overlay || !overlay.classList.contains('mud-overlay-visible');
        },
        null, { timeout: t }
    );
    console.error(`  ${ts()} MudBlazor: default code compiled`);

    // Verify no errors
    const errorsAfterDefault = await page.textContent(sel('errors-count'));
    console.error(`  ${ts()} MudBlazor: errors after default compile: ${errorsAfterDefault}`);

    // Check output iframe loaded (switch to iframe context and back)
    const outputFrame = page.frameLocator(sel('output-iframe'));
    try {
        await outputFrame.locator('body').waitFor({ timeout: 10000 });
        console.error(`  ${ts()} MudBlazor: output iframe content loaded`);
    } catch {
        console.error(`  ${ts()} MudBlazor: output iframe content not detected (non-fatal)`);
    }

    // ── Step 3: Toggle dark mode ────────────────────────────────────────
    await page.click(sel('theme-toggle-button'));
    await sleep(500);
    console.error(`  ${ts()} MudBlazor: dark mode toggled on`);
    await page.click(sel('theme-toggle-button'));
    await sleep(500);
    console.error(`  ${ts()} MudBlazor: dark mode toggled off`);

    // ── Step 4: Add a new .razor tab ────────────────────────────────────
    await page.click(sel('add-tab-button'));
    await page.waitForSelector(sel('new-tab-input'), { state: 'visible', timeout: t });
    await page.fill(sel('new-tab-input'), 'MyComponent.razor');
    await page.press(sel('new-tab-input'), 'Enter');
    await page.waitForSelector(sel('tab-MyComponent.razor'), { timeout: t });
    console.error(`  ${ts()} MudBlazor: .razor tab created`);

    // ── Step 5: Switch between tabs ─────────────────────────────────────
    await page.click(sel('tab-__Main.razor'));
    await sleep(300);
    await page.click(sel('tab-MyComponent.razor'));
    await sleep(300);
    console.error(`  ${ts()} MudBlazor: tabs switched`);

    // ── Step 6: Close the .razor tab ────────────────────────────────────
    await page.click(sel('close-tab-MyComponent.razor'));
    await page.waitForSelector(sel('tab-MyComponent.razor'), { state: 'hidden', timeout: t });
    console.error(`  ${ts()} MudBlazor: .razor tab closed`);

    // ── Step 7: Add a .cs tab ───────────────────────────────────────────
    await page.click(sel('add-tab-button'));
    await page.waitForSelector(sel('new-tab-input'), { state: 'visible', timeout: t });
    await page.fill(sel('new-tab-input'), 'MyService.cs');
    await page.press(sel('new-tab-input'), 'Enter');
    await page.waitForSelector(sel('tab-MyService.cs'), { timeout: t });
    console.error(`  ${ts()} MudBlazor: .cs tab created`);

    // ── Step 8: Type code with errors and run ───────────────────────────
    await page.click(sel('tab-__Main.razor'));
    await sleep(300);

    // Focus Monaco editor and replace content with invalid code
    await page.click('#user-code-editor');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('<MudButton OnClick="@(() => { UnknownMethod(); })">Click</MudButton>', { delay: 0 });

    await page.click(sel('run-button'));
    await page.waitForFunction(
        () => {
            const overlay = document.querySelector('[data-testid="loading-overlay"]');
            return !overlay || !overlay.classList.contains('mud-overlay-visible');
        },
        null, { timeout: t }
    );
    console.error(`  ${ts()} MudBlazor: error code compiled`);

    // Open diagnostics panel
    await page.click(sel('diagnostics-toggle'));
    await sleep(500);

    // Check if diagnostics panel appeared (errors expected)
    const errorsAfterBad = await page.textContent(sel('errors-count'));
    console.error(`  ${ts()} MudBlazor: errors after bad code: ${errorsAfterBad}`);

    // ── Step 9: Collapse diagnostics ────────────────────────────────────
    try {
        const collapseBtn = page.locator(sel('collapse-diagnostics'));
        if (await collapseBtn.isVisible({ timeout: 2000 })) {
            await collapseBtn.click();
            console.error(`  ${ts()} MudBlazor: diagnostics collapsed`);
        }
    } catch {
        console.error(`  ${ts()} MudBlazor: diagnostics collapse skipped (panel not visible)`);
    }

    // ── Step 10: Restore valid code and run ─────────────────────────────
    await page.click('#user-code-editor');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('<MudText Typo="Typo.h3">Hello from smoke test</MudText>', { delay: 0 });

    await page.click(sel('run-button'));
    await page.waitForFunction(
        () => {
            const overlay = document.querySelector('[data-testid="loading-overlay"]');
            return !overlay || !overlay.classList.contains('mud-overlay-visible');
        },
        null, { timeout: t }
    );
    console.error(`  ${ts()} MudBlazor: valid code compiled`);

    const errorsAfterGood = await page.textContent(sel('errors-count'));
    console.error(`  ${ts()} MudBlazor: errors after valid code: ${errorsAfterGood}`);

    // Check output iframe for rendered text
    try {
        const outputFrame2 = page.frameLocator(sel('output-iframe'));
        await outputFrame2.locator('text=Hello from smoke test').waitFor({ timeout: 15000 });
        console.error(`  ${ts()} MudBlazor: output verified in iframe`);
    } catch {
        console.error(`  ${ts()} MudBlazor: output text not found in iframe (non-fatal)`);
    }

    // ── Step 11: Open save popup and close it ───────────────────────────
    await page.click(sel('save-button'));
    await sleep(500);
    // Close by clicking the overlay
    try {
        const overlay = page.locator(sel('save-popup-overlay'));
        if (await overlay.isVisible({ timeout: 2000 })) {
            await overlay.click({ force: true });
            await sleep(500);
            console.error(`  ${ts()} MudBlazor: save popup opened and closed`);
        }
    } catch {
        console.error(`  ${ts()} MudBlazor: save popup interaction skipped (non-fatal)`);
    }

    // ── Step 12: Close the .cs tab ──────────────────────────────────────
    await page.click(sel('close-tab-MyService.cs'));
    await page.waitForSelector(sel('tab-MyService.cs'), { state: 'hidden', timeout: t });
    console.error(`  ${ts()} MudBlazor: .cs tab closed`);

    // ── Step 13: Navigate back to Index ─────────────────────────────────
    await page.goto(baseUrl, { timeout: t, waitUntil: 'load' });
    await page.waitForFunction(
        () => globalThis.dotnet_managed_ready !== undefined,
        null, { timeout: t }
    );
    await page.waitForSelector(sel('index-app-bar'), { timeout: t });
    console.error(`  ${ts()} MudBlazor: back to Index`);

    // ── Step 14: Navigate via "Get started" ─────────────────────────────
    await page.click(sel('get-started-button'));
    await page.waitForSelector(sel('editor-container'), { timeout: t });
    console.error(`  ${ts()} MudBlazor: REPL loaded via Get started`);

    const endTime = await page.evaluate(() => performance.now());
    return endTime - startTime;
}
