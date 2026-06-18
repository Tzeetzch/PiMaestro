"""Song model — the authoritative timeline the browser renders from.

Takes the parsed SMF (midifile.py) and produces the **view-model**: notes in real
seconds (tempo map applied), plus a provisional chord grouping. This is the single
source of truth for timing; the browser never recomputes it (see docs/ARCHITECTURE.md).

PianoBooster reference: Song.cpp (timeline), Chord.cpp / MIDI_PB_chordSeparator
(grouping notes that are played together), Tempo.cpp (tempo map).
"""
from __future__ import annotations

import bisect
import os

from .midifile import parse_midi
from .notation import note_pos, note_type, note_name

DEFAULT_TEMPO = 500_000          # usec per quarter note == 120 bpm, until the file says otherwise
MIDDLE_C = 60                    # provisional hand split (real hand selection is M2)
CHORD_EPS = 0.035                # notes starting within this many seconds == one chord
MAX_NOTES = 100_000              # cap the view-model; a real song is thousands. Guards a hostile/huge file.


def _tempo_map(tracks, ppqn):
    """Return (boundary_ticks, boundary_secs, usec_per_quarter) for tick->sec conversion."""
    tempos = sorted(
        (e.tick, e.a) for evs in tracks for e in evs if e.kind == "tempo"
    )
    if not tempos or tempos[0][0] != 0:
        tempos.insert(0, (0, DEFAULT_TEMPO))

    bticks, bsecs, busecs = [], [], []
    sec = 0.0
    for i, (tick, usec) in enumerate(tempos):
        if i > 0:
            sec = bsecs[-1] + (tick - bticks[-1]) * busecs[-1] / ppqn / 1e6
        bticks.append(tick); bsecs.append(sec); busecs.append(usec)
    return bticks, bsecs, busecs


def _tick_to_sec(tmap, ppqn, tick):
    bticks, bsecs, busecs = tmap
    i = bisect.bisect_right(bticks, tick) - 1
    if i < 0:
        i = 0
    return bsecs[i] + (tick - bticks[i]) * busecs[i] / ppqn / 1e6


def _is_piano_organ(program):
    return (0 <= program <= 7) or (16 <= program <= 23)


def _best_octave_shift(pitches, lo, hi):
    """Octave shift (semitones, multiple of 12) that lands the MOST of `pitches` inside
    [lo, hi] — used to auto-fit a song to the player's keyboard. Ties prefer no shift."""
    if not pitches:
        return 0
    best_count, best_shift = -1, 0
    for k in range(-4, 5):
        sh = k * 12
        c = sum(1 for p in pitches if lo <= p + sh <= hi)
        if c > best_count or (c == best_count and abs(sh) < abs(best_shift)):
            best_count, best_shift = c, sh
    return best_shift


def _detect_hands(raw, programs):
    """Port of TrackList::findLeftAndRightPianoParts — choose the piano/organ channels and
    put the lower-average-pitch one in the left hand, the higher in the right.
    Returns (left_channel, right_channel), each possibly None."""
    stats = {}                                   # ch -> [sum_pitch, count]
    for pitch, ch, *_ in raw:
        if ch == 9:
            continue
        s = stats.setdefault(ch, [0, 0])
        s[0] += pitch; s[1] += 1
    if not stats:
        return None, None
    def avg(ch):
        return stats[ch][0] / stats[ch][1]
    piano = [ch for ch in stats if _is_piano_organ(programs.get(ch, 0))]
    if len(piano) >= 2:
        piano.sort(key=lambda ch: stats[ch][1], reverse=True)   # busiest two piano parts
        a, b = piano[0], piano[1]
        return (a, b) if avg(a) < avg(b) else (b, a)
    if len(piano) == 1:
        return piano[0], piano[0]                # one piano part = both hands on one channel
    ch = max(stats, key=lambda c: stats[c][1])   # no piano: the busiest channel is the part
    return ch, ch


def _note_hand(ch, pitch, left, right, split):
    """Which hand (R/L): by detected hand channel, else a pitch split (the split point)."""
    if left is not None and right is not None and left != right:
        if ch == right:
            return "R"
        if ch == left:
            return "L"
    return "R" if pitch >= split else "L"


