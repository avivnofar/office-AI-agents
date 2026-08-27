#!/usr/bin/env node
/**
 * scripts/verify-admin-desk.js — dry-run verification for the admin desk.
 *
 * Calls `workers/admin-desk.js` for real (it imports nothing, which is why it
 * can be called rather than regexed) and asserts the ONE property the whole
 * block exists to have: **an empty queue produces nothing, and an unreadable
 * queue is not an empty one.**
 *
 * `globalThis.fetch` is replaced with a tripwire that throws, so "no network
 * calls" is proven rather than claimed — the same discipline
 * `verify-routing.js` and `verify-providers.js` use.
 *
 *   node scripts/verify-admin-desk.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DESK_AGENTS, ARCHITECT_ID, MAX_REVIEWS_PER_TICK, MAX_INCIDENTS_PER_NOTE,
  NOT_CARRIED_STATES, carriedDeliverables, reviewAssignments, approvalQueue,
  probationDecisionDraw, recentIncidents, deskSummary, producedAnything,
} from '../workers/admin-desk.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-admin-desk.js made a network call'); };

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

/* ═══════════════ §1 — the roster ═══════════════ */
section('§1 the roster');
check('the Architect is NOT a desk agent — he is dormant and has architect_liaison',
  !DESK_AGENTS.includes(ARCHITECT_ID));
check('every agent the 2026-08-11 removal silenced (5,6,7,8,9,11) is a desk agent',
  [5, 6, 7, 8, 9, 11].every((id) => DESK_AGENTS.includes(id)));
check('agents 12 and 13 are desk agents too — same tier, same in_case_rotation:false, never produced',
  DESK_AGENTS.includes(12) && DESK_AGENTS.includes(13));
check('no case worker (1-4) is a desk agent',
  ![1, 2, 3, 4].some((id) => DESK_AGENTS.includes(id)));

/* ═══════════════ §2 — what the office is carrying ═══════════════ */
section('§2 carried vs frozen deliverables');
const RECORDS = [
  { slug: 'office-site', board_task: 'OB-043', stage: 'IN-REVIEW', round: 0, owed_by: [10, 5, 7, 8, 12], required: [6, 9, 10, 13], open_gaps: 14, gaps: ['G1 [routine] ...'] },
  { slug: 'verifier-count-ledger', board_task: 'OB-018', stage: 'IN-REVIEW', round: 0, owed_by: [5, 6, 10, 7, 8, 9, 12, 13], required: [5, 6, 10], open_gaps: 0, gaps: [] },
  { slug: 'repo-size-hygiene-check', board_task: null, stage: 'IN-REVIEW', round: 0, owed_by: [5, 6, 10], required: [5, 6, 10], open_gaps: 0, gaps: [] },
  { slug: 'a-converged-thing', board_task: 'OB-900', stage: 'AWAITING-APPROVAL', round: 3, owed_by: [], required: [6], open_gaps: 0, gaps: [] },
];
const BOARD = [
  { id: 'OB-043', state: 'NOT-READY' },
  { id: 'OB-018', state: 'IN-PROGRESS' },
  { id: 'OB-900', state: 'IN-PROGRESS' },
];
const { carried, frozen } = carriedDeliverables(RECORDS, BOARD);
check('a NOT-READY board task freezes its deliverable — OB-043 was reassigned to the owner',
  frozen.length === 1 && frozen[0].slug === 'office-site');
check('...and it is REPORTED as frozen, not silently dropped',
  frozen[0].state === 'NOT-READY' && frozen[0].boardTask === 'OB-043');
check('a record with no board task at all is CARRIED — absence of a board id is not a drop',
  carried.some((r) => r.slug === 'repo-size-hygiene-check'));
check('the carried set is everything else', carried.length === 3);
check('DONE also freezes', NOT_CARRIED_STATES.includes('DONE'));

/* ═══════════════ §3 — the review draw ═══════════════ */
section('§3 the review draw');
const a1 = reviewAssignments(carried, { alreadyFiled: {} });
check(`the draw is capped at MAX_REVIEWS_PER_TICK (${MAX_REVIEWS_PER_TICK})`,
  a1.draw.length === MAX_REVIEWS_PER_TICK);
