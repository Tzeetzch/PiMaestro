#!/usr/bin/env python3
"""PiMaestro CEC remote bridge.

The LG TV forwards its remote over HDMI-CEC, but webOS/the kernel only turn SOME of it into keys
the browser can use: arrows arrive fine, OK (CEC 'select' 0x00) arrives at the CEC layer but the
kernel maps it to nothing useful, and Back arrives as the browser's dead "Close" key. Rather than
fight the kernel keymap (which labwc grabs) we read /dev/cec0 ourselves and feed the app the exact
keystrokes we want.

Delivery uses the app's existing SSE "key" channel (same path the phone remote uses): we POST
{"cmd":"key","key":...} to the server, which broadcasts it, and the page replays it as a keydown.
That means NO uinput and NO root — this runs as the plain user.

We deliberately DON'T re-send the arrows: those already reach the app via the kernel's CEC->input
map, so re-sending would double every navigation step. We only supply what's missing.
"""
import json
import re
import subprocess
import time
import urllib.request

CONTROL = "http://localhost:8080/control"
DEV = "/dev/cec0"
PHYS = "4.0.0.0"          # the Pi's HDMI physical address on this TV (HDMI0)

# CEC UI-command code -> browser key string the app's keydown handler understands.
# Arrows (0x01-0x04) are intentionally absent — the kernel already delivers those.
KEYMAP = {
    0x00: "Enter",        # select / OK  -> activate focused item
    0x0d: "Escape",       # back         -> up one level / pause
    0x44: " ",            # play         -> play/pause toggle (Space)
    0x46: " ",            # pause
}
DEBOUNCE = 0.25           # seconds; ignore a repeat of the same code within this window
_last = {}

_UICMD = re.compile(r"ui-cmd:\s+\S+\s+\(0x([0-9a-fA-F]+)\)")


def send_key(key):
    body = json.dumps({"cmd": "key", "key": key}).encode()
    req = urllib.request.Request(CONTROL, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass


def configure():
    """Claim a logical address + OSD name and announce we're the active source, so the LG detects
    the Pi as 'PiMaestro' and forwards its remote to us. The adapter boots unconfigured each time."""
    for args in (["--playback", "--osd-name", "PiMaestro"],
                 ["--to", "0", "--image-view-on"],
                 ["--active-source", "phys-addr=" + PHYS]):
        try:
            subprocess.run(["cec-ctl", "-d", DEV] + args, timeout=5,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


def main():
    configure()
    # cec-follower keeps the Pi alive on the bus (it answers the TV's CEC queries, which is what
    # keeps the remote being forwarded) and prints every message it receives in verbose mode.
    # stdbuf -oL: cec-follower block-buffers stdout when it's a pipe, which would stall our reads;
    # force line buffering so each received message reaches us immediately.
    proc = subprocess.Popen(["stdbuf", "-oL", "cec-follower", "-d", DEV, "-v"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    for line in proc.stdout:
        m = _UICMD.search(line)
        if not m:
            continue
        code = int(m.group(1), 16)
        key = KEYMAP.get(code)
        if key is None:
            continue
        now = time.monotonic()
        if now - _last.get(code, 0) < DEBOUNCE:
            continue
        _last[code] = now
        send_key(key)


if __name__ == "__main__":
    main()
