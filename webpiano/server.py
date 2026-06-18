#!/usr/bin/env python3
"""PiTV web server — the transport layer (runs on the Pi).

Thin pipe between the engine and the browser (see docs/ARCHITECTURE.md):
  - GET /events        Server-Sent Events: live MIDI keyboard notes (low-latency feel)
  - GET /songs         list available MIDI on the Pi, grouped by difficulty folder
  - GET /song?file=... parse a MIDI ON DEMAND via the engine, return the view-model
  - GET /...           static frontend from web/ and vendor/

No game logic lives here. Timing/scoring is the engine's job; the browser only renders
the view-model and shows live keys. Pure stdlib + the `aseqdump` ALSA tool for MIDI in.

Run on the Pi:   cd ~/webpiano && python3 server.py
"""
import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import http.server
import socketserver
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from engine.song import build_view_model  # noqa: E402
from engine.conductor import Conductor    # noqa: E402

WEB_DIR = os.path.join(HERE, "web")
VENDOR_DIR = os.path.join(HERE, "vendor")

# ---- catalogue: which MIDI we serve, grouped by folder (defends /song against arbitrary reads) ----
class SongCatalog:
    def __init__(self):
        self.roots = [os.path.realpath(os.path.expanduser(p)) for p in
                      ("~/linthesia/music", "~/Music", os.path.join(HERE, "songs"))]
        self.upload_dir = os.path.realpath(os.path.expanduser("~/Music/Uploads"))   # web uploads land here

    @staticmethod
    def _group_label(path):
        """(order, display) from the folder name. A LEADING number orders groups and is hidden from
        the label, so '21 Piano - Classical' shows as 'Piano - Classical' and sorts by 21."""
        parent = os.path.basename(os.path.dirname(path)).replace("_", " ").strip()
        m = re.match(r"(\d+)\s*[-.]*\s*(.+)", parent)
        if m:
            return int(m.group(1)), m.group(2).strip()
        return 900, (parent or "Songs")

    def list(self):
        songs = []
        for root in self.roots:
            if not os.path.isdir(root):
                continue
            for dirpath, _dirs, files in os.walk(root):
                for fn in files:
                    if fn.lower().endswith((".mid", ".midi")):
                        full = os.path.realpath(os.path.join(dirpath, fn))   # canonical = library key
                        order, label = self._group_label(full)
                        songs.append({"title": os.path.splitext(fn)[0].replace("_", " "),
                                      "file": full, "group": label, "_o": order})
        songs.sort(key=lambda s: (s["_o"], s["group"], s["title"]))          # ordered groups, then title
        return songs

    def is_allowed(self, path):
        real = os.path.realpath(path)
        return (real.lower().endswith((".mid", ".midi"))
                and any(real == r or real.startswith(r + os.sep) for r in self.roots))


# ---- per-song settings (part/speed/octave/mode + fav/played), keyed by file path, on the Pi ----
class SettingsStore:
    def __init__(self):
        self.dir = os.path.expanduser("~/.config/pitv")
        self.file = os.path.join(self.dir, "song-settings.json")
        self._lock = threading.Lock()

    def load_all(self):
        try:
            with open(self.file) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_for(self, path, settings):
        with self._lock:
            data = self.load_all()
            if settings is None:
                data.pop(path, None)
            else:
                data.setdefault(path, {}).update(settings)    # merge: keep fav/played + play-settings
            try:
                os.makedirs(self.dir, exist_ok=True)
                tmp = self.file + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(data, f, indent=1)
                os.replace(tmp, self.file)                     # atomic write
            except OSError:
                pass


# ---- power: the phone remote requests poweroff/reboot; a seat-session watcher polls /halt and runs
# the clean systemctl action (the server runs in the user manager, not a seat, so it can't itself). ----
class PowerControl:
    def __init__(self):
        self._action = ""

    def request(self, action):
        self._action = action

    def pending(self):
        return self._action


CATALOG = SongCatalog()
SETTINGS = SettingsStore()
POWER = PowerControl()

clients = []
clients_lock = threading.Lock()
MAX_SSE_CLIENTS = 24             # a TV + a few tablets is normal; cap so a LAN flood can't exhaust threads/queues
# aseqdump prints note-OFF with no velocity field ("Note off  0, note 69"), so velocity
# is optional here — otherwise note-offs never match and keys/sound never release.
NOTE_RE = re.compile(r"Note (on|off)\b.*?note (\d+)(?:.*?velocity (\d+))?", re.I)

