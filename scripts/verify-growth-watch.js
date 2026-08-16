#!/usr/bin/env node
/*
 * Dry-run verification for scripts/growth-watch.mjs — audit #12/#18/#19/#20/#24.
 *
 * WHAT THIS IS FOR. KFM-20 asks of every store that only grows: is there a cap,
 * a retirement path, or **at minimum a trend someone reads**? Finding #12 is
 * that the need had been identified across seven consecutive sweeps and nothing
 * was ever built. This verifies the thing that was finally built.
 *
 * The checks that matter are all one question — **can this instrument report a
 * number it does not have?** A growth ledger is uniquely able to lie quietly:
 * it runs from two places with different reach (a laptop with all three repos,
 * and a CI job with a credential for none of the private ones), so the single
 * most likely defect is a store that is merely UNREADABLE being written down as
 * zero, and then read next week as a store that shrank.
 *
 * NO NETWORK, NO LEDGER WRITES. `globalThis.fetch` is a tripwire; every
 * measurement runs against fixture directories in the OS temp dir, and the
 * real ledger is never opened for writing.
 *
 * Run: node scripts/verify-growth-watch.js
 */

import {
  WATCHED, LEDGER_PATH, countChecks, measureVerifySuite, measureRootDocs,
  measureReportsArchive, measureBackOffice, measureD1,
  readLedger, trendFor, buildReport, renderReport, appendLedger, collect,
} from './growth-watch.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-growth-watch.js must make no network call'); };

