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
// The five added 2026-08-16. The first four became importable only because the
// modules holding them were made loadable — see §7/§8/§9 and this file's header.
import { isRestDay, checkReports, checkBranches, branchVerdict, checkWorkerLiveness, isWorkerCommit } from './report-watchdog.mjs';
import { resolveGate } from './cross-project-health-check.mjs';
import { guidesEnabled } from '../workers/guide-engine.js';
import { checkKvPacingSlot } from '../workers/gemini-pacer.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const __vdir = nodePath.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(nodePath.join(__vdir, '..', rel), 'utf8').replace(/\r\n/g, '\n');

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
 * §7  report-watchdog.mjs — THE A16 EXTERNAL CHECK, now loadable
 * ═══════════════════════════════════════════════════════════════════════════
 * These three were UNPROVEN because the module RAN on import and exported
 * nothing — an architecture property, not a missing habit. 2026-08-16 wrapped
 * its main block in `main()` behind a run-directly guard and exported the
 * gates; `checkReports`/`checkBranches` also take an injectable `exec` so the
 * refusal paths can be reached without a network or a git repo.
 */
section('§7 report-watchdog — isRestDay / checkReports / checkBranches');

check('LOADABLE AT ALL, which is the whole fix: importing it ran nothing',
  typeof isRestDay === 'function' && typeof checkReports === 'function' && typeof checkBranches === 'function');

// isRestDay — the one place the watchdog is ALLOWED to expect silence. Getting
// it wrong in either direction is a false alarm every week, or a missed one.
check('REFUSES to alarm on Saturday (Israel), per A13', isRestDay(new Date('2026-08-15T09:00:00Z')) === true);
check('FALSIFIABLE: Friday is not a rest day', isRestDay(new Date('2026-08-14T09:00:00Z')) === false);
check('FALSIFIABLE: Sunday is not a rest day', isRestDay(new Date('2026-08-16T09:00:00Z')) === false);
// The +3 offset is the point: late Friday UTC is already Saturday in Israel,
// and a watchdog using the host's zone would alarm on the office's rest day.
check('the Israel offset is applied, not the host zone: 21:30 UTC Friday IS Saturday in Israel',
  isRestDay(new Date('2026-08-14T21:30:00Z')) === true);

// checkReports — THE MOST IMPORTANT ASSERTION IN THIS FILE for KFM-13. "The
// office did not report" and "I could not find out" are different facts, and
// this watchdog's exit code drives the midnight run. Collapsing them would
// raise a false DID-NOT-REPORT alarm on every offline or unauthenticated night.
const reportsFound = await checkReports('2026-08-16', {
  exec: () => JSON.stringify([{ commit: { message: 'daily summary\nbody' } }]),
});
check('FALSIFIABLE: a commit found today reports ok', reportsFound.ok === true && reportsFound.daily === 1);
const reportsNone = await checkReports('2026-08-16', { exec: () => '[]' });
check('REFUSES: zero commits reports ok=false — the office did not report',
  reportsNone.ok === false && /did not report today/.test(reportsNone.detail));
const reportsBroken = await checkReports('2026-08-16', {
  exec: () => { const e = new Error('gh: not authenticated'); throw e; },
});
check('KFM-13: a FAILED check reports ok=NULL, never false — "could not check" is not "did not report"',
  reportsBroken.ok === null);
check('...and says in words that the check was not performed', /WAS NOT PERFORMED/.test(reportsBroken.detail));
check('...and is marked offline rather than claiming the github-api method',
  reportsBroken.method === 'offline');

/* ── checkWorkerLiveness — the gate the GitHub Action judges on (OB-130) ────
 *
 * Added 2026-08-17 with the caller. `report-watchdog.mjs`'s only caller
 * anywhere was one line inside the midnight run's prompt, and the owner
 * disabled that run — so the office had no external check at all from
 * 2026-08-15. `.github/workflows/external-check.yml` is the caller, and this
 * is the gate its exit code comes from, so it gets the same three-outcome
 * treatment `checkReports` above gets: found / did-not / COULD-NOT-TELL.
 */
check('a Worker commit is recognised by its message prefix, not its author',
  isWorkerCommit('chore(agents): data-center capability-gap digest — 2026-08-16 [skip ci]') === true
  && isWorkerCommit('chore(office): weekly QA instruments 2026-08-16 [skip ci]') === true
  && isWorkerCommit('office: Agent 6 review on verifier-count-ledger round 0 [skip ci]') === true);
