// Static checks for the whole repository. CI runs this on every pull request
// and every push to main, not on other branch pushes; run it before pushing.
//
//   node scripts/check.js
//
// Plain Node, no Electron, no network. It checks the files a commit could
// include (tracked, plus untracked ones that aren't gitignored), so the
// gitignored credentials on a developer's machine are never opened.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const annotate = process.env.GITHUB_ACTIONS === 'true';

let failures = 0;

// Workflow-command escaping, so a message can't break the annotation syntax.
// Properties such as file= also need `:` and `,`, which separate them.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function report(name, problems, detail) {
  if (problems.length === 0) {
    console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
    return;
  }
  failures += problems.length;
  console.log('FAIL  ' + name);
  for (const p of problems) {
    console.log('      ' + p.file + (p.line ? ':' + p.line : '') + '  ' + p.message);
    // An annotation pins the failure to its line in the PR's diff view.
    if (annotate) {
      console.log('::error file=' + escapeProperty(p.file) + (p.line ? ',line=' + p.line : '') + '::' + escapeData(p.message));
    }
  }
}

// `git ls-files` also lists files deleted in the working tree but not yet
// staged, so drop anything that no longer exists.
const files = [...new Set(
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && fs.existsSync(path.join(root, f)))
)];
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lineOf = (text) => (/:(\d+)\r?\n/.exec(text) || [])[1];

// ---------------------------------------------------------------- JavaScript
// Compiled in-process without running, rather than a node --check process per
// file. Files under widgets/ are classic browser scripts, so vm.Script compiles
// them the way Chromium does: a top-level `return`, which CommonJS accepts, is
// an error there. Everything else is CommonJS, which Node's loader wraps in a
// function, and compileFunction does the same.
const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];
const jsFiles = files.filter((f) => f.endsWith('.js'));
const jsProblems = [];
for (const f of jsFiles) {
  try {
    if (f.startsWith('widgets/')) new vm.Script(read(f), { filename: f });
    else vm.compileFunction(read(f), CJS_PARAMS, { filename: f });
  } catch (err) {
    jsProblems.push({ file: f, line: lineOf(err.stack || ''), message: err.name + ': ' + err.message });
  }
}
report('JavaScript parses', jsProblems, jsFiles.length + ' files');

// ------------------------------------------------------------ inline scripts
// The clock and email widgets keep their code in inline <script> blocks, which
// the .js pass never sees. vm.Script compiles each block as a classic browser
// script without running it; lineOffset makes errors point at the HTML line.
// Only classic scripts are compiled: vm.Script can't parse a module, and JSON,
// importmap and template blocks aren't JavaScript. Attribute names must start
// after whitespace, so data-src= isn't mistaken for src=. A browser ends the
// block at any </script followed by whitespace, / or >, even </script foo>.
const CLASSIC_TYPE = /^\s*(?:(?:text|application)\/(?:java|ecma)script)?\s*$/i;
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const inlineProblems = [];
let inlineBlocks = 0;
for (const f of htmlFiles) {
  const html = read(f);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(m[1]) || m[2].trim() === '') continue;
    const type = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[1]);
    if (type && !CLASSIC_TYPE.test(type[1] ?? type[2] ?? type[3])) continue;
    inlineBlocks++;
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const startLine = html.slice(0, bodyStart).split('\n').length;
    try {
      new vm.Script(m[2], { filename: f, lineOffset: startLine - 1 });
    } catch (err) {
      inlineProblems.push({ file: f, line: lineOf(err.stack || ''), message: err.name + ': ' + err.message });
    }
  }
}
report('Inline scripts parse', inlineProblems, inlineBlocks + ' blocks in ' + htmlFiles.length + ' pages');

// ---------------------------------------------------------------------- JSON
// The example configs are what a new user copies, so a broken one breaks setup.
const jsonFiles = files.filter((f) => f.endsWith('.json'));
const jsonProblems = [];
for (const f of jsonFiles) {
  try {
    JSON.parse(read(f));
  } catch (err) {
    jsonProblems.push({ file: f, message: err.message });
  }
}
report('JSON parses', jsonProblems, jsonFiles.length + ' files');

