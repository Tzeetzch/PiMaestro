#!/bin/bash
# Download the WebAudioFont instrument + drum samples the Rich browser-sound engine uses, into
# web/waf/, so the Pi serves them locally and the app never needs the internet at runtime (~12 MB).
# Run once on the Pi:  bash ~/webpiano/pi/fetch-waf.sh
# waf-files.txt is the exact set the app requests (the default instrument per GM program + drums).
# Regenerate that list if WebAudioFontPlayer.js changes (node snippet in the repo history).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../web/waf"
mkdir -p "$dest"; cd "$dest"
cat "$here/waf-files.txt" | xargs -P 8 -I{} curl -fsS -o "{}" "https://cdn.jsdelivr.net/gh/surikov/webaudiofontdata@master/sound/{}"
echo "WebAudioFont samples: $(ls *.js | wc -l) files, $(du -sh . | cut -f1) in $dest"
