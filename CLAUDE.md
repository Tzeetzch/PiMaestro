# PiTV

Project context and operating rules for any Claude Code agent working in this folder.
This file is auto-loaded on session start — read it, then act. It is the portable source
of truth (machine-local `~/.claude` memory does NOT travel with this folder).

## What PiTV is

A **Raspberry Pi 4 Model B (4GB)** wired to a TV, used as a **piano-learning station**.

- **Device:** `pitv.local`, user `peter`. Debian 13 (trixie), kernel 6.12, aarch64.
- **Display:** Wayland compositor `labwc`; video/audio out over HDMI (`vc4hdmi`), plus
  bcm2835 headphone jack.
- **Audio:** PipeWire + pipewire-pulse. `fluidsynth` runs as a software MIDI synth
  (ALSA seq client). Signal path: **MIDI keyboard → FluidSynth → HDMI/headphone audio**.
- **App:** **Linthesia** — open-source falling-notes piano game (Synthesia clone), built
  from source at `~/linthesia` (origin: github.com/linthesia/linthesia, meson build under
  `~/linthesia/build`). MIDI songs live in `~/linthesia/music` and `~/Music`.
- **Boot:** No autostart yet — Linthesia is launched manually, not on boot.

> The local `C:\Dev\PiTV` folder holds project meta (this file, scripts, docs). The actual
> running system lives on the Pi — investigate it over SSH, don't assume.

## How to connect

Passwordless SSH is set up from this PC:

```bash
ssh peter@pitv.local '<command>'        # run a single command
ssh peter@pitv.local 'bash -s' <<'EOF'  # run a script block
...
EOF
```

**On a fresh PC** the key won't exist yet. Run `setup-pi-key.ps1` in a normal PowerShell
window (it generates/installs the key and prompts for the Pi password once). If there is no
key pair, create one first: `ssh-keygen -t ed25519`.

## Operating rules (how the user wants me to work)

- **Work wizardly.** Take the steps, act autonomously, keep responses tight. No info dumps.
- **Verify against ground truth.** I may do anything as long as I verify correctness against
  the actual system state, docs, or hands-on investigation — not by asking the user.
- **No question mode.** Never use the multiple-choice AskUserQuestion prompt. State the
  problem, list options with pros/cons, give a recommendation in prose.
- **Sudo → clipboard.** I cannot run sudo on the Pi. When a command needs sudo, put the
  exact ready-to-paste command on the user's Windows clipboard (`... | clip`) and say so.
- **Paste corruption.** The user can't reliably copy multi-line/spaced commands out of chat
  (whitespace corrupts). Prefer: write a script file they run, or use the clipboard.
