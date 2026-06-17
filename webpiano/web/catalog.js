/* PiMaestro catalogue: the song data + per-song metadata REPOSITORY. Owns the song list (from /songs),
   the fav/played/best metadata (from /library), uploading new MIDIs (/upload), and persisting metadata
   changes back to the Pi. This is pure data — it has NO DOM and renders nothing; the selector (pilib.js)
   reads it and draws. Split out of PiLib so the song-selector is just a view (in: a song list; out: the
   chosen song) and the data/transport lives here.

   Black-box contract: PiCatalog names no sibling module. INPUTS: control (persist a change to the engine),
   onChange (data changed → whoever's showing it should re-render). OUTPUTS: the pulled getters songs() /
   meta() / isFav() / bestOf() and the song-presentation helpers coverGlyph/coverBg. fetch('/songs' etc.)
   is the server data port, not a sibling box. Exposed as a global PiCatalog. */
const PiCatalog = (function () {
  let allSongs = [], lib = {};
  let ctx = { control: () => Promise.resolve(), onChange: () => {} };

  function coverGlyph(s) { const t = (s.title || '').trim(); return t ? t[0].toUpperCase() : '♫'; }
  // Stable hue per title so the grid has rhythm instead of a wall of identical tiles.
  function coverBg(title) {
    let hsh = 0; const t = title || '';
    for (let i = 0; i < t.length; i++) hsh = (hsh * 31 + t.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg, hsl(' + hsh + ' 58% 52%), hsl(' + ((hsh + 42) % 360) + ' 56% 38%))';
  }

  async function load() {
    try { allSongs = await (await fetch('/songs')).json(); } catch (e) { return; }
    try { lib = await (await fetch('/library')).json(); } catch (e) { lib = {}; }
    ctx.onChange();
  }
  // Upload MIDIs from any device (raw body, filename in the query — no multipart). onProgress(i, total)
  // lets the caller show per-file feedback. Refreshes the catalogue once, then returns a summary.
  async function upload(files, onProgress) {
    let ok = 0, fail = 0, last = null;
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length);
      try {
        const buf = await files[i].arrayBuffer();
        const r = await fetch('/upload?name=' + encodeURIComponent(files[i].name), { method: 'POST', body: buf });
        if (!r.ok) throw 0;
        const res = await r.json();
        if (!res.file) throw 0;
        ok++; last = res.file;
      } catch (e) { fail++; }
    }
    await load();                                  // refresh catalogue + metadata once (fires onChange)
    return { ok, fail, last };
  }

  return {
    init(c) { Object.assign(ctx, c); },
    load, upload,
    songs() { return allSongs; },
    meta(file) { return lib[file] || null; },
    isFav(file) { return !!(file && lib[file] && lib[file].fav); },
    bestOf(file) { return (lib[file] && lib[file].best) || 0; },
    markPlayed(file) { if (!file) return; lib[file] = Object.assign({}, lib[file], { played: Date.now() / 1000 }); ctx.control({ cmd: 'played', file }).catch(() => {}); ctx.onChange(); },
    toggleFav(file) { if (!file) return false; const on = !(lib[file] && lib[file].fav); lib[file] = Object.assign({}, lib[file], { fav: on }); ctx.control({ cmd: 'favorite', file, on }).catch(() => {}); ctx.onChange(); return on; },
    setBest(file, stars) { if (!file || stars <= ((lib[file] && lib[file].best) || 0)) return; lib[file] = Object.assign({}, lib[file], { best: stars }); ctx.control({ cmd: 'save_settings', file, settings: { best: stars } }).catch(() => {}); ctx.onChange(); },
    coverGlyph, coverBg,                                          // song-presentation helpers (selector + setup hero reuse these)
  };
})();
