<#
.SYNOPSIS
    Simulate CI benchmark pipeline locally using Docker.

.DESCRIPTION
    Thin wrapper around run-bench.mjs --mode docker.
    Checks prerequisites (Node.js, Docker, npm) then delegates to JS orchestrator.

.EXAMPLE
    ./local-docker-bench.ps1                                # Run all steps
    ./local-docker-bench.ps1 --skip-docker                  # Skip Docker image build
    ./local-docker-bench.ps1 --skip-build                   # Skip app build
    ./local-docker-bench.ps1 --skip-docker --skip-build     # Measure only
    ./local-docker-bench.ps1 --step docker-build            # Run only one step
    ./local-docker-bench.ps1 --dry-run                      # Chrome only
    ./local-docker-bench.ps1 --app try-mud-blazor           # Single app
    ./local-docker-bench.ps1 --engine chrome                # Specific engine
    ./local-docker-bench.ps1 --preset devloop,aot             # Specific presets
    ./local-docker-bench.ps1 --sdk-version 11.0.100-preview.3.26062.1

    All flags are forwarded to: node scripts/run-bench.mjs --mode docker ...
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

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        Err 'WSL not found. Install WSL with Docker to use Docker mode on Windows.'
        exit 1
    }
    $wslDocker = wsl docker --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Err 'Docker not found inside WSL. Install Docker in your WSL distribution.'
        exit 1
    }
    Info "WSL Docker: $wslDocker"
} elseif (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Err 'Docker not found. Install Docker to use Docker mode.'
    exit 1
}

if (-not (Test-Path (Join-Path $RepoDir 'node_modules'))) {
    Info 'node_modules not found — running npm ci...'
    Push-Location $RepoDir
    npm ci
    Pop-Location
}

# ── Delegate to JS orchestrator ──────────────────────────────────────────────

& node (Join-Path $ScriptDir 'run-bench.mjs') --mode docker @args
exit $LASTEXITCODE
