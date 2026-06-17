#!/bin/bash
# PiMaestro kiosk — autostarted inside the labwc/Wayland session via ~/.config/autostart
# (lxsession-xdg-autostart picks up the .desktop). Waits for the server (the pimaestro.service
# systemd --user unit) to answer, then opens the app fullscreen in Chromium on the TV.
# NOTE: --kiosk (not --start-fullscreen) — labwc ignores --start-fullscreen for --app windows,
# which left the page in a ~960px floating window centred on the TV with black bars all round.
# --kiosk forces a real borderless fullscreen surface (verified 1920x1080, DPR 1).

# Register on HDMI-CEC so the TV detects the Pi ("PiMaestro") and forwards its remote's
# D-pad/OK/colour keys to us. The vc4_hdmi adapter resets to unconfigured every boot, so claim a
# logical address here (no sudo needed); the kernel's RC passthrough then delivers the keypresses.
cec-ctl -d /dev/cec0 --playback --osd-name PiMaestro >/dev/null 2>&1 || true

for i in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:8080/ && break
  sleep 1
done
exec chromium --ozone-platform=wayland --kiosk --app=http://localhost:8080/ --noerrdialogs --disable-infobars >/dev/null 2>&1
