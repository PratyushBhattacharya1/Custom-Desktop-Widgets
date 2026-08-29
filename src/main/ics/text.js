// Unescapes an RFC 5545 TEXT value.
//
// Must be a single left-to-right pass, NOT chained .replace() calls. Replacing
// the backslash escape first and then the \n escape turns a literal
// "backslash followed by the letter n" into a newline, which is wrong.
const BACKSLASH = String.fromCharCode(92);

function unescapeText(value) {
  if (value.indexOf(BACKSLASH) === -1) return value;

  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== BACKSLASH || i + 1 >= value.length) {
      out += c;
      continue;
    }
    const next = value[++i];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === BACKSLASH) out += BACKSLASH;
    else if (next === ',') out += ',';
    else if (next === ';') out += ';';
    else out += next; // unknown escape: keep the character as-is
  }
  return out;
}

module.exports = { unescapeText };
