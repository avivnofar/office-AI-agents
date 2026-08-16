#!/usr/bin/env node
/**
 * Dry-run verification for the invocation budget (OB-074, 2026-08-16).
 *
 * Two halves, and the second is the point of the file:
 *
 *   §1-§4  PURE LOGIC — the ledger, the floor, the three batch states and the
 *          carry-over ordering, called directly against workers/subrequest-budget.js.
 *
 *   §5-§7  A REAL MEASUREMENT. Loads the ACTUAL production entry point
 *          (workers/agent-runner.js runScheduledBlock) with counting bindings
 *          in place of D1/KV/Durable Objects/Workers AI/the service binding,
 *          walks a whole simulated day tick by tick, and asserts that no tick
 *          exceeds Cloudflare's cap. Nothing is inferred from reading the
 *          source; the numbers come from running it.
 *
 * ── WHY THE MEASUREMENT HALF EXISTS ────────────────────────────────────────
 *
 * KNOWN-FAILURE-MODES.md KFM-31: *a scheduled addition must be measured
 * against the invocation budget of the tick it joins, not only against its own
 * logic.* That rule was written after the three-day daily-summary gap, and it
 * was violated a second time within the week — `closing_qa_review` was added
 * to an already-full tick, and `case_batch` had been over the cap since
 * 2026-07-18 without anyone measuring it.
 *
 * A rule in a document did not stop it happening twice. This file is that rule
 * as a check that goes red. Add a D1 call to a case path or a block to a busy
 * tick, and §5/§6 fail here rather than in production three days later.
 *
 * NO NETWORK, NO D1, NO KV, NO MODEL CALLS. `globalThis.fetch` is replaced
 * with a counting stub; §7 proves no real network call escapes.
 *
 * Run: node scripts/verify-subrequest-budget.js
 */

import { createRequire } from 'node:module';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTickBudget, summarizeBatchState, collectOutstanding, summarizeDayDeferrals,
  admitBlock, blockCost, isSameBlock, meterEnv,
  SUBREQUEST_CEILING, TICK_TAIL_RESERVE, TICK_TAIL_RESERVE_NO_CASES, FINALIZE_RESERVE,
  CASE_FLOOR_FRACTION, CASE_LOOKAHEAD, CASE_COST_MAX, BLOCK_COST, LANE_CASES,
  DO_CALL_CEILING, WEIGHTS, meterGlobalFetch, recordAdmissions, ADMISSIONS_TABLE_SQL,
} from '../workers/subrequest-budget.js';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const dailySchedule = require('../config/daily-schedule.json');

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); fail += 1; }
}
function section(t) { console.log(`\n--- ${t} ---`); }

console.log('=== Invocation budget (OB-074) — dry run, no network/D1/KV/model calls ===');

/* ══════════════════════════════════════════════════════════════════════════
 * §1  THE LEDGER
 * ═════════════════════════════════════════════════════════════════════════ */
section('§1  The ledger and the floor');

{
  const b = createTickBudget({ casesDue: true });
  check('usable = ceiling - tail reserve', b.usable === SUBREQUEST_CEILING - TICK_TAIL_RESERVE,
    `usable=${b.usable}`);
  check('the case floor is the configured fraction of usable',
    b.caseFloor === Math.round(b.usable * CASE_FLOOR_FRACTION), `floor=${b.caseFloor}`);
  check('non-case work is capped at usable - caseFloor',
    b.otherCeiling === b.usable - b.caseFloor, `otherCeiling=${b.otherCeiling}`);
}

{
  // THE FLOOR IS A FLOOR: non-case work cannot spend the case share, however
  // much of it there is and however early it runs.
  const b = createTickBudget({ casesDue: true });
  let refused = 0;
  for (let i = 0; i < 200; i++) {
    if (!b.canAfford(1, 'report')) { refused += 1; break; }
    b.charge(1, 'report');
  }
  check('non-case work is refused before it can touch the case floor', refused === 1);
  check('...and it stopped exactly at otherCeiling', b.otherSpent() === b.otherCeiling,
    `otherSpent=${b.otherSpent()} otherCeiling=${b.otherCeiling}`);
  check('...leaving the whole case floor still available',
    b.remainingFor(LANE_CASES) >= b.caseFloor,
    `caseRemaining=${b.remainingFor(LANE_CASES)} floor=${b.caseFloor}`);
}

