#!/bin/bash
# PiTV - open the app in the browser. Run "PiTV-Start" first.
# ?next=1 = the local-clock renderer (rAF + dirty-gating + a lean stream) — much lighter on the Pi 4.
chromium --app=http://localhost:8080/?next=1 >/dev/null 2>&1 &
