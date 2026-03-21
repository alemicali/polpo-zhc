# Polpo installer for Windows
# Usage: irm https://get.polpo.sh/windows | iex
$ErrorActionPreference = "Stop"

$MIN_NODE = 20

Write-Host ""
Write-Host "  Polpo Installer" -ForegroundColor White
Write-Host ""

# Check Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js is not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install Node.js ${MIN_NODE}+:" -ForegroundColor Cyan
    Write-Host "  winget install OpenJS.NodeJS.LTS"
    Write-Host "  # or download: https://nodejs.org"
    Write-Host ""
    exit 1
}

$nodeVersion = (node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])

if ($nodeMajor -lt $MIN_NODE) {
    Write-Host "Node.js $nodeVersion is too old. Polpo requires Node.js >= $MIN_NODE." -ForegroundColor Red
    Write-Host ""
    Write-Host "Upgrade: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

Write-Host "Node.js $nodeVersion" -ForegroundColor Green

# Check npm
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "npm not found. Reinstall Node.js: https://nodejs.org" -ForegroundColor Red
    exit 1
}

$npmVersion = npm -v
Write-Host "npm $npmVersion" -ForegroundColor Green
Write-Host ""

# Install
Write-Host "Installing polpo-ai..." -ForegroundColor Cyan
Write-Host ""

try {
    npm install -g polpo-ai
    Write-Host ""
    Write-Host "Polpo installed successfully!" -ForegroundColor Green
    Write-Host ""
    $ver = polpo --version 2>$null
    Write-Host "  Version:  $ver" -ForegroundColor Cyan
    Write-Host "  Platform: windows ($env:PROCESSOR_ARCHITECTURE)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Get started:"
    Write-Host "    polpo login       # connect to Polpo cloud"
    Write-Host "    polpo init        # or run locally"
    Write-Host "    polpo --help      # see all commands"
    Write-Host ""
    Write-Host "  Docs: https://docs.polpo.sh" -ForegroundColor Cyan
    Write-Host ""
} catch {
    Write-Host ""
    Write-Host "Installation failed." -ForegroundColor Red
    Write-Host "Try running PowerShell as Administrator." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
