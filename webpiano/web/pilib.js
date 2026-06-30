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
    getInstrument: () => 'keyboard', onPick: () => {}, onUpload: () => Promise.resolve({ ok: 0, fail: 0, last: null }),
  };
  const FAV = '★ Favorites', RECENT = '◷ Recently played';

  // Show only the chosen instrument's songs (folder-derived category). Drums -> the Drums groups;
  // Keyboard -> everything else. A pure filter: it hides clutter, never blocks a song from loading.
  function inInstrument(s) {
    return ctx.getInstrument() === 'drums' ? catOf(s.group) === 'Drums' : catOf(s.group) !== 'Drums';
  }
  function visibleSongs() { return ctx.getSongs().filter(inInstrument); }
  function favList() { return visibleSongs().filter(s => { const m = ctx.getMeta(s.file); return m && m.fav; }); }
  function recentList() {
    return visibleSongs().filter(s => { const m = ctx.getMeta(s.file); return m && m.played; })
      .sort((a, b) => ctx.getMeta(b.file).played - ctx.getMeta(a.file).played).slice(0, 20);
  }
  // Classify a group's folder into an instrument bucket — drives the instrument FILTER (inInstrument) above.
  function catOf(g) {
    if (/^Drums\b/.test(g)) return 'Drums';
    if (/^(Game|Popular|Uploads)\b/.test(g)) return 'More';
    return 'Piano';                          // piano-first app: course, lessons, my songs all live here
  }
  function subLabel(g) { return g.replace(/^(Drums|Piano)\s*-\s*/, ''); }   // hide the (now-implicit) instrument prefix
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
  // Left rail: a FLAT list of the chosen instrument's groups (Favourites/Recently pinned on top). The
  // old Drums/Piano/More category tree is gone — the instrument is now chosen on the Home screen, so the
  // top-level split it provided is redundant. Groups arrive already ordered (server sorts by folder prefix).
  function render() {
    songsByGroup = {};
    for (const s of visibleSongs()) (songsByGroup[s.group] = songsByGroup[s.group] || []).push(s);
    const real = Object.keys(songsByGroup);
    const virtual = [];
    if (recentList().length) virtual.push(RECENT);
    if (favList().length) virtual.push(FAV);
    const all = virtual.concat(real);
    if (!currentGroup || !all.includes(currentGroup)) currentGroup = all[0] || null;
    groupTabs.innerHTML = '';
    all.forEach(g => groupTabs.append(gtab(g)));
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
