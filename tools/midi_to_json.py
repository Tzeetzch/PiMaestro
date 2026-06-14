#!/usr/bin/env python3
"""Convert a MIDI file to a simple note list (JSON) for the web falling-notes view.

Output: { "title": str, "duration": sec, "notes": [ {"n": midi, "t": start_sec, "d": dur_sec}, ... ] }
Times are real seconds (mido applies the tempo map for us).

Usage: py tools/midi_to_json.py <in.mid> <out.json> [title]
"""
import json
import os
import sys
import mido


def convert(path):
    mid = mido.MidiFile(path)
    abs_t = 0.0
    pending = {}          # (channel, note) -> [start_sec, ...]
    notes = []
    for msg in mid:       # merged tracks, msg.time = real-seconds delta (tempo-aware)
        abs_t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            pending.setdefault((msg.channel, msg.note), []).append(abs_t)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            stack = pending.get((msg.channel, msg.note))
            if stack:
                start = stack.pop(0)
                notes.append({"n": msg.note, "t": round(start, 3),
                              "d": round(max(abs_t - start, 0.05), 3)})
    notes.sort(key=lambda x: (x["t"], x["n"]))
    return {"duration": round(abs_t, 2), "notes": notes}


def main():
    src, dst = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else os.path.splitext(os.path.basename(src))[0]
    data = convert(src)
    data["title"] = title
    with open(dst, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"{title}: {len(data['notes'])} notes, {data['duration']}s -> {dst} "
          f"({os.path.getsize(dst)} bytes)")


if __name__ == "__main__":
    main()
