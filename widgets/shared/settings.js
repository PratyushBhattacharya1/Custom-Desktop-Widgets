// Applies appearance settings to the card. Included by every widget, before
// pin.js so the pin's own state arrives on the same payload.
//
// Values are written as custom properties on documentElement, which outrank the
// :root block in widget.css — so a change from the context menu repaints on the
// next frame with no reload and no relayout beyond what the values imply.
(function () {
  const root = document.documentElement;

  function apply(s) {
    if (!s) return;
    root.style.setProperty('--card-bg', s.cardBg);
    root.style.setProperty('--card-fg', s.cardFg);
    root.style.setProperty('--card-halo', s.cardHalo);
    root.style.setProperty('--card-scale', String(s.scale));
    root.classList.toggle('no-pin', !s.showPin);
  }

  if (!window.widgetAPI || !window.widgetAPI.getSettings) return;

  window.widgetAPI.getSettings().then(apply).catch(function () {});
  window.widgetAPI.onSettingsChanged(apply);

  // Exposed for the verification harness, mirroring window.__cal.
  window.__settings = { apply: apply };
})();
