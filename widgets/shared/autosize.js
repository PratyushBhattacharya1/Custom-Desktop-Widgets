// Keeps a widget's window fitted to its card.
//
// Guard 1 of the three anti-oscillation guards lives here: only report a size
// that meaningfully changed, so the renderer and main process can't ping-pong.
// The other two (a main-side no-op and a rate limit) are in src/main/ipc.js.
//
// Returns its own sync function so callers can also nudge it directly after a
// change the ResizeObserver won't see as a card resize. The function also has
// hold() and release() for a drag that holds the window open (see
// widgetAPI.beginResize): nothing is reported while held, and release() reports
// at once, past Guard 1, because the window is no longer the size last reported
// even if the card is.
(function () {
  window.widgetAutosize = function (card, opts) {
    const both = !!(opts && opts.axes === 'both');
    let lastW = -1;
    let lastH = -1;
    let timer = null;
    let held = false;

    function report(force) {
      if (!window.widgetAPI || !window.widgetAPI.requestSize) return;
      const rect = card.getBoundingClientRect();
      const h = Math.ceil(rect.height);
      const w = Math.ceil(rect.width);
      if (!force && Math.abs(h - lastH) <= 1 && (!both || Math.abs(w - lastW) <= 1)) return;
      lastH = h;
      lastW = w;
      window.widgetAPI.requestSize(both ? { width: w, height: h } : { height: h });
    }

    // A card that grew is reported at once: until the window catches up, its
    // bottom is cut off, which the 50 ms wait made visible. A shrink still waits
    // for the card to settle, since the window's spare height is transparent
    // and nobody sees it.
    function sync() {
      if (held) return;
      if (timer) clearTimeout(timer);
      timer = null;
      const rect = card.getBoundingClientRect();
      if (Math.ceil(rect.height) > lastH + 1 || (both && Math.ceil(rect.width) > lastW + 1)) {
        report(false);
        return;
      }
      timer = setTimeout(function () { report(false); }, 50);
    }

    sync.hold = function () {
      held = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    sync.release = function () {
      held = false;
      report(true);
    };

    if (window.ResizeObserver) new ResizeObserver(sync).observe(card);
    return sync;
  };
})();
