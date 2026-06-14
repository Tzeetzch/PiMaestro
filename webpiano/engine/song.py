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


def _note_hand(ch, pitch, left, right):
    """Staff (R/L) for notation: by detected hand channel, else a middle-C pitch split."""
    if left is not None and right is not None and left != right:
        if ch == right:
            return "R"
        if ch == left:
            return "L"
    return "R" if pitch >= MIDDLE_C else "L"


def _raw_notes(tracks):
    """Pair note-on/off per (channel,pitch) -> [pitch, channel, track, start_tick, end_tick, velocity]."""
    out = []
    for ti, evs in enumerate(tracks):
        pending: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for e in evs:
            if e.kind == "note_on":
                pending.setdefault((e.channel, e.a), []).append((e.tick, e.b))
            elif e.kind == "note_off":
                st = pending.get((e.channel, e.a))
                if st:
                    s, v = st.pop(0)
                    out.append([e.a, e.channel, ti, s, e.tick, v])
        close = evs[-1].tick if evs else 0
        for (ch, pitch), starts in pending.items():
            for s, v in starts:
                out.append([pitch, ch, ti, s, max(close, s), v])
    return out


def _group_chords(notes):
    """Provisional chord grouping by start-time proximity (seeds M2 Follow-You)."""
    chords = []
    cur = None
    for n in notes:
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


def _grid_times(step_ticks, ppqn, tmap, duration):
    """Times (sec) of evenly spaced grid lines (bars or beats)."""
    if step_ticks <= 0:
        return []
    times, tick = [], 0.0
    while len(times) < 8000:
        sec = _tick_to_sec(tmap, ppqn, tick)
        if sec > duration + 4:
            break
        times.append(round(sec, 3))
        tick += step_ticks
    return times


def build_view_model(path: str, transpose=0, kbd_lo=None, kbd_hi=None) -> dict:
    """transpose: semitones to shift every note (use octaves for keyboard-fit), or the
    string 'auto' to pick the octave shift that best fits [kbd_lo, kbd_hi]. The applied
    shift is returned as vm['transpose']."""
    pm = parse_midi(path)
    tmap = _tempo_map(pm.tracks, pm.ppqn)
    key, timesig = _first_meta(pm.tracks)

    programs = {}                                        # first instrument per channel
    for evs in pm.tracks:
        for e in evs:
            if e.kind == "program" and e.channel not in programs:
                programs[e.channel] = e.a

    raw = _raw_notes(pm.tracks)
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
        hand = _note_hand(ch, pitch, left, right)        # which PART (channel) — for play/colour
        # Staff (treble/bass) follows PITCH, not channel — a single channel can span both
        # hands (e.g. a full piano part), so placing every note on one staff is wrong. This
        # is how real notation / PianoBooster engrave: middle C and up -> treble.
        staff = "treble" if pitch >= MIDDLE_C else "bass"
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
    num, den = timesig
    bar_ticks = num * pm.ppqn * 4.0 / den if den else 0
    beat_ticks = pm.ppqn * 4.0 / den if den else 0       # one beat = one 1/den note

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
        "duration": round(duration, 3),
        "ppqn": pm.ppqn,
        "keysig": key,
        "timesig": list(timesig),
        "programs": programs,
        "parts": parts,
        "rightChan": right,
        "leftChan": left,
        "bars": _grid_times(bar_ticks, pm.ppqn, tmap, duration),
        "beats": _grid_times(beat_ticks, pm.ppqn, tmap, duration),
        "notes": notes,
        "chords": _group_chords(notes),
    }
