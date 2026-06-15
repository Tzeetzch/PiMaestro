/* PiTV rendering — keyboard, falling-notes (game), and notation (grand staff).
   Thin view: it draws the position the Pi engine streams (setPos) and the view-model
   the engine computed (note staff positions/accidentals are ported from PianoBooster's
   StavePosition.cpp). It never recomputes timing or musical layout. */
const PiTV = (function () {
  const LOW = 21, HIGH = 108, LOOKAHEAD = 3.5;
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
  let keys = {};
  let rangeLo = LOW, rangeHi = HIGH;          // which keys are on the player's real keyboard
  function buildKeyboard(el) {
    el.innerHTML = '';
    keys = {};
    for (let n = LOW; n <= HIGH; n++) if (!isBlack(n)) keys[n] = mk(el, n, 'wk');
    for (let n = LOW; n <= HIGH; n++) if (isBlack(n)) keys[n] = mk(el, n, 'bk');
    applyRange();
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
  function highlight(n, on) { const el = keys[n]; if (el) el.classList.toggle('on', on); }

  /* ---- shared playback state (set from the streamed position) ---- */
  let canvas, ctx, song = null, view = 'notation';
  let now = -LOOKAHEAD, waiting = false, wanted = [], dirty = true, playSet = null;
  let loopA = null, loopB = null;            // loop region (seconds), or null
  let playHand = null;                       // 'R'/'L' to emphasise one hand of a 1-channel part
  let showNames = true;                      // draw the note-name chips in notation
  const wantedSet = {};
  const playedSet = new Set();               // MIDI notes the player is pressing right now (shown on the staff)
  // R.2: the notation staff + header (clefs/time-sig/key-sig) never change while scrolling,
  // so render them once to an offscreen canvas and blit it each frame.
  let staticCv = null, staticDirty = true;

  function attachCanvas(c) {
    canvas = c; ctx = c.getContext('2d');
    resize(); addEventListener('resize', resize);
    requestAnimationFrame(frame);
  }
  function resize() {
    if (!canvas) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    // R.5: cap the backing-store resolution on very large displays (e.g. 4K TVs) to save
    // fill-rate — CSS stretches the smaller bitmap. Displays at/under 1080p are untouched.
    const scale = Math.min(1, 1920 / Math.max(cw, 1), 1080 / Math.max(ch, 1));
    canvas.width = Math.round(cw * scale);
    canvas.height = Math.round(ch * scale);
    dirty = true; staticDirty = true;
  }
  function setSong(vm) {
    song = vm; now = -LOOKAHEAD; setWanted([]); dirty = true; staticDirty = true;
    gateTimes = []; gatePtr = 0; lastFrozen = -1;   // R.4: gates re-arrive via the 'gates' event
    // precompute static per-note layout ONCE (was recomputed every frame): musical-beat
    // position, and the top note of each chord (for the note-name label).
    const beats = vm.beats || [];
    const tops = {};
    let maxDur = 0;
    // ENGRAVING LAYOUT: group near-simultaneous notes into columns ("slots"), and lay them out
    // with a MINIMUM gap so dense bars GROW to fit their notes (sparse passages stay beat-spaced).
    // _lx is the column's horizontal position in beat-units; anchT/anchLx map real time -> _lx so
    // the playhead stays time-correct (scroll just speeds up through dense bars). game view is
    // unaffected (it uses time directly).
    const SLOT_EPS = 0.030, MIN_GAP = 0.30;
    const anchT = [], anchLx = [];
    let slotT = -1e9, slotLx = 0, prevB = 0, first = true;
    for (let i = 0; i < vm.notes.length; i++) {     // notes are sorted by start time (song.py)
      const nt = vm.notes[i];
      if (nt.t - slotT > SLOT_EPS) {                // start a new column
        const b = beatPos(nt.t, beats);
        if (first) { slotLx = b; first = false; } else { slotLx += Math.max(MIN_GAP, b - prevB); }
        prevB = b; slotT = nt.t;
        anchT.push(slotT); anchLx.push(slotLx);
      }
      nt._lx = slotLx;
      nt._top = false;
      if (nt.d > maxDur) maxDur = nt.d;
      const k = nt.staff + '_' + Math.round(nt.t / 0.05);
      if (!(k in tops) || nt.idx > vm.notes[tops[k]].idx) tops[k] = i;
    }
    for (const k in tops) vm.notes[tops[k]]._top = true;
    vm._maxDur = maxDur;                 // longest note (sec) — windowing margin (R.1)
    vm._anchT = anchT; vm._anchLx = anchLx;
  }
  // R.1: notes are sorted by start time (song.py), and _b is monotonic in t, so we can
  // binary-search the first visible note instead of scanning all N every frame.
  // lower-bound: smallest index i where key(notes[i]) >= target.
  function lbound(notes, key, target) {
    let lo = 0, hi = notes.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (key(notes[m]) < target) lo = m + 1; else hi = m; }
    return lo;
  }
  const keyT = nt => nt.t, keyLx = nt => nt._lx;
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
  function setPlay(channels, hand) { playSet = channels ? new Set(channels) : null; playHand = (hand === 'R' || hand === 'L') ? hand : null; dirty = true; }
  function setPos(t, isWaiting, want) { now = t; waiting = !!isWaiting; setWanted(want || []); dirty = true; }
  // Live keys the player presses -> drawn on the staff at the play line (PianoBooster behaviour).
  function setPlayed(n, on) { if (on) playedSet.add(n); else playedSet.delete(n); dirty = true; }

  /* ---- R.4 local playback clock (only active in ?next mode; off = unchanged) ---- */
  let clockOn = false, clockPlaying = false, clockSpeed = 1, lastTs = null;
  let gateTimes = [], gatePtr = 0, freezeMode = false, lastFrozen = -1;
  function enableClock() { clockOn = true; }
  function setClock(playing, speed) { clockPlaying = !!playing; if (speed != null) clockSpeed = +speed || 1; if (!clockPlaying) lastTs = null; dirty = true; }
  function firstGateAtOrAfter(t) { let lo = 0, hi = gateTimes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (gateTimes[m] < t - 1e-6) lo = m + 1; else hi = m; } return lo; }
  function setGates(times) { gateTimes = times || []; gatePtr = firstGateAtOrAfter(now); lastFrozen = -1; dirty = true; }
  function clearGateUpto(gi) { if (gi != null && gi + 1 > gatePtr) { gatePtr = gi + 1; dirty = true; } }   // a verdict = that gate is done
  function setFreezeMode(on) { freezeMode = !!on; dirty = true; }
  // For the browser-sound scheduler: current clock + the next-gate ceiling (don't schedule backing past it).
  function clockState() { return { t: now, playing: clockPlaying, speed: clockSpeed, limit: (freezeMode && gatePtr < gateTimes.length) ? gateTimes[gatePtr] : Infinity }; }
  // Gentle drift correction from the throttled position heartbeat; snap on a big jump (seek/loop).
  function correctNow(t) {
    if (!clockOn || t == null) return;
    if (!clockPlaying) { now = t; dirty = true; return; }
    if (Math.abs(t - now) > 0.5) { now = t; gatePtr = firstGateAtOrAfter(t); dirty = true; return; }
    if (freezeMode && gatePtr < gateTimes.length && Math.abs(now - gateTimes[gatePtr]) < 1e-3 && t > now + 0.25) gatePtr++;   // backstop resume if a verdict was missed
    now += (t - now) * 0.18;
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
      if (nt.n < rangeLo || nt.n > rangeHi) continue;
      w.push(nt.n);
    }
    waiting = true; setWanted(w);
  }
  function setLoop(a, b) { loopA = (a == null ? null : a); loopB = (b == null ? null : b); dirty = true; }
  function setNames(on) { showNames = !!on; dirty = true; }
  function setWanted(list) {
    for (const n in wantedSet) { if (keys[n]) keys[n].classList.remove('wait'); delete wantedSet[n]; }
    wanted = list;
    for (let i = 0; i < list.length; i++) { wantedSet[list[i]] = 1; if (keys[list[i]]) keys[list[i]].classList.add('wait'); }
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
    for (let bi = 0; bi < bars.length; bi++) {
      const by = H - (bars[bi] - now) * pps;
      if (by < -1 || by > H) continue;
      ctx.fillStyle = C_BARMK; ctx.fillRect(0, by, W, 1);
      ctx.fillStyle = C_NAME; ctx.fillText(String(bi + 1), 3, by + 2);
    }
    // window: first note that can still be on screen (its sustain may trail past the line,
    // so go back by the longest note) .. last note that has appeared at the top.
    const notes = song.notes;
    const tHi = now + LOOKAHEAD + 0.05;
    let i = lbound(notes, keyT, now - (song._maxDur || 0) - 0.05);
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
      const base = (atLine && wantedSet[nt.n]) ? '#f5b21f' : !mine ? '#6f7b8a' : nt.hand === 'L' ? '#56a3ff' : '#58d977';
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
        C_PLAYED = '#3fe08a';                // the keys the player is pressing (live), shown on the staff

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
    const step = Math.max(6, Math.min(13, H / 40));   // px per stave-index step
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
    const playX = scrollX + (endX - scrollX) * 0.4;   // play zone at 40% (PB Cfg::playZoneX)
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

  function drawNotation(W, H) {
    const g = notationGeom(W, H);
    if (staticDirty || !staticCv || staticCv.width !== W || staticCv.height !== H) buildStaticLayer(W, H, g);
    ctx.drawImage(staticCv, 0, 0);                    // blit the cached staff + header
    if (!song) return;
    const { step, s, trebleC, bassC, scrollX, endX, playX, markTop, markBot, yOf } = g;
    {
      // ---- scrolling region (engraving-spaced; clipped so it can't bleed into the header) ----
      const beats = song.beats, num = (song.timesig && song.timesig[0]) || 4;
      const aT = song._anchT || [], aLx = song._anchLx || [];   // real time <-> layout-x anchors
      const BEATS_AHEAD = 8;
      const ppb = Math.max(24, (endX - playX) / BEATS_AHEAD);   // px per layout unit
      const nowLx = interp(aT, aLx, now);            // playhead position in the variable layout
      const bx = lx => playX + (lx - nowLx) * ppb;
      const behind = (playX - scrollX) / ppb + 1;
      const lxLo = nowLx - behind - 0.5, lxHi = nowLx + BEATS_AHEAD + 0.5;

      ctx.save();
      ctx.beginPath(); ctx.rect(scrollX - 1, 0, endX - scrollX + 2, H); ctx.clip();

      // play zone band
      ctx.fillStyle = C_ZONE; ctx.fillRect(playX - 9 * s, markTop, 18 * s, markBot - markTop);

      // loop region: shade the looped bars + mark its edges (loopA/loopB are times -> layout x)
      if (loopA != null && loopB != null) {
        const xa = bx(interp(aT, aLx, loopA)), xz = bx(interp(aT, aLx, loopB));
        ctx.fillStyle = C_LOOP; ctx.fillRect(xa, markTop, xz - xa, markBot - markTop);
        ctx.strokeStyle = C_LOOPEDGE; ctx.lineWidth = Math.max(1.4, 1.6 * s);
        for (const xe of [xa, xz]) { ctx.beginPath(); ctx.moveTo(xe, markTop); ctx.lineTo(xe, markBot); ctx.stroke(); }
      }

      // beat + bar lines: each beat's TIME mapped through the layout, so they track the notes.
      // Bound the beat indices by the visible time window (inverse map of the lx window).
      const tLo = interp(aLx, aT, lxLo), tHi = interp(aLx, aT, lxHi);
      const jStart = Math.max(0, nbound(beats, tLo) - 1), jEnd = Math.min(beats.length - 1, nbound(beats, tHi));
      for (let j = jStart; j <= jEnd; j++) {
        const x = bx(interp(aT, aLx, beats[j]));
        if (x >= scrollX && x <= endX) {              // tall counting line on EVERY beat
          ctx.strokeStyle = (j % num === 0) ? C_BARMK : C_BEAT; ctx.lineWidth = Math.max(1, s);
          ctx.beginPath(); ctx.moveTo(x, markTop); ctx.lineTo(x, markBot); ctx.stroke();
        }
        if (j % num === 0) {                          // bar line within the staves, slight lead
          const xb = x - 0.3 * ppb;
          if (xb < scrollX || xb > endX) continue;
          ctx.strokeStyle = C_BAR; ctx.lineWidth = Math.max(1.4, 1.7 * s);
          ctx.beginPath(); ctx.moveTo(xb, yOf('treble', 4)); ctx.lineTo(xb, yOf('treble', -4)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(xb, yOf('bass', 4)); ctx.lineTo(xb, yOf('bass', -4)); ctx.stroke();
          const barNo = Math.round(j / num) + 1;
          ctx.fillStyle = C_BARNUM; ctx.font = '600 ' + (step * 1.25).toFixed(0) + 'px system-ui';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(String(barNo), xb + 3 * s, trebleC - 6 * step);
        }
      }
      // now line
      ctx.strokeStyle = waiting ? C_WANT : C_NOW; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(playX, markTop); ctx.lineTo(playX, markBot); ctx.stroke();

      // window to the visible layout range via binary search (notes sorted by _lx)
      const notes = song.notes;
      let i = lbound(notes, keyLx, lxLo);
      for (; i < notes.length; i++) {
        const nt = notes[i];
        if (nt._lx > lxHi) break;
        if (playSet && !playSet.has(nt.ch)) continue;   // hide parts you don't play (background)
        const x = bx(nt._lx); if (x < scrollX - step || x > endX) continue;
        const y = yOf(nt.staff, nt.idx);
        const mine = (nt.n >= rangeLo && nt.n <= rangeHi) && (!playHand || nt.hand === playHand);
        const col = (Math.abs(nt.t - now) < 0.06 && wantedSet[nt.n]) ? C_WANT : (mine ? C_NOTE : C_DIM);
        const t = nt.sym, solid = t === '16' || t === '8' || t === 'q', flags = t === '16' ? 2 : t === '8' ? 1 : 0;
        const c = nt.staff === 'treble' ? trebleC : bassC, lw = 12 * s;
        // ledger lines (PB threshold |idx| >= 6)
        ctx.strokeStyle = C_STAVE; ctx.lineWidth = Math.max(1, s);
        if (nt.idx >= 6) for (let k = 6; k <= nt.idx; k += 2) { const yy = c - k * step; ctx.beginPath(); ctx.moveTo(x - lw, yy); ctx.lineTo(x + lw, yy); ctx.stroke(); }
        if (nt.idx <= -6) for (let k = -6; k >= nt.idx; k -= 2) { const yy = c - k * step; ctx.beginPath(); ctx.moveTo(x - lw, yy); ctx.lineTo(x + lw, yy); ctx.stroke(); }
        if (nt.acc) accidental(Math.abs(nt.acc) === 2 ? 2 : nt.acc, x - 16 * s, y, s, col);
        // stem (up, right side) + flags
        const noteW = solid ? 6 : 7;
        if (t !== 'w') {
          ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.4, 2 * s);
          ctx.beginPath(); ctx.moveTo(x + noteW * s, y); ctx.lineTo(x + noteW * s, y - 34 * s); ctx.stroke();
          let o = 34;
          for (let f = 0; f < flags; f++) { ctx.beginPath(); ctx.moveTo(x + noteW * s, y - o * s); ctx.lineTo(x + (noteW + 8) * s, y - (o - 16) * s); ctx.stroke(); o -= 8; }
        }
        // note head (ported 12-vertex polygon) — solid uses the cached Path2D (R.3)
        if (solid) { ctx.fillStyle = col; fillGlyph(NOTEHEAD_PATH, x, y, s); }
        else { ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.4, 2 * s); strip(NOTEHEAD, x, y, s, true, false); }
        // note name in a chip, up-and-left of the note (clear of the up-right stem)
        if (showNames && nt.n <= 90 && nt._top && step >= 7) {
          const fh = step * 1.5;
          ctx.font = '600 ' + fh.toFixed(0) + 'px system-ui';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const lx = x - 9 * s, ly = y - 2 * step - 2;
          if (nt._nmW == null || nt._nmFh !== fh) { nt._nmW = ctx.measureText(nt.nm).width; nt._nmFh = fh; }  // measure once, not per frame
          const tw = nt._nmW, pad = 3 * s;
          ctx.fillStyle = 'rgba(13,17,23,0.85)';
          rr(lx - tw / 2 - pad, ly - fh / 2 - 1, tw + 2 * pad, fh + 2, 3 * s); ctx.fill();
          ctx.fillStyle = C_NAME;
          ctx.fillText(nt.nm, lx, ly);
        }
      }
      // live keys the player is pressing, drawn on the staff at the play line (PianoBooster behaviour)
      if (playedSet.size) {
        const split = (song && song.split) || 60, lw = 12 * s;
        for (const n of playedSet) {
          const sp = staffPos(+n, split);
          const c = sp.staff === 'treble' ? trebleC : bassC, y = yOf(sp.staff, sp.idx);
          ctx.strokeStyle = C_PLAYED; ctx.lineWidth = Math.max(1, s);
          if (sp.idx >= 6) for (let k = 6; k <= sp.idx; k += 2) { const yy = c - k * step; ctx.beginPath(); ctx.moveTo(playX - lw, yy); ctx.lineTo(playX + lw, yy); ctx.stroke(); }
          if (sp.idx <= -6) for (let k = -6; k >= sp.idx; k -= 2) { const yy = c - k * step; ctx.beginPath(); ctx.moveTo(playX - lw, yy); ctx.lineTo(playX + lw, yy); ctx.stroke(); }
          if (sp.acc) accidental(sp.acc, playX - 16 * s, y, s, C_PLAYED);
          ctx.fillStyle = C_PLAYED; fillGlyph(NOTEHEAD_PATH, playX, y, s);
        }
      }
      ctx.restore();
    }
  }

  /* ---- frame ---- */
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (view === 'notation') drawNotation(W, H);
    else drawGame(W, H);
  }
  function frame(ts) {
    requestAnimationFrame(frame);
    if (clockOn && clockPlaying) {                 // R.4: advance the local clock, freezing at gates
      if (lastTs != null) {
        let n = now + ((ts - lastTs) / 1000) * clockSpeed;
        if (freezeMode && gatePtr < gateTimes.length && n >= gateTimes[gatePtr]) n = gateTimes[gatePtr];
        now = n; dirty = true;
      }
      lastTs = ts;
    } else lastTs = null;
    if (clockOn) refreshWantedLocal();
    if (ctx && dirty) { draw(); dirty = false; }
  }

  return { buildKeyboard, highlight, attachCanvas, setSong, setPos, setPlayed, setView, setPlay, setRange, setLoop, setNames,
           enableClock, setClock, setGates, clearGateUpto, setFreezeMode, correctNow, clockState };
})();
