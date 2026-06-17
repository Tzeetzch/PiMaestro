"""Conductor — the Follow-You playback brain (runs on the Pi, authoritative).

Ports PianoBooster's Conductor.cpp idea: play the song, but at each note/chord the
player is responsible for, STOP and wait until they actually play it, then advance.
This is what makes pressing a key mean something.

The Pi owns the play-clock and consumes the live MIDI (server feeds note-ons in via
on_note). It streams state out through a callback the server broadcasts over SSE:
  - pos     position heartbeat {t, playing, speed, file, waiting, wanted, timing, ...}
            (throttled to ~4 Hz in server.py; tagged seek=True on a jump so it's never dropped)
  - gate    {gi} — gate `gi` was satisfied; the local-clock client unfreezes here
  - rating  {kind, off, gate, gi} — per-chord feedback (early/good/late/miss/wrong)
The browser runs its own rAF clock corrected by `pos`, freezes at gates, and resumes on
`gate`. Timing + input-matching live here, in one place. See docs/ARCHITECTURE.md.
"""
from __future__ import annotations

import queue
import socket
import threading
import time

from .scorekeeper import ScoreKeeper, EARLY_WINDOW   # the timing judge + the shared "near the line" window

LOOKAHEAD = 3.5          # seconds of lead-in (notes fall from the top before t=0)
TICK = 0.025             # ~40 Hz play-clock tick (pos frames are throttled to ~4 Hz in server.py)
AT_LINE_EPS = 0.0010     # tolerance for "note has reached the hit line"
AUTO_VEL = 90            # velocity for auto-played (accompaniment) notes (lacking their own velocity)
AUTO_GAIN = 0.6          # scale accompaniment velocity DOWN so the backing sits under the player's keys
MASTER_GAIN = 0.7        # FluidSynth master gain when not Pi-muted (set on load so it never jumps)
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
        # Connection-scoped state cached so we can REPLAY it whenever FluidSynth restarts and we
        # reconnect to a fresh process — otherwise gain/instruments/volumes/keyboard-transpose
        # silently revert to GM defaults mid-song. (prog/cc/gain/transpose are stateful; notes aren't.)
        self._cache_lock = threading.Lock()
        self._gain_val = None
        self._router_semis = 0
        self._progs = {}             # ch -> program
        self._vols = {}              # ch -> CC7 value
        threading.Thread(target=self._worker, daemon=True).start()

    def _send(self, cmd):
        try:
            self._q.put_nowait(cmd)
        except queue.Full:
            pass                       # synth backed up (FluidSynth down?) — drop, never block

    def _router_cmds(self, semis):
        """The FluidSynth command sequence that sets the keyboard de-transpose router."""
        if semis:
            return ["router_clear", "router_begin note",
                    f"router_par1 0 127 1.0 {int(semis)}", "router_end"] + \
                   [c for t in ("cc", "prog", "pbend", "cpress", "kpress")
                      for c in (f"router_begin {t}", "router_end")]
        return ["router_clear", "router_default"]

    def _replay_state(self, sock):
        """Re-send cached connection state on a fresh socket (call right after reconnecting)."""
        with self._cache_lock:
            cmds = []
            if self._gain_val is not None:
                cmds.append(f"gain {self._gain_val}")
            cmds += self._router_cmds(self._router_semis)
            cmds += [f"prog {ch} {p}" for ch, p in self._progs.items()]
            cmds += [f"cc {ch} 7 {v}" for ch, v in self._vols.items()]
        for c in cmds:
            sock.sendall((c + "\n").encode())

    def _worker(self):
        while True:
            cmd = self._q.get()
            if self._sock is None:
                try:
                    self._sock = socket.create_connection(self._addr, timeout=1)
                    self._replay_state(self._sock)   # restore gain/router/progs/vols on (re)connect
                except OSError:
                    self._sock = None
                    continue           # FluidSynth unreachable; drop this cmd, try the next
            try:
                self._sock.sendall((cmd + "\n").encode())
            except OSError:
                self._sock = None      # dropped; reconnect (and replay) on the next command

    def noteon(self, ch, key, vel):
        self._send(f"noteon {ch} {key} {vel}")

    def noteoff(self, ch, key):
        self._send(f"noteoff {ch} {key}")

    def prog(self, ch, program):
        with self._cache_lock:
            self._progs[int(ch)] = int(program)
        self._send(f"prog {ch} {program}")

    def all_off(self):
        for ch in range(16):
            self._send(f"cc {ch} 123 0")   # all-notes-off controller

    def gain(self, g):
        with self._cache_lock:
            self._gain_val = g
        self._send(f"gain {g}")            # FluidSynth master gain (0 = silent)

    def cc(self, ch, ctrl, val):
        if int(ctrl) == 7:
            with self._cache_lock:
                self._vols[int(ch)] = int(val)
        self._send(f"cc {ch} {ctrl} {val}")   # MIDI control change (e.g. CC7 = channel volume)

    def transpose(self, semis):
        """Transpose the KEYBOARD's incoming MIDI (ALSA->router->synth) by `semis`, so a
        pressed key can sound at a different pitch — in-engine, zero added latency. TCP
        noteon (accompaniment) bypasses the router, so the conductor de-transposes those."""
        with self._cache_lock:
            self._router_semis = int(semis)
        for c in self._router_cmds(semis):
            self._send(c)


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
        self._score = ScoreKeeper(on_state)   # the timing judge: press log, per-chord verdicts, tally
        self._clicks = []        # count-in click times (negative seconds) for the current run
        self._click_i = 0
        self._pi_muted = False   # FluidSynth silenced (a browser device is the speaker)

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
            self._synth.gain(0.0 if self._pi_muted else MASTER_GAIN)   # pin master gain (no jump on first mute)
            self._synth.transpose(-self._shift)        # keyboard sounds DOWN by the shift -> original pitch
            for ch, p in (vm.get("programs") or {}).items():   # match instrument sounds
                self._synth.prog(int(ch), p)
            self._rebuild_auto()
        self._emit(seeked=True)        # other clients see the file change + a forced (un-throttled) frame

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
        self._emit_gates()              # the gate SET changed (part/hand) — the local-clock client must re-freeze on the new gates

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
        self._emit(seeked=True)

    def set_pi_muted(self, on):
        """Silence the Pi's own output (when a browser device is the speaker) via FluidSynth gain.
        Stored + shipped in snapshot so a 2nd client / reconnect reflects the real state, and
        re-applied on load so a song change keeps the mute."""
        with self._lock:
            self._pi_muted = bool(on)
            self._synth.gain(0.0 if self._pi_muted else MASTER_GAIN)
        self._emit()

    def set_part(self, ch, mute=None, program=None, volume=None):
        """Instruments panel: change a part's instrument, volume (CC7), and/or mute it."""
        if ch is None:
            return
        ch = int(ch)
        with self._lock:
            if program is not None:
                self._synth.prog(ch, int(program))
            if volume is not None:
                self._synth.cc(ch, 7, max(0, min(127, int(volume))))   # per-instrument volume
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
        self._emit(seeked=True)

    def rewind(self):
        with self._lock:
            self._playing = False
            if self._loop:                       # Reset returns to the loop's start, not the song's
                self._t = self._loop[0]
                self._seek_to(self._t)
            else:
                self._reset_position()
            self._seek_auto(self._t)
        self._emit(seeked=True)

    # ---- live input (called from MIDI reader thread) ----
    def on_note(self, pitch):
        with self._lock:
            if not self._playing:
                return
            now = time.monotonic()
            self._score.record_press(self._t, pitch, now)   # song-time + real-time of press, for scoring
            if self._gate_idx < len(self._gates):
                gate_t, wanted = self._gates[self._gate_idx]
                near = self._t >= gate_t - EARLY_WINDOW
                if near and pitch in wanted:
                    self._satisfied[pitch] = now            # timestamp -> chord-together check
                elif (near and self._mode == "follow" and self._lo <= pitch <= self._hi
                      and not self._sounds_near(pitch)):
                    # a key with NO note anywhere in the music around now — not yours, not the backing,
                    # not the next chord you're reading into -> a real wrong note. Flash it red.
                    self._score.wrong_note(pitch)

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

    def _sounds_near(self, pitch):
        """Does `pitch` occur ANYWHERE in the song near the playhead (any part)? Used so the backing,
        the other hand, and reading a hair ahead are never mistaken for a wrong note."""
        lo, hi = self._t - 0.3, self._t + 0.5
        for n in self._notes:
            if n["n"] == pitch and lo <= n["t"] <= hi:
                return True
        return False

    def _reset_position(self):
        self._t = -LOOKAHEAD
        self._gate_idx = 0
        self._satisfied = {}
        self._score.reset(self._gate_idx)

    def _seek_to(self, t):
        self._gate_idx = 0
        self._satisfied = {}
        while self._gate_idx < len(self._gates) and self._gates[self._gate_idx][0] < t - AT_LINE_EPS:
            self._gate_idx += 1
        self._score.reset(self._gate_idx)     # the part/range/position changed — start the tally fresh

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
            gain = 1.0 if self._mode == "listen" else AUTO_GAIN           # don't duck when listening (it's the song)
            bvel = max(1, min(127, int(vel * gain)))                      # else backing sits UNDER the player's keys
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
        # Wanted pitches the player has pressed for the CURRENT gate. Once a correct note is
        # played it LATCHES until the gate advances — it does NOT decay by wall-clock. That is
        # what makes slow practice and spread-out chords work: at 0.5x a note pressed 0.30s
        # (song) early takes 0.60s (real) to reach the line, and a beginner may spread a chord
        # over seconds; neither should evaporate the press. EARLY_WINDOW (song-time, in on_note)
        # still stops a way-too-early press from counting; _satisfied is cleared on gate advance
        # (and on seek/reset), so a press can never leak to the next gate. Chord-togetherness is
        # intentionally NOT separately scored (Follow stays forgiving); add it in ScoreKeeper.finalize if wanted.
        return set(self._satisfied)

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
                # This gate is satisfied — tell the local-clock client to unfreeze HERE, tagged
                # with the freeze cursor (not the scoring cursor), so the two can't diverge (R.4).
                self._on_state({"type": "gate", "gi": self._gate_idx})
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
            "speed": self._speed,          # so a 2nd client's local clock tracks a speed change
            "waiting": waiting,
            "wanted": wanted,
            "timing": self._score.tally(self._mode != "listen"),   # early/good/late tallies (Follow + Play-along)
        }

    def _emit(self, seeked=False):
        with self._lock:
            frame = self._state_locked()
        if seeked:
            frame["seek"] = True       # a position jump (seek/loop/reset/load): server never throttles it
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
            frame["pi_muted"] = self._pi_muted       # so a reconnect/2nd client shows the real mute state
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
                looped = False
                if not self._waiting():
                    self._t += dt * self._speed
                    while self._click_i < len(self._clicks) and self._t >= self._clicks[self._click_i]:
                        self._synth.noteon(CLICK_CH, CLICK_NOTE, CLICK_VEL)   # count-in tick (Pi sound only)
                        self._click_i += 1
                    if self._loop and self._t >= self._loop[1]:   # reached loop end -> jump back
                        self._t = self._loop[0]
                        self._seek_to(self._t)
                        self._seek_auto(self._t)
                        looped = True
                    if self._mode == "follow":
                        self._advance_gates()        # only Follow-You freezes at gates
                    if self._mode != "listen":
                        self._score.finalize(self._t, self._gates, now)   # rate each chord early/good/late as it passes
                    self._service_auto()             # play the accompaniment up to here
                    if self._t >= self._duration + 1.0:
                        self._playing = False
                        ended = True                 # song finished on its own
                        self._synth.all_off(); self._sounding = []
                frame = self._state_locked()
                if ended:
                    frame["ended"] = True
                if looped:
                    frame["seek"] = True       # backward jump on loop wrap: don't let the throttle drop it
            self._on_state(frame)
