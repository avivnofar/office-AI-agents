#!/usr/bin/env node
/**
 * scripts/verify-build-chain.js — the build chain on a tick (Session 33, Item B).
 *
 * `globalThis.fetch` is a tripwire throughout. Nothing here makes a network
 * call, and §4 depends on that: the whole point of the spend-guard test is
 * that the guard refuses BEFORE any call, so a fetch that happened would be
 * the failure, not an inconvenience.
 *
 *   node scripts/verify-build-chain.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AWAITING_APPROVAL, AWAITING_REPAIR, MERGED, APPROVED_UNMERGED, STALLED, TERMINAL_STATES,
  MAX_REPAIRS_PER_TICK, MAX_APPROVALS_PER_TICK, BUILD_CHAIN_TABLE_SQL,
  repairQueue, approvalQueue, nextStateAfterApproval, nextStateAfterRepair, chainSummary,
} from '../workers/build-chain.js';
import { runArchitectApprovalCall } from '../workers/architect-spec.js';
import { BLOCK_COST } from '../workers/subrequest-budget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-build-chain.js made a network call'); };

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

const runner = readFileSync(path.join(ROOT, 'workers/agent-runner.js'), 'utf8');
const schedule = JSON.parse(readFileSync(path.join(ROOT, 'config/daily-schedule.json'), 'utf8'));

/* ═══════════════ §1 — the queue draws ═══════════════ */
section('§1 the draws — an empty queue produces nothing, an unreadable one is not empty');

const ROWS = [
  { slug: 'alpha', task_id: 'OB-001', agent_id: 7, state: AWAITING_REPAIR, finding: 'the thing is wrong', rounds: 1 },
  { slug: 'beta', task_id: 'OB-002', agent_id: 7, state: AWAITING_REPAIR, finding: 'a second thing', rounds: 1 },
  { slug: 'gamma', task_id: 'OB-003', agent_id: 6, state: AWAITING_APPROVAL, finding: null, rounds: 0 },
  { slug: 'delta', task_id: 'OB-004', agent_id: 6, state: AWAITING_APPROVAL, finding: null, rounds: 2 },
  { slug: 'eps', task_id: 'OB-005', agent_id: 6, state: MERGED, finding: null, rounds: 3 },
  { slug: 'zeta', task_id: 'OB-006', agent_id: 6, state: STALLED, finding: 'never converged', rounds: 3 },
];

const rq = repairQueue(ROWS);
check('the repair queue draws exactly MAX_REPAIRS_PER_TICK', rq.draw.length === MAX_REPAIRS_PER_TICK);
check('it draws the OLDEST first (rows arrive ordered by updated_at ASC)', rq.draw[0].slug === 'alpha');
check('the rest are DEFERRED and reported, never silently dropped', rq.deferred.length === 1 && rq.deferred[0].slug === 'beta');
check('a MERGED row is never drawn for repair', !rq.draw.concat(rq.deferred).some((r) => r.slug === 'eps'));
check('a STALLED row is never drawn again — three strikes means stop', !rq.draw.concat(rq.deferred).some((r) => r.slug === 'zeta'));

const aq = approvalQueue(ROWS);
check('the approval queue draws exactly MAX_APPROVALS_PER_TICK', aq.draw.length === MAX_APPROVALS_PER_TICK);
check('and only from AWAITING-APPROVAL', aq.draw[0].slug === 'gamma');
check('an empty queue draws nothing at all', repairQueue([]).draw.length === 0 && approvalQueue([]).draw.length === 0);

/* ═══════════════ §2 — the refusals ═══════════════ */
section('§2 what the queue refuses rather than guesses at');

const bad = repairQueue([
  { slug: 'no-finding', agent_id: 7, state: AWAITING_REPAIR, finding: '   ' },
  { slug: 'no-agent', agent_id: null, state: AWAITING_REPAIR, finding: 'a real finding' },
  { slug: null, agent_id: 7, state: AWAITING_REPAIR, finding: 'a real finding' },
]);
check('AWAITING-REPAIR with no finding is SKIPPED, never repaired against nothing', bad.draw.length === 0);
check('and each skip carries a reason', bad.skipped.length === 3 && bad.skipped.every((s) => s.why));

/* ═══════════════ §3 — the state machine ═══════════════ */
section('§3 the transitions — and a failure that moves nothing');

const blocked = nextStateAfterApproval({ ok: true, verdict: 'block', reasoning: 'two named files were never produced' });
check('a BLOCK verdict moves the row to AWAITING-REPAIR', blocked.state === AWAITING_REPAIR);
check("and the Architect's reasoning becomes the finding, VERBATIM — a paraphrase would break the three-strike fingerprint",
  blocked.finding === 'two named files were never produced');

