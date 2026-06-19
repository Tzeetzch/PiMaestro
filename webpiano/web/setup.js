/* PiMaestro Setup screen: the per-song configuration VIEW — the Part dropdown (which part you play),
   the per-track instruments panel (#instrPanel: play / instrument / volume / mute), the plain-language
   mode hint, and the hero (title / cover / notes / ☆). This is the rendering + the part-selection
   logic; the app still OWNS the shared performance state (currentPlay/hand/mode/transpose/split) and
   the load/select/adopt state machine — it reads our part helpers and we call back when the player
   re-picks which tracks they play. Exposed as a global PiSetup (like PiTV / PiLib / PiNav / PiTransport).

   Black-box contract — PiSetup does NOT know any other module exists. Everything it needs from the
   outside is an injected function:
     INPUTS  : getVM (current song), getPlay (channels you cover), getSelFile (chosen song id),
               control (send a command to the engine), coverGlyph/coverBg (art for the hero),
               isFav (is this song a favourite?).
     OUTPUTS : onPlay(channels) — "re-picked tracks via the instruments panel"; onPart() — "changed the
               Part dropdown". The app owns the shared performance state and reacts to both.
   It owns only its own Setup-screen DOM. handSel + modeSel are shared DOM the app's state machine
   writes (selectSong / adoptHello / pause overlay); we read them and render from them. */
