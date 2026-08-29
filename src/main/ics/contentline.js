// Splits one unfolded logical line into { name, params, value }.
//
// The colon split must ignore colons inside quoted parameter values
// (CN="Smith, John:x"), and must take only the FIRST unquoted colon — SUMMARY
// values legitimately contain bare colons ("Theater of War: Hector...").
function parseLine(line) {
  let inQuotes = false;
  let colon = -1;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Split the head on unquoted semicolons.
  const segments = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"') {
      q = !q;
      cur += c;
    } else if (c === ';' && !q) {
      segments.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  segments.push(cur);

  const params = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf('=');
    if (eq === -1) continue;
    const key = segments[i].slice(0, eq).toUpperCase();
    let val = segments[i].slice(eq + 1);
    if (val.length > 1 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1);
    }
    params[key] = val;
  }

  return { name: segments[0].toUpperCase().trim(), params, value };
}

module.exports = { parseLine };
