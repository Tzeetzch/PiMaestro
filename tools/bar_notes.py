#!/usr/bin/env python3
"""List the notes in/around a given bar of a MIDI file, with pitch names.

Usage: py tools/bar_notes.py <file.mid> <bar> [range]
"""
import sys
import mido

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pname(p):
    return f"{NAMES[p % 12]}{p // 12 - 1}"


def main():
    path, target = sys.argv[1], int(sys.argv[2])
    rng = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    mid = mido.MidiFile(path)
    ppqn = mid.ticks_per_beat

    sigs = []
    for tr in mid.tracks:
        t = 0
        for m in tr:
            t += m.time
            if m.type == "time_signature":
                sigs.append((t, m.numerator, m.denominator))
    sigs = sorted(sigs)
    num, den = (sigs[0][1], sigs[0][2]) if sigs and sigs[0][0] == 0 else (4, 4)
    tpb = ppqn * 4 * num // den  # ticks per bar
    print(f"ppqn={ppqn}  first time-sig={num}/{den}  ticks/bar={tpb}  "
          f"(time-sig changes: {len(sigs)})")

    rows = []
    for ti, tr in enumerate(mid.tracks):
        t = 0
        name = ""
        for m in tr:
            t += m.time
            if m.type == "track_name":
                name = m.name.strip()
            if m.type == "note_on" and m.velocity > 0:
                bar = t // tpb + 1
                if target - rng <= bar <= target + rng:
                    beat = (t % tpb) / ppqn + 1
                    rows.append((t, bar, beat, m.note, m.channel, ti, name))
    rows.sort()
    cur = None
    for t, bar, beat, note, ch, ti, name in rows:
        if bar != cur:
            print(f"\n--- bar {bar} ---")
            cur = bar
        star = "  <== C" if note % 12 == 0 else ""
        print(f"  beat {beat:4.2f}  {pname(note):4} (midi {note})  ch{ch+1} trk{ti}:{name[:16]}{star}")


if __name__ == "__main__":
    main()
