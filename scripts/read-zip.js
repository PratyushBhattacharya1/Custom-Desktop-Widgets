// Minimal ZIP reader built on Node's zlib. Dev-only: used by verify-ics.js to
// read the sample calendar export. Production fetches .ics over HTTPS and never
// touches a zip, so this deliberately isn't a dependency of the app.
//
// Supports stored (method 0) and deflated (method 8) entries, which is all a
// Google Calendar export produces.
const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEndOfCentralDirectory(buf) {
  // The EOCD record is at the end, after a comment of up to 64KB.
  const minPos = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) throw new Error('Not a zip file (no EOCD record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Re-read lengths from the local header: they're authoritative for data start.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${method} for ${name}`);

    entries.push({ name, text: content.toString('utf8'), bytes: content.length });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

module.exports = { readEntries };
