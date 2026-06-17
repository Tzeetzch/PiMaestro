#!/usr/bin/env python3
"""Generate a graded set of drum-groove MIDIs (GM drums, channel 10) for PiMaestro.

These are practice grooves, not copyrighted songs: easy -> medium, "work your way up". Each is a
short loop repeated for a few bars so there's something to play/listen along to. Written as a
minimal Standard MIDI File (format 0) in pure Python — no mido/external deps, so it runs anywhere.

Run:  python3 webpiano/pi/gen_drum_grooves.py
Writes into webpiano/songs/Drums/ (a song root that ships with the app) -> the "Drums" group.
"""
import os
import struct

PPQ = 480
OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "songs", "Drums"))

# General MIDI drum note numbers
K, S, H, O, R, C = 36, 38, 42, 46, 51, 49        # kick, snare, closed hat, open hat, ride, crash
T1, T2, T3 = 48, 45, 43                            # hi tom, mid tom, floor tom
VEL = {K: 110, S: 105, H: 80, O: 95, R: 88, C: 120, T1: 100, T2: 100, T3: 100}

# Each groove: (filename, bpm, grid, bars, base, fill, fill_bars)
#   grid = steps per 4/4 bar (16 = straight 16ths, 12 = triplet/shuffle feel)
#   base/fill = {note: [step indices]}  ;  fill_bars = 0-based bars that use `fill`
def E(*pairs):  # build a {note:[steps]} dict
    return {n: list(steps) for n, steps in pairs}

GROOVES = [
    ("01 Kick Pulse",          70, 16, 8, E((K, (0, 4, 8, 12))), None, ()),
    ("02 Backbeat Snare",      70, 16, 8, E((S, (4, 12))), None, ()),
    ("03 Kick and Snare",      75, 16, 8, E((K, (0, 8)), (S, (4, 12))), None, ()),
    ("04 Quarter Hats",        80, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, (0, 4, 8, 12))), None, ()),
    ("05 Basic Rock Beat",     85, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("06 Rock Two Kicks",      85, 16, 8, E((K, (0, 8, 10)), (S, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("07 Driving Eighths",     90, 16, 8, E((K, (0, 6, 8, 14)), (S, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("08 Off-Beat Kick",       90, 16, 8, E((K, (0, 8, 11)), (S, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("09 Open Hat Accent",     90, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, (0, 2, 4, 6, 8, 10, 12)), (O, (14,))), None, ()),
    ("10 Half-Time Groove",    95, 16, 8, E((K, (0,)), (S, (8,)), (H, range(0, 16, 2))), None, ()),
    ("11 Four on the Floor",  110, 16, 8, E((K, (0, 4, 8, 12)), (S, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("12 Disco Open Hats",    112, 16, 8, E((K, (0, 4, 8, 12)), (S, (4, 12)), (H, (0, 4, 8, 12)), (O, (2, 6, 10, 14))), None, ()),
    ("13 Sixteenth Hats",      85, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, range(0, 16))), None, ()),
    ("14 Syncopated Funk",     95, 16, 8, E((K, (0, 3, 6, 8, 14)), (S, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("15 Ride Groove",         92, 16, 8, E((K, (0, 8)), (S, (4, 12)), (R, range(0, 16, 2)), (C, (0,))), None, ()),
    ("16 Tom Beat",            95, 16, 8, E((K, (0, 8)), (T3, (4, 12)), (H, range(0, 16, 2))), None, ()),
    ("17 Groove with Fill",    95, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, range(0, 16, 2))),
        E((S, (0, 2, 4, 6)), (T1, (8, 10)), (T2, (12,)), (T3, (14,)), (K, (0,))), (3, 7)),
    ("18 Eighth Tom Fill",    100, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, range(0, 16, 2))),
        E((S, (0, 2)), (T1, (4, 6)), (T2, (8, 10)), (T3, (12, 14)), (K, (0,))), (3, 7)),
    ("19 Crash Groove",       100, 16, 8, E((K, (0, 8)), (S, (4, 12)), (H, range(0, 16, 2)), (C, (0,))),
        E((S, (0, 2, 4)), (T2, (6, 8)), (T3, (10, 12, 14)), (K, (0,))), (7,)),
    ("20 Shuffle Feel",        95, 12, 8, E((K, (0, 6)), (S, (3, 9)), (H, (0, 2, 3, 5, 6, 8, 9, 11))), None, ()),
]


def vlq(n):
    out = bytearray([n & 0x7F])
    n >>= 7
    while n:
        out.insert(0, (n & 0x7F) | 0x80)
        n >>= 7
    return bytes(out)


def build(groove):
    name, bpm, grid, bars, base, fill, fill_bars = groove
    step_ticks = (PPQ * 4) // grid
    song_end = bars * grid * step_ticks
    # Collect each instrument's onsets, then give every hit a NOTE VALUE = gap to its next hit
    # (capped at a quarter). That's what makes the notation read right — 8th hats -> 8th notes,
    # quarter kicks -> quarter notes — instead of everything looking like 16ths.
    onsets = {}
    for b in range(bars):
        pat = fill if (fill and b in fill_bars) else base
        bar_tick = b * grid * step_ticks
        for note, steps in pat.items():
            for st in steps:
                onsets.setdefault(note, []).append(bar_tick + st * step_ticks)
    events = []  # (abs_tick, order, bytes)  order: 0=off before 1=on at same tick
    for note, ts in onsets.items():
        ts.sort()
        v = VEL.get(note, 100)
        for i, t in enumerate(ts):
            nxt = ts[i + 1] if i + 1 < len(ts) else song_end
            dur = max(60, min(PPQ, nxt - t))                            # 16th..quarter
            events.append((t, 1, bytes([0x99, note, v])))               # note on, ch10
            events.append((t + dur, 0, bytes([0x89, note, 0])))         # note off
    events.sort(key=lambda e: (e[0], e[1]))

    track = bytearray()
    track += vlq(0) + b"\xFF\x03" + vlq(len(name)) + name.encode()      # track name
    us = 60_000_000 // bpm
    track += vlq(0) + b"\xFF\x51\x03" + struct.pack(">I", us)[1:]       # tempo
    track += vlq(0) + b"\xFF\x58\x04" + bytes([4, 2, 24, 8])            # 4/4
    prev = 0
    for t, _o, data in events:
        track += vlq(t - prev) + data
        prev = t
    track += vlq(0) + b"\xFF\x2F\x00"                                   # end of track

    return (b"MThd" + struct.pack(">IHHH", 6, 0, 1, PPQ)
            + b"MTrk" + struct.pack(">I", len(track)) + bytes(track))


def main():
    os.makedirs(OUT, exist_ok=True)
    for g in GROOVES:
        path = os.path.join(OUT, g[0] + ".mid")
        with open(path, "wb") as f:
            f.write(build(g))
    print("wrote %d grooves to %s" % (len(GROOVES), OUT))


if __name__ == "__main__":
    main()
