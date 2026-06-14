# PiTV — Plan

## Vision
An open-source, no-subscription "play along with the real song" trainer for **piano and
drums** — falling notes of the real part + the actual recording playing + accuracy feedback.
Rocksmith/Melodics-style, but free, hackable, and running on the user's own gear.

## Core principle: one engine, instrument = a config
Drums and piano are the *same notation* — MIDI notes on a timeline. The engine renders any
track's notes falling toward a **target strip**; the only difference is the strip:
- **Piano** strip = keyboard; notes are pitched + sustained (bars).
- **Drums** strip = lanes (kick/snare/hat/tom/cymbals); notes are instant hits (markers).

Input is **MIDI** (piano or e-kit) — reliable, no detection guesswork. "Pick a track → fall."

## "Real songs" (the headline feature)
Existing chart (MIDI, or Guitar Pro converted to MIDI) **+ the user's own mp3**, aligned:
1. Take a few short audio windows (e.g. ~0:30, mid, end-0:30).
2. Fingerprint each (chromagram) and slide it against the MIDI to auto-find `(audio_time ↔
   MIDI position)` anchor points (with a confidence score; low = MIDI doesn't match).
3. Piecewise time-warp the MIDI to the audio. **Audio is the master clock.**
4. Play audio + falling notes; "keep-up" mode (a recording can't pause mid-bar).
Stored as a small `song.sync.json` sidecar per song.

## Architecture
```
chart (MIDI track)  ─┐
                     ├─► engine: schedule notes (sec) ─► falling-notes renderer ─► TV
mp3 + sync.json ─────┘                                   ▲
MIDI input (piano/e-kit) ────────────────────────────────┘ (hit detection + scoring)
```
- `engine/chart.py` — parse MIDI → timed Note events (tempo-map aware). Headless, testable.
- `engine/fallnotes.py` — pygame renderer: falling notes, piano/drum layouts, transport.
- (later) `engine/sync.py` — chroma anchor-alignment, audio playback as master clock.
- (later) MIDI input + scoring.

## Roadmap
- [x] Access, project basis, TV launcher, CEC mapping.
- [x] Chart-data study + analyzer (`tools/analyze_midi.py`), sample corpus.
- [ ] **M1 — Falling-notes prototype (in progress):** render any sample track falling toward
      a piano keyboard *or* drum lanes, with play/pause/restart. Runs on Windows for fast
      iteration; deploy to the Pi for the TV.
- [ ] M2 — MIDI input + scoring (hit/miss within a timing window).
- [ ] M3 — Audio sync: mp3 as master clock + anchor alignment (`sync.json`).
- [ ] M4 — Song picker UI (TV/remote friendly), wire into the launcher.
- [ ] M5 — Guitar Pro import (GP→MIDI), pick instrument track.
- Parallel track: fix PianoBooster's two bugs on a local fork (stuck-halfway song; valid
  MIDI wrongly flagged "corrupted"). Needs the two files + cmake/Qt build deps on the Pi.

## Decisions / constraints
- Dev local in `C:\Dev\PiTV` for now; GitHub later, "once we have something we're proud of."
- Heavy steps (any future transcription) run on the Windows PC, not the Pi.
- Real recordings + matching MIDIs are user-supplied per song (licensing + must match).