def _raw_notes(tracks):
    """Pair note-on/off by (channel,pitch) GLOBALLY across tracks (format-1 files can split a
    note's on and off across tracks; per-track pairing would leak them as stuck, over-long
    notes). -> [pitch, channel, track, start_tick, end_tick, velocity], track = the note-on's."""
    events = [(e.tick, ti, e) for ti, evs in enumerate(tracks) for e in evs
              if e.kind in ("note_on", "note_off")]
    events.sort(key=lambda x: x[0])           # stable: equal-tick events keep track/in-track order
    last_tick = max((t for t, _, _ in events), default=0)
    pending: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
    out = []
    for tick, ti, e in events:
        if e.kind == "note_on":
            pending.setdefault((e.channel, e.a), []).append((e.tick, e.b, ti))
        else:                                  # note_off — pair with the oldest matching on
            st = pending.get((e.channel, e.a))
            if st:
                j = next((k for k, on in enumerate(st) if on[2] == ti), 0)   # prefer an on from THIS track
                s, v, oti = st.pop(j)
                out.append([e.a, e.channel, oti, s, e.tick, v])
    for (ch, pitch), starts in pending.items():    # never-closed notes -> end at the last event
        for s, v, oti in starts:
            out.append([pitch, ch, oti, s, max(last_tick, s), v])
    return out


def _group_chords(notes):
    """Provisional chord grouping by start-time proximity (seeds M2 Follow-You).
    Self-contained: sorts by start time so it never depends on the caller's ordering."""
    chords = []
    cur = None
    for n in sorted(notes, key=lambda x: (x["t"], x["n"])):
        if cur is not None and abs(n["t"] - cur["t"]) <= CHORD_EPS:
            cur["notes"].append(n["n"])
        else:
            cur = {"t": n["t"], "notes": [n["n"]]}
            chords.append(cur)
    return chords


def _first_meta(tracks):
    """First key signature (sharps, signed) and time signature (num, den) in the file."""
    key, timesig = 0, (4, 4)
    key_tick, ts_tick = None, None
    for evs in tracks:
        for e in evs:
            if e.kind == "key_sig" and (key_tick is None or e.tick < key_tick):
                key, key_tick = e.a, e.tick
            elif e.kind == "time_sig" and (ts_tick is None or e.tick < ts_tick):
                timesig, ts_tick = (e.a, e.b), e.tick
    return key, timesig


def _meter_map(tracks):
    """All time signatures as sorted (tick, num, den), with a 4/4 default at tick 0."""
    ts = sorted((e.tick, e.a, e.b) for evs in tracks for e in evs if e.kind == "time_sig")
    if not ts or ts[0][0] != 0:
        ts.insert(0, (0, 4, 4))
    return ts


def _grid_times(meter_map, ppqn, tmap, duration, kind):
    """Times (sec) of grid lines (kind='bar' or 'beat'), honouring meter CHANGES — the step
    is recomputed from whichever time signature is in force at each line, so bar/beat lines
    after a meter change land correctly instead of marching at the opening meter forever."""
    times, tick = [], 0.0
    mi, n = 0, len(meter_map)
    while len(times) < 200000:                 # safety only; the duration check ends it for real
        while mi + 1 < n and meter_map[mi + 1][0] <= tick + 1e-6:
            mi += 1                             # advance to the meter in force at this tick
        num, den = meter_map[mi][1], meter_map[mi][2]
        units = max(1, num) if kind == "bar" else 1     # a corrupt num=0 -> 1-beat bars, not a dead grid
        step = units * ppqn * 4.0 / den if den else 0
        if step <= 0:
            break
        sec = _tick_to_sec(tmap, ppqn, tick)
        if sec > duration + 4:
            break
        times.append(round(sec, 3))
        tick += step
    return times


