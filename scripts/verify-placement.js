// Offline checks for widget placement: anchors to screen edges and the fit that
// keeps a widget on a display.
//
//   node scripts/verify-placement.js
//
// No Electron, no fixture, so CI runs it in full. The displays below are shaped
// like screen.getAllDisplays(). The laptop is a 1920x1080 panel that Windows
// runs at 125% on one GPU and 100% on the other, with a 48 DIP taskbar.
const p = require('../src/main/placement');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    fail++;
    console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

const AT_125 = { id: 1, workArea: { x: 0, y: 0, width: 1536, height: 816 } };
const AT_100 = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
const LEFT_MONITOR = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
const TASKBAR_ON_TOP = { id: 3, workArea: { x: 0, y: 48, width: 1536, height: 816 } };

// --- the reported bug: a top-right calendar saved at 100%, reopened at 125% ---

const calendar = p.anchorFromRect({ x: 1563, y: 15, width: 274, height: 367 }, [AT_125]);
ok('off-screen calendar anchors to the top-right corner',
  same(calendar, { display: 1, right: 8, top: 15 }), show(calendar));

const at125 = p.fromAnchor(calendar, { width: 320, height: 367 }, [AT_125], 1);
ok('it opens fully on screen at 125%', same(at125, { x: 1208, y: 15, width: 320, height: 367 }), show(at125));

const at100 = p.fromAnchor(calendar, { width: 320, height: 367 }, [AT_100], 1);
ok('and stays in the corner at 100%', same(at100, { x: 1592, y: 15, width: 320, height: 367 }), show(at100));

const email = p.anchorFromRect({ x: 10, y: 505, width: 360, height: 300 }, [AT_125]);
ok('a bottom-left widget anchors to the bottom and left', same(email, { display: 1, left: 10, bottom: 11 }), show(email));
const email100 = p.fromAnchor(email, { width: 360, height: 300 }, [AT_100], 1);
ok('and keeps its gap above the taskbar at 100%', email100.x === 10 && email100.y === 721, show(email100));

// The clock was saved at 234x113 but reopens at the registry 260x260 before it
// measures itself. Its anchored edges hold, so it shrinks back to the old spot.
const clock = p.anchorFromRect({ x: 660, y: 321, width: 234, height: 113 }, [AT_125]);
const clockOpen = p.fromAnchor(clock, { width: 260, height: 260 }, [AT_125], 1);
const clockFitted = p.fromAnchor(clock, { width: 234, height: 113 }, [AT_125], 1);
ok('a widget refitting around its anchor returns to where it was',
  clockFitted.x === 660 && clockFitted.y === 321 && clockOpen.x === 634, show(clock) + ' ' + show(clockFitted));

// --- fitting ---

const inside = { x: 100, y: 100, width: 320, height: 300 };
ok('a rect already on screen is left alone', same(p.fitRect(inside, AT_125.workArea), inside));

const flush = p.fitRect({ x: 1300, y: 600, width: 236, height: 216 }, AT_125.workArea);
ok('the fit leaves EDGE_MARGIN on the right and bottom',
  flush.x === 1536 - p.EDGE_MARGIN - 236 && flush.y === 816 - p.EDGE_MARGIN - 216, show(flush));

const huge = p.fitRect({ x: 400, y: 300, width: 2000, height: 900 }, AT_125.workArea);
ok('a rect bigger than the screen keeps its top-left on screen', huge.x === 0 && huge.y === 0, show(huge));

const moved = p.fitRect({ x: -50, y: -20, width: 320, height: 300 }, AT_125.workArea);
ok('a rect past the left and top is pulled back in', moved.x === 0 && moved.y === 0, show(moved));

ok('the fit never resizes', huge.width === 2000 && huge.height === 900 && moved.width === 320);

// --- several displays ---

const both = [AT_125, LEFT_MONITOR];
const onLeft = p.anchorFromRect({ x: -1500, y: 100, width: 320, height: 300 }, both);
ok('a widget on a monitor left of the primary anchors to that monitor',
  same(onLeft, { display: 2, left: 420, top: 100 }), show(onLeft));
const backOnLeft = p.fromAnchor(onLeft, { width: 320, height: 300 }, both, 1);
ok('negative coordinates are kept, not pulled onto the primary', backOnLeft.x === -1500 && backOnLeft.y === 100, show(backOnLeft));

const unplugged = p.fromAnchor(onLeft, { width: 320, height: 300 }, [AT_125], 1);
ok('an unplugged monitor falls back to the primary', unplugged.x === 420 && unplugged.y === 100, show(unplugged));
ok('the fallback leaves the anchor naming its own monitor', onLeft.display === 2);

const stray = p.pickDisplay({ x: 4000, y: 100, width: 320, height: 300 }, both);
ok('a rect on no display picks the nearest one', stray.id === 1, 'picked ' + stray.id);

const spanning = p.pickDisplay({ x: -100, y: 100, width: 320, height: 300 }, both);
ok('a rect across two displays picks the one it covers most', spanning.id === 1, 'picked ' + spanning.id);

const topBar = p.fromAnchor({ display: 3, left: 20, top: 15 }, { width: 320, height: 300 }, [TASKBAR_ON_TOP], 3);
ok('anchors measure from the work area, past a taskbar on top', topBar.y === 63 && topBar.x === 20, show(topBar));

// --- anchors ---

const nearLeft = p.toAnchor({ x: 100, y: 500, width: 320, height: 200 }, AT_125);
ok('each axis anchors to its nearer edge', same(nearLeft, { display: 1, left: 100, bottom: 116 }), show(nearLeft));

const middle = p.toAnchor({ x: 608, y: 308, width: 320, height: 200 }, AT_125);
ok('a tie anchors left and top', 'left' in middle && 'top' in middle, show(middle));

ok('accepts one edge per axis', p.isAnchor({ display: 1, right: 8, top: 15 }));
ok('accepts an anchor with no display', p.isAnchor({ left: 0, bottom: 0 }));
const bad = [
  ['both horizontal edges', { left: 1, right: 2, top: 3 }],
  ['no vertical edge', { left: 1 }],
  ['a string distance', { left: '8', top: 15 }],
  ['a NaN distance', { left: NaN, top: 15 }],
  ['old absolute coordinates', { x: 1563, y: 15 }],
  ['null', null],
  ['undefined', undefined],
];
for (const [label, a] of bad) ok('rejects ' + label, !p.isAnchor(a));

// --- rounding tolerance ---

const placed = { x: 1208, y: 15, width: 320, height: 120 };
ok('Windows rounding still counts as in place', p.closeTo(placed, { x: 1208, y: 14, width: 320, height: 121 }));
ok('a real move does not', !p.closeTo(placed, { x: 1208, y: 15 + p.DRIFT + 1, width: 320, height: 120 }));

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
