/* PiMaestro library: the song catalogue + the left rail (collapsible Drums / Piano / More categories
   and the Favourites / Recently-played virtual groups) + the song grid + uploads. Owns the catalogue
   data and the per-song metadata (fav / played / best), and renders into #groupTabs / #songList.

   Exposed as a global PiLib (like PiTV / PiSound / PiSse). The app injects onPick (what happens when a
   song is chosen) and control (to persist metadata); the app keeps the "selected file" itself and
   tells us via select(). Metadata changes go through markPlayed / toggleFav / setBest. */
const PiLib = (function () {
  const $ = id => document.getElementById(id);
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
  const groupTabs = $('groupTabs'), songList = $('songList'), libTitle = $('libTitle'), libSub = $('libSub'),
        uploadBtn = $('uploadBtn'), fileInput = $('fileInput');

  let songsByGroup = {}, allSongs = [], lib = {}, currentGroup = null, selected = null;
  let ctx = { onPick: () => {}, control: () => Promise.resolve() };
  const FAV = '★ Favorites', RECENT = '◷ Recently played';

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
    render();
  }
  function songsForGroup(g) {
    if (g === FAV) return favList();
    if (g === RECENT) return recentList();
    return songsByGroup[g] || [];
  }
  function gtab(g, sub) {
    return h('button', { class: 'gtab' + (sub ? ' sub' : '') + (g === currentGroup ? ' on' : ''), tabIndex: 0,
      onclick: () => { currentGroup = g; render(); } },
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
  // Stable hue per title so the grid has rhythm instead of a wall of identical tiles.
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
    return h('li', { class: 'songitem' + (s.file === selected ? ' on' : ''), tabIndex: 0,
      onclick: () => ctx.onPick(s.file) },
      h('span', { class: 'cover', style: 'background:' + coverBg(s.title) }, coverGlyph(s)),
      h('span', { class: 'si-main' },
        h('div', { class: 'si-title' }, s.title),
        h('div', { class: 'si-meta' }, ...meta)));
  }
  // Left rail: collapsible category headers + their group tabs (Favourites/Recently on top).
  function render() {
    const real = Object.keys(songsByGroup);
    const virtual = [];
    if (recentList().length) virtual.push(RECENT);
    if (favList().length) virtual.push(FAV);
    const all = virtual.concat(real);
    if (!currentGroup || !all.includes(currentGroup)) currentGroup = all[0] || null;
    if (currentGroup && !virtual.includes(currentGroup)) collapsedCats.delete(catOf(currentGroup));  // keep the selection visible
    groupTabs.innerHTML = '';
    virtual.forEach(g => groupTabs.append(gtab(g)));
    for (const c of CATS) {
      const groups = real.filter(g => catOf(g) === c);
      if (!groups.length) continue;
      groupTabs.append(gcat(c, groups.reduce((n, g) => n + songsForGroup(g).length, 0)));
      if (!collapsedCats.has(c)) groups.forEach(g => groupTabs.append(gtab(g, true)));
    }
    fillSongList();
  }
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

  // Upload a MIDI from any device (raw body, filename in the query — no multipart needed).
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []); if (!files.length) return;
    uploadBtn.disabled = true;
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
    await load();                                  // refresh catalogue + library once
    if (last) { showGroupOf(last); ctx.onPick(last); }
    uploadBtn.textContent = fail ? ('Added ' + ok + ', ✕' + fail + ' bad') : ('✓ Added ' + ok);
    uploadBtn.disabled = false;
    setTimeout(() => { uploadBtn.innerHTML = '&#8593; Upload MIDIs'; }, 2500);
  };

  async function load() {
    try { allSongs = await (await fetch('/songs')).json(); } catch (e) { return; }
    try { lib = await (await fetch('/library')).json(); } catch (e) { lib = {}; }
    songsByGroup = {};
    for (const s of allSongs) (songsByGroup[s.group] = songsByGroup[s.group] || []).push(s);
    render();
  }
  function showGroupOf(file) { const s = allSongs.find(x => x.file === file); if (s) { currentGroup = s.group; render(); } }

  return {
    init(c) { Object.assign(ctx, c); },
    load, render,
    select(file) { selected = file || null; render(); },          // mirror the app's chosen song (highlight)
    showGroupOf,                                                   // jump the rail to a file's group (restore/upload)
    markPlayed(file) { if (!file) return; lib[file] = Object.assign({}, lib[file], { played: Date.now() / 1000 }); ctx.control({ cmd: 'played', file }).catch(() => {}); render(); },
    toggleFav(file) { if (!file) return false; const on = !(lib[file] && lib[file].fav); lib[file] = Object.assign({}, lib[file], { fav: on }); ctx.control({ cmd: 'favorite', file, on }).catch(() => {}); render(); return on; },
    isFav(file) { return !!(file && lib[file] && lib[file].fav); },
    bestOf(file) { return (lib[file] && lib[file].best) || 0; },
    setBest(file, stars) { if (!file || stars <= ((lib[file] && lib[file].best) || 0)) return; lib[file] = Object.assign({}, lib[file], { best: stars }); ctx.control({ cmd: 'save_settings', file, settings: { best: stars } }).catch(() => {}); render(); },
    coverGlyph, coverBg,                                          // setup hero reuses these
  };
})();