check('FALSIFIABLE: a human session commit is NOT counted as the Worker being alive',
  isWorkerCommit('Agent 13 joined the roster ten days ago and was seated at no meeting') === false
  && isWorkerCommit('') === false);
const liveYes = await checkWorkerLiveness('2026-08-17', {
  exec: () => JSON.stringify([
    { commit: { message: 'a human session commit' } },
    { commit: { message: 'chore(agents): guide draft rejected — x [skip ci]' } },
  ]),
});
check('FALSIFIABLE: one Worker commit among human ones is a pass, and only it is counted',
  liveYes.ok === true && liveYes.commits === 1);
const liveNo = await checkWorkerLiveness('2026-08-17', {
  exec: () => JSON.stringify([{ commit: { message: 'a human session commit' } }]),
});
check('REFUSES: a day of human commits with no Worker commit is an ALARM, not a pass',
  liveNo.ok === false && liveNo.commits === 0);
check('...and the alarm says the cron may not be firing, rather than only a count',
  /cron may not be firing/.test(liveNo.detail));
const liveBroken = await checkWorkerLiveness('2026-08-17', {
  exec: () => { throw new Error('gh: not authenticated'); },
});
check('KFM-13 again: an unreachable API is ok=NULL, never false — "could not tell" is not "did not run"',
  liveBroken.ok === null && /WAS NOT PERFORMED/.test(liveBroken.detail));
check('...and it does not claim the github-api method it never reached',
  liveBroken.method === 'unreachable');
check('a non-list response is a failed check, not zero commits',
  (await checkWorkerLiveness('2026-08-17', { exec: () => '{"message":"Not Found"}' })).ok === null);
check('the liveness signal labels itself WEAK — it is not the daily-summary check',
  liveYes.signal === 'weak');

// checkBranches + branchVerdict — policy A7's evidence.
const fakeRefs = (lines) => (cmd, args) => {
  if (args.includes('symbolic-ref')) return 'origin/main\n';
  return lines.join('\n');
};
const refNowSec = Math.floor(Date.now() / 1000);
const twoActive = checkBranches({
  repos: [{ name: 'demo', dir: '/nope' }],
  existsSync: () => true,
  exec: fakeRefs([
    `origin/main\t${refNowSec}\taviv`,
    `origin/feature-a\t${refNowSec - 86400 * 3}\taviv`,
    `origin/feature-b\t${refNowSec - 86400 * 9}\taviv`,
  ]),
});
check('the default branch is EXCLUDED from the active count, not counted as a stray',
  twoActive[0].active === 2 && !twoActive[0].branches.some((b) => b.branch === 'main'));
check('REFUSES: two active branches is an A7 violation', branchVerdict(twoActive).violation === true);
check('...and the violation names the repo', /demo/.test(branchVerdict(twoActive).violations[0]));
check('...and blocks a new branch there', branchVerdict(twoActive).blockedFromNew.includes('demo'));

const oneActive = checkBranches({
  repos: [{ name: 'demo', dir: '/nope' }],
  existsSync: () => true,
  exec: fakeRefs([`origin/main\t${refNowSec}\taviv`, `origin/feature-a\t${refNowSec - 86400}\taviv`]),
});
check('FALSIFIABLE: ONE active branch is not a violation', branchVerdict(oneActive).violation === false);
check('...but it still blocks opening a second, which is what A7 actually says',
  branchVerdict(oneActive).blockedFromNew.includes('demo'));

const noCheckout = checkBranches({ repos: [{ name: 'demo', dir: '/nope' }], existsSync: () => false, exec: () => '' });
check('KFM-13 again: a missing checkout is reported as unreadable, not as zero branches',
  !!noCheckout[0].error && noCheckout[0].active === undefined);
check('...and an unreadable repo is NOT counted as clean',
  branchVerdict(noCheckout).unreadable.length === 1 && branchVerdict(noCheckout).violation === false);

/* ═══════════════════════════════════════════════════════════════════════════
 * §8  cross-project-health-check.mjs resolveGate — the SKIP decision
 * ═══════════════════════════════════════════════════════════════════════════
 * The gate that decides whether a health check is evaluated at all. Its bad
 * failure mode is silence: everything SKIPPED and the sweep still reporting
 * "no FAILs". Same import-executes problem, same fix.
 */
