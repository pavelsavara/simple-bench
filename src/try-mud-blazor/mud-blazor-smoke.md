# TryMudBlazor — Smoke Test Walkthrough

Playwright smoke test sequence that visits every page and exercises all major interactive elements.
Uses `data-testid` selectors added to the source code.

## Selector Reference

| Element | Selector | Page/Component |
|---|---|---|
| **Index page** | | |
| App bar | `[data-testid="index-app-bar"]` | Index |
| Brand text | `[data-testid="index-brand"]` | Index |
| MudBlazor link | `[data-testid="index-mudblazor-link"]` | Index |
| Source Code link | `[data-testid="index-source-link"]` | Index |
| Play now button | `[data-testid="play-now-button"]` | Index |
| Get started button | `[data-testid="get-started-button"]` | Index |
| Footer | `[data-testid="index-footer"]` | Index |
| **Repl page — sidebar** | | |
| Sidebar drawer | `[data-testid="repl-drawer"]` | Repl |
| Run button | `[data-testid="run-button"]` | Repl |
| Save button | `[data-testid="save-button"]` | Repl |
| Theme toggle button | `[data-testid="theme-toggle-button"]` | Repl |
| Clear cache button | `[data-testid="clear-cache-button"]` | Repl |
| Brand text | `[data-testid="repl-brand"]` | Repl |
| **Repl page — editor area** | | |
| Editor container | `[data-testid="editor-container"]` | Repl |
| Monaco editor | `#user-code-editor` | CodeEditor |
| Loading overlay | `[data-testid="loading-overlay"]` | Repl |
| **Repl page — output area** | | |
| Output container | `[data-testid="output-container"]` | Repl |
| Output iframe | `[data-testid="output-iframe"]` | Repl |
| **Repl page — bottom bar** | | |
| Bottom bar | `[data-testid="bottom-bar"]` | Repl |
| Diagnostics toggle | `[data-testid="diagnostics-toggle"]` | Repl |
| Errors count | `[data-testid="errors-count"]` | Repl |
| Warnings count | `[data-testid="warnings-count"]` | Repl |
| **Tab manager** | | |
| Tab manager wrapper | `[data-testid="tab-manager"]` | TabManager |
| Tab item | `[data-testid="tab-{filename}"]` | TabManager (e.g. `tab-__Main.razor`) |
| Close tab button | `[data-testid="close-tab-{filename}"]` | TabManager |
| Add tab button | `[data-testid="add-tab-button"]` | TabManager |
| New tab input | `[data-testid="new-tab-input"]` | TabManager |
| **Error list** | | |
| Diagnostics panel | `[data-testid="diagnostics-panel"]` | ErrorList |
| Collapse diagnostics | `[data-testid="collapse-diagnostics"]` | ErrorList |
| **Save snippet popup** | | |
| Save popup | `[data-testid="save-popup"]` | SaveSnippetPopup |
| Create link button | `[data-testid="create-link-button"]` | SaveSnippetPopup |
| Snippet link field | `[data-testid="snippet-link-field"]` | SaveSnippetPopup |
| Copy link button | `[data-testid="copy-link-button"]` | SaveSnippetPopup |
| Save popup overlay | `[data-testid="save-popup-overlay"]` | SaveSnippetPopup |
| Save progress bar | `[data-testid="save-progress"]` | SaveSnippetPopup |
| **User page (iframe)** | | |
| User page container | `[data-testid="user-page-container"]` | UserPage |
| User page alert | `[data-testid="user-page-alert"]` | UserPage |

## Test Sequence

### Step 0 — Index page loads

- Navigate to base URL `/`
- **Wait** for `[data-testid="index-app-bar"]` to be visible
- **Assert** `[data-testid="index-brand"]` contains text `TryMudBlazor`
- **Assert** `[data-testid="play-now-button"]` is visible with text `Play now`
- **Assert** `[data-testid="get-started-button"]` is visible with text `Get started`
- **Assert** `[data-testid="index-mudblazor-link"]` is visible
- **Assert** `[data-testid="index-source-link"]` is visible
- **Assert** `[data-testid="index-footer"]` is visible

