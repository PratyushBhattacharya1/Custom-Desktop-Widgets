// Builds the Gmail API request URLs and decides which message ids may go in one.
//
// Kept apart from service.js, which needs Electron to load, so that
// scripts/verify-gmail.js can check it in plain Node.
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// metadata format carries the snippet and labelIds without the body, which is
// all the widget shows and keeps each response small.
const DETAIL_QUERY = new URLSearchParams([
  ['format', 'metadata'],
  ['metadataHeaders', 'From'],
  ['metadataHeaders', 'Subject'],
  ['metadataHeaders', 'Date'],
]).toString();

// Gmail ids are short hex strings. Ids come out of an API response, so they are
// checked rather than only escaped: percent-encoding leaves "." and ".." to be
// read as dot-segments, and throws on a lone surrogate. This admits any
// URL-safe token but no ".", so a passing id is always one ordinary segment.
function isMessageId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

function listUrl(cfg) {
  const params = new URLSearchParams({ maxResults: cfg.maxMessages, q: cfg.query });
  return API + '/messages?' + params.toString();
}

// Only for ids that passed isMessageId. The encoding is then a no-op, but it
// keeps the id escaped as one path segment where the URL is built.
function detailUrl(id) {
  return API + '/messages/' + encodeURIComponent(id) + '?' + DETAIL_QUERY;
}

module.exports = { isMessageId, listUrl, detailUrl };