section('§8 resolveGate — a disabled workflow SKIPS, an unreadable one is UNKNOWN');

check('no gatingWorkflow means no gate, and null is not an error', resolveGate(null) === null);

const gateActive = resolveGate({ repo: 'o/r', name: 'W' }, () => 'W|active\nOther|disabled');
check('FALSIFIABLE: an active workflow does not gate anything out', gateActive.enabled === true);
const gateDisabled = resolveGate({ repo: 'o/r', name: 'W' }, () => 'W|disabled_manually');
check('REFUSES: a disabled workflow reports enabled=false so its check is skipped', gateDisabled.enabled === false);
check('...and carries the state so the skip line can say WHY', gateDisabled.state === 'disabled_manually');

const gateMissing = resolveGate({ repo: 'o/r', name: 'W' }, () => 'Something|active');
check('KFM-13: a workflow that is NOT FOUND is enabled=null, not false — could-not-check, never "off"',
  gateMissing.enabled === null && /not found/.test(gateMissing.reason));
const gateBroken = resolveGate({ repo: 'o/r', name: 'W' }, () => { throw new Error('gh: HTTP 401\nmore'); });
check('...and an API failure is enabled=null too, with the reason kept',
  gateBroken.enabled === null && /could not query/.test(gateBroken.reason));
check('...and only the first line of the error is carried, so a stack trace cannot become the report',
  !/more/.test(gateBroken.reason));

/* ═══════════════════════════════════════════════════════════════════════════
 * §9  guidesEnabled — moved out of the Worker entry point to be testable
 * ═══════════════════════════════════════════════════════════════════════════
 * This one gates a pipeline that COMMITS FILES to the public repo. It was
 * UNPROVEN because it lived in agent-runner.js, which no Node verifier can
 * load. Moved to guide-engine.js 2026-08-16 with the behaviour unchanged.
 */
section('§9 guidesEnabled — the switch on a pipeline that writes to the public repo');

const kvWith = (obj) => ({ SIM_KV: { get: async () => obj } });
check('REFUSES when the flag is ABSENT — the shipped default', (await guidesEnabled(kvWith({}))) === false);
check('REFUSES when explicitly false', (await guidesEnabled(kvWith({ guides_enabled: false }))) === false);
check('REFUSES a truthy non-boolean: "true" as a string is not true',
  (await guidesEnabled(kvWith({ guides_enabled: 'true' }))) === false);
check('REFUSES 1 as well', (await guidesEnabled(kvWith({ guides_enabled: 1 }))) === false);
check('REFUSES with no SIM_KV binding at all', (await guidesEnabled({})) === false);
check('REFUSES when SIM_KV throws — an unreadable switch is an off switch',
  (await guidesEnabled({ SIM_KV: { get: async () => { throw new Error('kv down'); } } })) === false);
check('FALSIFIABLE: it does turn on for boolean true', (await guidesEnabled(kvWith({ guides_enabled: true }))) === true);
check('the guide blocks still consult it on the scheduled path',
  /!\(await guidesEnabled\(env\)\)/.test(readSrc('workers/agent-runner.js')));

/* ═══════════════════════════════════════════════════════════════════════════
 * §10  checkKvPacingSlot — the ONE pacing implementation
 * ═══════════════════════════════════════════════════════════════════════════
 * Created 2026-08-16 when the two copies of the get→compare→put pacing dance
 * were collapsed into one. It was UNPROVEN because it is NEW, not because it
 * lives anywhere awkward — §2 exercises `checkUnknownCapPacing`, which
 * delegates to it, but the audit counts call sites by NAME and an indirect
 * test is invisible to it.
 */
section('§10 checkKvPacingSlot — refuses inside the window, allows outside it');

const T0 = 1_000_000_000_000;
const kvPaced = fakeKv({ k: String(T0) });
const slotTooSoon = await checkKvPacingSlot({ SIM_KV: kvPaced }, 'k', 20_000, T0 + 5_000);
check('REFUSES: a call 5s after the last one, against a 20s floor', slotTooSoon.allowed === false);
check('...and reports the elapsed time rather than a bare false', slotTooSoon.waitedMs === 5_000);
check('...and flags that it was a real check, not a degrade-open', slotTooSoon.degradedOpen === false);
check('...and does NOT overwrite the stored timestamp on a refusal', kvPaced.store.get('k') === String(T0));

