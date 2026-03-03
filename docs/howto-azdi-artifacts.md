# How to find the latest Mono linux-x64 runtime pack from the dotnet/runtime CI

## Feed

Internal CI builds publish NuGet packages to Azure Artifacts transport feeds.
For the `main` branch (currently .NET 11), the feed is:

```
https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11-transport/nuget/v3/index.json
```

For .NET 10 (`release/10.0` branches), use `dotnet10-transport` instead.
These feeds are public (no auth required).

## Steps

### 1. Get the NuGet v3 service index

```
GET https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11-transport/nuget/v3/index.json
```

From the response, find the resource with `@type` = `PackageBaseAddress/3.0.0`.
This gives you the flat container base URL, e.g.:

```
https://pkgs.dev.azure.com/dnceng/9ee6d478-d288-47f7-aacc-f6e6d082ae6d/_packaging/a57d0dd1-b586-4233-8880-21626fab1f1a/nuget/v3/flat2/
```

### 2. List all versions of the package

Append `{package-id-lowercase}/index.json` to the flat container URL:

```
GET {flatBaseUrl}/microsoft.netcore.app.runtime.mono.linux-x64/index.json
```

The response contains a `versions` array with all published versions, sorted ascending.

### 3. Pick the latest version

Filter for the major version matching `main` (e.g. `11.*`) and take the last entry.

Version format: `{major}.{minor}.{patch}-{prerelease}.{SHORT_DATE}.{revision}`

To decode the date from `SHORT_DATE`:
- `YY = SHORT_DATE / 1000`
- `MM = (SHORT_DATE % 1000) / 50`
- `DD = (SHORT_DATE % 1000) % 50`

Example: `11.0.0-alpha.1.25613.101` → SHORT_DATE=25613 → YY=25, MM=12, DD=13 → 2025-12-13

### 4. Construct the download URL

```
{flatBaseUrl}/{package-id-lowercase}/{version}/{package-id-lowercase}.{version}.nupkg
```

Example:

```
https://pkgs.dev.azure.com/dnceng/9ee6d478-d288-47f7-aacc-f6e6d082ae6d/_packaging/a57d0dd1-b586-4233-8880-21626fab1f1a/nuget/v3/flat2/microsoft.netcore.app.runtime.mono.linux-x64/11.0.0-alpha.1.25613.101/microsoft.netcore.app.runtime.mono.linux-x64.11.0.0-alpha.1.25613.101.nupkg
```

### 5. Extract the binaries

The `.nupkg` is a zip file. Mono runtime binaries are under `runtimes/linux-x64/` inside the archive.

## PowerShell one-liner

```powershell
$feedIndex = Invoke-RestMethod "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet11-transport/nuget/v3/index.json"
$flatBase = ($feedIndex.resources | Where-Object { $_.'@type' -eq 'PackageBaseAddress/3.0.0' }).'@id'
$pkgId = "microsoft.netcore.app.runtime.mono.linux-x64"
$versions = (Invoke-RestMethod "$flatBase$pkgId/index.json").versions
$latest = ($versions | Where-Object { $_ -like '11.*' })[-1]
$url = "$flatBase$pkgId/$latest/$pkgId.$latest.nupkg"
Write-Host $url
```

## Other useful packages

| Package | Contents |
|---------|----------|
| `Microsoft.NETCore.App.Runtime.Mono.linux-x64` | Mono runtime for linux-x64 |
| `Microsoft.NETCore.App.Runtime.Mono.browser-wasm` | Mono runtime for browser/WASM |
| `Microsoft.NETCore.App.Runtime.Mono.wasi-wasm` | Mono runtime for WASI |
| `Microsoft.NETCore.App.Host.linux-x64` | AppHost for linux-x64 |
| `Microsoft.NETCore.App.Ref` | Reference assemblies (RID-less) |
