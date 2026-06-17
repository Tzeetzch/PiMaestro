#!/bin/bash
# PiMaestro kiosk — autostarted inside the labwc/Wayland session via ~/.config/autostart
# (lxsession-xdg-autostart picks up the .desktop). Waits for the server (the pimaestro.service
# systemd --user unit) to answer, then opens the app fullscreen in Chromium on the TV.
# NOTE: --kiosk (not --start-fullscreen) — labwc ignores --start-fullscreen for --app windows,
# which left the page in a ~960px floating window centred on the TV with black bars all round.
# --kiosk forces a real borderless fullscreen surface (verified 1920x1080, DPR 1).
# (HDMI-CEC setup + the LG-remote->keystroke bridge live in the separate pimaestro-cec service.)

for i in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:8080/ && break
  sleep 1
done
exec chromium --ozone-platform=wayland --kiosk --app=http://localhost:8080/ --noerrdialogs --disable-infobars >/dev/null 2>&1
