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

The server broadcasts these to every client. `pos` is **throttled to ~4 Hz per client** in `server.py`
(the local-clock browser only needs a heartbeat); a frame is always forwarded when `playing` changed, the
`file` changed, it is tagged `seek` (a jump), or `t` moved >0.5s. Discrete events are never throttled. On
queue overflow the **oldest** frame is dropped (a stale `pos`), so discrete events survive.

- `pos` — **idempotent heartbeat** (`t`, `file`, `playing`, `speed`, `waiting`, `wanted[]`, `timing`,
  `pi_muted?`, `ended?`, `seek?`). A dropped `pos` self-heals on the next tick. `file` lets a stale client
  detect another client switched songs and reconnect; `speed` keeps a 2nd client's local clock in sync.
- `hello` — full snapshot on connect: a `pos` plus `vm`, `file`, and the authoritative
  `play`/`hand`/`mode`/`speed`/`pi_muted`/`gates`. A reconnecting or 2nd client adopts this; if the Pi has
  a song loaded but paused, the client adopts the model (so the transport works) but stays on Home.
- `gate` — `{gi}`: gate `gi` was satisfied. The local-clock browser unfreezes at this gate. This is a
  position signal, separate from scoring, so the freeze cursor and the rating cursor can't diverge.
- `rating` — per-chord feedback `{kind, off, gate, gi}`, `kind` ∈ early/good/late/miss/**wrong**. Display
  only (badge flash; a `wrong` flashes the mis-pressed key red). Does NOT drive the clock.
- `gates` — `{gates[]}`: the gate-time set changed (part/range/mode). (A song *load* ships gates in the VM
  and other clients reconnect, so load does not broadcast `gates`.)
- `noteon`/`noteoff` — the player's live keys, for the keyboard highlight and the played-keys-on-staff
  overlay. (Display + optional browser sound; see below.)

## Sound

**The Pi is the primary sound source** for every mode. It plays out HDMI (TV) or the headphone jack:
- **Live keys** go keyboard→ALSA→FluidSynth (no web round-trip): latency is synth+buffer only.
  Accompaniment is sent over FluidSynth's TCP command server (:9800).
- **In-engine transpose:** notes can be shown shifted to fit a small keyboard while sounding at original
  pitch — the FluidSynth MIDI router transposes the keyboard down by the shift, and the conductor
  de-transposes TCP accompaniment to match. Zero added latency. (`_Synth.transpose`, `_service_auto`.)
- **Master gain** is pinned to `MASTER_GAIN` on load (so it never jumps); "Mute Pi" sets it to 0. The
  mute state is stored on the conductor, shipped in `hello`, and re-applied on load.
- **Non-blocking + self-healing synth client:** `_Synth` queues commands to a background worker that does
  the blocking socket I/O, so a stalled/absent FluidSynth never blocks live-MIDI matching. It caches
  connection state (gain, router-transpose, per-channel program + CC7 volume) and **replays it on
  reconnect**, so a FluidSynth restart doesn't silently revert instruments/volume/transpose.

**Optional in-browser sound (R.4):** a device that can't hear the Pi (a tablet across the room) can turn
on "Play sound on this device" — `web/app.js` loads `vendor/webaudio-tinysynth.js` and schedules the
backing from the VM on the local clock (held at the next gate in Follow), sonifying live keys from the
`noteon`/`noteoff` stream. It is **off by default** and paired with "Mute Pi". The scheduler runs only
while playing. The Pi stays the authority; this is purely a local speaker.

## State ownership / sessions

There is **one global Conductor** = one session, many views. Every client is a remote for the same state;
clients reconcile to the engine via `hello` (on connect / song change) and the `file` field in `pos`. This is
deliberate (a TV + a parent's tablet drive one song). True multi-session would be a much larger change.

## Persistence

- Per-song settings (part/hand/mode/speed/octave/split) live on the Pi keyed by realpath
  (`~/.config/pitv/song-settings.json`, merge semantics) so they follow the song to any client.
- Library (favorites, recently-played, **best-stars**) lives on the Pi too (same per-song store), so star
  badges and progress follow the song to any client.

## Known follow-ups (from the review panel)

- Trim the VM payload / fetch via cacheable GET instead of inlining the full VM in `hello` for huge MIDIs.
- A small test harness over song.py/conductor.py (synthetic VM → assert gates/auto/rating/loop).
