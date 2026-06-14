#!/usr/bin/env python3
"""Inspect MIDI files so we understand the chart data we'll be working with.

For each .mid in a folder, report: format, track count, division, duration,
tempo map, and per-track instrument/channel/note info — and crucially whether
a drum track (MIDI channel 10, i.e. zero-based channel 9) is present.

Usage: py tools/analyze_midi.py samples
"""
import sys
import os
import glob
import mido

# Windows consoles default to cp1252; force UTF-8 so non-Latin track names
# (and our em-dash) don't crash printing.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

GM = {  # rough General MIDI program-family labels (program // 8)
    0: "Piano", 1: "Chromatic Perc", 2: "Organ", 3: "Guitar", 4: "Bass",
    5: "Strings", 6: "Ensemble", 7: "Brass", 8: "Reed", 9: "Pipe",
    10: "Synth Lead", 11: "Synth Pad", 12: "Synth FX", 13: "Ethnic",
    14: "Percussive", 15: "Sound FX",
}


def analyze(path):
    mid = mido.MidiFile(path)
    tempos, notes_by_track, drum_notes = [], [], 0
    for i, track in enumerate(mid.tracks):
        name, channels, programs, n_notes, drum = "", set(), set(), 0, 0
        for msg in track:
            if msg.type == "track_name":
                name = msg.name.strip()
            elif msg.type == "set_tempo":
                tempos.append(msg.tempo)
            elif msg.type == "program_change":
                programs.add(msg.program)
                if msg.channel == 9:
                    drum = 1
            elif msg.type == "note_on" and msg.velocity > 0:
                n_notes += 1
                channels.add(msg.channel)
                if msg.channel == 9:
                    drum_notes += 1
        notes_by_track.append((i, name, channels, programs, n_notes))

    length = mid.length  # seconds (mido computes from tempo map)
    init_bpm = round(mido.tempo2bpm(tempos[0])) if tempos else "?"
    print(f"\n=== {os.path.basename(path)} ===")
    print(f"  format type {mid.type}, {len(mid.tracks)} tracks, {mid.ticks_per_beat} ticks/beat")
    print(f"  duration ~{length:.1f}s, tempo changes: {len(tempos)}, initial ~{init_bpm} BPM")
    has_drums = drum_notes > 0
    print(f"  DRUM TRACK (ch10): {'YES — ' + str(drum_notes) + ' hits' if has_drums else 'no'}")
    for i, name, channels, programs, n in notes_by_track:
        if n == 0 and not name:
            continue
        fams = sorted({GM.get(p // 8, f"prog{p}") for p in programs})
        chs = ",".join(str(c + 1) for c in sorted(channels)) or "-"
        drum_flag = " [DRUMS]" if 9 in channels else ""
        print(f"    trk{i:<2} {name[:24]:<24} ch:{chs:<7} notes:{n:<5} {','.join(fams)}{drum_flag}")


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "samples"
    files = sorted(glob.glob(os.path.join(folder, "*.mid")))
    if not files:
        print(f"No .mid files in {folder}")
        return
    print(f"Analyzing {len(files)} file(s) in {folder}/")
    for f in files:
        try:
            analyze(f)
        except Exception as exc:  # noqa: BLE001
            print(f"\n=== {os.path.basename(f)} ===\n  ERROR: {exc}")


if __name__ == "__main__":
    main()
