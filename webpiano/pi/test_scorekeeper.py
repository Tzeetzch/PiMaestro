#!/usr/bin/env python3
"""Synthetic unit tests for the timing judge (engine/scorekeeper.py) — no keyboard, no FluidSynth.

The scorer is pure logic (presses + gates in, rating verdicts out), so it can be tested with
synthetic input. This is the start of the engine test harness docs/ARCHITECTURE.md asks for.
Run from the webpiano dir:  python3 pi/test_scorekeeper.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # -> webpiano/
from engine.scorekeeper import ScoreKeeper


def run():
    fails = []

    def check(name, cond):
        print(("  ok  " if cond else " FAIL ") + name)
        if not cond:
            fails.append(name)

    G = lambda t, *ps: (t, frozenset(ps))   # a gate: (song-time, {pitches})

    # 1. GOOD — pressed right at the line
    sk = ScoreKeeper(lambda f: None); sk.reset(0)
    sk.record_press(1.00, 60, 100.0)
    sk.finalize(1.00, [G(1.0, 60)], 100.0)
    check("press at the line -> 1 good", sk.tally(True)["good"] == 1)

    # 2. EARLY — finished well before the line (song-time)
    sk = ScoreKeeper(lambda f: None); sk.reset(0)
    sk.record_press(0.85, 60, 100.0)        # 0.15s (song) before gt=1.0, beyond EARLY_TOL (0.07)
    sk.finalize(1.00, [G(1.0, 60)], 100.0)
    check("press before the line -> 1 early", sk.tally(True)["early"] == 1)

    # 3. LATE — completed after the line (real seconds past arrival)
    sk = ScoreKeeper(lambda f: None); sk.reset(0)
    sk.finalize(1.00, [G(1.0, 60)], 100.0)  # chord reaches the line now -> arrival=100.0, still pending
    sk.record_press(1.00, 60, 100.25)       # played 0.25s real later (> LATE_TOL 0.15)
    sk.finalize(1.00, [G(1.0, 60)], 100.25)
    check("press 0.25s real-late -> 1 late", sk.tally(True)["late"] == 1)

    # 4. MISS — never played; clock passes the give-up window
    sk = ScoreKeeper(lambda f: None); sk.reset(0)
    sk.finalize(1.0 + ScoreKeeper.RATE_GIVEUP + 0.1, [G(1.0, 60)], 100.0)
    check("no press past give-up -> 1 miss", sk.tally(True)["miss"] == 1)

    # 5. THE FIX — a later press of the SAME pitch (its next occurrence) must NOT satisfy an earlier
    #    missed gate. Gate at t=1.0; the only press of pitch 60 is at t=2.0 (> gt+RATE_GIVEUP=1.6).
    sk = ScoreKeeper(lambda f: None); sk.reset(0)
    sk.record_press(2.00, 60, 102.0)        # the NEXT note's press, well after this gate's window
    sk.finalize(2.50, [G(1.0, 60)], 102.5)
    t = sk.tally(True)
    check("future same-pitch press does NOT satisfy a missed gate -> miss, not good",
          t["miss"] == 1 and t["good"] == 0 and t["late"] == 0)

    # 6. CHORD — both notes needed; one pressed, one missing -> still pending, not 'good'
    sk = ScoreKeeper(lambda f: None); sk.reset(0)
    sk.record_press(1.00, 60, 100.0)        # only one of the two chord notes
    sk.finalize(1.00, [G(1.0, 60, 64)], 100.0)
    check("incomplete chord at the line -> not yet good", sk.tally(True)["good"] == 0)
    sk.record_press(1.02, 64, 100.02)       # the second note arrives
    sk.finalize(1.02, [G(1.0, 60, 64)], 100.02)
    check("completed chord -> 1 good", sk.tally(True)["good"] == 1)

    print()
    if fails:
        print(f"RESULT: FAIL ({len(fails)} failed)")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(run())
