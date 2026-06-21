# Drum kit — MIDI note map & abstract-kit reference

PiMaestro's drum view is built and tested against an **Alesis Nitro** electronic kit (ALSA client
name "Alesis Nitro", sends GM percussion on channel 9). Any GM-compatible kit works, but the Nitro's
default map is the ground truth for which pad sends what — and it differs from generic GM in ways
that matter (see the gotchas).

## Alesis Nitro default MIDI note map

From the Nitro Drum Module User Guide appendix:

| Note | Pad | Note | Pad |
|---|---|---|---|
| 36 | Kick | 49 | Crash 1 |
| 38 | Snare | 57 | Crash 2 |
| 40 | Snare Rim | 51 | Ride |
| 48 | Tom 1 | 46 | Hi-Hat Open |
| 50 | Tom 1 Rim | 23 | Hi-Hat Half-Open |
| 45 | Tom 2 | 42 | Hi-Hat Closed |
| 47 | Tom 2 Rim | 44 | Hi-Hat Pedal (foot) |
| 43 | Tom 3 | 21 | Splash (foot, hi-hat) |
| 58 | Tom 3 Rim | | |
| 41 | Tom 4 | | |
| 39 | Tom 4 Rim | | |

### Gotchas vs generic General MIDI

- **41 = Tom 4** and **43 = Tom 3** — two *separate* toms. Generic GM calls 41 "Low Floor Tom"; do
  not merge it with 43.
- **57 = Crash 2** — a distinct second crash, not the same as 49 (Crash 1).
- **23 = Hi-Hat Half-Open** — a hi-hat *stick* articulation, not a separate pad.
- **44 = Hi-Hat Pedal / 21 = Splash** — the *foot*, distinct from the stick cymbal.
- The module has optional Tom 4 + Crash 2 inputs; a fully-loaded kit uses them, hence the 4-tom /
  2-crash layout below.

## The abstract kit view (11 pieces)

`render.js` draws an abstract drummer's-eye kit (not a piano keyboard) that lights as notes hit. The
pieces and their note groupings:

| Piece | Label | GM/Alesis notes |
|---|---|---|
| Kick | K | 35, 36 |
| Snare | S | 37, 38, 39*, 40 |
| Tom 1 (high) | T1 | 48, 50 |
| Tom 2 | T2 | 45, 47 |
| Tom 3 | T3 | 43, 58 |
| Tom 4 (floor) | T4 | 41 |
| Hi-hat (stick) | HH | 42, 46, 23 |
| Hi-hat foot (pedal) | HHf | 44, 21 |
| Crash 1 | CR | 49, 52, 55 |
| Crash 2 | CR2 | 57 |
| Ride | RD | 51, 53, 54, 56, 59, 69, 70, 82 |

\* Note 39 is Tom 4 Rim on the Alesis but Hand Clap in generic GM; the grouping above follows the
notation map in `render.js` (`DRUM_MAP`/`KIT_MAP`). Foot pieces (kick, hi-hat foot) render as pedal
shapes, distinct from the round pads/cymbals.

## The two sync points (keep these aligned)

These three tables encode the same note→piece mapping and **must stay consistent**, or the gate will
ask for a piece the kit doesn't light (or vice versa):

1. **`KIT_MAP`** (`web/render.js`) — GM note → kit piece id (the amber cue + the green hit flash).
2. **`DRUM_MAP`** (`web/render.js`) — GM note → staff position + glyph (where the X/oval head sits).
3. **`DRUM_ZONE`** (`engine/scorekeeper.py`) — GM note → gating zone (what the conductor matches).

`KIT_MAP` (render) and `DRUM_ZONE` (engine) are the pair that gating depends on; if you add a piece
or remap a note, change both. See `docs/ARCHITECTURE.md` → "Drums" for how the gate uses these.
