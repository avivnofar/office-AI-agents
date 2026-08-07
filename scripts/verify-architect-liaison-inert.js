#!/usr/bin/env node
// Inertness proof for workers/architect-liaison.js (built 2026-08-07,
// phase-2 Architect-automation build session). This is the WRITTEN TEST
// PROCEDURE handed to the owner — run it, read the numbers, do not take
// this file's docstring's word for it.
//
// NO NETWORK. globalThis.fetch is a TRIPWIRE that throws if called with no
// mock installed — "made no GitHub API call" is PROVEN, not claimed, same
// technique as verify-improvement-loop.js and verify-routing.js. D1 is a
// recording fake.
//
// Three things this file proves, in order:
//   1. THE FLAG. architectLiaisonEnabled() reads exactly the KV shape this
//      module documents, defaults false on every absence, and is strict
//      equality against `true` (not truthiness) — same standard as every
//      other kill-switch flag in this repo (guides/routing/improvement-loop).
//   2. THE CALL SITE IS GATED, NOT JUST THE FUNCTION. Reads agent-runner.js
//      AS TEXT and asserts the `architect_liaison` block dispatch is a
//      ternary on architectLiaisonEnabled(sim) — i.e. the call site itself
//      decides whether processArchitectLiaisonBlock() is ever invoked, the
//      module does not merely no-op internally the way guide_* blocks do.
//      This is the "unreachable, not merely inactive" property, and it is
//      checked against the actual source file, not a transcription of it.
//   3. WHEN ENABLED, IT ACTUALLY WORKS. With the flag true and fetch/D1
//      mocked, the real fetch -> parse -> file pipeline runs and produces
//      exactly the D1 row this repo's schema expects, keyed for idempotency.
//
// Run: node scripts/verify-architect-liaison-inert.js

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { architectLiaisonEnabled, processArchitectLiaisonBlock } from '../workers/architect-liaison.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fetchCalls = 0;
let fetchMock = null;
globalThis.fetch = (...args) => {
  fetchCalls++;
  if (fetchMock) return fetchMock(...args);
  throw new Error('TRIPWIRE: verify-architect-liaison-inert.js made a network call with no mock installed. It must not.');
};
if (!globalThis.atob) {
  globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
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

console.log('Dry-run only — fetch is a tripwire, D1 is a recording fake.\n');

/* ── 1. The flag ─────────────────────────────────────────────────────────── */
console.log('-- 1. The kill switch (default OFF) --');
check('sim WITHOUT the key -> disabled (this is the shipped default: no KV key exists in production)',
  architectLiaisonEnabled({ guides_enabled: true }), false);
check('sim.architect_liaison_enabled = false -> disabled', architectLiaisonEnabled({ architect_liaison_enabled: false }), false);
check('sim.architect_liaison_enabled = true -> enabled', architectLiaisonEnabled({ architect_liaison_enabled: true }), true);
check('sim.architect_liaison_enabled = "true" (string) -> disabled, === true not truthiness', architectLiaisonEnabled({ architect_liaison_enabled: 'true' }), false);
check('sim.architect_liaison_enabled = 1 -> disabled', architectLiaisonEnabled({ architect_liaison_enabled: 1 }), false);
check('sim = undefined (no simulation-state at all) -> disabled', architectLiaisonEnabled(undefined), false);
check('sim = null -> disabled', architectLiaisonEnabled(null), false);

/* ── 2. Static defaults never bake the flag on ──────────────────────────── */
console.log('\n-- 2. config/simulation-config.json never sets the flag true by default --');
{
  const simConfigPath = path.join(__dirname, '..', 'config', 'simulation-config.json');
  const simConfigText = fs.readFileSync(simConfigPath, 'utf8');
  checkTrue('simulation-config.json does not mention architect_liaison_enabled at all',
    !simConfigText.includes('architect_liaison_enabled'));
}

/* ── 3. THE CALL SITE, not just the function, is gated ──────────────────── */
console.log('\n-- 3. agent-runner.js source: the call site gates entry, the function does not self-gate --');
{
  const runnerPath = path.join(__dirname, '..', 'workers', 'agent-runner.js');
  const runnerText = fs.readFileSync(runnerPath, 'utf8');

  checkTrue('agent-runner.js imports processArchitectLiaisonBlock from architect-liaison.js',
    /import\s*\{[^}]*processArchitectLiaisonBlock[^}]*\}\s*from\s*['"]\.\/architect-liaison\.js['"]/.test(runnerText));

  // The dispatch must read: architectLiaisonEnabled(sim) ? await processArchitectLiaisonBlock(env) : <skip>
  // i.e. the call is the CONSEQUENT of a ternary on the flag, not something
  // the function itself decides after being entered.
  const dispatchMatch = runnerText.match(
    /architectLiaisonEnabled\(sim\)\s*\n?\s*\?\s*await processArchitectLiaisonBlock\(env\)\s*\n?\s*:\s*\{[^}]*skipped:\s*true/
  );
  checkTrue('the architect_liaison block dispatch is a ternary: flag ? call the module : return a skipped stub inline',
    !!dispatchMatch);

  // Negative check: an ACTUAL CALL (not a comment mention, not the import)
  // must exist exactly once in this file — the one inside the ternary
  // matched above. Strip line-comments first so a prose mention of the
  // function name in an explanatory comment cannot masquerade as, or hide,
  // a second real call site.
  const codeOnly = runnerText
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const realCalls = [...codeOnly.matchAll(/(?<!import[^;]*)\bprocessArchitectLiaisonBlock\(env\)/g)]
    .filter((m) => !codeOnly.slice(Math.max(0, m.index - 80), m.index).includes('import'));
  check('exactly one ACTUAL CALL processArchitectLiaisonBlock(env) in agent-runner.js, after stripping comments and the import line',
    realCalls.length, 1);
}

/* ── 4. config/daily-schedule.json: shipped, but flagged off in its own doc ── */
console.log('\n-- 4. daily-schedule.json carries the block and documents it as shipped-off --');
{
  const schedulePath = path.join(__dirname, '..', 'config', 'daily-schedule.json');
  const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
  const fullDayHasIt = schedule.full_day_schedule.blocks.some((b) => b.type === 'architect_liaison');
  const fridayHasIt = schedule.friday_schedule.blocks.some((b) => b.type === 'architect_liaison');
  checkTrue('full_day_schedule carries an architect_liaison block', fullDayHasIt);
  checkTrue('friday_schedule carries an architect_liaison block', fridayHasIt);
  checkTrue('saturday_schedule does NOT carry one (off day, matches guide_draft/guide_review absence there)',
    !schedule.saturday_schedule.blocks.some((b) => b.type === 'architect_liaison'));
  checkTrue('architect_liaison_program doc block exists and self-documents SHIPPED OFF',
    schedule.architect_liaison_program?._meta?.includes('SHIPPED OFF'));
}

/* ── 5. When the flag is OFF at the module level, no fetch, no D1 write ──── */
console.log('\n-- 5. processArchitectLiaisonBlock() called directly WITHOUT a token: zero fetch calls --');
{
  fetchCalls = 0;
  const env = {}; // no BACKOFFICE_REPO_TOKEN, no DB
  const r = await processArchitectLiaisonBlock(env);
  check('returns filed:false, reason names the missing token', r, { filed: false, reason: 'BACKOFFICE_REPO_TOKEN not configured on this Worker' });
  check('ZERO fetch calls', fetchCalls, 0);
}

/* ── 6. When enabled end-to-end: real fetch -> parse -> file pipeline ────── */
console.log('\n-- 6. Flag ON (simulated): the real module fetches, parses, and files exactly one D1 row --');
{
  fetchCalls = 0;
  const writes = [];
  const record = {
    schema_version: 1,
    stamp: '2026-08-08-0000',
    date: '2026-08-08',
    agent_id: 10,
    mode: 'headless-midnight',
    outcome: 'build',
    task_slug: 'office-site',
    phase_id: 'scaffold',
    phase_title: 'Static shell, layout, data contract',
    summary: 'Built phase 1/3. 6 checks run, 6 passed.',
    checks: { ran: 6, passed: 6, exit_code: 0 },
    commits: [{ repo: 'warehouse-office-AI-agents', sha: 'a'.repeat(40) }],
    harvest: 'none',
    run_report_path: 'campus/agents/10-the-architect/runs/2026-08-08-0000-architect.md',
    todo_sweep_path: 'campus/agents/10-the-architect/runs/2026-08-08-0000-todo-sweep.md',
  };
  const encoded = Buffer.from(JSON.stringify(record)).toString('base64');

  fetchMock = async (url) => {
    if (url.endsWith('/contents/campus/agents/10-the-architect/runs')) {
      return {
        ok: true,
        json: async () => [
          { type: 'file', name: '2026-08-07-0000-session-record.json' },
          { type: 'file', name: '2026-08-08-0000-session-record.json' },
          { type: 'file', name: '2026-08-08-0000-architect.md' },
        ],
      };
    }
    if (url.endsWith('/2026-08-08-0000-session-record.json')) {
      return { ok: true, json: async () => ({ content: encoded }) };
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };

  const env = {
    BACKOFFICE_REPO_TOKEN: 'fake-token-for-test',
    DB: {
      prepare(sql) {
        return {
          bind: (...args) => ({
            run: async () => {
              const already = writes.some((w) => w.args[0] === args[0]);
              if (!already) writes.push({ sql, args });
              return { success: true, meta: { changes: already ? 0 : 1 } };
            },
          }),
        };
      },
    },
  };

  const r1 = await processArchitectLiaisonBlock(env);
  check('picks the LEXICOGRAPHICALLY LATEST record (2026-08-08, not 2026-08-07)', r1.filed, true);
  check('deterministic id keys off the record stamp', r1.id, 'architect-session-2026-08-08-0000');
  check('exactly 2 fetch calls (list dir, then fetch the one file)', fetchCalls, 2);
  check('exactly 1 D1 write', writes.length, 1);
  const [w] = writes;
  check('INSERT targets agent_id 10 (the Architect)', w.args[1], 10);
  check("INSERT type is 'architect_session'", w.args[2], 'architect_session');
  check('title names the date and outcome', w.args[3], 'Architect session — 2026-08-08 (build)');
  check('content is the record summary, not the full record', w.args[4], record.summary);
  check("event_type is 'architect_liaison', separable from guide_* / office_event rows", w.args[6], 'architect_liaison');

  // Idempotency: a second call with the same record must not double-file.
  fetchCalls = 0;
  const r2 = await processArchitectLiaisonBlock(env);
  check('second call with the SAME record: filed:false (idempotent no-op)', r2.filed, false);
  check('...and still exactly 1 total D1 write across both calls', writes.length, 1);
}

/* ── 7. Malformed / unversioned records are refused, not guessed ─────────── */
console.log('\n-- 7. Refuses rather than guesses on bad input --');
{
  fetchMock = async (url) => {
    if (url.endsWith('/contents/campus/agents/10-the-architect/runs')) {
      return { ok: true, json: async () => [{ type: 'file', name: 'x-session-record.json' }] };
    }
    return { ok: true, json: async () => ({ content: Buffer.from(JSON.stringify({ schema_version: 2 })).toString('base64') }) };
  };
  const env = { BACKOFFICE_REPO_TOKEN: 't', DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true, meta: { changes: 1 } }) }) }) } };
  const r = await processArchitectLiaisonBlock(env);
  check('unknown schema_version is refused, not parsed optimistically', r.filed, false);
  checkTrue('reason names the schema_version mismatch', r.reason?.includes('schema_version'));
}
{
  fetchMock = async () => ({ ok: true, json: async () => [] });
  const env = { BACKOFFICE_REPO_TOKEN: 't' };
  const r = await processArchitectLiaisonBlock(env);
  check('empty runs/ directory -> filed:false, no crash', r.filed, false);
}

console.log(`\n=== ${passed} passed, ${failed} failed (${fetchCalls} fetch calls in the last block) ===`);
console.log(failed === 0 ? 'All scenarios matched expectations.' : 'MISMATCH — see FAIL lines above.');
process.exit(failed === 0 ? 0 : 1);