const kvOk = fakeKv({ k: String(T0) });
const slotAllowed = await checkKvPacingSlot({ SIM_KV: kvOk }, 'k', 20_000, T0 + 25_000);
check('FALSIFIABLE: a call 25s later IS allowed', slotAllowed.allowed === true);
check('...and the slot is recorded, so the next call is paced against this one',
  kvOk.store.get('k') === String(T0 + 25_000));

check('a first-ever call with no stored timestamp is allowed rather than refused forever',
  (await checkKvPacingSlot({ SIM_KV: fakeKv({}) }, 'k', 20_000, T0)).allowed === true);
// The degrade-open posture is pinned here rather than left to be discovered: it
// is safe for the office and unsafe for the quota, and it is DECLARED on the
// return value rather than looking like a normal allow.
const noKv = await checkKvPacingSlot({}, 'k', 20_000, T0);
check('no SIM_KV binding degrades to allowed rather than blocking the office', noKv.allowed === true);
check('...and SAYS it degraded, so an allow with no store behind it is distinguishable', noKv.degradedOpen === true);

/* ═══════════════════════════════════════════════════════════════════════════
 * summary
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');
console.log('  PROVEN HERE (12 gates), each shown to REFUSE and each with a');
console.log('  falsifying case proving it does not refuse everything:');
console.log('    2026-08-16, first pass — getClaudeBudgetStatus · checkUnknownCapPacing');
console.log('      learningLoopEnabled · actionItemsToBoardEnabled · resolveAttendeeIds');
console.log('      resolveTaskLane · resolveImageRoles');
console.log('    2026-08-16, second pass (§7-§10) — isRestDay · checkReports');
console.log('      checkBranches · resolveGate · guidesEnabled · checkKvPacingSlot');
console.log('');
console.log('  HOW THE SECOND FIVE STOPPED BEING UNPROVABLE — the finding, not the fix:');
console.log('    None of them lacked a test because anybody neglected to write one.');
console.log('    Each lived in a module a Node verifier could not load, and no amount');
console.log('    of discipline about writing tests fixes a module that cannot be');
console.log('    loaded. Three different obstacles, three different small fixes:');
console.log('      report-watchdog.mjs / cross-project-health-check.mjs RAN their');
console.log('        whole check at import time and exported nothing -> main() behind');
console.log('        a run-directly guard, gates exported, behaviour when RUN unchanged.');
console.log('      guidesEnabled lived in agent-runner.js, which pulls Workers-only');
console.log('        bindings -> moved to guide-engine.js, which its own verifier');
console.log('        already loads. Same read, same `=== true`.');
console.log('      checkKvPacingSlot was simply NEW (created the same day the two');
console.log('        copies of the pacing dance were merged) and its only coverage was');
console.log('        indirect, through checkUnknownCapPacing. The audit counts call');
console.log('        sites by NAME, so an indirect test is invisible to it.');
console.log('');
console.log('  STILL NOT PROVEN, listed because an omitted gate reads as a covered one:');
console.log('    checkProductVersionBumps  (workers/agent-runner.js:3401)');
console.log('      -> the Worker entry point cannot be imported by a Node verifier, and');
console.log('         unlike guidesEnabled this is not a three-line flag read: it reads');
console.log('         the asset board, compares product versions and WRITES the board');
console.log('         back whole, through commitFileToRepo with an expectedSha. Lifting');
console.log('         it is a real extraction with a live read-modify-write inside it');
console.log('         (KFM-15 territory), and doing it in the same session that deploys');
console.log('         two other changes to this file is how a careful change becomes a');
console.log('         careless one. BOARDED as OB-083 with this scope attached.');
console.log(`\n  Audit verdict after this file, RE-RUN and read back: 46 CALLED · 1 UNPROVEN · 0 NOT-CALLED · 3 RETIRED`);
console.log(`  (re-run back-office tools/gate-call-audit/gate-call-audit.js to confirm)`);

if (failed) { console.log('\nUNPROVEN-gate verification FAILED.'); process.exit(1); }
console.log('\nAll scenarios matched expectations.');
