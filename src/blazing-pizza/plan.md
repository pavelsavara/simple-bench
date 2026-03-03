# Plan: Convert Blazing Pizza to Standalone WASM App

## Goal

Collapse the 4-project hybrid Blazor Web app (server + client + shared + components library) into a **single standalone Blazor WebAssembly project** with no server dependency. All data lives in-memory, auth is faked (always authenticated), and push notification subscription is faked locally.

## Decisions

| Concern | Decision |
|---------|----------|
| Auth | Fake — always authenticated as hardcoded user, no Identity, no login pages |
| Data | In-memory only — seeded on startup, orders lost on refresh |
| Order status | Keep as-is (client-side timestamp simulation) |
| Push notifications | Keep `SubscribeToNotifications` in `IRepository` but fake it (no-op), keep JS call |
| Project structure | Collapse into single `BlazingPizza.Client` project (SDK: `BlazorWebAssembly`) |
| Benchmark presets | Preserve — `Directory.Build.props`, `presets.props`, `versions.props` unchanged |

## Architecture: Before → After

```
BEFORE (4 projects, server-hosted):
  BlazingPizza           (Web host, SSR, API, EF Core, Identity)
  BlazingPizza.Client    (WASM interactive components)
  BlazingPizza.Shared    (Models, IRepository)
  BlazingPizza.ComponentsLibrary (Razor class library: Map, TemplatedDialog, etc.)

AFTER (1 project, standalone WASM):
  BlazingPizza.Client    (standalone WASM app, all code merged in)
```

## Step-by-step Plan

### Phase 1: Create `InMemoryRepository` (replaces both `EfRepository` and `HttpRepository`)

Create `InMemoryRepository.cs` in `BlazingPizza.Client` implementing `IRepository`:
- Constructor seeds specials & toppings from `SeedData` (adapted to work without DbContext)
- `GetSpecials()` / `GetToppings()` → return seeded lists
- `PlaceOrder(order)` → assign auto-increment `OrderId`, set `CreatedTime`, `DeliveryLocation`, `UserId`, store in `List<Order>`, return ID
- `GetOrdersAsync(userId)` / `GetOrdersAsync()` → filter/return from in-memory list, map via `OrderWithStatus.FromOrder()`
- `GetOrderWithStatus(orderId)` / `GetOrderWithStatus(orderId, userId)` → lookup + `OrderWithStatus.FromOrder()`
- `SubscribeToNotifications()` → no-op (just return completed task)

### Phase 2: Create `FakeAuthenticationStateProvider`

Create `FakeAuthenticationStateProvider.cs` in `BlazingPizza.Client`:
- Returns a hardcoded authenticated `ClaimsPrincipal` with:
  - `ClaimTypes.NameIdentifier` = `"fake-user-id"`
  - `ClaimTypes.Name` = `"demo@blazingpizza.com"`
  - `ClaimTypes.Email` = `"demo@blazingpizza.com"`
  - `authenticationType` = `"FakeAuth"`
- Always authenticated, no PersistentComponentState dependency

### Phase 3: Merge models into `BlazingPizza.Client`

Move from `BlazingPizza.Shared` into `BlazingPizza.Client`:
- `IRepository.cs`
- `Order.cs` (includes `OrderContext` source generator)
- `OrderWithStatus.cs`
- `Pizza.cs` (includes `PizzaContext` source generator)
- `PizzaSpecial.cs`
- `PizzaTopping.cs`
- `Topping.cs`
- `Address.cs`
- `LatLong.cs`
- `NotificationSubscription.cs`
- `UserInfo.cs` (already in Client but also in Shared namespace — keep Client version)

### Phase 4: Merge ComponentsLibrary into `BlazingPizza.Client`

Move from `BlazingPizza.ComponentsLibrary` into `BlazingPizza.Client`:
- `Map/Map.razor` + `Map/Marker.cs` + `Map/Point.cs` → `Components/Map/`
- `TemplatedDialog.razor` → `Components/`
- `TemplatedList.razor` → `Components/`
- `LocalStorage.cs` → root
- `wwwroot/` contents (JS files, leaflet/) → merge into Client `wwwroot/`

### Phase 5: Move server-only pages to Client (as WASM interactive)

Move from `BlazingPizza/Components/Pages/` into `BlazingPizza.Client/Components/Pages/`:
- `MyOrders.razor` — remove `HttpContext` cascading parameter, use `AuthenticationState` cascading parameter instead to get userId (or just hardcode since auth is fake)
- `OrderDetails.razor` — change from `@rendermode InteractiveServer` to no explicit rendermode (standalone WASM is always interactive). Remove server-specific auth state fetching.
- `Error.razor` — move as-is

### Phase 6: Update `LoginDisplay.razor`

Move to Client. Simplify to always show the fake user. Remove logout form, register/login links.

### Phase 7: Update layouts and routing

Move from server project to Client:
- `Layout/MainLayout.razor` + `MainLayout.razor.css`
- Merge `_Imports.razor` (combine both server and client imports)

Update `Routes.razor`:
- Remove `AuthorizeRouteView` wrapping (or keep it — since fake auth always passes, it still works)
- Remove `@using BlazingPizza.Components.Account.Shared` and `<RedirectToLogin />`
- Remove additional assemblies (single project now)

### Phase 8: Update `App.razor` → `index.html`