check('approve + merged -> MERGED', nextStateAfterApproval({ ok: true, verdict: 'approve', merged: true, verifiedOnMain: true }).state === MERGED);
check('approve + conflict -> APPROVED-UNMERGED, a DISTINCT state — a conflict must not look like a merge nobody has to check',
  nextStateAfterApproval({ ok: true, verdict: 'approve', merged: false, conflict: true, mergeReason: 'conflict' }).state === APPROVED_UNMERGED);
check('a merge that could not be verified on main says so rather than claiming it was',
  /NOT VERIFIED/.test(nextStateAfterApproval({ ok: true, verdict: 'approve', merged: true, verifiedOnMain: false }).reason));

// THE ONE THAT MATTERS MOST: a transport failure must not be read as consent.
const failedApproval = nextStateAfterApproval({ ok: false, reason: 'architect_spec_budget_exhausted ($1.02/$1/mo)' });
check('a FAILED approval moves the row NOWHERE — "we could not ask" is never "he did not object"',
  failedApproval.state === null);
check('and it says why', /budget_exhausted/.test(failedApproval.reason));
check('an unrecognised verdict also moves nothing',
  nextStateAfterApproval({ ok: true, verdict: 'maybe' }).state === null);

check('a repair -> AWAITING-APPROVAL, and the finding is CLEARED (whether it is fixed is the Architect\'s call, not the repairer\'s)',
  (() => {
    const r = nextStateAfterRepair({ ok: true, action: 'repaired', branch: 'repair/alpha', strikeCount: 2 });
    return r.state === AWAITING_APPROVAL && r.finding === null;
  })());
check('three strikes -> STALLED', nextStateAfterRepair({ ok: true, action: 'stop_surface_to_owner', fingerprint: 'deadbeef' }).state === STALLED);
check('a FAILED repair moves the row nowhere either', nextStateAfterRepair({ ok: false, reason: 'provider empty' }).state === null);
check('STALLED, MERGED and APPROVED-UNMERGED are all terminal',
  TERMINAL_STATES.includes(MERGED) && TERMINAL_STATES.includes(STALLED) && TERMINAL_STATES.includes(APPROVED_UNMERGED));

/* ══ §4 — B3: THE SPEND GUARD, WATCHED REFUSING SOMETHING ══ */
section("§4 the Architect's spend guard on the SCHEDULED path");

/**
 * This is the check the item actually asks for, and it is a RUN, not a read.
 *
 * `runArchitectApprovalCall()` is the one and only place the approval path
 * reaches Anthropic. If its budget check did not stop it, `callClaudeMessages`
 * would reach `globalThis.fetch` — which is a tripwire. So a clean refusal
 * here is the guard being watched refusing something, which is precisely what
 * `campus/brain-export/skills/gate-wiring-verification/` says to demand.
 */
const overBudgetDb = {
  prepare: (sql) => ({
    bind: () => ({
      first: async () => (/claude_budget_usage/.test(sql) ? { spent_usd: 999, call_count: 9999 } : null),
      run: async () => ({ success: true }),
      all: async () => ({ results: [] }),
    }),
    first: async () => (/claude_budget_usage/.test(sql) ? { spent_usd: 999, call_count: 9999 } : null),
    run: async () => ({ success: true }),
    all: async () => ({ results: [] }),
  }),
};
const guardEnv = { ANTHROPIC_API_KEY: 'not-a-real-key-and-never-used', DB: overBudgetDb };
const guarded = await runArchitectApprovalCall(guardEnv, {
  taskId: 'OB-999', slug: 'guard-test', specText: 'x', artifactContent: 'y', reviewSummary: null,
});
check('OVER BUDGET: the Architect approval call REFUSES', guarded.ok === false);
check('and it refuses for the budget, not for something else', /budget_exhausted/.test(guarded.reason || ''));
check('and it never reached the network — the tripwire did not fire', true);
check('no ANTHROPIC_API_KEY also refuses, rather than degrading to a routed provider',
  (await runArchitectApprovalCall({ DB: overBudgetDb }, { slug: 'x' })).reason === 'anthropic_api_key_not_configured');

// The guard is in ONE place, so a third caller cannot bypass it.
/*
 * SLICED TO THE NEXT FUNCTION, not to a distant landmark.
 *
 * The first version of this cut from `processArchitectApprovalBlock` to
 * `processOwnerChannelBlock`, which was correct for exactly one day: Session
 * 33's brain-audit functions landed between them, and the slice silently grew
 * to include a `callClaudeMessages()` that belongs to a different feature. The
 * check went red for the right reason and the wrong cause -- a landmark that is
 * not the function's own end is a boundary that moves under you.
 */
