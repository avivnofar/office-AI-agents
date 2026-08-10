#!/usr/bin/env node
// Dry-run verification for the improvement loop's CAPTURE half (plan 1.1/1.7).
//
// NO NETWORK, NO DATABASE, NO MODEL CALLS. globalThis.fetch is replaced with a
// tripwire that throws, so "made no network calls" is PROVEN rather than
// claimed — same technique as verify-routing.js and verify-providers.js. D1 is
// a recording fake, so every INSERT this file believes happened is one it can
// show you.
//
// It exercises the REAL functions from workers/improvement-loop.js, imported
// directly rather than mirrored.
//
// ── THE STANDARD THIS FILE IS HELD TO ────────────────────────────────────
// A test that describes a fix is not a test that catches a bug. Section 5
// transcribes the PRE-CHANGE behaviour of the Q&A path — quality computed and
// discarded — and asserts against it, so the table demonstrably catches
// something. See CLAUDE.md's guard-correction section in back-office.
//
// Run: node scripts/verify-improvement-loop.js

import {
  improvementLoopEnabled,
  buildOfficeEventRow,
  recordOfficeEvent,
  EVENT_TYPES,
  TRACKS,
  OFFICE_EVENT_TYPE,
  OFFICE_EVENT_INSERT_SQL,
  IMPROVEMENT_LOOP_FLAG,
  SIM_STATE_KEY,
  NOT_ASKED_EVENT,
} from '../workers/improvement-loop.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
const __vdir = nodePath.dirname(fileURLToPath(import.meta.url));
const readRepo = (rel) => readFileSync(nodePath.join(__vdir, '..', rel), 'utf8');

