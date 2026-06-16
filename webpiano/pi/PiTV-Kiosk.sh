#!/bin/bash
# PiMaestro kiosk — autostarted inside the labwc/Wayland session via ~/.config/autostart
# (lxsession-xdg-autostart picks up the .desktop). Waits for the server (the pimaestro.service
# systemd --user unit) to answer, then opens the app fullscreen in Chromium on the TV.
for i in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:8080/ && break
  sleep 1
done
exec chromium --app=http://localhost:8080/ --start-fullscreen --noerrdialogs --disable-infobars >/dev/null 2>&1
