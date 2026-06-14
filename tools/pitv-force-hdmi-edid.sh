#!/usr/bin/env bash
# PiTV PERMANENT HDMI-audio fix.
#
# Saves the TV's (audio-capable) EDID and forces the kernel to always use it at
# boot, so HDMI/TV audio is available even when the Pi boots with the TV off.
# Fixes the vc4 race where the HDMI audio path (ELD) isn't built at boot.
#
# Run with:  sudo bash ~/pitv-force-hdmi-edid.sh
# Then:      sudo reboot
set -e

EDID_SRC=/sys/class/drm/card1-HDMI-A-1/edid
DEST_DIR=/lib/firmware/edid
DEST=$DEST_DIR/pitv-tv.bin
CMDLINE=/boot/firmware/cmdline.txt
PARAM="drm.edid_firmware=HDMI-A-1:edid/pitv-tv.bin"

# 1. The live EDID must currently advertise audio (TV on, on the Pi's input).
sz=$(wc -c < "$EDID_SRC")
if [ "$sz" -lt 256 ]; then
  echo "ERROR: live EDID is only $sz bytes — no audio block. Make sure the TV is ON"
  echo "and showing the Pi, then re-run. Aborting (nothing changed)."
  exit 1
fi
python3 -c "import sys;d=open('$EDID_SRC','rb').read();sys.exit(0 if (len(d)>=256 and d[128]==2 and (d[131]&0x40)) else 1)" \
  || { echo 'ERROR: live EDID does not advertise basic audio. Aborting (nothing changed).'; exit 1; }

# 2. Save the audio-capable EDID into the firmware directory.
mkdir -p "$DEST_DIR"
cp "$EDID_SRC" "$DEST"
echo "Saved audio-capable EDID -> $DEST ($sz bytes)"

# 3. Add the kernel parameter to cmdline.txt (must stay a SINGLE line). Backup first.
cp "$CMDLINE" "$CMDLINE.pitvbak"
if grep -q "drm.edid_firmware" "$CMDLINE"; then
  echo "cmdline.txt already has drm.edid_firmware — leaving it unchanged."
else
  line=$(head -n1 "$CMDLINE")
  printf '%s %s\n' "$line" "$PARAM" > "$CMDLINE"
  echo "Added kernel param (backup at $CMDLINE.pitvbak)."
fi
echo "--- cmdline.txt now ---"
cat "$CMDLINE"
echo
echo "DONE.  Reboot to apply:   sudo reboot"
echo "Undo if needed:           sudo cp $CMDLINE.pitvbak $CMDLINE && sudo reboot"
