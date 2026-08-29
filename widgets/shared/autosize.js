// Keeps a widget's window fitted to its card.
//
// Guard 1 of the three anti-oscillation guards lives here: only report a size
// that meaningfully changed, so the renderer and main process can't ping-pong.
// The other two (a main-side no-op and a rate limit) are in src/main/ipc.js.
//
// Returns its own sync function so callers can also nudge it directly after a
// change the ResizeObserver won't see as a card resize.
(function () {
  window.widgetAutosize = function (card, opts) {
    const both = !!(opts && opts.axes === 'both');
    let lastW = -1;
    let lastH = -1;
    let timer = null;

    function sync() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        if (!window.widgetAPI || !window.widgetAPI.requestSize) return;
        const rect = card.getBoundingClientRect();
        const h = Math.ceil(rect.height);
        const w = Math.ceil(rect.width);
        if (Math.abs(h - lastH) <= 1 && (!both || Math.abs(w - lastW) <= 1)) return;
        lastH = h;
        lastW = w;
        window.widgetAPI.requestSize(both ? { width: w, height: h } : { height: h });
      }, 50);
    }

    if (window.ResizeObserver) new ResizeObserver(sync).observe(card);
    return sync;
  };
})();
