# PiTV — Vision (Product Owner brief)

This is the source of truth for *what we're building and why*. The PO agent answers
questions from this; the human PO (Peter) owns changes to it. If a decision is
clearly implied here, it's an "obvious 80%" — just follow it. If it's a genuine
trade-off this doc doesn't settle, escalate to the human PO with a recommendation.

## The dream

A **"Rocksmith for piano"** learning station at the piano. You pick a song, notes
fall / sheet music shows, you play your real keyboard, and the system *waits for you*,
*scores you*, and helps you actually learn the piece. Fun, modern, couch-and-tablet
friendly.

## The shape (decided)

- **Web app is the product.** The browser (TV, tablet, phone, laptop) is the
  **display + control surface**. Modern, touch- and remote-friendly UI.
- **The Pi is the headless brain**, sitting at the piano. It owns: MIDI input from
  the Yamaha E423 (USB), the music engine, and **local FluidSynth sound**.
- **Latency split — the key insight.** Sound stays **local on the Pi** (instant,
  for live play). Display + control go **over the LAN** (latency-tolerant). Never put
  anything latency-critical (live sound, note timing/scoring) on the network side.
- **Two sound paths.** (1) *Your live playing* → FluidSynth on the Pi (instant,
  reactive). (2) *The song's own audio* — backing parts and the hand you're NOT
  practising → played in the **browser, in sync with the falling notes** (same clock),
  so you can play along. Browser latency is fine here because this audio is scheduled,
  not reactive.
- **Split sounds (the Songsterr feel).** Songs are multi-track with per-channel
  instruments (MIDI program changes; the engine already tags each note with track +
  channel). Goal: **mute/solo individual parts** and play each with its real instrument
  sound. This is the stepping stone toward the parked dream of playing along to **real
  recordings**.
- **Use PianoBooster's *technique*, not its desktop app.** PianoBooster is the app
  Peter loves and it works. We **reuse its proven engine logic** — MIDI parsing,
  Follow-You (wait for the right notes), scoring/rating, notation — as the reference
  spec, ported cleanly into our engine. We are **not** shipping the Qt/OpenGL desktop
  app, and we are **not** building a shallow generic "falling blocks" game.
- **Use the MIDI directly.** Songs are real MIDI files. The engine parses them as the
  single source of truth. No lazy pre-baked-JSON-as-the-app shortcuts. (Serializing a
  view-model to the browser for *transport* is fine — that is not the same thing.)

## Non-negotiables (quality bar)

- **Decent architecture, real DRY.** One authoritative engine on the Pi. The browser
  never recomputes timing or scoring — it renders and sends control. No logic
  duplicated between front and back.
- **Incremental, demoable slices.** Every milestone runs end-to-end on the real Pi +
  TV + keyboard before the next one starts. No "build the whole thing then test."
- **Verify against ground truth**, not assumptions. Check the actual system/docs.
- **No wasted evenings.** Small slices, PO sign-off at each gate, reviewed code.

## Who plays what

- **Peter = Product Owner.** Owns priority, vision changes, milestone sign-off.
- **PO agent** = answers the obvious product questions from this vision so the build
  doesn't stall; escalates the genuine trade-offs to Peter with a recommendation.
- **Claude = architect + implementer**, runs a reviewer pass before showing work.

## Hardware / environment ground truth

- Raspberry Pi 4B (4GB), Debian 13, headless target (boot to console eventually).
- Pi IP **192.168.3.110** (use the IP; mDNS is flaky). User `peter`.
- Keyboard: **Yamaha E423** over USB → ALSA client `DigitalKBD`.
- Sound: MIDI keyboard → FluidSynth → HDMI/headphone, local on the Pi.
- ~199 MIDI songs already on the Pi under `~/linthesia/music/Learning/{2_-_Easy,
  3_-_Medium,4_-_Hard}/...`, graded by difficulty.

## Future / parked (NOT now — don't scope-creep into these)

- Play along with **real recordings** (mp3 + MIDI auto-aligned). Big future dream.
- Boot-to-kiosk autostart; stripping the Pi fully headless.
- These are real, but they come *after* the core learn-a-song loop works.

## How the PO agent should decide

**Answer directly (obvious) when** the vision/architecture clearly implies it, e.g.:
- "Where should timing/scoring live?" → the Pi engine (single source of truth).
- "Should the browser parse MIDI?" → no, the Pi does; browser gets a view-model.
- "Add a heavy dependency to the Pi for X?" → prefer stdlib/light; the Pi is the brain.
- "Game-style or shallow clone?" → PianoBooster technique, real engine.
- Anything that's just consistency with the latency split, DRY, or use-MIDI-directly.

**Escalate to the human PO (with a recommendation) when:**
- It's a genuine product trade-off the vision doesn't settle (e.g. exact scoring
  feel, what "good enough" accuracy is, UI look-and-feel direction).
- It changes scope, priority, or a milestone.
- It's costly or hard to reverse, or pulls in a parked/future item.