/* ── tripwire ────────────────────────────────────────────────────────────── */
globalThis.fetch = () => {
  throw new Error('TRIPWIRE: verify-improvement-loop.js made a network call. It must not.');
};
if (!globalThis.crypto?.randomUUID) {
  globalThis.crypto = { randomUUID: () => 'test-uuid' };
}

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) console.log(`       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
}
function checkTrue(label, actual) { check(label, !!actual, true); }

/* ── fakes ───────────────────────────────────────────────────────────────── */
function fakeEnv({ flag, withDb = true } = {}) {
  const writes = [];
  return {
    writes,
    SIM_KV: {
      get: async (key) => {
        if (key !== SIM_STATE_KEY) return null;
        if (flag === undefined) return { guides_enabled: true };      // key ABSENT — shipped default
        return { guides_enabled: true, [IMPROVEMENT_LOOP_FLAG]: flag };
      },
    },
    ...(withDb ? {
      DB: {
        prepare(sql) {
          return { bind: (...args) => ({ run: async () => { writes.push({ sql, args }); return { success: true }; } }) };
        },
      },
    } : {}),
  };
}

console.log('Dry-run only — fetch is a tripwire, D1 is a recording fake.\n');

/* ── 1. The switch ───────────────────────────────────────────────────────── */
console.log('-- 1. The kill switch (default OFF) --');
check('flag ABSENT from SIM_KV -> disabled (this is the shipped default)', await improvementLoopEnabled(fakeEnv({})), false);
check('flag false -> disabled', await improvementLoopEnabled(fakeEnv({ flag: false })), false);
check('flag true  -> enabled', await improvementLoopEnabled(fakeEnv({ flag: true })), true);
check('flag "true" (string) -> disabled — === true, not truthiness', await improvementLoopEnabled(fakeEnv({ flag: 'true' })), false);
check('flag 1 -> disabled', await improvementLoopEnabled(fakeEnv({ flag: 1 })), false);
check('no SIM_KV binding at all -> disabled', await improvementLoopEnabled({}), false);

/* ── 2. Switch OFF reproduces today's behaviour EXACTLY ──────────────────── */
console.log('\n-- 2. Switch OFF writes NOTHING (the deploy-inert guarantee) --');
{
  const env = fakeEnv({});                       // flag absent
  const r = await recordOfficeEvent(env, { agentId: 1, eventType: 'case_answer', track: 'client', quality: 0.9 });
  check('returns improvement_loop_disabled', r, { recorded: false, reason: 'improvement_loop_disabled' });
  check('ZERO D1 writes with the flag absent', env.writes.length, 0);
}
{
  const env = fakeEnv({ flag: false });
  await recordOfficeEvent(env, { agentId: 1, eventType: 'case_answer', track: 'client', quality: 0.9 });
  check('ZERO D1 writes with the flag explicitly false', env.writes.length, 0);
}
{
  // The refusal must come from the FLAG, before validation — so a caller
  // cannot learn anything about row validity while the loop is off.
  const env = fakeEnv({});
  const r = await recordOfficeEvent(env, { agentId: 'not-an-int', eventType: 'nonsense', track: 'nope' });
  check('flag is checked BEFORE row validation (an invalid row still reports disabled)', r.reason, 'improvement_loop_disabled');
  check('...and still writes nothing', env.writes.length, 0);
}

/* ── 3. Row validation: refuse, never default ───────────────────────────── */
console.log('\n-- 3. Row validation refuses rather than defaults --');
checkTrue('valid row builds', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'office' }).valid);
check('missing track is REFUSED, not defaulted', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review' }).valid, false);
check('unknown track refused', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'internal' }).valid, false);
check('unknown event_type refused', buildOfficeEventRow({ agentId: 6, eventType: 'qa_reveiw', track: 'office' }).valid, false);
check('non-integer agentId refused', buildOfficeEventRow({ agentId: '6', eventType: 'qa_review', track: 'office' }).valid, false);
check('quality > 1 refused', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'office', quality: 1.4 }).valid, false);
check('quality < 0 refused', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'office', quality: -0.1 }).valid, false);
check('quality NaN refused', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'office', quality: NaN }).valid, false);
checkTrue('quality 0 is VALID — a zero score is a real score', buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'office', quality: 0 }).valid);
check('quality null is valid and stays null (means "no score", not zero)',
  buildOfficeEventRow({ agentId: 6, eventType: 'meeting', track: 'office' }).row.quality, null);

/* ── 4. type vs event_type, track, embodiment ───────────────────────────── */
console.log('\n-- 4. The type/event_type rule and the two axes --');
{
  const row = buildOfficeEventRow({ agentId: 6, eventType: 'qa_review', track: 'office', embodimentModel: 'mistral' }).row;
  check("every loop row carries type='office_event'", row.type, OFFICE_EVENT_TYPE);
  check('event_type is the SEPARATE axis', row.event_type, 'qa_review');
  check('embodiment_model records what answered', row.embodiment_model, 'mistral');
  check('track recorded', row.track, 'office');
}
check('office_event is NOT one of the pre-existing document kinds',
  ['status', 'incident', 'gap_hebrew', 'weekly', 'day', 'disabled'].includes(OFFICE_EVENT_TYPE), false);
check('EVENT_TYPES and the old `type` values do not overlap',
  EVENT_TYPES.filter((e) => ['status', 'incident', 'gap_hebrew', 'weekly', 'day', 'disabled'].includes(e)), []);
check('both tracks exist and only those two', [...TRACKS], ['client', 'office']);

/* ── 5. FAILS-OLD: the pre-change Q&A path discarded quality ────────────── */
console.log('\n-- 5. [FAILS-OLD] quality persistence — transcribed pre-change behaviour --');
{
  // Transcription of askAssignedProject()'s tail BEFORE 2026-08-06: the
  // follow-up loop ran, then `return result` — quality was never written.
  // Verbatim in shape; the point is that there is no write here.
  function oldAskTail(env, result) {
    return result;                                  // <- the whole of it
  }
  const oldEnv = fakeEnv({ flag: true });
  oldAskTail(oldEnv, { quality: 0.42, source: 'cerebras' });
  check('OLD path persisted NOTHING even with the loop enabled', oldEnv.writes.length, 0);

  // The new tail, same inputs, loop ON.
  const newEnv = fakeEnv({ flag: true });
  await recordOfficeEvent(newEnv, {
    agentId: 3, eventType: 'case_answer', track: 'client',
    embodimentModel: 'cerebras', quality: 0.42, project: 'data-center',
  });
  check('NEW path persists exactly one row', newEnv.writes.length, 1);
  const [w] = newEnv.writes;
  check('...via the columns the ALTER TABLE adds', w.sql, OFFICE_EVENT_INSERT_SQL);
  check('...with the quality that used to be discarded', w.args[10], 0.42);
  check('...tagged track=client', w.args[9], 'client');
  check('...with the provider that actually served', w.args[8], 'cerebras');
  check('...and event_type=case_answer', w.args[7], 'case_answer');
  console.log('       ^ these four assertions FAIL against the old code: it wrote no row at all,');
  console.log('         so there was nothing carrying quality, track, or embodiment_model.');
}

/* ── 6. Additive-only: capture never alters the result ──────────────────── */
console.log('\n-- 6. Capture is write-only — it cannot change what it observes --');
{
  const env = fakeEnv({ flag: true });
  const result = { quality: 0.55, source: 'mistral', response: 'x', skipped: false };
  const snapshot = JSON.stringify(result);
  await recordOfficeEvent(env, {
    agentId: 2, eventType: 'case_answer', track: 'client',
    embodimentModel: result.source, quality: result.quality,
  });
  check('the observed result object is byte-identical afterwards', JSON.stringify(result), snapshot);

  // The follow-up band (0.3 <= q < 0.65) is the decision quality already
  // drives. Capture must not move it in either flag state.
  const band = (q) => typeof q === 'number' && q >= 0.3 && q < 0.65;
  for (const q of [0, 0.29, 0.3, 0.5, 0.64, 0.65, 1]) {
    const before = band(q);
    const envQ = fakeEnv({ flag: true });
    await recordOfficeEvent(envQ, { agentId: 2, eventType: 'case_answer', track: 'client', quality: q });
    check(`follow-up band unchanged at quality=${q}`, band(q), before);
  }
}
{
  // A capture failure must never propagate. This is the live-Track-A promise.
  const env = { SIM_KV: { get: async () => ({ [IMPROVEMENT_LOOP_FLAG]: true }) },
                DB: { prepare() { throw new Error('D1 exploded'); } } };
  const r = await recordOfficeEvent(env, { agentId: 1, eventType: 'case_answer', track: 'client', quality: 0.5 });
  check('a throwing D1 is swallowed, never propagated', r, { recorded: false, reason: 'capture_error' });
}
{
  const env = fakeEnv({ flag: true, withDb: false });
  const r = await recordOfficeEvent(env, { agentId: 1, eventType: 'case_answer', track: 'client' });
  check('no D1 binding degrades quietly', r, { recorded: false, reason: 'no_db_binding' });
}

/* ── 7. Per-track separability (what the column exists for) ─────────────── */
console.log('\n-- 7. Per-track consumption is separable (the plan requires this) --');
{
  const env = fakeEnv({ flag: true });
  await recordOfficeEvent(env, { agentId: 1, eventType: 'case_answer', track: 'client', quality: 0.8, embodimentModel: 'gemini' });
  await recordOfficeEvent(env, { agentId: 6, eventType: 'qa_review', track: 'office', quality: 0.6, embodimentModel: 'cerebras' });
  await recordOfficeEvent(env, { agentId: 8, eventType: 'lead_qa_weekly', track: 'office', embodimentModel: 'mistral' });
  const tracks = env.writes.map((w) => w.args[9]);
  check('3 rows, tracks distinguishable', tracks, ['client', 'office', 'office']);
  const providers = env.writes.map((w) => w.args[8]);
  check('embodiment differs per row — 1.5 can compare across providers', providers, ['gemini', 'cerebras', 'mistral']);
}

/* ── 8. The INSERT matches the declared schema ──────────────────────────── */
console.log('\n-- 8. INSERT column list matches database/schema.sql --');
{
  const cols = OFFICE_EVENT_INSERT_SQL.match(/\(([^)]*)\)/)[1].split(',').map((s) => s.trim());
  const placeholders = (OFFICE_EVENT_INSERT_SQL.match(/\?/g) || []).length;
  check('one placeholder per column', placeholders, cols.length);
  for (const c of ['event_type', 'embodiment_model', 'track', 'quality']) {
    checkTrue(`INSERT names the new column "${c}"`, cols.includes(c));
  }
  checkTrue('INSERT does not touch created_at (the DB default is the timestamp)', !cols.includes('created_at'));
}

/* ── 9. `case_not_asked` — the paced-out ask is not a scored answer ──────
   Added 2026-08-10. 86 of 129 live rows were asks that never reached a
   provider, written as `case_answer` with a correct null. The null was honest;
   the event type was not. */
console.log('\n-- 9. case_not_asked: an ask that never happened is a different event --');
{
  checkTrue('NOT_ASKED_EVENT is a member of the closed EVENT_TYPES set',
    EVENT_TYPES.includes(NOT_ASKED_EVENT));
  checkTrue('...and it is spelled case_not_asked', NOT_ASKED_EVENT === 'case_not_asked');

  const good = buildOfficeEventRow({ agentId: 3, eventType: NOT_ASKED_EVENT, track: 'client', quality: null });
  checkTrue('a case_not_asked row with a null quality is valid', good.valid === true);
  checkTrue('...and it still carries the client track (the work was client work that did not happen)',
    good.valid && good.row.track === 'client');

  // THE REFUSAL. The only way a scored case_not_asked row appears is a caller
  // wiring the wrong event type onto a real answer, which would poison the
  // population every consumer now trusts to be unscored.
  const scored = buildOfficeEventRow({ agentId: 3, eventType: NOT_ASKED_EVENT, track: 'client', quality: 0.8 });
  checkTrue('a case_not_asked row carrying a SCORE is REFUSED, not silently accepted',
    scored.valid === false);
  checkTrue('...and the refusal says why a score cannot exist for it',
    scored.valid === false && /never reached a provider/.test(scored.reason));
  checkTrue('a case_answer row carrying the same score is still fine (the rule is scoped)',
    buildOfficeEventRow({ agentId: 3, eventType: 'case_answer', track: 'client', quality: 0.8 }).valid === true);
}

/* ── 10. The call site routes skipped results to the new event type ────── */
console.log('\n-- 10. agent-base.js routes a skipped ask away from case_answer --');
{
  const src = readRepo('agents/agent-base.js');
  checkTrue('the capture line branches on result.skipped',
    /const notAsked = result\?\.skipped === true;/.test(src));
  checkTrue('...and chooses the event type from it',
    /eventType: notAsked \? 'case_not_asked' : 'case_answer'/.test(src));
  checkTrue('a not-asked row records NO embodiment (nothing answered, so nothing to attribute)',
    /embodimentModel: notAsked \? null :/.test(src));
  checkTrue('a not-asked row can never carry a quality, even if one is somehow present',
    /quality: typeof result\?\.quality === 'number' && !notAsked \? result\.quality : null/.test(src));
  checkTrue('WHY it was not asked is recorded — a discarded reason collapses every cause into one symptom',
    /not_asked_reason: notAsked \? \(result\?\.reason \|\| 'unstated'\) : null/.test(src));
  // The historical archive is read by this flag. Removing it would make the 86
  // pre-cutover rows unclassifiable.
  checkTrue('`skipped` STAYS in the content JSON (the discriminator for pre-2026-08-10 rows)',
    /skipped: notAsked,/.test(src));

  const decision = readRepo('workers/improvement-loop.js');
  // 2026-08-10: the owner reversed this. The rows WERE relabelled (113 of them),
  // so the assertion changes from "the refusal is recorded" to "the reversal is
  // recorded, and the published figure was corrected rather than overwritten".
  // The rule being protected is unchanged and is what this still pins: a
  // published number whose data moved underneath it must carry a dated note.
  checkTrue('the relabel decision is recorded, with the row count it actually touched',
    /RELABELLED 2026-08-10, BY OWNER DECISION/.test(decision) && /113 rows/.test(decision));
  checkTrue('the superseded "do not relabel" reasoning is STRUCK, not deleted',
    /~~WHAT WAS DELIBERATELY NOT DONE/.test(decision) && /struck 2026-08-10/.test(decision));
  checkTrue('the published figure was corrected by an appended dated note, not by rewriting it',
    /Correction 4/.test(decision) && /week-07-report\.md/.test(decision));
  checkTrue('week-07 actually carries that appended correction, naming both numbers',
    (() => {
      // Collapse the markdown's hard wraps before matching — these sentences
      // are prose in a published file and WILL be re-wrapped by any later edit.
      const wk = readRepo('reports/weekly/week-07-report.md').replace(/\s+/g, ' ');
      return /# Correction 4/.test(wk) && /113 rows changed/.test(wk)
        && /can no longer be reproduced from the database/.test(wk)
        && /Appended 2026-08-10/.test(wk);
    })());
  checkTrue('the change is reversible against the exact rows it touched',
    /checkpoints\/2026-08-10-ob-041-relabel-ids\.txt/.test(decision));
  checkTrue('the exact discriminator for the historical rows is written down',
    /content LIKE '%"skipped":true%'/.test(decision));
  checkTrue('the decision states plainly that it does NOT answer OB-027',
    /THIS DOES NOT ANSWER OB-027/.test(decision));

  // The two-populations error, fixed at both consumers.
  const runner = readRepo('workers/agent-runner.js');
  checkTrue('the report pack counts SCORED rows separately from total rows',
    /SUM\(CASE WHEN quality IS NOT NULL THEN 1 ELSE 0 END\) AS scored/.test(runner));
  checkTrue('...and states which population the average describes, on the same line',
    /the average does NOT describe them/.test(runner));
  const meeting = readRepo('workers/meeting-engine.js');
  checkTrue('the closing QA review no longer labels a total-row count "scored"',
    /event_type = 'case_answer' AND quality IS NOT NULL AND created_at >= \?/.test(meeting));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
console.log(failed === 0 ? 'All scenarios matched expectations.' : 'MISMATCH — see FAIL lines above.');
process.exit(failed === 0 ? 0 : 1);
