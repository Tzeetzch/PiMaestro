#!/usr/bin/env python3
"""Parse a MIDI file into timed note events for the falling-notes engine.

Headless and dependency-light (just `mido`) so it can be unit-tested without a
display. Tempo-map aware: note times are real seconds, honouring every tempo
change (important — see docs/FINDINGS.md, some pieces have 169 of them).

Run directly for a self-test:
    py engine/chart.py samples/piano_entertainer.mid --mode piano
    py engine/chart.py samples/multi_chrono-battle.mid --mode drums
"""
import argparse
import bisect
import mido

DRUM_CHANNEL = 9  # zero-based; MIDI channel 10


class Note:
    __slots__ = ("start", "dur", "pitch", "velocity", "channel")

    def __init__(self, start, dur, pitch, velocity, channel):
        self.start = start
        self.dur = dur
        self.pitch = pitch
        self.velocity = velocity
        self.channel = channel

    def __repr__(self):
        return f"Note(t={self.start:.2f}s dur={self.dur:.2f} p={self.pitch} v={self.velocity})"


def _build_tick_to_sec(mid):
    """Return a function mapping absolute ticks -> seconds via the tempo map."""
    tpb = mid.ticks_per_beat
    changes = []
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type == "set_tempo":
                changes.append((t, msg.tempo))
    changes.sort(key=lambda c: c[0])
    if not changes or changes[0][0] != 0:
        changes.insert(0, (0, 500000))  # default 120 BPM

    ticks, secs, tempos = [], [], []
    sec = 0.0
    for i, (tk, tempo) in enumerate(changes):
        if i > 0:
            sec += mido.tick2second(tk - ticks[-1], tpb, tempos[-1])
        ticks.append(tk)
        secs.append(sec)
        tempos.append(tempo)

    def t2s(abs_tick):
        idx = bisect.bisect_right(ticks, abs_tick) - 1
        if idx < 0:
            idx = 0
        return secs[idx] + mido.tick2second(abs_tick - ticks[idx], tpb, tempos[idx])

    return t2s


def track_summaries(mid):
    out = []
    for i, track in enumerate(mid.tracks):
        name, channels, n = "", set(), 0
        for msg in track:
            if msg.type == "track_name":
                name = msg.name.strip()
            elif msg.type == "note_on" and msg.velocity > 0:
                n += 1
                channels.add(msg.channel)
        out.append((i, name, channels, n))
    return out


def pick_track(mid, mode):
    info = track_summaries(mid)
    if mode == "drums":
        cand = [t for t in info if DRUM_CHANNEL in t[2]]
        return max(cand, key=lambda t: t[3])[0] if cand else None
    # piano / melody: the busiest non-drum track
    cand = [t for t in info if t[3] > 0 and DRUM_CHANNEL not in t[2]]
    if not cand:
        cand = [t for t in info if t[3] > 0]
    return max(cand, key=lambda t: t[3])[0] if cand else None


def _extract(track, t2s):
    t = 0
    pending = {}  # (channel, pitch) -> (start_tick, velocity)
    notes = []
    for msg in track:
        t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            pending[(msg.channel, msg.note)] = (t, msg.velocity)
        elif msg.type in ("note_off",) or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.channel, msg.note)
            if key in pending:
                st, vel = pending.pop(key)
                start = t2s(st)
                notes.append(Note(start, max(t2s(t) - start, 0.0), msg.note, vel, msg.channel))
    # flush un-closed notes (common for drums) as zero-length hits
    for (ch, pitch), (st, vel) in pending.items():
        notes.append(Note(t2s(st), 0.0, pitch, vel, ch))
    notes.sort(key=lambda n: n.start)
    return notes


def load_chart(path, mode="piano", track_index=None):
    mid = mido.MidiFile(path)
    t2s = _build_tick_to_sec(mid)
    if track_index is None:
        track_index = pick_track(mid, mode)
    notes = _extract(mid.tracks[track_index], t2s) if track_index is not None else []
    return {
        "path": path,
        "mode": mode,
        "track": track_index,
        "ticks_per_beat": mid.ticks_per_beat,
        "duration": mid.length,
        "notes": notes,
    }


def _selftest(path, mode):
    c = load_chart(path, mode=mode)
    notes = c["notes"]
    print(f"\n{path}  [mode={mode}]")
    print(f"  picked track {c['track']}, duration ~{c['duration']:.1f}s, {len(notes)} notes")
    if notes:
        pitches = [n.pitch for n in notes]
        print(f"  pitch range {min(pitches)}–{max(pitches)}, "
              f"time {notes[0].start:.2f}s … {notes[-1].start:.2f}s")
        print(f"  first 5: {notes[:5]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--mode", default="piano", choices=["piano", "drums"])
    args = ap.parse_args()
    for f in args.files:
        _selftest(f, args.mode)
