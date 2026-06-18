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
- **engine/gp.py** — Guitar Pro importer (.gp3/.gp4/.gp5 via the `pyguitarpro` package). Produces the
  **same VM** as song.py, so the whole engine is format-agnostic — `build_view_model` dispatches by
  extension (`.gp*` → gp.py, else MIDI). GP files carry explicit durations/voices, so notation is read,
  not inferred. (Runtime dep on the Pi: `pip install --user --break-system-packages pyguitarpro`.)
- **engine/notation.py** — pure pitch→stave-position logic, ported from PianoBooster's StavePosition.cpp.
- **engine/conductor.py** — the brain. Owns the clock, Follow-You gates, accompaniment scheduling,
  early/good/late rating, loop/seek/speed/transpose. Streams state through a callback the server broadcasts.
- **web/render.js** (PiTV) — canvas view (notation + falling-notes game). Consumes the VM; **never
  recomputes timing/matching/scoring**. Precomputes its display-only engraving layout once in `setSong`,
  into a render-owned side-store (`vmLay`) — never written back onto the VM.
- **web/app.js** — the **composition root** + play-flow orchestrator: the load/select state machine,
  play/pause/reset, the pause + end-of-song reward screens, the screen router, and the SSE handlers.
  The browser logic was carved into single-concern boxes (below); `app.js` is the only one that knows
  the others by name and wires them together.
- **web/{session,sound,sse,catalog,pilib,nav,transport,setup}.js** — the carved boxes (PiSession /
  PiSound / PiSse / PiCatalog / PiLib / PiNav / PiTransport / PiSetup). See **Box contracts** below.

## Box contracts

The browser logic is split into single-concern modules ("boxes"). The rule that keeps them honest:

> **Only a composition root may know other boxes by name.** There are two roots — `app.js` (browser)
> and `Conductor` + `server.py` (Pi). They wire the boxes together. **Every other box names no sibling.**
> Anything it needs from outside arrives as an injected input via `init({...})`; anything it produces
> leaves as a declared output (a callback or a pulled getter). No box reaches for a sibling global.

A box's contract is **IN** (what it's handed), **OUT** (what it emits), and **must-never-know**. Enforced
mechanically: grepping each module for `Pi<Sibling>.` returns nothing except in `app.js`.

| Box (file) | IN (injected / driven) | OUT | Must never know |
|---|---|---|---|
| **PiSession** (session.js) | property writes (`vm`/`file`/`play`/`hand`) | property reads | *everything* — it's a passive model |
| **PiTV** (render.js) | `setSong`, `setPlay`, gate/clock/view/loop setters, `highlight`/`flashWrong` | `clockState()` (pulled) | songs, engine, sound, nav |
| **PiSound** (sound.js) | `getVM`, `isMine`, `control`, `getClock` | audio out; `pi_mute` cmd | PiTV, library, nav |
| **PiSse** (sse.js) | `start(handlers)`, `reconnect()` | `handlers[type](msg)` dispatch | what the messages *mean* |
| **PiCatalog** (catalog.js) | `control`, `onChange`; `load`/`upload` driven | `songs/meta/isFav/bestOf` (pulled), `coverGlyph/coverBg` | the DOM, the selector, the stage |
| **PiLib** (pilib.js) | `getSongs`, `getMeta`, `coverGlyph/coverBg`, `onPick`, `onUpload` | `onPick(file)` | where songs *come from*, engine, the stage |
| **PiNav** (nav.js) | `getView/Playing/VM`, `control`, `go`, `openPause` | focus moves + element actions | what a screen *contains* |
| **PiTransport** (transport.js) | `getVM`, `control`, `showLoop`, `showProgress` (driven) | seek / loop commands | PiTV, the play-flow |
| **PiSetup** (setup.js) | `getVM/Play/SelFile`, `control`, `coverGlyph/coverBg/isFav`, `setHand` (driven) | `onPlay(channels)`, `onPart()` | PiLib, PiTV, the stage |
| **app.js** | — (the root) | — | *(may know every box)* |

The Pi side already obeys the same rule with the same two-root shape: **ScoreKeeper / _Synth / Song /
midifile / notation** are pure (know nothing of each other); **Conductor** composes ScoreKeeper + _Synth;
**server.py** composes Conductor + the catalogue/settings/power stores.

- **engine/scorekeeper.py** (ScoreKeeper) — the timing judge. IN: `reset`, `record_press`, `wrong_note`,
  `finalize(t, gates, now)`, `tally`. OUT: `rating` frames via the `on_state` callback. Knows nothing of
  the clock or the gates — the conductor passes them in. Split out so gating ≠ scoring.

DOM ownership: each shared node has exactly one owner — the box that *renders* it. The Part dropdown
`#handSel` is PiSetup's (the app restores/reads it via `setHand`/`handValue`/`handMirror` and reacts to
`onPart`); the position bar `#seek`/`#seekfill`/`#time` is PiTransport's (the app's heartbeat drives it
through `showProgress`); `#modeSel` is the app's (PiSetup gets the mode as a `updateModeHint(mode)` arg,
never reads the node).

The loaded-song state the other boxes read (the song `vm`, its `file`, the player's `play` channels +
`hand`) is the **PiSession** model — a passive state container the app writes and the injected getters
read. (`mode`/`transpose`/`split` stay in `app.js`: each is bound 1:1 to its `<select>` widget and the
engine's string protocol, read only inside app's own logic, and shared with no other box.)

## Load-time precompute vs play-time stream (the performance contract)

Everything expensive happens at **load**: MIDI parse, tempo-mapping to seconds, hand detection, octave
fit, notation layout (engine) and engraving column layout (render.js `setSong`). The **play loop does NOT
recompute** — at ~40 Hz (`TICK`) the conductor only advances `_t`, checks the current gate, walks the
precomputed accompaniment list, and emits a tiny `pos` frame. The browser windows the precomputed notes by
binary search and draws. Pressing Start runs a script; it does not build one.

Invariant: **new timing/matching logic goes in the conductor, not the browser. The VM flows one-way and
read-only; render.js never computes timing, matching, or scoring.** render.js DOES compute display-only
geometry — the horizontal engraving/column layout in `setSong`, and `staffPos` for live keys — but this
only affects on-screen spacing, never the clock/gates/scoring, and it is kept in a render-owned side-store
(`vmLay`), **not written back onto the VM** (the VM is also `PiSession` state that app/PiSound read).

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
