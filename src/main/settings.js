// Per-widget appearance settings: the catalogue of allowed values, the
// sanitising reader, and the composer that turns a stored setting into the CSS
// values a renderer applies.
//
// Lives in its own module rather than beside the WIDGETS array in main.js
// because ipc.js needs it and main.js requires ipc.js — putting it in main.js
// would make the require cycle back on itself.
const store = require('./store');

// Dark only, deliberately. The calendar's chrome (weekday strip, day hover,
// today pill, month cells, scrollbar) is hardcoded white-on-dark, so a light
// card would make all of it invisible. Light presets want a --chrome-* pass
// first; --card-fg already carries the value that pass would flip.
const BACKGROUNDS = {
  charcoal: { label: 'Charcoal', rgb: [20, 20, 25], fg: '#ffffff' }, // the original
  slate: { label: 'Slate', rgb: [38, 46, 60], fg: '#ffffff' },
  midnight: { label: 'Midnight', rgb: [12, 20, 46], fg: '#ffffff' },
  forest: { label: 'Forest', rgb: [18, 40, 32], fg: '#ffffff' },
  plum: { label: 'Plum', rgb: [40, 20, 44], fg: '#ffffff' },
  ember: { label: 'Ember', rgb: [48, 26, 20], fg: '#ffffff' },
};

// Exact binary fractions, so they survive a JSON round-trip and compare safely.
const OPACITY_STEPS = [0, 0.25, 0.5, 0.75, 1];

const SIZES = {
  small: { label: 'Small', scale: 0.8 },
  medium: { label: 'Medium', scale: 1 },
  large: { label: 'Large', scale: 1.3 },
};

const DEFAULTS = {
  background: 'charcoal',
  opacity: 0.5,
  showPin: true,
  size: 'medium',
};

// Scaling type only works where the window refits itself around the result.
// The calendar's 320px width is tuned to its seven-column grid and the email
// widget is a fixed-size placeholder, so neither offers Size.
const CAPABILITIES = {
  clock: { size: true },
  calendar: { size: false },
  email: { size: false },
};

function capabilities(id) {
  return CAPABILITIES[id] || { size: false };
}

// Every read passes through here, so a hand-edited or older config can never
// leave a widget in a state the menu has no item for.
function settingsFor(id) {
  const saved = store.get(id).settings;
  if (!saved || typeof saved !== 'object') return { ...DEFAULTS };
  return {
    background: BACKGROUNDS[saved.background] ? saved.background : DEFAULTS.background,
    opacity: OPACITY_STEPS.indexOf(saved.opacity) !== -1 ? saved.opacity : DEFAULTS.opacity,
    showPin: typeof saved.showPin === 'boolean' ? saved.showPin : DEFAULTS.showPin,
    size: SIZES[saved.size] ? saved.size : DEFAULTS.size,
  };
}

// store.patch merges shallowly, so writing a partial { settings: { ... } } would
// replace the whole object and silently drop its siblings. Always write the
// full sanitised set.
function setSetting(id, key, value) {
  const next = { ...settingsFor(id), [key]: value };
  store.patch(id, { settings: next });
  return settingsFor(id);
}

function reset(id) {
  store.patch(id, { settings: { ...DEFAULTS } });
  return settingsFor(id);
}

// Main owns the composition so renderers never duplicate the preset table.
function composeFor(id) {
  const s = settingsFor(id);
  const preset = BACKGROUNDS[s.background];
  const light = preset.fg !== '#ffffff';
  return {
    cardBg: `rgba(${preset.rgb.join(', ')}, ${s.opacity})`,
    cardFg: preset.fg,
    // Opacity dims the card, never the text — otherwise 0% would make a widget
    // invisible and recoverable only from the tray. Below half, a halo in the
    // opposite polarity keeps the text findable over busy wallpaper.
    cardHalo: s.opacity >= 0.5
      ? 'none'
      : light
        ? '0 1px 4px rgba(255, 255, 255, 0.8)'
        : '0 1px 4px rgba(0, 0, 0, 0.65)',
    scale: SIZES[s.size].scale,
    showPin: s.showPin,
    pinned: Boolean(store.get(id).pinned),
  };
}

module.exports = {
  BACKGROUNDS,
  OPACITY_STEPS,
  SIZES,
  DEFAULTS,
  capabilities,
  settingsFor,
  setSetting,
  reset,
  composeFor,
};
