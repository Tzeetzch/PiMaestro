#!/usr/bin/env python3
"""Headless smoke test: load the app in headless Chromium via the DevTools protocol,
capture every console error + unhandled promise rejection, confirm the modules are wired,
and drive the D-pad once so PiNav's listener/navCols/focusAt path actually runs.
Run on the Pi: python3 verify_web.py   (exits 0 = clean, 1 = problems)."""
import json, os, socket, struct, subprocess, sys, time, urllib.request, base64, hashlib

URL = "http://localhost:8080/"
PORT = 9333


def ws_connect(ws_url):
    host, rest = ws_url.split("://", 1)[1].split("/", 1)
    h, p = (host.split(":") + ["80"])[:2]
    s = socket.create_connection((h, int(p)), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET /{rest} HTTP/1.1\r\nHost: {h}:{p}\r\nUpgrade: websocket\r\n"
           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(1)
    return s


def ws_send(s, data):
    payload = data.encode()
    hdr = bytearray([0x81])
    n = len(payload)
    mask = os.urandom(4)
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
    hdr += mask
    s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def ws_recv(s):
    def rd(n):
        b = b""
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c:
                raise ConnectionError
            b += c
        return b
    b0, b1 = rd(2)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack(">H", rd(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", rd(8))[0]
    return rd(n).decode("utf-8", "replace")


def main():
    chrome = subprocess.Popen(
        ["chromium", "--headless=new", f"--remote-debugging-port={PORT}",
         "--no-sandbox", "--disable-gpu", "--window-size=1280,720", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tab = None
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://localhost:{PORT}/json"))
                pages = [t for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
                if pages:
                    tab = pages[0]
                    break
            except Exception:
                time.sleep(0.2)
        ws = ws_connect(tab["webSocketDebuggerUrl"])
        mid = [0]
        def cmd(method, params=None, wait=True):
            mid[0] += 1
            i = mid[0]
            ws_send(ws, json.dumps({"id": i, "method": method, "params": params or {}}))
            if not wait:
                return None
            while True:
                m = json.loads(ws_recv(ws))
                if m.get("id") == i:
                    return m

        cmd("Runtime.enable"); cmd("Log.enable"); cmd("Page.enable")
        # collector installed in-page: errors + unhandled rejections
        cmd("Page.addScriptToEvaluateOnNewDocument", {"source":
            "window.__errs=[];addEventListener('error',e=>__errs.push('error: '+(e.message||e)));"
            "addEventListener('unhandledrejection',e=>__errs.push('reject: '+(e.reason&&e.reason.message||e.reason)));"})
        cmd("Page.navigate", {"url": URL})

        def ev(expr):
            r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            res = r.get("result", {}).get("result", {})
            return res.get("value")

        # wait for the document to actually finish loading (poll readyState), then settle
        for _ in range(40):
            if ev("document.readyState") == "complete" and ev("location.href").startswith("http"):
                break
            time.sleep(0.25)
        time.sleep(2.5)  # let SSE hello + PiLib.load + render settle

        print("DIAG href:", ev("location.href"), "| readyState:", ev("document.readyState"),
              "| scripts:", ev("document.scripts.length"), "| body len:", ev("document.body? document.body.innerHTML.length : -1"))

        problems = []
        mods = ev("[typeof PiSession,typeof PiTV,typeof PiSound,typeof PiSse,typeof PiCatalog,typeof PiLib,typeof PiNav,typeof PiTransport,typeof PiSetup].join(',')")
        if "undefined" in (mods or "undefined"):
            problems.append(f"a module is missing: {mods}")
        # catalogue -> selector: PiCatalog.load() populated songs and the selector rendered the grid
        nsongs = ev("PiCatalog.songs().length")
        ngrid = ev("document.querySelectorAll('#songList .songitem').length")
        if not nsongs:
            problems.append("PiCatalog.songs() empty (catalogue did not load)")
        if not ngrid:
            problems.append("song grid empty (selector did not render from catalogue)")
        print("catalogue -> songs:", nsongs, "| grid items:", ngrid)

        # drive the library + d-pad: go to library, press Down, confirm focus moved and kbd-mode on
        ev("document.getElementById('homeStart').click()")
        time.sleep(0.4)
        ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))")
        time.sleep(0.2)
        kbd = ev("PiNav.isKbd()")
        active = ev("document.activeElement && document.activeElement.tagName + (document.activeElement.className?'.'+document.activeElement.className:'')")
        navhere = ev("!!document.querySelector('.nav-here')")
        if not kbd:
            problems.append("PiNav.isKbd() false after ArrowDown")
        if not navhere:
            problems.append("no .nav-here element after ArrowDown (focus didn't move)")

        # pick the first song -> setup screen should appear with a title
        ev("var s=document.querySelector('.songitem'); if(s) s.click()")
        time.sleep(1.5)
        setup = ev("!document.getElementById('screenSetup').hidden")
        title = ev("(document.getElementById('setupTitle')||{}).textContent")
        if not setup:
            problems.append("setup screen did not show after picking a song")
        # PiSession holds the loaded-song state the other boxes read
        sess = ev("(PiSession.vm ? 'vm' : '-') + ',' + (PiSession.file ? 'file' : '-') + ',' + (Array.isArray(PiSession.play) ? 'play[' + PiSession.play.length + ']' : '-')")
        if not (sess and sess.startswith("vm,file,")):
            problems.append("PiSession not populated after pick: " + str(sess))
        print("session -> ", sess)
        # render smoke: the vmLay fix changed setSong + the draw loop + drawNote. Enter the stage so
        # rAF actually draws frames against the loaded song (exercises vmLay.lx/top + drawNote), then pause.
        ev("document.getElementById('play').click()")
        time.sleep(1.5)
        clockt = ev("PiTV.clockState().t")
        drew = ev("PiTV.clockState().t > -3.49")     # clock advanced from -LOOKAHEAD => frames ran
        ev("var p=document.getElementById('play'); if(p && /Pause/.test(p.textContent)) p.click();")  # pause back
        time.sleep(0.4)
        if not drew:
            problems.append("canvas frames did not advance after play (clock t=" + str(clockt) + ")")
        print("render smoke -> clock t:", clockt, "| frames ran:", drew)
        # transport: entering Setup runs PiTransport.buildLoop -> #loopPanel should be populated
        loopui = ev("var lp=document.getElementById('loopPanel'); !!(lp && lp.querySelector('.hint'))")
        loopbtn = ev("!!document.querySelector('#loopPanel button')")   # bar table present -> Loop button built
        if not loopui:
            problems.append("loop panel not built on Setup (PiTransport.buildLoop)")
        # click-to-seek must not throw (PiTransport owns #seek's handler now)
        seekok = ev("try{document.getElementById('seek').click(); 'ok'}catch(e){'THROW: '+e}")
        if seekok != "ok":
            problems.append("seek click threw: " + str(seekok))
        # toggle the loop on: exercises applyLoop -> injected showLoop -> PiTV.setLoop (must not throw)
        loopok = ev("try{var b=document.querySelector('#loopPanel button'); if(b)b.click(); 'ok'}catch(e){'THROW: '+e}")
        if loopok != "ok":
            problems.append("loop toggle threw: " + str(loopok))
        print("transport -> loop hint:", loopui, "| loop button:", loopbtn, "| seek click:", seekok)
        # setup screen: PiSetup built the Part dropdown + the instruments panel + the hero
        partopts = ev("document.getElementById('handSel').options.length")
        instrrows = ev("document.querySelectorAll('#instrPanel .row, #instrPanel .hint').length")
        herotitle = ev("(document.getElementById('setupTitle')||{}).textContent")
        modehint = ev("(document.getElementById('modeHint')||{}).textContent || ''")
        if not partopts:
            problems.append("Part dropdown empty (PiSetup.buildPartOptions)")
        if not instrrows:
            problems.append("instruments panel empty (PiSetup.buildInstr)")
        if not (modehint and len(modehint) > 5):
            problems.append("mode hint empty (PiSetup.updateModeHint)")
        print("setup -> part opts:", partopts, "| instr rows:", instrrows, "| hero:", herotitle, "| mode hint set:", bool(modehint))
        # ownership cleanup: changing the Part dropdown (PiSetup owns it -> onPart) must not throw,
        # and the position bar readout (PiTransport.showProgress) must paint without throwing.
        partchg = ev("try{var h=document.getElementById('handSel'); if(h&&h.options.length>1){h.selectedIndex=1; h.dispatchEvent(new Event('change'));} 'ok'}catch(e){'THROW: '+e}")
        progok = ev("try{PiTransport.showProgress(5,10); var w=document.getElementById('seekfill').style.width; (w&&w!=='0%')?'ok':'no-paint:'+w}catch(e){'THROW: '+e}")
        if partchg != "ok":
            problems.append("Part-dropdown change threw: " + str(partchg))
        if progok != "ok":
            problems.append("showProgress issue: " + str(progok))
        print("ownership -> part change:", partchg, "| showProgress paint:", progok)

        errs = ev("JSON.stringify(window.__errs||[])")
        errlist = json.loads(errs or "[]")

        print("modules (PiSession,PiTV,PiSound,PiSse,PiCatalog,PiLib,PiNav,PiTransport,PiSetup):", mods)
        print("after ArrowDown -> kbd:", kbd, "| active:", active, "| nav-here:", navhere)
        print("after pick -> setup shown:", setup, "| title:", title)
        print("JS errors / rejections:", errlist if errlist else "none")
        print("problems:", problems if problems else "NONE")
        ok = not problems and not errlist
        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        chrome.terminate()


if __name__ == "__main__":
    sys.exit(main())
