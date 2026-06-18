/* PiTV app orchestration. The Pi engine is authoritative: we POST controls
   (load/play/stop/hand) and render the position it streams back over SSE.
   Timing + Follow-You gating live on the Pi, not here. */
(function () {
  const $ = id => document.getElementById(id);

  // Tiny DOM builder so view code is declarative + DRY (no repeated createElement boilerplate).
  // h('div', {class:'x', onclick:fn}, child, 'text', [more]) -> HTMLElement.
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'tabIndex') e.tabIndex = v;
      else if (k.startsWith('on')) e[k.toLowerCase()] = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  }
  // Nodes the app itself owns. (The Part dropdown #handSel belongs to PiSetup; the position bar
  // #seek/#seekfill/#time to PiTransport; the library nodes to PiLib — the app reaches none of them.)
  const statusEl = $('status'),
        backBtn = $('quitStage'), playBtn = $('play'), resetBtn = $('reset'),
        viewBtn = $('view'), songLabel = $('song'),
        modeSel = $('modeSel'),
        speedSel = $('speedSel'), kbdSel = $('kbdSel'), transSel = $('transSel'),
        scoreEl = $('score'), namesBtn = $('names'),
        stage = $('stage'), menu = $('menu'), startBtn = $('startBtn'),
        favBtn = $('fav'), splitSel = $('splitSel'),
        menuBack = $('menuBack'), menuSettings = $('menuSettings'), menuTitle = $('menuTitle'),
        splitField = $('splitField'),
        finish = $('finish'), finStars = $('finStars'), finSub = $('finSub'), finAgain = $('finAgain'), finPick = $('finPick'),
        countin = $('countin'),
        pauseEl = $('pause'), pMode = $('pMode'), pSpeed = $('pSpeed'), pHand = $('pHand'),
        pResume = $('pResume'), pRestart = $('pRestart'), pMore = $('pMore'), pQuit = $('pQuit');

  /* ---- navigation: ONE view at a time, ROOTED AT HOME. Home -> Library -> Setup -> Stage.
         Back goes up one level. The Stage is just a view you Play into and Quit out of — there is
         no "menu over the stage" and no "close to reveal the stage". Home is the root: no Back. ---- */
  const SCREENS = { home: 'screenHome', library: 'screenSongs', setup: 'screenSetup', settings: 'screenSettings' };
  const TITLES = { home: '', library: 'Library', setup: '', settings: 'Settings' };
  const PARENT = { library: 'home', setup: 'library', settings: 'home' };   // where Back goes from each view
  let view = 'home';
  function go(name) {
    view = name;
    const onStage = (name === 'stage');
    stage.hidden = !onStage;
    menu.hidden = onStage;
    if (!onStage) {
      for (const k in SCREENS) $(SCREENS[k]).hidden = (k !== name);
      if (name === 'setup') {                       // refresh dynamic bits for this song
        PiSetup.buildInstr(); PiTransport.buildLoop(); PiSetup.fillSetupHead(); PiSetup.updateModeHint(mode);
        const oneTrack = !!(PiSession.vm && PiSession.vm.rightChan != null && PiSession.vm.rightChan === PiSession.vm.leftChan);
        splitField.style.display = oneTrack ? '' : 'none';
      }
      menuTitle.textContent = TITLES[name] || '';
      menuBack.hidden = (name === 'home');          // Home is the root — nothing above it
      menuSettings.hidden = (name === 'home' || name === 'settings');
    } else {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));   // canvas was display:none
    }
    if (PiNav.isKbd()) setTimeout(PiNav.focusFirst, 0);
  }
  menuBack.onclick = () => go(PARENT[view] || 'home');
  menuSettings.onclick = () => go('settings');
  $('homeStart').onclick = () => go('library');
  $('homeSettings').onclick = () => go('settings');
  startBtn.onclick = () => { if (!playing) playBtn.click(); };   // "Play now" -> playBtn takes us to the Stage

  // Keyboard-size presets -> MIDI [lowest, highest] note. Keys outside the chosen range
  // are dimmed so the lit part of the on-screen keyboard matches the player's hardware.
  const KBD_RANGES = { 88: [21, 108], 76: [28, 103], 61: [36, 96], 49: [36, 84], 37: [48, 84], 25: [48, 72] };

  PiTV.buildKeyboard($('piano'));
  PiTV.attachCanvas($('fall'));
  PiTV.enableClock();                              // render runs its own clock; pos frames only correct it

  // The loaded song + the player's part live in PiSession (session.js); mode/transpose/split + the
  // transient flow flags (playing/restoring/loadSeq/lastT/selFile/endedShown) stay here in the orchestrator.
  let mode = 'follow', playing = false;
  let transpose = 'auto';                       // octave shift to fit the keyboard ('auto' or semitones)
  let split = 60;                               // left/right hand + treble/bass split pitch (middle C)
  let restoring = false, restoreSeq = 0;        // suppress auto-save while applying saved settings (restoreSeq = the load that owns the flag)
  let loadSeq = 0;                              // monotonic load token; a stale async load bails instead of clobbering
  let lastT = 0;                                // last streamed play position (for keyboard seek)
  function kbdRange() { return KBD_RANGES[kbdSel.value] || KBD_RANGES[88]; }

  // Per-song settings live on the Pi (keyed by file) so they follow the song to any client.
  // Debounced so dragging a select through intermediate values doesn't rewrite the whole file each step.
  let saveTimer = null;
  function saveCurrent() {
    if (restoring || !PiSession.file) return;
    const file = PiSession.file;
    // Snapshot WHAT to save NOW, not at fire time — so a song switch within the 350ms debounce
    // can't persist this song's file with the next song's settings.
    const settings = {
      hand: PiSetup.handValue(), play: PiSession.play.slice(), speed: speedSel.value,
      transpose: transSel.value, mode: modeSel.value, split: splitSel.value,
    };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { control({ cmd: 'save_settings', file: file, settings: settings }).catch(() => {}); }, 350);
  }

  /* ---- saved preferences (keyboard size + speed) ---- */
  function applyKbd(size) {
    const r = KBD_RANGES[size] || KBD_RANGES[88];
    PiTV.setRange(r[0], r[1]);
  }
  (function restorePrefs() {
    const savedKbd = localStorage.getItem('pitv.kbd');
    if (savedKbd && KBD_RANGES[savedKbd]) kbdSel.value = savedKbd;
    applyKbd(kbdSel.value);
    const savedSpeed = localStorage.getItem('pitv.speed');
    if (savedSpeed) speedSel.value = savedSpeed;
    control({ cmd: 'speed', mult: +speedSel.value }).catch(() => {});   // sync engine to the UI
  })();
  kbdSel.onchange = async () => {
    localStorage.setItem('pitv.kbd', kbdSel.value);
    applyKbd(kbdSel.value);                       // dim out-of-range keys
    const [lo, hi] = kbdRange();
    if (PiSession.file) await loadSong(PiSession.file, true);   // re-fit + re-gate for the new range
    else control({ cmd: 'range', lo, hi }).catch(() => {});
  };
  transSel.onchange = async () => {
    transpose = transSel.value === 'auto' ? 'auto' : +transSel.value;
    if (PiSession.file) await loadSong(PiSession.file, true);
    saveCurrent();
  };
  splitSel.onchange = async () => {
    split = +splitSel.value;
    if (PiSession.file) await loadSong(PiSession.file, true);   // rebuilds hands/staff at the new split
    saveCurrent();
  };
  speedSel.onchange = () => {
    localStorage.setItem('pitv.speed', speedSel.value);
    PiTV.setClock(playing, +speedSel.value);
    control({ cmd: 'speed', mult: +speedSel.value }).catch(() => {});
    saveCurrent();
  };

  // Set which part the player covers (channels + optional hand); the rest becomes background.
  // (The Part dropdown -> channels/hand logic + the Setup screen live in setup.js / PiSetup.)
  function setPlayChannels(ch, hand) {
    PiSession.play = ch.slice(); PiSession.hand = hand || null;
    PiTV.setPlay(ch, PiSession.hand);            // show only your chosen part (Listen plays the rest for sound)
    control({ cmd: 'play_parts', channels: ch, hand: PiSession.hand }).catch(() => {});
  }
  function applyParts() {
    setPlayChannels(PiSetup.partChannels(), PiSetup.partHand());
    if (view === 'setup') PiSetup.buildInstr();           // keep the Setup Play boxes in sync
    saveCurrent();
  }

  async function control(req) {
    const r = await fetch('/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* ---- song catalogue + left rail + song grid: lives in pilib.js (PiLib). The app keeps the
     "selected file" and tells PiLib to highlight it; PiLib calls back via onPick when a song is
     chosen, and the app persists fav/played/best through PiLib's methods. ---- */
  let selFile = null;
  favBtn.onclick = () => { if (selFile) { PiCatalog.toggleFav(selFile); PiSetup.updateFavBtn(); } };

  // Adopt the engine's authoritative snapshot (sent in the SSE 'hello' on connect / song change),
  // so a reconnecting or second client matches what the Pi is actually playing — not a default.
  function adoptHello(m) {
    PiSession.vm = m.vm; PiSession.file = m.file || null; selFile = m.file || null; PiLib.select(selFile);
    PiTV.setSong(m.vm); PiSetup.buildPartOptions(m.vm); showTranspose(m.vm.transpose || 0);
    songLabel.textContent = '♪ ' + m.vm.title + ' · ' + m.vm.notes.length + ' notes';
    if (m.speed != null) { speedSel.value = String(m.speed); PiTV.setClock(m.playing, m.speed); }
    if (m.mode) { modeSel.value = m.mode; mode = m.mode; }
    PiTV.setFreezeMode(mode === 'follow');
    if (m.hand === 'R' || m.hand === 'L') PiSetup.setHand(m.hand);
    if (Array.isArray(m.play)) { PiSession.play = m.play.slice(); PiSession.hand = m.hand || null; PiTV.setPlay(PiSession.play, PiSession.hand); }
    if (typeof m.pi_muted === 'boolean') PiSound.setPiMute(m.pi_muted);   // reflect the engine's real mute state
    PiSetup.updateModeHint(mode);
  }

  // Show the octave shift the engine actually applied (esp. when Auto picks one).
  function showTranspose(applied) {
    const opt = transSel.querySelector('option[value="auto"]');
    if (!opt) return;
    const oct = applied / 12;
    opt.textContent = (transSel.value === 'auto' && applied)
      ? 'Auto · ' + (applied > 0 ? '+' : '') + (Number.isInteger(oct) ? oct + ' oct' : applied + ' st')
      : 'Auto (fit keyboard)';
  }

  // Load into the engine (which returns the view-model for us to render). keep=true re-loads
  // the current song (after a transpose/keyboard change) WITHOUT resetting the chosen parts.
  async function loadSong(file, keep, token) {
    if (token == null) token = ++loadSeq;        // standalone call (e.g. a select onchange) gets its own token
    try {
      const [lo, hi] = kbdRange();
      const body = { cmd: 'load', file: file, transpose: transpose, lo: lo, hi: hi, split: split };
      if (keep) body.play = PiSession.play;
      const vm = await control(body);
      if (token !== loadSeq) return false;        // a newer load started while we awaited — drop this one
      PiSession.file = file;
      PiSession.vm = vm;
      PiTV.setSong(vm);
      if (keep) { setPlayChannels(PiSession.play, PiSession.hand); }
      else { PiSetup.buildPartOptions(vm); applyParts(); }
      showTranspose(vm.transpose || 0);
      PiTransport.clearLoop();                   // bar counts differ between songs
      if (view === 'setup') { PiSetup.buildInstr(); PiTransport.buildLoop(); }   // refresh Setup for the new song
      const shift = vm.transpose || 0;
      const stag = shift ? ' · ' + (shift > 0 ? '+' : '') + (shift / 12) + ' oct' : '';
      songLabel.textContent = '♪ ' + vm.title + ' · ' + vm.notes.length + ' notes' + stag;
      PiSound.resync();                            // new song -> reload instruments + re-aim the scheduler
      return true;
    } catch (e) {
      songLabel.textContent = 'could not load song';
      PiSession.file = null;
      return false;
    }
  }

  // Pick a song: restore its saved settings (part/speed/octave/mode) from the Pi, then load.
  async function selectSong(file) {
    const my = ++loadSeq;                               // claim this load; a newer pick invalidates us
    setPlayBtn(false);
    selFile = file; PiLib.select(file);                 // highlight it in the rail
    restoring = true; restoreSeq = my;                  // suppress auto-save during restore; we own the flag
    const release = () => { if (restoreSeq === my) restoring = false; };   // only clear if a newer load hasn't taken over
    let s = {};
    try { s = await (await fetch('/settings?file=' + encodeURIComponent(file))).json(); } catch (e) {}
    if (my !== loadSeq) { release(); return; }          // a newer selectSong started during the fetch
    const has = s && Object.keys(s).length;
    if (has && s.speed) speedSel.value = s.speed;       // else: speed carries over
    transSel.value = (has && s.transpose) ? s.transpose : 'auto';   // fresh song -> auto-fit
    splitSel.value = (has && s.split) ? s.split : '60';             // fresh song -> middle C
    if (has && s.mode) modeSel.value = s.mode;
    transpose = transSel.value === 'auto' ? 'auto' : +transSel.value;
    split = +splitSel.value;
    mode = modeSel.value;
    PiTV.setFreezeMode(mode === 'follow');
    const ok = await loadSong(file, false, my);         // builds vm with that transpose/range (same token)
    if (my !== loadSeq) { release(); return; }          // superseded while loading
    release();
    if (!ok) return;
    if (has && s.hand) PiSetup.setHand(s.hand);         // best-effort dropdown label
    if (has && s.play) setPlayChannels(s.play, PiSetup.partHand());   // authoritative part selection
    PiTV.setPlay(PiSession.play, PiSession.hand);
    control({ cmd: 'speed', mult: +speedSel.value }).catch(() => {});   // sync engine
    control({ cmd: 'mode', mode: mode }).catch(() => {});
    PiLib.select(file);                                 // re-highlight the picked song in the rail
    if (view !== 'stage') go('setup');                  // picking a song advances to its Setup
  }

  function setPlayBtn(on) {
    playing = on;
    playBtn.innerHTML = on ? '&#10073;&#10073; Pause' : '&#9654; Play';   // it pauses (opens the pause menu), so say so
    playBtn.classList.toggle('on', on);
    if (!on) { countin.hidden = true; if (countin.firstChild) countin.firstChild.textContent = ''; }  // every stop path clears the 3-2-1
    PiSound.onPlay(on);                                  // scheduler runs only while playing
  }

  /* ---- controls ---- */
  playBtn.onclick = async () => {
    if (!PiSession.file && selFile) await selectSong(selFile);
    if (!PiSession.file) return;
    const wantPlay = !playing;            // decide BEFORE the await — `playing` may change during it
    setPlayBtn(wantPlay);
    PiTV.setClock(wantPlay, +speedSel.value);   // optimistic: pause/play feels instant locally
    if (wantPlay) { PiCatalog.markPlayed(PiSession.file); endedShown = false; finish.hidden = true; closePause(); go('stage'); }  // fresh run
    try {
      await control({ cmd: wantPlay ? 'play' : 'stop' });
      if (!wantPlay) openPause();          // manual stop -> the pause screen (quick tweaks / quit)
    } catch (e) { setPlayBtn(!wantPlay); }  // revert if the request failed
  };
  resetBtn.onclick = async () => {
    setPlayBtn(false);
    PiTV.setClock(false);                 // pos will snap the clock to the new position
    try { await control({ cmd: 'reset' }); } catch (e) {}
  };
  // Visible Back/Quit on the Stage (a TV remote can't discover Esc): pause + open the menu (which has Quit).
  backBtn.onclick = () => { if (playing) playBtn.click(); else openPause(); };
  modeSel.onchange = async () => {
    mode = modeSel.value;
    PiTV.setFreezeMode(mode === 'follow');   // only Follow freezes the local clock at gates
    PiSetup.updateModeHint(mode);
    PiTV.setPlay(PiSession.play, PiSession.hand);
    saveCurrent();
    try { await control({ cmd: 'mode', mode: mode }); } catch (e) {}
  };

  /* ---- the per-track instruments panel + the Part dropdown + the mode hint + the hero live in
     setup.js (PiSetup). app keeps the shared performance state (PiSession + mode) and the
     load/select state machine; PiSetup renders the Setup screen and calls back via onPlay. ---- */

  /* ---- transport: click-to-seek + loop-a-passage drilling live in transport.js (PiTransport).
     The app calls buildLoop on entering Setup and clearLoop on a new song; PiTransport owns the
     loop state, the #loopPanel builder, and the #seek click handler. The pos heartbeat below still
     paints the bar's fill/time readout. ---- */
  let canvasView = 'notation';
  viewBtn.textContent = 'View: Notation';
  viewBtn.onclick = () => {
    canvasView = canvasView === 'game' ? 'notation' : 'game';
    PiTV.setView(canvasView);
    viewBtn.textContent = 'View: ' + (canvasView === 'game' ? 'Game' : 'Notation');
  };
  let names = localStorage.getItem('pitv.names') !== 'off';     // default on
  function applyNames() { PiTV.setNames(names); namesBtn.textContent = 'Names: ' + (names ? 'on' : 'off'); namesBtn.classList.toggle('on', names); }
  applyNames();
  namesBtn.onclick = () => { names = !names; localStorage.setItem('pitv.names', names ? 'on' : 'off'); applyNames(); };

  /* ---- browser sound lives in sound.js now (PiSound: SoundEngine base + Light/Rich subclasses,
     scheduler, and the sound/mute UI). It reads the song + "which notes are mine" through the context
     below; we drive it via PiSound.resync / live / onPlay / heartbeat / setPiMute. ---- */
  function isMine(nt) {                                 // notes YOU play live -> not scheduled as backing
    if (mode === 'listen' || !PiSession.play.includes(nt.ch)) return false;
    if (PiSession.hand && nt.hand !== PiSession.hand) return false;
    const [lo, hi] = kbdRange(); return nt.n >= lo && nt.n <= hi;
  }
  PiSound.init({ getVM: () => PiSession.vm, isMine, control, getClock: () => PiTV.clockState() });

  // Timing feedback: running tallies + an instant per-note flash (early / good / late).
  let timingTally = null, flashing = false, flashTimer = null;
  function showTiming() {
    const t = timingTally;
    if (!t || !t.on) { scoreEl.textContent = 'Timing: —'; scoreEl.className = 'badge'; return; }
    if (!(t.good + t.late + t.early + t.miss + (t.wrong || 0))) { scoreEl.textContent = 'Timing: ready'; scoreEl.className = 'badge'; return; }
    scoreEl.textContent = '🎯 ' + t.good + ' good · ' + t.late + ' late · ' + t.early + ' early'
      + (t.miss ? ' · ' + t.miss + ' miss' : '') + (t.wrong ? ' · ' + t.wrong + ' wrong' : '');
    scoreEl.className = 'badge';
  }
  const RATING = {            // verdict -> badge label + css class (was two parallel lookup maps)
    early: { label: 'EARLY', cls: 'r-early' }, good: { label: 'GOOD!', cls: 'good' },
    late: { label: 'LATE', cls: 'low' }, miss: { label: 'MISS', cls: 'r-miss' }, wrong: { label: 'WRONG', cls: 'r-miss' },
  };
  function flashRating(kind, off, note) {
    if (kind === 'wrong' && note != null) PiTV.flashWrong(note);   // flash the mis-pressed key red on the piano
    const r = RATING[kind] || { label: kind, cls: '' };
    const ms = (off != null && kind !== 'good' && kind !== 'wrong') ? ' ' + (off > 0 ? '+' : '') + Math.round(off * 1000) + 'ms' : '';
    scoreEl.textContent = r.label + ms;
    scoreEl.className = 'badge ' + r.cls;
    flashing = true; clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashing = false; showTiming(); }, 700);
  }

  /* ---- end-of-song celebration (reward loop) ---- */
  let endedShown = false;
  function celebrate() {
    const t = timingTally || {};
    const good = t.good || 0, late = t.late || 0, early = t.early || 0, miss = t.miss || 0, wrong = t.wrong || 0;
    const tot = good + late + early + miss;
    if (mode === 'listen' || tot === 0) {           // watching, not graded — don't hand out 3 gold stars
      finStars.textContent = '♪';
      finSub.textContent = 'Nice listening!';
      finish.hidden = false;
      if (PiNav.isKbd()) setTimeout(() => PiNav.focusAt(finAgain), 0);
      return;
    }
    let stars;
    if (mode === 'follow') {
      // Follow WAITS for you, so reaction time isn't a fault — reward correctness: notes hit vs
      // wrong/missed. (Tight early/good/late timing is graded in Play-along, where the clock runs.)
      const hit = good + late + early;
      const acc = hit / (hit + miss + wrong || 1);
      stars = acc >= 0.95 ? 3 : acc >= 0.7 ? 2 : 1;
    } else {
      const ratio = good / tot;                     // Play-along: timing IS the skill
      stars = ratio >= 0.85 ? 3 : ratio >= 0.55 ? 2 : 1;
    }
    finStars.textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
    finSub.textContent = good + ' good · ' + late + ' late · ' + early + ' early'
      + (miss ? ' · ' + miss + ' missed' : '') + (wrong ? ' · ' + wrong + ' wrong' : '');
    if (PiSession.file) PiCatalog.setBest(PiSession.file, stars);   // best (persisted) follows the song; only writes if higher
    finish.hidden = false;
    if (PiNav.isKbd()) setTimeout(() => PiNav.focusAt(finAgain), 0);
  }
  finAgain.onclick = async () => { finish.hidden = true; endedShown = false; try { await control({ cmd: 'reset' }); } catch (e) {} playBtn.click(); };
  finPick.onclick = () => { finish.hidden = true; endedShown = false; go('library'); };

  /* ---- pause screen (manual stop): quick no-reload tweaks + resume / restart / quit ---- */
  function openPause() {
    if (!PiSession.file) return;
    pMode.innerHTML = modeSel.innerHTML; pMode.value = modeSel.value;       // mirror the live (no-reload) controls
    pSpeed.innerHTML = speedSel.innerHTML; pSpeed.value = speedSel.value;
    const hm = PiSetup.handMirror(); pHand.innerHTML = hm.html; pHand.value = hm.value;
    pauseEl.hidden = false;
    if (PiNav.isKbd()) setTimeout(() => PiNav.focusAt(pResume), 0);
  }
  function closePause() { pauseEl.hidden = true; }
  pMode.onchange = () => { modeSel.value = pMode.value; modeSel.onchange(); };   // drive the real controls
  pSpeed.onchange = () => { speedSel.value = pSpeed.value; speedSel.onchange(); };
  pHand.onchange = () => { PiSetup.setHand(pHand.value); applyParts(); };   // drive the real Part dropdown
  pResume.onclick = () => { closePause(); if (!playing) playBtn.click(); };
  pRestart.onclick = async () => { closePause(); setPlayBtn(false); PiTV.setClock(false); try { await control({ cmd: 'reset' }); } catch (e) {} playBtn.click(); };
  pMore.onclick = () => { closePause(); go('setup'); };
  pQuit.onclick = async () => {                                  // unload the song and go back to the Library
    closePause(); setPlayBtn(false);
    PiTV.setClock(false);
    try { await control({ cmd: 'stop' }); } catch (e) {}
    PiSession.file = null;                                           // next Play reloads the song fresh
    go('library');
  };

  /* ---- D-pad / keyboard navigation (TV remote: arrows + Enter + Back) lives in nav.js (PiNav).
     It owns the focus-mode flag + column model + listeners; we inject the current view / play state /
     song (for seek) and the actions it triggers (go / openPause / control). ---- */
  PiNav.init({
    screens: SCREENS, parent: PARENT,
    getView: () => view, getPlaying: () => playing, getVM: () => PiSession.vm, getLastT: () => lastT,
    control, go, openPause,
  });
  PiTransport.init({ getVM: () => PiSession.vm, control, showLoop: (a, b) => PiTV.setLoop(a, b) });   // click-to-seek + loop drilling
  PiSetup.init({                                           // the Setup screen: part dropdown + instruments + hero
    getVM: () => PiSession.vm, getPlay: () => PiSession.play, getSelFile: () => selFile, control,
    onPlay: (channels) => { setPlayChannels(channels, null); saveCurrent(); },   // player re-picked their tracks
    onPart: () => applyParts(),                            // player changed the Part dropdown
    coverGlyph: PiCatalog.coverGlyph, coverBg: PiCatalog.coverBg, isFav: PiCatalog.isFav,    // injected — PiSetup never names the catalogue
  });

  /* ---- SSE: live keyboard notes + streamed play-position. The transport (connect/reconnect/parse)
     lives in sse.js (PiSse); what follows is just the handlers — what each message DOES. ---- */
  let lastTallyKey = '';
  // The pos/hello heartbeat is the one heavy arm — keep it in a named function; the rest are a map.
  function onPos(m) {
    // Only ADOPT the Pi's song on connect when it's actually PLAYING (a real reconnect / a 2nd
    // device joining mid-song). An idle Pi may still hold a song loaded from before — ignore it,
    // so a fresh load / F5 starts clean on the Library instead of dumping you into a random song.
    if (m.type === 'hello') {
      if (m.vm && m.playing && (!PiSession.vm || m.file !== PiSession.file)) {
        adoptHello(m); setPlayBtn(true); go('stage');   // join the in-progress song
      } else if (m.vm && !PiSession.vm) {
        adoptHello(m); setPlayBtn(!!m.playing);          // loaded-but-paused: adopt model, stay on Home
      }
    } else if (m.file && PiSession.file && m.file !== PiSession.file) {
      PiSse.reconnect(); return;                           // stale view: reconnect for a clean hello snapshot
    }
    lastT = m.t;                                           // local clock: pos is just a correction heartbeat
    if (m.gates) PiTV.setGates(m.gates);                   // hello carries gates
    PiTV.correctNow(m.t); PiTV.setClock(m.playing, m.speed);
    PiSound.heartbeat(m.t);                                // re-aims the backing scheduler on a backward jump
    if (playing && m.t < 0) { const n = Math.min(3, Math.ceil(-m.t)); countin.firstChild.textContent = n > 0 ? n : ''; countin.hidden = n <= 0; }
    else if (!countin.hidden) countin.hidden = true;
    PiTransport.showProgress(m.t, PiSession.vm ? PiSession.vm.duration : 0);   // PiTransport owns the position bar
    timingTally = m.timing;
    const tk = m.timing ? [m.timing.good, m.timing.late, m.timing.early, m.timing.miss, m.timing.wrong, m.timing.on].join() : '';
    if (!flashing && tk !== lastTallyKey) { showTiming(); lastTallyKey = tk; }   // only repaint when it changes
    if (m.ended) {                                         // song finished on its own (one-shot, never flips back)
      setPlayBtn(false); countin.hidden = true;
      if (!endedShown) { endedShown = true; celebrate(); }
    }
  }
  // SSE protocol -> handler map (was a 7-way if/else on m.type)
  PiSse.start({
    pos: onPos, hello: onPos,
    key: m => { PiNav.setKbd(true); document.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true, cancelable: true })); },
    gate: m => PiTV.clearGateUpto(m.gi),                   // freeze cursor cleared -> local clock resumes here
    rating: m => { flashRating(m.kind, m.off, m.note); if (m.gate != null) PiTV.setRated(m.gate, m.kind); },
    gates: m => PiTV.setGates(m.gates),                    // gate set changed (load / part / range / mode)
    noteon: m => { PiTV.highlight(m.note, true); PiTV.setPlayed(m.note, true); PiSound.live(m.note, true, m.velocity); },
    noteoff: m => { PiTV.highlight(m.note, false); PiTV.setPlayed(m.note, false); PiSound.live(m.note, false); },
  });

  // The catalogue holds the data; the selector (PiLib) is a pure view of it. The app wires them:
  // catalogue change -> re-render the selector; a tile pick / upload -> back through the catalogue.
  PiCatalog.init({ control, onChange: () => PiLib.render() });
  PiLib.init({
    getSongs: () => PiCatalog.songs(), getMeta: (f) => PiCatalog.meta(f),
    coverGlyph: PiCatalog.coverGlyph, coverBg: PiCatalog.coverBg,
    onPick: selectSong,                                       // a song tile was chosen
    onUpload: (files, prog) => PiCatalog.upload(files, prog), // MIDIs dropped on the upload button
  });
  PiCatalog.load();                                           // fetch songs + metadata -> fires onChange -> renders
  go('home');          // start at the Home screen (the root)
})();
