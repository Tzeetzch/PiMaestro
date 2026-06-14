# PiTV — Architecture (as built)

See `VISION.md` for *why*, `BACKLOG.md` for what's done / next. Option A: the engine runs
on the Pi (single source of truth), the browser is a thin view + controller.

## Boundary

```
  Yamaha E423 (USB MIDI)                              Browser (TV / tablet / laptop)
        │                                                   ▲          │
        │ ALSA seq (DigitalKBD)                      SSE /events   HTTP POST /control
        ▼                                            (pos, notes,      │
  ┌──────────────────────────── Raspberry Pi ─────────  autoon...) ────┼──────────┐
  │  ENGINE (Python)                         TRANSPORT (server.py)      ▼          │
  │   midifile → song(view-model)            HTTP + SSE + static files            │
  │   conductor (play brain) ◄── live MIDI (aseqdump) ── feeds gating + sound      │
  │   notation (CStavePos port)                                                    │
  │        │                                                                       │
  │        └── FluidSynth (TCP :9800): your keys (via aconnect) + accompaniment    │
  └────────────────────────────────────────────────────────────────────────────────┘
```

- **Engine = brain.** Parses MIDI, builds the view-model, runs Follow-You timing, drives
  accompaniment. Only place timing/gating lives.
- **Transport = dumb pipe** (`server.py`): serves `web/` + `vendor/`, streams SSE, takes
  control POSTs, reads the keyboard via `aseqdump`.
- **Browser = thin view**: renders the view-model + streamed position; sends controls.
- **Sound on the Pi**: your keys → FluidSynth via `aconnect`; accompaniment → FluidSynth
  via its TCP command server (:9800). Browser WebAudioFont sound is optional/secondary.

## As-built layout (`webpiano/`)

```
server.py            # HTTP+SSE transport; control endpoints; aseqdump MIDI reader; one Conductor
engine/
  midifile.py        # stdlib SMF parser (ports MidiFile/MidiTrack; #334 signed key-sig)
  song.py            # build_view_model: notes→seconds, hand detection, parts, bar/beat grids
  notation.py        # ported CStavePos (key tables, note_pos), GM note_name, note_type
  conductor.py       # play clock, Follow-You gates, modes, parts(channels), accompaniment, _Synth(:9800)
  (no score.py yet — scoring is a NEXT item)
web/
  index.html         # shell + controls (group/song, play/reset, Part, Mode, View, Sound, Instruments)
  app.js             # SSE client, control POSTs, Part/Instruments UI, WebAudioFont sound
  render.js          # canvas: drawGame() + drawNotation(); DOM keyboard; dirty-flag rAF loop
vendor/              # wafplayer.js, piano.js (self-hosted WebAudioFont; not in routine deploy)
pi/                  # PiTV-Start.sh / PiTV-Open.sh desktop shortcuts
```

## Data contracts

**View-model** (engine → browser on load, JSON): `{title, duration, ppqn, keysig,
timesig:[num,den], programs:{ch:prog}, parts:[{ch,program,count}], rightChan, leftChan,
bars:[sec], beats:[sec], chords:[...], notes:[ {n,t,d,trk,ch,hand,staff,idx,acc,sym,nm} ]}`.
Per note: `n`=MIDI pitch, `t`/`d`=start/dur seconds, `ch`=channel, `hand`=R/L (notation
staff), `idx`/`acc`=stave index/accidental (ported), `sym`=note-type (w/h/q/8/16),
`nm`=spelled name. `render.js` also precomputes `_b` (beat position) and `_top` per note.

**SSE events** (`/events`): `{type:'pos', t, playing, waiting, wanted:[pitches], ended?}`
(~40 Hz while playing); `{type:'noteon'|'noteoff', note, velocity}` (live keys);
`{type:'autoon'|'autooff', note, velocity}` + `{type:'alloff'}` (accompaniment for browser sound).

**Controls** (`POST /control`, JSON): `load{file}` (returns view-model), `play`, `stop`,
`reset`, `play_parts{channels:[]}` (which channels you play), `mode{mode:follow|along|listen}`,
`part{ch, mute?, program?}` (Instruments panel). Also `GET /songs`, `GET /song?file=`.

## Key engine behaviours

- **Parts = channels** (`TrackList` port): `_detect_hands` picks the two busiest
  piano/organ channels, lower avg pitch = left. The player's part = a set of channels
  (`conductor._play`); gates/backing computed from it. Drums (ch9) + out-of-range are
  never playable → always backing.
- **Follow-You gating**: gates = chords (by time) of the played channels. `EARLY_WINDOW`
  0.30 s (accept slightly early), `CHORD_WINDOW` 0.45 s (chord notes must be together),
  `HOLD_EPS` 0.03 (hold accompaniment at an unplayed gate so it lands with your note).
- **Modes**: Follow freezes at gates; Play-along/Listen run the clock continuously
  (`_advance_gates` only in Follow); Listen auto-plays every part.

## Rendering pipeline (`render.js`) — and where it's going

Single `<canvas>`, 2D context, one rAF loop that draws **only when `dirty`** (set by
`setPos`/`setSong`/`setView`/`setPlay`/`resize`). Good: no idle repaints. **Current
inefficiency:** each playing frame clears+repaints everything and iterates ALL notes to
cull the visible ~30, re-tessellating glyphs. PianoBooster instead compiles each note
once and only touches notes near the window (`Scroll.cpp`). Planned (BACKLOG "NOW"):
window the visible slice (R.1), layer static vs moving (R.2), cache glyphs as Path2D (R.3).

## Why not the alternatives
- **Headless C++ engine**: welded to Qt/OpenGL — fragile. Rejected.
- **Engine in the browser**: live input + sound are on the Pi; the brain must be where
  the keyboard is. Rejected.