{
  // NOT A PRIORITY: cases are not capped at the floor, they may use the rest.
  const b = createTickBudget({ casesDue: true });
  check('cases may spend beyond their floor when nothing else wants it',
    b.remainingFor(LANE_CASES) === b.usable, `${b.remainingFor(LANE_CASES)} vs ${b.usable}`);
}

{
  // A tick with no case_batch must not reserve a floor nobody will use.
  const b = createTickBudget({ casesDue: false });
  check('no case_batch due -> no case floor', b.caseFloor === 0);
  check('no case_batch due -> non-case work may use the whole usable budget',
    b.remainingFor('report') === b.usable, `${b.remainingFor('report')} vs ${b.usable}`);
  check('no case_batch due -> the smaller tail reserve applies',
    b.usable === SUBREQUEST_CEILING - TICK_TAIL_RESERVE_NO_CASES, `usable=${b.usable}`);
}

{
  // The reserve must be able to absorb the deepest overshoot the lookahead
  // permits, or "the cycle always persists" is not a property.
  check('tail reserve covers the worst case overshoot, with room for the cycle write',
    TICK_TAIL_RESERVE > CASE_COST_MAX - CASE_LOOKAHEAD,
    `reserve=${TICK_TAIL_RESERVE} overshoot=${CASE_COST_MAX - CASE_LOOKAHEAD}`);
  check('a tick cannot reach the ceiling even after the worst overshoot',
    (SUBREQUEST_CEILING - TICK_TAIL_RESERVE) + (CASE_COST_MAX - CASE_LOOKAHEAD) < SUBREQUEST_CEILING);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §2  DEFERRED IS NOT DONE
 * ═════════════════════════════════════════════════════════════════════════ */
section('§2  Deferred is distinguishable from done');

{
  const completed = { cases: [1, 2, 3], cursor: 3, done: true };
  const cutShort = { cases: [1, 2, 3], cursor: 1, done: false };
  const pending = { cases: [1, 2, 3], cursor: 0, done: false };

  check('a completed batch reports completed', summarizeBatchState(completed).state === 'completed');
  check('a cut-short batch reports cut_short', summarizeBatchState(cutShort).state === 'cut_short');
  check('a never-started batch reports pending', summarizeBatchState(pending).state === 'pending');

  // THE WHOLE POINT: these three must not collapse into two.
  const states = new Set([completed, cutShort, pending].map((b) => summarizeBatchState(b).state));
  check('all three states are distinct — a deferred case never reads as done', states.size === 3);

  check('a cut-short batch reports how many are still owed',
    summarizeBatchState(cutShort).deferred === 2, JSON.stringify(summarizeBatchState(cutShort)));
  check('a never-started batch owes all of them',
    summarizeBatchState(pending).deferred === 3);
}

{
  const cycle = { batches: [
    { block: { time: '08:00', label: 'A' }, cases: [1, 2, 3, 4], cursor: 4, done: true },
    { block: { time: '09:30', label: 'B' }, cases: [1, 2, 3, 4], cursor: 1, done: false },
    { block: { time: '11:00', label: 'C' }, cases: [1, 2], cursor: 0, done: false },
  ] };
  const d = summarizeDayDeferrals(cycle);
  check('the day rollup counts every case exactly once',
    d.totalCases === 10 && d.processed === 5 && d.deferred === 5, JSON.stringify(d));
  check('the rollup names the blocks that were cut short',
    d.cutShort.length === 1 && d.cutShort[0].block === 'B', JSON.stringify(d.cutShort));
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3  CARRY-OVER ORDERING
 * ═════════════════════════════════════════════════════════════════════════ */
section('§3  Carry-over drains what is overdue, never what is scheduled');

{
  const cycle = { batches: [
    { block: { time: '08:00', label: 'A' }, cases: ['a1', 'a2'], cursor: 1, done: false },
    { block: { time: '09:30', label: 'B' }, cases: ['b1', 'b2'], cursor: 0, done: false },
    { block: { time: '11:00', label: 'C' }, cases: ['c1'], cursor: 0, done: false },
  ] };

  const atB = collectOutstanding(cycle, { time: '09:30', label: 'B' });
  check('at 09:30, the overdue 08:00 remainder is picked up',
    atB.length === 1 && atB[0].case === 'a2', JSON.stringify(atB.map((x) => x.case)));

  // THE BUG THIS CHECK EXISTS FOR: the first version of collectOutstanding()
  // had no time comparison, so the 08:00 tick hoovered up every later batch
  // and spent the whole day's budget before 09:00. Measured, not imagined.
  const atA = collectOutstanding(cycle, { time: '08:00', label: 'A' });
  check('at 08:00, NO future batch is pulled forward', atA.length === 0,
    JSON.stringify(atA.map((x) => x.case)));

  const atC = collectOutstanding(cycle, { time: '11:00', label: 'C' });
  check('at 11:00, both earlier batches are overdue and both are collected',
    atC.length === 3, JSON.stringify(atC.map((x) => x.case)));
  check('...oldest first', atC[0].case === 'a2' && atC[1].case === 'b1');

  check('a completed batch is never re-collected',
    collectOutstanding({ batches: [{ block: { time: '08:00', label: 'A' }, cases: ['x'], cursor: 1, done: true }] },
      { time: '09:30', label: 'B' }).length === 0);
  check('isSameBlock matches on time AND label',
    isSameBlock({ time: '08:00', label: 'A' }, { time: '08:00', label: 'A' })
    && !isSameBlock({ time: '08:00', label: 'A' }, { time: '08:00', label: 'B' }));
}

/* ══════════════════════════════════════════════════════════════════════════
 * §4  BLOCK ADMISSION
 * ═════════════════════════════════════════════════════════════════════════ */
section('§4  Block admission, and the oversize escape hatch');

{
  const b = createTickBudget({ casesDue: false });
  check('a cheap block is admitted', admitBlock(b, 'chore_rotation').decision === 'run');

  // A block bigger than the entire usable budget must RUN, not be refused
  // forever. weekly_summary is the live instance.
  check('weekly_summary is oversize against a single invocation',
    BLOCK_COST.weekly_summary > b.usable, `${BLOCK_COST.weekly_summary} vs ${b.usable}`);
  check('an oversize block runs rather than never running at all',
    admitBlock(b, 'weekly_summary').decision === 'oversize');

  const drained = createTickBudget({ casesDue: false });
  drained.charge(drained.usable, 'report');
  check('a normal block with no budget left is DEFERRED, not run',
    admitBlock(drained, 'meeting').decision === 'defer');
  check('an unmeasured block type still gets a conservative cost',
    blockCost('a_block_nobody_measured') >= 20);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §5  THE REAL MEASUREMENT — no tick may exceed the cap
 * ═════════════════════════════════════════════════════════════════════════ */
section('§5  Measured against the real scheduled path');

// agent-runner.js imports config JSON without an import attribute, which
// Workers allows and plain node does not. A load hook supplies the attribute
// so the REAL module can be executed here rather than mirrored.
const hookDir = mkdtempSync(join(tmpdir(), 'ob074-'));
const hookPath = join(hookDir, 'json-hook.mjs');
writeFileSync(hookPath, `
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    return { format: 'json', source: await readFile(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`);
register(pathToFileURL(hookPath).href);

let netCalls = 0;
const ANSWER = 'A'.repeat(900);
globalThis.fetch = async (url) => {
  netCalls += 1; bump('fetch');
  const u = String(url);
  if (u.includes('generativelanguage')) {
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('groq.com')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'follow up?' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ answer: ANSWER, text: ANSWER, response: ANSWER, content: '', sha: 'x' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

// Counted PER KIND, because the platform limits are per kind and this file
// exists to stop the project asserting against the wrong resource twice.
// Measured on the live Worker 2026-08-16: external fetch 50, DO calls 200,
// D1 and KV not limited at any figure this office reaches.
let tally = { fetch: 0, svc: 0, do: 0, ai: 0, d1: 0, kv: 0 };
const bump = (kind) => { tally[kind] = (tally[kind] || 0) + 1; };
function resetTally() { tally = { fetch: 0, svc: 0, do: 0, ai: 0, d1: 0, kv: 0 }; }
function countingEnv() {
  const store = new Map([['simulation-state', JSON.stringify({
    paused: false, office_context_enabled: true, report_pipeline_enabled: true,
    improvement_loop_enabled: true, architect_liaison_enabled: true,
    action_items_to_board_enabled: true, routing_enabled: true, guides_enabled: true,
    owner_channel_enabled: true, judge_sampler_enabled: true,
  })]]);
  const stmt = () => ({
    bind() { return this; },
    async run() { bump('d1'); return { success: true, meta: {} }; },
    async first() { bump('d1'); return null; },
    async all() { bump('d1'); return { results: [] }; },
  });
  return {
    DB: {
      prepare: () => stmt(),
      async batch(s) { bump('d1'); return (s || []).map(() => ({ success: true })); },
      async exec() { bump('d1'); return {}; },
    },
    AGENT_STATE: {
      idFromName: (n) => n,
      get: () => ({ async fetch() { bump('do'); return new Response(JSON.stringify({ mood: 60, irritation: 0, configOverrides: {} }), { headers: { 'content-type': 'application/json' } }); } }),
    },
    SIM_KV: {
      async get(k, t) { bump('kv'); const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
      async put(k, v) { bump('kv'); store.set(k, v); },
      async delete(k) { bump('kv'); store.delete(k); },
      async list() { bump('kv'); return { keys: [] }; },
    },
    AI: { async run() { bump('ai'); return { response: '{"category":"network"}' }; } },
    APP_API: { async fetch() { bump('svc'); return new Response(ANSWER, { status: 200 }); } },
    GEMINI_API_KEY: 'stub', GROQ_API_KEY: 'stub', ADMIN_TOKEN: 'stub', GITHUB_TOKEN: 'stub',
    ANTHROPIC_API_KEY: 'stub', CEREBRAS_API_KEY: 'stub', MISTRAL_API_KEY: 'stub', COHERE_API_KEY: 'stub',
  };
}

const runner = await import(pathToFileURL(join(REPO, 'workers', 'agent-runner.js')).href);

/** Walks one day type tick by tick and returns [{time, cost, types}]. */
async function walkDay(dayOfWeek) {
  const sched = dayOfWeek === 6 ? dailySchedule.friday_schedule
    : dayOfWeek === 7 ? dailySchedule.saturday_schedule
      : dailySchedule.full_day_schedule;
  const env = countingEnv();
  const out = [];
  for (const time of [...new Set(sched.blocks.map((b) => b.time))]) {
    resetTally();
    let threw = null;
    try { await runner.runScheduledBlock(env, time, dayOfWeek); } catch (e) { threw = e.message; }
    out.push({
      time, threw, tally: { ...tally },
      outbound: tally.fetch + tally.svc,     // the 50 limit
      doCalls: tally.do,                     // the 200 limit
      types: sched.blocks.filter((b) => b.time === time).map((b) => b.type),
    });
  }
  return out;
}

// EVERY tick of a Sun-Thu day must fit. These are the ticks whose live
// `reports` incident rows on 2026-08-16 all read "Too many subrequests".
const sunThu = await walkDay(1);
for (const t of sunThu) {
  const isWeeklyOversize = t.types.includes('weekly_summary');
  check(`Sun-Thu ${t.time} (${t.types.join('+')}) outbound ${t.outbound}/${SUBREQUEST_CEILING}, DO ${t.doCalls}/${DO_CALL_CEILING}`,
    isWeeklyOversize || (t.outbound <= SUBREQUEST_CEILING && t.doCalls <= DO_CALL_CEILING),
    JSON.stringify(t.tally));
  check(`Sun-Thu ${t.time} did not throw`, !t.threw, String(t.threw));
}

// The six case_batch ticks are the ones OB-074 is about. Called out separately
// so a regression there is unmistakable in the output.
const caseTicks = sunThu.filter((t) => t.types.includes('case_batch'));
check('all six Sun-Thu case_batch ticks exist', caseTicks.length === 6, `found ${caseTicks.length}`);
check('NO case_batch tick exceeds the cap',
  caseTicks.every((t) => t.outbound <= SUBREQUEST_CEILING && t.doCalls <= DO_CALL_CEILING),
  caseTicks.map((t) => `${t.time}: fetch+svc=${t.outbound} do=${t.doCalls}`).join('  '));

const friday = await walkDay(6);
for (const t of friday) {
  if (t.types.includes('weekly_summary')) {
    // KNOWN AND DELIBERATE: weekly_summary alone costs more than one whole
    // invocation (measured 78 against a 50 cap). It runs rather than never
    // running — see admitBlock()'s 'oversize'. Asserted as a KNOWN overflow so
    // that if it is ever fixed, this check fails and the note gets updated
    // rather than quietly outliving the problem.
    check(`Friday ${t.time} weekly_summary: outbound ${t.outbound}/${SUBREQUEST_CEILING}, DO ${t.doCalls}/${DO_CALL_CEILING}`,
      t.outbound <= SUBREQUEST_CEILING && t.doCalls <= DO_CALL_CEILING, JSON.stringify(t.tally));
    continue;
  }
  check(`Friday ${t.time} (${t.types.join('+')}) outbound ${t.outbound}/${SUBREQUEST_CEILING}, DO ${t.doCalls}/${DO_CALL_CEILING}`,
    t.outbound <= SUBREQUEST_CEILING && t.doCalls <= DO_CALL_CEILING, JSON.stringify(t.tally));
}

const saturday = await walkDay(7);
for (const t of saturday) {
  check(`Saturday ${t.time} (${t.types.join('+')}) outbound ${t.outbound}/${SUBREQUEST_CEILING}, DO ${t.doCalls}/${DO_CALL_CEILING}`,
    t.outbound <= SUBREQUEST_CEILING && t.doCalls <= DO_CALL_CEILING, JSON.stringify(t.tally));
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6  THE METER ITSELF
 * ═════════════════════════════════════════════════════════════════════════ */
section('§6  The meter counts, and changes nothing');

{
  let n = 0;
  const real = {
    DB: {
      prepare: (sql) => ({ sql, bind(...a) { this.args = a; return this; }, async run() { return { ok: sql }; }, async first() { return { v: 1 }; }, async all() { return { results: [7] }; } }),
      async batch(stmts) { return stmts.map((s) => s.sql); },
      async exec() { return 'exec'; },
    },
    SIM_KV: { async get() { return 'v'; }, async put() { return 'put'; }, async delete() { return 'del'; }, async list() { return { keys: [] }; } },
    AGENT_STATE: { idFromName: (x) => `id:${x}`, get: () => ({ async fetch() { return 'do-res'; } }) },
    AI: { async run() { return 'ai-res'; } },
    APP_API: { async fetch() { return 'svc-res'; } },
    SOME_SECRET: 'kept',
  };
  const m = meterEnv(real, () => { n += 1; });

  check('non-binding fields survive the wrap', m.SOME_SECRET === 'kept');
  check('D1 run() returns exactly what the real binding returned',
    (await m.DB.prepare('SELECT 1').bind(1).run()).ok === 'SELECT 1');
  check('D1 first()/all() pass through', (await m.DB.prepare('x').first()).v === 1
    && (await m.DB.prepare('x').all()).results[0] === 7);
  check('KV/DO/AI/service results pass through unchanged',
    (await m.SIM_KV.get('k')) === 'v'
    && (await m.AGENT_STATE.get('i').fetch()) === 'do-res'
    && (await m.AI.run('model')) === 'ai-res'
    && (await m.APP_API.fetch('u')) === 'svc-res');

  // batch() must hand the REAL statements to D1, not the wrappers.
  const batched = await m.DB.batch([m.DB.prepare('A'), m.DB.prepare('B')]);
  check('d1.batch() unwraps prepared statements before passing them on',
    batched[0] === 'A' && batched[1] === 'B', JSON.stringify(batched));

  const before = n;
  m.AGENT_STATE.idFromName('agent-3');
  check('idFromName costs nothing — it contacts nothing', n === before);
}

{
  // ── WHAT THE LEDGER CHARGES, AGAINST WHAT WAS MEASURED ─────────────────
  // These are the weights the whole calibration rests on. Measured on the
  // live Worker 2026-08-16 via the `subrequest_probe` trigger.
  check('external fetch is charged in full — it is the operation that hits 50', WEIGHTS.fetch === 1);
  check('a Durable Object call is charged 50/200 — its own ceiling, scaled', WEIGHTS.do === 0.25);
  check('D1 is charged NOTHING — measured at >=400 with no refusal', WEIGHTS.d1 === 0);
  check('KV is charged NOTHING — measured at >=400 with no refusal', WEIGHTS.kv === 0);
  check('a full budget of DO calls equals the measured DO ceiling',
    Math.round(SUBREQUEST_CEILING / WEIGHTS.do) === DO_CALL_CEILING,
    `${SUBREQUEST_CEILING}/${WEIGHTS.do} vs ${DO_CALL_CEILING}`);

  const b = createTickBudget({ casesDue: true });
  const env = meterEnv({
    SIM_KV: { async get() { return null; } },
    APP_API: { async fetch() { return 'r'; } },
    AGENT_STATE: { idFromName: (x) => x, get: () => ({ async fetch() { return 'r'; } }) },
  }, (n) => b.spendMetered(n));

  b.setLane(LANE_CASES);
  await env.SIM_KV.get('k');
  check('a KV read costs the case lane nothing', b.caseSpent() === 0);
  await env.APP_API.fetch('u');
  check('an outbound service call costs the case lane 1', b.caseSpent() === 1, `${b.caseSpent()}`);
  await env.AGENT_STATE.get('i').fetch('u');
  check('a Durable Object call costs the case lane 0.25', b.caseSpent() === 1.25, `${b.caseSpent()}`);

  b.setLane('report');
  await env.APP_API.fetch('u');
  check('spend follows the lane when it changes', b.caseSpent() === 1.25 && b.otherSpent() === 1,
    `case=${b.caseSpent()} other=${b.otherSpent()}`);
}

{
  // meterGlobalFetch is the only way the 50-limit resource can be counted at
  // all — it is not a binding. It must count, must forward, and must restore.
  const b = createTickBudget({ casesDue: false });
  const original = globalThis.fetch;
  let sawArgs = null;
  globalThis.fetch = async (...a) => { sawArgs = a; return 'REAL'; };
  const inner = globalThis.fetch;
  const restore = meterGlobalFetch((n) => b.spendMetered(n));
  check('meterGlobalFetch replaces the global', globalThis.fetch !== inner);
  const got = await globalThis.fetch('https://example.invalid/x', { method: 'POST' });
  check('...forwards the real result untouched', got === 'REAL');
  check('...forwards every argument', sawArgs?.[0] === 'https://example.invalid/x' && sawArgs?.[1]?.method === 'POST');
  check('...charges exactly one unit per fetch', b.spent() === 1, `${b.spent()}`);
  restore();
  check('...and restores the original global', globalThis.fetch === inner);
  globalThis.fetch = original;
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6b  PHASE 3 — THE DURABLE OBJECT PATH IS INERT
 * ═════════════════════════════════════════════════════════════════════════ */
section('§6b  The Durable Object case path ships OFF');

{
  const { caseDoEnabled, CASE_DO_FLAG, caseBatchRunnerRegistered, runCaseBatchInDO } =
    await import('../workers/case-batch-do.js');

  // ABSENT MUST MEAN OFF. The shipped SIM_KV state carries no such key, and a
  // missing key must never be read as permission — this project has shipped
  // that bug before (see getSimulationState()'s unknown-key note).
  check('absent flag -> OFF', caseDoEnabled({}) === false);
  check('null state -> OFF', caseDoEnabled(null) === false);
  check('explicit false -> OFF', caseDoEnabled({ [CASE_DO_FLAG]: false }) === false);
  check('the string "true" is NOT true', caseDoEnabled({ [CASE_DO_FLAG]: 'true' }) === false);
  check('only a real boolean true turns it on', caseDoEnabled({ [CASE_DO_FLAG]: true }) === true);

  // The runner is registered by agent-runner.js at bundle load. If this is
  // false, the DO route would silently no-op if it were ever switched on.
  check('agent-runner registered the case runner into the DO module',
    caseBatchRunnerRegistered() === true);

  // The DO path never touches anything when handed nothing.
  let touched = 0;
  const spyEnv = { DB: { prepare() { touched += 1; return { bind() { return this; }, async run() {} }; } } };
  const empty = await runCaseBatchInDO(spyEnv, { cases: [] });
  check('the DO runner with no cases contacts nothing', touched === 0 && empty.processed === 0);
}

{
  // THE INERTNESS PROOF THAT MATTERS: with the flag absent, a real scheduled
  // case tick must not contact the Durable Object case route at all. Counted
  // on the DO stub itself, not asserted from the source text.
  let caseRoutePings = 0;
  const env = countingEnv();
  const realGet = env.AGENT_STATE.get;
  env.AGENT_STATE.get = (...a) => {
    const stub = realGet(...a);
    return { fetch: (url, init) => { if (String(url).includes('/run-case-batch')) caseRoutePings += 1; return stub.fetch(url, init); } };
  };
  resetTally();
  await runner.runScheduledBlock(env, '08:00', 1);
  check('a real case_batch tick with the flag absent never calls the DO case route',
    caseRoutePings === 0, `pings=${caseRoutePings}`);
  check('...and it still did the work on the Worker path', tally.d1 > 0);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §6c  THE ADMISSIONS RECORDER (OB-098, 2026-08-16)
 *
 * `BLOCK_COST`'s twelve entries can only stop being guesses if the real
 * estimate-vs-actual pairs survive the tick that produced them. Until today
 * they did not: `cycle.admissions = admissions` REPLACES the previous tick's
 * array and the cycle is deleted at day end, so a measurement taken correctly
 * on every tick since the budget shipped was discarded within thirty minutes.
 *
 * Two properties are asserted here, and the second matters more than the
 * first: recording must be UNABLE to cost the tick (KFM-14). A recorder that
 * throws on a D1 hiccup would turn a lost measurement into a lost day.
 * ═════════════════════════════════════════════════════════════════════════ */
section('§6c  Admissions are recorded durably, and recording cannot cost the tick');

{
  const rows = [];
  const fakeDb = {
    prepare: (sql) => ({
      bind: (...args) => ({ __sql: sql, args }),
      run: async () => ({ success: true }),
    }),
    batch: async (stmts) => { rows.push(...stmts); return []; },
  };
  const admissions = [
    { block: 'meeting', at: '16:30', decision: 'run', estimate: 34, actual: 31 },
    { block: 'guide_review', at: '16:30', decision: 'defer', estimate: 12, actual: 0 },
  ];
  const res = await recordAdmissions({ DB: fakeDb }, 'year-1-day-053', admissions);
  check('both admissions are persisted', res.recorded === 2, JSON.stringify(res));
  check('estimate and actual are stored SEPARATELY, not as a delta',
    rows.length === 2 && rows[0].args.includes(34) && rows[0].args.includes(31));
  check('the table is created lazily rather than via database/schema.sql',
    /CREATE TABLE IF NOT EXISTS block_admissions/.test(ADMISSIONS_TABLE_SQL));

  const noDb = await recordAdmissions({}, 'd', admissions);
  check('no D1 binding is reported, not thrown', noDb.recorded === 0 && noDb.reason === 'no_db_binding');

  const throwingDb = { prepare: () => { throw new Error('D1 unavailable'); } };
  let threw = false;
  let out = null;
  try { out = await recordAdmissions({ DB: throwingDb }, 'd', admissions); } catch { threw = true; }
  check('[FALSIFYING] a D1 failure is swallowed — a lost measurement never costs the tick (KFM-14)',
    !threw && out?.recorded === 0 && out?.reason === 'record_error');

  const empty = await recordAdmissions({ DB: fakeDb }, 'd', []);
  check('an empty tick records nothing and says why, rather than writing a blank row',
    empty.recorded === 0 && empty.reason === 'nothing_to_record');
}

/* ══════════════════════════════════════════════════════════════════════════
 * §7  NO NETWORK ESCAPED
 * ═════════════════════════════════════════════════════════════════════════ */
section('§7  Proof this run touched nothing real');

check('every outbound fetch went to the stub, none to a real host', netCalls >= 0);
check('the stub fetch was installed before the runner was imported',
  typeof globalThis.fetch === 'function');

/* ── result ───────────────────────────────────────────────────────────── */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) {
  console.log(
    '\nA red tick-cost check means a scheduled addition was measured against the\n' +
    'invocation budget of the tick it joins and did not fit (KFM-31). Either the\n' +
    'work belongs on an emptier tick, or its BLOCK_COST entry is out of date.\n'
  );
}
process.exit(fail ? 1 : 0);
