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
  function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  const statusEl = $('status'),
        backBtn = $('quitStage'), playBtn = $('play'), resetBtn = $('reset'),
        viewBtn = $('view'), songLabel = $('song'),
        handSel = $('handSel'), modeSel = $('modeSel'), instrPanel = $('instrPanel'),
        speedSel = $('speedSel'), kbdSel = $('kbdSel'), transSel = $('transSel'),
        loopPanel = $('loopPanel'), scoreEl = $('score'), timeEl = $('time'),
        seekEl = $('seek'), seekFill = $('seekfill'), namesBtn = $('names'),
        stage = $('stage'), menu = $('menu'), startBtn = $('startBtn'),
        favBtn = $('fav'), uploadBtn = $('uploadBtn'), fileInput = $('fileInput'), splitSel = $('splitSel'),
        menuBack = $('menuBack'), menuSettings = $('menuSettings'), menuTitle = $('menuTitle'), groupTabs = $('groupTabs'), songList = $('songList'),
        libTitle = $('libTitle'), libSub = $('libSub'),
        splitField = $('splitField'), modeHint = $('modeHint'),
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
        buildInstr(); buildLoop(); fillSetupHead(); updateModeHint();
        const oneTrack = !!(currentVM && currentVM.rightChan != null && currentVM.rightChan === currentVM.leftChan);
        splitField.style.display = oneTrack ? '' : 'none';
      }
      menuTitle.textContent = TITLES[name] || '';
      menuBack.hidden = (name === 'home');          // Home is the root — nothing above it
      menuSettings.hidden = (name === 'home' || name === 'settings');
    } else {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));   // canvas was display:none
    }
    if (kbd) setTimeout(focusFirst, 0);
  }
  menuBack.onclick = () => go(PARENT[view] || 'home');
  menuSettings.onclick = () => go('settings');
  $('homeStart').onclick = () => go('library');
  $('homeSettings').onclick = () => go('settings');
  startBtn.onclick = () => { if (!playing) playBtn.click(); };   // "Play now" -> playBtn takes us to the Stage

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
  PiTV.enableClock();                              // render runs its own clock; pos frames only correct it

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
    PiTV.setClock(playing, +speedSel.value);
    control({ cmd: 'speed', mult: +speedSel.value }).catch(() => {});
    saveCurrent();
  };

  // ---- which part(s) the player covers: Part dropdown -> MIDI channels (+ hand for 1-track) ----
  function partChannels() {
    const vm = currentVM; if (!vm) return [];
    const v = handSel.value;
    if (v === 'R') return vm.rightChan != null ? [vm.rightChan] : [];
    if (v === 'L') return vm.leftChan != null ? [vm.leftChan] : [];
    if (v === 'drums') return [9];                        // play the drum kit (-> percussion staff)
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
    const hasPiano = (r != null || l != null);
    const hasDrums = (vm.parts || []).some(p => p.ch === 9);
    if (hasPiano) { add('both', 'Both hands'); add('R', 'Right hand'); add('L', 'Left hand'); }
    if (hasDrums) add('drums', 'Drums');                  // play the kit -> drum notation
    (vm.parts || []).forEach(p => {                       // any other instrument you could play
      if (p.ch === 9 || p.ch === r || p.ch === l) return; // drums / piano part already covered
      add('ch:' + p.ch, 'Play: ' + (GM_NAMES[p.program] || ('Part ' + p.ch)));
    });
    if (!handSel.options.length) add('both', 'All');
    handSel.value = hasPiano ? 'both' : (hasDrums ? 'drums' : handSel.options[0].value);   // drum-only -> Drums
  }
  // Set which part the player covers (channels + optional hand); the rest becomes background.
  function setPlayChannels(ch, hand) {
    currentPlay = ch.slice(); currentHand = hand || null;
    PiTV.setPlay(ch, currentHand);            // show only your chosen part (Listen plays the rest for sound)
    control({ cmd: 'play_parts', channels: ch, hand: currentHand }).catch(() => {});
  }
  function applyParts() {
    setPlayChannels(partChannels(), partHand());
    if (view === 'setup') buildInstr();                   // keep the Setup Play boxes in sync
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
  // Two-level rail: groups roll up into collapsible categories (Drums / Piano / More).
  const CATS = ['Drums', 'Piano', 'More'];
  function catOf(g) {
    if (/^Drums\b/.test(g)) return 'Drums';
    if (/^(Game|Popular|Uploads)\b/.test(g)) return 'More';
    return 'Piano';                          // piano-first app: course, lessons, my songs all live here
  }
  function subLabel(g) { return g.replace(/^(Drums|Piano)\s*-\s*/, ''); }   // hide the category prefix
  let collapsedCats = new Set((localStorage.getItem('pitv.collapsed') || '').split(',').filter(Boolean));
  function toggleCat(c) {
    collapsedCats.has(c) ? collapsedCats.delete(c) : collapsedCats.add(c);
    localStorage.setItem('pitv.collapsed', [...collapsedCats].join(','));
    buildGroupTabs();
  }
  function songsForGroup(g) {
    if (g === FAV) return favList();
    if (g === RECENT) return recentList();
    return songsByGroup[g] || [];
  }
  // --- components (DRY view builders) ---
  function gtab(g, sub) {
    return h('button', { class: 'gtab' + (sub ? ' sub' : '') + (g === currentGroup ? ' on' : ''), tabIndex: 0,
      onclick: () => { currentGroup = g; buildGroupTabs(); } },
      h('span', null, subLabel(g)), h('span', { class: 'count' }, String(songsForGroup(g).length)));
  }
  // Inline SVG (currentColor) so it renders on the Pi's Chromium, which has no emoji font.
  const CAT_ICON = {
    Drums: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="17" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="7.5" cy="5" r="1.7" fill="currentColor" stroke="none"/><line x1="16.4" y1="6.4" x2="5" y2="20"/><line x1="8.1" y1="6.4" x2="19" y2="20"/></svg>',
    Piano: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="7.3" y="5" width="3" height="6.5" rx="0.5" fill="currentColor" stroke="none"/><rect x="13.7" y="5" width="3" height="6.5" rx="0.5" fill="currentColor" stroke="none"/></svg>',
    More: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6.5" cy="17.5" r="2.4" fill="currentColor" stroke="none"/><circle cx="16.5" cy="15.5" r="2.4" fill="currentColor" stroke="none"/><path d="M8.9 17.5V6.5l9.6-2v11"/></svg>',
  };
  function gcat(c, count) {
    const open = !collapsedCats.has(c);
    return h('button', { class: 'gcat' + (open ? ' open' : ''), tabIndex: 0, onclick: () => toggleCat(c) },
      h('span', { class: 'chev' }, open ? '▾' : '▸'),
      h('span', { class: 'cicon', html: CAT_ICON[c] || '' }),
      h('span', { class: 'gcat-name' }, c),
      h('span', { class: 'count' }, String(count)));
  }
  function coverGlyph(s) { const t = (s.title || '').trim(); return t ? t[0].toUpperCase() : '♫'; }
  // Derive a stable hue per title so the grid has rhythm instead of a wall of identical tiles.
  function coverBg(title) {
    let hsh = 0; const t = title || '';
    for (let i = 0; i < t.length; i++) hsh = (hsh * 31 + t.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg, hsl(' + hsh + ' 58% 52%), hsl(' + ((hsh + 42) % 360) + ' 56% 38%))';
  }
  function songItem(s) {
    const meta = [];
    if (lib[s.file] && lib[s.file].fav) meta.push(h('span', { class: 'si-fav' }, '★'));
    const best = (lib[s.file] && lib[s.file].best) || 0;
    if (best) meta.push(h('span', { class: 'si-stars' }, '★'.repeat(best)));
    meta.push(h('span', null, s.group));
    return h('li', { class: 'songitem' + (s.file === selFile ? ' on' : ''), tabIndex: 0,
      onclick: () => selectSong(s.file) },
      h('span', { class: 'cover', style: 'background:' + coverBg(s.title) }, coverGlyph(s)),
      h('span', { class: 'si-main' },
        h('div', { class: 'si-title' }, s.title),
        h('div', { class: 'si-meta' }, ...meta)));
  }
  // Left rail: one tab per category. Selecting a tab repaints the song list.
  function buildGroupTabs() {
    const real = Object.keys(songsByGroup);
    const virtual = [];
    if (recentList().length) virtual.push(RECENT);
    if (favList().length) virtual.push(FAV);
    const all = virtual.concat(real);
    if (!currentGroup || !all.includes(currentGroup)) currentGroup = all[0] || null;
    if (currentGroup && !virtual.includes(currentGroup)) collapsedCats.delete(catOf(currentGroup));  // keep the selection visible
    groupTabs.innerHTML = '';
    virtual.forEach(g => groupTabs.append(gtab(g)));               // Favourites / Recently — uncategorised, on top
    for (const c of CATS) {
      const groups = real.filter(g => catOf(g) === c);
      if (!groups.length) continue;
      groupTabs.append(gcat(c, groups.reduce((n, g) => n + songsForGroup(g).length, 0)));
      if (!collapsedCats.has(c)) groups.forEach(g => groupTabs.append(gtab(g, true)));
    }
    fillSongList();
  }
  // Right pane: the songs in the chosen category. Clicking one loads it and goes to Setup.
  function fillSongList() {
    songList.innerHTML = '';
    const songs = songsForGroup(currentGroup);
    libTitle.textContent = currentGroup || 'Songs';
    libSub.textContent = songs.length ? (songs.length + (songs.length === 1 ? ' song' : ' songs')) : '';
    if (!songs.length) {
      songList.append(h('li', { class: 'hint empty', tabIndex: 0, onclick: () => uploadBtn.click() },
        'No songs yet — press here to upload MIDI files.'));
      return;
    }
    songs.forEach(s => songList.append(songItem(s)));
  }
  function fillSetupHead() {
    if (!currentVM) return;
    $('setupTitle').textContent = currentVM.title || '—';
    const cv = document.querySelector('.setup-hero .cover');
    if (cv) { cv.textContent = coverGlyph(currentVM); cv.style.background = coverBg(currentVM.title); }
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
    if (m.speed != null) { speedSel.value = String(m.speed); PiTV.setClock(m.playing, m.speed); }
    if (m.mode) { modeSel.value = m.mode; mode = m.mode; }
    PiTV.setFreezeMode(mode === 'follow');
    if (m.hand === 'R' || m.hand === 'L') handSel.value = m.hand;
    if (Array.isArray(m.play)) { currentPlay = m.play.slice(); currentHand = m.hand || null; PiTV.setPlay(currentPlay, currentHand); }
    if (typeof m.pi_muted === 'boolean') setPiMuteBtn(m.pi_muted);   // reflect the engine's real mute state
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
      if (view === 'setup') { buildInstr(); buildLoop(); }   // refresh Setup for the new song
      const shift = vm.transpose || 0;
      const stag = shift ? ' · ' + (shift > 0 ? '+' : '') + (shift / 12) + ' oct' : '';
      songLabel.textContent = '♪ ' + vm.title + ' · ' + vm.notes.length + ' notes' + stag;
      if (soundOn) soundResync();                  // new song -> reload instruments + re-aim the scheduler
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
    PiTV.setFreezeMode(mode === 'follow');
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
    if (view !== 'stage') go('setup');                  // picking a song advances to its Setup
  }

  function setPlayBtn(on) {
    playing = on;
    playBtn.innerHTML = on ? '&#10073;&#10073; Pause' : '&#9654; Play';   // it pauses (opens the pause menu), so say so
    playBtn.classList.toggle('on', on);
    if (!on) { countin.hidden = true; if (countin.firstChild) countin.firstChild.textContent = ''; }  // every stop path clears the 3-2-1
    if (typeof soundOn !== 'undefined' && soundOn) { on ? startSoundTimer() : stopSoundTimer(); }      // scheduler runs only while playing
  }

  /* ---- controls ---- */
  playBtn.onclick = async () => {
    if (!loadedFile && selFile) await selectSong(selFile);
    if (!loadedFile) return;
    const wantPlay = !playing;            // decide BEFORE the await — `playing` may change during it
    setPlayBtn(wantPlay);
    PiTV.setClock(wantPlay, +speedSel.value);   // optimistic: pause/play feels instant locally
    if (wantPlay) { markPlayed(loadedFile); endedShown = false; finish.hidden = true; closePause(); go('stage'); }  // fresh run
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
  handSel.onchange = () => applyParts();
  modeSel.onchange = async () => {
    mode = modeSel.value;
    PiTV.setFreezeMode(mode === 'follow');   // only Follow freezes the local clock at gates
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
      const vol = document.createElement('input');                 // per-instrument volume (CC7)
      vol.type = 'range'; vol.min = 0; vol.max = 127; vol.value = 100; vol.className = 'vol'; vol.title = 'Volume';
      vol.oninput = () => { control({ cmd: 'part', ch: p.ch, volume: +vol.value }).catch(() => {}); };
      row.appendChild(vol);
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

  /* ---- browser sound (optional; for a device that can't hear the Pi): a pluggable synth fed from
     the local clock + your live keys. Two engines: 'rich' = WebAudioFont (real sampled instruments,
     loaded on demand, Songsterr-style) and 'light' = WebAudioTinySynth (oscillator — tiny + CPU-cheap,
     for weak devices). The Pi stays the real instrument; this is just a local speaker. Backing is
     scheduled from the view-model and held at the next gate in Follow. ---- */
  const sndHere = $('sndHere'), piMute = $('piMute'), sndRow = $('sndRow'), muteRow = $('muteRow'),
        sndQual = $('sndQual'), sndQualRow = $('sndQualRow');
  let soundOn = false, schedTimer = null, schedPtr = 0, piMuted = false, soundLastT = 0, audioCtx = null;
  let engineKind = localStorage.getItem('pitv.sndEngine') || 'rich';
  let engine = null;
  const SND_LOOKAHEAD = 0.2;
  function isMine(nt) {                                 // notes YOU cover -> sonified live, not scheduled
    if (mode === 'listen' || !currentPlay.includes(nt.ch)) return false;
    if (currentHand && nt.hand !== currentHand) return false;
    const [lo, hi] = kbdRange(); return nt.n >= lo && nt.n <= hi;
  }
  function firstNoteAtOrAfter(t) {
    const ns = (currentVM && currentVM.notes) || []; let lo = 0, hi = ns.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ns[m].t < t) lo = m + 1; else hi = m; } return lo;
  }
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

  // Pluggable browser synth: two engines share ONE contract behind a SoundEngine base class —
  // the same base/subclass shape as the NotationView staff hierarchy in render.js.
  class SoundEngine {
    constructor() { this.loading = null; }
    async ensure() {}                                    // load lib + open audio context + set programs
    programs() {}                                        // (pre)load the instruments this song needs
    now() { return audioCtx ? audioCtx.currentTime : 0; }
    schedule(ch, n, v, at, dur) {}                       // queue a backing note at audio-time `at`
    live(note, on, vel) {}                               // a key you pressed, right now
    reset() {}                                           // drop everything queued/held
  }

  // Light — WebAudioTinySynth (oscillator GM, single 62KB file, very CPU-cheap).
  class LightEngine extends SoundEngine {
    constructor() { super(); this.synth = null; }
    async ensure() {
      if (!window.WebAudioTinySynth) { this.loading = this.loading || loadScript('vendor/webaudio-tinysynth.js'); await this.loading; }
      if (!this.synth) this.synth = new WebAudioTinySynth({ quality: 1, useReverb: 1, voices: 64 });
      audioCtx = this.synth.getAudioContext();
      if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
      this.programs();
    }
    programs() {
      if (!this.synth || !currentVM) return;
      (currentVM.parts || []).forEach(p => { try { this.synth.setProgram(p.ch, p.program || 0); } catch (e) {} });
      try { this.synth.setProgram(0, 0); } catch (e) {}     // live keys = grand piano on ch0
    }
    now() { return this.synth.getAudioContext().currentTime; }
    schedule(ch, n, v, at, dur) { this.synth.noteOn(ch, n, v, at); this.synth.noteOff(ch, n, at + dur); }
    live(note, on, vel) { if (on) this.synth.noteOn(0, note, vel || 96, 0); else this.synth.noteOff(0, note, 0); }
    reset() { try { this.synth.reset(); } catch (e) {} }
  }

  // Rich — WebAudioFont: real sampled instruments, served from the Pi (web/waf/), loaded on demand.
  const WAF_BASE = '/waf/';
  class RichEngine extends SoundEngine {
    constructor() { super(); this.player = null; this.ch = {}; this.drums = {}; this.env = {}; }
    async ensure() {
      if (!window.WebAudioFontPlayer) { this.loading = this.loading || loadScript('vendor/WebAudioFontPlayer.js'); await this.loading; }
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (!this.player) this.player = new WebAudioFontPlayer();
      await this.programs();
    }
    _src(info) { return WAF_BASE + info.url.split('/').pop(); }
    _load(info) {
      const v = info.variable;
      if (window[v]) return Promise.resolve(window[v]);
      return new Promise(res => { this.player.loader.startLoad(audioCtx, this._src(info), v); this.player.loader.waitLoad(() => res(window[v] || null)); });
    }
    async programs() {                                   // preload the instruments THIS song uses
      if (!this.player || !currentVM) return;
      this.ch = {};
      const L = this.player.loader, jobs = [];
      jobs.push(this._load(L.instrumentInfo(L.findInstrument(0))).then(p => { this.ch[0] = p; }));   // live keys
      (currentVM.parts || []).forEach(part => {
        if (part.ch === 9) return;                       // drums handled per-note below
        jobs.push(this._load(L.instrumentInfo(L.findInstrument(part.program || 0))).then(p => { this.ch[part.ch] = p; }));
      });
      await Promise.all(jobs).catch(() => {});
    }
    now() { return audioCtx.currentTime; }
    schedule(ch, n, v, at, dur) {
      try {
        if (ch === 9) {                                  // percussion: one sample per drum note
          const L = this.player.loader, di = L.findDrum(n); if (di < 0) return;
          const info = L.drumInfo(di), preset = window[info.variable] || this.drums[n];
          if (!preset) { this._load(info).then(p => { this.drums[n] = p; }); return; }   // first hit loads (silent), then ready
          this.player.queueWaveTable(audioCtx, audioCtx.destination, preset, at, info.pitch, dur, v / 127);
        } else {
          const preset = this.ch[ch]; if (!preset) return;
          this.player.queueWaveTable(audioCtx, audioCtx.destination, preset, at, n, dur, v / 127);
        }
      } catch (e) {}
    }
    live(note, on, vel) {
      try {
        const preset = this.ch[0]; if (!preset) return;
        if (on) { if (this.env[note]) this.env[note].cancel(); this.env[note] = this.player.queueWaveTable(audioCtx, audioCtx.destination, preset, audioCtx.currentTime, note, 9999, (vel || 96) / 127); }
        else if (this.env[note]) { try { this.env[note].cancel(); } catch (e) {} delete this.env[note]; }
      } catch (e) {}
    }
    reset() { try { this.player.cancelQueue(audioCtx); } catch (e) {} this.env = {}; }
  }

  const lightEngine = new LightEngine(), richEngine = new RichEngine();
  function pickEngine() { return engineKind === 'light' ? lightEngine : richEngine; }
  async function ensureSound() { engine = pickEngine(); await engine.ensure(); }
  function schedTick() {                                // schedule backing a hair ahead of the clock
    if (!soundOn || !engine || !currentVM) return;
    const st = PiTV.clockState(); if (!st.playing) return;
    const audioNow = engine.now(), ns = currentVM.notes;
    while (schedPtr < ns.length) {
      const nt = ns[schedPtr];
      if (nt.t >= st.limit) break;                      // hold backing at the next gate (Follow)
      if (nt.t > st.t + SND_LOOKAHEAD) break;           // beyond the lookahead window
      schedPtr++;
      if (nt.t < st.t - 0.1 || isMine(nt)) continue;     // already past, or you play it live
      const at = audioNow + Math.max(0, (nt.t - st.t) / st.speed);
      engine.schedule(nt.ch, nt.n, nt.v || 80, at, Math.max(0.05, nt.d / st.speed));
    }
  }
  function soundResync() {                              // after seek / loop / song change: drop + re-aim
    if (!soundOn || !engine) return;
    engine.reset(); engine.programs(); schedPtr = firstNoteAtOrAfter(PiTV.clockState().t);
  }
  function liveSound(note, on, vel) { if (soundOn && engine) engine.live(note, on, vel); }   // your pressed keys
  function startSoundTimer() { if (soundOn && !schedTimer) schedTimer = setInterval(schedTick, 60); }
  function stopSoundTimer() { if (schedTimer) { clearInterval(schedTimer); schedTimer = null; } }
  sndRow.hidden = false; muteRow.hidden = false; if (sndQualRow) sndQualRow.hidden = false;
  sndHere.onclick = async () => {
    if (!soundOn) {
      sndHere.innerHTML = '&#8987; …';
      try { await ensureSound(); } catch (e) { sndHere.innerHTML = 'sound load failed'; return; }
      soundOn = true; sndHere.classList.add('on'); sndHere.innerHTML = '&#128266; On';
      schedPtr = firstNoteAtOrAfter(PiTV.clockState().t);
      if (PiTV.clockState().playing) startSoundTimer();   // idle? don't burn CPU — armed on next Play
    } else {
      soundOn = false; sndHere.classList.remove('on'); sndHere.innerHTML = '&#128266; Off';
      stopSoundTimer(); if (engine) engine.reset();
    }
  };
  if (sndQual) {
    sndQual.value = engineKind;
    sndQual.onchange = async () => {                    // hot-swap engine; keep playing if sound is on
      engineKind = sndQual.value; localStorage.setItem('pitv.sndEngine', engineKind);
      if (soundOn) { if (engine) engine.reset(); try { await ensureSound(); schedPtr = firstNoteAtOrAfter(PiTV.clockState().t); } catch (e) {} }
    };
  }
  function setPiMuteBtn(on) {
    piMuted = on;
    piMute.classList.toggle('on', piMuted);
    piMute.innerHTML = piMuted ? '&#128263; Pi muted' : '&#128264; Mute Pi';
  }
  piMute.onclick = () => { setPiMuteBtn(!piMuted); control({ cmd: 'pi_mute', on: piMuted }).catch(() => {}); };

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
  function flashRating(kind, off, note) {
    if (kind === 'wrong' && note != null) PiTV.flashWrong(note);   // flash the mis-pressed key red on the piano
    const label = { early: 'EARLY', good: 'GOOD!', late: 'LATE', miss: 'MISS', wrong: 'WRONG' }[kind] || kind;
    const cls = { early: 'r-early', good: 'good', late: 'low', miss: 'r-miss', wrong: 'r-miss' }[kind] || '';
    const ms = (off != null && kind !== 'good' && kind !== 'wrong') ? ' ' + (off > 0 ? '+' : '') + Math.round(off * 1000) + 'ms' : '';
    scoreEl.textContent = label + ms;
    scoreEl.className = 'badge ' + cls;
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
      if (kbd) setTimeout(() => focusAt(finAgain), 0);
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
    if (loadedFile) {                               // best lives on the Pi so it follows the song to any client
      const prev = (lib[loadedFile] && lib[loadedFile].best) || 0;
      if (stars > prev) {
        lib[loadedFile] = Object.assign({}, lib[loadedFile], { best: stars });
        control({ cmd: 'save_settings', file: loadedFile, settings: { best: stars } }).catch(() => {});
      }
    }
    finish.hidden = false;
    if (kbd) setTimeout(() => focusAt(finAgain), 0);
  }
  finAgain.onclick = async () => { finish.hidden = true; endedShown = false; try { await control({ cmd: 'reset' }); } catch (e) {} playBtn.click(); };
  finPick.onclick = () => { finish.hidden = true; endedShown = false; go('library'); };

  /* ---- pause screen (manual stop): quick no-reload tweaks + resume / restart / quit ---- */
  function openPause() {
    if (!loadedFile) return;
    pMode.innerHTML = modeSel.innerHTML; pMode.value = modeSel.value;       // mirror the live (no-reload) controls
    pSpeed.innerHTML = speedSel.innerHTML; pSpeed.value = speedSel.value;
    pHand.innerHTML = handSel.innerHTML; pHand.value = handSel.value;
    pauseEl.hidden = false;
    if (kbd) setTimeout(() => focusAt(pResume), 0);
  }
  function closePause() { pauseEl.hidden = true; }
  pMode.onchange = () => { modeSel.value = pMode.value; modeSel.onchange(); };   // drive the real controls
  pSpeed.onchange = () => { speedSel.value = pSpeed.value; speedSel.onchange(); };
  pHand.onchange = () => { handSel.value = pHand.value; handSel.onchange(); };
  pResume.onclick = () => { closePause(); if (!playing) playBtn.click(); };
  pRestart.onclick = async () => { closePause(); setPlayBtn(false); PiTV.setClock(false); try { await control({ cmd: 'reset' }); } catch (e) {} playBtn.click(); };
  pMore.onclick = () => { closePause(); go('setup'); };
  pQuit.onclick = async () => {                                  // unload the song and go back to the Library
    closePause(); setPlayBtn(false);
    PiTV.setClock(false);
    try { await control({ cmd: 'stop' }); } catch (e) {}
    loadedFile = null;                                           // next Play reloads the song fresh
    go('library');
  };

  /* ---- D-pad / keyboard navigation (TV remote: arrows + Enter + Back) ---- */
  let kbd = false;                                        // true once the user drives by keys -> show focus ring
  function vis(el) { return el && el.offsetParent !== null && !el.disabled; }
  function navCols() {
    if (!pauseEl.hidden) return [[pMode, pSpeed, pHand, pResume, pRestart, pMore, pQuit].filter(vis)];
    if (!finish.hidden) return [[finAgain, finPick].filter(vis)];
    if (view === 'stage') return [[backBtn, playBtn, resetBtn, viewBtn, seekEl].filter(vis)];
    const sc = $(SCREENS[view]);
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
    if (view === 'setup' && vis(startBtn)) return focusAt(startBtn);          // primary action ("Play now") first
    if (view === 'library') { const sel = songList.querySelector('.songitem.on'); if (vis(sel)) return focusAt(sel); }
    const c = navCols(); if (c.length && c[0].length) focusAt(c[0][0]);
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
    if (!currentVM) return;
    const step = Math.max(1, currentVM.duration * 0.02);
    control({ cmd: 'seek', t: Math.max(0, Math.min(currentVM.duration, lastT + dir * step)) }).catch(() => {});
  }
  document.addEventListener('pointerdown', () => { kbd = false; document.querySelectorAll('.nav-here').forEach(e => e.classList.remove('nav-here')); });
  document.addEventListener('keydown', e => {
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
        if (ae && tag !== 'SELECT' && ae.click) { ae.click(); e.preventDefault(); }
        break;
      case 'Backspace': case 'Escape':
        kbd = true;
        if (!pauseEl.hidden) pResume.click();
        else if (!finish.hidden) finPick.click();                      // Back on the finish screen -> Library
        else if (view === 'stage') { if (playing) playBtn.click(); else openPause(); }   // Esc on the stage = pause/menu
        else if (view !== 'home') go(PARENT[view] || 'home');          // up one level (Home is the root)
        e.preventDefault(); break;
      case ' ': case 'Spacebar':
        if (!pauseEl.hidden) { pResume.click(); e.preventDefault(); }
        else if (view === 'stage' && finish.hidden) { playBtn.click(); e.preventDefault(); }
        break;
    }
  });

  /* ---- SSE: live keyboard notes + streamed play-position ---- */
  (function connect() {
    const es = new EventSource('/events');
    es.onopen = () => { statusEl.className = 'dot ok'; statusEl.title = 'connected'; };
    es.onerror = () => { statusEl.className = 'dot err'; statusEl.title = 'reconnecting…'; };
    let lastPct = -1, lastTallyKey = '';
    // The pos/hello heartbeat is the one heavy arm — keep it in a named function; the rest are a map.
    function onPos(m) {
      // Only ADOPT the Pi's song on connect when it's actually PLAYING (a real reconnect / a 2nd
      // device joining mid-song). An idle Pi may still hold a song loaded from before — ignore it,
      // so a fresh load / F5 starts clean on the Library instead of dumping you into a random song.
      if (m.type === 'hello') {
        if (m.vm && m.playing && (!currentVM || m.file !== loadedFile)) {
          adoptHello(m); setPlayBtn(true); go('stage');   // join the in-progress song
        } else if (m.vm && !currentVM) {
          adoptHello(m); setPlayBtn(!!m.playing);          // loaded-but-paused: adopt model, stay on Home
        }
      } else if (m.file && loadedFile && m.file !== loadedFile) {
        es.close(); setTimeout(connect, 60); return;       // stale view: reconnect for a clean hello snapshot
      }
      lastT = m.t;                                         // local clock: pos is just a correction heartbeat
      if (m.gates) PiTV.setGates(m.gates);                 // hello carries gates
      const jumpedBack = m.t < soundLastT - 0.3;           // seek/loop/reset went backward
      soundLastT = m.t;
      PiTV.correctNow(m.t); PiTV.setClock(m.playing, m.speed);
      if (jumpedBack) soundResync();                       // AFTER the clock snaps, re-aim the scheduler
      if (playing && m.t < 0) { const n = Math.min(3, Math.ceil(-m.t)); countin.firstChild.textContent = n > 0 ? n : ''; countin.hidden = n <= 0; }
      else if (!countin.hidden) countin.hidden = true;
      const d = currentVM ? currentVM.duration : 0;
      const pct = d > 0 ? Math.max(0, Math.min(100, m.t / d * 100)) : 0;
      if (Math.abs(pct - lastPct) >= 0.2) {
        seekFill.style.width = pct + '%'; seekEl.setAttribute('aria-valuenow', Math.round(pct));
        seekEl.setAttribute('aria-valuetext', fmtTime(m.t) + ' of ' + fmtTime(d));   // screen reader: time, not bare %
        timeEl.textContent = fmtTime(m.t) + ' / ' + fmtTime(d); lastPct = pct;
      }
      timingTally = m.timing;
      const tk = m.timing ? [m.timing.good, m.timing.late, m.timing.early, m.timing.miss, m.timing.wrong, m.timing.on].join() : '';
      if (!flashing && tk !== lastTallyKey) { showTiming(); lastTallyKey = tk; }   // only repaint when it changes
      if (m.ended) {                                       // song finished on its own (one-shot, never flips back)
        setPlayBtn(false); countin.hidden = true;
        if (!endedShown) { endedShown = true; celebrate(); }
      }
    }
    // SSE protocol -> handler map (was a 7-way if/else on m.type)
    const handlers = {
      pos: onPos, hello: onPos,
      key: m => { kbd = true; document.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true, cancelable: true })); },
      gate: m => PiTV.clearGateUpto(m.gi),                 // freeze cursor cleared -> local clock resumes here
      rating: m => { flashRating(m.kind, m.off, m.note); if (m.gate != null) PiTV.setRated(m.gate, m.kind); },
      gates: m => PiTV.setGates(m.gates),                  // gate set changed (load / part / range / mode)
      noteon: m => { PiTV.highlight(m.note, true); PiTV.setPlayed(m.note, true); liveSound(m.note, true, m.velocity); },
      noteoff: m => { PiTV.highlight(m.note, false); PiTV.setPlayed(m.note, false); liveSound(m.note, false); },
    };
    es.onmessage = ev => { const m = JSON.parse(ev.data); const fn = handlers[m.type]; if (fn) fn(m); };
  })();

  loadSongList();
  go('home');          // start at the Home screen (the root)
})();
