// Offline checks for the Gmail request URLs, message-id validation and how the
// refresh token is stored.
//
//   node scripts/verify-gmail.js
//
// No Electron (a stand-in serves auth.js), no network, no fixture, so CI runs
// it in full. Message ids come
// out of an API response; these pin down that an id which reaches a request
// can only name one message under /messages/.
const { isMessageId, listUrl, detailUrl } = require('../src/main/gmail/urls');

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

const MESSAGES = '/gmail/v1/users/me/messages';
const ID = '18c5a3b2f1e4d7a9';

ok('accepts a Gmail id', isMessageId(ID));
const hostile = [
  ['path, query and fragment', 'a/b?x=1#f'],
  ['a dot-dot segment', '..'],
  ['a dot segment', '.'],
  ['an empty id', ''],
  ['a lone surrogate', '\ud800'],
  ['a missing id', undefined],
  ['a non-string id', 123],
];
for (const [label, id] of hostile) ok('rejects ' + label, !isMessageId(id));

const detail = new URL(detailUrl(ID));
ok('detail URL is one segment under /messages/', detail.pathname === MESSAGES + '/' + ID, detail.pathname);
ok('detail URL asks for metadata only',
  detail.searchParams.get('format') === 'metadata' &&
  detail.searchParams.getAll('metadataHeaders').join() === 'From,Subject,Date', detail.search);

// isMessageId keeps these out, but the builder still escapes on its own.
const escaped = new URL(detailUrl('a/b?x=1#f'));
ok('detail URL escapes an unchecked id', escaped.pathname === MESSAGES + '/a%2Fb%3Fx%3D1%23f' &&
  escaped.search === detail.search && escaped.hash === '', escaped.pathname);

const list = new URL(listUrl({ maxMessages: 25, query: 'in:inbox is:unread &x=1' }));
ok('list URL carries the count and the whole query',
  list.pathname === MESSAGES &&
  list.searchParams.get('maxResults') === '25' &&
  list.searchParams.get('q') === 'in:inbox is:unread &x=1' &&
  [...list.searchParams.keys()].join() === 'maxResults,q', list.search);

// --- refresh token at rest ---------------------------------------------------
// auth.js runs against a stand-in electron: a userData folder in the OS temp
// dir and a safeStorage whose "ciphertext" is the string reversed behind a
// prefix. Each decrypt can be held open, which is how a Connect or Disconnect
// is made to land while init() waits on one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-gmail-'));
const TOKEN = path.join(userData, 'gmail-token.bin');
const safe = { reEncrypt: false, hold: null };
const enc = (s) => Buffer.from('enc:' + [...s].reverse().join(''));
const electron = {
  app: { getPath: () => userData },
  shell: {},
  net: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => enc(s),
    decryptStringAsync: async (buf) => {
      if (safe.hold) await safe.hold;
      const text = buf.toString();
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return { result: [...text.slice(4)].reverse().join(''), shouldReEncrypt: safe.reEncrypt };
    },
  },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : realLoad.call(this, request, ...rest);
};
const AUTH = require.resolve('../src/main/gmail/auth');
function freshAuth() {
  delete require.cache[AUTH];
  return require(AUTH);
}
function reset(stored) {
  for (const f of fs.readdirSync(userData)) fs.unlinkSync(path.join(userData, f));
  if (stored != null) fs.writeFileSync(TOKEN, enc(stored));
  safe.reEncrypt = false;
  safe.hold = null;
}
function held() {
  let release;
  safe.hold = new Promise((r) => { release = r; });
  return release;
}
const quiet = (fn) => async () => {
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
};

async function tokenSuite() {
  reset('old-refresh-token');
  let auth = freshAuth();
  await auth.init();
  ok('init reads a stored token as connected', auth.isConnected());

  // Re-encrypt rewrites through a temp file and a rename.
  reset('old-refresh-token');
  safe.reEncrypt = true;
  auth = freshAuth();
  await auth.init();
  ok('re-encrypt keeps the token readable and connected',
    auth.isConnected() && fs.readFileSync(TOKEN).equals(enc('old-refresh-token')));
  ok('re-encrypt leaves no temp file', fs.readdirSync(userData).join() === 'gmail-token.bin',
    fs.readdirSync(userData).join());

  // The rewrite is optional: the old file still decrypts, so failing to write
  // it must not report the token gone.
  reset('old-refresh-token');
  safe.reEncrypt = true;
  auth = freshAuth();
  const write = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).startsWith(TOKEN)) throw new Error('ENOSPC: disk full');
    return write(p, ...rest);
  };
  try { await quiet(() => auth.init())(); } finally { fs.writeFileSync = write; }
  ok('a failed re-encrypt write stays connected', auth.isConnected());

  // A rename that fails leaves the old token whole and no temp file behind.
  reset('old-refresh-token');
  safe.reEncrypt = true;
  auth = freshAuth();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('EBUSY: locked'); };
  try { await quiet(() => auth.init())(); } finally { fs.renameSync = rename; }
  ok('a failed rename stays connected', auth.isConnected());
  ok('a failed rename leaves the old token whole',
    fs.readFileSync(TOKEN).equals(enc('old-refresh-token')));
  ok('a failed rename removes its temp file', fs.readdirSync(userData).join() === 'gmail-token.bin',
    fs.readdirSync(userData).join());

  // Finding 2: a Disconnect while init() decrypts wins, and the token stays gone.
  reset('old-refresh-token');
  safe.reEncrypt = true;
  auth = freshAuth();
  let release = held();
  let starting = auth.init();
  await new Promise((r) => setImmediate(r));
  auth.disconnect();
  release();
  await starting;
  ok('a Disconnect during init stays disconnected', !auth.isConnected());
  ok('a Disconnect during init is not undone by the re-encrypt', !fs.existsSync(TOKEN));
}

tokenSuite().catch((err) => ok('token suite ran', false, err && err.message)).finally(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
});
