#!/bin/bash
# PiMaestro remote-doctor — read-only. Explains why the phone remote's keys / power buttons
# aren't working by checking the two session-side helpers they depend on. No sudo, no changes.
# Run on the Pi:  bash ~/webpiano/pi/PiTV-Doctor.sh
say(){ printf '%-34s %s\n' "$1" "$2"; }

echo "== PiMaestro remote doctor =="
say "server :8080 (http)"  "$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://localhost:8080/halt 2>/dev/null || echo DOWN)"
say "server :8443 (https)" "$(curl -sk --max-time 2 -o /dev/null -w '%{http_code}' https://localhost:8443/halt 2>/dev/null || echo DOWN)"
say "power flag (/halt)"   "[$(curl -s --max-time 2 http://localhost:8080/halt 2>/dev/null | tr -d '\"')]"

echo "-- session helpers (must run INSIDE the graphical session) --"
pgrep -af PiTV-PowerWatch >/dev/null && say "power-watcher" "RUNNING" || say "power-watcher" "NOT running  <-- shut down/restart will do nothing"
pgrep -af "chromium.*app"  >/dev/null && say "kiosk (TV game page)" "RUNNING" || say "kiosk (TV game page)" "NOT running  <-- arrows/OK reach nothing"

echo "-- autostart wiring --"
for f in pimaestro-powerwatch pimaestro-kiosk; do
  [ -e "$HOME/.config/autostart/$f.desktop" ] && say "~/.config/autostart/$f" "present" || say "~/.config/autostart/$f" "MISSING"
done
echo "labwc session autostart (one of these must launch the XDG entries, e.g. via lxsession-xdg-autostart):"
for a in "$HOME/.config/labwc/autostart" /etc/xdg/labwc/autostart; do
  if [ -e "$a" ]; then echo "  [$a]"; sed 's/^/    /' "$a"; else echo "  [$a]  (none)"; fi
done

echo "-- verdict --"
if pgrep -af PiTV-PowerWatch >/dev/null && pgrep -af "chromium.*app" >/dev/null; then
  echo "Both helpers are up. The remote should work — if it doesn't, the phone may be on the cached"
  echo "PWA pointing at a stale host; check the status dot (green=on) on the remote page."
elif [ -e "$HOME/.config/autostart/pimaestro-powerwatch.desktop" ]; then
  echo "Autostart files are present but the helpers aren't running -> just REBOOT once: systemctl reboot"
  echo "If they STILL don't start after reboot, labwc isn't processing ~/.config/autostart; the fix is to"
  echo "add a line to ~/.config/labwc/autostart that launches them (lxsession-xdg-autostart, or call the .sh directly)."
else
  echo "Autostart files are MISSING -> they were never installed into ~/.config/autostart. Reinstall them, then reboot."
fi
