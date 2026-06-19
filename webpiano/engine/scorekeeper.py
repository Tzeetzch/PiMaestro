"""ScoreKeeper — the timing judge (runs on the Pi, inside the Conductor).

Split out of conductor.py so the Follow-You GATING (which gates exist, the play-clock, and the
_satisfied latch that decides when to unfreeze) stays separate from SCORING (how well each chord
was played). This half owns:
  - the recent press log (song-time + real-time of every key you hit),
  - the per-chord verdict cursor that walks the gates rating each as early / good / late / miss,
  - the running tally shipped in every `pos` frame,
  - genuine wrong-note flags.

The conductor still owns the gates and the clock; it feeds us presses (record_press), tells us a
press was off the music (wrong_note), and calls finalize() each tick with the current time + gate
list. We emit one `rating` event per chord through the same on_state callback the conductor uses,
so the browser flashes feedback instantly. See docs/ARCHITECTURE.md.
"""
from __future__ import annotations

EARLY_WINDOW = 0.30      # accept a note played up to this much (SONG time) BEFORE the line (forgiving).
                         # Shared with the conductor's gating, so both agree on "near the line".

# GM drum note -> abstract-kit ZONE. MUST stay in sync with KIT_MAP in web/render.js. Drum gating and
# scoring match at this granularity (not exact pitch), so ANY articulation of the right pad counts —
# open/closed/pedal hi-hat all satisfy "hat", crash bow/edge both satisfy "crash" — which is exactly
# what the on-screen kit lights, so the cue and the gate always agree.
DRUM_ZONE = {
    35: "kick", 36: "kick",
    37: "snare", 38: "snare", 39: "snare", 40: "snare",
    42: "hat", 46: "hat", 23: "hat",                       # hi-hat stick: closed / open / half-open
    44: "hatpedal", 21: "hatpedal",                        # hi-hat foot: pedal / splash
    48: "tom1", 50: "tom1", 45: "tom2", 47: "tom2",
    43: "tom3", 58: "tom3", 41: "tom4",                    # Alesis: 43=Tom 3, 41=Tom 4 (separate toms)
    49: "crash1", 52: "crash1", 55: "crash1", 57: "crash2",  # Alesis: 49=Crash 1, 57=Crash 2
    51: "ride", 53: "ride", 54: "ride", 56: "ride", 59: "ride", 69: "ride", 70: "ride", 82: "ride",
}


class ScoreKeeper:
    RATE_GIVEUP = 0.6        # play-along: declare a miss this long (s) after the note's time
    EARLY_TOL = 0.07         # finished earlier than this (s) before the line = "early"
    LATE_TOL = 0.15          # finished later than this (s) = "late"; in between = "good"

    def __init__(self, on_state):
        self._on_state = on_state        # callback(dict): emit one rating frame (the conductor broadcasts it)
        self.reset(0)

    def reset(self, gate_idx):
        """Start the tally fresh from gate `gate_idx` (load / seek / part / range / position change)."""
        self.early = self.good = self.late = self.miss = self.wrong = 0
        self._ptr = gate_idx                  # next gate to rate; skip ones already behind
        self._arrival = None                  # real time the current gate reached the line
        self._played = []                     # recent (song_time, pitch, real_time) presses

    def record_press(self, t, pitch, now):
        """Log a key press: song-time `t` and real-time `now` (so lateness can use either clock)."""
        self._played.append((t, pitch, now))
        if len(self._played) > 128:
            self._played = self._played[-128:]

    def wrong_note(self, pitch):
        """A key with no note anywhere in the music around now — a real wrong note. Flash it red."""
        self.wrong += 1
        self._on_state({"type": "rating", "kind": "wrong", "off": None, "note": pitch})

    def finalize(self, t, gates, now, rhythm=False):
        """Rate each gate at `_ptr` once it's played (or timed out). Timing is in seconds
        early(-)/late(+): finishing BEFORE the line uses song-time; finishing AFTER uses REAL
        time — the song freezes at the line in Follow, so 'how long it waited for you' IS the
        lateness. Emits a 'rating' event per chord for instant feedback. `rhythm` (drum part):
        any tap (any pitch) near the line counts, so we rate on TIMING alone, not pitch match."""
        while self._ptr < len(gates):
            gt, wanted = gates[self._ptr]
            if t >= gt and self._arrival is None:
                self._arrival = now                               # chord reached the line now
            # a press counts for this gate only within its window: from EARLY_WINDOW before the line
            # to RATE_GIVEUP after it. Without the upper bound, a LATER press of the same pitch (the
            # next time that note occurs) could retroactively "satisfy" a chord the player actually missed.
            if rhythm:                                            # DRUMS: require each due ZONE to be hit
                # Match each due kit-zone to a hit of that zone (any articulation), within a window
                # bounded to the MIDPOINTS of adjacent gates so one tap can't be credited to two close
                # beats (dense drum lines) — keeping the early/good/late tally honest.
                lo_t, hi_t = gt - EARLY_WINDOW, gt + self.RATE_GIVEUP
                if self._ptr > 0:
                    lo_t = max(lo_t, (gates[self._ptr - 1][0] + gt) / 2)
                if self._ptr + 1 < len(gates):
                    hi_t = min(hi_t, (gt + gates[self._ptr + 1][0]) / 2)
                sel, ok = [], True
                for z in {DRUM_ZONE.get(w) for w in wanted}:
                    cands = [(pt, rt) for (pt, pp, rt) in self._played
                             if DRUM_ZONE.get(pp) == z and lo_t <= pt <= hi_t]
                    if not cands:
                        ok = False
                        break
                    sel.append(min(cands, key=lambda c: abs(c[0] - gt)))
            else:
                sel, ok = [], True
                for w in wanted:
                    cands = [(pt, rt) for (pt, pp, rt) in self._played
                             if pp == w and gt - EARLY_WINDOW <= pt <= gt + self.RATE_GIVEUP]
                    if not cands:
                        ok = False
                        break
                    sel.append(min(cands, key=lambda c: abs(c[0] - gt)))   # press nearest the line
            if ok:
                comp_song = max(c[0] for c in sel)                # when the chord was completed
                comp_real = max(c[1] for c in sel)
                if comp_song < gt - 0.02:
                    off = comp_song - gt                          # finished before the line: early
                elif self._arrival is not None:
                    off = comp_real - self._arrival               # after the line: real seconds late
                else:
                    off = comp_song - gt
                kind = "early" if off < -self.EARLY_TOL else ("late" if off > self.LATE_TOL else "good")
                setattr(self, kind, getattr(self, kind) + 1)
                # gate/gi tag the verdict so a local-clock client knows WHICH gate to clear+resume (R.4)
                self._on_state({"type": "rating", "kind": kind, "off": round(off, 3), "gate": round(gt, 3), "gi": self._ptr})
            elif t > gt + self.RATE_GIVEUP:                       # play-along: you never played it
                self.miss += 1
                self._on_state({"type": "rating", "kind": "miss", "off": None, "gate": round(gt, 3), "gi": self._ptr})
            else:
                break                                             # current chord still pending
            self._ptr += 1
            self._arrival = None

    def tally(self, scored):
        """The early/good/late/miss/wrong counts for the `pos` heartbeat. `scored` is False in
        Listen mode (nothing is graded), which the browser shows as 'Timing: —'."""
        return {"early": self.early, "good": self.good, "late": self.late,
                "miss": self.miss, "wrong": self.wrong, "on": scored}
