#!/usr/bin/env node
/**
 * scripts/verify-daily-obligation.js — the daily obligation (Session 33, Item A).
 *
 * Calls `workers/daily-obligation.js` FOR REAL — it imports nothing, which is
 * why it can be called rather than regexed — and asserts the properties the
 * check exists to have. `globalThis.fetch` is a tripwire, so "this module makes
 * no network call" is proven rather than claimed.
 *
 * ── §6 IS THE PART THAT MAKES THIS EVIDENCE AND NOT DOCUMENTATION ─────────
 *
 * CLAUDE.md, 2026-08-06: *"A test that describes a fix is not a test that
 * catches a bug. The way to tell them apart is cheap: transcribe the pre-fix
 * logic and run the new scenario table against it."*
 *
 * There is no pre-fix classifier to transcribe here — this capability did not
 * exist yesterday. So §6 transcribes the DEFAULT SOMEBODY WOULD PLAUSIBLY HAVE
 * WRITTEN instead: "a committed repo write is output, so count them all". That
 * is not a straw man; it is what `repo_writes` invites, and it is exactly the
 * shape that made 2026-08-28 look like a working day. Every scenario in §6
 * must FAIL against it, or the classification below is decoration.
 *
 *   node scripts/verify-daily-obligation.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CLASSIFICATION_RULES, ARTIFACT_CAPABLE_BLOCKS, DAILY_OBLIGATION_TABLE_SQL,
  classifyWrite, countArtifacts, lastArtifactCapableBlock, switchedOffBlockTypes, buildObligationIssue,
  WAREHOUSE_REPO, BACKOFFICE_REPO, PUBLIC_REPO,
} from '../workers/daily-obligation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-daily-obligation.js made a network call'); };

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(label);
  console.error(`  ✗ ${label}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

/* ═══════════ §1 — the owner's COUNTS list, each entry exercised ═══════════ */
section("§1 what counts — the owner's own four categories");

check('a file in the warehouse counts',
  classifyWrite({ repo: WAREHOUSE_REPO, path: 'tasks/dependency-audit/audit.py' }).artifact === true);
check('a filed review counts',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/lifecycle-inbox/verifier-count-ledger/2026-08-23-review-agent08.json' }).artifact === true);
check('an owner-named review filed into the channel counts (Item C)',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'channel/from-office/2026-08-28-review-something.md' }).artifact === true);
check('a completed analysis counts (a gap digest)',
  classifyWrite({ repo: PUBLIC_REPO, path: 'reports/gaps/data-center/2026-08-20.md' }).artifact === true);
check('a delivered report counts (a guide)',
  classifyWrite({ repo: PUBLIC_REPO, path: 'guides/_drafts/networking-ipsec-vs-wireguard.md' }).artifact === true);

/* ═══════════ §2 — the DOES NOT COUNT list, NOT softened ═══════════ */
section('§2 what does not count — and the list is not softened');

