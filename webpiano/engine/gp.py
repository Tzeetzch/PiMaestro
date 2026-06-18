"""Guitar Pro importer — .gp3/.gp4/.gp5 -> the SAME view-model song.py builds from MIDI.

Why this exists: a MIDI file is just note on/off + timing, so the renderer has to *infer*
note durations / beaming. A Guitar Pro file carries that structure explicitly (each beat's
duration, voices, accents), so the notation is read, not guessed. We parse it with PyGuitarPro
into the identical view-model shape, and everything downstream — Follow-You gating, stopping,
scoring, the renderer — is untouched. See docs/ARCHITECTURE.md.

(v1 scope: per-measure tempo, time signatures, voices, dotted/tuplet durations, drums + pitched
tracks. Mid-measure tempo changes and ties are approximated. gp.py owns NO musical-position logic
of its own — staff/accidental/name/symbol all come from notation.py, same as MIDI.)
"""
from __future__ import annotations

import os

import guitarpro

from .notation import note_pos, note_type, note_name
from .song import MIDDLE_C, MAX_NOTES, _group_chords

PPQN = 960   # synthetic ticks-per-quarter, only so we can reuse notation.note_type for the symbol


def _qlen(dur):
    """Beat length in quarter-notes from a GP Duration (value 4=quarter, 8=eighth, ...)."""
    q = 4.0 / dur.value
    if dur.isDotted:
        q *= 1.5
    t = getattr(dur, "tuplet", None)
    if t and getattr(t, "times", 0):
        q *= t.enters / t.times      # e.g. triplet: 3 in the time of 2
    return q


def _key_of(track0):
    try:
        ks = track0.measures[0].header.keySignature.value
        return ks[0] if isinstance(ks, (tuple, list)) else int(ks)
    except Exception:
        return 0


def build_view_model(path, transpose=0, kbd_lo=None, kbd_hi=None, split=MIDDLE_C) -> dict:
    try:
        split = max(21, min(108, int(split)))
    except (TypeError, ValueError):
        split = MIDDLE_C
    s = guitarpro.parse(path)
    tracks = s.tracks or []
    title = s.title or os.path.splitext(os.path.basename(path))[0].replace("_", " ")
    key = _key_of(tracks[0]) if tracks else 0
    nmeas = len(tracks[0].measures) if tracks else 0

    # ---- timeline: per-measure start time (sec), tempo + time-sig in force ----
    tempo = float(s.tempo or 120)
    starts, tempos, tsigs, cum = [], [], [], 0.0
    ref = tracks[0] if tracks else None
    for mi in range(nmeas):
        m = ref.measures[mi]
        th = getattr(m.header, "tempo", None)            # GP5 carries per-measure tempo here
        if th and getattr(th, "value", 0):
            tempo = float(th.value)
        ts = m.header.timeSignature
        num, den = ts.numerator, ts.denominator.value
        starts.append(cum); tempos.append(tempo); tsigs.append((num, den))
        cum += num * (4.0 / den) * (60.0 / tempo)        # measure length in seconds
    duration = cum

    # ---- notes (every track; the player picks a part later) ----
    raw = []                                             # (pitch0, ch, trk, start, dur, vel, sym)
    for ti, t in enumerate(tracks):
        perc = t.isPercussionTrack
        ch = t.channel.channel
        tun = [st.value for st in t.strings]
        for mi in range(min(nmeas, len(t.measures))):
            mstart, sp = starts[mi], 60.0 / tempos[mi]
            for v in t.measures[mi].voices:
                off = 0.0
                for b in v.beats:
                    ql = _qlen(b.duration)
                    bstart, bdur = mstart + off * sp, ql * sp
                    sym = note_type(max(1, int(round(ql * PPQN))), PPQN)
                    for n in b.notes:
                        if getattr(n.type, "name", "") == "dead":
                            continue
                        pitch = n.value if perc else (tun[n.string - 1] + n.value if 0 < n.string <= len(tun) else n.value)
                        vel = max(1, min(127, getattr(n, "velocity", 95) or 95))
                        raw.append((max(0, min(127, pitch)), ch, ti, bstart, bdur, vel, sym))
                    off += ql
    raw.sort(key=lambda r: r[3])
    if len(raw) > MAX_NOTES:
        del raw[MAX_NOTES:]

    # GP tracks are whole instruments, not hands — no L/R pitch split. Auto-fit stays off (shift 0)
    # so drum notes keep their GM numbers; explicit transpose still works.
    shift = 0 if transpose == "auto" else int(transpose or 0)
    notes = []
    for pitch0, ch, ti, st, du, vel, sym in raw:
        pitch = max(0, min(127, pitch0 + shift))
        staff = "treble" if pitch >= split else "bass"
        idx, acc = note_pos("R" if staff == "treble" else "L", pitch, key)
        notes.append({
            "n": pitch, "t": round(st, 3), "d": round(max(du, 0.05), 3),
            "trk": ti, "ch": ch, "hand": None, "v": vel,
            "staff": staff, "idx": idx, "acc": acc,
            "sym": sym, "nm": note_name(pitch, key),
        })
    notes.sort(key=lambda n: (n["t"], n["n"]))

    # ---- parts / programs ----
    programs, parts, seen = {}, [], {}
    for t in tracks:
        ch = t.channel.channel
        if ch not in programs:
            programs[ch] = (getattr(t.channel, "instrument", 0) or 0) if not t.isPercussionTrack else 0
    for n in notes:
        ch = n["ch"]
        if ch not in seen:
            seen[ch] = {"ch": ch, "program": programs.get(ch, 0), "count": 0}
            parts.append(seen[ch])
        seen[ch]["count"] += 1
    parts.sort(key=lambda p: p["ch"])

    # ---- bar + beat grid lines (seconds) ----
    bars = [round(starts[mi], 3) for mi in range(nmeas)]
    if duration:
        bars.append(round(duration, 3))
    beats = []
    for mi in range(nmeas):
        num, den = tsigs[mi]
        beatsec = (4.0 / den) * (60.0 / tempos[mi])
        for j in range(num):
            beats.append(round(starts[mi] + j * beatsec, 3))

    return {
        "title": title,
        "transpose": shift,
        "split": split,
        "duration": round(duration, 3),
        "ppqn": PPQN,
        "keysig": key,
        "timesig": list(tsigs[0]) if tsigs else [4, 4],
        "programs": programs,
        "parts": parts,
        "rightChan": None,
        "leftChan": None,
        "bars": bars,
        "beats": beats,
        "notes": notes,
        "chords": _group_chords(notes),
    }
