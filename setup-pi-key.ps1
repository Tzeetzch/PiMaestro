# One-time: install local SSH public key onto the Pi for passwordless login.
# Run in a normal PowerShell window; it will ask for the Pi password once.

$ErrorActionPreference = "Stop"
$pub = (Get-Content "$HOME\.ssh\id_ed25519.pub" -Raw).Trim()

$remote = @"
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED
"@

Write-Host "Connecting to peter@pitv.local - enter your Pi password when prompted..." -ForegroundColor Cyan
ssh peter@pitv.local $remote
