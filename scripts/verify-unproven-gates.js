#!/usr/bin/env node
/*
 * scripts/verify-unproven-gates.js — OB-078.
 *
 * ── WHAT "UNPROVEN" MEANT, AND WHY IT IS ITS OWN VERDICT ─────────────────
 *
 * The gate-call audit (back-office `tools/gate-call-audit/`) reported
 * 31 CALLED · 13 UNPROVEN · 0 NOT-CALLED · 3 RETIRED on 2026-08-16.
 *
 * UNPROVEN is not "unwired". Every one of the 13 has a live production call
 * site. What none of them had is a test that ever fed the gate the thing it
 * exists to refuse. That gap is the one this project keeps falling into from
 * a slightly different angle each time (KFM-08, KFM-26): the mechanism is
 * built, it is connected, and nobody ever checked that it says no.
 *
 * A gate is proven when it has been shown to REFUSE, not when it has been
 * shown to return. So every scenario below is adversarial: it constructs the
 * input the gate is supposed to reject and asserts the rejection, and where a
 * gate has an allow path it asserts that too — a gate that refuses everything
 * is an outage, not a control (the falsifiability rule KFM-08b records).
 *
 * ── WHY ONLY SOME OF THE 13 ARE HERE ────────────────────────────────────
 *
 * Six of the thirteen turned out to be unprovable for a STRUCTURAL reason
 * rather than a missing test, and that is a finding in its own right:
 *
 *   `workers/agent-runner.js` and the two operational `.mjs` scripts cannot be
 *   imported by a Node verifier at all — the Worker entry point pulls Workers-
 *   only bindings, and `report-watchdog.mjs` / `cross-project-health-check.mjs`
 *   execute their whole check at import time and export nothing. A test cannot
 *   call what it cannot load.
 *
 * Two things were done about that rather than reporting it and stopping:
 *
 *   1. `workers/model-router.js` and `workers/meeting-engine.js` WERE
 *      unloadable for a fixable reason — bare `import x from './y.json'`,
 *      which Workers accepts and Node does not. Adding `with { type: 'json' }`
 *      makes both loadable with no behaviour change (`wrangler deploy
 *      --dry-run` confirms the bundle still builds), which is what let §1, §3,
 *      §4 and §5 exist at all.
 *   2. Two private functions were exported for the sole purpose of being
 *      exercised by name — see the note at each definition. Testing them only
 *      through their callers would prove the behaviour and leave the audit
 *      still reporting UNPROVEN, because that tool counts call sites by name.
 *
 * The remainder are reported with what each needs, in this file's closing
 * summary. NOT silently omitted — an unlisted gate reads as a covered one.
 *
 * NO NETWORK. `globalThis.fetch` is a tripwire that throws.
 *
 * Run: node scripts/verify-unproven-gates.js
 */

import { checkUnknownCapPacing, checkProviderAllowance } from '../workers/task-router.js';
import { learningLoopEnabled } from '../workers/context-editor.js';
import { getClaudeBudgetStatus, resolveTaskLane, resolveImageRoles } from '../workers/model-router.js';
import { actionItemsToBoardEnabled, resolveAttendeeIds } from '../workers/meeting-engine.js';

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-unproven-gates.js must make no network call'); };

let passed = 0; let failed = 0;
const check = (label, cond) => {
  if (cond) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
};
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

/* ── fakes ───────────────────────────────────────────────────────────────── */

/** KV fake. `store` is inspectable so a check-and-SET can be proven to have set. */
const fakeKv = (initial = {}) => {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
};

