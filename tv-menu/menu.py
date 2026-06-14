#!/usr/bin/env python3
"""PiTV — full-screen, remote-navigable launcher for the piano-learning station.

Designed for control by an LG TV remote over HDMI-CEC, which only delivers a
D-pad + OK + Back + colored buttons (no mouse). Navigate with Up/Down, launch
with OK/Enter, quit-to-desktop with Back/Esc or the Red button.

Source of truth lives in the PiTV project repo; deployed to the Pi at
~/pitv-menu/menu.py.
"""
import os
import subprocess
import sys
import tkinter as tk
from tkinter import font as tkfont

HOME = os.path.expanduser("~")

# (label, subtitle, command). command=None means a built-in action handled below.
ENTRIES = [
    ("Linthesia",     "Falling-notes piano practice",  ["/bin/bash", f"{HOME}/Desktop/PlayLinthesia.sh"]),
    ("Neothesia",     "Modern falling-notes player",   ["/bin/bash", f"{HOME}/Desktop/PlayNeothesia.sh"]),
    ("Piano Booster", "Play along with MIDI songs",    ["/bin/bash", f"{HOME}/Desktop/PlayPiano.sh"]),
    ("Quit to Desktop", "Exit this menu",              "QUIT"),
]

BG       = "#0d1117"   # near-black
FG       = "#c9d1d9"   # light grey
ACCENT   = "#1f6feb"   # selection highlight
ACCENT_F = "#ffffff"   # selected text
SUB      = "#8b949e"   # subtitle grey


class Launcher:
    def __init__(self, root):
        self.root = root
        self.index = 0
        self.rows = []

        root.configure(bg=BG)
        root.attributes("-fullscreen", True)
        root.config(cursor="none")

        title_f = tkfont.Font(family="DejaVu Sans", size=64, weight="bold")
        item_f  = tkfont.Font(family="DejaVu Sans", size=40, weight="bold")
        sub_f   = tkfont.Font(family="DejaVu Sans", size=20)
        hint_f  = tkfont.Font(family="DejaVu Sans", size=18)

        tk.Label(root, text="PiTV", font=title_f, bg=BG, fg=FG).pack(pady=(60, 40))

        container = tk.Frame(root, bg=BG)
        container.pack(expand=True)

        for i, (label, subtitle, _cmd) in enumerate(ENTRIES):
            row = tk.Frame(container, bg=BG, padx=40, pady=18)
            row.pack(fill="x", pady=8)
            lbl = tk.Label(row, text=label, font=item_f, bg=BG, fg=FG, anchor="w")
            lbl.pack(fill="x")
            sub = tk.Label(row, text=subtitle, font=sub_f, bg=BG, fg=SUB, anchor="w")
            sub.pack(fill="x")
            self.rows.append((row, lbl, sub))

        tk.Label(root, text="↑↓  move      OK / Enter  select      Back / Red  quit",
                 font=hint_f, bg=BG, fg=SUB).pack(side="bottom", pady=40)

        # Key bindings.
        # Up/Down move; RIGHT selects, LEFT goes back — these are the CEC D-pad
        # keys that reliably reach the app (OK/Back map to KEY_OK/KEY_BACK which
        # XWayland doesn't surface as Return/Escape). Enter/Esc kept as a bonus.
        root.bind("<Up>",        lambda e: self.move(-1))
        root.bind("<Down>",      lambda e: self.move(1))
        root.bind("<Right>",     lambda e: self.activate())
        root.bind("<Left>",      lambda e: self.quit_to_desktop())
        root.bind("<Return>",    lambda e: self.activate())
        root.bind("<KP_Enter>",  lambda e: self.activate())
        root.bind("<Escape>",    lambda e: self.quit_to_desktop())
        for keysym in ("XF86Red", "XF86Back"):
            try:
                root.bind(f"<{keysym}>", lambda e: self.quit_to_desktop())
            except tk.TclError:
                pass

        # Diagnostic: log every keysym/keycode so we can learn what OK/Back emit.
        root.bind("<Key>", self._log_key, add="+")

    def _log_key(self, event):
        try:
            with open("/tmp/pitv-keys.log", "a") as fh:
                fh.write(f"keysym={event.keysym!r} keycode={event.keycode} char={event.char!r}\n")
        except OSError:
            pass

        self.render()
        root.after(100, lambda: (root.focus_force()))

    def render(self):
        for i, (row, lbl, sub) in enumerate(self.rows):
            if i == self.index:
                row.configure(bg=ACCENT); lbl.configure(bg=ACCENT, fg=ACCENT_F); sub.configure(bg=ACCENT, fg=ACCENT_F)
            else:
                row.configure(bg=BG); lbl.configure(bg=BG, fg=FG); sub.configure(bg=BG, fg=SUB)

    def move(self, delta):
        self.index = (self.index + delta) % len(ENTRIES)
        self.render()

    def activate(self):
        cmd = ENTRIES[self.index][2]
        if cmd == "QUIT":
            self.quit_to_desktop()
            return
        # Hide the menu, run the app (blocks until it exits), then come back.
        self.root.withdraw()
        try:
            subprocess.run(cmd)
        except Exception as exc:  # noqa: BLE001 - surface launch errors but never crash the menu
            print(f"launch error: {exc}", file=sys.stderr)
        self.root.deiconify()
        self.root.attributes("-fullscreen", True)
        self.root.after(100, self.root.focus_force)

    def quit_to_desktop(self):
        self.root.destroy()


def main():
    root = tk.Tk()
    root.title("PiTV")
    Launcher(root)
    root.mainloop()


if __name__ == "__main__":
    main()
