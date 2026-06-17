/* PiMaestro SSE client: owns the /events EventSource — opening it, the connection status dot,
   reconnecting, parsing each frame, and dispatching by message type. The handlers (what each
   message actually DOES) live in app.js; this is purely the transport. Exposed as a global PiSse,
   the same way render.js exposes PiTV and sound.js exposes PiSound. */
const PiSse = (function () {
  const statusEl = document.getElementById('status');
  let es = null, handlers = {};

  function connect() {
    es = new EventSource('/events');
    es.onopen = () => { if (statusEl) { statusEl.className = 'dot ok'; statusEl.title = 'connected'; } };
    es.onerror = () => { if (statusEl) { statusEl.className = 'dot err'; statusEl.title = 'reconnecting…'; } };
    es.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      const fn = handlers[m.type];
      if (fn) fn(m);
    };
  }

  return {
    start(h) { handlers = h || {}; connect(); },           // begin streaming; dispatch frames by type
    reconnect() { try { if (es) es.close(); } catch (e) {} setTimeout(connect, 60); },  // drop + re-open (stale view)
  };
})();
