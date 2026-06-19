/* PiTV rendering — keyboard, falling-notes (game), and notation (grand staff).
   Thin view: it runs a local rAF playback clock (advanced in frame()), corrected by the
   Pi's throttled 'pos' heartbeat via correctNow(), and freezes at gates in Follow mode. It
   renders the view-model the engine computed (note staff positions/accidentals are ported
   from PianoBooster's StavePosition.cpp). It never recomputes timing or musical layout. */
const PiTV = (function () {
  const LOW = 21, HIGH = 108, LOOKAHEAD = 3.5;
  const MIN_GAP = 0.30;   // engraving: minimum column advance in layout-units (shared by setSong layout + render's px-gap floor)
  const isBlack = n => [1, 3, 6, 8, 10].indexOf(((n % 12) + 12) % 12) !== -1;

  const layout = {};
  (function build() {
    const whites = [];
    for (let n = LOW; n <= HIGH; n++) if (!isBlack(n)) whites.push(n);
    const ww = 1 / whites.length;
    let wi = 0;
    for (let n = LOW; n <= HIGH; n++) if (!isBlack(n)) { layout[n] = { x: wi * ww, w: ww }; wi++; }
    wi = 0;
    for (let n = LOW; n <= HIGH; n++) {
      if (!isBlack(n)) wi++;
      else layout[n] = { x: wi * ww - ww * 0.3, w: ww * 0.6 };
    }
  })();

  /* ---- keyboard ---- */
  let keys = {}, kit = {}, bottomEl = null;
  let rangeLo = LOW, rangeHi = HIGH;          // which keys are on the player's real keyboard
  // The bottom strip is a PIANO keyboard for pitched parts, or an abstract DRUM KIT for drum parts
  // (a piano under a drum chart is meaningless). Both are cheap DOM/SVG with CSS class toggles — no
  // per-frame canvas cost. The app calls buildKeyboard() once; we render whichever fits drumMode.
  function buildKeyboard(el) { bottomEl = el; renderBottom(); }
  function renderBottom() {
    if (!bottomEl) return;
    bottomEl.classList.toggle('drumkit', drumMode);
    if (drumMode) buildDrumKit(bottomEl); else buildPianoKeys(bottomEl);
  }
  function buildPianoKeys(el) {
    el.innerHTML = ''; keys = {};
    for (let n = LOW; n <= HIGH; n++) if (!isBlack(n)) keys[n] = mk(el, n, 'wk');
    for (let n = LOW; n <= HIGH; n++) if (isBlack(n)) keys[n] = mk(el, n, 'bk');
    applyRange();
  }
  // Abstract drum kit (drummer's-eye view): 7 pieces grouped from DRUM_MAP, lit green on a hit.
  const KIT = [   // drummer's-eye layout matching a full Alesis kit: 2 crashes, hi-hat (+foot pedal), 4 toms, ride
    { id: 'hat',     label: 'HH',  cx: 235, cy: 116, sh: '<ellipse cx="235" cy="104" rx="44" ry="9"/><ellipse cx="235" cy="124" rx="44" ry="8"/>' },
    { id: 'crash1',  label: 'CR',  cx: 360, cy: 56,  sh: '<ellipse cx="360" cy="56" rx="56" ry="13" transform="rotate(-18 360 56)"/>' },
    { id: 'crash2',  label: 'CR2', cx: 648, cy: 50,  sh: '<ellipse cx="648" cy="50" rx="52" ry="12" transform="rotate(14 648 50)"/>' },
    { id: 'ride',    label: 'RD',  cx: 872, cy: 92,  sh: '<ellipse cx="872" cy="92" rx="62" ry="15" transform="rotate(16 872 92)"/>' },
    { id: 'tom1',    label: 'T1',  cx: 478, cy: 104, sh: '<circle cx="478" cy="104" r="31"/>' },
    { id: 'tom2',    label: 'T2',  cx: 568, cy: 100, sh: '<circle cx="568" cy="100" r="35"/>' },
    { id: 'tom3',    label: 'T3',  cx: 666, cy: 108, sh: '<circle cx="666" cy="108" r="37"/>' },
    { id: 'tom4',    label: 'T4',  cx: 818, cy: 184, sh: '<circle cx="818" cy="184" r="46"/>' },   // floor tom (drummer's right, lower)
    { id: 'snare',   label: 'S',   cx: 360, cy: 192, sh: '<circle cx="360" cy="192" r="43"/>' },
    { id: 'kick',    label: 'K',   cx: 525, cy: 256, pedal: true, sh: '<polygon points="472,240 578,240 596,274 454,274"/>' },         // bass-drum FOOT pedal (footboard, not a drum)
    { id: 'hatpedal',label: 'HHf', cx: 235, cy: 256, pedal: true, sh: '<polygon points="213,242 257,242 267,270 203,270"/>' },         // hi-hat FOOT pedal — directly UNDER the hi-hat cymbal
  ];
  const KIT_MAP = {};   // GM/Alesis drum note -> kit piece id. MUST stay in sync with DRUM_ZONE in engine/scorekeeper.py
  [[35,'kick'],[36,'kick'],
   [37,'snare'],[38,'snare'],[39,'snare'],[40,'snare'],
   [42,'hat'],[46,'hat'],[23,'hat'],                          // hi-hat STICK: closed / open / half-open
   [44,'hatpedal'],[21,'hatpedal'],                           // hi-hat FOOT: pedal / splash
   [48,'tom1'],[50,'tom1'],[45,'tom2'],[47,'tom2'],
   [43,'tom3'],[58,'tom3'],[41,'tom4'],                       // Alesis: 43=Tom3, 41=Tom4 (two separate toms)
   [49,'crash1'],[52,'crash1'],[55,'crash1'],[57,'crash2'],   // Alesis: 49=Crash1, 57=Crash2
   [51,'ride'],[53,'ride'],[54,'ride'],[56,'ride'],[59,'ride'],[69,'ride'],[70,'ride'],[82,'ride']
  ].forEach(p => { KIT_MAP[p[0]] = p[1]; });
  function buildDrumKit(el) {
    kit = {};
    const g = KIT.map(p => '<g class="piece' + (p.pedal ? ' pedal' : '') + '" data-id="' + p.id + '">' + p.sh
      + '<text class="kit-lbl" x="' + p.cx + '" y="' + p.cy + '">' + p.label + '</text></g>').join('');
    el.innerHTML = '<svg class="kit" viewBox="0 0 1000 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + g + '</svg>';
    for (const p of KIT) kit[p.id] = el.querySelector('[data-id="' + p.id + '"]');
  }
  function hitKit(n) {                                  // flash the struck piece green, fade after 240ms
    const p = kit[KIT_MAP[n] || 'snare']; if (!p) return;
    p.classList.add('hit'); clearTimeout(p._t); p._t = setTimeout(() => p.classList.remove('hit'), 240);
  }
  function mk(el, n, cls) {
    const d = document.createElement('div');
    d.className = cls;
    if (n === 60) d.classList.add('midc');     // mark middle C
    d.style.left = (layout[n].x * 100) + '%';
    d.style.width = (layout[n].w * 100) + '%';
    el.appendChild(d);
    return d;
  }
  // Dim keys outside the player's keyboard range so the lit region matches their hardware.
  function applyRange() {
    for (let n = LOW; n <= HIGH; n++) { const el = keys[n]; if (el) el.classList.toggle('oor', n < rangeLo || n > rangeHi); }
  }
  function setRange(lo, hi) { rangeLo = lo; rangeHi = hi; applyRange(); }
  function highlight(n, on) { if (drumMode) return; const el = keys[n]; if (el) el.classList.toggle('on', on); }   // drums light via setPlayed -> hitKit
  function flashWrong(n) {
    if (drumMode) { const p = kit[KIT_MAP[n] || 'snare']; if (p) { p.classList.add('wrong'); setTimeout(() => p.classList.remove('wrong'), 350); } return; }
    const el = keys[n]; if (!el) return; el.classList.add('wrong'); setTimeout(() => el.classList.remove('wrong'), 350);
  }

  /* ---- shared playback state (set from the streamed position) ---- */
  let canvas, ctx, song = null, view = 'notation', drumMode = false;
  // Render-OWNED engraving layout for the current song, rebuilt in setSong — kept OFF the VM so the
  // engine's payload stays a read-only one-way model (the same VM object is PiSession state that
  // app/PiSound read; render must not decorate it). Index-parallel to song.notes: lx (column x in
  // beat-units, monotonic ↑), top (chord-top, for the name chip), nmW/nmFh (lazy name-width cache);
  // plus song-level anchT/anchLx (time↔lx) + maxDur (windowing margin) + allDrum/hasDrums.
  let vmLay = { lx: [], top: [], nmW: [], nmFh: [], anchT: [], anchLx: [], maxDur: 0, allDrum: false, hasDrums: false };
  let now = -LOOKAHEAD, waiting = false, wanted = [], dirty = true, playSet = null;
  let loopA = null, loopB = null;            // loop region (seconds), or null
  let playHand = null;                       // 'R'/'L' to emphasise one hand of a 1-channel part
  let playTrk = null;                        // which DRUM track to show (multi-drummer files); null = all
  let showNames = true;                      // draw the note-name chips in notation
  const wantedSet = {};
  const playedSet = new Set();               // MIDI notes the player is pressing right now (shown on the staff)
  // R.2: the notation staff + header (clefs/time-sig/key-sig) never change while scrolling,
  // so render them once to an offscreen canvas and blit it each frame.
  let staticCv = null, staticDirty = true;
  let bgCanvas = null, bgCtx = null;     // the STATIC background layer (staff/clefs) — drawn once, never per frame

  function attachCanvas(c) {
    canvas = c; ctx = c.getContext('2d');
    bgCanvas = document.getElementById('fallbg');
    if (bgCanvas) bgCtx = bgCanvas.getContext('2d');
    resize(); addEventListener('resize', resize);
    requestAnimationFrame(frame);
    window.PiRenderDbg = () => ({ drawMs: Math.round(drawMs * 100) / 100, backing: canvas.width + 'x' + canvas.height, resScale, now });   // draw-cost probe
  }
  // Backing store = CSS px (capped near 1080p) times resScale. The CANVAS (scrolling notation) renders
  // into this backing store and CSS upscales it to its layout box, so resScale changes SHARPNESS only,
  // never the on-screen size/zoom (all geometry derives from canvas.width/height — see draw()). The DOM
  // (text, buttons, keyboard/kit) is unaffected and stays crisp at native. Lowering resScale cuts the
  // per-frame GPU fill-rate so the Pi can hold a high refresh (100 Hz at 1080p) where full-res can't.
  // Live-tunable: PiResScale(f) from the console, persisted in localStorage so it survives reload.
  let baseScale = 1, resScale = (function () { const v = parseFloat(localStorage.getItem('pimaestro.resScale')); return (v > 0 && v <= 1) ? v : 0.67; })();
  window.PiResScale = function (f) { if (f > 0 && f <= 1) { resScale = f; try { localStorage.setItem('pimaestro.resScale', f); } catch (e) {} applyRes(); } return resScale; };
  // notation size: a user preference (Settings) that scales the staff/notes. Multiplies the size cap,
  // so it shrinks/grows everything proportionally and is independent of render resolution (resScale).
  let noteScale = (function () { const v = parseFloat(localStorage.getItem('pimaestro.noteSize')); return (v >= 0.6 && v <= 1.5) ? v : 0.9; })();
  function resize() {
    if (!canvas) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    baseScale = Math.min(1, 1920 / Math.max(cw, 1), 1080 / Math.max(ch, 1));
    applyRes();
  }
  function applyRes() {
    const w = Math.max(1, Math.round(canvas.clientWidth * baseScale * resScale));
    const h = Math.max(1, Math.round(canvas.clientHeight * baseScale * resScale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; staticDirty = true; }
    if (bgCanvas && (bgCanvas.width !== w || bgCanvas.height !== h)) { bgCanvas.width = w; bgCanvas.height = h; staticDirty = true; }
    dirty = true;
  }
  function setSong(vm) {
    song = vm; now = -LOOKAHEAD; setWanted([]); dirty = true; staticDirty = true;
    const N = (vm.notes && vm.notes.length) || 0;
    // Drum chart? render the percussion staff when the notes on screen are all GM channel-10 drums —
    // either a drum-only file, or the drum PART of a full song once it's the selected part (see setPlay).
    vmLay = { lx: new Array(N), top: new Array(N).fill(false), nmW: new Array(N), nmFh: new Array(N),
              anchT: [], anchLx: [], maxDur: 0,
              allDrum: !!(N && vm.notes.every(n => n.ch === 9)),
              hasDrums: !!(N && vm.notes.some(n => n.ch === 9)) };
    recomputeDrumMode();
    gateTimes = (vm && vm.gates) || []; gatePtr = firstGateAtOrAfter(now); lastFrozen = -1;   // R.4: gates ship in the VM
    ratedGates = {};   // verdicts belong to the previous song
    // precompute static per-note layout ONCE (was recomputed every frame): musical-beat
    // position, and the top note of each chord (for the note-name label).
    const beats = vm.beats || [];
    const tops = {};
    let maxDur = 0;
    // ENGRAVING LAYOUT: group near-simultaneous notes into columns ("slots"), and lay them out
    // with a MINIMUM gap so dense bars GROW to fit their notes (sparse passages stay beat-spaced).
    // lx is the column's horizontal position in beat-units; anchT/anchLx map real time -> lx so
    // the playhead stays time-correct. game view is unaffected (it uses time directly).
    const SLOT_EPS = 0.030;   // MIN_GAP is module-level (shared with render's px-gap floor)
    const anchT = [], anchLx = [];
    let slotT = -1e9, slotLx = 0, prevB = 0, first = true;
    for (let i = 0; i < N; i++) {                   // notes are sorted by start time (song.py)
      const nt = vm.notes[i];
      if (nt.t - slotT > SLOT_EPS) {                // start a new column
        const b = beatPos(nt.t, beats);
        if (first) { slotLx = b; first = false; } else { slotLx += Math.max(MIN_GAP, b - prevB); }
        prevB = b; slotT = nt.t;
        anchT.push(slotT); anchLx.push(slotLx);
      }
      vmLay.lx[i] = slotLx;
      if (nt.d > maxDur) maxDur = nt.d;
      const k = nt.staff + '_' + Math.round(nt.t / 0.05);
      if (!(k in tops) || nt.idx > vm.notes[tops[k]].idx) tops[k] = i;
    }
    for (const k in tops) vmLay.top[tops[k]] = true;
    vmLay.maxDur = maxDur;                 // longest note (sec) — windowing margin (R.1)
    vmLay.anchT = anchT; vmLay.anchLx = anchLx;
  }
  // R.1: notes are sorted by start time (song.py), and _b is monotonic in t, so we can
  // binary-search the first visible note instead of scanning all N every frame.
  // lower-bound: smallest index i where key(notes[i]) >= target.
  function lbound(notes, key, target) {
    let lo = 0, hi = notes.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (key(notes[m]) < target) lo = m + 1; else hi = m; }
    return lo;
  }
  const keyT = nt => nt.t, ident = v => v;
  // piecewise-linear interpolation over sorted xs->ys, extrapolating at the end slopes.
  // Used both ways: time->layout-x (anchT,anchLx) and layout-x->time (anchLx,anchT).
  function interp(xs, ys, x) {
    const n = xs.length;
    if (n === 0) return x;
    if (n === 1) return ys[0] + (x - xs[0]);
    if (x <= xs[0]) { const r = (ys[1] - ys[0]) / ((xs[1] - xs[0]) || 1); return ys[0] + (x - xs[0]) * r; }
    if (x >= xs[n - 1]) { const r = (ys[n - 1] - ys[n - 2]) / ((xs[n - 1] - xs[n - 2]) || 1); return ys[n - 1] + (x - xs[n - 1]) * r; }
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m] <= x) lo = m; else hi = m - 1; }
    const f = (x - xs[lo]) / ((xs[lo + 1] - xs[lo]) || 1);
    return ys[lo] + f * (ys[lo + 1] - ys[lo]);
  }
  function nbound(arr, target) {            // lower-bound index in a plain sorted number array
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < target) lo = m + 1; else hi = m; }
    return lo;
  }
  function setView(v) { view = v; dirty = true; staticDirty = true; }
  // channels the player covers (Set) -> the rest is hidden; null = show all (Listen).
  // hand ('R'/'L') optionally narrows to one hand of a single-channel part (the other dims).
  function setPlay(channels, hand, track) { playSet = channels ? new Set(channels) : null; playHand = (hand === 'R' || hand === 'L') ? hand : null; playTrk = (track == null ? null : track); recomputeDrumMode(); dirty = true; }
  // Drum staff when the visible notes are all percussion: a drum-only song, or the drum part (ch9)
  // selected as the part to view/play in a full-band song.
  function recomputeDrumMode() {
    const before = drumMode;
    const selDrum = !!(playSet && playSet.size && song && vmLay.hasDrums && [...playSet].every(c => c === 9));
    drumMode = !!(song && (vmLay.allDrum || selDrum));
    if (drumMode !== before) { staticDirty = true; dirty = true; renderBottom(); }   // swap the bottom strip: keyboard <-> drum kit
  }
  // Live keys the player presses -> drawn on the staff at the play line (PianoBooster behaviour).
  function setPlayed(n, on) { if (drumMode && on) hitKit(n); if (on) playedSet.add(n); else playedSet.delete(n); dirty = true; }

  /* ---- R.4 local playback clock (always on; pos frames only correct it) ---- */
  let clockOn = false, clockPlaying = false, clockSpeed = 1, lastTs = null;
  let gateTimes = [], gatePtr = 0, freezeMode = false, lastFrozen = -1;
  let ratedGates = {};   // gate-time -> 'early'|'good'|'late'|'miss' verdict, to colour played notes
  function enableClock() { clockOn = true; }
  function setRated(gate, kind) { if (gate != null && kind) { ratedGates[gate] = kind; dirty = true; } }
  function setClock(playing, speed) { clockPlaying = !!playing; if (speed != null) clockSpeed = +speed || 1; if (!clockPlaying) lastTs = null; dirty = true; }
  function firstGateAtOrAfter(t) { let lo = 0, hi = gateTimes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (gateTimes[m] < t - 1e-6) lo = m + 1; else hi = m; } return lo; }
  function setGates(times) { gateTimes = times || []; gatePtr = firstGateAtOrAfter(now); lastFrozen = -1; dirty = true; }
  // The Pi cleared gate `gi` — resume past it. Guard against a STALE index from a previous gate set
  // (a part/hand change rebuilds gates): ignore a gi that points before `now`, so we never clamp backward.
  function clearGateUpto(gi) {
    if (gi == null || gi >= gateTimes.length) return;
    if (gi + 1 > gatePtr && gateTimes[gi] >= now - 0.3) { gatePtr = gi + 1; dirty = true; }
  }
  function setFreezeMode(on) { freezeMode = !!on; dirty = true; }
  // For the browser-sound scheduler: current clock + the next-gate ceiling (don't schedule backing past it).
  function clockState() { return { t: now, playing: clockPlaying, speed: clockSpeed, limit: (freezeMode && gatePtr < gateTimes.length) ? gateTimes[gatePtr] : Infinity }; }
  // Gentle drift correction from the throttled position heartbeat; snap on a big jump (seek/loop).
  function correctNow(t) {
    if (!clockOn || t == null) return;
    if (!clockPlaying || Math.abs(t - now) > 0.5) {    // paused, reset, seek or loop jump: snap + realign the gate
      if (t < now - 0.5) ratedGates = {};              // jumped backward (seek/loop/reset) -> re-rate from here
      now = t; gatePtr = firstGateAtOrAfter(t); lastFrozen = -1; dirty = true; return;
    }
    // The Pi's position is authoritative: any gate it has already passed (t beyond it) is cleared.
    // This stops the freeze-clamp from fighting the correction — the cause of overshoot-then-jitter
    // around a note when you hold the key early.
    while (freezeMode && gatePtr < gateTimes.length && t > gateTimes[gatePtr] + 0.02) gatePtr++;
    // The local rAF clock is accurate; the heartbeat arrives with network jitter, so don't chase small
    // diffs (free-run within a dead-zone) — only gently correct genuine drift. Seeks/pauses snap above.
    const d = t - now;
    if (Math.abs(d) > 0.12) now += d * 0.10;
    dirty = true;
  }
  // While frozen at a gate, light the keys you owe — computed locally so the amber is instant.
  function refreshWantedLocal() {
    const frozen = clockPlaying && freezeMode && gatePtr < gateTimes.length && Math.abs(now - gateTimes[gatePtr]) < 1e-3;
    const fg = frozen ? gatePtr : -1;
    if (fg === lastFrozen) return;                 // only recompute on a freeze-state change
    lastFrozen = fg;
    if (!frozen) { waiting = false; setWanted([]); return; }
    const gt = gateTimes[gatePtr], w = [];
    if (song) for (const nt of song.notes) {
      if (Math.abs(nt.t - gt) > 0.05) continue;
      if (playSet && !playSet.has(nt.ch)) continue;
      if (playHand && nt.hand !== playHand) continue;
      if (playTrk != null && nt.ch === 9 && nt.trk !== playTrk) continue;   // a different drummer's track
      if (!drumMode && (nt.n < rangeLo || nt.n > rangeHi)) continue;   // drums aren't bound to the keyboard range
      w.push(nt.n);
    }
    waiting = true; setWanted(w);
  }
  function setLoop(a, b) { loopA = (a == null ? null : a); loopB = (b == null ? null : b); dirty = true; }
  function setNames(on) { showNames = !!on; dirty = true; }
  function setNoteScale(f) { f = +f; if (f >= 0.6 && f <= 1.5) { noteScale = f; try { localStorage.setItem('pimaestro.noteSize', f); } catch (e) {} staticDirty = true; dirty = true; } }   // notation size preference
  function setWanted(list) {                            // amber "you owe this" cue — on the piano keys OR the drum kit
    const wait = (n, on) => { if (keys[n]) keys[n].classList.toggle('wait', on); const kp = kit[KIT_MAP[n]]; if (kp) kp.classList.toggle('wait', on); };
    for (const n in wantedSet) { wait(n, false); delete wantedSet[n]; }
    wanted = list;
    for (let i = 0; i < list.length; i++) { wantedSet[list[i]] = 1; wait(list[i], true); }
  }

  /* =================== GAME (falling notes) =================== */
  function darken(hex, f) {                          // hex -> darker rgb() (for the note caps)
    if (hex[0] !== '#') return hex;
    const n = parseInt(hex.slice(1), 16);
    return 'rgb(' + ((n >> 16 & 255) * f | 0) + ',' + ((n >> 8 & 255) * f | 0) + ',' + ((n & 255) * f | 0) + ')';
  }
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawGame(W, H) {
    const lineY = H - 4;
    // faint octave lane lines
    ctx.fillStyle = '#161b22';
    for (let n = LOW; n <= HIGH; n++) if (n % 12 === 0) ctx.fillRect(layout[n].x * W, 0, 1, H);
    // hit line (drawn first; note caps sit on top of it)
    ctx.fillStyle = waiting ? '#f5b21f' : '#7d8794';
    ctx.fillRect(0, lineY, W, 3);
    if (!song) return;
    const pps = H / LOOKAHEAD;
    // bar lines: a horizontal divider sweeping down with the music at each bar's downbeat,
    // with the bar number — same reference the notation view shows.
    const bars = song.bars || [];
    ctx.font = '600 12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let bi = Math.max(0, nbound(bars, now)); bi < bars.length; bi++) {   // window: skip bars below/above
      const by = H - (bars[bi] - now) * pps;
      if (by < -1) break;                                                     // higher bars are further up — done
      ctx.fillStyle = C_BARMK; ctx.fillRect(0, by, W, 1);
      ctx.fillStyle = C_NAME; ctx.fillText(String(bi + 1), 3, by + 2);
    }
    // window: first note that can still be on screen (its sustain may trail past the line,
    // so go back by the longest note) .. last note that has appeared at the top.
    const notes = song.notes;
    const tHi = now + LOOKAHEAD + 0.05;
    let i = lbound(notes, keyT, now - (vmLay.maxDur || 0) - 0.05);
    for (; i < notes.length; i++) {
      const nt = notes[i];
      if (nt.t > tHi) break;
      const yb = H - (nt.t - now) * pps;                 // leading edge (bottom) = HIT point
      const h = Math.max(nt.d * pps, 10);
      const yt = yb - h;                                 // trailing edge (top) = RELEASE point
      if (yb < -4 || yt > lineY) continue;
      if (playSet && !playSet.has(nt.ch)) continue;   // hide parts you don't play (background)
      const L = layout[nt.n]; if (!L) continue;
      const x = L.x * W + 1, w = Math.max(L.w * W - 2, 3);
      const atLine = Math.abs(nt.t - now) < 0.06;
      const mine = (nt.n >= rangeLo && nt.n <= rangeHi) && (!playHand || nt.hand === playHand);
      const verdict = mine ? rateCol(ratedGates[nt.t]) : null;   // green/yellow/red once rated
      const base = verdict ? verdict
        : (atLine && wantedSet[nt.n]) ? '#f5b21f' : !mine ? '#6f7b8a' : nt.hand === 'L' ? '#56a3ff' : '#58d977';
      const headY = Math.min(yb, lineY);                 // leading edge, clamped to the line
      const active = yb > lineY + 0.5 && yt < lineY;      // straddling the line -> HOLD now
      // remaining-to-hold body (above the line) — shrinks as you hold
      if (headY - yt > 0.5) { ctx.fillStyle = base; rr(x, yt, w, headY - yt, 4); ctx.fill(); }
      // already-passed part (below the line) — faded, shows it's being released
      if (yb > lineY) { ctx.globalAlpha = 0.22; ctx.fillStyle = base; rr(x, lineY, w, yb - lineY, 4); ctx.fill(); ctx.globalAlpha = 1; }
      // leading-edge cap = the strike marker (a darker shade of the bar; rides down, then
      // sits on the line while held)
      ctx.fillStyle = darken(base, active ? 0.62 : 0.45);
      rr(x, headY - 5, w, 6, 3); ctx.fill();
    }
  }

  /* =================== NOTATION (grand staff) ===================
     Symbol geometry ported VERBATIM from PianoBooster Draw.cpp (GL vertices, units
     where 7 == one stave step, +y up). We render them scaled by s = staffStep/7 with
     y flipped for canvas. Key-signature positions are PianoBooster's exact tables. */
  const NOTEHEAD = [[-7, 2], [-5, 4], [-1, 6], [4, 6], [7, 4], [7, 1], [6, -2], [4, -4], [0, -6], [-4, -6], [-8, -3], [-8, 0]];
  // R.3: the solid notehead is drawn ~30x/frame — build its Path2D once (in PB units) and
  // stamp it with a translate+scale transform instead of re-tessellating every frame.
  const NOTEHEAD_PATH = (function () {
    const p = new Path2D();
    for (let i = 0; i < NOTEHEAD.length; i++) { const v = NOTEHEAD[i]; if (i === 0) p.moveTo(v[0], v[1]); else p.lineTo(v[0], v[1]); }
    p.closePath(); return p;
  })();
  function fillGlyph(path, ox, oy, s) {   // PB units -> px, y flipped (matches strip())
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, -s); ctx.fill(path); ctx.restore();
  }
  const SHARP = [[-2, -14, -2, 14], [2, -13, 2, 15], [-5, 4, 5, 7], [-5, -6, 5, -3]];
  const FLAT = [[-4, 17], [-4, -6], [2, -2], [5, 2], [5, 4], [3, 5], [0, 5], [-4, 2]];
  const NATURAL = [[3, -15, 3, 8], [-3, -8, -3, 15], [3, 8, -3, 2], [3, -2, -3, -8]];
  const TREBLE_CLEF = [[-0.011922, -16.11494], [-3.761922, -12.48994], [-4.859633, -8.85196], [-4.783288, -5.42815], [-0.606711, -1.11108], [5.355545, 0.48711], [10.641104, -1.6473], [14.293812, -6.18241], [14.675578, -11.42744], [12.550578, -17.30244], [7.912166, -20.944], [3.049705, -21.65755], [-1.711005, -21.36664], [-6.283661, -19.66739], [-10.123329, -16.79162], [-13.363008, -12.28184], [-14.675578, -5.79969], [-13.66821, 0.20179], [-10.385341, 6.27562], [5.539491, 20.32671], [10.431588, 28.20584], [11.00141, 34.71585], [9.204915, 39.62875], [7.854166, 42.08262], [5.481415, 42.66649], [3.57972, 41.4147], [1.507889, 37.35642], [-0.381338, 31.14317], [-0.664306, 25.51354], [8.296044, -32.22694], [8.050507, -36.6687], [6.496615, -39.52999], [3.368583, -41.7968], [0.253766, -42.66649], [-3.599633, -42.23514], [-8.098754, -39.46637], [-9.463279, -35.49796], [-7.08037, -31.36512], [-3.336421, -31.14057], [-1.360313, -34.07738], [-1.608342, -37.11828], [-5.729949, -39.24759], [-7.480646, -36.2136], [-6.826918, -33.36919], [-4.069083, -32.9226], [-3.040669, -34.433], [-3.737535, -36.38759], [-5.496558, -36.97633], [-5.295932, -34.01951]];
  const BASS_CLEF = [[-15.370325, -17.42068], [-7.171025, -13.75432], [-2.867225, -10.66642], [0.925165, -7.03249], [4.254425, -0.65527], [4.762735, 7.77848], [2.693395, 13.92227], [-1.207935, 16.80317], [-5.526425, 17.42068], [-10.228205, 15.65609], [-13.453995, 10.7128], [-13.133655, 5.43731], [-9.475575, 3.00714], [-5.846445, 4.72159], [-5.395545, 9.72918], [-8.850025, 11.64372], [-11.519385, 10.35816], [-11.706365, 6.8704], [-9.463505, 5.01391], [-7.172075, 5.81649], [-7.189565, 8.62975], [-9.175055, 9.82019], [-10.696425, 8.08395], [-8.843065, 6.66726], [-8.995775, 8.71136]];
  const BASS_DOTS = [[10, 14], [14, 14], [14, 10], [10, 10]];   // + the same shifted down 10
  // PianoBooster Draw.cpp drawKeySignature lookups (stave index per hand):
  const SHARP_R = [4, 1, 5, 2, -1, 3, 0], SHARP_L = [2, -1, 3, 0, -3, 1, -2];
  const FLAT_R = [0, 3, -1, 2, -2, 1, -3], FLAT_L = [-2, 1, -3, 0, -4, -1, -5];
  const VISIBLE_AHEAD = 4.0, VISIBLE_BEHIND = 1.2;

  // draw a vertex list (PB units) at origin (ox,oy), scale s, y flipped
  function strip(verts, ox, oy, s, close, fill) {
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      const X = ox + verts[i][0] * s, Y = oy - verts[i][1] * s;
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    if (close) ctx.closePath();
    if (fill) ctx.fill(); else ctx.stroke();
  }
  function segs(list, ox, oy, s) {
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      ctx.moveTo(ox + a[0] * s, oy - a[1] * s); ctx.lineTo(ox + a[2] * s, oy - a[3] * s);
    }
    ctx.stroke();
  }
  function accidental(acc, ox, oy, s, col) {
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, 2 * s);
    if (acc === 1) segs(SHARP, ox, oy, s);
    else if (acc === -1) strip(FLAT, ox, oy, s, false, false);
    else segs(NATURAL, ox, oy, s);
  }

  // Easy-on-the-eyes palette (PianoBooster is green-on-black; softened to light-on-dark).
  // Calm palette: neutrals for structure, near-white notes, ONE blue accent, amber only
  // for the note you must play.
  const C_STAVE = '#515b68', C_NOTE = '#e8edf2', C_WANT = '#f5b21f', C_DIM = '#6f7b8a',
        C_BEAT = '#1f2630', C_BARMK = '#323c48', C_BAR = '#79838f',
        C_NAME = '#9aa4b0', C_NOW = '#3b82f0', C_ZONE = 'rgba(59,130,240,0.10)',
        C_BARNUM = '#8b97a6', C_LOOP = 'rgba(150,120,230,0.16)', C_LOOPEDGE = 'rgba(168,140,245,0.85)',
        C_PLAYED = '#3fe08a',                // the keys the player is pressing (live)
        C_EARLY = '#f5d000', C_GOOD = '#3fe08a', C_LATE = '#ff6472';   // per-chord verdict colours
  function rateCol(kind) { return kind === 'good' ? C_GOOD : kind === 'early' ? C_EARLY : (kind === 'late' || kind === 'miss') ? C_LATE : null; }

  // Map an arbitrary MIDI pitch to a grand-staff position (stave-index from the staff centre,
  // + a sharp for black keys), so we can draw live-played keys without the engine's per-note layout.
  // Matches notationGeom's geometry: middle C is idx -6 (treble) / +6 (bass).
  const DEG = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];   // pitch-class -> diatonic degree (C=0..B=6)
  const ACC = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];   // black keys drawn as sharps
  function staffPos(n, split) {
    const pc = ((n % 12) + 12) % 12, oct = Math.floor(n / 12);
    const D = 7 * oct + DEG[pc];                       // absolute diatonic step number
    const staff = n >= (split || 60) ? 'treble' : 'bass';
    return { staff, idx: staff === 'treble' ? D - 41 : D - 29, acc: ACC[pc] };   // B4=41, D3=29 are the centres
  }
  // ---- DRUM NOTATION placement (standard percussion staff) ----
  // GM drum note -> {pos, g, v}. pos = stave-index units (lines even, spaces odd; top line +4,
  // middle line 0, bottom line -4). g: 'x' cymbal/hi-hat, 'o' drum head. v: 'up' hands, 'dn' feet.
  // Hal-Leonard-style placements: kick bottom space (stem down), snare 3rd space, toms descending,
  // hats/ride/crash as X on/above the top line, hi-hat pedal X below the staff.
  const DRUM_MAP = {
    35: { pos: -3, g: 'o', v: 'dn' }, 36: { pos: -3, g: 'o', v: 'dn' },     // bass drum (kick) — bottom space, stem down
    48: { pos: 3, g: 'o', v: 'up' }, 50: { pos: 3, g: 'o', v: 'up' },       // tom 1 (highest) — 4th space
    45: { pos: 2, g: 'o', v: 'up' }, 47: { pos: 2, g: 'o', v: 'up' },       // tom 2 — 4th line
    43: { pos: -1, g: 'o', v: 'up' }, 58: { pos: -1, g: 'o', v: 'up' },     // tom 3 — 2nd space (distinct from tom 4 below it)
    41: { pos: -2, g: 'o', v: 'up' }, 39: { pos: -2, g: 'o', v: 'up' },     // tom 4 (lowest) — 2nd line, above the kick
    38: { pos: 1, g: 'o', v: 'up' }, 40: { pos: 1, g: 'o', v: 'up' },       // snare (3rd space)
    37: { pos: 1, g: 'x', v: 'up' },                                        // side stick
    42: { pos: 4, g: 'x', v: 'up' },                                        // closed hi-hat (top line)
    46: { pos: 4, g: 'x', v: 'up', open: true },                           // open hi-hat
    23: { pos: 4, g: 'x', v: 'up' },                                        // half-open hi-hat (stick)
    44: { pos: -5, g: 'x', v: 'dn' }, 21: { pos: -5, g: 'x', v: 'dn' },     // hi-hat FOOT: pedal + splash (below staff)
    51: { pos: 5, g: 'x', v: 'up' }, 59: { pos: 5, g: 'x', v: 'up' }, 53: { pos: 5, g: 'x', v: 'up' },  // ride
    49: { pos: 6, g: 'x', v: 'up' }, 57: { pos: 6, g: 'x', v: 'up' }, 55: { pos: 6, g: 'x', v: 'up' }, 52: { pos: 6, g: 'x', v: 'up' },  // crash 1 / crash 2 / splash / china
    54: { pos: 5, g: 'x', v: 'up' }, 56: { pos: 5, g: 'x', v: 'up' },      // tambourine / cowbell (above staff)
    69: { pos: 6, g: 'x', v: 'up' }, 70: { pos: 6, g: 'x', v: 'up' }, 82: { pos: 6, g: 'x', v: 'up' },  // cabasa / maracas / shaker
  };
  const DRUM_FALLBACK = { pos: 1, g: 'o', v: 'up' };

  // Map a real-time position (sec) to a fractional musical-beat index using the engine's
  // tempo-mapped beat grid. This makes horizontal spacing musical (constant width per note
  // value, tempo-independent) like PianoBooster, while the playhead still tracks real time.
  function beatPos(t, beats) {
    const n = beats.length;
    if (n === 0) return t;
    if (t <= beats[0]) { const sp = n > 1 ? beats[1] - beats[0] : 1; return (t - beats[0]) / sp; }
    if (t >= beats[n - 1]) { const sp = n > 1 ? beats[n - 1] - beats[n - 2] : 1; return (n - 1) + (t - beats[n - 1]) / sp; }
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid - 1; }
    const sp = beats[lo + 1] - beats[lo] || 1;
    return lo + (t - beats[lo]) / sp;
  }

  // Shared notation geometry (used by both the static layer and the scrolling layer).
  function notationGeom(W, H) {
    const bs = baseScale * resScale;                  // backing-px per display-px: scale the clamp by it
    const step = Math.max(6 * bs, Math.min(13 * bs * noteScale, H / 40));   // px per stave-index step (size = resolution-independent, user-scalable)
    const s = step / 7;                               // PB-unit -> px scale (PB: 7 == one step)
    // Staff-centre offset: bass & treble centres must be 12 steps apart so middle C
    // (idx -6 in treble, +6 in bass) lands on the SAME line — a proper grand staff. (was
    // 12 each = 24 apart, which stretched the staves and pushed high notes off the top.)
    const midY = H / 2, off = 6 * step;
    const trebleC = midY - off, bassC = midY + off;
    // header layout (scaled from PB Cfg x-constants): clef -> time sig -> key sig -> scroll
    const x0 = 12;
    const clefX = x0 + 26 * s, tsX = x0 + 58 * s, ksX = x0 + 86 * s, ksGap = 11 * s;
    const key = song ? (song.keysig || 0) : 0;
    const nAcc = Math.min(Math.abs(key), 7);
    const scrollX = ksX + Math.max(64 * s, nAcc * ksGap + 22 * s);
    const endX = W - 14;
    const playX = scrollX + (endX - scrollX) * 0.3;   // play zone at 30% — more lead-in (notes coming) than trailing
    const markTop = trebleC - 8 * step, markBot = bassC + 8 * step;
    const yOf = (staff, idx) => (staff === 'treble' ? trebleC : bassC) - idx * step;
    return { step, s, trebleC, bassC, x0, clefX, tsX, ksX, ksGap, key, nAcc, scrollX, endX, playX, markTop, markBot, yOf };
  }

  // R.2: draw the unchanging layer (staff lines + clefs + time/key sig) into the offscreen
  // canvas once. Reuses the same strip/accidental code by pointing `ctx` at the offscreen.
  function buildStaticLayer(W, H, g) {
    if (!staticCv) staticCv = document.createElement('canvas');
    staticCv.width = W; staticCv.height = H;
    const save = ctx; ctx = staticCv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const { step, s, trebleC, bassC, x0, clefX, tsX, ksX, ksGap, key, nAcc, endX, yOf } = g;
    // staff lines (5 each, full width) + left joining line
    ctx.strokeStyle = C_STAVE; ctx.lineWidth = Math.max(1, s);
    for (const c of [trebleC, bassC])
      for (let i = -4; i <= 4; i += 2) { const y = c - i * step; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(endX, y); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(x0, trebleC - 4 * step); ctx.lineTo(x0, bassC + 4 * step); ctx.stroke();
    // clefs: ported PB shapes. Treble anchored at right idx -1 (+4u), bass at left idx +1.
    ctx.strokeStyle = C_NOTE; ctx.lineWidth = Math.max(1.5, 2.2 * s);
    strip(TREBLE_CLEF, clefX + 14 * s, yOf('treble', -1) - 4 * s, s, false, false);
    strip(BASS_CLEF, clefX + 14 * s, yOf('bass', 1), s, false, false);
    ctx.fillStyle = C_NOTE;
    strip(BASS_DOTS, clefX + 14 * s, yOf('bass', 1), s, true, true);
    strip(BASS_DOTS.map(p => [p[0], p[1] - 10]), clefX + 14 * s, yOf('bass', 1), s, true, true);
    if (song && song.timesig) {
      ctx.fillStyle = C_NOTE; ctx.font = 'bold ' + (step * 2.4).toFixed(0) + 'px Georgia,serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const c of [trebleC, bassC]) { ctx.fillText(String(song.timesig[0]), tsX, c - 2 * step); ctx.fillText(String(song.timesig[1]), tsX, c + 2 * step); }
    }
    if (key !== 0) {
      const R = key > 0 ? SHARP_R : FLAT_R, L = key > 0 ? SHARP_L : FLAT_L;
      for (let i = 0; i < nAcc; i++) { accidental(key > 0 ? 1 : -1, ksX + i * ksGap, yOf('treble', R[i]), s, C_NOTE); accidental(key > 0 ? 1 : -1, ksX + i * ksGap, yOf('bass', L[i]), s, C_NOTE); }
    }
    ctx = save;
    staticDirty = false;
  }

  /* =================== NOTATION VIEWS (shared base + piano / drum variants) ===================
     The grand staff and the drum staff share all the scrolling machinery — engraving-spaced layout,
     the beat/bar grid, loop shading, the now-line, note windowing. The base class owns that; each
     variant supplies only what differs: its geometry, its static header (clefs/sig), how to draw a
     single note, which notes are visible, and where live-played keys sit on the staff. */
  // beam/flag count from a duration symbol: 8th = 1, 16th = 2, 32nd = 3, longer = 0 (dot doesn't add).
  function flagsOf(sym) { const b = (sym && sym.charAt(sym.length - 1) === '.') ? sym.slice(0, -1) : (sym || 'q'); return b === '32' ? 3 : b === '16' ? 2 : b === '8' ? 1 : 0; }

  class NotationView {
    // Per-variant overrides: geom(W,H) buildStatic(W,H,g) drawHead(nt,x,g,i)->stemSpec visible(nt) playedYs(g)
    render(W, H) {
      const g = this.geom(W, H);
      // STATIC layer: rebuild the staff/header only when it changes, and paint it onto the BACKGROUND
      // canvas (composited by the GPU for free). The per-frame foreground draw (below) never touches it
      // — that's what removes the full-canvas blit that was capping the framerate even with no notes.
      if (staticDirty || !staticCv || staticCv.width !== W || staticCv.height !== H) {
        this.buildStatic(W, H, g);
        if (bgCtx) { bgCtx.clearRect(0, 0, W, H); bgCtx.drawImage(staticCv, 0, 0); }
      }
      if (!bgCtx) ctx.drawImage(staticCv, 0, 0);      // fallback (no bg layer): blit onto the main canvas
      if (!song) return;
      const { step, s, scrollX, endX, playX, markTop, markBot, staves, barNumY } = g;
      // ---- scrolling region (engraving-spaced; clipped so it can't bleed into the header) ----
      const beats = song.beats, num = (song.timesig && song.timesig[0]) || 4;
      const aT = vmLay.anchT || [], aLx = vmLay.anchLx || [];   // real time <-> layout-x anchors
      const BEATS_AHEAD = 8;
      // px-gap FLOOR (resolution-independent): the layout's minimum column advance (MIN_GAP units)
      // must render as at least one notehead + half a notehead of clear space, so adjacent notes
      // never crowd. headW = 2*NW (NW = 6*s = notehead half-width / stem offset, see drawStems).
      // Computed from s, which scales with the backing-store size, so it holds at 720p, 1080p, etc.
      // Dense passages zoom in to honour this (fewer beats shown ahead); sparse stay time-spaced.
      const minGapPpb = 1.5 * (12 * s) / MIN_GAP;               // MIN_GAP units -> 1.5 head-widths
      const ppb = Math.max(24, minGapPpb, (endX - playX) / BEATS_AHEAD);   // px per layout unit
      const nowLx = interp(aT, aLx, now);
      const bx = lx => playX + (lx - nowLx) * ppb;
      const behind = (playX - scrollX) / ppb + 1;
      // collect ~2 layout-units (≥ a beat) PAST each edge so a beam group is fully formed before it
      // scrolls on-screen — otherwise the run/beam-height recomputes as members appear and the beam jumps.
      const lxLo = nowLx - behind - 2, lxHi = nowLx + BEATS_AHEAD + 2;

      ctx.save();
      ctx.beginPath(); ctx.rect(scrollX - 1, 0, endX - scrollX + 2, H); ctx.clip();
      ctx.fillStyle = C_ZONE; ctx.fillRect(playX - 9 * s, markTop, 18 * s, markBot - markTop);   // play-zone band

      if (loopA != null && loopB != null) {           // shade the looped bars + mark its edges
        const xa = bx(interp(aT, aLx, loopA)), xz = bx(interp(aT, aLx, loopB));
        ctx.fillStyle = C_LOOP; ctx.fillRect(xa, markTop, xz - xa, markBot - markTop);
        ctx.strokeStyle = C_LOOPEDGE; ctx.lineWidth = Math.max(1.4, 1.6 * s);
        for (const xe of [xa, xz]) { ctx.beginPath(); ctx.moveTo(xe, markTop); ctx.lineTo(xe, markBot); ctx.stroke(); }
      }

      // beat + bar lines: each beat's TIME mapped through the layout, so they track the notes.
      const tLo = interp(aLx, aT, lxLo), tHi = interp(aLx, aT, lxHi);
      const jStart = Math.max(0, nbound(beats, tLo) - 1), jEnd = Math.min(beats.length - 1, nbound(beats, tHi));
      const beatX = [], barmkX = [], barX = [], barNums = [];
      for (let j = jStart; j <= jEnd; j++) {
        const x = bx(interp(aT, aLx, beats[j]));
        if (x >= scrollX && x <= endX) (j % num === 0 ? barmkX : beatX).push(x);
        if (j % num === 0) { const xb = x - 0.3 * ppb; if (xb < scrollX || xb > endX) continue; barX.push(xb); barNums.push([xb, Math.round(j / num) + 1]); }
      }
      ctx.lineWidth = Math.max(1, s);
      if (beatX.length) { ctx.strokeStyle = C_BEAT; ctx.beginPath(); for (const x of beatX) { ctx.moveTo(x, markTop); ctx.lineTo(x, markBot); } ctx.stroke(); }
      if (barmkX.length) { ctx.strokeStyle = C_BARMK; ctx.beginPath(); for (const x of barmkX) { ctx.moveTo(x, markTop); ctx.lineTo(x, markBot); } ctx.stroke(); }
      if (barX.length) {                              // bar line through each stave (1 for drums, 2 for the grand staff)
        ctx.strokeStyle = C_BAR; ctx.lineWidth = Math.max(1.4, 1.7 * s); ctx.beginPath();
        for (const xb of barX) for (const st of staves) { ctx.moveTo(xb, st.top); ctx.lineTo(xb, st.bot); }
        ctx.stroke();
      }
      if (barNums.length) {
        ctx.fillStyle = C_BARNUM; ctx.font = '600 ' + (step * 1.2).toFixed(0) + 'px system-ui';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (const bn of barNums) ctx.fillText(String(bn[1]), bn[0] + 3 * s, barNumY);
      }
      ctx.strokeStyle = waiting ? C_WANT : C_NOW; ctx.lineWidth = 2;   // now line
      ctx.beginPath(); ctx.moveTo(playX, markTop); ctx.lineTo(playX, markBot); ctx.stroke();

      // notes — windowed via binary search (vmLay.lx sorted). TWO passes: heads (per note, by the
      // variant's drawHead), then ONE stems+beams+flags pass over the visible set so consecutive
      // 8th/16th columns in a beat beam together (instead of each note carrying its own flag).
      const notes = song.notes, lx = vmLay.lx, margin = 2 * ppb;
      const vis = [];
      let i = lbound(lx, ident, lxLo);
      for (; i < notes.length; i++) {
        if (lx[i] > lxHi) break;
        const nt = notes[i];
        if (!this.visible(nt)) continue;
        const x = bx(lx[i]); if (x < scrollX - step - margin || x > endX + margin) continue;
        const onScreen = (x >= scrollX - step && x <= endX);
        const spec = this.drawHead(nt, x, g, i, onScreen);   // head drawn only if on-screen; spec returned either way (for beaming)
        if (spec) { spec.t = nt.t; vis.push(spec); }
      }
      if (vis.length) this.drawStems(vis, g);
      // live keys the player is pressing: short marks just LEFT of the play bar (PianoBooster behaviour)
      const ys = this.playedYs(g);
      if (ys && ys.length) {
        const x2 = playX - 5 * s, x1 = playX - 30 * s;
        ctx.strokeStyle = C_PLAYED; ctx.lineWidth = Math.max(2.5, 3 * s); ctx.lineCap = 'round'; ctx.beginPath();
        for (const y of ys) { ctx.moveTo(x1, y); ctx.lineTo(x2, y); }
        ctx.stroke(); ctx.lineCap = 'butt';
      }
      ctx.restore();
    }

    // ---- stems + beams + flags + accents (shared by both staves) ----
    // Group the visible notes by voice (stem up/down), collapse same-x notes into columns (one stem,
    // stacked heads), then beam consecutive 8th/16th columns that fall in the SAME beat. A lone flagged
    // column keeps its flag; quarters/halves get a plain stem. Velocity >= 100 draws an accent (>).
    drawStems(vis, g) {
      const { s } = g, beats = song.beats || [], NW = 6 * s, STEM = 30 * s;
      // Accumulate everything into a few Path2Ds, then stroke each ONCE — on a Pi 4 the cost is the
      // draw-call COUNT, not the pixels, so batching (instead of a stroke per stem/beam) is the win.
      const stems = new Map(), beamP = new Path2D(), beam2 = new Path2D(), accP = new Path2D();
      const sp = col => { let p = stems.get(col); if (!p) { p = new Path2D(); stems.set(col, p); } return p; };
      const seg = (p, x0, y0, x1, y1) => { p.moveTo(x0, y0); p.lineTo(x1, y1); };
      const vseg = (p, x, y0, y1) => { p.moveTo(x, y0); p.lineTo(x, y1); };   // vertical stem — x can't be omitted
      const accent = (x, y) => { const w = 5 * s, h = 3.5 * s; accP.moveTo(x - w, y - h); accP.lineTo(x + w, y); accP.lineTo(x - w, y + h); };
      for (const up of [true, false]) {
        const sub = vis.filter(o => o.up === up);
        if (!sub.length) continue;
        const map = new Map(), cols = [];
        for (const o of sub) {                          // collapse notes sharing an x into one stem-column
          const k = Math.round(o.x), c = map.get(k);
          if (!c) { const nc = { x: o.x, lo: o.y, hi: o.y, topX: o.cross, f: o.flags, w: o.w, col: o.col, beat: nbound(beats, o.t + 1e-4) }; map.set(k, nc); cols.push(nc); }
          else { if (o.y < c.lo) { c.lo = o.y; c.topX = o.cross; } if (o.y > c.hi) c.hi = o.y; c.f = Math.max(c.f, o.flags); c.w = Math.max(c.w, o.w); if (o.col === C_WANT) c.col = C_WANT; }
        }
        cols.sort((a, b) => a.x - b.x);
        // stem attaches at the lower-head side for up-stems; for down-stems at the TOP of the top head
        // (the top of the X for a cymbal/hi-hat — Songsterr style), so the stick meets the cross cleanly.
        const top = c => up ? c.hi : c.lo - (c.topX ? 5 : 3) * s;
        let i = 0;
        while (i < cols.length) {
          let j = i;
          if (cols[i].f > 0) while (j + 1 < cols.length && cols[j + 1].f > 0 && cols[j + 1].beat === cols[i].beat) j++;
          if (cols[i].f > 0 && j > i) {                 // BEAM a run of >= 2 columns
            let beamY = up ? 1e9 : -1e9;                // flat beam at the extreme stem-end
            for (let k = i; k <= j; k++) { const e = up ? cols[k].lo - STEM : cols[k].hi + STEM; beamY = up ? Math.min(beamY, e) : Math.max(beamY, e); }
            for (let k = i; k <= j; k++) { const c = cols[k], sx = c.x + (up ? NW : -NW); vseg(sp(c.col), sx, top(c), beamY); if (c.w >= 100) accent(c.x, up ? beamY - 7 * s : c.lo - 13 * s); }
            seg(beamP, cols[i].x + (up ? NW : -NW), beamY, cols[j].x + (up ? NW : -NW), beamY);
            const off = (up ? 1 : -1) * 5 * s;
            for (let k = i; k < j; k++) if (cols[k].f >= 2 && cols[k + 1].f >= 2) seg(beam2, cols[k].x + (up ? NW : -NW), beamY + off, cols[k + 1].x + (up ? NW : -NW), beamY + off);
          } else {                                      // plain stem (+ flag if a lone 8th/16th)
            const c = cols[i], sx = c.x + (up ? NW : -NW), end = up ? c.lo - STEM : c.hi + STEM;
            vseg(sp(c.col), sx, top(c), end);
            for (let f = 0; f < c.f; f++) { const fy = end + (up ? 1 : -1) * f * 8 * s; seg(sp(c.col), sx, fy, sx + 8 * s, fy + (up ? 14 : -14) * s); }
            if (c.w >= 100) accent(c.x, up ? end - 7 * s : c.lo - 13 * s);
          }
          i = j + 1;
        }
      }
      ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(1.4, 2 * s);
      for (const [col, p] of stems) { ctx.strokeStyle = col; ctx.stroke(p); }
      ctx.strokeStyle = C_NOTE; ctx.lineWidth = Math.max(2.4, 3 * s); ctx.stroke(beamP);
      ctx.lineWidth = Math.max(2, 2.6 * s); ctx.stroke(beam2);
      ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.4, 1.8 * s); ctx.stroke(accP); ctx.lineCap = 'butt';
    }
  }

  // ---- piano variant: the grand staff (treble + bass), pitched + sustained notes ----
  class PianoStaff extends NotationView {
    geom(W, H) {
      const g = notationGeom(W, H);
      g.staves = [{ top: g.yOf('treble', 4), bot: g.yOf('treble', -4) }, { top: g.yOf('bass', 4), bot: g.yOf('bass', -4) }];
      g.barNumY = g.trebleC - 6 * g.step;
      return g;
    }
    buildStatic(W, H, g) { buildStaticLayer(W, H, g); }
    visible(nt) { return !(playSet && !playSet.has(nt.ch)); }   // hide parts you don't play (background)
    playedYs(g) {
      if (!playedSet.size) return null;
      const split = (song && song.split) || 60, ys = [];
      for (const n of playedSet) { const sp = staffPos(+n, split); ys.push(g.yOf(sp.staff, sp.idx)); }
      return ys;
    }
    drawHead(nt, x, g, i, onScreen) {                 // draws the notehead (+ ledgers/acc/dot/name); returns the stem spec
      const { step, s, trebleC, bassC, yOf } = g;
      const y = yOf(nt.staff, nt.idx);
      const mine = (nt.n >= rangeLo && nt.n <= rangeHi) && (!playHand || nt.hand === playHand);
      const verdict = mine ? rateCol(ratedGates[nt.t]) : null;   // green/yellow/red once this chord is rated
      const col = verdict ? verdict
        : (Math.abs(nt.t - now) < 0.06 && wantedSet[nt.n]) ? C_WANT : (mine ? C_NOTE : C_DIM);
      const t = nt.sym, dotted = t.charAt(t.length - 1) === '.', base = dotted ? t.slice(0, -1) : t;
      const spec = base === 'w' ? null : { x, y, up: true, flags: flagsOf(nt.sym), w: nt.v || 0, col, cross: false };   // grand staff: stems up; whole notes have none
      if (!onScreen) return spec;                     // margin note (kept only so its beam group is complete)
      const solid = base !== 'h' && base !== 'w';
      const c = nt.staff === 'treble' ? trebleC : bassC, lw = 12 * s;
      ctx.strokeStyle = C_STAVE; ctx.lineWidth = Math.max(1, s);   // ledger lines (PB threshold |idx| >= 6)
      if (nt.idx >= 6) for (let k = 6; k <= nt.idx; k += 2) { const yy = c - k * step; ctx.beginPath(); ctx.moveTo(x - lw, yy); ctx.lineTo(x + lw, yy); ctx.stroke(); }
      if (nt.idx <= -6) for (let k = -6; k >= nt.idx; k -= 2) { const yy = c - k * step; ctx.beginPath(); ctx.moveTo(x - lw, yy); ctx.lineTo(x + lw, yy); ctx.stroke(); }
      if (nt.acc) accidental(Math.abs(nt.acc) === 2 ? 2 : nt.acc, x - 16 * s, y, s, col);
      if (solid) { ctx.fillStyle = col; fillGlyph(NOTEHEAD_PATH, x, y, s); }
      else { ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.4, 2 * s); strip(NOTEHEAD, x, y, s, true, false); }
      if (dotted) { const dy = (nt.idx % 2 === 0) ? y - step / 2 : y; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 11 * s, dy, Math.max(1.3, 1.8 * s), 0, 6.2832); ctx.fill(); }
      if (showNames && nt.n <= 90 && vmLay.top[i] && step >= 7) {  // note-name chip, up-and-left of the head
        const fh = step * 1.5;
        ctx.font = '600 ' + fh.toFixed(0) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const lx = x - 9 * s, ly = y - 2 * step - 2;
        if (vmLay.nmW[i] == null || vmLay.nmFh[i] !== fh) { vmLay.nmW[i] = ctx.measureText(nt.nm).width; vmLay.nmFh[i] = fh; }
        const tw = vmLay.nmW[i], pad = 3 * s;
        ctx.fillStyle = 'rgba(13,17,23,0.85)'; rr(lx - tw / 2 - pad, ly - fh / 2 - 1, tw + 2 * pad, fh + 2, 3 * s); ctx.fill();
        ctx.fillStyle = C_NAME; ctx.fillText(nt.nm, lx, ly);
      }
      return spec;
    }
  }

  // ---- drum variant: one 5-line percussion staff; placement/glyph/stem from DRUM_MAP ----
  class DrumStaff extends NotationView {
    geom(W, H) {
      const bs = baseScale * resScale;                // backing-px per display-px: scale the clamp by it so the staff size is constant across resScale
      const step = Math.max(8 * bs, Math.min(22 * bs * noteScale, H / 22)), s = step / 7, center = H / 2, x0 = 12;
      const clefX = x0 + 22 * s, tsX = x0 + 50 * s, scrollX = tsX + 30 * s, endX = W - 14;
      const playX = scrollX + (endX - scrollX) * 0.3, yOf = pos => center - pos * step;
      return { step, s, center, x0, clefX, tsX, scrollX, endX, playX, yOf,
               markTop: yOf(8), markBot: yOf(-8),
               staves: [{ top: yOf(4), bot: yOf(-4) }], barNumY: yOf(4) - 1.6 * step };
    }
    buildStatic(W, H, g) {
      if (!staticCv) staticCv = document.createElement('canvas');
      staticCv.width = W; staticCv.height = H;
      const save = ctx; ctx = staticCv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      const { step, s, x0, clefX, tsX, endX, yOf } = g, top = yOf(4), bot = yOf(-4);
      ctx.strokeStyle = C_STAVE; ctx.lineWidth = Math.max(1, s);
      for (let i = -4; i <= 4; i += 2) { const y = yOf(i); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(endX, y); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0, bot); ctx.stroke();
      ctx.fillStyle = C_NOTE;                         // percussion clef: two thick vertical bars
      const bw = 2.6 * s, gp = 3.4 * s, y3 = yOf(3), hgt = yOf(-3) - yOf(3);
      ctx.fillRect(clefX - gp / 2 - bw, y3, bw, hgt);
      ctx.fillRect(clefX + gp / 2, y3, bw, hgt);
      if (song && song.timesig) {
        ctx.fillStyle = C_NOTE; ctx.font = 'bold ' + (step * 2.2).toFixed(0) + 'px Georgia,serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(song.timesig[0]), tsX, yOf(2));
        ctx.fillText(String(song.timesig[1]), tsX, yOf(-2));
      }
      ctx = save; staticDirty = false;
    }
    visible(nt) { return nt.ch === 9 && (playTrk == null || nt.trk === playTrk); }   // one drummer's track when picked
    playedYs(g) {
      if (!playedSet.size) return null;
      const ys = [];
      for (const n of playedSet) { const dm = DRUM_MAP[+n]; if (dm) ys.push(g.yOf(dm.pos)); }
      return ys;
    }
    glyph(dm, x, y, s, col) {
      if (dm.g === 'x') {                             // cymbal / hi-hat: an X
        const r = 5 * s;
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.6, 2.2 * s); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r); ctx.stroke(); ctx.lineCap = 'butt';
        if (dm.open) { ctx.beginPath(); ctx.arc(x, y - 9 * s, 3.2 * s, 0, 6.2832); ctx.stroke(); }   // open hi-hat ring
      } else { ctx.fillStyle = col; fillGlyph(NOTEHEAD_PATH, x, y, s); }   // drum: solid oval head
    }
    drawHead(nt, x, g, i, onScreen) {                  // draws the X/oval head; returns the stem spec (base beams them)
      const { s, yOf } = g;
      const dm = DRUM_MAP[nt.n] || DRUM_FALLBACK, y = yOf(dm.pos);
      const col = (Math.abs(nt.t - now) < 0.06) ? C_WANT : C_NOTE;
      if (onScreen) this.glyph(dm, x, y, s, col);
      return { x, y, up: false, flags: flagsOf(nt.sym), w: nt.v || 0, col, cross: dm.g === 'x' };   // drums: all stems DOWN (Songsterr style)
    }
  }

  const pianoView = new PianoStaff(), drumView = new DrumStaff();

  /* ---- frame ---- */
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);                        // foreground: wiped + redrawn every frame (moving content only)
    if (view === 'notation') (drumMode ? drumView : pianoView).render(W, H);
    else { if (bgCtx) bgCtx.clearRect(0, 0, W, H); drawGame(W, H); }   // game view has no static staff -> clear the bg layer
  }
  // Hold 60fps the way game engines do: draw EVERY frame (never skip — motion stays smooth), but
  // adapt the render RESOLUTION to the budget. We track a smoothed draw cost; if it creeps toward the
  // ~16.6ms 60fps budget we shrink resScale (fewer pixels next frame), and when there's slack we grow
  // it back toward full. A 9–15ms dead-zone keeps it from oscillating. The clock advances every rAF,
  // so timing is exact regardless of resolution.
  let drawMs = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (clockOn && clockPlaying) {                 // R.4: advance the local clock, freezing at gates
      if (lastTs != null) {
        let n = now + ((ts - lastTs) / 1000) * clockSpeed;
        if (freezeMode && gatePtr < gateTimes.length && n >= gateTimes[gatePtr]) n = gateTimes[gatePtr];
        if (n !== now) { now = n; dirty = true; }   // frozen at a gate? nothing moved — skip the repaint
      }
      lastTs = ts;
    } else lastTs = null;
    if (clockOn) refreshWantedLocal();
    if (ctx && dirty) { const t0 = performance.now(); draw(); dirty = false; drawMs += ((performance.now() - t0) - drawMs) * 0.1; }   // render at native res; track draw cost
  }

  return { buildKeyboard, highlight, flashWrong, attachCanvas, setSong, setPlayed, setView, setPlay, setRange, setLoop, setNames,
           enableClock, setClock, setGates, clearGateUpto, setRated, setFreezeMode, correctNow, clockState, setNoteScale };
})();
