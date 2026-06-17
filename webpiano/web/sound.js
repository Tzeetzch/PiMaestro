/* PiMaestro browser sound (optional; for a device that can't hear the Pi): a pluggable synth fed
   from the local clock + your live keys. Two engines behind one SoundEngine base class:
   'rich' = WebAudioFont (real sampled instruments, served from the Pi, loaded on demand) and
   'light' = WebAudioTinySynth (oscillator — tiny + CPU-cheap, for weak devices). The Pi stays the
   real instrument; this is just a local speaker.

   This module owns ALL sound state, the two engines, the scheduler, and the sound/mute UI. It reads
   the current song and "which notes the player covers" from the app through the context passed to
   PiSound.init(); the app drives it via resync/live/onPlay/heartbeat/setPiMute. Exposed as a global
   (PiSound) the same way render.js exposes PiTV. */
const PiSound = (function () {
  const $ = id => document.getElementById(id);
  const sndHere = $('sndHere'), piMute = $('piMute'), sndRow = $('sndRow'), muteRow = $('muteRow'),
        sndQual = $('sndQual'), sndQualRow = $('sndQualRow');
  let soundOn = false, schedTimer = null, schedPtr = 0, piMuted = false, lastT = 0, audioCtx = null;
  let engineKind = localStorage.getItem('pitv.sndEngine') || 'rich';
  let engine = null;
  const SND_LOOKAHEAD = 0.2;
  // Black-box contract: PiSound names no sibling module. Injected by the app — the current view-model,
  // whether a note is the player's (live, not scheduled), the engine channel, and getClock: the local
  // render clock {playing, t} the scheduler aims at (the app wires it to PiTV; we never reach for PiTV).
  let ctx = { getVM: () => null, isMine: () => false, control: () => Promise.resolve(), getClock: () => ({ playing: false, t: 0 }) };

  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

  // Two engines share one contract behind a SoundEngine base class (same shape as NotationView).
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
      const vm = ctx.getVM();
      if (!this.synth || !vm) return;
      (vm.parts || []).forEach(p => { try { this.synth.setProgram(p.ch, p.program || 0); } catch (e) {} });
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
      const vm = ctx.getVM();
      if (!this.player || !vm) return;
      this.ch = {};
      const L = this.player.loader, jobs = [];
      jobs.push(this._load(L.instrumentInfo(L.findInstrument(0))).then(p => { this.ch[0] = p; }));   // live keys
      (vm.parts || []).forEach(part => {
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
  function firstNoteAtOrAfter(t) {
    const ns = (ctx.getVM() && ctx.getVM().notes) || []; let lo = 0, hi = ns.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ns[m].t < t) lo = m + 1; else hi = m; } return lo;
  }
  function schedTick() {                                // schedule backing a hair ahead of the clock
    const vm = ctx.getVM();
    if (!soundOn || !engine || !vm) return;
    const st = ctx.getClock(); if (!st.playing) return;
    const audioNow = engine.now(), ns = vm.notes;
    while (schedPtr < ns.length) {
      const nt = ns[schedPtr];
      if (nt.t >= st.limit) break;                      // hold backing at the next gate (Follow)
      if (nt.t > st.t + SND_LOOKAHEAD) break;           // beyond the lookahead window
      schedPtr++;
      if (nt.t < st.t - 0.1 || ctx.isMine(nt)) continue; // already past, or you play it live
      const at = audioNow + Math.max(0, (nt.t - st.t) / st.speed);
      engine.schedule(nt.ch, nt.n, nt.v || 80, at, Math.max(0.05, nt.d / st.speed));
    }
  }
  function resync() {                                   // after seek / loop / song change: drop + re-aim
    if (!soundOn || !engine) return;
    engine.reset(); engine.programs(); schedPtr = firstNoteAtOrAfter(ctx.getClock().t);
  }
  function startTimer() { if (soundOn && !schedTimer) schedTimer = setInterval(schedTick, 60); }
  function stopTimer() { if (schedTimer) { clearInterval(schedTimer); schedTimer = null; } }

  sndRow.hidden = false; muteRow.hidden = false; if (sndQualRow) sndQualRow.hidden = false;
  sndHere.onclick = async () => {
    if (!soundOn) {
      sndHere.innerHTML = '&#8987; …';
      try { await ensureSound(); } catch (e) { sndHere.innerHTML = 'sound load failed'; return; }
      soundOn = true; sndHere.classList.add('on'); sndHere.innerHTML = '&#128266; On';
      schedPtr = firstNoteAtOrAfter(ctx.getClock().t);
      if (ctx.getClock().playing) startTimer();        // idle? don't burn CPU — armed on next Play
    } else {
      soundOn = false; sndHere.classList.remove('on'); sndHere.innerHTML = '&#128266; Off';
      stopTimer(); if (engine) engine.reset();
    }
  };
  if (sndQual) {
    sndQual.value = engineKind;
    sndQual.onchange = async () => {                    // hot-swap engine; keep playing if sound is on
      engineKind = sndQual.value; localStorage.setItem('pitv.sndEngine', engineKind);
      if (soundOn) { if (engine) engine.reset(); try { await ensureSound(); schedPtr = firstNoteAtOrAfter(ctx.getClock().t); } catch (e) {} }
    };
  }
  function setPiMute(on) {
    piMuted = on;
    piMute.classList.toggle('on', piMuted);
    piMute.innerHTML = piMuted ? '&#128263; Pi muted' : '&#128264; Mute Pi';
  }
  piMute.onclick = () => { setPiMute(!piMuted); ctx.control({ cmd: 'pi_mute', on: piMuted }).catch(() => {}); };

  return {
    init(c) { Object.assign(ctx, c); },
    resync,                                             // re-aim after seek/loop/song change
    live: (note, on, vel) => { if (soundOn && engine) engine.live(note, on, vel); },   // your pressed keys
    onPlay: (playing) => { if (soundOn) playing ? startTimer() : stopTimer(); },        // scheduler runs only while playing
    heartbeat: (t) => { const back = t < lastT - 0.3; lastT = t; if (back) resync(); }, // backward jump -> re-aim
    setPiMute,
    isOn: () => soundOn,
  };
})();