CTYPES = {"html": "text/html; charset=utf-8", "js": "application/javascript",
          "css": "text/css", "json": "application/json", "svg": "image/svg+xml",
          "png": "image/png", "webmanifest": "application/manifest+json",
          "crt": "application/x-x509-ca-cert"}   # so a tablet recognises the CA download


# ---------------------------------------------------------------- MIDI input (SSE)
def broadcast(obj):
    data = json.dumps(obj)
    with clients_lock:
        for q in list(clients):
            try:
                q.put_nowait(data)
            except queue.Full:
                # A stalled client filled its queue. Drop the OLDEST frame (a stale pos) to make
                # room for this one, so a discrete event (gate/rating/noteoff) isn't the casualty.
                try:
                    q.get_nowait(); q.put_nowait(data)
                except (queue.Empty, queue.Full):
                    pass


# The single playback brain (one piano, one session). Streams state via broadcast().
conductor = Conductor(broadcast)


def midi_reader(port):
    try:
        listing = subprocess.run(["aseqdump", "-l"], capture_output=True, text=True).stdout
        print("ALSA MIDI ports:\n" + listing, flush=True)
    except FileNotFoundError:
        print("ERROR: aseqdump not found (install alsa-utils)", file=sys.stderr, flush=True)
        return
    while True:
        print(f"connecting MIDI input '{port}'...", flush=True)
        proc = subprocess.Popen(["aseqdump", "-p", port], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        # route the keyboard into FluidSynth for local sound (idempotent; harmless if off)
        subprocess.run(["aconnect", port, "FLUID Synth"], capture_output=True)
        for line in proc.stdout:
            if "ote" not in line:          # skip the Clock/Active-Sensing flood before regex
                continue
            m = NOTE_RE.search(line)
            if not m:
                continue
            kind, note = m.group(1).lower(), int(m.group(2))
            vel = int(m.group(3)) if m.group(3) else 0
            typ = "noteon" if (kind == "on" and vel > 0) else "noteoff"
            if typ == "noteon":
                conductor.on_note(note)               # feed Follow-You gating
            broadcast({"type": typ, "note": note, "velocity": vel})
        proc.wait()
        print(f"'{port}' input ended (keyboard off?); retrying in 2s", flush=True)
        time.sleep(2)


# ---------------------------------------------------------------- HTTP
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/events":
            self._sse()
        elif u.path == "/songs":
            self._json(CATALOG.list())
        elif u.path == "/song":
            self._song(parse_qs(u.query))
        elif u.path == "/settings":
            path = (parse_qs(u.query).get("file") or [""])[0]
            self._json((SETTINGS.load_all().get(os.path.realpath(path)) or {}) if CATALOG.is_allowed(path) else {})
        elif u.path == "/halt":
            self._json(POWER.pending())           # "" | "poweroff" | "reboot" — the session watcher polls this
        elif u.path == "/remote":
            self._static("/remote.html")          # phone power remote (clean shutdown/restart, no TV needed)
        elif u.path == "/library":
            self._json(SETTINGS.load_all())       # {path: {fav, played, ...}} for Favorites/Recent
        else:
            self._static(u.path)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/upload":
            self._upload(parse_qs(u.query))
            return
        if u.path != "/control":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            self.send_error(400, "bad length"); return
        if length > 2_000_000:                                  # /control bodies are tiny JSON
            self.send_error(413, "too large"); return
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            self.send_error(400, "bad json")
            return
        if not isinstance(req, dict):
            self.send_error(400, "bad json"); return
        handler = self._CONTROL.get(req.get("cmd"))
        if not handler:
            self.send_error(400, "unknown cmd"); return
        try:
            handler(self, req)
        except Exception as e:                                  # a malformed field (bad channels/lo/hi/program)
            self.send_error(400, f"bad request: {e}")           # -> 400, never a crashed handler thread

    # --- /control command handlers (registered in the _CONTROL dispatch table at the end) ---
    def _c_load(self, req):
        path = req.get("file", "")
        if not CATALOG.is_allowed(path):
            self.send_error(403, "song not allowed"); return
        lo, hi = req.get("lo"), req.get("hi")
        try:
            vm = build_view_model(path, req.get("transpose", 0), lo, hi, req.get("split") or 60)
        except Exception as e:                          # noqa: BLE001
            self.send_error(500, f"parse failed: {e}"); return
        conductor.load(vm, req.get("play"), lo, hi, path)
        self._json(vm)                                  # browser renders from this
    def _c_play(self, req): conductor.play(); self._json({"ok": True})
    def _c_stop(self, req): conductor.stop(); self._json({"ok": True})
    def _c_reset(self, req): conductor.rewind(); self._json({"ok": True})
    def _c_play_parts(self, req): conductor.set_play(req.get("channels"), req.get("hand")); self._json({"ok": True})
    def _c_mode(self, req): conductor.set_mode(req.get("mode", "follow")); self._json({"ok": True})
    def _c_speed(self, req): conductor.set_speed(req.get("mult", 1.0)); self._json({"ok": True})
    def _c_loop(self, req): conductor.set_loop(req.get("start"), req.get("end")); self._json({"ok": True})
    def _c_range(self, req): conductor.set_range(req.get("lo"), req.get("hi")); self._json({"ok": True})
    def _c_seek(self, req): conductor.seek(req.get("t")); self._json({"ok": True})
    def _c_part(self, req): conductor.set_part(req.get("ch"), req.get("mute"), req.get("program"), req.get("volume")); self._json({"ok": True})
    def _c_pi_mute(self, req): conductor.set_pi_muted(bool(req.get("on"))); self._json({"ok": True})
    def _c_key(self, req):
        k = req.get("key")                              # phone remote -> the TV app replays this keypress
        if k:
            broadcast({"type": "key", "key": str(k)})
        self._json({"ok": True})
    # persistence: settings / favourite / played all share one guarded write
    def _save_song(self, req, payload):
        f = req.get("file", "")
        if CATALOG.is_allowed(f):
            SETTINGS.save_for(os.path.realpath(f), payload)
        self._json({"ok": True})
    def _c_save_settings(self, req): self._save_song(req, req.get("settings"))
    def _c_favorite(self, req): self._save_song(req, {"fav": bool(req.get("on"))})
    def _c_played(self, req): self._save_song(req, {"played": time.time()})
    # power: poweroff/reboot set a flag the seat-session watcher acts on; exit kills our own kiosk
    def _set_power(self, action):
        POWER.request(action)
        self._json({"ok": True})
    def _c_poweroff(self, req): self._set_power("poweroff")
    def _c_reboot(self, req): self._set_power("reboot")
    def _c_exit(self, req):
        # The kiosk Chromium is our own user's process, so we can signal it directly — no privilege
        # needed (unlike poweroff/reboot). The kiosk script `exec`s chromium, so killing it drops to
        # labwc; relaunch via the desktop shortcut.
        subprocess.Popen(["pkill", "-f", "chromium.*--app=http://localhost:8080"])
        self._json({"ok": True})
    _CONTROL = {
        "load": _c_load, "play": _c_play, "stop": _c_stop, "reset": _c_reset,
        "play_parts": _c_play_parts, "mode": _c_mode, "speed": _c_speed, "loop": _c_loop,
        "range": _c_range, "seek": _c_seek, "part": _c_part, "pi_mute": _c_pi_mute, "key": _c_key,
        "save_settings": _c_save_settings, "favorite": _c_favorite, "played": _c_played,
        "poweroff": _c_poweroff, "reboot": _c_reboot, "exit": _c_exit,
    }

    # --- API ---
    def _upload(self, qs):
        name = (qs.get("name") or [""])[0]
        base = os.path.basename(name).strip()
        if not base.lower().endswith((".mid", ".midi")):
            self.send_error(400, "need a .mid or .midi file"); return
        safe = re.sub(r"[^A-Za-z0-9 ._-]", "_", base)[:120] or "upload.mid"
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            self.send_error(400, "bad length"); return
        if length <= 0 or length > 5_000_000:                  # MIDIs are tiny; cap at 5 MB
            self.send_error(400, "bad size"); return
        data = self.rfile.read(length)
        if data[:4] != b"MThd":                                # must be a Standard MIDI File
            self.send_error(400, "not a Standard MIDI File"); return
        try:
            os.makedirs(CATALOG.upload_dir, exist_ok=True)
            dest = os.path.join(CATALOG.upload_dir, safe)
            with open(dest, "wb") as f:
                f.write(data)
        except OSError as e:                                    # noqa: BLE001
            self.send_error(500, f"save failed: {e}"); return
        self._json({"ok": True, "file": os.path.realpath(dest),
                    "title": os.path.splitext(safe)[0].replace("_", " ")})

    def _song(self, qs):
        path = (qs.get("file") or [""])[0]
        if not path or not CATALOG.is_allowed(path):
            self.send_error(403, "song not allowed")
            return
        try:
            self._json(build_view_model(path))
        except Exception as e:                                  # noqa: BLE001
            self.send_error(500, f"parse failed: {e}")

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- static: web/ first, then vendor/ ---
    def _static(self, path):
        rel = (path.split("?", 1)[0].lstrip("/")) or "index.html"
        if rel.startswith("vendor/"):
            base, rel = VENDOR_DIR, rel[len("vendor/"):]
        else:
            base = WEB_DIR
        full = os.path.realpath(os.path.join(base, rel))
        if not full.startswith(os.path.realpath(base) + os.sep) and full != os.path.realpath(base):
            self.send_error(403)
            return
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(404)
            return
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
        self.send_response(200)
        self.send_header("Content-Type", CTYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")     # always serve fresh app code
        self.end_headers()
        self.wfile.write(body)

    def _sse(self):
        with clients_lock:
            full = len(clients) >= MAX_SSE_CLIENTS               # cap fan-out: a LAN flood can't exhaust threads/mem
        if full:
            self.send_error(503, "too many clients"); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        # A wedged-but-open client (frozen TV, half-open NAT) would otherwise block wfile.write
        # forever, pinning this thread + leaking its queue. Time the socket out so it falls through
        # to the finally and is cleaned up.
        try:
            self.connection.settimeout(30)
        except OSError:
            pass
        # The client runs its own playback clock, so it only needs the position frame as a
        # low-rate heartbeat. Throttle `pos` to ~4 Hz, but ALWAYS pass a frame that changed
        # play-state, switched song (file), was tagged seek=True (seek/loop/reset/load), or
        # jumped >0.5s — and never throttle discrete events (gate/rating/noteon/...).
        last_pos, last_play, last_t, last_file, last_speed = 0.0, None, None, None, None
        q = queue.Queue(maxsize=2000)
        with clients_lock:
            clients.append(q)
        try:
            # resync this client immediately: current song + play position
            self.wfile.write(f"data: {json.dumps(conductor.snapshot())}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                    obj = json.loads(data)
                    if obj.get("type") == "pos":
                        nowm, pl, t, f, sp = time.monotonic(), obj.get("playing"), obj.get("t"), obj.get("file"), obj.get("speed")
                        forced = (obj.get("seek") or pl != last_play or f != last_file or sp != last_speed
                                  or (last_t is not None and t is not None and abs(t - last_t) > 0.5))
                        if not forced and (nowm - last_pos) < 0.25:
                            last_t, last_file = t, f      # track even when dropped, so jumps stay detectable
                            continue                      # throttle this heartbeat for the local-clock client
                        last_pos, last_play, last_t, last_file, last_speed = nowm, pl, t, f, sp
                    self.wfile.write(f"data: {data}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with clients_lock:
                if q in clients:
                    clients.remove(q)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--midi", default="DigitalKBD")
    ap.add_argument("--tls-port", type=int, default=8443)
    ap.add_argument("--tls-cert", default="")
    ap.add_argument("--tls-key", default="")
    args = ap.parse_args()
    threading.Thread(target=midi_reader, args=(args.midi,), daemon=True).start()
    print(f"PiTV server: http://0.0.0.0:{args.port}  (MIDI: {args.midi})", flush=True)
    print(f"song roots: {[r for r in CATALOG.roots if os.path.isdir(r)]}", flush=True)
    # Optional HTTPS on a second port (same handler), so phones/tablets get a secure context —
    # required for an installable PWA + service worker. Cert from mkcert (locally trusted).
    if args.tls_cert and args.tls_key and os.path.exists(args.tls_cert) and os.path.exists(args.tls_key):
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.tls_cert, args.tls_key)
        https = Server(("0.0.0.0", args.tls_port), Handler)
        https.socket = ctx.wrap_socket(https.socket, server_side=True)
        threading.Thread(target=https.serve_forever, daemon=True).start()
        print(f"PiTV HTTPS:  https://0.0.0.0:{args.tls_port}", flush=True)
    Server(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
