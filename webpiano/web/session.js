/* PiMaestro session: the current performance — the loaded song (vm + file) and which part the player
   covers (play channels + hand). This is the shared state the OTHER boxes read (PiSound/PiTransport/
   PiSetup/PiNav all get a getVM closure; PiSetup also gets getPlay) — so it earns a first-class home
   instead of living as loose vars in app.js. A passive "model": it holds values, nothing more.

   Black-box contract: PiSession names nothing and knows nothing. IN = property writes; OUT = property
   reads. Only the composition root (app.js) touches it directly; the other boxes never name PiSession —
   the app injects plain getters (getVM: () => PiSession.vm, ...) that happen to read it.

   (mode / transpose / split deliberately stay in app.js: each is bound 1:1 to its <select> widget and
   the engine's string protocol, is read only inside app's own logic, and isn't shared across boxes.)

   Implemented with accessor properties so reads/writes are ordinary `PiSession.vm` / `PiSession.vm = x`. */
const PiSession = (function () {
  let vm = null,        // the loaded view-model (the song timeline the engine returned), or null
      file = null,      // that song's path on the Pi (load identity), or null when nothing is loaded
      play = [],        // MIDI channels the player covers (their part); the rest is accompaniment
      hand = null;      // 'R'/'L' to split a single-channel song by pitch, else null
  return {
    get vm() { return vm; }, set vm(v) { vm = v; },
    get file() { return file; }, set file(v) { file = v; },
    get play() { return play; }, set play(v) { play = v; },
    get hand() { return hand; }, set hand(v) { hand = v; },
  };
})();
