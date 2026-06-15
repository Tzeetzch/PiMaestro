# PiMaestro — Architecture

This is the contract the code relies on. The source files point here ("see docs/ARCHITECTURE.md");
when you change behaviour, keep this in sync. PiMaestro is a GPLv3 derivative of PianoBooster — the
notation geometry, gating idea, and key-signature tables are ported from it.

## One sentence

A headless **Raspberry Pi is authoritative**: it parses the MIDI, owns the play-clock, decides
timing/gating/scoring, and makes the sound (FluidSynth). The **browser is a thin view + remote**:
it renders the position the Pi streams and POSTs control commands. No game logic lives in the browser.

## Processes

```
MIDI keyboard ──ALSA──▶ FluidSynth (TCP :9800, -a pipewire) ──▶ HDMI / headphone audio
      │                      ▲
      │ aseqdump            │ noteon/noteoff/prog/cc (accompaniment + count-in)
      ▼                      │
  server.py (HTTP :8080) ──▶ Conductor (the play brain) ──SSE──▶ browser (render.js + app.js)
      ▲                                                              │
      └───────────────── POST /control (load/play/stop/...) ◀───────┘
```

- **server.py** — pure transport. HTTP + SSE, static files, MIDI-reader thread (aseqdump → `on_note`),
  per-song settings + library persistence. No musical logic.
- **engine/midifile.py** — SMF parser (running status, signed key-sig, resilient to a bad track).
- **engine/song.py** — `build_view_model(path, transpose, kbd_lo, kbd_hi, split)` → the **view-model (VM)**:
  every note in **seconds** with staff/idx/accidental/symbol/hand/velocity, plus beats, bars, key/time sig,
  detected hands, auto octave-fit. Built ONCE per load.
- **engine/notation.py** — pure pitch→stave-position logic, ported from PianoBooster's StavePosition.cpp.
- **engine/conductor.py** — the brain. Owns the clock, Follow-You gates, accompaniment scheduling,
  early/good/late rating, loop/seek/speed/transpose. Streams state through a callback the server broadcasts.
- **web/render.js** — canvas view (notation + falling-notes game). Consumes the VM; **never recomputes
  timing or musical layout**. Precomputes its engraving layout once in `setSong`.
- **web/app.js** — orchestration: the menu wizard, SSE client, controls, per-song settings, local sound.

## Load-time precompute vs play-time stream (the performance contract)

Everything expensive happens at **load**: MIDI parse, tempo-mapping to seconds, hand detection, octave
fit, notation layout (engine) and engraving column layout (render.js `setSong`). The **play loop does NOT
recompute** — at ~40 Hz (`TICK`) the conductor only advances `_t`, checks the current gate, walks the
precomputed accompaniment list, and emits a tiny `pos` frame. The browser windows the precomputed notes by
binary search and draws. Pressing Start runs a script; it does not build one.

Invariant: **new timing/matching logic goes in the conductor, not the browser. New per-note data flows
one-way through the VM. render.js never computes anything musical** (the lone exception is `staffPos`, a
display-only mapping for live-pressed keys, which has no bearing on scoring).

## SSE frame taxonomy

The server broadcasts these to every client. The queue **drops on overflow** (`queue.Full`) — so:

- `pos` — **idempotent snapshot** (`t`, `file`, `playing`, `waiting`, `wanted[]`, `timing`, `ended?`).
  A dropped `pos` self-heals on the next tick. Carries `file` so a stale client can detect another client
  switched songs and reconnect for a fresh `hello`.
- `hello` — full snapshot sent once on connect: a `pos` plus `vm`, `file`, and the authoritative
  `play`/`hand`/`mode`/`speed`. A reconnecting or second client adopts this so it matches the engine
  instead of resetting to defaults.
- `noteon`/`noteoff` — the player's live keys, for the on-screen keyboard highlight and the
  played-keys-on-the-staff overlay (display only — these do NOT make sound).
- `rating` — instant early/good/late feedback per chord.

## Sound

**The Pi is the only sound source, for every mode (playing, game, listening).** It plays out the
HDMI (TV) or the headphone jack. The web app is display + remote control — **it makes no sound** (no
in-browser synthesis, no audio streaming). This is deliberate: the player always hears the Pi locally,
so the browser never needs to.

- **Live keys** go keyboard→ALSA→FluidSynth (no web round-trip): latency is synth+buffer only.
  Accompaniment is sent over FluidSynth's TCP command server (:9800).
- **In-engine transpose:** notes can be shown shifted to fit a small keyboard while sounding at original
  pitch — the FluidSynth MIDI router transposes the keyboard down by the shift, and the conductor
  de-transposes TCP accompaniment to match. Zero added latency. (`_Synth.transpose`, `_service_auto`.)
- **Non-blocking synth client:** `_Synth` queues commands to a background worker thread that does the
  blocking socket I/O, so a stalled/absent FluidSynth never blocks the conductor's live-MIDI matching.
- If a far-from-the-Pi device ever needs to hear a demo, the right approach is to stream the Pi's audio
  output (ffmpeg from the PipeWire sink monitor → an `<audio>` element) — latency is fine for passive
  listening. Not built; intentionally left out until the need is real.

## State ownership / sessions

There is **one global Conductor** = one session, many views. Every client is a remote for the same state;
clients reconcile to the engine via `hello` (on connect / song change) and the `file` field in `pos`. This is
deliberate (a TV + a parent's tablet drive one song). True multi-session would be a much larger change.

## Persistence

- Per-song settings (part/hand/mode/speed/octave/split) live on the Pi keyed by realpath
  (`~/.config/pitv/song-settings.json`, merge semantics) so they follow the song to any client.
- Library (favorites, recently-played) is separate; best-stars are client-local (localStorage) for now.

## Known follow-ups (from the review panel)

- Trim the VM payload / fetch via cacheable GET instead of inlining the full VM in `hello` for huge MIDIs.
- A small test harness over song.py/conductor.py (synthetic VM → assert gates/auto/rating/loop).
