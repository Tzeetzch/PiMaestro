#!/usr/bin/env python3
"""PiTV falling-notes renderer (prototype, milestone M1).

Reads a MIDI track via chart.py and animates the notes falling toward a target
strip at the bottom — a piano keyboard (pitched bars) or drum lanes (hit
markers). This is visualisation + playback only; MIDI input + scoring is M2.

Usage:
    py engine/fallnotes.py samples/piano_entertainer.mid --mode piano
    py engine/fallnotes.py samples/multi_chrono-battle.mid --mode drums

Keys:  Space pause/resume   R restart   ←/→ slower/faster   Esc/Q quit
"""
import argparse
import sys
import pygame

from chart import load_chart

# --- layout / look ---------------------------------------------------------
W, H = 1280, 720
HITLINE = H - 140              # y of the "play now" line
LEAD = 3.0                     # seconds of notes visible above the hitline
BG = (13, 17, 23)
GRID = (30, 36, 44)
HIT = (240, 240, 240)
NOTE_PIANO = (31, 111, 235)
NOTE_PIANO_HI = (88, 166, 255)
TEXT = (139, 148, 158)

# GM drum map -> lanes (label, [pitches], colour)
DRUM_LANES = [
    ("Kick",   [35, 36],             (236, 110, 76)),
    ("Snare",  [38, 40, 37],         (240, 200, 64)),
    ("Hi-Hat", [42, 44, 46],         (88, 200, 120)),
    ("Tom",    [41, 43, 45, 47, 48, 50], (96, 160, 255)),
    ("Crash",  [49, 52, 55, 57],     (200, 120, 240)),
    ("Ride",   [51, 53, 59],         (120, 200, 240)),
]


def drum_lane(pitch):
    for i, (_, pitches, _) in enumerate(DRUM_LANES):
        if pitch in pitches:
            return i
    return len(DRUM_LANES) - 1  # dump unknowns into the last lane


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--mode", default="piano", choices=["piano", "drums"])
    ap.add_argument("--track", type=int, default=None)
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    chart = load_chart(args.file, mode=args.mode, track_index=args.track)
    notes = chart["notes"]
    if not notes:
        print("No notes found in that track.")
        sys.exit(1)

    mode = args.mode
    pitches = [n.pitch for n in notes]
    lo, hi = min(pitches) - 1, max(pitches) + 1

    def note_x_w(n):
        """Return (x, width) for a note in pixels."""
        if mode == "drums":
            lanes = len(DRUM_LANES)
            lw = W / lanes
            return drum_lane(n.pitch) * lw + 6, lw - 12
        span = max(hi - lo, 1)
        x = (n.pitch - lo) / span * W
        return x, max(W / span - 3, 6)

    pygame.init()
    screen = pygame.display.set_mode((W, H))
    pygame.display.set_caption(f"PiTV — {chart['path']} [{mode}]")
    clock = pygame.time.Clock()
    font = pygame.font.SysFont("DejaVu Sans", 20)
    bigfont = pygame.font.SysFont("DejaVu Sans", 28, bold=True)

    pps = (HITLINE) / LEAD            # pixels per second of fall
    now = -LEAD                       # start with the song just above the screen
    speed = args.speed
    paused = False

    while True:
        dt = clock.tick(60) / 1000.0
        for e in pygame.event.get():
            if e.type == pygame.QUIT:
                pygame.quit(); return
            if e.type == pygame.KEYDOWN:
                if e.key in (pygame.K_ESCAPE, pygame.K_q):
                    pygame.quit(); return
                if e.key == pygame.K_SPACE:
                    paused = not paused
                if e.key == pygame.K_r:
                    now = -LEAD
                if e.key == pygame.K_RIGHT:
                    speed = min(speed + 0.1, 3.0)
                if e.key == pygame.K_LEFT:
                    speed = max(speed - 0.1, 0.2)
        if not paused:
            now += dt * speed

        # --- draw ---
        screen.fill(BG)
        if mode == "drums":
            lw = W / len(DRUM_LANES)
            for i, (label, _, col) in enumerate(DRUM_LANES):
                x = i * lw
                pygame.draw.line(screen, GRID, (x, 0), (x, H), 1)
                lab = font.render(label, True, col)
                screen.blit(lab, (x + lw / 2 - lab.get_width() / 2, HITLINE + 16))
        else:
            for p in range(lo, hi + 1):
                if p % 12 == 0:  # C lines
                    x = (p - lo) / max(hi - lo, 1) * W
                    pygame.draw.line(screen, GRID, (x, 0), (x, HITLINE), 1)

        pygame.draw.line(screen, HIT, (0, HITLINE), (W, HITLINE), 3)

        # notes
        for n in notes:
            y = HITLINE - (n.start - now) * pps
            if y < -50 or y > H + 50:
                continue
            x, w = note_x_w(n)
            if mode == "drums":
                col = DRUM_LANES[drum_lane(n.pitch)][2]
                pygame.draw.rect(screen, col, (x, y - 14, w, 18), border_radius=5)
            else:
                length = max(n.dur * pps, 10)
                near = abs(n.start - now) < 0.08
                col = NOTE_PIANO_HI if near else NOTE_PIANO
                pygame.draw.rect(screen, col, (x, y - length, w, length), border_radius=4)

        # HUD
        screen.blit(bigfont.render(f"{max(now,0):05.1f}s / {chart['duration']:.0f}s", True, HIT), (20, 16))
        screen.blit(font.render(f"{mode}  track {chart['track']}  speed x{speed:.1f}   "
                                f"[Space pause  R restart  ←/→ speed  Esc quit]", True, TEXT), (20, 52))
        pygame.display.flip()


if __name__ == "__main__":
    main()
