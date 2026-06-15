"""Notation layout — ported from PianoBooster's StavePosition.cpp + Notation.cpp.

Pure data/logic: given a MIDI note + key signature, where does the note head sit on
the grand staff (which staff, which stave index) and does it carry an accidental;
and given a note's duration in ticks, which note-head type (whole/half/quarter/...).

This is the tested PianoBooster technique, reproduced faithfully. The browser draws
the staff from this; it does not recompute any of it. See docs/ARCHITECTURE.md.

Stave index convention (from CStavePos): 0 = the centre line of that staff, +ve up,
-ve down; each diatonic step is one index. Staff lines are at even indices (-4..+4).
Accidental: 0 none, 1 sharp, -1 flat, 2 natural (in a sharp key), -2 natural (flat key).
"""
from __future__ import annotations

DEFAULT_PPQN = 96  # PianoBooster's reference ppqn for the note-length boundaries

# Per key-signature lookup: pitch-class (0..11) -> (pianoNote, accidental).
# pianoNote: diatonic step, 1=C 2=D 3=E 4=F 5=G 6=A 7=B (8 = C of next letter, edge case).
# Transcribed verbatim from StavePosition.cpp getstaveLookupTable().
_KEY_TABLES = {
    -6: [(1, 2), (2, 0), (2, 2), (3, 0), (3, 2), (4, 0), (5, 0), (5, 2), (6, 0), (6, 2), (7, 0), (8, 0)],   # Gb
    -5: [(1, 0), (2, 0), (2, 2), (3, 0), (3, 2), (4, 0), (5, 0), (5, 2), (6, 0), (6, 2), (7, 0), (7, 2)],   # Db
    -4: [(1, 0), (2, 0), (2, 2), (3, 0), (3, 2), (4, 0), (5, -1), (5, 0), (6, 0), (6, 2), (7, 0), (7, 2)],  # Ab
    -3: [(1, 0), (2, -1), (2, 0), (3, 0), (3, 2), (4, 0), (5, -1), (5, 0), (6, 0), (6, 2), (7, 0), (7, 2)], # Eb
    -2: [(1, 0), (2, -1), (2, 0), (3, 0), (3, 2), (4, 0), (4, 1), (5, 0), (6, -1), (6, 0), (7, 0), (7, 2)], # Bb
    -1: [(1, 0), (1, 1), (2, 0), (3, -1), (3, 0), (4, 0), (4, 1), (5, 0), (6, -1), (6, 0), (7, 0), (7, 2)], # F
     0: [(1, 0), (1, 1), (2, 0), (3, -1), (3, 0), (4, 0), (4, 1), (5, 0), (5, 1), (6, 0), (7, -1), (7, 0)], # C
     1: [(1, 0), (1, 1), (2, 0), (2, 1), (3, 0), (4, -2), (4, 0), (5, 0), (5, 1), (6, 0), (7, -1), (7, 0)], # G
     2: [(1, -2), (1, 0), (2, 0), (2, 1), (3, 0), (4, -2), (4, 0), (5, 0), (5, 1), (6, 0), (6, 1), (7, 0)], # D
     3: [(1, -2), (1, 0), (2, 0), (2, 1), (3, 0), (4, -2), (4, 0), (5, -2), (5, 0), (6, 0), (6, 1), (7, 0)],# A
     4: [(1, -2), (1, 0), (2, -2), (2, 0), (3, 0), (4, -2), (4, 0), (5, -2), (5, 0), (6, 0), (6, 1), (7, 0)],# E
     5: [(1, -2), (1, 0), (2, -2), (2, 0), (3, 0), (4, -2), (4, 0), (5, -2), (5, 0), (6, -2), (6, 0), (7, 0)],# B
     6: [(1, -2), (1, 0), (2, -2), (2, 0), (3, -2), (3, 0), (4, 0), (5, -2), (5, 0), (6, -2), (6, 0), (7, 0)],# F#
}


def _table(key):
    if key < -6 or key > 6:
        key = 0
    return _KEY_TABLES[key]


def note_pos(hand, midi, key):
    """MIDI note -> (stave_index, accidental) for the given hand ('R'/'L') and key sig.
    Ported from CStavePos::notePos()."""
    piano_note, acc = _table(key)[midi % 12]
    if hand == "R":
        idx = piano_note - 7
    else:
        idx = piano_note + 5
    idx += (midi // 12) * 7 - 7 * 5
    return idx, acc


_LETTERS = "CDEFGAB"


def note_name(midi, key):
    """Spelled note name (e.g. 'C', 'F#', 'Bb'). Ported from CStavePos::midiNote2Name:
    names come from the key-of-C table, re-spelled (sharp vs flat) to suit the key."""
    pc = midi % 12
    c_note, c_acc = _KEY_TABLES[0][pc]          # key of C gives the natural names
    if c_acc != 0:                              # a black key — choose sharp/flat spelling for the key
        key_note = _table(key)[pc][0]
        if c_note != key_note:
            c_note = key_note
            c_acc = 1 if key > 0 else -1
    letter = _LETTERS[(c_note - 1) % 7]
    return letter + ("#" if c_acc == 1 else "b" if c_acc == -1 else "")


def note_type(dur_ticks, ppqn):
    """Duration (ticks) -> note-head symbol, INCLUDING dotted notes. Boundaries are the
    midpoints between adjacent note values measured in quarter-notes. A trailing '.' marks a
    dot (1.5x). Symbols: '16' semiquaver, '8' quaver, '8.' dotted quaver, 'q' crotchet,
    'q.' dotted crotchet, 'h' minim, 'h.' dotted minim (3 beats), 'w' semibreve.
    (The old port stopped at 'w', so a 3-beat dotted-half was wrongly drawn as a whole note.)"""
    q = dur_ticks / float(ppqn or DEFAULT_PPQN)     # length in quarter-notes
    if q < 0.375:
        return "16"
    if q < 0.625:
        return "8"
    if q < 0.875:
        return "8."
    if q < 1.25:
        return "q"
    if q < 1.75:
        return "q."
    if q < 2.5:
        return "h"
    if q < 3.5:
        return "h."
    return "w"