def build_view_model(path: str, transpose=0, kbd_lo=None, kbd_hi=None, split=MIDDLE_C) -> dict:
    """transpose: semitones to shift every note (use octaves for keyboard-fit), or the
    string 'auto' to pick the octave shift that best fits [kbd_lo, kbd_hi]. The applied
    shift is returned as vm['transpose'].
    split: the pitch boundary between left/right hand AND treble/bass staff (default
    middle C); used per-note for the hand fallback (single-channel songs) and the staff."""
    if path.lower().endswith((".gp3", ".gp4", ".gp5")):    # Guitar Pro -> same view-model, via gp.py
        from . import gp                                   # lazy import: avoids a circular dependency
        return gp.build_view_model(path, transpose, kbd_lo, kbd_hi, split)
    try:
        split = max(21, min(108, int(split)))
    except (TypeError, ValueError):
        split = MIDDLE_C
    pm = parse_midi(path)
    tmap = _tempo_map(pm.tracks, pm.ppqn)
    key, timesig = _first_meta(pm.tracks)
    meter_map = _meter_map(pm.tracks)                    # full list, for meter-change-aware grids

    programs = {}                                        # first instrument per channel
    for evs in pm.tracks:
        for e in evs:
            if e.kind == "program" and e.channel not in programs:
                programs[e.channel] = e.a

    raw = _raw_notes(pm.tracks)
    if len(raw) > MAX_NOTES:                             # oversized/hostile file: keep the earliest notes,
        raw.sort(key=lambda r: r[3])                     # don't build a multi-hundred-MB view-model / JSON
        del raw[MAX_NOTES:]
    left, right = _detect_hands(raw, programs)           # ported piano-hand channel detection

    # how far to shift: auto-fit the player's part to their keyboard, or an explicit amount
    if transpose == "auto":
        played = set(c for c in (left, right) if c is not None)
        pls = [p for p, ch, *_ in raw if ch in played and ch != 9]
        shift = _best_octave_shift(pls, kbd_lo, kbd_hi) if (pls and kbd_lo is not None) else 0
    else:
        shift = int(transpose or 0)

    notes = []
    for pitch0, ch, ti, st, en, vel in raw:
        pitch = max(0, min(127, pitch0 + shift))
        t = _tick_to_sec(tmap, pm.ppqn, st)
        end = _tick_to_sec(tmap, pm.ppqn, en)
        hand = _note_hand(ch, pitch, left, right, split)  # which hand — for play/colour
        # Staff (treble/bass) follows PITCH at the split point, not channel — a single channel
        # can span both hands (e.g. a full piano part), so placing every note on one staff is
        # wrong. This is how real notation / PianoBooster engrave: at/above the split -> treble.
        staff = "treble" if pitch >= split else "bass"
        idx, acc = note_pos("R" if staff == "treble" else "L", pitch, key)
        notes.append({
            "n": pitch, "t": round(t, 3), "d": round(max(end - t, 0.05), 3),
            "trk": ti, "ch": ch, "hand": hand, "v": vel,
            "staff": staff, "idx": idx, "acc": acc,
            "sym": note_type(max(en - st, 1), pm.ppqn), "nm": note_name(pitch, key),
        })
    notes.sort(key=lambda n: (n["t"], n["n"]))

    duration = max((n["t"] + n["d"] for n in notes), default=0.0)
    title = os.path.splitext(os.path.basename(path))[0].replace("_", " ")
    # parts = channels that have notes (the browser shows the instrument name; the L/R
    # marker comes from rightChan/leftChan). Each part is individually selectable to play.
    parts, seen = [], {}
    for n in notes:
        ch = n["ch"]
        if ch not in seen:
            seen[ch] = {"ch": ch, "program": programs.get(ch, 0), "count": 0}
            parts.append(seen[ch])
        seen[ch]["count"] += 1
    parts.sort(key=lambda p: p["ch"])

    return {
        "title": title,
        "transpose": shift,
        "split": split,
        "duration": round(duration, 3),
        "ppqn": pm.ppqn,
        "keysig": key,
        "timesig": list(timesig),
        "programs": programs,
        "parts": parts,
        "rightChan": right,
        "leftChan": left,
        "bars": _grid_times(meter_map, pm.ppqn, tmap, duration, "bar"),
        "beats": _grid_times(meter_map, pm.ppqn, tmap, duration, "beat"),
        "notes": notes,
        "chords": _group_chords(notes),
    }
