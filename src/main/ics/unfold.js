// RFC 5545 line unfolding.
//
// This must run over the WHOLE file before anything is parsed. Google folds at
// ~75 chars without regard for structure, so a fold can land inside a parameter
// list — real exports contain ATTENDEE lines whose first physical line has no
// colon at all. Parsing physical lines individually silently drops those.
function unfold(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const physical = text.split(/\r\n|\r|\n/);
  const logical = [];

  for (const line of physical) {
    if (line === '') continue;
    // A continuation begins with a single space or tab; both are legal.
    if ((line[0] === ' ' || line[0] === '\t') && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

module.exports = { unfold };
