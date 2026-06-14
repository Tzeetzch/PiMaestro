#!/bin/bash
# PiTV - start the web-app server (and route the MIDI keyboard into FluidSynth for sound).
# Double-click from the Pi desktop. FluidSynth itself auto-starts on boot.
cd "$HOME/webpiano" || exit 1
fuser -k 8080/tcp 2>/dev/null      # stop any previous instance on the port
sleep 1
# local piano sound: connect the keyboard to the synth (no-op if the keyboard is off)
aconnect 'DigitalKBD' 'FLUID Synth' 2>/dev/null
# start the server detached so it keeps running after this script exits
setsid python3 server.py > "$HOME/webpiano/server.log" 2>&1 < /dev/null &
sleep 1
notify-send 'PiTV' 'Server started - now open "Open PiTV".' 2>/dev/null
