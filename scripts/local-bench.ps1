<#
.SYNOPSIS
    Simulate CI benchmark pipeline locally using Docker.

.DESCRIPTION
    Steps (re-startable — skip with flags):
      1. docker-build   Build both Docker images
      2. build          Build all apps inside the build container
      3. measure        Run measurements inside measure containers (sequentially)

.EXAMPLE
    ./local-bench.ps1                                # Run all steps
    ./local-bench.ps1 -SkipDocker                    # Skip Docker image build
    ./local-bench.ps1 -SkipBuild                     # Skip app build (reuse artifacts/publish)
    ./local-bench.ps1 -SkipDocker -SkipBuild         # Measure only
    ./local-bench.ps1 -Step docker-build             # Run only one step
    ./local-bench.ps1 -Step build
    ./local-bench.ps1 -Step measure
    ./local-bench.ps1 -DryRun                        # Measure chrome only (like PR mode)
    ./local-bench.ps1 -App empty-browser -Preset debug   # Measure one combo
    ./local-bench.ps1 -SdkVersion 11.0.100-preview.3.26062.1
#>
[CmdletBinding()]
param(
    [switch]$SkipDocker,
    [switch]$SkipBuild,
    [switch]$SkipMeasure,

    [ValidateSet('docker-build', 'build', 'measure')]
    [string]$Step,

    [string]$SdkChannel = '11.0',
    [string]$SdkVersion,
    [switch]$DryRun,
    [string]$App,
    [string]$Preset
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoDir = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$ArtifactsDir = Join-Path $RepoDir 'artifacts'

# ── Log file setup ───────────────────────────────────────────────────────────
if (-not (Test-Path $ArtifactsDir)) {
    New-Item -ItemType Directory -Path $ArtifactsDir -Force | Out-Null
}
$LogFile = Join-Path $ArtifactsDir 'local-bench.log'
$LogTimestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content -Path $LogFile -Value "`n=== local-bench.ps1 started at $LogTimestamp ==="

function Write-Log {
    param([string]$Message)
    Add-Content -Path $LogFile -Value $Message
}

# ── Helpers ──────────────────────────────────────────────────────────────────

function Banner([string]$Text) {
    $msg = "`n=== $Text ==="
    Write-Host $msg -ForegroundColor Cyan
    Write-Log $msg
}

function Info([string]$Text) {
    $msg = "▶ $Text"
    Write-Host $msg -ForegroundColor Green
    Write-Log $msg
}

function Err([string]$Text) {
    $msg = "✗ $Text"
    Write-Host $msg -ForegroundColor Red
    Write-Log $msg
}

function Invoke-Docker {
    param([string[]]$Arguments)
    $output = & docker @Arguments 2>&1
    $output | ForEach-Object {
        $line = $_.ToString()
        Write-Host $line
        Write-Log $line
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE"
    }
}

function Invoke-DockerAllowFailure {
    param([string[]]$Arguments)
    $output = & docker @Arguments 2>&1
    $output | ForEach-Object {
        $line = $_.ToString()
        Write-Host $line
        Write-Log $line
    }
    return $LASTEXITCODE
}

# ── Step/skip logic ─────────────────────────────────────────────────────────

if ($Step) {
    $SkipDocker = $true
    $SkipBuild = $true
    $SkipMeasure = $true
    switch ($Step) {
        'docker-build' { $SkipDocker = $false }
        'build'        { $SkipBuild = $false }
        'measure'      { $SkipMeasure = $false }
    }
}

$BuildImage = 'browser-bench-build:latest'
$MeasureImage = 'browser-bench-measure:latest'

# ── Prerequisites ────────────────────────────────────────────────────────────

if (-not (Test-Path (Join-Path $RepoDir 'node_modules'))) {
    Err "node_modules not found. Run 'npm ci' first."
    exit 1
}

# ── Permission / cleanup helpers ─────────────────────────────────────────────

function Fix-Permissions {
    if (Test-Path $ArtifactsDir) {
        $dockerPath = ConvertTo-DockerPath $ArtifactsDir
        & docker run --rm -v "${dockerPath}:/a" $BuildImage chmod -R a+rw /a 2>$null
    }
}

function Clean-Artifacts {
    param([string[]]$Dirs)
    Fix-Permissions
    foreach ($d in $Dirs) {
        $target = Join-Path $ArtifactsDir $d
        if (Test-Path $target) {
            Remove-Item -Recurse -Force $target
        }
    }
}

# Convert Windows path to WSL Docker volume mount format.
# D:\simple-bench → /mnt/d/simple-bench
function ConvertTo-DockerPath([string]$WinPath) {
    $resolved = (Resolve-Path $WinPath -ErrorAction Stop).Path
    if ($resolved -match '^([A-Za-z]):\\(.*)$') {
        $drive = $Matches[1].ToLower()
        $rest = $Matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }
    return $resolved -replace '\\', '/'
}

$DockerRepoDir = ConvertTo-DockerPath $RepoDir

# ── Step 1: Build Docker images ──────────────────────────────────────────────

if (-not $SkipDocker) {
    Banner 'Step 1: Build Docker images'

    Info "Building $BuildImage..."
    Invoke-Docker @('build', '--target', 'browser-bench-build',
        '-t', $BuildImage, '-f', (Join-Path $RepoDir 'docker/Dockerfile'), $RepoDir)

    Info "Building $MeasureImage..."
    Invoke-Docker @('build', '--target', 'browser-bench-measure',
        '-t', $MeasureImage, '-f', (Join-Path $RepoDir 'docker/Dockerfile'), $RepoDir)

    Info 'Docker images ready'
}
else {
    Info 'Skipping Docker image build'
}

# ── Step 2: Build apps ───────────────────────────────────────────────────────

$ManifestFile = Join-Path $ArtifactsDir 'results/build-manifest.json'

if (-not $SkipBuild) {
    Banner 'Step 2: Build all apps'

    Info 'Cleaning artifacts/sdk and artifacts/publish...'
    Clean-Artifacts @('sdk', 'publish')
    if (-not (Test-Path $ArtifactsDir)) {
        New-Item -ItemType Directory -Path $ArtifactsDir -Force | Out-Null
    }

    $sdkVersionArg = ''
    if ($SdkVersion) {
        $sdkVersionArg = "--sdk-version '$SdkVersion'"
    }

    $dryRunBuildFlag = ''
    if ($DryRun) {
        $dryRunBuildFlag = '--dry-run'
    }

    $buildStart = Get-Date

    Info "Running build inside $BuildImage..."
    $bashCmd = "node scripts/run-pipeline.mjs --sdk-channel '$SdkChannel' $sdkVersionArg --runtime mono $dryRunBuildFlag"
    Invoke-Docker @('run', '--rm',
        '-v', "${DockerRepoDir}:/bench",
        '-w', '/bench',
        '-e', 'ARTIFACTS_DIR=/bench/artifacts',
        $BuildImage,
        'bash', '-c', $bashCmd)

    $buildEnd = Get-Date
    Fix-Permissions

    if (-not (Test-Path $ManifestFile)) {
        Err "Build manifest not found at $ManifestFile"
        exit 1
    }

    $buildDuration = [int]($buildEnd - $buildStart).TotalSeconds
    Info "Build completed in ${buildDuration}s"
    Info "Build manifest: $(Get-Content $ManifestFile -Raw)"
    $sdkInfoPath = Join-Path $ArtifactsDir 'sdk/sdk-info.json'
    if (Test-Path $sdkInfoPath) {
        Info "SDK info: $(Get-Content $sdkInfoPath -Raw)"
    }
    else {
        Info 'SDK info: not found'
    }
}
else {
    Info "Skipping build (reusing $ArtifactsDir\publish\)"
    if (-not (Test-Path $ManifestFile)) {
        Err 'No build manifest found. Run the build step first.'
        exit 1
    }
    Info "Reusing manifest: $(Get-Content $ManifestFile -Raw)"
}

# ── Step 3: Measure ──────────────────────────────────────────────────────────

if (-not $SkipMeasure) {
    Banner 'Step 3: Run measurements'

    $matrix = Get-Content $ManifestFile -Raw | ConvertFrom-Json
    $sdkInfoFile = Join-Path $ArtifactsDir 'sdk/sdk-info.json'

    if (-not (Test-Path $sdkInfoFile)) {
        Err "sdk-info.json not found at $sdkInfoFile — run the build step first."
        exit 1
    }

    $resultsDir = Join-Path $ArtifactsDir 'results'
    if (-not (Test-Path $resultsDir)) {
        New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null
    }

    $dryRunFlag = ''
    if ($DryRun) {
        $dryRunFlag = '--dry-run'
    }

    $entryCount = $matrix.Count
    $current = 0
    $failed = 0
    $measureTotalStart = Get-Date

    Info "Measuring $entryCount app/preset combinations..."

    foreach ($entry in $matrix) {
        $appName = $entry.app
        $presetName = $entry.preset

        # Apply filters
        if ($App -and $appName -ne $App) { continue }
        if ($Preset -and $presetName -ne $Preset) { continue }

        $current++
        $publishDir = "/bench/artifacts/publish/$appName/$presetName"

        Info "[$current/$entryCount] Measuring $appName / $presetName..."
        $stepStart = Get-Date

        $bashCmd = @(
            "node scripts/run-measure-job.mjs",
            "--app '$appName'",
            "--preset '$presetName'",
            "--publish-dir '$publishDir'",
            "--sdk-info /bench/artifacts/sdk/sdk-info.json",
            "--build-manifest /bench/artifacts/results/build-manifest.json",
            "--output-dir /bench/artifacts/results",
            "--runtime mono",
            "--retries 3",
            "--timeout 300000",
            $dryRunFlag
        ) -join ' '

        $exitCode = Invoke-DockerAllowFailure @('run', '--rm',
            '--user', '1001',
            '-v', "${DockerRepoDir}:/bench",
            '-w', '/bench',
            '-e', 'ARTIFACTS_DIR=/bench/artifacts',
            $MeasureImage,
            'bash', '-c', $bashCmd)

        if ($exitCode -ne 0) {
            Err "Measurement failed for $appName / $presetName (continuing...)"
            $failed++
        }

        $stepEnd = Get-Date
        $stepDuration = [int]($stepEnd - $stepStart).TotalSeconds
        Info "[$current/$entryCount] $appName / $presetName completed in ${stepDuration}s"
        Fix-Permissions
    }

    $measureTotalEnd = Get-Date
    $measureDuration = [int]($measureTotalEnd - $measureTotalStart).TotalSeconds

    Banner 'Results'
    Info "Total measurement time: ${measureDuration}s"
    $resultFiles = Get-ChildItem -Path $resultsDir -Filter '*.json' -ErrorAction SilentlyContinue
    if ($resultFiles) {
        Write-Host 'Result files:'
        $resultFiles | Format-Table Name, @{Label='Size'; Expression={
            if ($_.Length -ge 1MB) { '{0:N1} MB' -f ($_.Length / 1MB) }
            elseif ($_.Length -ge 1KB) { '{0:N1} KB' -f ($_.Length / 1KB) }
            else { "$($_.Length) B" }
        }} -AutoSize
    }
    else {
        Write-Host 'No result files produced.'
    }
}
else {
    Info 'Skipping measurements'
}

Write-Host ''
Info 'Done.'