check('the cap is NOT silent — everything undrawn is returned as deferred',
  a1.deferred.length > 0);
check('nothing is drawn for the frozen deliverable',
  !a1.draw.concat(a1.deferred).some((d) => d.slug === 'office-site'));
check('the Architect is skipped and the skip says he still owes the review',
  a1.skipped.some((s) => s.agentId === ARCHITECT_ID && /still owes/.test(s.why)));
check('a required reviewer is drawn as kind "review"',
  a1.draw.every((d) => (d.agentId === 5 || d.agentId === 6) ? d.kind === 'review' : true));
const a2 = reviewAssignments(carried, { alreadyFiled: {}, max: 99 });
check('a non-required reviewer is drawn as kind "comment"',
  a2.draw.some((d) => d.agentId === 7 && d.kind === 'comment'));
check('every drawn item carries its slug, agent, round and gap context',
  a2.draw.every((d) => d.slug && Number.isInteger(d.agentId) && Number.isInteger(d.round) && Array.isArray(d.gaps)));

section('§3b re-running the same day does not re-file');
const a3 = reviewAssignments(carried, { alreadyFiled: { 'verifier-count-ledger': [5, 6] }, max: 99 });
check('an agent whose review is already in the inbox is not drawn again',
  !a3.draw.some((d) => d.slug === 'verifier-count-ledger' && (d.agentId === 5 || d.agentId === 6)));
check('...and the skip reason names the inbox, so a reader knows why',
  a3.skipped.some((s) => /lifecycle inbox/.test(s.why)));
check('the other deliverables are unaffected by that slug\'s filed set',
  a3.draw.some((d) => d.slug === 'repo-size-hygiene-check'));

section('§3c an empty queue draws nothing');
check('no IN-REVIEW deliverables → an empty draw, an empty deferred list, and no error',
  (() => { const r = reviewAssignments([], {}); return r.draw.length === 0 && r.deferred.length === 0; })());
check('a deliverable at IN-REVIEW that everyone has already answered draws nothing',
  reviewAssignments([{ slug: 's', stage: 'IN-REVIEW', owed_by: [], required: [] }], {}).draw.length === 0);
check('a deliverable NOT at IN-REVIEW is never drawn for review',
  reviewAssignments([{ slug: 's', stage: 'IMPROVING', owed_by: [5, 6], required: [6] }], {}).draw.length === 0);

section('§3d session 30 item A — an unreadable slug never displaces a readable one\'s slot');
/*
 * The live scenario, 2026-08-23 through 2026-08-27: OB-043 flipped back to
 * READY on 2026-08-23, so `office-site` is CARRIED again (unlike §2/§3's
 * fixture, where OB-043 is still NOT-READY/frozen). It sorts first in board
 * order, has no readable artifact (nothing under `tools/office-site/`), and
 * its five `owed_by` entries filled BOTH of MAX_REVIEWS_PER_TICK's slots
 * every tick — before this fix, the artifact check ran one layer up, AFTER
 * the draw. `verifier-count-ledger`, whose artifact IS readable, never got a
 * turn.
 */
const RECORDS_D = [
  { slug: 'office-site', board_task: 'OB-043', stage: 'IN-REVIEW', round: 0, owed_by: [10, 5, 7, 8, 12], required: [6, 9, 10, 13], open_gaps: 14, gaps: [] },
  { slug: 'verifier-count-ledger', board_task: 'OB-018', stage: 'IN-REVIEW', round: 0, owed_by: [10, 9, 12, 13], required: [5, 6, 10], open_gaps: 0, gaps: [] },
];
const BOARD_D = [{ id: 'OB-043', state: 'READY' }, { id: 'OB-018', state: 'IN-PROGRESS' }];
const carriedD = carriedDeliverables(RECORDS_D, BOARD_D).carried;
check('the fixture reflects OB-043 back to READY — office-site is carried, not frozen',
  carriedD.some((r) => r.slug === 'office-site') && carriedD.length === 2);
const a4 = reviewAssignments(carriedD, { alreadyFiled: {}, unreadableSlugs: new Set(['office-site']) });
check('none of the unreadable slug\'s candidates enter the draw',
  !a4.draw.some((d) => d.slug === 'office-site'));
