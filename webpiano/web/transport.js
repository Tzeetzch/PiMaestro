/* PiMaestro transport: the position controls — click-to-seek on the bar, bar-by-bar stepping, and
   loop-a-passage drilling. These are the "where the playhead goes" controls. (Play/Pause/Reset
   themselves stay in app.js, because they also drive the screen router and the end-of-song reward
   flow — they're the play-flow orchestrator, not just transport.) This is the SOLE owner of:
     - the position bar: the #seek click handler + the fill/time readout (#seekfill / #time), which the
       app's pos heartbeat drives through showProgress(t, duration);
     - the loop state, shown in TWO places that stay in sync: the Setup card (#loopPanel: From/to bars)
       and the stage header (#loopA / #loopB / #loopX + #loopLbl) for setting it while you play;
     - the bar readouts (#barNow in the header, #pBar in the pause panel) + the ◀/▶ bar steppers.

   Exposed as a global PiTransport (like PiTV / PiSound / PiSse / PiLib / PiNav). The app injects the
   current song (bar table + duration), control (to tell the engine), and showLoop (to mirror the loop
   on the canvas). The app calls buildLoop on entering Setup and clearLoop on a new song. */
const PiTransport = (function () {
  const $ = id => document.getElementById(id);
  const seekEl = $('seek'), seekFill = $('seekfill'), timeEl = $('time'), loopPanel = $('loopPanel');
  const barNowEl = $('barNow'), loopLbl = $('loopLbl'), loopA = $('loopA'), loopB = $('loopB'), loopX = $('loopX'),
        pBar = $('pBar'), pPrev = $('pPrev'), pNext = $('pNext');
  // Black-box contract: PiTransport names no sibling module. It mirrors the loop on the canvas through
  // the injected showLoop(start,end) (the app wires it to PiTV); we never reach for PiTV ourselves.
  let ctx = { getVM: () => null, control: () => Promise.resolve(), showLoop: () => {} };
  // Loop state lives HERE (not in the Setup inputs) so the header A/B and the Setup card share it.
  // pendingA: A was pressed, waiting for B (shown in the header; not looping yet).
  let loopOn = false, loopFrom = 1, loopTo = 4, pendingA = false;
  let loopFromEl = null, loopToEl = null, loopToggleEl = null, lastPct = -1, lastT = 0, lastBar = -1;
  function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  // Paint the position bar from the play heartbeat (PiTransport is the sole owner of #seek/#seekfill/#time).
  function showProgress(t, dur) {
    lastT = t;
    paintBar();
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
  // The 1-based bar the playhead is in (binary search over the bar start times).
  function curBar() {
    const vm = ctx.getVM(), b = vm && vm.bars, m = barCount(); if (!m) return 1;
    let lo = 0, hi = m - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= lastT + 0.02) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  function paintBar() {                                  // header + pause readouts, only when the bar changes
    const m = barCount(), n = m ? curBar() : 0;
    if (n === lastBar) return;
    lastBar = n;
    const txt = m ? ('Bar ' + n + ' / ' + m) : 'Bar —';
    if (barNowEl) barNowEl.textContent = txt;
    if (pBar) pBar.textContent = txt;
  }
  // One place that reflects the loop state everywhere (header label/buttons + the Setup card).
  function reflectLoop() {
    if (loopLbl) {
      loopLbl.textContent = loopOn ? ('Loop ' + loopFrom + '–' + loopTo) : pendingA ? ('From bar ' + loopFrom + '… press B') : 'Loop off';
      loopLbl.classList.toggle('on', loopOn);
    }
    if (loopA) loopA.classList.toggle('on', pendingA || loopOn);
    if (loopB) loopB.classList.toggle('on', loopOn);
    if (loopX) loopX.disabled = !(loopOn || pendingA);
    if (loopFromEl) loopFromEl.value = loopFrom;
    if (loopToEl) loopToEl.value = loopTo;
    if (loopToggleEl) { loopToggleEl.classList.toggle('on', loopOn); loopToggleEl.textContent = loopOn ? 'Looping' : 'Loop on'; }
  }
  function applyLoop() {
    const vm = ctx.getVM();
    if (!vm || !loopOn) { ctx.control({ cmd: 'loop', start: null, end: null }).catch(() => {}); ctx.showLoop(null, null); reflectLoop(); return; }
    loopFrom = clampBar(loopFrom); loopTo = clampBar(loopTo);
    if (loopTo < loopFrom) loopTo = loopFrom;
    const start = barStart(loopFrom), end = barEnd(loopTo);
    ctx.control({ cmd: 'loop', start, end }).catch(() => {});
    ctx.showLoop(start, end);
    reflectLoop();
  }
  function clearLoop() {
    loopOn = false; pendingA = false;
    ctx.control({ cmd: 'loop', start: null, end: null }).catch(() => {}); ctx.showLoop(null, null);
    lastBar = -1; paintBar(); reflectLoop();
  }
  // Header A/B: A = "the hard part starts in THIS bar", B = "...and ends in this bar" -> loop at once.
  function markA() {
    if (!barCount()) return;
    loopFrom = curBar(); pendingA = true;
    if (loopOn) { loopOn = false; applyLoop(); } else reflectLoop();   // re-marking A starts a new loop
  }
  function markB() {
    if (!barCount()) return;
    const n = curBar();
    if (!pendingA && !loopOn) loopFrom = n;              // B without A: loop just this bar
    loopTo = Math.max(n, loopFrom);
    if (n < loopFrom) { loopTo = loopFrom; loopFrom = n; }   // marked backwards: swap
    pendingA = false; loopOn = true;
    applyLoop();
  }
  // ◀ / ▶ : jump to the start of the previous / next bar (precise, D-pad friendly — no fiddly clicking).
  function stepBar(d) {
    if (!barCount()) return;
    const cur = curBar();
    // ◀ inside a bar (past its first beat) goes to THIS bar's start first, like a media player.
    const target = (d < 0 && lastT - barStart(cur) > 0.25) ? cur : clampBar(cur + d);
    lastT = barStart(target); lastBar = -1; paintBar();  // update the readout now; the engine echoes the pos
    ctx.control({ cmd: 'seek', t: barStart(target) }).catch(() => {});
  }
  function buildLoop() {
    loopPanel.innerHTML = '';
    const total = barCount();
    const hint = document.createElement('div'); hint.className = 'hint';
    hint.textContent = total ? ('Repeats these bars while you play (song has ' + total + ' bars). Tip: while playing, use A and B in the top bar.') : 'Load a song first.';
    loopPanel.appendChild(hint);
    if (!total) return;
    const row = document.createElement('div'); row.className = 'row';
    const mk = (val, set) => { const i = document.createElement('input'); i.type = 'number'; i.min = 1; i.max = total; i.value = val; i.onchange = () => { set(+i.value); if (loopOn) applyLoop(); else reflectLoop(); }; return i; };
    loopFromEl = mk(loopFrom, v => { loopFrom = clampBar(v); }); loopToEl = mk(Math.min(total, loopTo), v => { loopTo = clampBar(v); });
    row.appendChild(document.createTextNode('From'));
    row.appendChild(loopFromEl);
    row.appendChild(document.createTextNode('to'));
    row.appendChild(loopToEl);
    loopPanel.appendChild(row);
    const brow = document.createElement('div'); brow.className = 'row';
    loopToggleEl = document.createElement('button'); loopToggleEl.className = 'pbtn';
    loopToggleEl.onclick = () => { loopOn = !loopOn; pendingA = false; applyLoop(); };
    brow.appendChild(loopToggleEl);
    loopPanel.appendChild(brow);
    reflectLoop();
  }
  seekEl.onclick = (e) => {                              // click the bar to jump to that spot
    const vm = ctx.getVM(); if (!vm) return;
    const r = seekEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    ctx.control({ cmd: 'seek', t: frac * vm.duration }).catch(() => {});
  };
  if (loopA) loopA.onclick = markA;
  if (loopB) loopB.onclick = markB;
  if (loopX) loopX.onclick = clearLoop;
  if (pPrev) pPrev.onclick = () => stepBar(-1);
  if (pNext) pNext.onclick = () => stepBar(1);
  reflectLoop();

  return {
    init(c) { Object.assign(ctx, c); },
    buildLoop,                                           // app calls on entering Setup / after a load
    clearLoop,                                           // app calls when a new song loads (bar counts differ)
    showProgress,                                        // app's pos heartbeat paints the bar through this
    stepBar,                                             // ◀/▶ one bar (also bound to keys by the app/nav)
  };
})();
