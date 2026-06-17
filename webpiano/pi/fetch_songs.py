#!/usr/bin/env python3
"""Fetch a curated set of song MIDIs from BitMidi onto the Pi, VETTED for a usable part, sorted into
clean groups under ~/Music. Personal-use content — these live on the device, never in the repo.

For each song it searches BitMidi's API, tries the most-played transcriptions, and keeps the first
that actually has what we need: a real drum track for drum songs, or enough melodic notes for piano.
Bad/empty transcriptions are skipped. Run:  python3 ~/webpiano/pi/fetch_songs.py
"""
import json, os, sys, time, urllib.request, urllib.parse
sys.path.insert(0, os.path.expanduser("~/webpiano"))
from engine.song import build_view_model

MUSIC = os.path.expanduser("~/Music")
HDR = {"User-Agent": "Mozilla/5.0"}

# (filename, search query, kind 'drums'|'piano', group folder)
D_EASY = "10 Drums - Easy"; D_UP = "11 Drums - Stepping Up"; D_REACH = "12 Drums - Reach"
P_FIRST = "20 Piano - First Steps"; P_CLASS = "21 Piano - Classical"; P_ROCK = "22 Piano - Rock and Metal"
SONGS = [
    # ---- drums: simple but massive ----
    ("AC-DC - Back in Black", "ac dc back in black", "drums", D_EASY),
    ("AC-DC - Highway to Hell", "ac dc highway to hell", "drums", D_EASY),
    ("AC-DC - T.N.T.", "ac dc tnt", "drums", D_EASY),
    ("AC-DC - You Shook Me All Night Long", "ac dc you shook me all night long", "drums", D_EASY),
    ("AC-DC - Thunderstruck", "ac dc thunderstruck", "drums", D_EASY),
    ("Queen - We Will Rock You", "queen we will rock you", "drums", D_EASY),
    ("Queen - Another One Bites the Dust", "queen another one bites the dust", "drums", D_EASY),
    ("The White Stripes - Seven Nation Army", "seven nation army", "drums", D_EASY),
    ("Deep Purple - Smoke on the Water", "deep purple smoke on the water", "drums", D_EASY),
    ("Survivor - Eye of the Tiger", "eye of the tiger", "drums", D_EASY),
    # ---- drums: stepping up ----
    ("Led Zeppelin - When the Levee Breaks", "led zeppelin when the levee breaks", "drums", D_UP),
    ("Led Zeppelin - Rock and Roll", "led zeppelin rock and roll", "drums", D_UP),
    ("Led Zeppelin - Whole Lotta Love", "led zeppelin whole lotta love", "drums", D_UP),
    ("Pink Floyd - Another Brick in the Wall", "pink floyd another brick in the wall", "drums", D_UP),
    ("Pink Floyd - Money", "pink floyd money", "drums", D_UP),
    ("Pink Floyd - Time", "pink floyd time", "drums", D_UP),
    ("Black Sabbath - Paranoid", "black sabbath paranoid", "drums", D_UP),
    ("Black Sabbath - Iron Man", "black sabbath iron man", "drums", D_UP),
    ("Black Sabbath - War Pigs", "black sabbath war pigs", "drums", D_UP),
    ("Metallica - Enter Sandman", "metallica enter sandman", "drums", D_UP),
    ("Nirvana - Smells Like Teen Spirit", "nirvana smells like teen spirit", "drums", D_UP),
    ("Nirvana - Come As You Are", "nirvana come as you are", "drums", D_UP),
    # ---- drums: reach ----
    ("Iron Maiden - The Trooper", "iron maiden the trooper", "drums", D_REACH),
    ("Iron Maiden - Run to the Hills", "iron maiden run to the hills", "drums", D_REACH),
    ("Iron Maiden - Fear of the Dark", "iron maiden fear of the dark", "drums", D_REACH),
    ("Rush - Tom Sawyer", "rush tom sawyer", "drums", D_REACH),
    ("Led Zeppelin - Good Times Bad Times", "led zeppelin good times bad times", "drums", D_REACH),
    ("Nightwish - Nemo", "nightwish nemo", "drums", D_REACH),
    # ---- piano: first steps (achievable + emotional) ----
    ("Beethoven - Fur Elise", "fur elise", "piano", P_FIRST),
    ("Satie - Gymnopedie No 1", "satie gymnopedie no 1", "piano", P_FIRST),
    ("Beethoven - Ode to Joy", "ode to joy", "piano", P_FIRST),
    ("Pachelbel - Canon in D", "pachelbel canon in d", "piano", P_FIRST),
    ("Traditional - Greensleeves", "greensleeves", "piano", P_FIRST),
    ("Mozart - Eine Kleine Nachtmusik", "eine kleine nachtmusik", "piano", P_FIRST),
    # ---- piano: classical ----
    ("Beethoven - Moonlight Sonata", "beethoven moonlight sonata", "piano", P_CLASS),
    ("Chopin - Nocturne Op 9 No 2", "chopin nocturne op 9 no 2", "piano", P_CLASS),
    ("Chopin - Prelude in E minor", "chopin prelude e minor op 28 no 4", "piano", P_CLASS),
    ("Debussy - Clair de Lune", "debussy clair de lune", "piano", P_CLASS),
    ("Einaudi - Nuvole Bianche", "einaudi nuvole bianche", "piano", P_CLASS),
    ("Bach - Air on the G String", "bach air on the g string", "piano", P_CLASS),
    ("Grieg - In the Hall of the Mountain King", "in the hall of the mountain king", "piano", P_CLASS),
    ("Beethoven - Moonlight 3rd Movement", "moonlight sonata 3rd movement", "piano", P_CLASS),
    # ---- piano: rock & metal ----
    ("Evanescence - My Immortal", "evanescence my immortal", "piano", P_ROCK),
    ("Metallica - Nothing Else Matters", "metallica nothing else matters", "piano", P_ROCK),
    ("Meat Loaf - I'd Do Anything for Love", "meat loaf i would do anything for love", "piano", P_ROCK),
    ("Meat Loaf - Bat Out of Hell", "meat loaf bat out of hell", "piano", P_ROCK),
    ("Queen - Bohemian Rhapsody", "queen bohemian rhapsody", "piano", P_ROCK),
    ("Guns N Roses - November Rain", "guns n roses november rain", "piano", P_ROCK),
    ("Coldplay - Clocks", "coldplay clocks", "piano", P_ROCK),
    ("Nightwish - Sleeping Sun", "nightwish sleeping sun", "piano", P_ROCK),
    ("Elton John - Rocket Man", "elton john rocket man", "piano", P_ROCK),
    ("Pink Floyd - Great Gig in the Sky", "pink floyd great gig in the sky", "piano", P_ROCK),
]


