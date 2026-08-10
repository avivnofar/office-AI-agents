#!/usr/bin/env node
/**
 * scripts/verify-lifecycle-ingest.js
 *
 * `scripts/lifecycle.mjs` is a pure CLI script (no exports — `process.exit(main(...))`
 * at its own bottom) and `scripts/verify-lifecycle.js` deliberately never imports it —
 * that file's own header says it tests `workers/deliverable-lifecycle.js`'s PURE logic
 * only, no fs, no JSON import, no warehouse token. That left the one thing an operator
 * actually runs — `lifecycle.mjs ingest`, the command that reads a real inbox file and
 * writes a real STATE.json — with NO automated coverage at all. By this project's own
 * verdict language (docs/CAPABILITY-TOOLBOX.md), the ingest command's refusal behaviour
 * was UNPROVEN: exercised exactly once in production (G3's dismissal, C3's resolution,
 * 2026-08-11) and never by anything that runs on every session.
 *
 * This is that coverage, added the same session as G7's resolution (which this file's
 * own scenarios are modelled on). It runs the REAL CLI as a subprocess against a scratch
 * fixture — never imports lifecycle.mjs's internals, since it has none to import — and
 * asserts on the real STATE.json the command writes. This is the specific behaviour
 * PART 4 of this session's brief calls for: "a finding can be dismissed with evidence,
 * the dismissal is recorded with its reasoning, and a dismissed finding is never
 * silently deleted... a dismissal with no evidence is refused."
 *
 * NO NETWORK — this script and lifecycle.mjs both touch only the local filesystem.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'scripts', 'lifecycle.mjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n--- ${title} ---`); }

const workDir = mkdtempSync(path.join(tmpdir(), 'verify-lifecycle-ingest-'));
const tasksDir = path.join(workDir, 'tasks');
const inboxDir = path.join(workDir, 'inbox');
const slug = 'ingest-fixture';

function run(args) {
  const out = execFileSync('node', [cliPath, ...args, '--tasks-dir', tasksDir, '--inbox', inboxDir, '--no-board'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function readFixtureState() {
  return JSON.parse(readFileSync(path.join(tasksDir, slug, 'STATE.json'), 'utf8'));
}

function writeInboxFile(name, obj) {
  writeFileSync(path.join(inboxDir, slug, name), JSON.stringify(obj));
}

try {
  mkdirSync(path.join(tasksDir, slug), { recursive: true });
  mkdirSync(path.join(inboxDir, slug), { recursive: true });
  writeFileSync(path.join(tasksDir, slug, 'STATE.json'), JSON.stringify({ completed: ['scaffold'] }));

  section('§0 fixture setup — a real init, over the real CLI');
  const initOut = run(['init', '--slug', slug, '--task', 'OB-TEST', '--type', 'warehouse-build']);
  check('init succeeded and opened BUILDING', initOut.stage === 'BUILDING', JSON.stringify(initOut));

  section('§1 a gap enters the record, then a dismissal with evidence is applied and kept');
  writeInboxFile('01-gap.json', { kind: 'gap', id: 'T1', title: 'a test gap', class: 'routine', raised_by: 6, at: '2026-08-11' });
  writeInboxFile('02-dismiss.json', { kind: 'gap_resolution', id: 'T1', status: 'dismissed', decision: 'checked against the live code; the claim does not hold', at: '2026-08-11' });
  const out1 = run(['ingest', '--slug', slug]);
  check('both files applied, none refused', out1.applied.length === 2 && out1.refused.length === 0, JSON.stringify(out1));

  const st1 = readFixtureState();
  const t1 = st1.lifecycle.gaps.find((g) => g.id === 'T1');
  check('the gap is still ON THE RECORD, not deleted', !!t1);
  check('its status is dismissed', t1?.status === 'dismissed');
  check('its decision text was recorded verbatim', t1?.decision === 'checked against the live code; the claim does not hold');
  check('closed_at was stamped from the item\'s own `at`', t1?.closed_at === '2026-08-11');
  check('the ORIGINAL gap fields (id, title, class, raised_by) survive a dismissal untouched',
    t1?.title === 'a test gap' && t1?.class === 'routine' && t1?.raised_by === 6);

  section('§2 a dismissal with NO evidence is refused — the exact rule PART 4 asks for');
  writeInboxFile('03-gap.json', { kind: 'gap', id: 'T2', title: 'a second test gap', class: 'binding', raised_by: 9, at: '2026-08-11' });
  writeInboxFile('04-dismiss-empty.json', { kind: 'gap_resolution', id: 'T2', status: 'dismissed', decision: '', at: '2026-08-11' });
  const out2 = run(['ingest', '--slug', slug]);
  const dismissRefusal = out2.refused.find((r) => r.file === '04-dismiss-empty.json');
  check('the gap itself was applied', out2.applied.some((a) => a.file === '03-gap.json'));
  check('the empty-decision dismissal was REFUSED, not applied', !!dismissRefusal, JSON.stringify(out2));
  check('the refusal names why — a dismissal must carry the decision, not merely move past the gap',
    /must carry the decision/.test(dismissRefusal?.why || ''));

  const st2 = readFixtureState();
  const t2 = st2.lifecycle.gaps.find((g) => g.id === 'T2');
  check('the refused dismissal left the gap OPEN, not silently closed', t2?.status === 'open');
  check('no decision text was written from the refused attempt', !t2?.decision);

  section('§2b whitespace-only "evidence" is refused exactly like empty — no loophole');
  writeInboxFile('05-dismiss-whitespace.json', { kind: 'gap_resolution', id: 'T2', status: 'dismissed', decision: '   ', at: '2026-08-11' });
  const out2b = run(['ingest', '--slug', slug]);
  const wsRefusal = out2b.refused.find((r) => r.file === '05-dismiss-whitespace.json');
  check('a whitespace-only decision is refused, same as empty', !!wsRefusal, JSON.stringify(out2b));

  section('§2c a dismissal with NO decision field at all (not merely empty) is refused the same way');
  writeInboxFile('06-dismiss-absent.json', { kind: 'gap_resolution', id: 'T2', status: 'dismissed', at: '2026-08-11' });
  const out2c = run(['ingest', '--slug', slug]);
  const absentRefusal = out2c.refused.find((r) => r.file === '06-dismiss-absent.json');
  check('a missing `decision` key is refused, not treated as an implicit empty pass', !!absentRefusal, JSON.stringify(out2c));

  section('§3 resolved (not dismissed) still requires nothing extra, and both close a gap the same way');
  writeInboxFile('07-gap.json', { kind: 'gap', id: 'T3', title: 'a third test gap', class: 'binding', raised_by: 13, at: '2026-08-11' });
  writeInboxFile('08-resolve.json', { kind: 'gap_resolution', id: 'T3', status: 'resolved', decision: 'fixed in commit abc123', at: '2026-08-11' });
  run(['ingest', '--slug', slug]);
  const st3 = readFixtureState();
  const t3 = st3.lifecycle.gaps.find((g) => g.id === 'T3');
  check('a resolved gap also carries its decision', t3?.status === 'resolved' && t3?.decision === 'fixed in commit abc123');

  section('§4 an unknown status value is refused — only resolved|dismissed exist');
  writeInboxFile('09-gap.json', { kind: 'gap', id: 'T4', title: 'a fourth test gap', class: 'routine', raised_by: 6, at: '2026-08-11' });
  writeInboxFile('10-bogus-status.json', { kind: 'gap_resolution', id: 'T4', status: 'ignored', decision: 'whatever', at: '2026-08-11' });
  const out4 = run(['ingest', '--slug', slug]);
  const bogusRefusal = out4.refused.find((r) => r.file === '10-bogus-status.json');
  check('an invalid status is refused rather than silently accepted', !!bogusRefusal, JSON.stringify(out4));
  const st4 = readFixtureState();
  check('the gap it targeted stays open', st4.lifecycle.gaps.find((g) => g.id === 'T4')?.status === 'open');

  section('§5 a gap_resolution naming a gap not on the record is refused, never invented');
  writeInboxFile('11-resolve-unknown.json', { kind: 'gap_resolution', id: 'GHOST', status: 'resolved', decision: 'n/a', at: '2026-08-11' });
  const out5 = run(['ingest', '--slug', slug]);
  const ghostRefusal = out5.refused.find((r) => r.file === '11-resolve-unknown.json');
  check('an unknown gap id is refused', !!ghostRefusal, JSON.stringify(out5));
  const st5 = readFixtureState();
  check('no phantom gap was created on the record', !st5.lifecycle.gaps.some((g) => g.id === 'GHOST'));

  section('§6 idempotency — re-running ingest never re-applies or double-processes a file already applied');
  const beforeGapCount = st5.lifecycle.gaps.length;
  const out6 = run(['ingest', '--slug', slug]);
  check('a second run with no new files applies nothing', out6.applied.length === 0, JSON.stringify(out6));
  const st6 = readFixtureState();
  check('the gap count is unchanged — nothing was re-applied or duplicated', st6.lifecycle.gaps.length === beforeGapCount);

  section('§7 every refused file was left in place — never deleted, never silently applied later');
  const inboxFiles = new Set([
    '01-gap.json', '02-dismiss.json', '03-gap.json', '04-dismiss-empty.json', '05-dismiss-whitespace.json',
    '06-dismiss-absent.json', '07-gap.json', '08-resolve.json', '09-gap.json', '10-bogus-status.json', '11-resolve-unknown.json',
  ]);
  let allPresent = true;
  for (const f of inboxFiles) {
    if (!existsSync(path.join(inboxDir, slug, f))) allPresent = false;
  }
  check('every inbox file, applied or refused, still exists on disk', allPresent);
  const stillUnapplied = JSON.parse(readFileSync(path.join(inboxDir, slug, '04-dismiss-empty.json'), 'utf8'));
  check('a refused file was NOT marked applied — it is eligible to be corrected and re-ingested', stillUnapplied.applied !== true);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
