"""Conductor — the Follow-You playback brain (runs on the Pi, authoritative).

Ports PianoBooster's Conductor.cpp idea: play the song, but at each note/chord the
player is responsible for, STOP and wait until they actually play it, then advance.
This is what makes pressing a key mean something.

The Pi owns the play-clock and consumes the live MIDI (server feeds note-ons in via
on_note). It streams state out through a callback — {type:'pos', t, playing, waiting,
wanted:[...]} — which the server broadcasts over SSE. The browser is a thin view that
renders `t` and highlights `wanted`. Timing + input-matching live here, in one place
(scoring will reuse the same matching). See docs/ARCHITECTURE.md.
"""
from __future__ import annotations

import queue
import socket
import threading
import time

LOOKAHEAD = 3.5          # seconds of lead-in (notes fall from the top before t=0)
TICK = 0.025             # ~40 Hz play-clock / state stream
AT_LINE_EPS = 0.0010     # tolerance for "note has reached the hit line"
EARLY_WINDOW = 0.15      # accept a note this much BEFORE the line; earlier than this = "too early", keep waiting
CHORD_WINDOW = 0.45      # all notes of a chord must be pressed within this of each other
AUTO_VEL = 90            # velocity for auto-played (accompaniment) notes (lacking their own velocity)
AUTO_GAIN = 0.6          # scale accompaniment velocity DOWN so the backing sits under the player's keys
COUNT_IN = 4             # metronome clicks during the pre-roll, so the player knows when to start
CLICK_CH, CLICK_NOTE, CLICK_VEL = 9, 76, 100   # GM drums: Hi Wood Block
HOLD_EPS = 0.03          # accompaniment within this of a pending gate is held until you play it


class _Synth:
    """Tiny client for FluidSynth's TCP command server (it runs with -s on :9800).
    Lets the conductor play the parts the player isn't covering, locally on the Pi, in
    sync with the play-clock and through the same synth as the player's own keys."""

    def __init__(self, host="127.0.0.1", port=9800):
        self._addr = (host, port)
        self._sock = None
        # commands go on a queue; a background thread does the BLOCKING socket I/O, so callers
        # (the conductor, while holding its lock) never block on the network — keeping live
        # MIDI matching responsive even if FluidSynth stalls. FIFO + single worker keeps order.
        self._q = queue.Queue(maxsize=4096)
        threading.Thread(target=self._worker, daemon=True).start()

    def _send(self, cmd):
        try:
            self._q.put_nowait(cmd)
        except queue.Full:
            pass                       # synth backed up (FluidSynth down?) — drop, never block

    def _worker(self):
        while True:
            cmd = self._q.get()
            if self._sock is None:
                try:
                    self._sock = socket.create_connection(self._addr, timeout=1)
                except OSError:
                    self._sock = None
                    continue           # FluidSynth unreachable; drop this cmd, try the next
            try:
                self._sock.sendall((cmd + "\n").encode())
            except OSError:
                self._sock = None      # dropped; reconnect on the next command

    def noteon(self, ch, key, vel):
        self._send(f"noteon {ch} {key} {vel}")

    def noteoff(self, ch, key):
        self._send(f"noteoff {ch} {key}")

    def prog(self, ch, program):
        self._send(f"prog {ch} {program}")

    def all_off(self):
        for ch in range(16):
            self._send(f"cc {ch} 123 0")   # all-notes-off controller

    def gain(self, g):
        self._send(f"gain {g}")            # FluidSynth master gain (0 = silent)

    def transpose(self, semis):
        """Transpose the KEYBOARD's incoming MIDI (ALSA->router->synth) by `semis`, so a
        pressed key can sound at a different pitch — in-engine, zero added latency. TCP
        noteon (accompaniment) bypasses the router, so the conductor de-transposes those."""
        self._send("router_clear")
        if semis:
            self._send("router_begin note")
            self._send(f"router_par1 0 127 1.0 {int(semis)}")
            self._send("router_end")
            for t in ("cc", "prog", "pbend", "cpress", "kpress"):
                self._send(f"router_begin {t}"); self._send("router_end")
        else:
            self._send("router_default")