The standalone WASM app uses `wwwroot/index.html` (already exists in server's wwwroot).
- Update to reference `blazor.webassembly.js` instead of `blazor.web.js`
- Remove service worker registration (optional — can keep for PWA)
- Keep leaflet, localStorage, pushNotifications, deliveryMap script references
- Merge static assets: `css/`, `img/`, `manifest.json`, `service-worker.js` from server wwwroot

### Phase 9: Update `Program.cs`

Rewrite `BlazingPizza.Client/Program.cs`:
```csharp
var builder = WebAssemblyHostBuilder.CreateDefault(args);

// Services
builder.Services.AddScoped<IRepository, InMemoryRepository>();
builder.Services.AddScoped<OrderState>();

// Fake auth
builder.Services.AddAuthorizationCore();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddSingleton<AuthenticationStateProvider, FakeAuthenticationStateProvider>();

await builder.Build().RunAsync();
```

Remove `HttpClient` registration (no server to call).

### Phase 10: Update `BlazingPizza.Client.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>$(DefaultTargetFramework)</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <NoDefaultLaunchSettingsFile>true</NoDefaultLaunchSettingsFile>
    <StaticWebAssetProjectMode>Default</StaticWebAssetProjectMode>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="$(MicrosoftAspNetCoreVersion)" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.Authentication" Version="$(MicrosoftAspNetCoreVersion)" />
  </ItemGroup>
</Project>
```

Remove project references to `ComponentsLibrary` and `Shared` (code merged in).
Keep `Authentication` package (used by `Checkout.razor` for `AccessTokenNotAvailableException`).

### Phase 11: Update solution file

Remove projects:
- `BlazingPizza` (server)
- `BlazingPizza.Shared`
- `BlazingPizza.ComponentsLibrary`

Keep only `BlazingPizza.Client`.

### Phase 12: Clean up removed references

- Remove `HttpRepository.cs` (replaced by `InMemoryRepository`)
- Remove `PersistentAuthenticationStateProvider.cs` (replaced by `FakeAuthenticationStateProvider`)
- Remove `@rendermode InteractiveWebAssembly` from pages (standalone WASM is always interactive)
- Remove `@rendermode InteractiveServer` from `OrderDetails.razor`
- Clean up `_Imports.razor`: remove `@using static Microsoft.AspNetCore.Components.Web.RenderMode`
- Fix `Checkout.razor`: remove `AccessTokenNotAvailableException` try/catch (no remote auth)

### Phase 13: Verify build

```
dotnet build BlazingPizza.Client
dotnet publish BlazingPizza.Client
```

## Files Created (new)

| File | Purpose |
|------|---------|
| `BlazingPizza.Client/InMemoryRepository.cs` | Implements `IRepository` with in-memory lists, seed data |
| `BlazingPizza.Client/FakeAuthenticationStateProvider.cs` | Always-authenticated auth state |

## Files Moved (from other projects → Client)

| Source | Destination |
|--------|-------------|
| `Shared/*.cs` (all models + IRepository) | `BlazingPizza.Client/` (same namespace `BlazingPizza.Shared`) |
| `ComponentsLibrary/Map/*` | `BlazingPizza.Client/Components/Map/` |
| `ComponentsLibrary/TemplatedDialog.razor` | `BlazingPizza.Client/Components/` |
| `ComponentsLibrary/TemplatedList.razor` | `BlazingPizza.Client/Components/` |
| `ComponentsLibrary/LocalStorage.cs` | `BlazingPizza.Client/` |
| `ComponentsLibrary/_Imports.razor` | Merge into `BlazingPizza.Client/_Imports.razor` |
| `ComponentsLibrary/wwwroot/*` | `BlazingPizza.Client/wwwroot/` |
| `Server/Components/Pages/MyOrders.razor` | `BlazingPizza.Client/Components/Pages/` |
| `Server/Components/Pages/OrderDetails.razor` | `BlazingPizza.Client/Components/Pages/` |
| `Server/Components/Pages/Error.razor` | `BlazingPizza.Client/Components/Pages/` |
| `Server/Components/LoginDisplay.razor` | `BlazingPizza.Client/Components/` |
| `Server/Components/Layout/*` | `BlazingPizza.Client/Layout/` |
| `Server/wwwroot/*` (css, img, manifest, etc.) | `BlazingPizza.Client/wwwroot/` |

## Files Deleted (server-only, no longer needed)

| File/Dir | Reason |
|----------|--------|
| `BlazingPizza/` (entire server project) | No server |
| `BlazingPizza.Shared/` (entire project) | Merged into Client |
| `BlazingPizza.ComponentsLibrary/` (entire project) | Merged into Client |
| `BlazingPizza.Client/HttpRepository.cs` | Replaced by InMemoryRepository |
| `BlazingPizza.Client/PersistentAuthenticationStateProvider.cs` | Replaced by FakeAuthenticationStateProvider |

## Namespace Strategy

- Keep `namespace BlazingPizza.Shared` for model classes (avoid mass-renaming references)
- Keep `namespace BlazingPizza.ComponentsLibrary` / `BlazingPizza.ComponentsLibrary.Map` for moved components
- Keep `namespace BlazingPizza.Client` for client code
- Add necessary `@using` directives to `_Imports.razor`

## Risk / Gotchas

1. **`OrderWithStatus` uses `DateTime.Now`** — works fine in WASM (browser clock). No issue.
2. **`AccessTokenNotAvailableException`** in `Checkout.razor` — remove the try/catch, auth is fake.
3. **`_content/BlazingPizza.ComponentsLibrary/...`** paths in JS/CSS references — after merging wwwroot, these become direct paths (e.g., `leaflet/leaflet.js`). Must update `index.html`.
4. **`BlazingPizza.styles.css`** — component-scoped CSS bundle name changes. Ensure the link in `index.html` references the correct bundle name.
5. **`MyOrders.razor` uses `HttpContext`** — not available in WASM. Must switch to `AuthenticationState` cascading parameter or hardcoded user ID.
6. **Service worker** — `service-worker.js` references may need updating for the new file structure.
