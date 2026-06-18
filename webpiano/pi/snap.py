#!/usr/bin/env python3
"""Headless screenshot of the stage for a given song+part — to eyeball the notation (beaming).
Run on the Pi:  python3 snap.py "Seven Nation Army" drums 30   ->  writes /tmp/snap.png
args: <title substring> <part: drums|both|R|L> <seek seconds>"""
import base64, json, os, socket, struct, subprocess, sys, time, urllib.request

PORT = 9334
TITLE = sys.argv[1] if len(sys.argv) > 1 else "Seven Nation Army"
PART = sys.argv[2] if len(sys.argv) > 2 else "drums"
SEEK = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
OUT = "/tmp/snap.png"


def ws_connect(u):
    host, rest = u.split("://", 1)[1].split("/", 1)
    h, p = (host.split(":") + ["80"])[:2]
    s = socket.create_connection((h, int(p)), timeout=10)
    k = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /{rest} HTTP/1.1\r\nHost: {h}:{p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {k}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(1)
    return s


def send(s, d):
    p = d.encode(); h = bytearray([0x81]); n = len(p); m = os.urandom(4)
    if n < 126: h.append(0x80 | n)
    elif n < 65536: h.append(0x80 | 126); h += struct.pack(">H", n)
    else: h.append(0x80 | 127); h += struct.pack(">Q", n)
    h += m; s.sendall(bytes(h) + bytes(b ^ m[i % 4] for i, b in enumerate(p)))


def recv(s):
    def rd(n):
        b = b""
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c: raise ConnectionError
            b += c
        return b
    b0, b1 = rd(2); n = b1 & 0x7F
    if n == 126: n = struct.unpack(">H", rd(2))[0]
    elif n == 127: n = struct.unpack(">Q", rd(8))[0]
    return rd(n).decode("utf-8", "replace")


def main():
    chrome = subprocess.Popen(["chromium", "--headless=new", f"--remote-debugging-port={PORT}",
                               "--no-sandbox", "--disable-gpu", "--window-size=1280,720", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tab = None
        for _ in range(50):
            try:
                t = [x for x in json.load(urllib.request.urlopen(f"http://localhost:{PORT}/json")) if x.get("type") == "page"]
                if t: tab = t[0]; break
            except Exception: time.sleep(0.2)
        ws = ws_connect(tab["webSocketDebuggerUrl"]); mid = [0]

        def cmd(method, params=None):
            mid[0] += 1; i = mid[0]
            send(ws, json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                m = json.loads(recv(ws))
                if m.get("id") == i: return m

        def ev(expr):
            return cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True}).get("result", {}).get("result", {}).get("value")

        cmd("Page.enable"); cmd("Runtime.enable")
        cmd("Page.navigate", {"url": "http://localhost:8080/"})
        for _ in range(40):
            if ev("document.readyState") == "complete": break
            time.sleep(0.25)
        time.sleep(2.5)
        # pick the song by title, choose the part, enter the stage, seek into the groove
        ev("var f=PiCatalog.songs().find(s=>s.title.indexOf(%r)>=0); if(f) PiLib.showGroupOf(f.file);" % TITLE)
        time.sleep(0.3)
        picked = ev("var li=[...document.querySelectorAll('#songList .songitem')].find(e=>e.textContent.indexOf(%r)>=0); if(li){li.click(); 'ok'} else 'not-found'" % TITLE)
        time.sleep(1.5)
        ev("var h=document.getElementById('handSel'); if(h){h.value=%r; h.dispatchEvent(new Event('change'));}" % PART)
        time.sleep(0.5)
        ev("document.getElementById('play').click()")
        time.sleep(0.6)
        ev("fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'seek',t:%f})})" % SEEK)
        time.sleep(1.6)
        info = ev("({pick:%r, view: PiNav?1:1, drumMode: (function(){try{return !!document.querySelector('canvas')}catch(e){return false}})(), t: PiTV.clockState().t})" % picked)
        png = cmd("Page.captureScreenshot", {"format": "png"})["result"]["data"]
        open(OUT, "wb").write(base64.b64decode(png))
        print("picked:", picked, "| clock t:", round(ev("PiTV.clockState().t") or -99, 1), "| wrote", OUT, os.path.getsize(OUT), "bytes")
    finally:
        chrome.terminate()


if __name__ == "__main__":
    main()