check('...nor the deferred list — they never had a slot to lose',
  !a4.deferred.some((d) => d.slug === 'office-site'));
check('...they are recorded in skipped, with a reason naming the artifact',
  a4.skipped.filter((s) => s.slug === 'office-site').length > 0
  && a4.skipped.some((s) => s.slug === 'office-site' && /no readable artifact/.test(s.why)));
check('the freed slots go to the readable deliverable instead',
  a4.draw.every((d) => d.slug !== 'office-site') && a4.draw.length === MAX_REVIEWS_PER_TICK
  && a4.draw.some((d) => d.slug === 'verifier-count-ledger'));

/*
 * THE PRE-FIX LOGIC, TRANSCRIBED — per this project's own standing rule that
 * a test describing a fix is not a test that catches a bug (CLAUDE.md,
 * "A test that describes a fix is not a test that catches a bug"). This is
 * `reviewAssignments()` exactly as it read before session 30 item A: no
 * `unreadableSlugs` parameter, no check against it, so the draw fills purely
 * from `owed_by` in board order regardless of whether the slug is readable.
 */
function reviewAssignmentsPreFix(carriedIn = [], opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_REVIEWS_PER_TICK;
  const agents = opts.agents || DESK_AGENTS;
  const alreadyFiled = opts.alreadyFiled || {};
  const draw = [];
  const deferred = [];
  const skipped = [];
  for (const record of carriedIn || []) {
    if (record?.stage !== 'IN-REVIEW') continue;
    const required = new Set((record.required || []).map(Number));
    const filed = new Set((alreadyFiled[record.slug] || []).map(Number));
    for (const rawId of record.owed_by || []) {
      const agentId = Number(rawId);
      if (!Number.isInteger(agentId)) continue;
      if (agentId === ARCHITECT_ID) { skipped.push({ slug: record.slug, agentId, why: 'architect' }); continue; }
      if (!agents.includes(agentId)) { skipped.push({ slug: record.slug, agentId, why: 'not desk agent' }); continue; }
      if (filed.has(agentId)) { skipped.push({ slug: record.slug, agentId, why: 'already filed' }); continue; }
      const item = { slug: record.slug, agentId, kind: required.has(agentId) ? 'review' : 'comment' };
      if (draw.length < max) draw.push(item); else deferred.push(item);
    }
  }
  return { draw, deferred, skipped };
}
const preFix = reviewAssignmentsPreFix(carriedD, { alreadyFiled: {} });
check('FAILS OLD: the pre-fix draw fills BOTH slots from the unreadable slug (agents 5 and 7 on office-site)',
  preFix.draw.length === MAX_REVIEWS_PER_TICK && preFix.draw.every((d) => d.slug === 'office-site'));
check('FAILS OLD: the pre-fix draw contains nothing from the readable deliverable at all',
  !preFix.draw.some((d) => d.slug === 'verifier-count-ledger'));
check('the new scenario table is therefore evidence, not documentation — it fails against the transcribed old path',
  preFix.draw.length === MAX_REVIEWS_PER_TICK && a4.draw.length === MAX_REVIEWS_PER_TICK
  && JSON.stringify(preFix.draw.map((d) => d.slug)) !== JSON.stringify(a4.draw.map((d) => d.slug)));

/* ═══════════════ §4 — the CEO's queue ═══════════════ */
section('§4 the CEO approval queue');
check('AWAITING-APPROVAL is the CEO\'s queue and it finds the one record at it',
  approvalQueue(carried).length === 1 && approvalQueue(carried)[0].slug === 'a-converged-thing');
check('a loop with nothing converged gives the CEO an empty queue',
  approvalQueue(carried.filter((r) => r.stage === 'IN-REVIEW')).length === 0);

/* ═══════════════ §5 — the probation meeting ═══════════════ */
section('§5 the probation decision draw');
check('nothing due → nothing drawn', probationDecisionDraw([]).draw.length === 0);
check('one due → one drawn', probationDecisionDraw([{ id: 'a' }]).draw.length === 1);
check('two due → one drawn and the other DEFERRED, not dropped',
  (() => { const r = probationDecisionDraw([{ id: 'a' }, { id: 'b' }]); return r.draw.length === 1 && r.deferred.length === 1; })());
