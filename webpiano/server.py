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

# Directories we are willing to read MIDI from (defends /song against arbitrary reads).
SONG_ROOTS = [os.path.realpath(os.path.expanduser(p)) for p in (
    "~/linthesia/music", "~/Music", os.path.join(HERE, "songs"),
)]
# Web uploads land here (under ~/Music, so they're listed by /songs as the "Uploads" group).
UPLOAD_DIR = os.path.realpath(os.path.expanduser("~/Music/Uploads"))

clients = []
clients_lock = threading.Lock()

# Per-song settings (part/speed/octave/mode) live on the Pi so they follow the song to any
# client. Keyed by the song's file path.
SETTINGS_DIR = os.path.expanduser("~/.config/pitv")
SETTINGS_FILE = os.path.join(SETTINGS_DIR, "song-settings.json")
_settings_lock = threading.Lock()


def _load_settings():
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_settings_for(path, settings):
    with _settings_lock:
        data = _load_settings()
        if settings is None:
            data.pop(path, None)
        else:
            data.setdefault(path, {}).update(settings)    # merge: keep fav/played + play-settings
        try:
            os.makedirs(SETTINGS_DIR, exist_ok=True)
            tmp = SETTINGS_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, indent=1)
            os.replace(tmp, SETTINGS_FILE)        # atomic write
        except OSError:
            pass
# aseqdump prints note-OFF with no velocity field ("Note off  0, note 69"), so velocity
# is optional here — otherwise note-offs never match and keys/sound never release.
NOTE_RE = re.compile(r"Note (on|off)\b.*?note (\d+)(?:.*?velocity (\d+))?", re.I)

CTYPES = {"html": "text/html; charset=utf-8", "js": "application/javascript",
          "css": "text/css", "json": "application/json", "svg": "image/svg+xml"}


# ---------------------------------------------------------------- MIDI input (SSE)
def broadcast(obj):
    data = json.dumps(obj)
    with clients_lock:
        for q in list(clients):
            try:
                q.put_nowait(data)
            except queue.Full:
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


# ---------------------------------------------------------------- song catalogue
def _difficulty(path):
    """Derive a difficulty/group label from the folder name (e.g. '2_-_Easy' -> 'Easy')."""
    parent = os.path.basename(os.path.dirname(path))
    m = re.match(r"\d+\s*-\s*(.+)", parent.replace("_", " ").strip())
    return m.group(1).strip() if m else (parent or "Songs")


def list_songs():
    songs = []
    for root in SONG_ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if fn.lower().endswith((".mid", ".midi")):
                    full = os.path.realpath(os.path.join(dirpath, fn))   # canonical = library key
                    songs.append({
                        "title": os.path.splitext(fn)[0].replace("_", " "),
                        "file": full,
                        "group": _difficulty(full),
                    })
    songs.sort(key=lambda s: (s["group"], s["title"]))
    return songs


def _is_allowed_song(path):
    real = os.path.realpath(path)
    return (real.lower().endswith((".mid", ".midi"))
            and any(real == r or real.startswith(r + os.sep) for r in SONG_ROOTS))


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
            self._json(list_songs())
        elif u.path == "/song":
            self._song(parse_qs(u.query))
        elif u.path == "/settings":
            path = (parse_qs(u.query).get("file") or [""])[0]
            self._json((_load_settings().get(os.path.realpath(path)) or {}) if _is_allowed_song(path) else {})
        elif u.path == "/library":
            self._json(_load_settings())          # {path: {fav, played, ...}} for Favorites/Recent
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
        cmd = req.get("cmd")
        if cmd == "load":
            path = req.get("file", "")
            if not _is_allowed_song(path):
                self.send_error(403, "song not allowed")
                return
            lo, hi = req.get("lo"), req.get("hi")
            try:
                vm = build_view_model(path, req.get("transpose", 0), lo, hi)
            except Exception as e:                          # noqa: BLE001
                self.send_error(500, f"parse failed: {e}")
                return
            conductor.load(vm, req.get("play"), lo, hi, path)
            self._json(vm)                                  # browser renders from this
        elif cmd == "play":
            conductor.play(); self._json({"ok": True})
        elif cmd == "stop":
            conductor.stop(); self._json({"ok": True})
        elif cmd == "reset":
            conductor.rewind(); self._json({"ok": True})
        elif cmd == "play_parts":
            conductor.set_play(req.get("channels")); self._json({"ok": True})
        elif cmd == "mode":
            conductor.set_mode(req.get("mode", "follow")); self._json({"ok": True})
        elif cmd == "speed":
            conductor.set_speed(req.get("mult", 1.0)); self._json({"ok": True})
        elif cmd == "loop":
            conductor.set_loop(req.get("start"), req.get("end")); self._json({"ok": True})
        elif cmd == "range":
            conductor.set_range(req.get("lo"), req.get("hi")); self._json({"ok": True})
        elif cmd == "seek":
            conductor.seek(req.get("t")); self._json({"ok": True})
        elif cmd == "save_settings":
            f = req.get("file", "")
            if _is_allowed_song(f):
                _save_settings_for(os.path.realpath(f), req.get("settings"))
            self._json({"ok": True})
        elif cmd == "favorite":
            f = req.get("file", "")
            if _is_allowed_song(f):
                _save_settings_for(os.path.realpath(f), {"fav": bool(req.get("on"))})
            self._json({"ok": True})
        elif cmd == "played":
            f = req.get("file", "")
            if _is_allowed_song(f):
                _save_settings_for(os.path.realpath(f), {"played": time.time()})
            self._json({"ok": True})
        elif cmd == "part":
            conductor.set_part(req.get("ch"), req.get("mute"), req.get("program")); self._json({"ok": True})
        else:
            self.send_error(400, "unknown cmd")

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
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            dest = os.path.join(UPLOAD_DIR, safe)
            with open(dest, "wb") as f:
                f.write(data)
        except OSError as e:                                    # noqa: BLE001
            self.send_error(500, f"save failed: {e}"); return
        self._json({"ok": True, "file": os.path.realpath(dest),
                    "title": os.path.splitext(safe)[0].replace("_", " ")})

    def _song(self, qs):
        path = (qs.get("file") or [""])[0]
        if not path or not _is_allowed_song(path):
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
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
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
    args = ap.parse_args()
    threading.Thread(target=midi_reader, args=(args.midi,), daemon=True).start()
    print(f"PiTV server: http://0.0.0.0:{args.port}  (MIDI: {args.midi})", flush=True)
    print(f"song roots: {[r for r in SONG_ROOTS if os.path.isdir(r)]}", flush=True)
    Server(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
