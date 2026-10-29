# Встановлює (за згодою) усе потрібне й запускає Electron-версію SSH Key Maker. Windows 10/11.
#   start.cmd       — перевірити Node.js, Electron і запустити
#   start.cmd -y    — не питати, погоджуватись на все
# OpenSSH програма перевіряє й пропонує встановити сама.
param([switch]$y)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location (Join-Path $PSScriptRoot 'electron')
$NodeMin = 22

function Confirm-Step($question) {
    if ($y) { return $true }
    $a = Read-Host "$question [т/Н]"
    return $a -match '^(т|y)'
}

# winget змінює PATH лише для нових процесів — перечитуємо його з реєстру
function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    return [int](& node -p "process.versions.node.split('.')[0]")
}

function Stop-With($message) {
    Write-Host "✗ $message"
    exit 1
}

# 1. Node.js і npm
if ((Get-NodeMajor) -lt $NodeMin) {
    Write-Host "→ Потрібен Node.js $NodeMin або новіший (з ним іде npm)."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Stop-With 'Немає winget. Встановіть Node.js LTS з https://nodejs.org і запустіть знову.'
    }
    if (-not (Confirm-Step 'Встановити Node.js LTS через winget?')) { Stop-With 'Без Node.js запустити не можу.' }
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Update-Path
    if ((Get-NodeMajor) -lt $NodeMin) { Stop-With 'Node.js так і не знайдено. Відкрийте нове вікно й запустіть знову.' }
}
Write-Host "✓ Node.js $(node -v)"

# 2. Electron та інші залежності з package.json
# У Windows PowerShell 5.1 stderr рідної команди з 'Stop' стає винятком — тимчасово вимикаємо
$ErrorActionPreference = 'Continue'
& node -e "require('fs').accessSync(require('electron'))" 2>$null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) {
    if (-not (Confirm-Step 'Встановити Electron і залежності (npm install, ~200 МБ)?')) { Stop-With 'Скасовано.' }
    & npm install
    if ($LASTEXITCODE -ne 0) { Stop-With "npm install завершився з кодом $LASTEXITCODE." }
}
Write-Host "✓ Electron $(node -p "require('electron/package.json').version")"

# 3. Запуск
Write-Host '→ Запускаю SSH Key Maker…'
& npm start --silent