### Step 1 — Navigate to Repl via "Play now"

- **Click** `[data-testid="play-now-button"]`
- **Wait** for `[data-testid="editor-container"]` to be visible
- **Assert** URL matches `/snippet`
- **Assert** `[data-testid="repl-drawer"]` is visible
- **Assert** `[data-testid="run-button"]` is visible
- **Assert** `[data-testid="save-button"]` is visible
- **Assert** `[data-testid="theme-toggle-button"]` is visible
- **Assert** `[data-testid="clear-cache-button"]` is visible
- **Assert** `[data-testid="repl-brand"]` contains text `Try MudBlazor`
- **Assert** `[data-testid="bottom-bar"]` is visible
- **Assert** `[data-testid="errors-count"]` has text `0`
- **Assert** `[data-testid="warnings-count"]` has text `0`
- **Assert** `[data-testid="tab-manager"]` is visible
- **Assert** `[data-testid="tab-__Main.razor"]` is visible and has active class
- **Assert** `#user-code-editor` is visible (Monaco editor loaded)
- **Assert** `[data-testid="output-iframe"]` is visible (iframe rendered)

### Step 2 — Run the default code

- **Click** `[data-testid="run-button"]`
- **Wait** for `[data-testid="loading-overlay"]` to become visible (compilation starts)
- **Wait** for `[data-testid="loading-overlay"]` to become hidden (compilation finishes; timeout ~30s)
- **Assert** `[data-testid="errors-count"]` has text `0`
- **Assert** `[data-testid="warnings-count"]` has text `0`
- Switch to `[data-testid="output-iframe"]` frame context
- **Wait** for rendered content to appear (e.g. any MudBlazor element)
- Switch back to main frame

### Step 3 — Toggle dark mode

- **Assert** current theme class (check `MudThemeProvider` dark state or CSS variable)
- **Click** `[data-testid="theme-toggle-button"]`
- **Wait** briefly for theme transition
- **Assert** theme has changed (dark mode toggled)
- **Click** `[data-testid="theme-toggle-button"]` (toggle back)
- **Wait** briefly for theme transition

### Step 4 — Add a new file tab

- **Click** `[data-testid="add-tab-button"]`
- **Wait** for `[data-testid="new-tab-input"]` to be visible and focused
- **Fill** `[data-testid="new-tab-input"]` with `MyComponent.razor`
- **Press** Enter
- **Assert** `[data-testid="tab-MyComponent.razor"]` is visible
- **Assert** `[data-testid="tab-MyComponent.razor"]` has active class (newly created tab activated)
- **Assert** `[data-testid="close-tab-MyComponent.razor"]` is visible (close button present; non-default tab)

### Step 5 — Switch between tabs

- **Click** `[data-testid="tab-__Main.razor"]`
- **Assert** `[data-testid="tab-__Main.razor"]` has active class
- **Assert** `[data-testid="tab-MyComponent.razor"]` does NOT have active class
- **Click** `[data-testid="tab-MyComponent.razor"]`
- **Assert** `[data-testid="tab-MyComponent.razor"]` has active class

### Step 6 — Close the new file tab

- **Click** `[data-testid="close-tab-MyComponent.razor"]`
- **Assert** `[data-testid="tab-MyComponent.razor"]` is NOT visible (tab removed)
- **Assert** `[data-testid="tab-__Main.razor"]` has active class (falls back to default)

### Step 7 — Add a C# file tab

- **Click** `[data-testid="add-tab-button"]`
- **Wait** for `[data-testid="new-tab-input"]` to be visible
- **Fill** `[data-testid="new-tab-input"]` with `MyService.cs`
- **Press** Enter
- **Assert** `[data-testid="tab-MyService.cs"]` is visible
- **Assert** `[data-testid="tab-MyService.cs"]` has active class

### Step 8 — Type code with errors and run

