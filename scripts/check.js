// Static checks for the whole repository. CI runs this on every push and pull
// request; run it before pushing.
//
//   node scripts/check.js
//
// Plain Node, no Electron, no network. It checks the files a commit could
// include (tracked, plus untracked ones that aren't gitignored), so the
// gitignored credentials on a developer's machine are never opened.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const annotate = process.env.GITHUB_ACTIONS === 'true';

let failures = 0;

// Workflow-command escaping, so a message can't break the annotation syntax.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

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
      console.log('::error file=' + p.file + (p.line ? ',line=' + p.line : '') + '::' + escapeData(p.message));
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
// node --check parses each file the way Node loads it (CommonJS here).
const jsFiles = files.filter((f) => f.endsWith('.js'));
const jsProblems = [];
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = /^\w*Error: .*$/m.exec(r.stderr || '');
    jsProblems.push({ file: f, line: lineOf(r.stderr || ''), message: msg ? msg[0] : 'node --check failed' });
  }
}
report('JavaScript parses', jsProblems, jsFiles.length + ' files');

// ------------------------------------------------------------ inline scripts
// The clock and email widgets keep their code in inline <script> blocks, which
// node --check never sees. vm.Script compiles each block as a classic browser
// script without running it; lineOffset makes errors point at the HTML line.
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const inlineProblems = [];
let inlineBlocks = 0;
for (const f of htmlFiles) {
  const html = read(f);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || m[2].trim() === '') continue;
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

// Credential-equivalent values, wherever they appear. Messages never echo the
// match, because CI logs on a public repo are public too.
const SECRETS = [
  ['Google Calendar secret address', /\/private-[0-9a-f]{16,}\//],
  ['Canvas calendar feed address', /\/feeds\/calendars\/user_[A-Za-z0-9]{20,}/],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{10,}/],
  ['Google OAuth refresh token', /\b1\/\/0[A-Za-z0-9_-]{20,}/],
  ['Google OAuth access token', /\bya29\.[A-Za-z0-9_-]{20,}/],
];

const secretProblems = [];
for (const f of files) {
  if (PRIVATE_FILE.test(f)) {
    secretProblems.push({ file: f, message: 'credential or personal file is in the repo; remove it with git rm --cached' });
    continue;
  }
  const buf = fs.readFileSync(path.join(root, f));
  if (buf.subarray(0, 8000).includes(0)) continue; // binary, by git's own heuristic
  buf.toString('utf8').split('\n').forEach((text, i) => {
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

console.log('\n===== ' + (failures ? failures + ' problem(s) found' : 'all checks passed') + ' =====');
process.exit(failures ? 1 : 0);