check('a meeting transcript does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/meetings/2026-08-28-daily_standup-x.md' }).artifact === false);
check('a standup / day summary does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/daily/year-1-day-064-summary.md' }).artifact === false);
check('a journal entry does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/agents/05-the-it-chief/journal.md' }).artifact === false);
check('a board note does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/board/BOARD.md' }).artifact === false);
check('a proposal in the BOARD inbox does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/board/inbox/2026-08-28-daily_standup-x.md' }).artifact === false);
check('channel traffic does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'channel/from-owner-issues/2026-08-26-issue-4-comment-1.md' }).artifact === false);
check('the derived IN-FLIGHT index does NOT count',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/lifecycle/IN-FLIGHT.md' }).artifact === false);

/* ═══ §3 — the one place the two lists collide, resolved the owner's way ═══ */
section('§3 lifecycle-inbox vs board/inbox — both are inboxes, only one counts');

check('a REVIEW in the lifecycle inbox counts — finished judgement',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/lifecycle-inbox/office-site/2026-08-10-review-agent06.json' }).artifact === true);
check('a PROPOSAL in the board inbox does not — a request for somebody else to work',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/board/inbox/PROMOTED-LOG.md' }).artifact === false);
check('the lifecycle inbox README is documentation, not a filing',
  classifyWrite({ repo: BACKOFFICE_REPO, path: 'campus/shared/lifecycle-inbox/README.md' }).artifact === false);

/* ═══════════ §4 — an unclassified path is NOT an artifact, and is NAMED ═══ */
section('§4 unclassified is never silently defaulted in either direction');

const novel = classifyWrite({ repo: BACKOFFICE_REPO, path: 'some/path/nobody/has/ruled/on.md' });
check('a path matching no rule is NOT counted as an artifact', novel.artifact === false);
check('and it is marked unmatched, so it can be reported by name', novel.matched === false);
const withNovel = countArtifacts([{ repo: BACKOFFICE_REPO, path: 'some/new/thing.md', committed: 1 }]);
check('countArtifacts() surfaces it in `unclassified`', withNovel.unclassified.length === 1);
check('and it does not satisfy the obligation on its own', withNovel.count === 0);

/* ═══════════ §5 — counting rules ═══════════ */
section('§5 counting');

check('an UNCOMMITTED write is not an artifact — a refused write is nothing a person can open',
  countArtifacts([{ repo: WAREHOUSE_REPO, path: 'tasks/x/a.py', committed: 0 }]).count === 0);
check('the same path committed four times is ONE artifact, not four — a stuck repair loop must not satisfy the obligation',
  countArtifacts([
    { repo: WAREHOUSE_REPO, path: 'tasks/dependency-audit/audit.py', committed: 1 },
    { repo: WAREHOUSE_REPO, path: 'tasks/dependency-audit/audit.py', committed: 1 },
    { repo: WAREHOUSE_REPO, path: 'tasks/dependency-audit/audit.py', committed: 1 },
    { repo: WAREHOUSE_REPO, path: 'tasks/dependency-audit/audit.py', committed: 1 },
  ]).count === 1);
check('a repo nobody has rules for contributes nothing rather than everything',
  countArtifacts([{ repo: 'aviv-brain', path: 'skills/x/SKILL.md', committed: 1 }]).count === 0);

/* ═══ §6 — THE NEGATIVE CONTROL: the table must fail the naive classifier ═══ */
section('§6 the pre-fix default — "every committed write is output" — must FAIL');

/**
 * Transcribed, not imported: what a session would plausibly have written if it
 * had reached for `repo_writes` without a classification. If any scenario below
 * passes against this, that scenario is not testing anything.
 */
const naive = (rows) => rows.filter((r) => Number(r.committed) === 1).length;

const REAL_2026_08_28 = [
  { repo: BACKOFFICE_REPO, path: 'campus/shared/qa-instruments/2026-08-28-qa-instruments.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/shared/meetings/2026-08-28-daily_standup-2026-08-28T05-30-56-019Z.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/agents/12-the-workflow/journal.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/agents/07-the-team-lead/journal.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/agents/05-the-it-chief/journal.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/shared/board/inbox/2026-08-28-daily_standup-2026-08-28T05-30-50-361Z.md', committed: 1 },
];
// The real six rows of 2026-08-28, from D1. The naive count says SIX; the
// classifier says ONE, and the one is the Friday analysis.
check('the real 2026-08-28 day: naive says 6, classifier says 1',
  naive(REAL_2026_08_28) === 6 && countArtifacts(REAL_2026_08_28).count === 1);

const REAL_2026_08_26 = [
  { repo: BACKOFFICE_REPO, path: 'campus/shared/daily/year-1-day-063-summary.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/shared/meetings/2026-08-26-closing_qa_review-x.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/agents/12-the-workflow/journal.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/agents/07-the-team-lead/journal.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'campus/agents/06-the-qa/journal.md', committed: 1 },
  { repo: BACKOFFICE_REPO, path: 'channel/from-office/READ-LOG.md', committed: 1 },
];
// The real 2026-08-26 day: six writes, and NOT ONE of them is an artifact.
// This is the scenario the whole item exists for.
check('the real 2026-08-26 day: naive says 6 (a working day), classifier says 0 (a failure)',
  naive(REAL_2026_08_26) === 6 && countArtifacts(REAL_2026_08_26).count === 0);

check('the real 2026-08-27 day (the first artifact) is a PASS under both — a control that must not fail',
  countArtifacts([
    { repo: WAREHOUSE_REPO, path: 'tasks/dependency-audit/audit.py', committed: 1 },
    { repo: BACKOFFICE_REPO, path: 'campus/agents/05-the-it-chief/journal.md', committed: 1 },
  ]).count === 1);

/* ═══════════ §7 — which block could have produced one ═══════════ */
section('§7 the last artifact-capable block');

const runner = readFileSync(path.join(ROOT, 'workers/agent-runner.js'), 'utf8');
const schedule = JSON.parse(readFileSync(path.join(ROOT, 'config/daily-schedule.json'), 'utf8'));

// A CLAIM ABOUT THE CODE, CHECKED AGAINST THE CODE. A block renamed or removed
// makes this fail rather than silently turning the list into a fiction — the
// gate-wiring lesson applied to a list.
for (const type of ARTIFACT_CAPABLE_BLOCKS) {
  check(`ARTIFACT_CAPABLE_BLOCKS entry '${type}' is a real dispatched block type in agent-runner.js`,
    new RegExp(`block\\.type === '${type}'`).test(runner));
}
check('a meeting is NOT artifact-capable — a transcript is on the DOES NOT COUNT list',
  !ARTIFACT_CAPABLE_BLOCKS.includes('meeting'));
check('spare_time is NOT artifact-capable',
  !ARTIFACT_CAPABLE_BLOCKS.includes('spare_time'));
check('case_batch is NOT artifact-capable — an answered question is not a document',
  !ARTIFACT_CAPABLE_BLOCKS.includes('case_batch'));

// SWITCHED-OFF BLOCKS ARE NOT CAPABLE. Live 2026-08-28: guides_enabled false.
// Without this the Sun-Thu answer is `guide_review`, a gated no-op that has
// produced nothing for weeks — a true statement about the schedule and a
// useless place to send the owner.
const LIVE_SWITCHES = { guides_enabled: false, office_context_enabled: true, improvement_loop_enabled: true };
const OFF = switchedOffBlockTypes(LIVE_SWITCHES);
check('with guides off, the guide_* blocks are not counted as capable', OFF.has('guide_review') && OFF.has('guide_draft'));
check('with office_context on, admin_desk IS counted as capable', !OFF.has('admin_desk'));
check('all-on leaves nothing switched off',
  switchedOffBlockTypes({ guides_enabled: true, office_context_enabled: true, improvement_loop_enabled: true }).size === 0);
check('a MISSING flag is off, never truthy-on — the shape every gate in this estate uses',
  switchedOffBlockTypes({}).has('admin_desk'));
const weekday = lastArtifactCapableBlock(schedule.full_day_schedule, { disabled: OFF });
const friday = lastArtifactCapableBlock(schedule.friday_schedule, { disabled: OFF });
check('with guides off the Sun-Thu answer is NOT a guide block', weekday && !/^guide_/.test(weekday.type));
check('a Sun-Thu day HAS a last artifact-capable block', !!weekday);
check('a Friday HAS a last artifact-capable block', !!friday);
check('Saturday (rest day, one spare_time block) has NONE — and that is correct, not a defect',
  lastArtifactCapableBlock(schedule.saturday_schedule, { disabled: OFF }) === null);
console.log(`     Sun-Thu: ${weekday && `${weekday.type}@${weekday.time}`} · Friday: ${friday && `${friday.type}@${friday.time}`}`);

/* ═══════════ §8 — the notice says only what he asked for ═══════════ */
section('§8 the notice — nothing but the two facts and the sequence');

const issue = buildObligationIssue({
  date: '2026-08-26', seq: 19, previous: { seq: 18, sentAt: '2026-08-28 08:00:49' },
  lastCapableBlock: { type: 'report', time: '16:00' },
});
check('it names the date', issue.body.includes('2026-08-26'));
check('it names the last block that could have produced one', issue.body.includes('`report`') && issue.body.includes('16:00'));
check('it carries the sequence, so a LOST notice is visible in the one that arrived',
  issue.body.includes('#19') && issue.body.includes('#18'));
check('NO summary, NO encouragement, NO plan — under 400 characters of body',
  issue.body.length < 400);
check('an unreadable sequence SAYS SO rather than guessing a number',
  buildObligationIssue({ date: '2026-08-26', seq: null, sequenceReason: 'no_db_binding' })
    .body.includes('UNAVAILABLE'));

/* ═══════════ §9 — the wiring ═══════════ */
section('§9 the wiring — is the check actually reached');

check('runDailyObligationCheck() exists in agent-runner.js',
  /async function runDailyObligationCheck\(/.test(runner));
check('it is CALLED at the day\'s last block, and not only from a supervised trigger',
  /const obligation = await runDailyObligationCheck\(env, \{/.test(runner));
/*
 * ── THE PLACEMENT, AND ITS OWN FIRST LIVE RUN CAUGHT IT ────────────────────
 *
 * It was first wired at the END of `finalizeScheduledDay()`. The Friday
 * 2026-08-28 12:30 tick overflowed the invocation budget (`closing_qa_review`
 * spent 40.75 of 37 usable), finalize threw at 09:30:48Z, and THE CHECK THAT
 * EXISTS TO NOTICE A BAD DAY DID NOT RUN ON ONE. A monitor placed downstream
 * of the thing it monitors inherits its failures.
 *
 * These four assertions are that fix, pinned. Move the call back inside
 * finalize and they go red.
 */
const finalizeStart = runner.indexOf('async function finalizeScheduledDay(');
const finalizeBody = runner.slice(
  finalizeStart,
  runner.indexOf('\nasync function ', finalizeStart + 10)
);
check('the check is NOT inside finalizeScheduledDay() — it must survive finalize throwing',
  !/runDailyObligationCheck\(/.test(finalizeBody));
check('it sits AFTER the try/catch around finalize, in the caller',
  /blockType: 'finalize'[\s\S]{0,6000}const obligation = await runDailyObligationCheck/.test(runner));
check('a day that BROKE is distinguishable from a quiet one IN THE ROW, not only by the row being absent',
  /FINALIZE THREW/.test(runner));
check('and the check is reachable on demand — a capability with no route to it does not stay a gap',
  /case 'daily_obligation_check':/.test(runner));
check('it is skipped on the rest day (A13) rather than recording a designed silence as a failure',
  /rest_day_not_checked/.test(runner));
check('the D1 row is written even when the notice is gated off — a suppressed alarm stays countable',
  /owner_channel_enabled is not true — the failure is recorded and the owner was NOT told/.test(runner));
check('the notice rides the SAME ledger and sequence as every other owner notification',
  /kind: 'daily_obligation'/.test(runner) && /await nextSequence\(env\)/.test(runner));
check('the table is keyed on `date`, so a re-run replaces a day rather than appending a second verdict',
  /date TEXT PRIMARY KEY/.test(DAILY_OBLIGATION_TABLE_SQL));
check('the check cannot throw out of finalize (KFM-14)',
  /check_threw:/.test(runner));

/* ═══════════ §10 — the rules themselves ═══════════ */
section('§10 rule hygiene');
check('every rule declares a repo, a pattern, a verdict and the owner\'s own category word',
  CLASSIFICATION_RULES.every((r) => r.repo && r.re instanceof RegExp && typeof r.artifact === 'boolean' && r.category));
check('the qa-instruments rule is marked WEAKEST in its own category text, so striking it is one deliberate line',
  CLASSIFICATION_RULES.some((r) => /WEAKEST/.test(r.category)));

/* ═══════════════ done ═══════════════ */
console.log(`\n${fail === 0 ? '✅' : '❌'} verify-daily-obligation: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
