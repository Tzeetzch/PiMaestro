#!/bin/bash
# PiTV - open the app in the browser. Run "PiTV-Start" first.
chromium --app=http://localhost:8080/ >/dev/null 2>&1 &
