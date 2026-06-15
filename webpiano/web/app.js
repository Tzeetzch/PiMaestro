/* PiTV app orchestration. The Pi engine is authoritative: we POST controls
   (load/play/stop/hand) and render the position it streams back over SSE.
   Timing + Follow-You gating live on the Pi, not here. */
(function () {
  const $ = id => document.getElementById(id);
  const statusEl = $('status'),
        playBtn = $('play'), resetBtn = $('reset'),
        viewBtn = $('view'), songLabel = $('song'),
        handSel = $('handSel'), modeSel = $('modeSel'), instrPanel = $('instrPanel'),
        speedSel = $('speedSel'), kbdSel = $('kbdSel'), transSel = $('transSel'),
        loopPanel = $('loopPanel'), scoreEl = $('score'),
        seekEl = $('seek'), seekFill = $('seekfill'), namesBtn = $('names'),
        menuBtn = $('menuBtn'), menu = $('menu'), menuClose = $('menuClose'), startBtn = $('startBtn'),
        favBtn = $('fav'), uploadBtn = $('uploadBtn'), fileInput = $('fileInput'), splitSel = $('splitSel'),
        menuBack = $('menuBack'), menuTitle = $('menuTitle'), groupTabs = $('groupTabs'), songList = $('songList'),
        splitField = $('splitField'), modeHint = $('modeHint'),
        finish = $('finish'), finStars = $('finStars'), finSub = $('finSub'), finAgain = $('finAgain'), finPick = $('finPick'),
        countin = $('countin');

  /* ---- multi-screen menu: home -> song picker -> per-song setup -> game; settings off home ---- */
  const SCREENS = { home: 'screenHome', songs: 'screenSongs', setup: 'screenSetup', settings: 'screenSettings' };
  const TITLES = { home: '', songs: 'Choose a song', setup: '', settings: 'Settings' };
  let screen = 'home';
  function showScreen(name) {
    screen = name;
    for (const k in SCREENS) $(SCREENS[k]).hidden = (k !== name);
    if (name === 'setup') {                         // refresh dynamic bits for this song
      buildInstr(); buildLoop(); fillSetupHead(); updateModeHint();
      // Hand split only matters when both hands share one track (else R/L are real channels).
      const oneTrack = !!(currentVM && currentVM.rightChan != null && currentVM.rightChan === currentVM.leftChan);
      splitField.style.display = oneTrack ? '' : 'none';
    }
    menuTitle.textContent = TITLES[name] || '';
    menuBack.hidden = (name === 'home');
    menuClose.hidden = !loadedFile;                 // can only return to a game once a song is loaded
    if (kbd) setTimeout(() => focusFirst(), 0);     // land the remote's focus on this screen
  }
  // The ☰ opens the menu where it makes sense: straight to the song's setup if one's loaded, else home.
  function openMenu() { menu.hidden = false; showScreen(loadedFile ? 'setup' : 'home'); }
  function closeMenu() { menu.hidden = true; }
  menuBtn.onclick = () => { if (menu.hidden) openMenu(); else closeMenu(); };
  menuClose.onclick = closeMenu;
  menuBack.onclick = () => { showScreen(screen === 'setup' ? 'songs' : 'home'); };
  $('homeStart').onclick = () => showScreen('songs');
  $('homeSettings').onclick = () => showScreen('settings');
  startBtn.innerHTML = '&#9654; Play now';                 // distinct verb from Home "Start" (which just browses)
  startBtn.onclick = () => { closeMenu(); if (!playing) playBtn.click(); };

  // Per-mode plain-language hint shown under the Mode dropdown.
  const MODE_HINTS = {
    follow: 'The song pauses and waits until you press the right keys.',
    along: 'The song keeps going at a steady speed — try to keep up.',
    listen: 'The song plays itself so you can watch and listen.',
  };
  function updateModeHint() { modeHint.textContent = MODE_HINTS[modeSel.value] || ''; }

  // Keyboard-size presets -> MIDI [lowest, highest] note. Keys outside the chosen range
  // are dimmed so the lit part of the on-screen keyboard matches the player's hardware.
  const KBD_RANGES = { 88: [21, 108], 76: [28, 103], 61: [36, 96], 49: [36, 84], 37: [48, 84], 25: [48, 72] };

  // General MIDI instrument names (program 0..127)
  const GM_NAMES = ['Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet', 'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer', 'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion', 'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics', 'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2', 'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani', 'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit', 'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2', 'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet', 'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina', 'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass+lead)', 'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)', 'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)', 'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai', 'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal', 'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'];

  PiTV.buildKeyboard($('piano'));
  PiTV.attachCanvas($('fall'));

  let loadedFile = null, mode = 'follow', playing = false, currentVM = null, currentPlay = [], currentHand = null;
  let transpose = 'auto';                       // octave shift to fit the keyboard ('auto' or semitones)
  let split = 60;                               // left/right hand + treble/bass split pitch (middle C)
  let restoring = false;                        // suppress auto-save while applying saved settings
  let loadSeq = 0;                              // monotonic load token; a stale async load bails instead of clobbering
  let lastT = 0;                                // last streamed play position (for keyboard seek)
  function kbdRange() { return KBD_RANGES[kbdSel.value] || KBD_RANGES[88]; }

  // Per-song settings live on the Pi (keyed by file) so they follow the song to any client.
  // Debounced so dragging a select through intermediate values doesn't rewrite the whole file each step.
  let saveTimer = null;
  function saveCurrent() {
    if (restoring || !loadedFile) return;
    const file = loadedFile;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      control({ cmd: 'save_settings', file: file, settings: {
        hand: handSel.value, play: currentPlay, speed: speedSel.value,
        transpose: transSel.value, mode: modeSel.value, split: splitSel.value,
      } }).catch(() => {});
    }, 350);
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
    if (loadedFile) await loadSong(loadedFile, true);   // re-fit + re-gate for the new range
    else control({ cmd: 'range', lo, hi }).catch(() => {});
  };
  transSel.onchange = async () => {
    transpose = transSel.value === 'auto' ? 'auto' : +transSel.value;
    if (loadedFile) await loadSong(loadedFile, true);
    saveCurrent();
  };
  splitSel.onchange = async () => {
    split = +splitSel.value;
    if (loadedFile) await loadSong(loadedFile, true);   // rebuilds hands/staff at the new split
    saveCurrent();
  };
  speedSel.onchange = () => {
    localStorage.setItem('pitv.speed', speedSel.value);
    control({ cmd: 'speed', mult: +speedSel.value }).catch(() => {});
    saveCurrent();
  };

  // ---- which part(s) the player covers: Part dropdown -> MIDI channels (+ hand for 1-track) ----
  function partChannels() {
    const vm = currentVM; if (!vm) return [];
    const v = handSel.value;
    if (v === 'R') return vm.rightChan != null ? [vm.rightChan] : [];
    if (v === 'L') return vm.leftChan != null ? [vm.leftChan] : [];
    if (v && v.indexOf('ch:') === 0) return [parseInt(v.slice(3), 10)];
    return [...new Set([vm.rightChan, vm.leftChan].filter(c => c != null))];   // 'both'
  }
  // When both hands live on ONE channel, R/L can't be a channel — split by pitch instead.
  function partHand() {
    const vm = currentVM; if (!vm) return null;
    if (vm.rightChan != null && vm.rightChan === vm.leftChan) {
      if (handSel.value === 'R') return 'R';
      if (handSel.value === 'L') return 'L';
    }
    return null;
  }
  function buildPartOptions(vm) {
    handSel.innerHTML = '';
    const add = (val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; handSel.appendChild(o); };
    const r = vm.rightChan, l = vm.leftChan;
    add('both', 'Both hands');
    if (r != null || l != null) { add('R', 'Right hand'); add('L', 'Left hand'); }   // always pickable now
    (vm.parts || []).forEach(p => {                       // any other instrument you could play
      if (p.ch === 9 || p.ch === r || p.ch === l) return; // drums / piano part already covered
      add('ch:' + p.ch, 'Play: ' + (GM_NAMES[p.program] || ('Part ' + p.ch)));
    });
    handSel.value = 'both';
  }
  // Set which part the player covers (channels + optional hand); the rest becomes background.
  function setPlayChannels(ch, hand) {
    currentPlay = ch.slice(); currentHand = hand || null;
    PiTV.setPlay(ch, currentHand);            // show only your chosen part (Listen plays the rest for sound)
    control({ cmd: 'play_parts', channels: ch, hand: currentHand }).catch(() => {});
  }
  function applyParts() {
    setPlayChannels(partChannels(), partHand());
    if (!menu.hidden) buildInstr();                       // keep the menu's Play boxes in sync
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

  /* ---- song catalogue (+ Favorites / Recently-played virtual categories) ---- */
  let songsByGroup = {}, allSongs = [], lib = {}, currentGroup = null, selFile = null;
  const FAV = '★ Favorites', RECENT = '◷ Recently played';
  async function loadSongList() {
    try { allSongs = await (await fetch('/songs')).json(); } catch (e) { return; }
    try { lib = await (await fetch('/library')).json(); } catch (e) { lib = {}; }
    songsByGroup = {};
    for (const s of allSongs) (songsByGroup[s.group] = songsByGroup[s.group] || []).push(s);
    buildGroupTabs();
  }
  function favList() { return allSongs.filter(s => lib[s.file] && lib[s.file].fav); }
  function recentList() {
    return allSongs.filter(s => lib[s.file] && lib[s.file].played)
      .sort((a, b) => lib[b.file].played - lib[a.file].played).slice(0, 20);
  }
  function groupNames() {
    const names = [];
    if (recentList().length) names.push(RECENT);
    if (favList().length) names.push(FAV);
    return names.concat(Object.keys(songsByGroup));
  }
  function songsForGroup(g) {
    if (g === FAV) return favList();
    if (g === RECENT) return recentList();
    return songsByGroup[g] || [];
  }
  // Left column: one clickable tab per category. Selecting a tab repaints the song list.
  function buildGroupTabs() {
    const names = groupNames();
    if (!currentGroup || !names.includes(currentGroup)) currentGroup = names[0] || null;
    groupTabs.innerHTML = '';
    names.forEach(g => {
      const b = document.createElement('button');
      b.className = 'gtab' + (g === currentGroup ? ' on' : '');
      b.textContent = g + ' (' + songsForGroup(g).length + ')';
      b.onclick = () => { currentGroup = g; buildGroupTabs(); };
      groupTabs.appendChild(b);
    });
    fillSongList();
  }
  // Right pane: the songs in the chosen category. Clicking one loads it and goes to setup.
  function fillSongList() {
    songList.innerHTML = '';
    const songs = songsForGroup(currentGroup);
    if (!songs.length) {
      const e = document.createElement('li'); e.className = 'hint'; e.textContent = 'No songs here yet.';
      songList.appendChild(e); return;
    }
    songs.forEach(s => {
      const li = document.createElement('li');
      li.className = 'songitem' + (s.file === selFile ? ' on' : '');
      li.tabIndex = 0;                                    // focusable for D-pad / remote
      li.textContent = ((lib[s.file] && lib[s.file].fav) ? '★ ' : '') + s.title;
      const best = +(localStorage.getItem(bestKey(s.file)) || 0);
      if (best) { const sp = document.createElement('span'); sp.className = 'stars-mini'; sp.textContent = ' ' + '★'.repeat(best); li.appendChild(sp); }
      li.onclick = () => selectSong(s.file);
      songList.appendChild(li);
    });
  }
  function fillSetupHead() {
    if (!currentVM) return;
    $('setupTitle').textContent = currentVM.title || '—';
    const shift = currentVM.transpose || 0;
    const stag = shift ? ' · ' + (shift > 0 ? '+' : '') + (shift / 12) + ' oct' : '';
    $('setupSub').textContent = currentVM.notes.length + ' notes' + stag;
    updateFavBtn();
  }
  function updateFavBtn() {
    const f = selFile, on = !!(f && lib[f] && lib[f].fav);
    favBtn.textContent = on ? '★' : '☆';
    favBtn.classList.toggle('on', on);
  }
  function markPlayed(f) {
    if (!f) return;
    lib[f] = Object.assign({}, lib[f], { played: Date.now() / 1000 });
    control({ cmd: 'played', file: f }).catch(() => {});
    buildGroupTabs();                             // make Recently-played appear/update
  }
  favBtn.onclick = () => {
    const f = selFile; if (!f) return;
    const on = !(lib[f] && lib[f].fav);
    lib[f] = Object.assign({}, lib[f], { fav: on });
    control({ cmd: 'favorite', file: f, on: on }).catch(() => {});
    updateFavBtn(); buildGroupTabs();
  };
  // Upload a MIDI from any device (raw body, filename in the query — no multipart needed).
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []); if (!files.length) return;
    const label = uploadBtn.textContent; uploadBtn.disabled = true;
    let ok = 0, fail = 0, last = null;
    for (let i = 0; i < files.length; i++) {
      uploadBtn.textContent = 'Uploading ' + (i + 1) + '/' + files.length + '…';
      try {
        const buf = await files[i].arrayBuffer();
        const r = await fetch('/upload?name=' + encodeURIComponent(files[i].name), { method: 'POST', body: buf });
        if (!r.ok) throw 0;
        const res = await r.json();
        if (!res.file) throw 0;
        ok++; last = res.file;
      } catch (e) { fail++; }
    }
    await loadSongList();                          // refresh catalogue + library once
    const s = last && allSongs.find(x => x.file === last);
    if (s) { currentGroup = s.group; buildGroupTabs(); await selectSong(last); }
    uploadBtn.textContent = fail ? ('Added ' + ok + ', ✕' + fail + ' bad') : ('✓ Added ' + ok);
    setTimeout(() => { uploadBtn.textContent = label; }, 2500);
    uploadBtn.disabled = false; fileInput.value = '';
  };

  // Adopt the engine's authoritative snapshot (sent in the SSE 'hello' on connect / song change),
  // so a reconnecting or second client matches what the Pi is actually playing — not a default.
  function adoptHello(m) {
    currentVM = m.vm; loadedFile = m.file || null; selFile = m.file || null;
    PiTV.setSong(m.vm); buildPartOptions(m.vm); showTranspose(m.vm.transpose || 0);
    songLabel.textContent = '♪ ' + m.vm.title + ' · ' + m.vm.notes.length + ' notes';
    if (m.speed != null) speedSel.value = String(m.speed);
    if (m.mode) { modeSel.value = m.mode; mode = m.mode; }
    if (m.hand === 'R' || m.hand === 'L') handSel.value = m.hand;
    if (Array.isArray(m.play)) { currentPlay = m.play.slice(); currentHand = m.hand || null; PiTV.setPlay(currentPlay, currentHand); }
    updateModeHint();
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
      if (keep) body.play = currentPlay;
      const vm = await control(body);
      if (token !== loadSeq) return false;        // a newer load started while we awaited — drop this one
      loadedFile = file;
      currentVM = vm;
      PiTV.setSong(vm);
      if (keep) { setPlayChannels(currentPlay, currentHand); }
      else { buildPartOptions(vm); applyParts(); }
      showTranspose(vm.transpose || 0);
      clearLoop();                               // bar counts differ between songs
      if (!menu.hidden) { buildInstr(); buildLoop(); }     // refresh open menu for the new song
      const shift = vm.transpose || 0;
      const stag = shift ? ' · ' + (shift > 0 ? '+' : '') + (shift / 12) + ' oct' : '';
      songLabel.textContent = '♪ ' + vm.title + ' · ' + vm.notes.length + ' notes' + stag;
      return true;
    } catch (e) {
      songLabel.textContent = 'could not load song';
      loadedFile = null;
      return false;
    }
  }

  // Pick a song: restore its saved settings (part/speed/octave/mode) from the Pi, then load.
  async function selectSong(file) {
    const my = ++loadSeq;                               // claim this load; a newer pick invalidates us
    setPlayBtn(false);
    selFile = file;
    restoring = true;                                   // suppress auto-save during restore
    let s = {};
    try { s = await (await fetch('/settings?file=' + encodeURIComponent(file))).json(); } catch (e) {}
    if (my !== loadSeq) return;                         // a newer selectSong started during the fetch
    const has = s && Object.keys(s).length;
    if (has && s.speed) speedSel.value = s.speed;       // else: speed carries over
    transSel.value = (has && s.transpose) ? s.transpose : 'auto';   // fresh song -> auto-fit
    splitSel.value = (has && s.split) ? s.split : '60';             // fresh song -> middle C
    if (has && s.mode) modeSel.value = s.mode;
    transpose = transSel.value === 'auto' ? 'auto' : +transSel.value;
    split = +splitSel.value;
    mode = modeSel.value;
    const ok = await loadSong(file, false, my);         // builds vm with that transpose/range (same token)
    if (my !== loadSeq) return;                         // superseded while loading
    restoring = false;
    if (!ok) return;
    if (has && s.hand) handSel.value = s.hand;          // best-effort dropdown label
    if (has && s.play) setPlayChannels(s.play, partHand());   // authoritative part selection
    PiTV.setPlay(currentPlay, currentHand);
    control({ cmd: 'speed', mult: +speedSel.value }).catch(() => {});   // sync engine
    control({ cmd: 'mode', mode: mode }).catch(() => {});
    fillSongList();                                     // highlight the picked song
    if (!menu.hidden) showScreen('setup');              // advance the wizard to its per-song settings
  }

  function setPlayBtn(on) {
    playing = on;
    playBtn.innerHTML = on ? '&#9209; Stop' : '&#9654; Play';
    playBtn.classList.toggle('on', on);
  }

  /* ---- controls ---- */
  playBtn.onclick = async () => {
    if (!loadedFile && selFile) await selectSong(selFile);
    if (!loadedFile) return;
    const wantPlay = !playing;            // decide BEFORE the await — `playing` may change during it
    setPlayBtn(wantPlay);
    if (wantPlay) { markPlayed(loadedFile); endedShown = false; finish.hidden = true; }  // fresh run
    try { await control({ cmd: wantPlay ? 'play' : 'stop' }); }
    catch (e) { setPlayBtn(!wantPlay); }  // revert if the request failed
  };
  resetBtn.onclick = async () => {
    setPlayBtn(false);
    try { await control({ cmd: 'reset' }); } catch (e) {}
  };
  handSel.onchange = () => applyParts();
  modeSel.onchange = async () => {
    mode = modeSel.value;
    updateModeHint();
    PiTV.setPlay(currentPlay, currentHand);
    saveCurrent();
    try { await control({ cmd: 'mode', mode: mode }); } catch (e) {}
  };

  /* ---- instruments: one sound chooser per part (built into the Tracks menu section) ---- */
  const COMMON = [0, 1, 4, 6, 11, 12, 16, 19, 21, 24, 25, 27, 30, 32, 33, 40, 42, 48, 52, 56, 60, 65, 71, 73, 75, 80, 81, 89];
  function buildInstr() {
    instrPanel.innerHTML = '';
    const parts = (currentVM && currentVM.parts) || [];
    if (!parts.length) {
      const e = document.createElement('div'); e.className = 'hint'; e.textContent = 'Load a song first.';
      instrPanel.appendChild(e); return;
    }
    const playCbs = [];
    const gatherPlay = () => { setPlayChannels(playCbs.filter(o => o.cb.checked).map(o => o.ch), null); saveCurrent(); };
    parts.forEach(p => {
      const row = document.createElement('div'); row.className = 'row';
      const isDrum = p.ch === 9;
      const r = currentVM.rightChan, l = currentVM.leftChan;
      const nm = document.createElement('span'); nm.className = 'nm';
      nm.textContent = isDrum ? 'Drums'
        : (r !== l && p.ch === r) ? 'Right hand'
        : (r !== l && p.ch === l) ? 'Left hand'
        : (GM_NAMES[p.program] || ('Part ' + p.ch));
      row.appendChild(nm);
      if (!isDrum) {                                    // you can't play GM drums on a piano
        const plab = document.createElement('label');
        const pcb = document.createElement('input'); pcb.type = 'checkbox';
        pcb.checked = currentPlay.includes(p.ch);
        pcb.onchange = gatherPlay;
        playCbs.push({ ch: p.ch, cb: pcb });
        plab.appendChild(pcb); plab.appendChild(document.createTextNode('play'));
        row.appendChild(plab);
      }
      if (!isDrum) {                                    // GM drums (ch10) ignore program -> mute only
        const sel = document.createElement('select');
        const opts = COMMON.includes(p.program) ? COMMON : [p.program].concat(COMMON);
        opts.forEach(prog => {
          const o = document.createElement('option'); o.value = prog; o.textContent = GM_NAMES[prog] || ('Program ' + prog);
          if (prog === p.program) o.selected = true;
          sel.appendChild(o);
        });
        sel.onchange = () => { control({ cmd: 'part', ch: p.ch, program: +sel.value }).catch(() => {}); };
        row.appendChild(sel);
      }
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.onchange = () => { control({ cmd: 'part', ch: p.ch, mute: cb.checked }).catch(() => {}); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode('mute'));
      row.appendChild(lab);
      instrPanel.appendChild(row);
    });
    const hint2 = document.createElement('div'); hint2.className = 'hint';
    hint2.textContent = 'play = you play it (shown). off = background (heard, hidden). mute = silent.';
    instrPanel.appendChild(hint2);
  }
  /* ---- loop a bar range (practise a hard passage) ---- */
  let loopOn = false, loopFromEl = null, loopToEl = null, loopToggleEl = null;
  function barCount() { const b = currentVM && currentVM.bars; return (b && b.length) ? b.length - 1 : 0; }
  function clampBar(n) { const m = barCount(); return Math.max(1, Math.min(m || 1, Math.round(n) || 1)); }
  function barStart(n) { const b = currentVM.bars; return b[clampBar(n) - 1]; }
  function barEnd(n) { const b = currentVM.bars, i = Math.min(clampBar(n), b.length - 1); return Math.min(b[i] != null ? b[i] : currentVM.duration, currentVM.duration); }
  function applyLoop() {
    if (!currentVM || !loopOn) { control({ cmd: 'loop', start: null, end: null }).catch(() => {}); PiTV.setLoop(null, null); return; }
    let from = clampBar(+loopFromEl.value), to = clampBar(+loopToEl.value);
    if (to < from) { to = from; loopToEl.value = to; }
    loopFromEl.value = from;
    const start = barStart(from), end = barEnd(to);
    control({ cmd: 'loop', start, end }).catch(() => {});
    PiTV.setLoop(start, end);
  }
  function clearLoop() { loopOn = false; if (loopToggleEl) loopToggleEl.classList.remove('on'); control({ cmd: 'loop', start: null, end: null }).catch(() => {}); PiTV.setLoop(null, null); }
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
    if (!currentVM) return;
    const r = seekEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    control({ cmd: 'seek', t: frac * currentVM.duration }).catch(() => {});
  };
  let view = 'notation';
  viewBtn.textContent = 'View: Notation';
  viewBtn.onclick = () => {
    view = view === 'game' ? 'notation' : 'game';
    PiTV.setView(view);
    viewBtn.textContent = 'View: ' + (view === 'game' ? 'Game' : 'Notation');
  };
  let names = localStorage.getItem('pitv.names') !== 'off';     // default on
  function applyNames() { PiTV.setNames(names); namesBtn.textContent = 'Names: ' + (names ? 'on' : 'off'); namesBtn.classList.toggle('on', names); }
  applyNames();
  namesBtn.onclick = () => { names = !names; localStorage.setItem('pitv.names', names ? 'on' : 'off'); applyNames(); };

  /* Sound is the Pi's job (FluidSynth -> HDMI / headphone jack), for every mode. The web app
     is display + remote only; it makes no sound, so there's no in-browser synth here. */

  // Timing feedback: running tallies + an instant per-note flash (early / good / late).
  let timingTally = null, flashing = false, flashTimer = null;
  function showTiming() {
    const t = timingTally;
    if (!t || !t.on) { scoreEl.textContent = 'Timing: —'; scoreEl.className = 'badge'; return; }
    if (!(t.good + t.late + t.early + t.miss)) { scoreEl.textContent = 'Timing: ready'; scoreEl.className = 'badge'; return; }
    scoreEl.textContent = '🎯 ' + t.good + ' good · ' + t.late + ' late · ' + t.early + ' early' + (t.miss ? ' · ' + t.miss + ' miss' : '');
    scoreEl.className = 'badge';
  }
  function flashRating(kind, off) {
    const label = { early: 'EARLY', good: 'GOOD!', late: 'LATE', miss: 'MISS' }[kind] || kind;
    const cls = { early: 'r-early', good: 'good', late: 'low', miss: 'low' }[kind] || '';
    const ms = (off != null && kind !== 'good') ? ' ' + (off > 0 ? '+' : '') + Math.round(off * 1000) + 'ms' : '';
    scoreEl.textContent = label + ms;
    scoreEl.className = 'badge ' + cls;
    flashing = true; clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashing = false; showTiming(); }, 700);
  }

  /* ---- end-of-song celebration (reward loop) ---- */
  let endedShown = false;
  function bestKey(f) { return 'pitv.best.' + f; }
  function celebrate() {
    const t = timingTally || {};
    const tot = (t.good || 0) + (t.late || 0) + (t.early || 0) + (t.miss || 0);
    const ratio = tot ? (t.good || 0) / tot : 1;          // Listen / no gates -> full marks
    const stars = tot === 0 ? 3 : ratio >= 0.85 ? 3 : ratio >= 0.55 ? 2 : 1;
    finStars.textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
    finSub.textContent = tot
      ? (t.good + ' good · ' + t.late + ' late · ' + t.early + ' early' + (t.miss ? ' · ' + t.miss + ' missed' : ''))
      : 'Nice listening!';
    if (loadedFile) {
      const prev = +(localStorage.getItem(bestKey(loadedFile)) || 0);
      if (stars > prev) localStorage.setItem(bestKey(loadedFile), stars);
    }
    finish.hidden = false;
    if (kbd) setTimeout(() => focusAt(finAgain), 0);
  }
  finAgain.onclick = async () => { finish.hidden = true; endedShown = false; try { await control({ cmd: 'reset' }); } catch (e) {} playBtn.click(); };
  finPick.onclick = () => { finish.hidden = true; endedShown = false; menu.hidden = false; showScreen('songs'); };

  /* ---- D-pad / keyboard navigation (TV remote: arrows + Enter + Back) ---- */
  let kbd = false;                                        // true once the user drives by keys -> show focus ring
  function vis(el) { return el && el.offsetParent !== null && !el.disabled; }
  function navCols() {
    if (!finish.hidden) return [[finAgain, finPick].filter(vis)];
    if (menu.hidden) return [[playBtn, resetBtn, viewBtn, menuBtn, seekEl].filter(vis)];
    const sc = $(SCREENS[screen]);
    if (screen === 'songs') {                             // two columns: category tabs | song list (+ upload)
      const tabs = Array.from(groupTabs.querySelectorAll('.gtab')).filter(vis);
      const items = Array.from(songList.querySelectorAll('.songitem')).filter(vis).concat([uploadBtn].filter(vis));
      return [tabs, items];
    }
    return [Array.from(sc.querySelectorAll('button, select, summary, .songitem')).filter(vis)];
  }
  function focusAt(el) {
    if (!el) return;
    document.querySelectorAll('.nav-here').forEach(e => e.classList.remove('nav-here'));
    try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
    if (kbd) el.classList.add('nav-here');
  }
  function focusFirst() { const c = navCols(); if (c.length && c[0].length) focusAt(c[0][0]); }
  function navMove(dRow, dCol) {
    const cols = navCols(); if (!cols.length) return;
    const cur = document.activeElement;
    let ci = cols.findIndex(c => c.indexOf(cur) >= 0);
    if (ci < 0) { focusFirst(); return; }
    let ri = cols[ci].indexOf(cur);
    if (dCol) { ci = Math.max(0, Math.min(cols.length - 1, ci + dCol)); ri = Math.min(Math.max(ri, 0), cols[ci].length - 1); }
    if (dRow) { ri = Math.max(0, Math.min(cols[ci].length - 1, ri + dRow)); }
    focusAt(cols[ci][ri]);
  }
  function seekBy(dir) {
    if (!currentVM) return;
    const step = Math.max(1, currentVM.duration * 0.02);
    control({ cmd: 'seek', t: Math.max(0, Math.min(currentVM.duration, lastT + dir * step)) }).catch(() => {});
  }
  document.addEventListener('pointerdown', () => { kbd = false; document.querySelectorAll('.nav-here').forEach(e => e.classList.remove('nav-here')); });
  document.addEventListener('keydown', e => {
    const k = e.key, ae = document.activeElement, tag = (ae && ae.tagName) || '';
    if (tag === 'INPUT') return;                          // let text/number inputs (loop bars) use keys natively
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (tag === 'SELECT') {                             // remote: left/right adjust the focused setting
        const d = k === 'ArrowRight' ? 1 : -1, ni = ae.selectedIndex + d;
        if (ni >= 0 && ni < ae.options.length) { ae.selectedIndex = ni; ae.dispatchEvent(new Event('change')); }
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
        if (ae && tag !== 'SELECT' && ae.click) { ae.click(); e.preventDefault(); }
        break;
      case 'Backspace': case 'Escape':
        kbd = true;
        if (!finish.hidden) { /* leave celebration via its buttons */ }
        else if (!menu.hidden) { if (screen === 'home') { if (loadedFile) closeMenu(); } else menuBack.onclick(); }
        else openMenu();
        e.preventDefault(); break;
      case ' ': case 'Spacebar':
        if (menu.hidden && finish.hidden) { playBtn.click(); e.preventDefault(); }
        break;
    }
  });

  /* ---- SSE: live keyboard notes + streamed play-position ---- */
  (function connect() {
    const es = new EventSource('/events');
    es.onopen = () => { statusEl.className = 'dot ok'; statusEl.title = 'connected'; };
    es.onerror = () => { statusEl.className = 'dot err'; statusEl.title = 'reconnecting…'; };
    let lastPct = -1, lastTallyKey = '';
    es.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'pos' || m.type === 'hello') {
        // Adopt the engine's authoritative state on (re)connect, or when another client switched songs.
        const newSong = m.vm && (!currentVM || m.file !== loadedFile);
        if (m.type === 'hello' && newSong) {
          adoptHello(m);
          setPlayBtn(!!m.playing);
          if (m.playing) closeMenu();        // resynced to a playing song -> show the stage
          else if (!menu.hidden && screen === 'home') showScreen('setup');   // idle -> its setup (don't interrupt nav)
        } else if (m.type === 'pos' && m.file && loadedFile && m.file !== loadedFile) {
          es.close(); setTimeout(connect, 60); return;    // stale view: reconnect for a clean hello snapshot
        }
        lastT = m.t;
        PiTV.setPos(m.t, m.waiting, m.wanted);
        // visual count-in: 3-2-1 during the pre-roll (negative play time)
        if (playing && m.t < 0) { const n = Math.min(3, Math.ceil(-m.t)); countin.firstChild.textContent = n > 0 ? n : ''; countin.hidden = n <= 0; }
        else if (!countin.hidden) countin.hidden = true;
        const d = currentVM ? currentVM.duration : 0;
        const pct = d > 0 ? Math.max(0, Math.min(100, m.t / d * 100)) : 0;
        if (Math.abs(pct - lastPct) >= 0.2) { seekFill.style.width = pct + '%'; seekEl.setAttribute('aria-valuenow', Math.round(pct)); lastPct = pct; }
        timingTally = m.timing;
        const tk = m.timing ? (m.timing.good + ',' + m.timing.late + ',' + m.timing.early + ',' + m.timing.miss + ',' + m.timing.on) : '';
        if (!flashing && tk !== lastTallyKey) { showTiming(); lastTallyKey = tk; }   // only repaint when it changes
        if (m.ended) {                       // song finished on its own (one-shot, never flips back)
          setPlayBtn(false); countin.hidden = true;
          if (!endedShown) { endedShown = true; celebrate(); }
        }
      } else if (m.type === 'rating') {
        flashRating(m.kind, m.off);         // instant early/good/late feedback per chord
      } else if (m.type === 'noteon') {
        PiTV.highlight(m.note, true); PiTV.setPlayed(m.note, true);   // light the key + show it on the staff
      } else if (m.type === 'noteoff') {
        PiTV.highlight(m.note, false); PiTV.setPlayed(m.note, false);
      }
    };
  })();

  loadSongList();
  openMenu();          // start on the menu/home screen
})();