const PiSetup = (function () {
  const $ = id => document.getElementById(id);
  // PiSetup is the SOLE owner of the Part dropdown (#handSel): it builds the options AND is the only
  // box that reads/writes its value (the app goes through setHand / handValue / handMirror / onPart).
  // #modeSel stays the app's (static options, play-flow onchange); we only need the mode value, passed in.
  const handSel = $('handSel'), modeHint = $('modeHint'), instrPanel = $('instrPanel'), favBtn = $('fav');
  let ctx = {
    getVM: () => null, getPlay: () => [], getSelFile: () => null,
    control: () => Promise.resolve(), onPlay: () => {}, onPart: () => {},
    coverGlyph: () => '♫', coverBg: () => '', isFav: () => false,
  };
  handSel.onchange = () => ctx.onPart();                 // player changed the Part dropdown -> app re-applies

  // Per-mode plain-language hint shown under the Mode dropdown.
  const MODE_HINTS = {
    follow: 'The song pauses and waits until you press the right keys.',
    along: 'The song keeps going at a steady speed — try to keep up.',
    listen: 'The song plays itself so you can watch and listen.',
  };
  function updateModeHint(modeVal) { modeHint.textContent = MODE_HINTS[modeVal] || ''; }

  // General MIDI instrument names (program 0..127)
  const GM_NAMES = ['Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet', 'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer', 'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion', 'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics', 'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2', 'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani', 'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit', 'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2', 'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet', 'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina', 'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass+lead)', 'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)', 'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)', 'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai', 'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal', 'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'];
  const COMMON = [0, 1, 4, 6, 11, 12, 16, 19, 21, 24, 25, 27, 30, 32, 33, 40, 42, 48, 52, 56, 60, 65, 71, 73, 75, 80, 81, 89];

  // ---- which part(s) the player covers: Part dropdown -> MIDI channels (+ hand for 1-track) ----
  function partChannels() {
    const vm = ctx.getVM(); if (!vm) return [];
    const v = handSel.value;
    if (v === 'R') return vm.rightChan != null ? [vm.rightChan] : [];
    if (v === 'L') return vm.leftChan != null ? [vm.leftChan] : [];
    if (v === 'drums' || v.indexOf('drk:') === 0) return [9];   // play the drum kit (-> percussion staff)
    if (v && v.indexOf('ch:') === 0) return [parseInt(v.slice(3), 10)];
    return [...new Set([vm.rightChan, vm.leftChan].filter(c => c != null))];   // 'both'
  }
  // Which DRUM track (when a file has >1 on ch9, e.g. two drummers); null = the single/merged drum part.
  function partTrack() {
    const v = handSel.value;
    return (v && v.indexOf('drk:') === 0) ? parseInt(v.slice(4), 10) : null;
  }
  // When both hands live on ONE channel, R/L can't be a channel — split by pitch instead.
  function partHand() {
    const vm = ctx.getVM(); if (!vm) return null;
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
    const dts = vm.drumTracks || [];
    const hasDrums = dts.length > 0 || (vm.parts || []).some(p => p.ch === 9);
    if (hasPiano) { add('both', 'Both hands'); add('R', 'Right hand'); add('L', 'Left hand'); }
    if (dts.length > 1) {                                 // >1 drum track (e.g. two drummers) -> pick which
      dts.forEach((d, i) => add('drk:' + d.trk, 'Drums' + (d.name ? ' — ' + d.name : ' ' + (i + 1))));
    } else if (hasDrums) {
      add('drums', 'Drums');                              // play the kit -> drum notation
    }
    (vm.parts || []).forEach(p => {                       // any other instrument you could play
      if (p.ch === 9 || p.ch === r || p.ch === l) return; // drums / piano part already covered
      add('ch:' + p.ch, 'Play: ' + (GM_NAMES[p.program] || ('Part ' + p.ch)));
    });
    if (!handSel.options.length) add('both', 'All');
    handSel.value = hasPiano ? 'both' : (dts.length > 1 ? 'drk:' + dts[0].trk : (hasDrums ? 'drums' : handSel.options[0].value));   // drum-only -> Drums (busiest track)
  }

  /* ---- instruments: one sound chooser per part (built into the Tracks menu section) ---- */
  function buildInstr() {
    instrPanel.innerHTML = '';
    const vm = ctx.getVM();
    const parts = (vm && vm.parts) || [];
    if (!parts.length) {
      const e = document.createElement('div'); e.className = 'hint'; e.textContent = 'Load a song first.';
      instrPanel.appendChild(e); return;
    }
    const play = ctx.getPlay();
    const playCbs = [];
    const gatherPlay = () => ctx.onPlay(playCbs.filter(o => o.cb.checked).map(o => o.ch));   // app sets play + saves
    parts.forEach(p => {
      const row = document.createElement('div'); row.className = 'row';
      const isDrum = p.ch === 9;
      const r = vm.rightChan, l = vm.leftChan;
      const nm = document.createElement('span'); nm.className = 'nm';
      nm.textContent = isDrum ? 'Drums'
        : (r !== l && p.ch === r) ? 'Right hand'
        : (r !== l && p.ch === l) ? 'Left hand'
        : (GM_NAMES[p.program] || ('Part ' + p.ch));
      row.appendChild(nm);
      if (!isDrum) {                                    // you can't play GM drums on a piano
        const plab = document.createElement('label');
        const pcb = document.createElement('input'); pcb.type = 'checkbox';
        pcb.checked = play.includes(p.ch);
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
        sel.onchange = () => { ctx.control({ cmd: 'part', ch: p.ch, program: +sel.value }).catch(() => {}); };
        row.appendChild(sel);
      }
      const vol = document.createElement('input');                 // per-instrument volume (CC7)
      vol.type = 'range'; vol.min = 0; vol.max = 127; vol.value = 100; vol.className = 'vol'; vol.title = 'Volume';
      vol.oninput = () => { ctx.control({ cmd: 'part', ch: p.ch, volume: +vol.value }).catch(() => {}); };
      row.appendChild(vol);
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.onchange = () => { ctx.control({ cmd: 'part', ch: p.ch, mute: cb.checked }).catch(() => {}); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode('mute'));
      row.appendChild(lab);
      instrPanel.appendChild(row);
    });
    const hint2 = document.createElement('div'); hint2.className = 'hint';
    hint2.textContent = 'play = you play it (shown). off = background (heard, hidden). mute = silent.';
    instrPanel.appendChild(hint2);
  }

  /* ---- hero: title / cover / notes + the ☆ favourite toggle's reflected state ---- */
  function fillSetupHead() {
    const vm = ctx.getVM(); if (!vm) return;
    $('setupTitle').textContent = vm.title || '—';
    const cv = document.querySelector('.setup-hero .cover');
    if (cv) { cv.textContent = ctx.coverGlyph(vm); cv.style.background = ctx.coverBg(vm.title); }
    const shift = vm.transpose || 0;
    const stag = shift ? ' · ' + (shift > 0 ? '+' : '') + (shift / 12) + ' oct' : '';
    $('setupSub').textContent = vm.notes.length + ' notes' + stag;
    updateFavBtn();
  }
  function updateFavBtn() {                        // the ☆ on the Setup screen reflects the injected fav state
    const on = ctx.isFav(ctx.getSelFile());
    favBtn.textContent = on ? '★' : '☆';
    favBtn.classList.toggle('on', on);
  }

  return {
    init(c) { Object.assign(ctx, c); },
    buildInstr, buildPartOptions, partChannels, partHand, partTrack, updateModeHint, fillSetupHead, updateFavBtn,
    setHand(v) { if (v != null) handSel.value = v; },                       // app restores/adopts the dropdown label
    handValue() { return handSel.value; },                                  // app persists it in saved settings
    handMirror() { return { html: handSel.innerHTML, value: handSel.value }; },   // the pause overlay clones it
  };
})();
