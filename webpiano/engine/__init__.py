"""PiTV music engine — the single source of truth (runs on the Pi).

Ported from PianoBooster's proven technique (see ../../pianobooster as the
reference spec): MIDI parsing, song model, Follow-You, scoring. The browser is
a thin view; it never recomputes timing or scoring. See docs/ARCHITECTURE.md.
"""
