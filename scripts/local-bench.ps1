<#
.SYNOPSIS
    Run the benchmark pipeline locally (no Docker).

.DESCRIPTION
    Thin wrapper around run-bench.mjs --mode local.
    Checks prerequisites (Node.js, npm, .NET SDK) then delegates to JS orchestrator.

.EXAMPLE
    ./local-bench.ps1                                # Run all steps
    ./local-bench.ps1 --skip-build                   # Measure only
    ./local-bench.ps1 --app try-mud-blazor           # Single app
    ./local-bench.ps1 --engine chrome,firefox         # Specific engines
    ./local-bench.ps1 --dry-run                      # Chrome only (fast)
    ./local-bench.ps1 --preset devloop,aot           # Specific presets
    ./local-bench.ps1 --sdk-version 11.0.100-preview.3.26062.1

    All flags are forwarded to: node scripts/run-bench.mjs --mode local ...
#>

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoDir = (Resolve-Path (Join-Path $ScriptDir '..')).Path

# ── Helpers ──────────────────────────────────────────────────────────────────

function Info([string]$Text) { Write-Host "▶ $Text" -ForegroundColor Green }
function Err([string]$Text) { Write-Host "✗ $Text" -ForegroundColor Red }

# ── Prerequisites ────────────────────────────────────────────────────────────

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Err 'Node.js not found. Install Node.js >= 24.'
    exit 1
}
Info "Node.js $(node -v)"

if (-not (Test-Path (Join-Path $RepoDir 'node_modules'))) {
    Info 'node_modules not found — running npm ci...'
    Push-Location $RepoDir
    npm ci
    Pop-Location
}

# Install Playwright browsers if needed
$PwCache = if ($env:PLAYWRIGHT_BROWSERS_PATH) { $env:PLAYWRIGHT_BROWSERS_PATH }
           elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'ms-playwright' }
           else { Join-Path $HOME '.cache/ms-playwright' }
if (-not (Test-Path (Join-Path $PwCache 'chromium_headless_shell-*'))) {
    Info 'Playwright browsers not found — installing...'
    Push-Location $RepoDir
    node node_modules/playwright/cli.js install chromium firefox
    Pop-Location
}

# ── Delegate to JS orchestrator ──────────────────────────────────────────────

& node (Join-Path $ScriptDir 'run-bench.mjs') --mode local @args
exit $LASTEXITCODE
