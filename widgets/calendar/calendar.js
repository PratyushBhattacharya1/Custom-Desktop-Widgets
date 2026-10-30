// Calendar widget renderer.
//
// Two views share one header: a Monday-start day grid, and a month picker. The
// events panel below shows the selected day and drives the window's height, and
// the grip under it sets how tall its list can grow.
(function () {
  const MIN_YEAR = 1926;
  const MAX_YEAR = 2099;
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const el = {
    card: document.querySelector('.card'),
    label: document.getElementById('label'),
    todayBtn: document.getElementById('today-btn'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    dayView: document.getElementById('day-view'),
    monthView: document.getElementById('month-view'),
    grid: document.getElementById('grid'),
    daysTable: document.querySelector('#day-view .days'),
    daysStack: document.querySelector('#day-view .days-stack'),
    monthGrid: document.getElementById('month-grid'),
    events: document.getElementById('events'),
    eventsScroll: document.getElementById('events-scroll'),
    grip: document.getElementById('events-grip'),
  };

  function todayParts() {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
  }

  const start = todayParts();
  const state = {
    view: 'days',
    cursor: { y: start.y, m: start.m },
    selected: { y: start.y, m: start.m, d: start.d }, // today is selected on load
    today: start,
    month: null,          // { instances, calendars, status } for the cursor month
    maxWidgetHeight: 460, // replaced by the real work-area budget at init
    workAreaHeight: 1000, // also replaced at init: the most a list sized by hand gets
    listHeight: null,     // the most the events list grows to once dragged; null uses the budget
  };

  const sameDay = (a, b) => !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;

  // ---------------------------------------------------------------- data

  let monthReq = 0;

  async function loadMonth() {
    if (!window.calendarAPI) return;
    // Requests can land out of order, and an onUpdated broadcast can race a
    // navigation. Without these guards state.month ends up describing a
    // different month than state.cursor, which silently shows the wrong events.
    const seq = ++monthReq;
    const want = { y: state.cursor.y, m: state.cursor.m };
    let data = null;
    try {
      data = await window.calendarAPI.getMonth(want.y, want.m);
    } catch {
      data = null;
    }
    if (seq !== monthReq) return;
    if (want.y !== state.cursor.y || want.m !== state.cursor.m) return;
    state.month = data;
    renderHeader();
    // Mid-fade the panel is on its way out; endFade() renders it once, with
    // this fresher state.month already in place.
    if (!fadeEventsPending) renderEvents();
  }

  function instancesForDay(sel) {
    if (!sel || !state.month || !state.month.instances) return [];
    const dayStart = new Date(sel.y, sel.m, sel.d, 0, 0, 0, 0).getTime();
    const dayEnd = new Date(sel.y, sel.m, sel.d, 23, 59, 59, 999).getTime();
    return state.month.instances.filter((i) =>
      i.allDay
        // All-day ends are exclusive: a one-day event ends at the next midnight.
        ? i.startMs <= dayEnd && i.endMs > dayStart
        // Timed ends are exclusive too, so an event that ends at 00:00 isn't on
        // the next day. One with no length still shows on the day it starts.
        : i.startMs <= dayEnd && (i.startMs >= dayStart || i.endMs > dayStart)
    );
  }

  // ---------------------------------------------------------------- render

  function renderHeader() {
    if (state.view === 'months') {
      el.label.textContent = String(state.cursor.y);
      el.prev.disabled = state.cursor.y <= MIN_YEAR;
      el.next.disabled = state.cursor.y >= MAX_YEAR;
    } else {
      el.label.textContent = MONTHS_LONG[state.cursor.m] + ' ' + state.cursor.y;
      el.prev.disabled = state.cursor.y <= MIN_YEAR && state.cursor.m === 0;
      el.next.disabled = state.cursor.y >= MAX_YEAR && state.cursor.m === 11;
    }

    const stale = !!(state.month && state.month.status &&
      Object.values(state.month.status).some((s) => s && s.stale));
    const existing = el.label.querySelector('.stale-dot');
    if (stale && !existing) {
      const dot = document.createElement('span');
      dot.className = 'stale-dot';
      dot.title = 'Showing cached calendar data';
      el.label.appendChild(dot);
    } else if (!stale && existing) {
      existing.remove();
    }
  }

  function renderDays() {
    el.grid.textContent = '';

    const y = state.cursor.y;
    const m = state.cursor.m;
    // Monday-start: getDay() is Sunday-based, so rotate it by one.
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    // Always six rows, so the grid height is constant and only the events panel
    // changes the window size.
    for (let row = 0; row < 6; row++) {
      const tr = document.createElement('tr');
      for (let col = 0; col < 7; col++) {
        const dayNum = row * 7 + col - offset + 1;
        const td = document.createElement('td');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day';

        if (dayNum < 1 || dayNum > daysInMonth) {
          btn.classList.add('blank');
          btn.tabIndex = -1;
        } else {
          btn.textContent = String(dayNum);
          btn.dataset.day = String(dayNum);
          const cell = { y: y, m: m, d: dayNum };
          if (sameDay(cell, state.today)) btn.classList.add('today');
          if (sameDay(cell, state.selected)) btn.classList.add('selected');
        }

        td.appendChild(btn);
        tr.appendChild(td);
      }
      el.grid.appendChild(tr);
    }
  }

  function renderMonthPicker() {
    el.monthGrid.textContent = '';
    for (let i = 0; i < 12; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'month-cell';
      btn.textContent = MONTHS_SHORT[i];
      if (state.cursor.y === state.today.y && i === state.today.m) {
        btn.classList.add('current');
      }
      const monthIndex = i;
      btn.addEventListener('click', function () { pickMonth(monthIndex); });
      el.monthGrid.appendChild(btn);
    }
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function addSection(parent, text) {
    const h = document.createElement('div');
    h.className = 'ev-section';
    h.textContent = text;
    parent.appendChild(h);
  }

  function addEvent(parent, inst) {
    const div = document.createElement('div');
    div.className = 'event';
    if (inst.color) div.style.setProperty('--cal-color', inst.color);
    // textContent only: summaries are external data, never treated as markup.
    div.textContent = inst.summary || '(no title)';
    if (inst.calName) div.title = inst.calName;
    parent.appendChild(div);
  }

  function collapseEvents() {
    el.events.classList.remove('has-content');
    // A drag that's under way would otherwise hold the empty panel open.
    el.eventsScroll.style.height = '';
    el.eventsScroll.style.maxHeight = '';
    // A refresh or midnight can empty the day mid-drag. With no list left to
    // size, the drag ends: losing capture runs endDrag.
    if (grab && el.grip.hasPointerCapture(grab.pointerId)) {
      el.grip.releasePointerCapture(grab.pointerId);
    }
    syncHeight();
  }

  function renderEvents() {
    const scroll = el.eventsScroll;
    scroll.textContent = '';

    // No selection, or nothing on that day, means the panel collapses away. So
    // does the month picker: the panel belongs to the day grid.
    if (!state.selected || state.view === 'months') {
      collapseEvents();
      return;
    }

    const list = instancesForDay(state.selected);
    if (!list.length) {
      collapseEvents();
      return;
    }

    el.events.classList.add('has-content');

    const allDay = list.filter((i) => i.allDay);
    const timed = list
      .filter((i) => !i.allDay)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    if (allDay.length) {
      addSection(scroll, 'All day');
      allDay.forEach((i) => addEvent(scroll, i));
    }

    // Events sharing an identical start AND end share one time header. Any
    // difference in either bound starts a new group.
    let i = 0;
    while (i < timed.length) {
      const s = timed[i].startMs;
      const e = timed[i].endMs;
      const group = [];
      while (i < timed.length && timed[i].startMs === s && timed[i].endMs === e) {
        group.push(timed[i]);
        i++;
      }
      addSection(scroll, e > s ? fmtTime(s) + ' - ' + fmtTime(e) : fmtTime(s));
      group.forEach((inst) => addEvent(scroll, inst));
    }

    applyListHeight();
    syncHeight();
  }

  const LIST_MIN = 60; // the shortest the list gets from its budget or a drag

  // Sizes the scroll area. The list fits its events up to a limit, then
  // scrolls. The limit keeps the whole widget within its height budget, or,
  // once the user has dragged the grip, it's the height they dropped it at, as
  // far as the work area allows. Mid-drag, the list takes the drag's height
  // exactly, even past its last event.
  function applyListHeight() {
    const scroll = el.eventsScroll;
    const top = scroll.scrollTop; // measuring at full length clamps it to 0
    scroll.style.height = '';
    scroll.style.maxHeight = 'none';
    const cardHeight = el.card.getBoundingClientRect().height;
    const scrollHeight = scroll.getBoundingClientRect().height;
    const chrome = cardHeight - scrollHeight; // everything that isn't the list
    if (grab && grab.moved) {
      scroll.style.height = grab.height + 'px';
    } else if (state.listHeight !== null) {
      const room = Math.max(LIST_MIN, Math.round(state.workAreaHeight - chrome));
      scroll.style.maxHeight = Math.min(state.listHeight, room) + 'px';
    } else {
      const budget = state.maxWidgetHeight - chrome;
      scroll.style.maxHeight = Math.max(LIST_MIN, Math.round(budget)) + 'px';
    }
    scroll.scrollTop = top;
  }

  // ---------------------------------------------------------------- cross-fade

  // A single clone of the outgoing grid fades out on top of the live one, which
  // stays fully opaque underneath. Cross-fading two half-opaque grids instead
  // would dip to 75% total alpha mid-way and read as a flicker.
  let fadeGhost = null;
  let fadeTimer = null;
  let fadeEventsPending = false;

  function makeGhost() {
    const ghost = el.daysTable.cloneNode(true);
    ghost.classList.add('days-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    // The clone carries a duplicate id="grid"; strip it before it enters the DOM.
    const body = ghost.querySelector('tbody');
    if (body) body.removeAttribute('id');
    // pointer-events:none stops clicks, but cloned buttons stay tabbable.
    const buttons = ghost.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) buttons[i].tabIndex = -1;
    return ghost;
  }

  function dropGhost() {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    if (!fadeGhost) return;
    fadeGhost.removeEventListener('transitionend', onFadeEnd);
    fadeGhost.remove();
    fadeGhost = null;
  }

  // Returns whether a renderEvents() was owed, so a burst of clicks collapses
  // into exactly one deferred render at the end of the last fade.
  function settleFade() {
    dropGhost();
    el.events.classList.remove('is-fading');
    const owed = fadeEventsPending;
    fadeEventsPending = false;
    return owed;
  }

  function endFade() {
    if (settleFade()) renderEvents();
  }

  // transitionend bubbles, and the cloned .day cells carry their own
  // transitions — so filter on both target and property.
  function onFadeEnd(e) {
    if (e.target !== fadeGhost || e.propertyName !== 'opacity') return;
    endFade();
  }

  function beginFade(ghost) {
    dropGhost();
    fadeGhost = ghost;
    el.daysStack.appendChild(ghost); // last child paints over the live grid
    if (el.events.classList.contains('has-content')) {
      el.events.classList.add('is-fading');
    }
    fadeEventsPending = true;
    void ghost.offsetWidth; // flush, same idiom as pin.js
    ghost.classList.add('is-out');
    ghost.addEventListener('transitionend', onFadeEnd);
    // Net for the case transitionend never arrives (hidden window, etc).
    fadeTimer = setTimeout(endFade, 400);
  }

  // Hiding the widget from the tray suspends transitions and throttles timers,
  // so transitionend may never arrive. Settle immediately rather than leaving a
  // stranded overlay for the next time the widget is shown.
  //
  // Only on the way out: firing on every visibility change would let an
  // incidental flicker (occlusion, focus) cut a fade short mid-flight.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) endFade();
  });

  // What is currently on screen, so we never fade when nothing actually changed.
  let painted = { view: null, y: null, m: null };

  function render(opts) {
    const isMonths = state.view === 'months';

    const fade = !!(opts && opts.animate)
      && !isMonths
      && painted.view === 'days'
      && (painted.y !== state.cursor.y || painted.m !== state.cursor.m)
      && !!el.grid.firstChild;

    const ghost = fade ? makeGhost() : null; // snapshot before the rebuild

    el.dayView.hidden = isMonths;
    el.monthView.hidden = !isMonths;
    renderHeader();
    if (isMonths) renderMonthPicker();
    else renderDays();

    if (ghost) {
      beginFade(ghost); // renderEvents() runs when the fade ends
    } else {
      settleFade();
      renderEvents();
    }

    painted = { view: state.view, y: state.cursor.y, m: state.cursor.m };
  }

  // ---------------------------------------------------------------- actions

  // Moves the ring by toggling one class, so the .day transition in calendar.css
  // actually gets a start value to animate from. Rebuilding the grid destroyed
  // the nodes, which meant the ring always appeared instantly.
  function paintSelection() {
    const sel = state.selected;
    const onMonth = !!sel && sel.y === state.cursor.y && sel.m === state.cursor.m;
    const cells = el.grid.querySelectorAll('.day');
    for (let i = 0; i < cells.length; i++) {
      const btn = cells[i];
      const isSel = onMonth && Number(btn.dataset.day) === sel.d;
      btn.classList.toggle('selected', isSel);
    }
  }

  function selectDay(d) {
    // The live grid is clickable mid-fade; snap the ghost away so the new ring
    // isn't hidden underneath it.
    settleFade();
    state.selected = { y: state.cursor.y, m: state.cursor.m, d: d };
    paintSelection();
    renderEvents();
  }

  function stepMonth(delta) {
    const next = new Date(state.cursor.y, state.cursor.m + delta, 1);
    const y = next.getFullYear();
    if (y < MIN_YEAR || y > MAX_YEAR) return;
    state.cursor = { y: y, m: next.getMonth() };
    state.selected = null; // navigating away clears the selection
    render({ animate: true });
    loadMonth();
  }

  // The month label can close the picker without a month being picked, which
  // shows the cursor month straight away. So a year step is a move like any
  // other: it clears the selection and loads the month it moved to, or the grid
  // would show the old month's events.
  function stepYear(delta) {
    const y = state.cursor.y + delta;
    if (y < MIN_YEAR || y > MAX_YEAR) return;
    state.cursor = { y: y, m: state.cursor.m };
    state.selected = null;
    render();
    loadMonth();
  }

  function goToToday() {
    state.today = todayParts();
    state.cursor = { y: state.today.y, m: state.today.m };
    state.selected = { y: state.today.y, m: state.today.m, d: state.today.d };
    state.view = 'days';
    render({ animate: true });
    loadMonth();
  }

  function pickMonth(m) {
    state.cursor = { y: state.cursor.y, m: m };
    state.view = 'days';
    state.selected = null; // picking a month leaves nothing selected
    render();
    loadMonth();
  }

  el.label.addEventListener('click', function () {
    state.view = state.view === 'days' ? 'months' : 'days';
    render();
  });
  // Delegated: #grid is only ever emptied, never replaced, so one listener here
  // outlives every render and saves rebinding 31 closures each time.
  el.grid.addEventListener('click', function (e) {
    const btn = e.target.closest('.day');
    if (!btn || !btn.dataset.day) return;
    selectDay(Number(btn.dataset.day));
  });

  el.todayBtn.addEventListener('click', goToToday);
  // Up = previous, down = next, as specified.
  el.prev.addEventListener('click', function () {
    if (state.view === 'months') stepYear(-1); else stepMonth(-1);
  });
  el.next.addEventListener('click', function () {
    if (state.view === 'months') stepYear(1); else stepMonth(1);
  });

  // ---------------------------------------------------------------- sizing

  // Width is fixed at 320 and tuned to the seven-column grid, so only height
  // is reported. The shared helper owns the ResizeObserver and Guard 1.
  const syncHeight = window.widgetAutosize
    ? window.widgetAutosize(el.card, { axes: 'height' })
    : Object.assign(function () {}, { hold: function () {}, release: function () {} });

  // ---------------------------------------------------------------- list grip

  // Dragging the grip sets how tall the events list may grow. The first move
  // past the slop holds the window open down to the bottom of the work area, so
  // the list follows the pointer with no size request to wait on. The drag
  // shows the exact height it sets, even past the last event, so the empty room
  // shows what a busier day can fit. On release the height is saved, and the
  // list eases back to fit its events before the window refits around the card:
  // the ease-back is what tells the user the height is a limit. A press that
  // never moves is a click and changes nothing, so a double-click, which puts
  // the list back on its budget, never stretches the window.
  const DRAG_SLOP = 3; // px a press can wander and still be a click
  const EASE_MS = 180;

  // { pointerId, startY, startHeight, chrome, maxHeight, moved, height }
  let grab = null;
  let settling = null; // the ease-back animation while it runs

  // Eases the list from the dropped height down to its events, if they're
  // shorter, and resolves once it's there. element.animate() rather than a CSS
  // transition: applyListHeight() rewrites the inline height to measure, and an
  // animation sits over the inline styles, so a re-render mid-ease can't strand
  // it. It also sits outside widget.css's reduced-motion override, so it checks
  // the setting itself and lands at once.
  function easeBack(from) {
    if (!el.events.classList.contains('has-content')) return Promise.resolve();
    applyListHeight(); // the dropped height is now the list's limit
    const to = el.eventsScroll.getBoundingClientRect().height;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (to >= from - 1 || reduce || !el.eventsScroll.animate) return Promise.resolve();
    const anim = el.eventsScroll.animate(
      [{ height: from + 'px' }, { height: to + 'px' }],
      { duration: EASE_MS, easing: 'ease-out' }
    );
    settling = anim;
    return new Promise(function (resolve) {
      // Net for a hidden window, where an animation may never finish.
      const timer = setTimeout(function () { anim.finish(); }, EASE_MS + 300);
      function done() {
        clearTimeout(timer);
        if (settling === anim) settling = null;
        resolve();
      }
      anim.finished.then(done, done);
    });
  }

  function startDrag() {
    const g = grab;
    g.moved = true;
    syncHeight.hold();
    document.documentElement.classList.add('is-resizing');
    el.grip.classList.add('is-dragging');
    if (!window.widgetAPI || !window.widgetAPI.beginResize) return;
    window.widgetAPI.beginResize().then(function (height) {
      if (grab !== g || !Number.isFinite(height)) return;
      g.maxHeight = Math.max(g.maxHeight, Math.floor(height - g.chrome));
    }).catch(function () {});
  }

  function endDrag(e) {
    if (!grab || e.pointerId !== grab.pointerId) return;
    const g = grab;
    grab = null;
    document.documentElement.classList.remove('is-resizing');
    el.grip.classList.remove('is-dragging');
    if (!g.moved) return;
    state.listHeight = g.height;
    // Saved before the window refits, because main only lets the widget past
    // its height budget once the list has a limit of its own. The window stays
    // held through the ease-back, or the list would be cut off as it eases.
    const saved = window.widgetAPI && window.widgetAPI.setListHeight
      ? window.widgetAPI.setListHeight(g.height).catch(function () {})
      : Promise.resolve();
    Promise.all([saved, easeBack(g.height)]).then(function () {
      // A new drag that already took hold keeps the window open for itself.
      if (!grab || !grab.moved) syncHeight.release();
    });
  }

  el.grip.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || grab) return;
    e.preventDefault();
    // A press mid-ease lands it at once, so the drag starts where the list is.
    if (settling) settling.finish();
    const list = el.eventsScroll.getBoundingClientRect().height;
    const chrome = el.card.getBoundingClientRect().height - list;
    grab = {
      pointerId: e.pointerId,
      startY: e.screenY,
      startHeight: list,
      chrome: chrome,
      // Until main holds the window open, the list can only use what's there.
      maxHeight: Math.max(list, Math.floor(window.innerHeight - chrome)),
      moved: false,
      height: Math.round(list),
    };
    el.grip.setPointerCapture(e.pointerId);
  });

  el.grip.addEventListener('pointermove', function (e) {
    if (!grab || e.pointerId !== grab.pointerId) return;
    const dy = e.screenY - grab.startY;
    if (!grab.moved) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      startDrag();
    }
    // A list already shorter than the floor can't be stretched to it in one jump.
    const floor = Math.min(LIST_MIN, grab.startHeight);
    grab.height = Math.round(Math.max(floor, Math.min(grab.startHeight + dy, grab.maxHeight)));
    el.eventsScroll.style.maxHeight = 'none';
    el.eventsScroll.style.height = grab.height + 'px';
  });

  // lostpointercapture also follows every pointerup, which endDrag ignores
  // because the grab is already over.
  el.grip.addEventListener('pointerup', endDrag);
  el.grip.addEventListener('pointercancel', endDrag);
  el.grip.addEventListener('lostpointercapture', endDrag);

  el.grip.addEventListener('dblclick', function () {
    if (state.listHeight === null) return;
    state.listHeight = null;
    if (window.widgetAPI && window.widgetAPI.setListHeight) {
      window.widgetAPI.setListHeight(null).catch(function () {});
    }
    // The card can change height, and the ResizeObserver refits the window.
    applyListHeight();
  });

  // ---------------------------------------------------------------- midnight

  // Moves the widget onto the new day. Split out from the timer so it can be
  // driven directly instead of waiting for an actual midnight.
  function rollToNewDay() {
    const prevToday = state.today;
    state.today = todayParts();

    // Leaving the widget sitting on today should keep it on today. A day the
    // user deliberately picked is left where they put it, so the selection
    // can't silently jump out from under them overnight.
    if (!sameDay(state.selected, prevToday)) {
      render();
      return;
    }

    state.selected = { y: state.today.y, m: state.today.m, d: state.today.d };
    // Rolling into a new month has to carry the grid with it, or the selected
    // day would sit outside the month on screen.
    const monthChanged =
      state.cursor.y !== state.today.y || state.cursor.m !== state.today.m;
    state.cursor = { y: state.today.y, m: state.today.m };
    render();
    if (monthChanged) loadMonth();
  }

  function scheduleMidnight() {
    const now = new Date();
    // Aim at the next actual local midnight rather than a fixed 24h interval,
    // which would drift across DST.
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    setTimeout(function () {
      rollToNewDay();
      scheduleMidnight();
    }, Math.max(1000, next.getTime() - now.getTime()));
  }

  // ---------------------------------------------------------------- init

  async function init() {
    if (window.widgetAPI) {
      try {
        const wa = await window.widgetAPI.getWorkArea();
        if (wa && wa.maxWidgetHeight) state.maxWidgetHeight = wa.maxWidgetHeight;
        if (wa && wa.height) state.workAreaHeight = wa.height;
      } catch {
        /* keep the default budget */
      }
      try {
        const h = await window.widgetAPI.getListHeight();
        if (Number.isFinite(h) && h > 0) state.listHeight = h;
      } catch {
        /* fit the events */
      }
      window.widgetAPI.onWorkAreaChanged(function (wa) {
        if (wa && wa.maxWidgetHeight) {
          state.maxWidgetHeight = wa.maxWidgetHeight;
          if (wa.height) state.workAreaHeight = wa.height;
          renderEvents();
        }
      });
    }

    if (window.calendarAPI) {
      window.calendarAPI.onUpdated(function () { loadMonth(); });
    }

    render();
    await loadMonth();
    scheduleMidnight();
  }

  // Exposed purely so the verification harness can drive the widget.
  window.__cal = {
    state: state, render: render, loadMonth: loadMonth,
    stepMonth: stepMonth, goToToday: goToToday, rollToNewDay: rollToNewDay,
    ghost: function () { return fadeGhost; },
  };

  init();
})();
