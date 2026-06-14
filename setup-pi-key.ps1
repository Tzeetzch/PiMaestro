# One-time: install local SSH public key onto the Pi for passwordless login.
# Run in a normal PowerShell window; it will ask for the Pi password once.

$ErrorActionPreference = "Stop"
# Pi target as user@host — set $env:PITV_HOST, or put it in a git-ignored ".pitv-host" file.
$Pi = $env:PITV_HOST
if (-not $Pi) {
  $cfg = Join-Path $PSScriptRoot ".pitv-host"
  if (Test-Path $cfg) { $Pi = (Get-Content $cfg -Raw).Trim() }
}
if (-not $Pi) { throw "Set the Pi target: `$env:PITV_HOST = 'user@host'  (or create a .pitv-host file)" }
$pub = (Get-Content "$HOME\.ssh\id_ed25519.pub" -Raw).Trim()

$remote = @"
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED
"@

Write-Host "Connecting to $Pi - enter your Pi password when prompted..." -ForegroundColor Cyan
ssh $Pi $remote
