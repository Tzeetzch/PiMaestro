<#
  deploy.ps1 — PiTV: sync the webpiano app to the Pi, restart the server, smoke-test.
  One command for the dev feedback loop. Vendor JS libs are large and rarely change,
  so they are NOT synced by default (use -Vendor to include them).

  Usage:
    ./deploy.ps1            # sync code, restart server, smoke test
    ./deploy.ps1 -Vendor    # also sync vendor/ (wafplayer.js, piano.js)
    ./deploy.ps1 -NoRestart # sync only, don't restart the server
#>
param(
  [switch]$Vendor,
  [switch]$NoRestart
)
$ErrorActionPreference = "Stop"
$Pi   = "peter@192.168.3.110"
$Dst  = "~/webpiano"
$Port = 8080
$Root = Join-Path $PSScriptRoot "webpiano"

Write-Host "==> Ensuring remote layout" -ForegroundColor Cyan
ssh $Pi "mkdir -p $Dst/engine $Dst/web $Dst/vendor $Dst/songs"

Write-Host "==> Syncing code" -ForegroundColor Cyan
# server + engine + web frontend. scp is fine for this size; no rsync on Windows.
scp "$Root\server.py" "${Pi}:$Dst/server.py"
if (Test-Path "$Root\engine") { scp -r "$Root\engine\*" "${Pi}:$Dst/engine/" }
if (Test-Path "$Root\web")    { scp -r "$Root\web\*"    "${Pi}:$Dst/web/" }

if ($Vendor -and (Test-Path "$Root\vendor")) {
  Write-Host "==> Syncing vendor libs" -ForegroundColor Cyan
  scp "$Root\vendor\*" "${Pi}:$Dst/vendor/"
}

if (-not $NoRestart) {
  Write-Host "==> Restarting server" -ForegroundColor Cyan
  # Kill old by port (NOT pkill -f, which self-matches the ssh shell), then relaunch detached.
  # The detached server can keep the ssh channel open, so run the restart ssh in a job
  # with a timeout — it can never hang the deploy even if ssh doesn't return cleanly.
  $restart = "fuser -k $Port/tcp 2>/dev/null; sleep 1; cd $Dst && setsid python3 server.py > $Dst/server.log 2>&1 < /dev/null & disown; echo started"
  $j = Start-Job { param($pi, $cmd) ssh $pi $cmd } -ArgumentList $Pi, $restart
  if (Wait-Job $j -Timeout 8) { Receive-Job $j }
  Remove-Job $j -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  Write-Host "==> Smoke test" -ForegroundColor Cyan
  $code = ssh $Pi "curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://localhost:$Port/"
  if ($code -eq "200") {
    Write-Host "OK  http://192.168.3.110:$Port/  (HTTP $code)" -ForegroundColor Green
  } else {
    Write-Host "FAIL  HTTP $code - last server log:" -ForegroundColor Red
    ssh $Pi "tail -n 20 $Dst/server.log"
    exit 1
  }
}
Write-Host "==> Done" -ForegroundColor Green
