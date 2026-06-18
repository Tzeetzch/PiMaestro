/* PiMaestro transport: the position controls — click-to-seek on the bar + loop-a-passage drilling.
   These are the "where the playhead goes" controls. (Play/Pause/Reset themselves stay in app.js,
   because they also drive the screen router and the end-of-song reward flow — they're the play-flow
   orchestrator, not just transport.) This is the SOLE owner of the position bar — the loop state +
   builder UI in #loopPanel, the #seek click handler, AND the fill/time readout (#seekfill / #time),
   which the app's pos heartbeat drives through showProgress(t, duration).

   Exposed as a global PiTransport (like PiTV / PiSound / PiSse / PiLib / PiNav). The app injects the
   current song (bar table + duration), control (to tell the engine), and showLoop (to mirror the loop
   on the canvas). The app calls buildLoop on entering Setup and clearLoop on a new song. */
const PiTransport = (function () {
  const $ = id => document.getElementById(id);
  const seekEl = $('seek'), seekFill = $('seekfill'), timeEl = $('time'), loopPanel = $('loopPanel');
  // Black-box contract: PiTransport names no sibling module. It mirrors the loop on the canvas through
  // the injected showLoop(start,end) (the app wires it to PiTV); we never reach for PiTV ourselves.
  let ctx = { getVM: () => null, control: () => Promise.resolve(), showLoop: () => {} };
  let loopOn = false, loopFromEl = null, loopToEl = null, loopToggleEl = null, lastPct = -1;
  function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  // Paint the position bar from the play heartbeat (PiTransport is the sole owner of #seek/#seekfill/#time).
  function showProgress(t, dur) {
    const pct = dur > 0 ? Math.max(0, Math.min(100, t / dur * 100)) : 0;
    if (Math.abs(pct - lastPct) < 0.2) return;            // only repaint on a meaningful move
    seekFill.style.width = pct + '%';
    seekEl.setAttribute('aria-valuenow', Math.round(pct));
    seekEl.setAttribute('aria-valuetext', fmtTime(t) + ' of ' + fmtTime(dur));   // screen reader: time, not bare %
    timeEl.textContent = fmtTime(t) + ' / ' + fmtTime(dur);
    lastPct = pct;
  }

  function barCount() { const vm = ctx.getVM(); const b = vm && vm.bars; return (b && b.length) ? b.length - 1 : 0; }
  function clampBar(n) { const m = barCount(); return Math.max(1, Math.min(m || 1, Math.round(n) || 1)); }
  function barStart(n) { const b = ctx.getVM().bars; return b[clampBar(n) - 1]; }
  function barEnd(n) { const vm = ctx.getVM(), b = vm.bars, i = Math.min(clampBar(n), b.length - 1); return Math.min(b[i] != null ? b[i] : vm.duration, vm.duration); }
  function applyLoop() {
    const vm = ctx.getVM();
    if (!vm || !loopOn) { ctx.control({ cmd: 'loop', start: null, end: null }).catch(() => {}); ctx.showLoop(null, null); return; }
    let from = clampBar(+loopFromEl.value), to = clampBar(+loopToEl.value);
    if (to < from) { to = from; loopToEl.value = to; }
    loopFromEl.value = from;
    const start = barStart(from), end = barEnd(to);
    ctx.control({ cmd: 'loop', start, end }).catch(() => {});
    ctx.showLoop(start, end);
  }
  function clearLoop() { loopOn = false; if (loopToggleEl) loopToggleEl.classList.remove('on'); ctx.control({ cmd: 'loop', start: null, end: null }).catch(() => {}); ctx.showLoop(null, null); }
  function buildLoop() {
    loopPanel.innerHTML = '';
    const total = barCount();
    const hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = total ? ('Repeats these bars while you play (song has ' + total + ' bars).') : 'Load a song first.';
    loopPanel.appendChild(hint);
    if (!total) return;
    const row = document.createElement('div'); row.className = 'row';
    const mk = (val) => { const i = document.createElement('input'); i.type = 'number'; i.min = 1; i.max = total; i.value = val; i.onchange = () => { if (loopOn) applyLoop(); }; return i; };
    loopFromEl = mk(1); loopToEl = mk(Math.min(total, 4));
    row.appendChild(document.createTextNode('From'));
    row.appendChild(loopFromEl);
    row.appendChild(document.createTextNode('to'));
    row.appendChild(loopToEl);
    loopPanel.appendChild(row);
    const brow = document.createElement('div'); brow.className = 'row';
    loopToggleEl = document.createElement('button'); loopToggleEl.className = 'pbtn' + (loopOn ? ' on' : '');
    loopToggleEl.textContent = loopOn ? 'Looping' : 'Loop on';
    loopToggleEl.onclick = () => {
      loopOn = !loopOn;
      loopToggleEl.classList.toggle('on', loopOn);
      loopToggleEl.textContent = loopOn ? 'Looping' : 'Loop on';
      applyLoop();
    };
    brow.appendChild(loopToggleEl);
    loopPanel.appendChild(brow);
  }
  seekEl.onclick = (e) => {                              // click the bar to jump to that spot
    const vm = ctx.getVM(); if (!vm) return;
    const r = seekEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    ctx.control({ cmd: 'seek', t: frac * vm.duration }).catch(() => {});
  };

  return {
    init(c) { Object.assign(ctx, c); },
    buildLoop,                                           // app calls on entering Setup / after a load
    clearLoop,                                           // app calls when a new song loads (bar counts differ)
    showProgress,                                        // app's pos heartbeat paints the bar through this
  };
})();