let passed = 0; let failed = 0;
const check = (label, cond) => {
  if (cond) { passed += 1; console.log(`[PASS] ${label}`); }
  else { failed += 1; console.log(`[FAIL] ${label}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

/* ── fixtures ────────────────────────────────────────────────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-watch-'));
const mk = (rel, body = '') => {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return full;
};

mk('repo/scripts/verify-a.js', 'check("x", 1);\ncheck("y", 2);\n// three lines\n');
mk('repo/scripts/verify-b.js', 'checkTrue("z", 1);\n');
mk('repo/scripts/helper.js', 'check("not counted — not a verify- file", 1);\n');
mk('repo/TOKEN-BUDGET.md', 'a\nb\nc\n');
mk('repo/reports/one.md', '12345');
mk('repo/reports/nested/two.md', '1234567890');

mk('gh/back-office-AI-agents/campus/agents/01-a/journal.md', 'x'.repeat(100));
mk('gh/back-office-AI-agents/campus/agents/02-b/journal.md', 'x'.repeat(50));
mk('gh/back-office-AI-agents/campus/agents/03-c/notes.md', 'no journal here');
mk('gh/back-office-AI-agents/campus/shared/board/BOARD.md', 'x'.repeat(7));

const REPO = path.join(tmp, 'repo');
const GH = path.join(tmp, 'gh');
const EMPTY_GH = path.join(tmp, 'nothing-here');

/* ═══════════════════════════════════════════════════════════════════════════
 * §1  IT MEASURES THE THINGS THE AUDIT NAMED
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§1 coverage — every watched store traces to an audit finding');

check('every watched metric names the finding it comes from',
  WATCHED.every((w) => /^#\d+$/.test(w.finding)));
check('every watched metric names a unit, so a number is never bare',
  WATCHED.every((w) => typeof w.unit === 'string' && w.unit.length > 0));
for (const f of ['#18', '#19', '#20', '#24']) {
  check(`finding ${f} has at least one metric watching it`, WATCHED.some((w) => w.finding === f));
}
check('the ledger is append-only JSONL, not a file that gets rewritten',
  /LEDGER\.jsonl$/.test(LEDGER_PATH));

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  THE MEASUREMENTS ARE RIGHT ON KNOWN FIXTURES
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§2 measured against directories whose sizes are known exactly');

const vs = measureVerifySuite(REPO);
check('counts verify-*.js files only, not every script', vs.verify_suite_files.value === 2);
check('counts assertions across the suite', vs.verify_suite_checks.value === 3);
check('...and does NOT count assertions in a non-verify file',
  countChecks('check("a",1);\ncheck("b",2);\n') === 2);
check('counts lines', vs.verify_suite_lines.value > 0);

check('counts TOKEN-BUDGET.md lines', measureRootDocs(REPO).token_budget_lines.value === 4);

const ra = measureReportsArchive(REPO);
check('walks reports/ recursively', ra.reports_files.value === 2);
check('...and sums their bytes', ra.reports_bytes.value === 15);

const bo = measureBackOffice(GH);
check('sums journal.md bytes across agents', bo.journal_bytes_total.value === 150);
check('counts only agents that actually HAVE a journal', bo.journal_files.value === 2);
check('measures BOARD.md', bo.board_bytes.value === 7);

/* ═══════════════════════════════════════════════════════════════════════════
 * §3  UNREACHABLE IS NEVER ZERO — the defect this instrument could most easily commit
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§3 KFM-13: a store it cannot see is not a store of size zero');

const missing = measureBackOffice(EMPTY_GH);
check('an absent back-office reports reachable:false, NOT a value of 0',
  missing.journal_bytes_total.reachable === false && missing.journal_bytes_total.value === null);
check('...and says WHY, naming the private repo and the missing credential',
  /private repo/.test(missing.journal_bytes_total.reason));
check('BOARD.md unreadable is also reachable:false rather than 0 bytes',
  missing.board_bytes.reachable === false && missing.board_bytes.value === null);
check('an absent reports/ is unreachable, not an archive of zero files',
  measureReportsArchive(EMPTY_GH).reports_files.reachable === false);
check('an absent scripts/ is unreachable, not a verify suite of zero files',
  measureVerifySuite(EMPTY_GH).verify_suite_files.reachable === false);

const noCreds = await measureD1({});
check('D1 with no credential is unreachable, not zero rows',
  noCreds.d1_reports_rows.reachable === false && noCreds.d1_reports_rows.value === null);
check('...and names which credential was missing', /AGENTS_API_BASE/.test(noCreds.d1_reports_rows.reason));
const d1Http = await measureD1({ base: 'http://x', token: 't', fetchImpl: async () => ({ ok: false, status: 503 }) });
check('a non-OK Worker response is unreachable, not zero rows',
  d1Http.d1_reports_rows.reachable === false && /503/.test(d1Http.d1_reports_rows.reason));
const d1Threw = await measureD1({ base: 'http://x', token: 't', fetchImpl: async () => { throw new Error('offline'); } });
check('a thrown fetch is unreachable, not zero rows', d1Threw.d1_reports_rows.reachable === false);
const d1Null = await measureD1({
  base: 'http://x', token: 't',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: { counts: { reports: null, interactions: 7 } } }) }),
});
check('a NULL count from the Worker is unreachable, never 0 — the trigger promises this and the reader must honour it',
  d1Null.d1_reports_rows.reachable === false);
check('...while a real count alongside it still comes through',
  d1Null.d1_interactions_rows.reachable === true && d1Null.d1_interactions_rows.value === 7);

/* ═══════════════════════════════════════════════════════════════════════════
 * §4  THE TREND — compared per METRIC, not per run
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§4 trendFor() — the comparison that makes a partial run still useful');

const entries = [
  { at: '2026-08-01T00:00:00.000Z', metrics: { j: { reachable: true, value: 100 }, v: { reachable: true, value: 10 } } },
  // A CI run: it could not see back-office, so `j` is unreachable here.
  { at: '2026-08-08T00:00:00.000Z', metrics: { j: { reachable: false, value: null, reason: 'private repo' }, v: { reachable: true, value: 12 } } },
];

const jTrend = trendFor('j', entries, { reachable: true, value: 170, _at: '2026-08-11T00:00:00.000Z' });
check('a metric skips OVER runs that could not measure it and compares to the last that could',
  jTrend.status === 'trend' && jTrend.since === '2026-08-01T00:00:00.000Z');
check('...reporting the absolute change', jTrend.delta === 70);
check('...and a per-day rate over the real elapsed time, not per run', jTrend.perDay === 7);

check('the FIRST measurement of a metric is a baseline, not a delta of zero',
  trendFor('brand_new', entries, { reachable: true, value: 5, _at: '2026-08-11T00:00:00.000Z' }).status === 'baseline');
check('a metric that could not be measured THIS run is not_measured, with the reason carried',
  trendFor('j', entries, { reachable: false, reason: 'private repo', _at: '2026-08-11T00:00:00.000Z' }).status === 'not_measured');
check('a shrinking store reports a negative delta rather than being clamped',
  trendFor('v', entries, { reachable: true, value: 4, _at: '2026-08-11T00:00:00.000Z' }).delta === -8);
check('two runs at the same instant report no per-day rate rather than dividing by zero',
  trendFor('v', entries, { reachable: true, value: 20, _at: '2026-08-08T00:00:00.000Z' }).perDay === null);

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  THE REPORT STATES ITS OWN COVERAGE
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§5 the report cannot be read as complete when it is partial');

const partial = await collect({ now: '2026-08-16T00:00:00.000Z', repoRoot: REPO, ghRoot: EMPTY_GH });
const partialReport = buildReport(partial, []);
check('a partial run reports fewer measured than watched', partialReport.measured < partialReport.watched);
check('...and SAYS so in the coverage note (KFM-03)',
  /of \d+ watched stores were measured/.test(partialReport.coverageNote));
check('...and states that the missing ones are not recorded as zero',
  /NOT recorded as zero/.test(partialReport.coverageNote));

const full = await collect({
  now: '2026-08-16T00:00:00.000Z', repoRoot: REPO, ghRoot: GH,
  base: 'http://x', token: 't',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: { counts: { reports: 100, interactions: 200 } } }) }),
});
const fullReport = buildReport(full, []);
check('FALSIFIABILITY: a run that reaches everything says all stores were measured',
  fullReport.measured === fullReport.watched && /All \d+ watched stores/.test(fullReport.coverageNote));

const rendered = renderReport(partialReport);
check('the rendered table shows not-measured rows rather than omitting them', /not measured/.test(rendered));
check('the render says the watcher caps nothing, so it is not mistaken for enforcement',
  /caps nothing and retires nothing/.test(rendered));
check('the render explains that a not-measured store is not a store of size zero',
  /not\*\* a store of size zero/.test(rendered));
check('every rendered row names its audit finding', WATCHED.every((w) => rendered.includes(w.finding)));

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  THE LEDGER IS APPEND-ONLY AND SURVIVES A BAD LINE
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§6 the ledger');

const ledger = path.join(tmp, 'ledger', 'LEDGER.jsonl');
appendLedger({ at: '2026-08-01T00:00:00.000Z', metrics: { v: { reachable: true, value: 1 } } }, ledger);
appendLedger({ at: '2026-08-02T00:00:00.000Z', metrics: { v: { reachable: true, value: 2 } } }, ledger);
check('appending twice keeps both entries — nothing is rewritten (A15)', readLedger(ledger).length === 2);
check('...in order', readLedger(ledger)[0].at < readLedger(ledger)[1].at);

fs.appendFileSync(ledger, 'this is not json\n', 'utf8');
appendLedger({ at: '2026-08-03T00:00:00.000Z', metrics: { v: { reachable: true, value: 3 } } }, ledger);
check('a corrupted line is skipped rather than crashing the whole trend', readLedger(ledger).length === 3);
check('an absent ledger reads as an empty history, not an error', readLedger(path.join(tmp, 'no', 'such.jsonl')).length === 0);

fs.rmSync(tmp, { recursive: true, force: true });

/* ═══════════════════════════════════════════════════════════════════════════
 * §7  OB-085 — THE CI JOB CAN ACTUALLY EXTEND THE LEDGER
 *
 * The tool worked from the day it was written; what was missing was a caller
 * that could RECORD, which is KFM-26's shape (built right, wired short). These
 * assert the wiring rather than the tool, because "the ledger grows from local
 * runs only" was true while every check in this file was green.
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log('\n── §7 OB-085: the weekly CI job extends the ledger ──');

const wf = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..', '.github', 'workflows', 'weekly-capability-audit.yml'),
  'utf8',
).replace(/\r\n/g, '\n');
// Comments in this file DISCUSS --no-append at length (it was removed there),
// so strip them first — a check that cannot tell a directive from prose about
// a directive reports the opposite of the truth (KFM-04c).
const wfCode = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

check('the growth-watch step no longer passes --no-append',
  /growth-watch\.mjs/.test(wfCode) && !/--no-append/.test(wfCode));
check('the job is granted contents: write, without which the commit cannot land',
  /permissions:\s*\n\s*contents: write/.test(wfCode));
check('there is a step that commits the ledger',
  /git commit -m "chore\(growth\)/.test(wfCode) && /git add reports\/growth\/LEDGER\.jsonl/.test(wfCode));
check('the commit names ONLY the ledger path — never `git add -A`, which would sweep up unrelated files',
  !/git add\s+(-A|--all|\.)\s/.test(wfCode));
check('the push retries, because the live Worker commits to this same branch on its own cron',
  /git pull --rebase/.test(wfCode) && /for attempt in/.test(wfCode));
check('a failed measurement or commit is RE-RAISED, so this cannot fail silently (KFM-05)',
  /growth_exit != '0' \|\| steps\.ledger_commit\.outputs\.commit_exit != '0'/.test(wfCode));
check('...and it is re-raised AFTER the findings are posted, so a lost row never costs the audit (KFM-14)',
  wfCode.indexOf('Post findings to the board inbox') < wfCode.indexOf('growth ledger could not be measured'));
check('the ledger failure is a SEPARATE step from the capability gate, so which one fired is legible (KFM-06)',
  /gate_exit != '0'/.test(wfCode) && /commit_exit != '0'/.test(wfCode)
  && wfCode.indexOf("gate_exit != '0'") !== wfCode.indexOf("commit_exit != '0'"));

// THE INVARIANT OB-085 NAMES BY NAME. The CI row will carry `not_measured`
// for both private repos; writing a zero instead would publish the
// back-office journals collapsing to nothing every Sunday.
const ciUnreachable = trendFor(
  'ci_private_store',
  [{ at: '2026-08-09T00:00:00.000Z', metrics: { ci_private_store: { reachable: true, value: 40 } } }],
  { reachable: false, reason: 'no credential for back-office in CI', _at: '2026-08-16T00:00:00.000Z' },
);
check('an unreachable store summarises as not_measured, never as zero',
  ciUnreachable.status === 'not_measured' && ciUnreachable.value === null && ciUnreachable.delta === null);
check('...and it carries the REASON, so a reader can tell "we could not look" from "there is nothing there"',
  /credential/.test(ciUnreachable.reason || ''));
check('...and a LATER reachable run still trends against the last run that measured it, skipping the CI blank',
  trendFor('ci_private_store', [
    { at: '2026-08-09T00:00:00.000Z', metrics: { ci_private_store: { reachable: true, value: 40 } } },
    { at: '2026-08-16T00:00:00.000Z', metrics: { ci_private_store: { reachable: false, reason: 'no credential' } } },
  ], { reachable: true, value: 52, _at: '2026-08-23T00:00:00.000Z' }).delta === 12);
check('nothing in the workflow rewrites a not_measured row before committing it',
  !/not_measured/.test(wfCode.split('Commit the growth ledger row')[1] || ''));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) { console.log('Growth-watch verification FAILED.'); process.exit(1); }
console.log('All scenarios matched expectations.');