- **Click** `[data-testid="tab-__Main.razor"]` (switch to main file)
- **Clear** Monaco editor content via keyboard (Ctrl+A, then type)
- **Type** invalid code into Monaco: `<MudButton OnClick="@(() => { UnknownMethod(); })">Click</MudButton>`
- **Click** `[data-testid="run-button"]`
- **Wait** for `[data-testid="loading-overlay"]` to become hidden (compilation finishes)
- **Assert** `[data-testid="errors-count"]` text is NOT `0` (compilation errors)
- **Click** `[data-testid="diagnostics-toggle"]`
- **Wait** for `[data-testid="diagnostics-panel"]` to be visible
- **Assert** `[data-testid="diagnostics-panel"]` contains at least one `<tr>` in `<tbody>`

### Step 9 — Collapse diagnostics

- **Click** `[data-testid="collapse-diagnostics"]`
- **Assert** `[data-testid="diagnostics-panel"]` is NOT visible

### Step 10 — Restore valid code and run

- **Click** `[data-testid="tab-__Main.razor"]`
- **Clear** Monaco editor content (Ctrl+A, then type)
- **Type** valid code: `<MudText Typo="Typo.h3">Hello from smoke test</MudText>`
- **Click** `[data-testid="run-button"]`
- **Wait** for `[data-testid="loading-overlay"]` to become hidden
- **Assert** `[data-testid="errors-count"]` has text `0`
- Switch to `[data-testid="output-iframe"]` frame context
- **Wait** for text `Hello from smoke test` to appear
- Switch back to main frame

### Step 11 — Open save popup and close it

- **Click** `[data-testid="save-button"]`
- **Wait** for `[data-testid="save-popup"]` to be visible
- **Assert** `[data-testid="create-link-button"]` is visible with text `Create shareable link`
- **Click** `[data-testid="save-popup-overlay"]` (close by clicking overlay)
- **Wait** for `[data-testid="save-popup"]` to be hidden

### Step 12 — Close the C# tab added earlier

- **Click** `[data-testid="close-tab-MyService.cs"]`
- **Assert** `[data-testid="tab-MyService.cs"]` is NOT visible
- **Assert** `[data-testid="tab-__Main.razor"]` has active class

### Step 13 — Navigate back to Index via browser

- Navigate to base URL `/`
- **Wait** for `[data-testid="index-app-bar"]` to be visible
- **Assert** `[data-testid="play-now-button"]` is visible

### Step 14 — Navigate to Repl via "Get started"

- **Click** `[data-testid="get-started-button"]`
- **Wait** for `[data-testid="editor-container"]` to be visible
- **Assert** URL matches `/snippet`

## Coverage Summary

| Area | Covered |
|---|---|
| Index page — landing renders | Yes (Step 0) |
| Index page — "Play now" navigation | Yes (Step 1) |
| Index page — "Get started" navigation | Yes (Step 14) |
| Index page — app bar & footer visible | Yes (Step 0) |
| Repl page — sidebar buttons visible | Yes (Step 1) |
| Repl page — Run (compile) default code | Yes (Step 2) |
| Repl page — output iframe shows result | Yes (Steps 2, 10) |
| Repl page — dark mode toggle | Yes (Step 3) |
| Repl page — loading overlay | Yes (Steps 2, 8, 10) |
| Tab manager — default tab active | Yes (Step 1) |
| Tab manager — create .razor tab | Yes (Step 4) |
| Tab manager — create .cs tab | Yes (Step 7) |
| Tab manager — switch tabs | Yes (Step 5) |
| Tab manager — close tab | Yes (Steps 6, 12) |
| Code editor — type code | Yes (Steps 8, 10) |
| Compilation — successful | Yes (Steps 2, 10) |
| Compilation — errors detected | Yes (Step 8) |
| Diagnostics panel — open | Yes (Step 8) |
| Diagnostics panel — collapse | Yes (Step 9) |
| Error/warning counts — display | Yes (Steps 1, 8, 10) |
| Save popup — open | Yes (Step 11) |
| Save popup — close via overlay | Yes (Step 11) |
| Bottom bar — visible | Yes (Step 1) |
| Navigation — Index → Repl | Yes (Steps 1, 14) |
| Navigation — Repl → Index | Yes (Step 13) |
