#!/bin/bash
# PiMaestro power-watcher — autostarted inside peter's active seat session (via ~/.config/autostart).
# The phone remote (/remote) sets a power action on the server; this loop polls /halt and runs the
# clean systemctl action. polkit allows power-off/reboot for the active local session with no password,
# so this needs no sudo — but ONLY works because it runs in the graphical session, not the server.
while :; do
  action=$(curl -s --max-time 2 http://localhost:8080/halt 2>/dev/null | tr -d '"')
  case "$action" in
    poweroff) systemctl poweroff; exit 0 ;;
    reboot)   systemctl reboot;   exit 0 ;;
  esac
  sleep 2
done
