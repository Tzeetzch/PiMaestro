# PiTV — Backlog

**Definition of Done (every ticket):** code reviewed → deployed to the Pi (`deploy.ps1`)
→ smoke-tested (often a `_smoke_*.py` run on the Pi) → Peter tried it on the real
TV/keyboard → Peter signs off. Verify against ground truth, not assumptions.

Pi at **192.168.3.110**, app at `http://192.168.3.110:8080`. See `ARCHITECTURE.md` for
the as-built design and `../webpiano/` for the code.

---

## ✅ DONE (built, deployed, signed off)

- **Engine on the Pi** (`webpiano/engine/`): `midifile.py` (stdlib SMF parser, ports
  PianoBooster incl. #334 signed key-sig), `song.py` (view-model: notes in seconds,
  tempo map, beat/bar grids, parts, hand detection), `conductor.py` (the play brain),
  `notation.py` (ported `CStavePos` + GM names + note-type). Parses MIDI on demand —
  the old Windows `midi_to_json`/`song.json` hack is gone.
- **Follow-You** — engine freezes at each gate until you play it; early-hit window
  0.30 s; a chord must be pressed together within 0.45 s.
- **Play modes** — Follow you / Play along (continuous) / Listen (`cmd:mode`).
- **Parts = MIDI channels** — ported `TrackList` hand detection (two busiest piano/organ
  channels, lower avg pitch = left). Part dropdown: Both/R/L + "Play: <instrument>" per
  other channel (`cmd:play_parts {channels}`). Drums + out-of-range always back you.
- **Play-along accompaniment** — conductor sends non-played parts to FluidSynth's TCP
  server (:9800) and broadcasts `autoon/autooff` for browser sound; held at unplayed
  gates so the backing lands WITH your note.
- **Instruments panel** — per-part GM instrument dropdown + mute (`cmd:part`).
- **Notation view** — grand staff ported vertex-for-vertex from `Draw.cpp` (clefs,
  noteheads, stems, flags, accidentals, key sig), beat+bar markers, note-name chips,
  **beat-based** horizontal spacing, calm light-on-dark palette (NOT PB green).
- **Game view** — falling notes: bright leading-edge cap = hit, bar above = sustain,
  fade below = release. Bar lines (downbeat dividers + bar number) sweep down with the music.
- **Live keyboard** highlight + local FluidSynth sound (auto-connected on (re)connect).
- **Controls**: play/stop (race-fixed), reset, group→song dropdowns.
- **Pi runtime**: desktop shortcuts `PiTV-Start.sh` / `PiTV-Open.sh` (sources in
  `webpiano/pi/`); governor=performance; see memory [[pi-runtime]].
- **Staff by pitch** — notation places each note on treble/bass by PITCH (middle-C split),
  not by channel/hand. Fixes wide-range single-channel parts (e.g. Christmas Truce ch0 = a
  full piano part) whose high notes were wrongly forced onto the bass staff. `hand`/`ch`
  still drives which PART you play; staff is purely for engraving.
- **Per-part play/background** — Instruments panel has a **play** checkbox per part beside
  **mute**: play = you play it (gated + shown); off = background (auto-played, hidden);
  mute = silenced. Notation/game now HIDE channels you don't play (was: dimmed).

---

## Independent reviews (2026-06-14) — fixes done + big directions
Ran 6 parallel reviews (architecture/code/UI-UX/game-design/web-design/audio). **Fixed batch:**
timing-badge class regression; per-song settings keyed by realpath; MIDI parser resync (no
more silent track loss); SSE `hello` snapshot on connect (fresh/reconnected client renders the
song, not a blank stage); accompaniment uses **real note velocities** (was fixed 80); browser
drops drums (were piano); FluidSynth light room reverb + gain 0.4. **Bigger directions NOT done:**
- [x] **TV/remote UX** (HIGH, two reviewers) — D-pad/keyboard navigation across the whole UI
      (arrows move a focus ring, Enter activates, Esc/Backspace = back, Space = play; Left/Right
      adjust a focused `<select>` and seek the `#seek` slider). Seek is now `role=slider` with keys.
      Remaining: text ~2× for 10-ft distance, segmented controls instead of native `<select>`.