check('a row with no id is refused rather than half-decided',
  probationDecisionDraw([{ agent_id: 2 }]).draw.length === 0);

/* ═══════════════ §6 — incident triage ═══════════════ */
section('§6 incident triage');
const CUTOFF = '2026-08-16 10:00:00';
const INCIDENTS = [
  { created_at: '2026-08-17 06:31:12', title: 'a', content: 'x' },
  { created_at: '2026-08-16 12:01:35', title: 'b', content: 'x' },
  { created_at: '2026-08-15 09:00:00', title: 'too old', content: 'x' },
];
const inc = recentIncidents(INCIDENTS, CUTOFF);
check('rows older than the cutoff are excluded', inc.total === 2);
check('rows are newest first', inc.triaged[0].created_at === '2026-08-17 06:31:12');
check('an empty window gives total 0 and nothing triaged',
  (() => { const r = recentIncidents(INCIDENTS, '2026-08-18 00:00:00'); return r.total === 0 && r.triaged.length === 0; })());
const many = Array.from({ length: 40 }, (_, i) => ({ created_at: `2026-08-17 0${i % 10}:00:00`, title: `t${i}`, content: 'x' }));
const capped = recentIncidents(many, '2026-08-17 00:00:00');
check(`the note is capped at MAX_INCIDENTS_PER_NOTE (${MAX_INCIDENTS_PER_NOTE})`,
  capped.triaged.length === MAX_INCIDENTS_PER_NOTE);
check('the cap is NOT silent — `total` and `overflow` both survive to the caller',
  capped.total === 40 && capped.overflow === 40 - MAX_INCIDENTS_PER_NOTE);
check('a malformed row (no created_at) is dropped rather than crashing the desk',
  recentIncidents([{ title: 'no timestamp' }], CUTOFF).total === 0);

/* ═══════════════ §7 — the honest summary ═══════════════ */
section('§7 the summary distinguishes empty from failed');
const SUMMARY = deskSummary([
  { desk: 'deliverable_review', agentIds: [5, 6], queued: 21, produced: 2 },
  { desk: 'ceo_approval', agentIds: [], queued: 0, produced: 0 },
  { desk: 'probation_decision', agentIds: [], queued: 1, produced: 0, reason: 'the judgment lane returned nothing' },
]);
check('a desk that produced says what it produced and out of how deep a queue',
  /2 produced from a queue of 21/.test(SUMMARY[0]));
check('an EMPTY queue says "nothing written, nothing recorded"',
  /queue empty — nothing written, nothing recorded/.test(SUMMARY[1]));
check('a NON-empty queue that produced nothing is a different sentence, and carries the reason',
  /1 queued and 0 produced/.test(SUMMARY[2]) && /judgment lane/.test(SUMMARY[2]));
check('a desk that returned nothing at all is called a defect, not an empty queue',
  /defect/.test(deskSummary([null])[0]));
check('producedAnything() is false when every queue was empty',
  producedAnything([{ produced: 0, queued: 0 }, { produced: 0, queued: 0 }]) === false);
check('producedAnything() is true as soon as one desk produced',
  producedAnything([{ produced: 0, queued: 0 }, { produced: 1, queued: 3 }]) === true);

/* ═══════════════ §8 — the wiring, asserted against the real files ═══════════════ */
section('§8 the wiring');
const runner = readFileSync(path.join(ROOT, 'workers/agent-runner.js'), 'utf8');
const schedule = JSON.parse(readFileSync(path.join(ROOT, 'config/daily-schedule.json'), 'utf8'));
const budget = readFileSync(path.join(ROOT, 'workers/subrequest-budget.js'), 'utf8');

