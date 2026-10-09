// Offline checks for the Gmail request URLs and message-id validation.
//
//   node scripts/verify-gmail.js
//
// No Electron, no network, no fixture, so CI runs it in full. Message ids come
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

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