class Conductor:
    def __init__(self, on_state):
        self._on_state = on_state        # callback(dict): broadcast one state frame
        self._lock = threading.Lock()
        self._gen = 0                    # play-thread generation (guards against doubles)

        self._vm = None
        self._file = None                # current song path (so reconnecting clients can resync)
        self._notes = []
        self._duration = 0.0
        self._play = set()               # MIDI channels the player covers (their part)
        self._hand = None                # 'R'/'L' to split a single channel by pitch, else None
        self._mode = "follow"            # follow (waits) / along (continuous) / listen (plays all)
        self._lo, self._hi = 21, 108     # player's keyboard range; notes outside auto-play

        self._gates = []                 # ordered [(t, frozenset(pitches))] for the active hand
        self._gate_idx = 0
        self._satisfied = {}          # wanted pitches played for the current gate

        self._t = -LOOKAHEAD
        self._speed = 1.0                # playback speed multiplier (practise slow, ramp up)
        self._loop = None                # (start_sec, end_sec) to repeat, or None — drill a passage
        self._playing = False
        self._synth = _Synth()
        self._shift = 0          # song's octave transpose; we de-transpose the SOUND to play it at original pitch
        self._auto = []          # [(start, end, ch, pitch)] notes played FOR the player
        self._auto_i = 0         # next auto note to start
        self._sounding = []      # [(end, ch, pitch)] auto notes currently ringing
        self._muted = set()      # channels the user muted (skipped in accompaniment)
        self._played = []        # recent (song_time, pitch) you pressed — for scoring
        self._clicks = []        # count-in click times (negative seconds) for the current run
        self._click_i = 0
        self._reset_rating()

    def _resync_after_change(self):
        """Re-derive gates + accompaniment after a part/range/mode change, keeping position.
        One place so the three steps can't drift out of order across the control methods."""
        self._rebuild_gates()
        self._seek_to(self._t)
        self._rebuild_auto()

    # ---- control (called from HTTP handler thread) ----
    def load(self, vm, play=None, lo=None, hi=None, file=None):
        with self._lock:
            if lo is not None and hi is not None:
                self._lo, self._hi = int(lo), int(hi)
            self._vm = vm
            self._file = file
            self._notes = vm.get("notes", [])
            self._duration = vm.get("duration", 0.0)
            if play is not None:
                self._play = set(int(c) for c in play)
            else:                                              # default: both detected hands
                self._play = set(c for c in (vm.get("rightChan"), vm.get("leftChan")) if c is not None)
            self._muted = set()
            self._rebuild_gates()
            vm["gates"] = [round(t, 3) for t, _ in self._gates]   # ship gates IN the load response (no SSE race)
            self._reset_position()
            self._playing = False
            # SOUND at the song's ORIGINAL pitch even when the notes are shown shifted to fit
            # the keyboard: de-transpose the keyboard (router) + the accompaniment (below).
            self._shift = int(vm.get("transpose", 0) or 0)
            self._synth.transpose(-self._shift)        # keyboard sounds DOWN by the shift -> original pitch
            for ch, p in (vm.get("programs") or {}).items():   # match instrument sounds
                self._synth.prog(int(ch), p)
            self._rebuild_auto()
        self._emit()
        self._emit_gates()

    def set_play(self, channels, hand=None):
        """Choose which part(s) the player covers — a set of MIDI channels, optionally
        narrowed to one hand ('R'/'L') by pitch, for single-channel (one-track) songs."""
        with self._lock:
            self._play = set(int(c) for c in (channels or []))
            self._hand = hand if hand in ("R", "L") else None
            self._rebuild_gates()
            self._seek_to(self._t)       # keep position, recompute current gate
            self._rebuild_auto()         # the rest becomes backing
        self._emit()

    def set_range(self, lo, hi):
        """Tell the engine the player's keyboard range. Notes outside it can't be played,
        so they drop out of the gates and get auto-played (you still hear them)."""
        try:
            lo, hi = int(lo), int(hi)
        except (TypeError, ValueError):
            return
        with self._lock:
            self._lo, self._hi = lo, hi
            self._resync_after_change()
        self._emit()
        self._emit_gates()

    def set_mode(self, mode):
        with self._lock:
            self._mode = mode if mode in ("follow", "along", "listen") else "follow"
            self._resync_after_change()         # listen plays every part; follow/along mute yours
        self._emit()

    def set_speed(self, mult):
        """Playback speed multiplier. Scales the whole timeline — gates and accompaniment
        derive from self._t, so they follow for free. Clamped to a sane practise range."""
        try:
            m = float(mult)
        except (TypeError, ValueError):
            return
        with self._lock:
            self._speed = max(0.25, min(2.0, m))
        self._emit()

    def set_loop(self, start, end):
        """Repeat a bar range to drill it (start/end in seconds). None clears the loop.
        Setting a loop parks the playhead at its start so Play begins the passage."""
        with self._lock:
            if start is None or end is None:
                self._loop = None
            else:
                try:
                    a, b = float(start), float(end)
                except (TypeError, ValueError):
                    return
                if b <= a:
                    self._loop = None
                else:
                    self._loop = (a, b)
                    self._t = a
                    self._seek_to(a)
                    self._seek_auto(a)
        self._emit()

    def set_pi_muted(self, on):
        """Silence the Pi's own output (when a browser device is the speaker) via FluidSynth gain."""
        self._synth.gain(0.0 if on else 0.7)

    def set_part(self, ch, mute=None, program=None):
        """Instruments panel: change a part's instrument and/or mute it (accompaniment)."""
        if ch is None:
            return
        ch = int(ch)
        with self._lock:
            if program is not None:
                self._synth.prog(ch, int(program))
            if mute is not None:
                self._muted.discard(ch) if not mute else self._muted.add(ch)
                self._rebuild_auto()
        self._emit()

    def play(self):
        with self._lock:
            if not self._vm or self._playing:        # already playing -> no second thread
                return
            if self._t >= self._duration:
                self._reset_position()
                self._seek_auto(self._t)
            self._playing = True
            self._gen += 1
            gen = self._gen
            # count-in clicks during the pre-roll, spaced at the song's opening beat interval
            self._clicks, self._click_i = [], 0
            if self._t < 0:
                beats = (self._vm or {}).get("beats") or []
                spb = (beats[1] - beats[0]) if len(beats) >= 2 else 0.5
                spb = max(0.2, min(1.5, spb))
                self._clicks = sorted(-i * spb for i in range(1, COUNT_IN + 1) if -i * spb > -LOOKAHEAD)
        threading.Thread(target=self._run, args=(gen,), daemon=True).start()

    def stop(self):
        with self._lock:
            self._playing = False
            self._synth.all_off()        # silence the accompaniment when paused
            self._sounding = []
        self._emit()

    def seek(self, t):
        """Jump the playhead to time t (seconds). Works while playing or stopped."""
        try:
            t = float(t)
        except (TypeError, ValueError):
            return
        with self._lock:
            self._t = max(-LOOKAHEAD, min(t, self._duration))
            self._seek_to(self._t)       # recompute current gate + reset the timing tally
            self._seek_auto(self._t)     # re-cue the accompaniment
        self._emit()

    def rewind(self):
        with self._lock:
            self._playing = False
            if self._loop:                       # Reset returns to the loop's start, not the song's
                self._t = self._loop[0]
                self._seek_to(self._t)
            else:
                self._reset_position()
            self._seek_auto(self._t)
        self._emit()

    # ---- live input (called from MIDI reader thread) ----
    def on_note(self, pitch):
        with self._lock:
            if not self._playing:
                return
            self._played.append((self._t, pitch, time.monotonic()))   # song-time + real-time of press
            if len(self._played) > 128:
                self._played = self._played[-128:]
            if self._gate_idx < len(self._gates):
                gate_t, wanted = self._gates[self._gate_idx]
                if self._t >= gate_t - EARLY_WINDOW and pitch in wanted:
                    self._satisfied[pitch] = time.monotonic()  # timestamp -> chord-together check

    # ---- internals (call with lock held unless noted) ----
    def _rebuild_gates(self):
        groups: dict[float, set] = {}
        for n in self._notes:
            ch = int(n.get("ch", 0))
            if ch == 9 or not (self._lo <= n["n"] <= self._hi):   # drums / off your keyboard
                continue
            if ch in self._play and (self._hand is None or n.get("hand") == self._hand):
                groups.setdefault(round(n["t"], 3), set()).add(n["n"])
        self._gates = [(t, frozenset(ps)) for t, ps in sorted(groups.items()) if ps]

    def _reset_position(self):
        self._t = -LOOKAHEAD
        self._gate_idx = 0
        self._satisfied = {}
        self._reset_rating()

    def _seek_to(self, t):
        self._gate_idx = 0
        self._satisfied = {}
        while self._gate_idx < len(self._gates) and self._gates[self._gate_idx][0] < t - AT_LINE_EPS:
            self._gate_idx += 1
        self._reset_rating()                  # the part/range/position changed — start the tally fresh

    # ---- timing feedback: rate each chord you play early / good / late (or missed) ----
    RATE_GIVEUP = 0.6        # play-along: declare a miss this long (s) after the note's time
    EARLY_TOL = 0.07         # finished earlier than this (s) before the line = "early"
    LATE_TOL = 0.15          # finished later than this (s) = "late"; in between = "good"
    def _reset_rating(self):
        self._r_early = self._r_good = self._r_late = self._r_miss = 0
        self._rate_ptr = self._gate_idx       # next gate to rate; skip ones already behind
        self._rate_arrival = None             # real time the current gate reached the line
        self._played = []

    def _rate_finalize(self, now):
        """Rate the gate at _rate_ptr once it's played (or timed out). Timing is in seconds
        early(-)/late(+): finishing BEFORE the line uses song-time; finishing AFTER uses REAL
        time — the song freezes at the line in Follow, so 'how long it waited for you' IS the
        lateness. Emits a 'rating' event per chord for instant feedback."""
        while self._rate_ptr < len(self._gates):
            gt, wanted = self._gates[self._rate_ptr]
            if self._t >= gt and self._rate_arrival is None:
                self._rate_arrival = now                          # chord reached the line now
            sel, ok = [], True
            for w in wanted:
                cands = [(pt, rt) for (pt, pp, rt) in self._played if pp == w and pt >= gt - EARLY_WINDOW]
                if not cands:
                    ok = False
                    break
                sel.append(min(cands, key=lambda c: abs(c[0] - gt)))   # press nearest the line
            if ok:
                comp_song = max(c[0] for c in sel)                # when the chord was completed
                comp_real = max(c[1] for c in sel)
                if comp_song < gt - 0.02:
                    off = comp_song - gt                          # finished before the line: early
                elif self._rate_arrival is not None:
                    off = comp_real - self._rate_arrival          # after the line: real seconds late
                else:
                    off = comp_song - gt
                kind = "early" if off < -self.EARLY_TOL else ("late" if off > self.LATE_TOL else "good")
                setattr(self, "_r_" + kind, getattr(self, "_r_" + kind) + 1)
                # gate/gi tag the verdict so a local-clock client knows WHICH gate to clear+resume (R.4)
                self._on_state({"type": "rating", "kind": kind, "off": round(off, 3), "gate": round(gt, 3), "gi": self._rate_ptr})
            elif self._t > gt + self.RATE_GIVEUP:                 # play-along: you never played it
                self._r_miss += 1
                self._on_state({"type": "rating", "kind": "miss", "off": None, "gate": round(gt, 3), "gi": self._rate_ptr})
            else:
                break                                             # current chord still pending
            self._rate_ptr += 1
            self._rate_arrival = None

    # ---- accompaniment (the parts the player is NOT covering) ----
    def _rebuild_auto(self):
        auto = []
        for n in self._notes:
            ch = int(n.get("ch", 0))
            if ch in self._muted:
                continue                                   # muted in the Instruments panel
            reachable = ch != 9 and self._lo <= n["n"] <= self._hi   # on your keyboard?
            mine = (reachable and self._mode != "listen" and ch in self._play
                    and (self._hand is None or n.get("hand") == self._hand))
            if mine:
                continue                                   # you provide it; the rest auto-plays
            auto.append((n["t"], n["t"] + n["d"], ch, n["n"], n.get("v") or AUTO_VEL))
        auto.sort()
        self._auto = auto
        self._seek_auto(self._t)

    def _seek_auto(self, t):
        self._synth.all_off()
        self._sounding = []
        self._auto_i = 0
        while self._auto_i < len(self._auto) and self._auto[self._auto_i][0] < t:
            self._auto_i += 1

    def _service_auto(self):
        # Play accompaniment up to the clock, but NEVER past a gate the player hasn't
        # played yet: notes that fall ON that beat are held until they play it, so the
        # accompaniment sounds together with the player's note. Notes between beats (and
        # any intro before the first gate) still flow at tempo because limit == t there.
        limit = self._t
        if self._mode == "follow" and self._gate_idx < len(self._gates):
            gate_t, wanted = self._gates[self._gate_idx]
            if not wanted.issubset(self._fresh()):
                limit = min(limit, gate_t - HOLD_EPS)
        while self._auto_i < len(self._auto) and self._auto[self._auto_i][0] <= limit:
            _, end, ch, pitch, vel = self._auto[self._auto_i]
            snd = max(0, min(127, pitch - self._shift))                   # play at original pitch
            bvel = max(1, min(127, int(vel * AUTO_GAIN)))                 # backing sits UNDER the player's keys
            self._synth.noteon(ch, snd, bvel)
            self._sounding.append((end, ch, snd))
            self._auto_i += 1
        if self._sounding:
            still = []
            for end, ch, snd in self._sounding:
                if end <= self._t:
                    self._synth.noteoff(ch, snd)
                else:
                    still.append((end, ch, snd))
            self._sounding = still

    def _fresh(self):
        # pitches pressed recently enough to still count toward the current chord — this is
        # what forces a chord to be played together rather than one note at a time.
        cutoff = time.monotonic() - CHORD_WINDOW
        return {p for p, ts in self._satisfied.items() if ts >= cutoff}

    def _waiting(self):
        if self._mode != "follow":       # play-along / listen never stop
            return False
        if self._gate_idx >= len(self._gates):
            return False
        gate_t, wanted = self._gates[self._gate_idx]
        return self._t >= gate_t - AT_LINE_EPS and not wanted.issubset(self._fresh())

    def _advance_gates(self):
        """Step past gates we've reached; clamp+wait at the first unsatisfied one."""
        while self._gate_idx < len(self._gates):
            gate_t, wanted = self._gates[self._gate_idx]
            if self._t < gate_t - AT_LINE_EPS:
                break                                  # haven't reached this gate yet
            if wanted.issubset(self._fresh()):
                self._gate_idx += 1
                self._satisfied = {}
                continue                               # already played: move on
            self._t = gate_t                           # freeze exactly at the line
            break

    def _state_locked(self):
        # waiting/wanted only exist while actually playing, so a Stop (or hand switch)
        # clears the amber highlight instead of leaving it stuck.
        waiting = self._playing and self._waiting()
        wanted = []
        if waiting:
            _, ws = self._gates[self._gate_idx]
            wanted = sorted(ws - self._fresh())
        return {
            "type": "pos",
            "t": round(self._t, 3),
            "file": self._file,            # lets a stale client detect another client switched songs
            "playing": self._playing,
            "waiting": waiting,
            "wanted": wanted,
            "timing": {                                 # early/good/late tallies (Follow + Play-along)
                "early": self._r_early, "good": self._r_good,
                "late": self._r_late, "miss": self._r_miss,
                "on": self._mode != "listen",
            },
        }

    def _emit(self):
        with self._lock:
            frame = self._state_locked()
        self._on_state(frame)

    def _emit_gates(self):
        """Broadcast the current gate times (notes the player must hit). A local-clock client (R.4)
        reads these to know where to freeze; re-sent whenever the gate set changes."""
        with self._lock:
            gates = [round(t, 3) for t, _ in self._gates]
        self._on_state({"type": "gates", "gates": gates})

    def snapshot(self):
        """Full current state for a just-connected client: the loaded song + play position,
        so a fresh/reconnected browser (e.g. the TV) renders the song instead of a blank stage."""
        with self._lock:
            frame = self._state_locked()
            frame["type"] = "hello"
            frame["vm"] = self._vm
            frame["file"] = self._file
            frame["play"] = sorted(self._play)       # authoritative part/hand/mode/speed so a
            frame["hand"] = self._hand               # reconnecting or 2nd client matches the engine
            frame["mode"] = self._mode               # instead of resetting to defaults
            frame["speed"] = self._speed
            frame["gates"] = [round(t, 3) for t, _ in self._gates]   # where Follow-You freezes (R.4)
            return frame

    def _run(self, gen):
        last = time.monotonic()
        while True:
            time.sleep(TICK)
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if gen != self._gen or not self._playing:
                    frame = self._state_locked()
                    self._on_state(frame)
                    return
                ended = False
                if not self._waiting():
                    self._t += dt * self._speed
                    while self._click_i < len(self._clicks) and self._t >= self._clicks[self._click_i]:
                        self._synth.noteon(CLICK_CH, CLICK_NOTE, CLICK_VEL)   # count-in tick (Pi sound only)
                        self._click_i += 1
                    if self._loop and self._t >= self._loop[1]:   # reached loop end -> jump back
                        self._t = self._loop[0]
                        self._seek_to(self._t)
                        self._seek_auto(self._t)
                    if self._mode == "follow":
                        self._advance_gates()        # only Follow-You freezes at gates
                    if self._mode != "listen":
                        self._rate_finalize(now)     # rate each chord early/good/late as it passes
                    self._service_auto()             # play the accompaniment up to here
                    if self._t >= self._duration + 1.0:
                        self._playing = False
                        ended = True                 # song finished on its own
                        self._synth.all_off(); self._sounding = []
                frame = self._state_locked()
                if ended:
                    frame["ended"] = True
            self._on_state(frame)
