# PiMaestro — Product Vision

> This is the source of truth for *what we're building and why*. Any agent making a decision
> should read this and ask: "does this serve the vision?" It is deliberately about intent and
> taste, not implementation detail (that lives in ARCHITECTURE.md and the code).

## One sentence

A **beautiful, buttery-smooth play-along trainer** for **piano and drums** that runs on a
Raspberry Pi 4 wired to a TV, and teaches you real songs by scrolling sheet-music notation and
**waiting for you to play the right thing** before it moves on.

## Who it's for / how it's used

- A learner at a MIDI keyboard (and later a drum input) in front of a TV. The TV is the screen;
  an **LG CEC remote** drives it (no keyboard/mouse at the TV). A phone/tablet can also be a view.
- Sessions are short and hands-on. The learner reads the staff, plays, and the app **gates** —
  it stops and waits at each chord/note until played, then advances ("Follow-You"). Stopping is a
  *feature*: it's how you practice timing and accuracy.

## What "good" feels like (the bar)

1. **Smooth above all.** The scroll must be glassy at 60fps on the Pi. Timing and motion are the
   product — a learner reads rhythm from steady motion. Jitter/stutter is a P0 bug, not a polish item.
   When forced to choose, **smoothness beats sharpness** (the user has said this explicitly).
2. **Songsterr-quality notation.** Clean engraving: correct beaming, stems, accents, drum X-heads,
   readable at TV distance. It should look like a professional tab/score, not a toy.
3. **TV-first, remote-friendly.** Everything reachable with a D-pad/OK remote. Big, legible,
   high-contrast, dark theme. No tiny targets, no hover-only affordances.
4. **Instant and obvious.** Home-first: you land, you see your songs, you pick one, you play.
   No menus to learn. The UX flow is a one-view router rooted at home — don't fight it.

## Scope of content

- **Piano** (grand staff) and **drums** (percussion staff). Both first-class.
- Input formats: **MIDI** and **Guitar Pro** (.gp3/4/5). Guitar Pro is preferred when available
  because durations/beaming/accents are explicit (better notation than inferred-from-MIDI).
- The **drum view** should feel like a drummer's view, not a pianist's — see "Known directions".

## Hard constraints (never violate)

- **Thin client.** The Pi is authoritative for the clock, the sound (FluidSynth, server-side), and
  the Follow-You gating. Browsers are views. Don't move authority into the client.
- **No build step.** Plain HTML/canvas/JS, IIFE modules loaded by `<script>` order, SSE for live
  state. Keep it deployable by copying files.
- **Black-box modules.** Only the composition roots (app.js in the browser, Conductor/server.py on
  the Pi) may name siblings; every other module gets its deps injected. (See ARCHITECTURE.md.)
- **Runs on a Pi 4.** Modest VideoCore GPU. Per-frame GPU fill-rate/bandwidth is the real budget,
  not CPU draw-call time. Design rendering accordingly.
- **Licensing/IP:** GPLv3 + keep the PianoBooster attribution. Copyrighted song files (MIDI, GP)
  and soundfonts live ONLY on the Pi — never committed.

## Known directions / taste calls (current)

- **Drum view should not show a piano keyboard.** A piano under a drum chart is meaningless to a
  drummer. Replace it with an **abstract drum representation** (a clean kit / pad layout that lights
  up as notes hit) — legible at TV distance, matching the dark aesthetic.
- **Prefer Guitar Pro sources for drum songs** when a GP version exists — the notation is better.
- **Resolution-independent rendering.** Quality may scale to hold 60fps, but scaling must change
  *sharpness only*, never the *size/zoom* of the content. (A backing-store size clamp once caused a
  visible zoom — that class of bug violates the vision.)

## How we work (so the product stays good)

- **Verify against the running system**, not against assumptions. The real TV (via the kiosk's
  measured frame timing) is ground truth; headless renders smooth and will lie to you about perf.
- **Blank-context review** every substantial change with a specialist who didn't build it.
- Smooth, legible, remote-driveable, home-first. If a change makes any of those worse, it's wrong.
