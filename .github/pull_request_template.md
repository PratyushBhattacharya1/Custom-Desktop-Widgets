Closes #

## What and why

<!-- The behaviour change and the reasoning. Mention rejected approaches if they explain the design. -->

## Verification

<!-- How you checked it. Keep what applies, delete the rest. -->

- [ ] `node scripts/check.js`
- [ ] `node scripts/verify-ics.js` against the calendar export (changes under `src/main/ics/`)
- [ ] `node scripts/mutate-ics.js` (changes under `src/main/ics/`, `test/fixtures/` or the ICS scripts)
- [ ] Posted a verdict on every ECC Tools and CodeQL finding: fixed, issue opened, or why it doesn't apply
- [ ] `npm start`, then exercised the affected widget
- [ ] Updated `docs/privacy.md` (OAuth scopes or stored data changed)
- [ ] Updated `AGENTS.md` (architecture, invariants or workflow changed)