- [x] **Make-it-fun for the kid** (HIGH, game review) — end-of-song **celebration + 1–3 stars**
      (from the good/late/early tally; per-song best in localStorage, shown on the song list) with
      Play-again / Pick-another; **count-in** (visual 3-2-1 + audible woodblock clicks on the beat).
      Still TODO: streak/combo, **Rhythm-Tap** onramp, anti-stuck assist ladder.
- [x] **Concurrency** — FluidSynth TCP sends are non-blocking via `_Synth`'s background sender
      thread (single FIFO worker); broadcast already non-blocking. Verified on Pi.
- [x] **Audiophile** — accompaniment uses real velocities (AUTO_VEL fallback 80→90); FluidSynth
      `synth.gain` 0.4→0.7 on the Pi (dense passages were timid on TV speakers). Remaining:
      optional dedicated piano SF; forward sustain (CC64).

## Browser audio removed entirely (2026-06-15)
Decision: the **Pi is the only sound source** for every mode — playing, game, and listening all use the
Pi's FluidSynth out the HDMI / headphone jack; the web app is display + remote only and makes NO sound.
WebAudioFont caused lag on dense songs (CPU synthesis) and never matched the Pi's tone; the only thing it
bought (hearing on a remote device) isn't how PiMaestro is used. Removed: `vendor/wafplayer.js` +
`piano.js` (~850 KB off every page load), all WebAudioFont code, the `autoon`/`autooff`/`alloff` SSE
emission, and the short-lived `wants_sound`/gating experiment. Kept: FluidSynth (unchanged) and
`noteon`/`noteoff` (drive the keyboard highlight + played-keys-on-the-staff — display only).
If a far-room demo speaker is ever wanted, stream the Pi's audio (ffmpeg → `<audio>`); ~an afternoon,
ffmpeg is already on the Pi. (The unused `vendor/*.js` still sit on the Pi; harmless, can be deleted.)