def api_search(q):
    url = "https://bitmidi.com/api/midi/search?q=" + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers=HDR)
    data = json.loads(urllib.request.urlopen(req, timeout=15).read())
    return data.get("result", {}).get("results", [])


def download(dlurl, dest):
    req = urllib.request.Request("https://bitmidi.com" + dlurl, headers=HDR)
    b = urllib.request.urlopen(req, timeout=25).read()
    with open(dest, "wb") as f:
        f.write(b)


def vet(path, kind):
    try:
        vm = build_view_model(path, kbd_lo=21, kbd_hi=108)
    except Exception:
        return None
    ch9 = sum(1 for n in vm["notes"] if n["ch"] == 9)
    mel = sum(1 for n in vm["notes"] if n["ch"] != 9)
    ok = (ch9 >= 150) if kind == "drums" else (mel >= 120)
    return {"ok": ok, "ch9": ch9, "mel": mel}


def main():
    kept = fail = 0
    by_group = {}
    for name, query, kind, group in SONGS:
        folder = os.path.join(MUSIC, group)
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, name + ".mid")
        if os.path.exists(dest):
            print("skip  ", name); kept += 1; continue
        try:
            results = sorted(api_search(query), key=lambda r: r.get("plays", 0), reverse=True)
        except Exception as e:
            print("SRCHX ", name, e); fail += 1; continue
        chosen = None
        for r in results[:5]:
            tmp = dest + ".tmp"
            try:
                download(r["downloadUrl"], tmp)
            except Exception:
                continue
            st = vet(tmp, kind)
            if st and st["ok"]:
                os.replace(tmp, dest); chosen = st; break
            if os.path.exists(tmp):
                os.remove(tmp)
            time.sleep(0.2)
        if chosen:
            kept += 1; by_group[group] = by_group.get(group, 0) + 1
            print("OK    ", name, "(ch9=%d mel=%d)" % (chosen["ch9"], chosen["mel"]))
        else:
            fail += 1; print("NONE  ", name, "(no good transcription)")
        time.sleep(0.3)
    print("\n=== kept %d, failed %d ===" % (kept, fail))
    for g in sorted(by_group):
        print("  %-26s %d" % (g, by_group[g]))


if __name__ == "__main__":
    main()