// ------------------------------------------------------------------- secrets
// .gitignore keeps these out of `git add`, but not out of `git add -f`.
const PRIVATE_FILE = /(^|\/)(calendars|gmail)\.local\.json$|\.ics$|\.ical\.zip$/i;
// A synthetic calendar committed as a parser test fixture is allowed. The
// content scan below still checks it for secret addresses, and the fixture
// scan after it checks that its events are made up.
const FIXTURE_ICS = /^test\/fixtures\/.+\.ics$/i;

// Credential-equivalent values, wherever they appear. Messages never echo the
// match, because CI logs on a public repo are public too.
const SECRETS = [
  ['Google Calendar secret address', /\/private-[0-9a-f]{16,}\//],
  ['Canvas calendar feed address', /\/feeds\/calendars\/user_[A-Za-z0-9]{20,}/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ['Google OAuth refresh token', /\b1\/\/0[A-Za-z0-9_-]{20,}/],
  ['Google OAuth access token', /\bya29\.[A-Za-z0-9_-]{20,}/],
];

// A file's text, or null for a binary file, by git's own heuristic. UTF-16
// text is full of NULs, so check for its BOM before the binary test. Notepad's
// "Unicode" encoding and Windows PowerShell 5.1's `>` write it.
function textOf(f) {
  const buf = fs.readFileSync(path.join(root, f));
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(0, buf.length & ~1)).swap16().toString('utf16le');
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

const secretProblems = [];
for (const f of files) {
  if (PRIVATE_FILE.test(f) && !FIXTURE_ICS.test(f)) {
    secretProblems.push({ file: f, message: 'credential or personal file is in the repo; remove it with git rm --cached' });
    continue;
  }
  const content = textOf(f);
  if (content === null) continue;
  content.split('\n').forEach((text, i) => {
    for (const [name, re] of SECRETS) {
      if (re.test(text)) secretProblems.push({ file: f, line: i + 1, message: name + ' (value not printed)' });
    }
  });
}
report('No secrets or personal data', secretProblems, files.length + ' files');
if (secretProblems.length) {
  console.log('\nA secret that has been pushed is already public. Rotate it (reset the calendar\'s');
  console.log('secret address, or the OAuth client secret); deleting the commit does not revoke it.');
}

// ------------------------------------------------------------------ fixtures
// .gitignore lets test/fixtures/*.ics through for the synthetic calendar, which
// means `git add .` also stages a real export saved there, and one without a
// secret feed address passes the scan above. Every event has a UID and a real
// one never ends in @fixture.invalid, so the UID rule catches any export; the
// address rule catches a real attendee copied into a made-up event. Lines are
// unfolded first, so a fold can't split an address out of reach. The UIDs'
// domain is allowed as an address too: .invalid is reserved, so no mailbox can
// be there.
const FIXTURE_DOMAINS = new Set(['example.com', 'fixture.invalid']);
const ADDRESS = /[\w.%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;

const fixtures = files.filter((f) => FIXTURE_ICS.test(f));
const fixtureProblems = [];
for (const f of fixtures) {
  const content = textOf(f);
  if (content === null) {
    fixtureProblems.push({ file: f, message: 'not a text file, so its events can\'t be checked' });
    continue;
  }
  // Each logical line keeps the number of its first physical line.
  const lines = [];
  content.split(/\r\n|\r|\n/).forEach((text, i) => {
    if ((text[0] === ' ' || text[0] === '\t') && lines.length) lines[lines.length - 1].text += text.slice(1);
    else lines.push({ line: i + 1, text });
  });
  for (const { line, text } of lines) {
    if (/^UID[;:]/i.test(text) && !text.endsWith('@fixture.invalid')) {
      fixtureProblems.push({ file: f, line, message: 'UID does not end in @fixture.invalid (value not printed)' });
    } else if ([...text.matchAll(ADDRESS)].some((m) => !FIXTURE_DOMAINS.has(m[1].toLowerCase()))) {
      fixtureProblems.push({ file: f, line, message: 'email address outside example.com (value not printed)' });
    }
  }
}
report('Fixtures hold only made-up events', fixtureProblems, fixtures.length + (fixtures.length === 1 ? ' file' : ' files'));
if (fixtureProblems.length) {
  console.log('\nA real calendar export doesn\'t belong in test/fixtures/. Fixture events are made up,');
  console.log('with UIDs ending in @fixture.invalid and addresses at example.com.');
}

console.log('\n===== ' + (failures ? failures + ' problem(s) found' : 'all checks passed') + ' =====');
process.exit(failures ? 1 : 0);
