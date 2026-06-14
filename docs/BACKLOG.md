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
      optional dedicated piano SF; forward sustain (CC64); per-GM-program WebAudioFont bank (browser).

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
- [ ] **R.4 (deferred, medium risk)** local clock + interpolation, then lower conductor
      `TICK` (40→~12 Hz) for smoother scroll + less Pi/SSE load. Touches Follow-You timing —
      do only with a focused test pass. `TODO`

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
