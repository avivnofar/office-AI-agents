#!/usr/bin/env node
// Dry-run / scratch-invocation verification for SESSION 37, ITEM 1 — the day
// counter double-increment guard (workers/day-advance-guard.js).
//
// Calls the REAL exported functions (no JSON import in that module, so it
// loads under plain Node — same reason qa-topics.js/gap-reports.js/
// gemini-pacer.js are plain-Node-importable, per verify-qa-engine.js's
// header) against an in-memory mock SIM_KV. No network, no D1, no real
// Worker invocation — per Session 37's Hard Rule 8, this proves the fix by
// calling the actual scheduling function twice in immediate succession in a
// scratch invocation, NOT by manufacturing a real cron/manual trigger against
// production.
//
// Run: node scripts/verify-day-advance-guard.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { israelDateStr, alreadyAdvancedToday, recordDayAdvance, LAST_DAY_ADVANCE_KEY_NAME } from '../workers/day-advance-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`[PASS] ${label}`);
    pass += 1;
  } else {
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

/** Minimal in-memory KV standing in for SIM_KV — get/put only, matching what the guard uses. */
function makeMockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

console.log('── §1 israelDateStr — matches agent-runner.js\'s ISRAEL_UTC_OFFSET_HOURS=3 convention ──');
{
  // 05:00:38 UTC on 2026-08-29 is the real Saturday 08:00 IDT tick that
  // produced the day-66 block_admissions row (measured live).
  const d = israelDateStr(new Date('2026-08-29T05:00:38Z'), 3);
  check('05:00 UTC + 3h offset lands on 2026-08-29 Israel-local', d === '2026-08-29', d);

  // The stray tick that produced the day-67 phantom cycle, created_at
  // 2026-08-29 12:00:04 UTC — still the same Israel calendar date.
  const d2 = israelDateStr(new Date('2026-08-29T12:00:04Z'), 3);
  check('12:00 UTC + 3h offset is STILL 2026-08-29 Israel-local (the collision this guard exists for)', d2 === '2026-08-29', d2);

  // Just past midnight Israel time (21:05 UTC = 00:05 next day IDT) rolls over.
  const d3 = israelDateStr(new Date('2026-08-29T21:05:00Z'), 3);
  check('21:05 UTC rolls over to the next Israel-local date', d3 === '2026-08-30', d3);
}

console.log('\n── §2 THE ACCEPTANCE TEST — two calls in immediate succession, same real day ──');
{
  const env = { SIM_KV: makeMockKv() };
  const todayDate = '2026-08-29';

  // Call 1: nothing recorded yet — the real Saturday 08:00 tick, day 66.
  const call1 = await alreadyAdvancedToday(env, todayDate);
  check('CALL 1 (first tick of the day): alreadyAdvancedToday returns false — day is allowed to open', call1 === false, String(call1));
  await recordDayAdvance(env, todayDate, 66);
  console.log(`  → CALL 1 output: alreadyAdvancedToday=${call1}; day opened, recordDayAdvance(env, '${todayDate}', 66) called.`);

  // Call 2: the SAME real calendar day, immediate succession — this is
  // exactly the stray "14:30 dayOfWeek=1" tick that landed 7 hours later on
  // the live Saturday and produced the phantom day-67 cycle.
  const call2 = await alreadyAdvancedToday(env, todayDate);
  check('CALL 2 (stray/duplicate tick, SAME day): alreadyAdvancedToday returns true — day-open is REFUSED', call2 === true, String(call2));
  console.log(`  → CALL 2 output: alreadyAdvancedToday=${call2} — this is the return value agent-runner.js's guard checks before opening a second cycle. It refuses; the day does NOT advance a second time.`);

  check('The marker in KV still reads back day 66 (unchanged by the refused second call)',
    JSON.parse(env.SIM_KV.store.get(LAST_DAY_ADVANCE_KEY_NAME)).day === 66);
}

console.log('\n── §3 the NEXT real day still opens normally ──');
{
  const env = { SIM_KV: makeMockKv() };
  await recordDayAdvance(env, '2026-08-29', 66);
  const tomorrow = await alreadyAdvancedToday(env, '2026-08-30');
  check('A genuinely new calendar date is NOT blocked by yesterday\'s marker', tomorrow === false, String(tomorrow));
}

console.log('\n── §4 fails CLOSED, and cannot throw out of the tick ──');
{
  const throwingGetEnv = { SIM_KV: { get: async () => { throw new Error('KV outage'); }, put: async () => {} } };
  let threw = false;
  let result;
  try {
    result = await alreadyAdvancedToday(throwingGetEnv, '2026-08-29');
  } catch {
    threw = true;
  }
  check('A throwing SIM_KV.get does not propagate out of alreadyAdvancedToday()', threw === false);
  check('...and resolves to true (refuse to advance) rather than false (would allow a second day)', result === true, String(result));

  const throwingPutEnv = { SIM_KV: { get: async () => null, put: async () => { throw new Error('KV write failed'); } } };
  let putThrew = false;
  try {
    await recordDayAdvance(throwingPutEnv, '2026-08-29', 67);
  } catch {
    putThrew = true;
  }
  check('A throwing SIM_KV.put does not propagate out of recordDayAdvance() (KFM-14 shape)', putThrew === false);
}

console.log('\n── §5 no SIM_KV binding — matches every other SIM_KV-gated check\'s "nothing to guard" default ──');
{
  const noKvEnv = {};
  check('alreadyAdvancedToday(noKvEnv) is false (never refuses when there is no KV to have raced)', (await alreadyAdvancedToday(noKvEnv, '2026-08-29')) === false);
  let threw = false;
  try {
    await recordDayAdvance(noKvEnv, '2026-08-29', 67);
  } catch {
    threw = true;
  }
  check('recordDayAdvance(noKvEnv) is a silent no-op, not a throw', threw === false);
}

console.log('\n── §6 the guard is actually wired into agent-runner.js\'s cycle-open branch (source-level) ──');
{
  const src = readFileSync(path.join(root, 'workers/agent-runner.js'), 'utf8');
  check('agent-runner.js imports the guard from day-advance-guard.js',
    /from '\.\/day-advance-guard\.js'/.test(src));
  check('the cycle-open condition (isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek) is unchanged — the guard adds a check, it does not replace the trigger',
    src.includes('if (isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek) {'));
  // The guard call must appear INSIDE that branch, before nextDay is computed,
  // and the branch must return (not continue) when it refuses.
  const branchStart = src.indexOf('if (isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek) {');
  const branchSlice = src.slice(branchStart, branchStart + 2000);
  check('alreadyAdvancedToday() is called inside the cycle-open branch', branchSlice.includes('await alreadyAdvancedToday(env, todayDate)'));
  check('a refused advance returns a skip result (does not fall through to opening the cycle)',
    /alreadyAdvancedToday\(env, todayDate\)\)\s*\{\s*\n\s*return \{\s*\n\s*skipped: true, reason: 'day_already_advanced_today'/.test(branchSlice));
  check('recordDayAdvance() is called before the cycle object is built (nextDay computed just above it)',
    branchSlice.indexOf('await recordDayAdvance(env, todayDate, nextDay);') > branchSlice.indexOf('const nextDay =')
    && branchSlice.indexOf('await recordDayAdvance(env, todayDate, nextDay);') < branchSlice.indexOf('cycle = {'));
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
