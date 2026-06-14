# PiTV

Meta/control folder for **PiTV** — a Raspberry Pi 4 wired to a TV as a piano-learning
station (MIDI keyboard → FluidSynth → TV, with [Linthesia](https://github.com/linthesia/linthesia)
showing falling notes).

The Pi itself is the real system; this folder holds setup scripts, docs, and the context
that lets a Claude Code agent pick up where the last session left off.

## Contents

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Auto-loaded project context + operating rules for Claude Code agents. |
| `setup-pi-key.ps1` | One-time: install this PC's SSH public key onto the Pi for passwordless login. |
| `.claude/` | Project-scoped Claude Code settings (e.g. permissions). |

## Onboarding a new PC

1. Make sure you have an SSH key: `ssh-keygen -t ed25519` (skip if `~/.ssh/id_ed25519.pub` exists).
2. Run `setup-pi-key.ps1` in PowerShell — enter the Pi password once.
3. Verify: `ssh peter@pitv.local hostname` should print `PiTV` without asking for a password.
4. Open this folder in Claude Code — it reads `CLAUDE.md` automatically.

## Backup

This is a plain folder — copy it, or `git init` and push to a remote to version + sync it
across machines.
