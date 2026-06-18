/* PiMaestro D-pad / keyboard navigation: the TV remote (and a real keyboard) drive the whole UI
   with just arrows + Enter + Back + Space. This owns the focus-mode flag (kbd), the column model
   of each screen (navCols), focus movement (navMove / focusAt / focusFirst), seek-by-arrow, and the
   two document-level listeners. The app injects what nav can't know on its own — the current view,
   whether a song is playing, the loaded song (for seek), and the actions to take (go / openPause /
   control). Exposed as a global PiNav, like PiTV / PiSound / PiSse / PiLib. */
const PiNav = (function () {
  const $ = id => document.getElementById(id);
  const backBtn = $('quitStage'), playBtn = $('play'), resetBtn = $('reset'), viewBtn = $('view'), seekEl = $('seek'),
        groupTabs = $('groupTabs'), songList = $('songList'), uploadBtn = $('uploadBtn'), startBtn = $('startBtn'),
        finish = $('finish'), finAgain = $('finAgain'), finPick = $('finPick'),
        pauseEl = $('pause'), pMode = $('pMode'), pSpeed = $('pSpeed'), pHand = $('pHand'),
        pResume = $('pResume'), pRestart = $('pRestart'), pMore = $('pMore'), pQuit = $('pQuit');

  let kbd = false;                                        // true once the user drives by keys -> show focus ring
  let ctx = {
    screens: {}, parent: {},
    getView: () => 'home', getPlaying: () => false, getVM: () => null, getLastT: () => 0,
    control: () => Promise.resolve(), go: () => {}, openPause: () => {},
  };

  function vis(el) { return el && el.offsetParent !== null && !el.disabled; }
  function navCols() {
    const view = ctx.getView();
    if (!pauseEl.hidden) return [[pMode, pSpeed, pHand, pResume, pRestart, pMore, pQuit].filter(vis)];
    if (!finish.hidden) return [[finAgain, finPick].filter(vis)];
    if (view === 'stage') return [[backBtn, playBtn, resetBtn, viewBtn, seekEl].filter(vis)];
    const sc = $(ctx.screens[view]);
    if (view === 'library') {                             // category rail | the song GRID (modeled as real columns)
      const tabs = Array.from(groupTabs.querySelectorAll('.gcat, .gtab')).filter(vis);
      const items = Array.from(songList.querySelectorAll('.songitem')).filter(vis);
      if (!items.length) return [tabs, [songList.querySelector('.hint.empty'), uploadBtn].filter(vis)];
      const rows = []; let top = null, row = null;        // group tiles into visual rows by their top edge...
      for (const it of items) {
        if (top === null || Math.abs(it.offsetTop - top) > 4) { row = []; rows.push(row); top = it.offsetTop; }
        row.push(it);
      }
      const ncol = Math.max.apply(null, rows.map(r => r.length));   // ...then transpose to columns for D-pad L/R/U/D
      const cols = [tabs];
      for (let c = 0; c < ncol; c++) cols.push(rows.map(r => r[c]).filter(Boolean));
      cols[cols.length - 1] = cols[cols.length - 1].concat([uploadBtn].filter(vis));
      return cols;
    }
    return [Array.from(sc.querySelectorAll('button, select, summary, input[type=checkbox], input[type=range], .songitem')).filter(vis)];
  }
  function focusAt(el) {
    if (!el) return;
    document.querySelectorAll('.nav-here').forEach(e => e.classList.remove('nav-here'));
    try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
    if (kbd) el.classList.add('nav-here');
  }
  function focusFirst() {
    const view = ctx.getView();
    if (view === 'setup' && vis(startBtn)) return focusAt(startBtn);          // primary action ("Play now") first
    if (view === 'library') { const sel = songList.querySelector('.songitem.on'); if (vis(sel)) return focusAt(sel); }
    const c = navCols(); for (const col of c) { if (col.length) { focusAt(col[0]); return; } }   // first NON-EMPTY column (an empty rail must not strand focus before Upload)
  }
  function navMove(dRow, dCol) {
    const cols = navCols(); if (!cols.length) return;
    const cur = document.activeElement;
    let ci = cols.findIndex(c => c.indexOf(cur) >= 0);
    if (ci < 0) { focusFirst(); return; }
    let ri = cols[ci].indexOf(cur);
    if (dCol) {                                   // jump columns, keep the nearest row
      ci = Math.max(0, Math.min(cols.length - 1, ci + dCol));
      ri = Math.min(Math.max(ri, 0), cols[ci].length - 1);
      focusAt(cols[ci][ri]); return;
    }
    // Vertical: WRAP top<->bottom and skip anything that won't take focus, so the d-pad always
    // traverses the whole column. (Single-column screens like Setup put the primary button last,
    // so a plain clamp dead-ended Down/Left/Right the moment you landed there.)
    const col = cols[ci], L = col.length;
    for (let n = 0; n < L; n++) {
      ri = ((ri + dRow) % L + L) % L;
      focusAt(col[ri]);
      if (document.activeElement === col[ri]) return;
    }
  }
  function seekBy(dir) {
    const vm = ctx.getVM(); if (!vm) return;
    const step = Math.max(1, vm.duration * 0.02);
    ctx.control({ cmd: 'seek', t: Math.max(0, Math.min(vm.duration, ctx.getLastT() + dir * step)) }).catch(() => {});
  }
  document.addEventListener('pointerdown', () => { kbd = false; document.querySelectorAll('.nav-here').forEach(e => e.classList.remove('nav-here')); });
  document.addEventListener('keydown', e => {
    const view = ctx.getView();
    const k = e.key, ae = document.activeElement, tag = (ae && ae.tagName) || '';
    if (tag === 'INPUT' && (ae.type === 'number' || ae.type === 'text')) return;   // loop-bar inputs use keys natively
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (tag === 'SELECT') {                             // remote: left/right adjust the focused setting
        const d = k === 'ArrowRight' ? 1 : -1, ni = ae.selectedIndex + d;
        if (ni >= 0 && ni < ae.options.length) { ae.selectedIndex = ni; ae.dispatchEvent(new Event('change')); }
        e.preventDefault(); return;
      }
      if (tag === 'INPUT' && ae.type === 'range') {       // remote: left/right step a volume slider
        const d = k === 'ArrowRight' ? 8 : -8;
        ae.value = Math.max(+ae.min, Math.min(+ae.max, (+ae.value) + d));
        ae.dispatchEvent(new Event('input'));
        e.preventDefault(); return;
      }
      if (ae === seekEl) { seekBy(k === 'ArrowRight' ? 1 : -1); e.preventDefault(); return; }
    }
    switch (k) {
      case 'ArrowUp': kbd = true; navMove(-1, 0); e.preventDefault(); break;
      case 'ArrowDown': kbd = true; navMove(1, 0); e.preventDefault(); break;
      case 'ArrowLeft': kbd = true; navMove(0, -1); e.preventDefault(); break;
      case 'ArrowRight': kbd = true; navMove(0, 1); e.preventDefault(); break;
      case 'Enter':
        // a synthetic .click() on the seek bar would arrive with clientX=0 -> seek to 0 (restart). Skip it.
        if (ae && tag !== 'SELECT' && ae !== seekEl && ae.click) { ae.click(); e.preventDefault(); }
        break;
      case 'Backspace': case 'Escape':
        kbd = true;
        if (!pauseEl.hidden) pResume.click();
        else if (!finish.hidden) finPick.click();                      // Back on the finish screen -> Library
        else if (view === 'stage') { if (ctx.getPlaying()) playBtn.click(); else ctx.openPause(); }   // Esc on the stage = pause/menu
        else if (view !== 'home') ctx.go(ctx.parent[view] || 'home');  // up one level (Home is the root)
        e.preventDefault(); break;
      case ' ': case 'Spacebar':
        if (!pauseEl.hidden) { pResume.click(); e.preventDefault(); }
        else if (view === 'stage' && finish.hidden) { playBtn.click(); e.preventDefault(); }
        break;
    }
  });

  return {
    init(c) { Object.assign(ctx, c); },
    focusFirst, focusAt,                                  // the app refocuses after navigating / on pause/finish
    isKbd() { return kbd; },                              // app reads it to decide whether to move focus
    setKbd(b) { kbd = !!b; },                             // SSE 'key' frames (a remote press) enter keyboard mode
  };
})();
