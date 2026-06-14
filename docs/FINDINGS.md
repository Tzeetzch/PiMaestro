# PiTV — Findings

Investigation results that inform the build. Dates are 2026.

## Hardware / system (the Pi)
- Raspberry Pi 4B (4GB), Debian 13 (trixie), Wayland (`labwc`) + `wf-panel-pi` + `pcmanfm-pi`.
- Audio: PipeWire (+ pipewire-pulse), `fluidsynth` soft-synth. Out via HDMI / headphone jack.
- Instruments: **Yamaha PSR-E423** piano over USB-MIDI — works perfectly in PianoBooster.
  Electric **drum kit** (MIDI) is the second target instrument.
- Apps present: PianoBooster (favorite), Neothesia (flatpak), Linthesia (dropped).

## TV remote over HDMI-CEC
- Works on `/dev/cec0` (HDMI0, phys addr 4.0.0.0). Kernel auto-creates an input device
  from CEC, so D-pad navigation works with no daemon.
- **Buttons the LG actually forwards:** Up/Down/Left/Right, OK/Select (0x00, *only when
  not in Magic-Remote pointer mode*), Back (0x0d), Play/Pause, and the 4 colored buttons.
- **Never forwarded:** Home, Exit, Settings, Volume, Mute, numbers, and the wand/mouse
  pointer (CEC carries no pointer movement). So: ~11 buttons, no mouse.
- The launcher (`tv-menu/menu.py`) uses Up/Down + Right=select, Left=back (OK/Back map to
  KEY_OK/KEY_BACK which XWayland doesn't surface as Return/Escape).

## MIDI chart data study
Corpus in `samples/`, analyzed with `tools/analyze_midi.py` (Python 3.13 + `mido`).

- Charts are **format-1 MIDI**: a metadata track + one named track per instrument.
- **Piano** = pitched, sustained notes (usually channel 1).
- **Drums** = instantaneous hits on **MIDI channel 10** (kick 35/36, snare 38/40,
  hi-hat 42/44/46, toms, cymbals 49/51/57…). Confirmed across 3 multitrack files
  (476–2706 drum hits each).
- **Tempo-stability predicts sync difficulty:**
  - Produced music (pop / game multitrack): ~1 tempo change → trivial to align (2 anchors).
  - Expressive solo classical: up to 169 tempo changes → needs many anchors or riding the
    MIDI's own tempo map.
  - => The user's pop/drum goal is the *easy* alignment case.

## Software landscape (why we build our own)
- Polished "Rocksmith-for-piano" apps (Synthesia, Yousician, flowkey, Simply Piano,
  Playground, Skoove, Melodics) are all paid/subscription and/or don't run on ARM Linux.
- Open-source + Linux options are basically PianoBooster, Linthesia, Neothesia + some web
  apps (MIDIano, etc.). PianoBooster is among the best — and hackable.
- Rhythm-game custom content (Clone Hero, Rocksmith, Beat Saber) does **not** transfer:
  its "notes" are game-lane/guitar abstractions or non-musical, not real pitches.
- **YARG** does real-audio + e-kit + huge chart library, but it's a *game* (simplified Rock
  Band lanes, not real-instrument practice) and Unity/x86 (won't run on the Pi). Rejected.
- PianoBooster upstream is effectively dead (last release v1.0.0, Dec 2020; 49 open issues)
  → we fork it locally.

## Sources
- ByteDance piano_transcription, Spotify Basic Pitch, Google Magenta (audio→MIDI, not used
  for now — superseded by the MIDI+mp3 anchor-align approach).
- GuitarPro→MIDI: GuitarPro-to-Midi, PyGuitarPro, TuxGuitar.
- Sample MIDIs: mfiles.co.uk (public-domain piano), vgmusic.com (multitrack w/ drums).
