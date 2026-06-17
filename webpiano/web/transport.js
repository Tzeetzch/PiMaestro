/* PiMaestro transport: the position controls — click-to-seek on the bar + loop-a-passage drilling.
   These are the "where the playhead goes" controls. (Play/Pause/Reset themselves stay in app.js,
   because they also drive the screen router and the end-of-song reward flow — they're the play-flow
   orchestrator, not just transport.) This owns the loop state + the loop builder UI in #loopPanel
   and the click handler on #seek; the app's pos heartbeat still paints the bar's fill/time readout.

   Exposed as a global PiTransport (like PiTV / PiSound / PiSse / PiLib / PiNav). The app injects the
   current song (bar table + duration) and control (to tell the engine); we mirror the loop on the
   canvas through PiTV.setLoop. The app calls buildLoop on entering Setup and clearLoop on a new song. */
const PiTransport = (function () {
  const $ = id => document.getElementById(id);
  const seekEl = $('seek'), loopPanel = $('loopPanel');
  let ctx = { getVM: () => null, control: () => Promise.resolve() };
  let loopOn = false, loopFromEl = null, loopToEl = null, loopToggleEl = null;

  function barCount() { const vm = ctx.getVM(); const b = vm && vm.bars; return (b && b.length) ? b.length - 1 : 0; }
  function clampBar(n) { const m = barCount(); return Math.max(1, Math.min(m || 1, Math.round(n) || 1)); }
  function barStart(n) { const b = ctx.getVM().bars; return b[clampBar(n) - 1]; }
  function barEnd(n) { const vm = ctx.getVM(), b = vm.bars, i = Math.min(clampBar(n), b.length - 1); return Math.min(b[i] != null ? b[i] : vm.duration, vm.duration); }
  function applyLoop() {
    const vm = ctx.getVM();
    if (!vm || !loopOn) { ctx.control({ cmd: 'loop', start: null, end: null }).catch(() => {}); PiTV.setLoop(null, null); return; }
    let from = clampBar(+loopFromEl.value), to = clampBar(+loopToEl.value);
    if (to < from) { to = from; loopToEl.value = to; }
    loopFromEl.value = from;
    const start = barStart(from), end = barEnd(to);
    ctx.control({ cmd: 'loop', start, end }).catch(() => {});
    PiTV.setLoop(start, end);
  }
  function clearLoop() { loopOn = false; if (loopToggleEl) loopToggleEl.classList.remove('on'); ctx.control({ cmd: 'loop', start: null, end: null }).catch(() => {}); PiTV.setLoop(null, null); }
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
  };
})();
