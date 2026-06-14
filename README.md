# 🎹 PiMaestro

**A patient music teacher on a Raspberry Pi.** A falling-notes game and a real sheet-music
view that *wait for you* to play the right notes, with play-along backing and live timing
feedback. The Pi runs the engine and the sound; any browser — TV, tablet, laptop — is the
screen and the controls. Bring your own MIDI.

> **Built on [PianoBooster](https://github.com/pianobooster/PianoBooster).** PiMaestro
> reimplements and ports significant parts of PianoBooster's engine, so it is released under
> the same licence (GPL v3). See **[Credits & licence](#credits--licence)**.

---

## What it does

- **Follow-You** — the song freezes at each note/chord and waits until you actually play it,
  then continues. Early hits count; a chord must be pressed together. This is what makes
  pressing a key *mean* something.
- **Two views** — a falling-notes **Game** (Synthesia-style) and a real **Notation** grand
  staff (engraving ported from PianoBooster).
- **Play-along** — hear the parts you're *not* playing as backing, in time with you — or
  **Listen** to the whole song play itself.
- **Fits your keyboard** — auto-transposes a song to your keyboard's size (61 / 76 / 88…);
  notes you can't reach play themselves. It shows the keys to press while sounding the song
  at its true pitch (the keyboard input is transposed back inside the synth).
- **Timing feedback** — every chord you play is rated *early / good / late*.
- **Practice tools** — speed control (50–200 %), loop a bar range, jump-to-bar seek, bar
  numbers, note-name labels, pick which hand/part you play.
- **Library** — Favourites, Recently-played, per-song settings that follow the song to any
  device, and **upload your own MIDIs** straight from the browser.
- **Sound** — FluidSynth on the Pi (low-latency, correct GM instruments); optional in-browser
  sound for remote devices.

## How it works

```
 MIDI keyboard ──USB──► Raspberry Pi ──HDMI / headphones──► sound (FluidSynth)
                           │
                           │  engine:    MIDI parse · Follow-You timing · accompaniment
                           │  transport: HTTP + Server-Sent Events
                           ▼
                  any browser (TV / tablet / laptop)  =  display + controls
```

The Pi is the brain — it owns the play-clock and the sound, so live playing feels instant —
and the browser is a thin client that renders what the engine streams and sends controls
back. The engine is pure Python standard library (no heavy dependencies).

## Hardware

- Raspberry Pi 4 (4 GB) — Debian, PipeWire, FluidSynth with a General-MIDI soundfont
  (`fluid-soundfont-gm`).
- A USB MIDI keyboard.
- Any screen with a browser — the Pi's own HDMI display, or a tablet/laptop on the LAN.

## Run it

On the Pi:

```bash
cd ~/webpiano
python3 server.py            # serves http://<pi-ip>:8080
```

Then open `http://<pi-ip>:8080` in any browser on the network. (Desktop shortcuts
`PiTV-Start` / `PiTV-Open` for the Pi live in `webpiano/pi/`.)

From a dev PC, `deploy.ps1` syncs the app to the Pi over SSH and restarts the server.

## Layout

```
webpiano/        the app
  server.py      HTTP + SSE transport · MIDI reader (aseqdump) · MIDI upload
  engine/        midifile (SMF parser) · song (view-model) · conductor (Follow-You,
                 timing, accompaniment, transpose) · notation (staff positions)
  web/           index.html · app.js · render.js (canvas: notation + falling-notes)
  pi/            PiTV-Start / PiTV-Open desktop shortcuts
docs/            VISION · ARCHITECTURE · BACKLOG
deploy.ps1       sync + restart to the Pi
```

## Credits & licence

PiMaestro stands on the shoulders of **[PianoBooster](https://github.com/pianobooster/PianoBooster)**
by **L. J. Barman and others** (© 2008–2020). The hard, clever parts of the music engine are
theirs — this project ports and reimplements them:

- the **Standard MIDI File** parsing semantics (running status, signed key-signature, tempo
  map) — from `MidiFile.cpp` / `MidiTrack.cpp`;
- the **notation engraving** — note-head / clef / accidental geometry transcribed
  vertex-for-vertex from `Draw.cpp`, and the key-signature stave-position tables from
  `StavePosition.cpp`;
- the **Follow-You** idea and **hand/part detection** — from `Conductor.cpp` / `TrackList.cpp`.

Individual source files note the specific PianoBooster file they derive from.

Because it is a derivative work, **PiMaestro is licensed under the GNU General Public License
v3 (or later)** — the same licence as PianoBooster. See [`LICENSE`](LICENSE). The original
PianoBooster source is available at <https://github.com/pianobooster/PianoBooster>.

A personal project — built for one kid learning piano, and growing toward more instruments.
Developed collaboratively with Claude Code.
