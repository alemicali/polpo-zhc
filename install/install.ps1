# OpenPolpo installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/lumea-labs/polpo/main/install/install.ps1 | iex
#
# Or download and run:
#   Invoke-WebRequest -Uri https://raw.githubusercontent.com/lumea-labs/polpo/main/install/install.ps1 -OutFile install.ps1
#   .\install.ps1

$ErrorActionPreference = "Stop"

# ── Banner ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ██████╗  ██████╗ ██╗     ██████╗  ██████╗" -ForegroundColor Magenta
Write-Host "  ██╔══██╗██╔═══██╗██║     ██╔══██╗██╔═══██╗" -ForegroundColor Magenta
Write-Host "  ██████╔╝██║   ██║██║     ██████╔╝██║   ██║" -ForegroundColor DarkMagenta
Write-Host "  ██╔═══╝ ██║   ██║██║     ██╔═══╝ ██║   ██║" -ForegroundColor DarkMagenta
Write-Host "  ██║     ╚██████╔╝███████╗██║     ╚██████╔╝" -ForegroundColor DarkBlue
Write-Host "  ╚═╝      ╚═════╝ ╚══════╝╚═╝      ╚═════╝" -ForegroundColor DarkBlue
Write-Host ""
Write-Host "  Agent-agnostic AI orchestration framework" -ForegroundColor DarkGray
Write-Host ""

# ── Helpers ─────────────────────────────────────────────────────────

function Write-Info  { param($msg) Write-Host "  info  " -ForegroundColor Blue -NoNewline; Write-Host $msg }
function Write-Ok    { param($msg) Write-Host "    ok  " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn  { param($msg) Write-Host "  warn  " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err   { param($msg) Write-Host "  error " -ForegroundColor Red -NoNewline; Write-Host $msg }

# ── Check Node.js ───────────────────────────────────────────────────

function Test-NodeVersion {
    try {
        $nodeVersion = (node --version 2>$null)
        if (-not $nodeVersion) { return $false }
        $ver = $nodeVersion -replace '^v', ''
        $major = [int]($ver.Split('.')[0])
        if ($major -ge 18) {
            Write-Ok "Node.js $ver found"
            return $true
        }
        else {
            Write-Warn "Node.js $ver found but >= 18 is required"
            return $false
        }
    }
    catch {
        return $false
    }
}

function Test-Npm {
    try {
        $npmVersion = (npm --version 2>$null)
        if ($npmVersion) {
            Write-Ok "npm $npmVersion found"
            return $true
        }
        return $false
    }
    catch {
        return $false
    }
}

function Test-Pnpm {
    try {
        $pnpmVersion = (pnpm --version 2>$null)
        if ($pnpmVersion) {
            Write-Ok "pnpm $pnpmVersion found"
            return $true
        }
        return $false
    }
    catch {
        return $false
    }
}

# ── Install Node.js ────────────────────────────────────────────────

function Install-NodeJs {
    Write-Info "Node.js >= 18 is required. Attempting to install..."

    # Try winget (Windows 10+)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js via winget..."
        winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Test-NodeVersion) { return }
    }

    # Try Chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js via Chocolatey..."
        choco install nodejs-lts -y
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Test-NodeVersion) { return }
    }

    # Try Scoop
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js via Scoop..."
        scoop install nodejs-lts
        if (Test-NodeVersion) { return }
    }

    # Try fnm
    if (Get-Command fnm -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js 22 via fnm..."
        fnm install 22
        fnm use 22
        if (Test-NodeVersion) { return }
    }

    # Try volta
    if (Get-Command volta -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js 22 via volta..."
        volta install node@22
        if (Test-NodeVersion) { return }
    }

    # Manual instructions
    Write-Err "Could not automatically install Node.js."
    Write-Host ""
    Write-Host "  Please install Node.js >= 18 manually:" -ForegroundColor White
    Write-Host ""
    Write-Host "    https://nodejs.org/en/download" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Or install via winget:" -ForegroundColor White
    Write-Host ""
    Write-Host "    winget install OpenJS.NodeJS.LTS" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Then re-run this installer."
    Write-Host ""
    exit 1
}

# ── Install Polpo ──────────────────────────────────────────────────

function Install-Polpo {
    $pkgManager = "npm"

    if (Test-Pnpm) {
        $pkgManager = "pnpm"
    }

    Write-Info "Installing @polpo-ai/polpo globally via $pkgManager..."

    switch ($pkgManager) {
        "pnpm" { pnpm add -g @polpo-ai/polpo }
        "npm"  { npm install -g @polpo-ai/polpo }
    }

    # Verify installation
    try {
        $polpoVersion = (polpo --version 2>$null)
        if ($polpoVersion) {
            Write-Ok "@polpo-ai/polpo $polpoVersion installed successfully"
        }
        else {
            throw "not found"
        }
    }
    catch {
        Write-Warn "polpo was installed but may not be in your PATH."
        Write-Host ""
        $npmPrefix = (npm config get prefix 2>$null)
        Write-Host "  Ensure this directory is in your PATH:" -ForegroundColor White
        Write-Host ""
        Write-Host "    $npmPrefix" -ForegroundColor Cyan
        Write-Host ""
    }
}

# ── Next steps ─────────────────────────────────────────────────────

function Show-NextSteps {
    Write-Host ""
    Write-Host "  Installation complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Quick start:" -ForegroundColor White
    Write-Host ""
    Write-Host "    mkdir my-project; cd my-project" -ForegroundColor Cyan
    Write-Host "    polpo init" -ForegroundColor Cyan
    Write-Host "    polpo" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Run as a server:" -ForegroundColor White
    Write-Host ""
    Write-Host "    polpo serve" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Run with Docker:" -ForegroundColor White
    Write-Host ""
    Write-Host "    docker run -it -p 3000:3000 -v ${PWD}:/workspace lumea-labs/polpo" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Documentation: https://polpo.sh" -ForegroundColor DarkGray
    Write-Host "  GitHub:        https://github.com/lumea-labs/polpo" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Main ────────────────────────────────────────────────────────────

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$isArm = $env:PROCESSOR_ARCHITECTURE -eq "ARM64"
if ($isArm) { $arch = "arm64" }
Write-Info "Detected platform: windows ($arch)"

# Check or install Node.js
if (-not (Test-NodeVersion)) {
    Install-NodeJs
    if (-not (Test-NodeVersion)) {
        Write-Err "Node.js installation failed. Please install Node.js >= 18 manually."
        exit 1
    }
}

# Check npm
if (-not (Test-Npm)) {
    Write-Err "npm not found. It should come with Node.js — please reinstall Node.js."
    exit 1
}

# Install
Install-Polpo

# Done
Show-NextSteps
