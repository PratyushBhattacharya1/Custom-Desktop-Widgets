// Injects the pin (lock-position) button into a widget's .card and keeps the
// window's drag region in sync with it. Included by every widget.
(function () {
  const card = document.querySelector('.card');
  if (!card || !window.widgetAPI) return;

  const btn = document.createElement('button');
  btn.className = 'pin-btn';
  btn.type = 'button';
  // Static, author-controlled markup — no external data reaches this string.
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 17.5v4.5"/>' +
    '<path class="pin-head" d="M9 10.9V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.4a2 2 0 0 0 .6 1.4l1.7 1.7a1 1 0 0 1-.7 1.7H6.4a1 1 0 0 1-.7-1.7l1.7-1.7a2 2 0 0 0 .6-1.4z"/>' +
    '</svg>';

  // The button is hidden until hovered, so it needs a target bigger than itself
  // to find. The zone is invisible and no-drag: drag regions on Windows often
  // don't deliver mouse events to the page, so hover has to happen off one.
  const zone = document.createElement('div');
  zone.className = 'pin-zone';
  zone.appendChild(btn);
  card.appendChild(zone);

  let pinned = false;

  function paint(animate) {
    document.documentElement.classList.toggle('pos-locked', pinned);
    btn.classList.toggle('pinned', pinned);
    btn.setAttribute('aria-pressed', String(pinned));
    btn.title = pinned ? 'Unlock position' : 'Lock position';
    if (animate) {
      btn.classList.remove('pop');
      void btn.offsetWidth; // restart the animation
      btn.classList.add('pop');
    }
  }

  btn.addEventListener('click', async () => {
    pinned = !pinned;
    paint(true);
    try {
      // Trust main's answer over our optimistic guess.
      pinned = await window.widgetAPI.setPinned(pinned);
      paint(false);
    } catch (err) {
      console.error('Failed to save pin state:', err);
    }
  });

  // The context menu can toggle the lock, so mirror pushed state. paint(false)
  // deliberately: the pop animation belongs to a click on the button itself.
  if (window.widgetAPI.onSettingsChanged) {
    window.widgetAPI.onSettingsChanged(function (s) {
      if (!s || typeof s.pinned !== 'boolean' || s.pinned === pinned) return;
      pinned = s.pinned;
      paint(false);
    });
  }

  window.widgetAPI
    .getPinned()
    .then((value) => {
      pinned = Boolean(value);
      paint(false);
    })
    .catch(() => {})
    .finally(() => btn.classList.add('ready'));
})();
