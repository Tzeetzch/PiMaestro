/* PiMaestro song selector: the left rail (collapsible Drums / Piano / More categories + the
   Favourites / Recently-played virtual groups) and the song grid. This is a pure VIEW — it does NOT
   fetch, hold, or persist anything; the song list + metadata live in the catalogue (catalog.js) and
   arrive here as injected inputs. Its whole job: show the songs, let you pick one, emit the choice.

   Black-box contract: PiLib names no sibling module. INPUTS: getSongs (the catalogue list), getMeta
   (fav/played/best for a file), coverGlyph/coverBg (a song's cover art), and onUpload (hand MIDIs to
   the catalogue). OUTPUT: onPick(file) — the chosen song. The app keeps the "selected file" and tells
   us via select() to highlight it; the app re-renders us (via the catalogue's onChange) when data
   changes. Exposed as a global PiLib. */
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

  let songsByGroup = {}, currentGroup = null, selected = null;
  let ctx = {
    getSongs: () => [], getMeta: () => null, coverGlyph: () => '♫', coverBg: () => '',
    onPick: () => {}, onUpload: () => Promise.resolve({ ok: 0, fail: 0, last: null }),
  };
  const FAV = '★ Favorites', RECENT = '◷ Recently played';

  function favList() { return ctx.getSongs().filter(s => { const m = ctx.getMeta(s.file); return m && m.fav; }); }
  function recentList() {
    return ctx.getSongs().filter(s => { const m = ctx.getMeta(s.file); return m && m.played; })
      .sort((a, b) => ctx.getMeta(b.file).played - ctx.getMeta(a.file).played).slice(0, 20);
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
  function songItem(s) {
    const m = ctx.getMeta(s.file) || {};
    const meta = [];
    if (m.fav) meta.push(h('span', { class: 'si-fav' }, '★'));
    const best = m.best || 0;
    if (best) meta.push(h('span', { class: 'si-stars' }, '★'.repeat(best)));
    meta.push(h('span', null, s.group));
    return h('li', { class: 'songitem' + (s.file === selected ? ' on' : ''), tabIndex: 0,
      onclick: () => ctx.onPick(s.file) },
      h('span', { class: 'cover', style: 'background:' + ctx.coverBg(s.title) }, ctx.coverGlyph(s)),
      h('span', { class: 'si-main' },
        h('div', { class: 'si-title' }, s.title),
        h('div', { class: 'si-meta' }, ...meta)));
  }
  // Left rail: collapsible category headers + their group tabs (Favourites/Recently on top).
  function render() {
    songsByGroup = {};
    for (const s of ctx.getSongs()) (songsByGroup[s.group] = songsByGroup[s.group] || []).push(s);
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

  // Upload button: the view owns the button + per-file feedback; the catalogue does the actual POST.
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const files = Array.from(fileInput.files || []); if (!files.length) return;
    uploadBtn.disabled = true;
    const res = await ctx.onUpload(files, (i, total) => { uploadBtn.textContent = 'Uploading ' + (i + 1) + '/' + total + '…'; });
    if (res && res.last) { showGroupOf(res.last); ctx.onPick(res.last); }   // jump to + pick the newest
    uploadBtn.textContent = (res && res.fail) ? ('Added ' + res.ok + ', ✕' + res.fail + ' bad') : ('✓ Added ' + ((res && res.ok) || 0));
    uploadBtn.disabled = false;
    setTimeout(() => { uploadBtn.innerHTML = '&#8593; Upload MIDIs'; }, 2500);
  };

  function showGroupOf(file) { const s = ctx.getSongs().find(x => x.file === file); if (s) { currentGroup = s.group; render(); } }

  return {
    init(c) { Object.assign(ctx, c); },
    render,                                                        // app re-renders us when the catalogue changes
    select(file) { selected = file || null; render(); },          // mirror the app's chosen song (highlight)
    showGroupOf,                                                   // jump the rail to a file's group (restore/upload)
  };
})();
