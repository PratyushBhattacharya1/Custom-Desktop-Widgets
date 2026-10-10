// Where a widget window goes, worked out against the displays' work areas.
//
// A saved position is an anchor, not a coordinate: how far the widget sits from
// the nearer horizontal and the nearer vertical edge of its display's work area,
// e.g. { display: 1879209626, fingerprint: 'internal:1920x1080', right: 8, top: 15 }.
// Absolute coordinates broke on a laptop whose panel Windows runs at 100% on one
// GPU and 125% on the other, so the desktop is 1920 DIP wide one session and
// 1536 the next. A corner spot saved at one scale was past the screen edge at
// the other, and nothing moved it back. An anchor keeps a corner widget in its
// corner at any scale.
//
// Everything here is pure (no electron) so scripts/verify-placement.js can run
// it in plain Node. `displays` is the shape screen.getAllDisplays() returns:
// [{ id, workArea: { x, y, width, height }, size, scaleFactor, internal }]. Only
// id and workArea are required.

// How far a window may sit from where it was put and still count as there. At
// 125% a DIP coordinate rarely lands on a whole pixel: Windows rounds it, and
// getBounds() hands back y 14 for a setBounds() of y 15, or height 121 for 120.
const DRIFT = 2;

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Squared distance from the rect's centre to the nearest point of the area.
function distanceSq(rect, area) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width));
  const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height));
  return dx * dx + dy * dy;
}

// The display the rect overlaps most or, when it overlaps none (its monitor was
// unplugged, or the desktop shrank), the one nearest to it.
function pickDisplay(rect, displays) {
  let best = null;
  let bestOverlap = 0;
  for (const d of displays) {
    const o = overlapArea(rect, d.workArea);
    if (o > bestOverlap) {
      best = d;
      bestOverlap = o;
    }
  }
  if (best) return best;
  return displays.reduce((a, b) => (distanceSq(rect, b.workArea) < distanceSq(rect, a.workArea) ? b : a));
}

// Moves the rect, never resizes it, until it lies inside the area. Sizing is
// applySize's job. The fit is the same on every side, so a widget can sit flush
// against any edge. A rect too big for the area keeps its top-left corner on
// screen, and the rest hangs off the right or bottom.
function fitRect(rect, area) {
  const x = Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width));
  const y = Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height));
  return { x: Math.round(x), y: Math.round(y), width: rect.width, height: rect.height };
}

// Exactly one horizontal and one vertical edge, as finite numbers. Anything else
// (a hand edit, a file from an older build) is not an anchor.
function isAnchor(a) {
  if (!a || typeof a !== 'object') return false;
  const has = (k) => Number.isFinite(a[k]);
  return has('left') !== has('right') && has('top') !== has('bottom');
}

// A display's physical size and whether it's built in. Windows can hand the same
// monitor a new id (a GPU switch or a dock can renumber its outputs), so an
// anchor carries this too, to recognise its monitor without the id. Undefined
// for a display that doesn't report its size and scale.
function fingerprint(display) {
  if (!display.size || !Number.isFinite(display.scaleFactor)) return undefined;
  const w = Math.round(display.size.width * display.scaleFactor);
  const h = Math.round(display.size.height * display.scaleFactor);
  return (display.internal ? 'internal:' : 'external:') + w + 'x' + h;
}

// Describes the rect by its distance from the nearer edge on each axis. A rect
// too big for the area has a negative distance to its far edge, which would pin
// it to that edge once it shrinks, so it anchors to its left or top instead.
function toAnchor(rect, display) {
  const area = display.workArea;
  const left = rect.x - area.x;
  const right = area.x + area.width - (rect.x + rect.width);
  const top = rect.y - area.y;
  const bottom = area.y + area.height - (rect.y + rect.height);
  const anchor = { display: display.id };
  const print = fingerprint(display);
  if (print) anchor.fingerprint = print;
  if (right < 0 || left <= right) anchor.left = Math.round(left);
  else anchor.right = Math.round(right);
  if (bottom < 0 || top <= bottom) anchor.top = Math.round(top);
  else anchor.bottom = Math.round(bottom);
  return anchor;
}

// Anchors a rect to the display it's mostly on, after pulling it fully onto
// that display. Used for a drag the user just finished and for a position saved
// as plain coordinates by an older build.
function anchorFromRect(rect, displays) {
  const display = pickDisplay(rect, displays);
  return toAnchor(fitRect(rect, display.workArea), display);
}

// The anchor's own display. Failing that (unplugged, or back under a new id),
// the one display with the anchor's fingerprint, and otherwise the primary. The
// anchor keeps the original id, so the widget goes back once it's plugged in.
function anchorDisplay(anchor, displays, primaryId) {
  const alike = displays.filter((d) => anchor.fingerprint && fingerprint(d) === anchor.fingerprint);
  return (
    displays.find((d) => d.id === anchor.display) ||
    (alike.length === 1 && alike[0]) ||
    displays.find((d) => d.id === primaryId) ||
    displays[0]
  );
}

// The on-screen rect for an anchor at a given size.
function fromAnchor(anchor, size, displays, primaryId) {
  const area = anchorDisplay(anchor, displays, primaryId).workArea;
  const x = Number.isFinite(anchor.left)
    ? area.x + anchor.left
    : area.x + area.width - anchor.right - size.width;
  const y = Number.isFinite(anchor.top)
    ? area.y + anchor.top
    : area.y + area.height - anchor.bottom - size.height;
  return fitRect({ x, y, width: size.width, height: size.height }, area);
}

// Where a widget goes when its size changes from oldSize to size, and its anchor
// afterwards. Width grows away from the anchored edge, so a clock in a right-hand
// corner stays in it. Height always grows down from the current top and moves up
// only as far as the work area forces it: the calendar's header and day grid are
// at its top, so they hold still under the cursor while its events panel opens
// and closes. The vertical edge is then picked again from where the widget ended
// up, so placing it from the new anchor gives the same rect.
function resize(anchor, oldSize, size, displays, primaryId) {
  const display = anchorDisplay(anchor, displays, primaryId);
  const x = fromAnchor(anchor, size, displays, primaryId).x;
  const y = fromAnchor(anchor, oldSize, displays, primaryId).y;
  const rect = fitRect({ x, y, width: size.width, height: size.height }, display.workArea);
  const picked = toAnchor(rect, display);
  const next = { ...anchor };
  delete next.top;
  delete next.bottom;
  if ('top' in picked) next.top = picked.top;
  else next.bottom = picked.bottom;
  return { rect, anchor: next };
}

// True when two rects differ by no more than Windows' rounding.
function closeTo(a, b) {
  return (
    Math.abs(a.x - b.x) <= DRIFT &&
    Math.abs(a.y - b.y) <= DRIFT &&
    Math.abs(a.width - b.width) <= DRIFT &&
    Math.abs(a.height - b.height) <= DRIFT
  );
}

module.exports = {
  DRIFT,
  pickDisplay, fitRect, isAnchor, toAnchor, anchorFromRect, anchorDisplay, fromAnchor, resize, closeTo,
};
