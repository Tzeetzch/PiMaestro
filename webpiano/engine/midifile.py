"""Standard MIDI File (SMF) parser — stdlib only.

Ports the parsing *semantics* of PianoBooster's MidiFile.cpp / MidiTrack.cpp
(the reference spec under ../../pianobooster), notably:
  - variable-length quantities and MIDI **running status**
  - note-on with velocity 0 treated as note-off
  - tempo / time-signature / key-signature meta events
  - **SIGNED** key-signature byte (PianoBooster #334: `char` is unsigned on the
    Pi's ARM CPU, which wrongly rejected flat keys as a corrupted file)

PianoBooster #308 (a fixed C++ queue that under-allocated and silently truncated
long tracks) does NOT apply here: Python lists grow, so a long track can never be
cut short.

Output is a `ParsedMidi` carrying absolute-tick events per track. Converting ticks
to seconds (the tempo map) is the song model's job — see song.py.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field


@dataclass
class Event:
    tick: int            # absolute tick from start of track
    kind: str            # note_on | note_off | tempo | time_sig | key_sig | track_name | program
    channel: int = 0
    a: int = 0           # note pitch / tempo usec-per-quarter / keysig sharps / program
    b: int = 0           # velocity / keysig major-minor / time-sig denom
    text: str = ""


@dataclass
class ParsedMidi:
    fmt: int                          # SMF format 0/1/2
    ppqn: int                         # ticks per quarter note
    tracks: list = field(default_factory=list)   # list[list[Event]]
    title: str = ""


class _Reader:
    """A bounded byte cursor over one track chunk."""
    __slots__ = ("d", "i", "end")

    def __init__(self, data: bytes, start: int, end: int):
        self.d = data
        self.i = start
        self.end = end

    def byte(self) -> int:
        if self.i >= self.end:
            raise EOFError("read past end of track")
        b = self.d[self.i]
        self.i += 1
        return b

    def take(self, n: int) -> bytes:
        n = max(0, min(n, self.end - self.i))      # clamp: never read past this track chunk
        b = self.d[self.i:self.i + n]
        self.i += n
        return b

    def varlen(self) -> int:
        """MIDI variable-length quantity (max 4 bytes)."""
        value = 0
        for _ in range(4):
            c = self.byte()
            value = (value << 7) | (c & 0x7F)
            if not (c & 0x80):
                break
        return value


def _parse_track(data: bytes, start: int, end: int):
    r = _Reader(data, start, end)
    events: list[Event] = []
    abstick = 0
    running = 0
    track_name = ""

    try:
      while r.i < end:
        abstick += r.varlen()
        c = r.byte()
        if c & 0x80:
            status = c
            if c < 0xF0:              # running status only applies to channel voice messages
                running = c
        else:
            status = running
            r.i -= 1                  # this byte is data1; push it back for the case to read

        hi = status & 0xF0
        ch = status & 0x0F

        if hi == 0x80:                # note off
            note = r.byte(); vel = r.byte()
            events.append(Event(abstick, "note_off", ch, note, vel))
        elif hi == 0x90:              # note on (vel 0 == note off)
            note = r.byte(); vel = r.byte()
            events.append(Event(abstick, "note_on" if vel > 0 else "note_off", ch, note, vel))
        elif hi == 0xA0:              # poly aftertouch (ignore, consume 2)
            r.byte(); r.byte()
        elif hi == 0xB0:              # control change (ignore, consume 2)
            r.byte(); r.byte()
        elif hi == 0xC0:              # program change
            events.append(Event(abstick, "program", ch, r.byte()))
        elif hi == 0xD0:              # channel pressure (ignore, consume 1)
            r.byte()
        elif hi == 0xE0:              # pitch bend (ignore, consume 2)
            r.byte(); r.byte()
        elif status == 0xFF:          # meta event
            mtype = r.byte()
            length = r.varlen()
            payload = r.take(length)
            if mtype == 0x51 and length == 3:                       # set tempo (usec/quarter)
                events.append(Event(abstick, "tempo", 0,
                                    (payload[0] << 16) | (payload[1] << 8) | payload[2]))
            elif mtype == 0x58 and length >= 2:                     # time signature
                events.append(Event(abstick, "time_sig", 0, payload[0], 1 << payload[1]))
            elif mtype == 0x59 and length == 2:                     # key signature (SIGNED, #334)
                sharps = payload[0] - 256 if payload[0] >= 128 else payload[0]
                events.append(Event(abstick, "key_sig", 0, sharps, payload[1]))
            elif mtype == 0x03:                                     # track name
                track_name = payload.decode("latin-1", "replace")
                events.append(Event(abstick, "track_name", 0, text=track_name))
            elif mtype == 0x2F:                                     # end of track
                break
            # all other meta events: payload already consumed, ignore
        elif status in (0xF0, 0xF7):  # sysex — consume declared length
            r.take(r.varlen())
            running = 0
        else:
            # unknown/unsynced status. A stray data byte with no running status is junk —
            # skip one byte and try to resync instead of abandoning the rest of the track.
            if not (c & 0x80) and running == 0:
                r.byte()
                continue
            break
    except EOFError:
        pass        # truncated/garbled chunk — keep the events parsed so far
    return events, track_name


def parse_midi(path: str) -> ParsedMidi:
    with open(path, "rb") as f:
        data = f.read()

    if data[0:4] != b"MThd":
        raise ValueError("not a Standard MIDI File (missing MThd)")
    hdr_len = struct.unpack(">I", data[4:8])[0]
    fmt, _ntrks, division = struct.unpack(">HHH", data[8:14])
    # division: high bit set => SMPTE frames; otherwise ticks-per-quarter-note.
    ppqn = division if (division & 0x8000) == 0 and division > 0 else 96

    pos = 8 + hdr_len
    tracks: list = []
    title = ""
    while pos + 8 <= len(data):
        if data[pos:pos + 4] != b"MTrk":
            break
        tlen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        start = pos + 8
        end = min(start + tlen, len(data))
        evs, tname = _parse_track(data, start, end)
        tracks.append(evs)
        if tname and not title:
            title = tname
        pos = end

    return ParsedMidi(fmt=fmt, ppqn=ppqn, tracks=tracks, title=title)
