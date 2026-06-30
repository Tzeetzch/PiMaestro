#!/usr/bin/env python3
"""Drum-song validator. Runs every drum MIDI / Guitar Pro file in the library through the SAME
build_view_model pipeline the app uses, then flags the things that make a drum song "feel off":

  - parse errors
  - drum notes that aren't a real kit piece (unmapped vs scorekeeper.DRUM_ZONE) -> render as nothing
  - empty drum track (no ch9 notes at all) -> nothing to follow
  - suspiciously sparse drum track (very few hits for the song's length)

Use it to vet what's in the library and to screen any NEW drum source before adding it.

Run on the Pi:  python3 ~/webpiano/pi/check_drums.py
                python3 ~/webpiano/pi/check_drums.py /path/to/folder   # check one folder
"""
import sys, os, glob, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))                 # repo root: import engine.*
from engine.song import build_view_model                 # noqa: E402
from engine.scorekeeper import DRUM_ZONE                  # noqa: E402

SPARSE_HITS_PER_MIN = 30        # below this, the "drum part" is probably not a real groove

DEFAULT_ROOTS = (os.path.expanduser("~/Music"), os.path.expanduser("~/linthesia/music"),
                 os.path.join(os.path.dirname(HERE), "songs"))
EXTS = ("*.mid", "*.midi", "*.gp3", "*.gp4", "*.gp5")


def drum_folders(roots):
    found = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _d, _f in os.walk(root):
            if "drums" in os.path.basename(dirpath).lower():
                found.append(dirpath)
    return sorted(set(found))


def check_file(path):
    """Return a dict describing the drum content / problems of one song."""
    try:
        vm = build_view_model(path, 0, None, None, 60)
    except Exception as e:                                # noqa: BLE001
        return {"error": str(e)[:80]}
    drum = [n for n in vm["notes"] if n["ch"] == 9]
    unmapped = collections.Counter(n["n"] for n in drum if n["n"] not in DRUM_ZONE)
    dur_min = max(vm.get("duration", 0) / 60.0, 1e-6)
    return {"drums": len(drum), "unmapped": dict(unmapped),
            "tracks": len(vm.get("drumTracks", [])),
            "hits_per_min": len(drum) / dur_min}


def main():
    roots = [os.path.abspath(sys.argv[1])] if len(sys.argv) > 1 else list(DEFAULT_ROOTS)
    folders = [roots[0]] if (len(sys.argv) > 1 and os.path.isdir(roots[0])) else drum_folders(roots)
    total = problems = 0
    for folder in folders:
        files = []
        for ext in EXTS:
            files += glob.glob(os.path.join(folder, ext))
        if not files:
            continue
        print(f"\n=== {folder}  ({len(files)} files) ===")
        for path in sorted(files):
            total += 1
            name = os.path.basename(path)
            r = check_file(path)
            flags = []
            if "error" in r:
                flags.append("PARSE-ERROR: " + r["error"])
            else:
                if r["unmapped"]:
                    flags.append(f"unmapped notes {r['unmapped']}")
                if r["drums"] == 0:
                    flags.append("NO drum notes")
                elif r["hits_per_min"] < SPARSE_HITS_PER_MIN:
                    flags.append(f"sparse ({r['hits_per_min']:.0f} hits/min)")
            if flags:
                problems += 1
                print(f"  [!] {name}: " + "; ".join(flags))
            else:
                print(f"      {name}: {r['drums']} drum notes, {r['tracks']} track(s)  OK")
    print(f"\nchecked {total} files, {problems} flagged")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