check('the block has a handler', /async function processAdminDeskBlock\(/.test(runner));
check('the scheduled path calls it', /block\.type === 'admin_desk'/.test(runner));
check('there is a supervised trigger for it', /case 'admin_desk_block'/.test(runner));
check('it is gated on office_context_enabled and has NO switch of its own',
  /\[admin-desk\] office_context_enabled is not true/.test(runner)
  && !/admin_desk_enabled/.test(runner));
check('the block is on the Sun-Thu schedule at a tick that carries nothing else',
  (() => {
    const blocks = schedule.full_day_schedule.blocks;
    const mine = blocks.filter((b) => b.type === 'admin_desk');
    if (mine.length !== 1) return false;
    return blocks.filter((b) => b.time === mine[0].time).length === 1;
  })());
check('the Sun-Thu block array is still sorted by time (blocks[0] opens the day, blocks[last] closes it)',
  schedule.full_day_schedule.blocks.every((b, i, a) => i === 0 || a[i - 1].time <= b.time));
check('it is NOT on the Friday schedule, and the program says why rather than leaving it implied',
  !schedule.friday_schedule.blocks.some((b) => b.type === 'admin_desk')
  && /NOT Friday/.test(schedule.admin_desk_program.description));
check('Saturday is still a zero-activity day',
  !schedule.saturday_schedule.blocks.some((b) => b.type === 'admin_desk'));
check('the block has an invocation-budget cost, and it is labelled as arithmetic rather than measured',
  /admin_desk: \d+,\s*\/\/ ARITHMETIC, not measured/.test(budget));
check('an unreadable queue is reported as unreadable, never collapsed into empty',
  /which is not the same fact as empty/.test(runner));
check('a review is refused rather than fabricated when the artifact cannot be read',
  /fabricated participation/.test(runner));
check('no block artifact is written on a day when every queue was empty',
  /NO BLOCK ARTIFACT ON AN EMPTY DAY/.test(runner));
check('the desk files its reports rows under a distinct type, not `status`',
  /ADMIN_DESK_REPORT_TYPE = 'admin_desk'/.test(runner));
check('an empty string from a 200 is treated as a failure, not a review',
  /empty_text_from_provider/.test(runner));
/*
 * The FIRST live run's finding, mechanized. Agent 6's round-0 review claimed to
 * have run the scripts against three test repositories; it had been handed one
 * markdown file. A reviewer that narrates work it did not do produces exactly
 * the artifact a later reader trusts most, and the lifecycle APPLIES these.
 */
check('the review prompt tells the reviewer, in words, that it has run nothing',
  /You have NOT run this code/.test(runner) && /no "I ran"/.test(runner));
check('...and tells it that "I cannot tell from this" is a real finding, so refusing is available',
  /name what you would need/i.test(runner));
check('the review budget leaves room for the VERDICT line, and says why the number changed',
  /neither reached its\s*\n?\s*\/\/ VERDICT line/.test(runner) || /reached its VERDICT line/.test(runner));
/*
 * The first live run's SECOND finding. Agent 5 wrote `**Verdict:** revise` —
 * markdown emphasis, after four hundred words of bold headings — and the
 * inline `/VERDICT:\s*(...)/i` did not match across the `**`. The review was
 * filed with `verdict: null`, which is indistinguishable from a reviewer who
 * never reached one. A parser strict enough to drop a decision plainly made is
 * losing, not refusing.
 */
check('all three decision words go through ONE parser: defined once, called three times',
  (runner.match(/parseDecisionWord\(/g) || []).length === 4);
check('...and no decision word is still pulled out by an inline .exec()',
  // Deliberately NOT a search for the old regex TEXT: parseDecisionWord()'s own
  // header quotes it to explain what went wrong, and a check that reads a
  // comment as code is a check that fails on its own documentation. Asserted
  // against the executable shape instead — a regex literal ending `.exec(`.
  !/\/[^\n]*(VERDICT|OUTCOME|DECISION)[^\n]*\/i?\.exec\(/.test(runner));
check('...and that parser strips markdown emphasis before matching',
  /replace\(\/\[\*_`\]\/g/.test(runner));
check('...while a genuine no-match still returns null for the caller to refuse on',
  /return m \? m\[1\]\.toLowerCase\(\) : null;/.test(runner));

/* ═══════════════ done ═══════════════ */
console.log(`\n${fail === 0 ? '✅' : '❌'} verify-admin-desk: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