/** D1 fake returning one canned row for the budget SELECT. */
const fakeDbWithSpend = (spentUsd) => ({
  prepare: () => ({
    bind: () => ({ first: async () => ({ spent_usd: spentUsd, call_count: 1 }) }),
    run: async () => ({}),
    first: async () => ({ spent_usd: spentUsd, call_count: 1 }),
  }),
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §1  getClaudeBudgetStatus — the gate on MONEY
 * ═══════════════════════════════════════════════════════════════════════════
 * The only thing standing between the office and an overrun of the owner's
 * $4.50/month Anthropic soft-stop. Its `overBudget` flag is read by
 * _askDataCenter() before every Claude call. It had no test.
 */
section('§1 getClaudeBudgetStatus — refuses when the month is spent');

const overBudget = await getClaudeBudgetStatus({ DB: fakeDbWithSpend(99) });
check('REFUSES: spend far past the cap sets overBudget', overBudget.overBudget === true);
check('...and remaining is clamped at 0, never negative', overBudget.remainingUsd === 0);

const underBudget = await getClaudeBudgetStatus({ DB: fakeDbWithSpend(0.01) });
check('FALSIFIABLE: a nearly-unspent month is NOT over budget', underBudget.overBudget === false);
check('...and reports remaining headroom', underBudget.remainingUsd > 0);

// The boundary. `>=` not `>` is the difference between stopping AT the cap and
// one call past it, and a soft-stop that triggers late is not a soft-stop.
const atCap = await getClaudeBudgetStatus({ DB: fakeDbWithSpend(underBudget.capUsd) });
check('BOUNDARY: spend exactly equal to the cap is over budget, not under', atCap.overBudget === true);

// The two components draw on separate month rows and separate caps. A guides
// overrun must not be able to stop the Q&A engine, or vice versa.
const guides = await getClaudeBudgetStatus({ DB: fakeDbWithSpend(0) }, { component: 'guides' });
const qa = await getClaudeBudgetStatus({ DB: fakeDbWithSpend(0) }, { component: 'qa' });
check('the guides component keys a DIFFERENT month row than qa', guides.month !== qa.month);
check('the guides month key is the documented `YYYY-MM#guides` shape', /#guides$/.test(guides.month));

// DEGRADES OPEN without D1 — asserted rather than assumed, because "no binding"
// silently meaning "$0 spent" is exactly the KFM-13 shape and a reader should
// find it pinned here rather than discover it in an incident.
const noDb = await getClaudeBudgetStatus({});
check('KNOWN POSTURE: with no D1 binding it degrades OPEN, treating spend as $0',
  noDb.overBudget === false && noDb.spentUsd === 0);

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  checkUnknownCapPacing — the gate on a QUOTA THAT CANNOT BE COUNTED
 * ═══════════════════════════════════════════════════════════════════════════
 * Four providers publish no daily ceiling, so policy limits them by wall clock
 * instead: 20s minimum spacing. This function is the whole of that protection.
 */
section('§2 checkUnknownCapPacing — refuses a call inside the spacing window');

const NOW = 1_000_000_000_000;
const SPACING = 20_000;

const tooSoon = await checkUnknownCapPacing(
  { SIM_KV: fakeKv({ 'routing-pace:cerebras': String(NOW - 5_000) }) }, 'cerebras', SPACING, NOW);
check('REFUSES: a call 5s after the last one is denied', tooSoon.allowed === false);
check('...and reports the elapsed time rather than a bare false', tooSoon.elapsedMs === 5_000);

const boundaryKv = fakeKv({ 'routing-pace:cerebras': String(NOW - SPACING) });
const exactly = await checkUnknownCapPacing({ SIM_KV: boundaryKv }, 'cerebras', SPACING, NOW);
check('BOUNDARY: exactly at the spacing is allowed (>= not >)', exactly.allowed === true);

const lateKv = fakeKv({ 'routing-pace:cerebras': String(NOW - 60_000) });
const late = await checkUnknownCapPacing({ SIM_KV: lateKv }, 'cerebras', SPACING, NOW);
check('FALSIFIABLE: a call a full minute later is allowed', late.allowed === true);
check('CHECK-AND-SET: an allowed check CONSUMES the slot by writing the new timestamp',
  lateKv.store.get('routing-pace:cerebras') === String(NOW));
check('...and a REFUSED check does NOT move the timestamp (else a caller could starve itself)',
  (await (async () => {
    const kv = fakeKv({ 'routing-pace:cerebras': String(NOW - 1_000) });
    await checkUnknownCapPacing({ SIM_KV: kv }, 'cerebras', SPACING, NOW);
    return kv.store.get('routing-pace:cerebras');
  })()) === String(NOW - 1_000));

check('providers are paced INDEPENDENTLY — one provider\'s recent call does not block another',
  (await checkUnknownCapPacing(
    { SIM_KV: fakeKv({ 'routing-pace:cerebras': String(NOW) }) }, 'mistral', SPACING, NOW)).allowed === true);

const degraded = await checkUnknownCapPacing({}, 'cerebras', SPACING, NOW);
check('KNOWN POSTURE: with no SIM_KV it degrades OPEN and SAYS SO in the return value',
  degraded.allowed === true && degraded.degradedOpen === true);

// Reached through its real caller too, so the wiring is proven and not just the
// function. A never-called provider has no stored timestamp: elapsed is huge.
const viaCaller = await checkProviderAllowance(
  { SIM_KV: fakeKv({ 'routing-pace:cerebras': String(NOW - 1_000) }), CEREBRAS_API_KEY: 'x' },
  'cerebras',
  { tokenEconomy: { providers: { cerebras: { requests_per_day: null } } }, routingConfig: {}, now: NOW });
check('WIRED: the refusal surfaces through checkProviderAllowance as `unknown_cap_paced`',
  viaCaller.allowed === false && viaCaller.reason === 'unknown_cap_paced');

/* ═══════════════════════════════════════════════════════════════════════════
 * §3  learningLoopEnabled — the gate on WRITING AN AGENT'S CONTEXT
 * ═══════════════════════════════════════════════════════════════════════════
 * OFFICE-POLICY A2's red line runs through here: this flag is what stands
 * between the office and edits to the files that shape how agents behave.
 */
section('§3 learningLoopEnabled — absent means OFF, and only literal true means ON');

/*
 * The KV fake honours `get(key, 'json')` — the second argument Workers KV
 * actually takes — and the first version of this file did not. It returned a
 * JSON STRING regardless of type, so `stored?.[FLAG]` indexed a string, came
 * back undefined, and both "literal true opens the gate" checks failed while
 * the production code was correct. A fake that does not model the real
 * signature does not test the real function; it tests the fake. Left recorded
 * because the failure mode (a green suite built on a wrong stub) is worse than
 * the bug it hides.
 */
const flagKv = (value) => ({ SIM_KV: {
  get: async (_key, type) => {
    if (value === undefined) return null;
    const raw = JSON.stringify(value);
    if (type !== 'json') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  },
  put: async () => {},
} });

/** Stores a RAW string and honours type 'json' — for the unparseable case. */
const rawKv = (raw) => ({ SIM_KV: {
  get: async (_key, type) => {
    if (type !== 'json') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  },
  put: async () => {},
} });

check('REFUSES: no simulation-state key at all reads as OFF', (await learningLoopEnabled(flagKv(undefined))) === false);
check('REFUSES: state present but the flag absent reads as OFF', (await learningLoopEnabled(flagKv({}))) === false);
check('REFUSES: explicit false reads as OFF', (await learningLoopEnabled(flagKv({ learning_loop_enabled: false }))) === false);
check('REFUSES: a TRUTHY NON-BOOLEAN does not open the gate ("true" is not true)',
  (await learningLoopEnabled(flagKv({ learning_loop_enabled: 'true' }))) === false);
check('REFUSES: 1 does not open the gate either',
  (await learningLoopEnabled(flagKv({ learning_loop_enabled: 1 }))) === false);
check('FALSIFIABLE: literal boolean true DOES open it', (await learningLoopEnabled(flagKv({ learning_loop_enabled: true }))) === true);
check('REFUSES: no SIM_KV binding reads as OFF, not as unknown-so-allow', (await learningLoopEnabled({})) === false);
check('REFUSES: unparseable stored JSON reads as OFF rather than throwing into a caller',
  (await learningLoopEnabled(rawKv('{not json'))) === false);

/* ═══════════════════════════════════════════════════════════════════════════
 * §4  actionItemsToBoardEnabled — the gate on WRITING TO THE BOARD
 * ═══════════════════════════════════════════════════════════════════════════
 * Meeting action items become real board tasks through this flag. CTL-01
 * records that the board's single-writer contract is what stopped a fabricated
 * transcript claiming live work; this flag is that writer's on switch.
 */
section('§4 actionItemsToBoardEnabled — same contract, on the board write path');

check('REFUSES: absent reads as OFF', (await actionItemsToBoardEnabled(flagKv(undefined))) === false);
check('REFUSES: explicit false reads as OFF', (await actionItemsToBoardEnabled(flagKv({ action_items_to_board_enabled: false }))) === false);
check('REFUSES: a truthy non-boolean does not open the board write path',
  (await actionItemsToBoardEnabled(flagKv({ action_items_to_board_enabled: 'yes' }))) === false);
check('FALSIFIABLE: literal true DOES open it', (await actionItemsToBoardEnabled(flagKv({ action_items_to_board_enabled: true }))) === true);
check('REFUSES: no SIM_KV binding reads as OFF', (await actionItemsToBoardEnabled({})) === false);

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  resolveAttendeeIds — who a PUBLISHED TRANSCRIPT may name
 * ═══════════════════════════════════════════════════════════════════════════
 * enforceAttendeeGate() checks every speaker against the declared attendee
 * list. This function produces that list — so an error here is invisible to
 * the gate, which would faithfully validate against a wrong roster.
 */
section('§5 resolveAttendeeIds — the declared list the attribution gate checks against');

check('an explicit attendee list is honoured verbatim',
  JSON.stringify(resolveAttendeeIds('daily_standup', { attendees: [1, 2] })) === JSON.stringify([1, 2]));
check('an EMPTY explicit list does not silently become the default (it falls through deliberately)',
  resolveAttendeeIds('daily_standup', { attendees: [] }).length > 0);
check('audit_session always seats QA(6) and Team Lead(7) plus the audited agent',
  (() => { const r = resolveAttendeeIds('audit_session', { auditedAgentId: 3 }); return r.includes(6) && r.includes(7) && r.includes(3); })());
check('an audited agent who IS a reviewer is not seated twice (the ids are deduped)',
  resolveAttendeeIds('audit_session', { auditedAgentId: 6 }).filter((x) => x === 6).length === 1);
check('pip_session seats the Team Lead and the target', (() => {
  const r = resolveAttendeeIds('pip_session', { targetAgentId: 4 }); return r.includes(7) && r.includes(4);
})());
check('an unknown meeting type falls back to leadership rather than to everyone',
  JSON.stringify(resolveAttendeeIds('no_such_meeting', {})) === JSON.stringify([11, 7]));
check('every resolved id is a number, so a stringly-typed id can never reach the gate as a "match"',
  resolveAttendeeIds('audit_session', { auditedAgentId: 3 }).every((x) => typeof x === 'number'));

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  resolveTaskLane / resolveImageRoles — the ANTHROPIC-UNREACHABLE rule
 * ═══════════════════════════════════════════════════════════════════════════
 * CLAUDE.md: "Anthropic is unreachable from routing, enforced two independent
 * ways." verify-routing.js proves that for `resolveLane()`, the pure function.
 * These two are model-router's config-bound wrappers — the ones production
 * actually calls — and nothing had ever exercised THEM.
 */
section('§6 resolveTaskLane — the architect lane refuses to route, at the bound wrapper');

const architect = resolveTaskLane('architect');
check('REFUSES: the architect lane is not routable', architect.routable === false);
check('...and names no provider to route to', !architect.candidates || architect.candidates.length === 0);
check('...and gives a reason rather than an empty refusal', typeof architect.reason === 'string' && architect.reason.length > 0);

const unknownLane = resolveTaskLane('no_such_lane_exists');
check('REFUSES: an unknown lane does not silently fall back to some default provider',
  unknownLane.routable === false || !(unknownLane.candidates || []).length);

const judgment = resolveTaskLane('judgment');
check('FALSIFIABLE: a real lane still resolves to its ordered candidates', judgment.routable === true && judgment.candidates.length > 0);
check('...and no lane in the live table names anthropic',
  !(judgment.candidates || []).some((c) => /anthropic|claude/i.test(c)));

const imageRoles = resolveImageRoles();
check('resolveImageRoles returns the role map from live config', imageRoles !== null && typeof imageRoles === 'object');
check('...and no image role names anthropic either',
  !JSON.stringify(imageRoles).match(/anthropic/i));

/* ═══════════════════════════════════════════════════════════════════════════
 * summary
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');
console.log('  PROVEN HERE (7 of the audit\'s 13 UNPROVEN gates), each shown to REFUSE:');
console.log('    getClaudeBudgetStatus · checkUnknownCapPacing · learningLoopEnabled');
console.log('    actionItemsToBoardEnabled · resolveAttendeeIds · resolveTaskLane');
console.log('    resolveImageRoles');
console.log('');
console.log('  NOT PROVEN HERE, and what each would need — listed because an');
console.log('  omitted gate reads as a covered one:');
console.log('    guidesEnabled, checkProductVersionBumps  (workers/agent-runner.js)');
console.log('      -> the Worker entry point cannot be imported by a Node verifier.');
console.log('         Needs both lifted into an importable module, the way');
console.log('         guide-engine.js/report-pipeline.js already separate logic');
console.log('         from the entry point. Real work, not a missing test.');
console.log('    checkReports, checkBranches, isRestDay  (scripts/report-watchdog.mjs)');
console.log('    resolveGate                             (scripts/cross-project-health-check.mjs)');
console.log('      -> both scripts RUN their whole check at import time and export');
console.log('         nothing, so importing one executes it. Needs the usual');
console.log('         module + thin entry-point split. These four are A16 external');
console.log('         checks: they guard no write and touch no credential, which is');
console.log('         why they are last rather than skipped.');
console.log(`\n  Audit verdict after this file: 38 CALLED · 6 UNPROVEN · 0 NOT-CALLED · 3 RETIRED`);
console.log(`  (re-run back-office tools/gate-call-audit/gate-call-audit.js to confirm)`);

if (failed) { console.log('\nUNPROVEN-gate verification FAILED.'); process.exit(1); }
console.log('\nAll scenarios matched expectations.');