## Review pass 2 (2026-06-14) — 6-reviewer panel on the wizard menu + whole app
Fixed batch (deployed): **menu wizard** (Home → Song picker w/ category tabs + list → per-song Setup
→ game; device settings split off; Advanced disclosure hides octave/split/instruments; per-mode hint;
removed dead Quit); **remote/keyboard navigation** (above); **celebration + count-in** (above);
**reconnect/2nd-client state** (`hello` now carries play/hand/mode/speed; `pos` carries `file` so a stale
client reconnects on a song switch); **browser-sound robustness** (separate live/accompaniment voice pools
so backing can't steal the player's key; bounded note length so a dropped note-off self-releases; release
tail); **menu race** (monotonic load token — a stale async load bails instead of clobbering); **played keys
on the staff** (PianoBooster behaviour — live presses drawn at the play line); perf (debounced per-song
save, throttled seek/score DOM writes, cached `measureText`); engine `_resync_after_change` helper; wrote
`webpiano/docs/ARCHITECTURE.md` (was referenced by 6 files, didn't exist).
Known follow-ups: per-GM preset bank (assets); trim/lazy-load VM payload for huge MIDIs; test harness over
song.py/conductor.py; single-global-session is intentional (documented).

## UI/UX — decluttered into 3 zones (2026-06-14)
The header had ~16 controls in one row. Reorganised (media/practice-app pattern, NOT PianoBooster):
top bar (brand · status dot · song picker · timing badge · ⚙), a **transport** bar above the
keyboard (Play/Reset/Mode/Speed/View), and a **settings drawer** (gear) with Practice / Loop /
Display / Sound sections. The loop & instruments pop-overs folded into the drawer. All control
IDs kept; logic unchanged. `DONE` (awaiting Peter's visual sign-off — couldn't headless-verify).

## NOW — Rendering performance (the "just-in-time" trio)
*From the rendering investigation. Goal: render like PianoBooster (compile once, only
touch on-screen notes) — helps every device, especially the weak TV browser.*
Current cost: each playing frame clears+repaints EVERYTHING and loops over ALL notes
(1000–5000) to cull the ~30 on screen, re-tessellating every glyph. All in `web/render.js`.

- [x] **R.1 Window the notes** — binary-search the visible slice (notes sorted by `t`,
      `_b` monotonic in `t`); both `drawGame`/`drawNotation` now `lbound` to the first
      visible note and `break` past the window instead of scanning all N. `DONE`
- [x] **R.2 Layer static vs moving** — staff + clefs + time/key sig render once to an
      offscreen canvas (`buildStaticLayer`, invalidated on song/view/resize) and blit each
      frame; only the scrolling notes layer repaints. `DONE`
- [x] **R.3 Cache glyphs (Path2D)** — solid notehead built once as `NOTEHEAD_PATH`, stamped
      via translate+scale (`fillGlyph`) instead of re-tessellating ~30×/frame. Hollow heads
      + accidentals stay on `strip` (line-width scaling makes the transform not worth it). `DONE`
- [x] **R.5 Cap backing-store resolution** — `resize()` downscales the canvas bitmap above
      1080p (CSS stretches it); crisp at/under 1080p, ends 4×-pixel paint on a 4K TV. `DONE`
- [ ] **R.4 (deferred, medium risk)** local clock + interpolation instead of the 40 Hz position
      flood. **Full plan below** ("Event-driven playback stream"). Touches Follow-You timing —
      do only with a focused test pass. `TODO`

---

## PLAN — Event-driven playback stream (R.4 in full) (2026-06-15)
*Design dialogue with Peter. The Pi stays exactly as-is — the brain AND the only sound source.
This only changes WHAT the Pi streams to the browser during play.*

**Idea (Peter's).** Today the Pi pushes a full `pos` frame ~40×/s. But the browser already holds the
whole song from load, so it can run its **own playback clock** and the Pi need only send what the browser
can't derive. Result: ~10× less traffic, smoother scroll (interpolate at the display's 60 Hz instead of
stepping at 40 Hz), less client CPU/parsing. In Listen mode the stream goes near-silent.

**What the Pi sends during play**
- **Heartbeat** (~3 Hz) — the reconciliation channel. `{type:'hb', t, playing, speed, gen, seq}`:
  - `t` — authoritative clock (sec), for gentle drift correction.
  - `playing` — play/paused, so pause/resume reconciles correctly (Peter's add — see "instant pause").
  - `speed` — a speed change propagates without a reload.
  - `gen` (+ `file`) — load-generation, bumped on load and on any gate-set change (hand/part/keyboard/
    split). A client seeing a new `gen` refetches the VM → cleanly fixes multi-client song-switch and
    reconnect resync (replaces today's "`file` on every `pos`" hack).
  - `seq` — monotonic; a gap tells the client to request a fresh snapshot.
- **Discrete events** (only when they occur): `noteon`/`noteoff` (your live keys → keyboard highlight +
  staff overlay); `verdict {gate, kind, off}` (early/good/late **tagged with which gate**); transport
  edges `seek`/`loop`(+loop-jump)/`ended`.
- **Removed:** the 40 Hz `pos` stream.

**View-model addition.** The VM carries `gates: [t, …]` — the times of notes you must play — computed by
the Pi at load and re-sent (new `gen`) when the gate set changes. The browser only *reads* gate positions;
the matching logic (chord window, early window, satisfaction) stays 100% on the Pi.

**Browser clock**
- Free-runs on rAF: `now += dt * speed` while `playing` and not frozen.
- **Freeze is emergent:** when `now` reaches a gate not yet cleared, hold there — the browser knows where
  gates are, so the Pi never has to announce a freeze.
- **Resume rides on the verdict:** the gate's `verdict` arrives → clear it → roll on. The heartbeat's
  advancing `t` is the backstop. An **early hit** = verdict arrives before `now` reaches the gate → cleared,
  never freezes.
- **Drift correction = gentle slew, not snap:** each heartbeat, ease `now` toward `t` so scroll never
  jumps; hard-snap only on seek / `gen` change / tab-refocus.

**Instant pause (Peter's idea) → optimistic local control.** On a local Play/Pause/Seek/Speed press,
apply it to the local clock *immediately* (feels instant, no round-trip), POST the command, and let the
next heartbeat confirm/correct. Because the audio is the Pi's, it actually pauses ~50 ms later — imperceptible,
and the visual leading by that hair on pause is fine. `playing` in the heartbeat is what keeps the optimistic
state honest (incl. when *another* client pauses).

**Extra ideas folded in (build on Peter's):**
- **Optimistic control + reconcile** generalizes the instant-pause idea to play/seek/speed.
- **`gen`/`file` in the heartbeat** finally closes the multi-client + reconnect resync gap cleanly.
- **Gentle clock slew** (game-netcode style) so corrections are invisible.
- **`seq`-gap → resync** by re-requesting the existing `hello` snapshot.
- **Heartbeat doubles as keepalive/liveness** — a missed beat or two flips the status dot far faster than
  today's 15 s SSE keepalive.
- **Background-tab caveat:** browsers throttle rAF/timers in hidden tabs, so a backgrounded tablet's clock
  stalls and snaps forward on refocus via the heartbeat. Fine for the always-foreground TV kiosk; just
  expected behaviour on a tablet you switch away from.

**Risks / focused test pass (this touches Follow-You timing — do it deliberately):** gate freeze/resume;
early hit; late hit; chord spread across the window; seek/loop-jump during a freeze; speed change mid-song;
count-in (negative `t`); drift over a long song (no creeping audio↔visual offset); multi-client join +
song-switch (`gen` bump); reconnect after a blip.

**Effort: medium.** Conductor — add `gates` to the VM, tag verdicts with their gate, emit a heartbeat in
place of per-tick `pos`, keep the discrete events. Browser — a small clock module (advance/freeze/resume/
slew), optimistic control, `gen`-based resync. Keep the old `pos` path behind a flag during bring-up to
A/B and fall back if sync misbehaves.

---

## NEXT — Features PianoBooster has that we don't (ranked, from the gap report)
*Most build on machinery the conductor already has (`self._t`, seek, gate list, bar/beat
grids). The single highest-leverage change is a `speed` multiplier in `conductor._run`.*

1. [x] **Speed/tempo control** — `_speed` mult on the conductor clock (gates + backing scale
       for free), clamped 0.25–2.0; `cmd:speed`; header dropdown 50–200%, saved to
       localStorage and re-synced to the engine on load. `DONE`
   - [x] **Mark middle C** — blue dot on the C4 key (`.midc`).
   - [x] **Configurable keyboard size** — 88/76/61/49/37/25 presets; keys outside the
         range are dimmed (`.oor`) so the lit region matches the player's hardware. Saved
         to localStorage. (Yamaha E423 = 61-key.)
2. [x] **Loop a bar range** — `conductor.set_loop(start,end)` (seconds); `_run` jumps back at
       loop end, Reset returns to the loop start; `cmd:loop`. Loop panel (From/To bar +
       Loop-on toggle) maps bars→times via the view-model `bars[]`; cleared on song load.
       Notation shades the looped bars + marks the edges (`PiTV.setLoop`). `DONE`
3. [x] **Timing feedback (early/good/late)** — replaced the numeric score (Peter: cares about
       quality, not points; and Follow waiting = lateness). `_rate_finalize` rates each chord:
       finishing BEFORE the line uses song-time (early); AFTER uses REAL time since the line
       arrived (so "the song waited for you" in Follow = late). Thresholds EARLY_TOL 0.07 /
       LATE_TOL 0.15; emits a `rating` SSE event per chord ({kind, off}) + running tallies in
       the `pos` frame. Header badge flashes EARLY/GOOD/LATE/MISS (+ms) then shows tallies.
       Verified on Pi (−150ms early, 0ms good, +400ms late, miss). `DONE`
4. [x] **Note-name on/off toggle** — header "Names: on/off" button; `PiTV.setNames` gates the
       name chips in `drawNotation`; remembered in localStorage (`pitv.names`). `DONE`
5. [ ] **Per-part + own-piano volume** (S) — FluidSynth `cc <ch> 7 <v>`; sliders in the
       Instruments panel. `TODO`
6. [x] **Count-in** — visual 3-2-1 over the stage during the pre-roll + audible woodblock clicks
       (GM drums ch9) on the opening beat interval before t=0. `DONE`
7. [x] **Save settings per song** — Pi-side JSON store (`~/.config/pitv/song-settings.json`,
       atomic write, keyed by song path) so settings follow the song to any client.
       `GET /settings?file=` + `cmd:save_settings`. Saves part(hand+play)/speed/octave/mode;
       auto-saved on each change; restored on song select (`selectSong` fetches then applies
       before load, so the octave is right). Verified round-trip on Pi. Instruments/loop = v2.
       `DONE`
8. [x] **Octave transpose + fit-to-keyboard** — `build_view_model(path, transpose, lo, hi)`
       shifts all notes (`'auto'` = the octave shift landing the most of YOUR part inside the
       keyboard range; notation/names/gates recompute on the shifted pitch). The engine knows
       the keyboard range (`conductor.set_range`, `cmd:range`, or via `load`): notes outside
       it drop out of the gates and become **auto-played** (you still hear them) — so a song
       wider than the keyboard (e.g. Senbonzakura, 73 keys) never freezes Follow-You. Header
       "Octave: Auto/±oct" dropdown; off-keyboard notes shown dimmed. Semitone/key transpose
       (respelling) still `TODO`. `DONE (octave)`
9. [x] **Bar number + scrub/seek** — bar numbers drawn above each bar line; `conductor.seek(t)`
       (clamped, re-cues gate + accompaniment + timing tally, works playing or stopped);
       `cmd:seek`; click-to-jump progress bar (`#seek`) under the header, fill tracks position.
       Verified on Pi. `DONE`
10. [ ] **Rhythm-Tap mode** (M) — youngest-child on-ramp (tap timing, ignore pitch). `TODO`

11. [x] **Favorites + Recently-played categories** — song picker prepends `◷ Recently played`
        (top 20 by play time) and `★ Favorites` virtual categories; ★ toggle button; stored in
        the Pi-side song store (merged), `cmd:favorite`/`cmd:played` + `GET /library`; /songs
        realpath'd to match keys. Verified on Pi. `DONE`

12. [x] **Upload MIDI from any device** — menu "⬆ Upload MIDI"; `POST /upload?name=` raw body
        (no multipart — cgi gone in 3.13), sanitized + 5 MB cap + MThd check, saved to
        `~/Music/Uploads` (auto-lists as "Uploads" group), then auto-selected. Verified. `DONE`

Deferred (lower value/effort for this audience): follow-tempo (experimental in PB),
courtesy/in-bar accidental suppression, keyboard range/split setup, in-app MIDI/latency
setup (CLI works), distinct wrong-note sound (needs scoring), high-score (needs scoring +
per-song save).

---

## Parked (awaiting Peter)
- **Sound-quality verification** — FluidSynth set dry (chorus/reverb off, gain 0.5) to match
  PianoBooster; browser got a 24-voice cap. Peter to judge tone on the Pi when back; can
  fine-tune (light reverb / gain) or swap to PB's exact TimGM6mb font if needed.

## Parked (don't pull in without Peter's OK)
- **Drum-kit input** — read a 2nd MIDI input, make Drums a playable part. Needs the
  hardware to build/test (Peter to confirm a kit). Or a "keyboard-as-drums" variant.
- Real-recording play-along (mp3 + MIDI alignment) — the long-term dream.
- Strip Pi to **headless** (boot to console) — only if the Pi's own screen isn't used.
- PianoBooster Qt desktop bug #352 — separate from the web app.