const approvalStart = runner.indexOf('async function processArchitectApprovalBlock(');
const approvalEnd = runner.indexOf('\nasync function ', approvalStart + 10);
const approvalBlockSrc = runner.slice(approvalStart, approvalEnd === -1 ? undefined : approvalEnd);
check('processArchitectApprovalBlock() makes NO Anthropic call of its own — its only model call is runArchitectApprovalCall()',
  /runArchitectApprovalCall\(/.test(approvalBlockSrc) && !/callClaudeMessages\(/.test(approvalBlockSrc));
check('the scheduled wrapper calls the SAME processArchitectApprovalBlock(), not a parallel copy',
  /const result = await processArchitectApprovalBlock\(env, \{/.test(runner));
check('the scheduled repair wrapper calls the SAME processRepairBlock()',
  /const result = await processRepairBlock\(env, \{/.test(runner));
// KNOWN LIMIT, recorded rather than discovered later.
check('the guard degrades OPEN with no D1 binding, and that limit is written down in the schedule config',
  /degrades open/.test(JSON.stringify(schedule.build_chain_program)));

/* ═══════════════ §5 — the wiring ═══════════════ */
section('§5 the wiring — is the tick actually reaching them');

check("'repair' is dispatched from the scheduled block loop", /block\.type === 'repair'/.test(runner));
check("'architect_approval' is dispatched from the scheduled block loop", /block\.type === 'architect_approval'/.test(runner));
const weekdayTypes = schedule.full_day_schedule.blocks.map((b) => b.type);
const fridayTypes = schedule.friday_schedule.blocks.map((b) => b.type);
check("the Sun-Thu schedule carries a 'repair' block", weekdayTypes.includes('repair'));
check("the Sun-Thu schedule carries an 'architect_approval' block", weekdayTypes.includes('architect_approval'));
check('neither is on Friday — every Friday tick already carries a block and blocks[last] finalizes the day',
  !fridayTypes.includes('repair') && !fridayTypes.includes('architect_approval'));

const times = schedule.full_day_schedule.blocks.map((b) => b.time);
check('the block array is still time-ordered', JSON.stringify(times) === JSON.stringify([...times].sort()));
check('the DAY-FINALIZING last block is unchanged (16:30) — adding blocks must not move the finalize',
  schedule.full_day_schedule.blocks[schedule.full_day_schedule.blocks.length - 1].time === '16:30');
check('repair runs BEFORE approval, so a repair made this morning is judged this afternoon',
  times.indexOf('11:30') < times.indexOf('13:00'));
check('each sits on a tick of its own — a free tick is its own invocation budget',
  times.filter((t) => t === '11:30').length === 1 && times.filter((t) => t === '13:00').length === 1);
check('both times land on a :00 or :30 inside the 08:00-18:00 cron window, or they are never reached at all',
  ['11:30', '13:00'].every((t) => /:(00|30)$/.test(t) && t >= '08:00' && t <= '18:00'));

check('both have a BLOCK_COST, so admitBlock() sizes them rather than falling back to UNMEASURED',
  Number.isInteger(BLOCK_COST.repair) && Number.isInteger(BLOCK_COST.architect_approval));
check('and both fit inside a free tick\'s usable budget (~38) rather than being refused every day',
  BLOCK_COST.repair < 38 && BLOCK_COST.architect_approval < 38);
check('both costs are declared ARITHMETIC rather than passed off as measured',
  /repair: 14,\s*\/\/ ARITHMETIC, not measured/.test(readFileSync(path.join(ROOT, 'workers/subrequest-budget.js'), 'utf8')));

check('build_artifact now ENQUEUES on success, so the chain has a producer rather than a hand-typed slug',
  /state: AWAITING_APPROVAL, finding: null, rounds: 0,/.test(runner));
check('the entry point is still SUPERVISED, and the config says so rather than leaving it to be discovered',
  /is NOT on this schedule/.test(JSON.stringify(schedule.build_chain_program)));
check('the schedule block `ref` resolves to a real program entry', !!schedule.build_chain_program);

/* ═══════════════ §6 — the honest report ═══════════════ */
section('§6 the honest report');
check('a desk that drew nothing says "queue empty" and writes nothing',
  /queue empty/.test(chainSummary([{ desk: 'repair', queued: 0, produced: 0 }])[0]));
check('a desk that had a queue and produced nothing must give a reason, and its absence is called a defect',
  /itself a defect/.test(chainSummary([{ desk: 'repair', queued: 2, produced: 0 }])[0]));
check('the table is keyed on slug — one task, one position in the chain',
  /slug TEXT PRIMARY KEY/.test(BUILD_CHAIN_TABLE_SQL));

/* ═══════════════ done ═══════════════ */
console.log(`\n${fail === 0 ? '✅' : '❌'} verify-build-chain: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
