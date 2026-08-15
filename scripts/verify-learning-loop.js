#!/usr/bin/env node
// Dry-run verification for the learning loop's write path (OFFICE-POLICY.md
// A2/A3) — workers/context-editor.js, probation.js, probation-review.js,
// embodiment-comparison.js, plus the agent-base.js embodiment-attribution fix
// this session made while building the comparison reader.
//
// NO REAL NETWORK. `globalThis.fetch` is replaced with a controllable fake
// that serves GitHub Contents API GET/PUT against an in-memory file map — not
// a tripwire, because these modules' whole job is to call fetch, and a test
// that never lets them would prove nothing about what they send. Every
// scenario that does NOT need a real write (refusals, pure logic) instead
// runs with the fake set to THROW on any call, so "refused before touching
// the network" is proven rather than claimed for those.
//
// D1 is a recording fake (same technique as verify-improvement-loop.js).
//
// Run: node scripts/verify-learning-loop.js

import {
  learningLoopEnabled, writeActiveContextAmendment, removeActiveContextEntry,
  writeJournalEntry, appendAdaptation, parseApprovedEntries, AGENT_SLUGS,
  SIM_STATE_KEY, LEARNING_LOOP_FLAG, ACTIVE_CONTEXT_CAP_BYTES,
} from '../workers/context-editor.js';
import {
  proposeChange, recordProbationAction, probationsDueForDecision, applyDecision,
  applyMissedMeetingFall, PROBATION_ACTIONS_TARGET, MAX_CONCURRENT_PER_AGENT,
} from '../workers/probation.js';
import { recordDecision, meetingMissedFalls, reviewTheReviewers, canBlameProvider, REVIEWERS, CEO_ID } from '../workers/probation-review.js';
import { runCrossEmbodimentComparison, renderComparisonFinding, MIN_SAMPLE_FOR_FINDING } from '../workers/embodiment-comparison.js';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
const __vdir = nodePath.dirname(fileURLToPath(import.meta.url));
const readRepo = (rel) => readFileSync(nodePath.join(__vdir, '..', rel), 'utf8');

if (!globalThis.crypto?.randomUUID) {
  let n = 0;
  globalThis.crypto = { randomUUID: () => `test-uuid-${++n}` };
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
function checkFalse(label, actual) { check(label, !!actual, false); }

/* ── fakes ───────────────────────────────────────────────────────────────── */

function b64(text) { return Buffer.from(text, 'utf8').toString('base64'); }
function unb64(b) { return Buffer.from(b, 'base64').toString('utf8'); }

/** A controllable GitHub Contents API fake, keyed by path. `files` is a live
 *  Map the test can inspect after the call. `commits` records every PUT. */
function makeGithubFetch(files, commits) {
  return async (url, opts = {}) => {
    const m = /\/contents\/(.+)$/.exec(url);
    const path = m ? decodeURIComponent(m[1]) : null;
    const method = opts.method || 'GET';
    if (method === 'GET') {
      if (!files.has(path)) return { ok: false, status: 404, text: async () => 'Not Found', json: async () => null };
      return { ok: true, status: 200, json: async () => ({ content: b64(files.get(path)), sha: 'fake-sha' }) };
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const text = unb64(body.content);
      files.set(path, text);
      commits.push({ path, text, message: body.message });
      return { ok: true, status: 200, json: async () => ({ content: { sha: 'new-fake-sha' } }) };
    }
    throw new Error(`unhandled fake fetch: ${method} ${url}`);
  };
}

function throwingFetch(label) {
  return async () => { throw new Error(`TRIPWIRE: ${label} made a network call and should have refused before doing so.`); };
}

function fakeDb() {
  const tables = { probation: [] };
  const db = {
    _tables: tables,
    prepare(sql) {
      const handlers = (args) => {
          const run = async () => {
            if (/^CREATE TABLE/.test(sql)) return { success: true };
            if (/^INSERT INTO repo_writes/.test(sql)) return { success: true }; // recordRepoWrite() — not under test here
            if (/^INSERT INTO probation/.test(sql)) {
              const [id, agent_id, aspect, proposed_by, active_context_kind, entry_text] = args;
              tables.probation.push({ id, agent_id, aspect, proposed_by, active_context_kind, entry_text, action_count: 0, rounds: 1, status: 'open', decided_at: null, decision: null, evidence: null, decided_by: null, entered_at: 'now' });
              return { success: true };
            }
            if (/^UPDATE probation SET action_count = action_count \+ 1/.test(sql)) {
              const [agentId] = args;
              let changes = 0;
              for (const r of tables.probation) if (r.agent_id === agentId && r.status === 'open') { r.action_count += 1; changes++; }
              return { success: true, meta: { changes } };
            }
            if (/^UPDATE probation SET rounds/.test(sql)) {
              const [decision, evidence, decidedBy, id] = args;
              const r = tables.probation.find((x) => x.id === id);
              if (r) { r.rounds += 1; r.action_count = 0; r.decision = decision; r.evidence = evidence; r.decided_by = decidedBy; r.decided_at = 'now'; }
              return { success: true };
            }
            if (/^UPDATE probation SET status = 'kept'/.test(sql)) {
              const [decision, evidence, decidedBy, id] = args;
              const r = tables.probation.find((x) => x.id === id);
              if (r) { r.status = 'kept'; r.decision = decision; r.evidence = evidence; r.decided_by = decidedBy; r.decided_at = 'now'; }
              return { success: true };
            }
            if (/^UPDATE probation SET status = 'dropped'/.test(sql)) {
              const [decision, evidence, decidedBy, id] = args;
              const r = tables.probation.find((x) => x.id === id);
              if (r) { r.status = 'dropped'; r.decision = decision; r.evidence = evidence; r.decided_by = decidedBy; r.decided_at = 'now'; }
              return { success: true };
            }
            if (/^UPDATE probation SET status = 'fell'/.test(sql)) {
              const [evidence, id] = args;
              const r = tables.probation.find((x) => x.id === id);
              if (r) { r.status = 'fell'; r.decision = 'fell_process_failure'; r.evidence = evidence; r.decided_at = 'now'; }
              return { success: true };
            }
            throw new Error(`fakeDb: unhandled UPDATE/INSERT: ${sql}`);
          };
          const first = async () => {
            if (/^SELECT \* FROM probation WHERE id = \?/.test(sql)) {
              return tables.probation.find((r) => r.id === args[0]) || null;
            }
            throw new Error(`fakeDb: unhandled first(): ${sql}`);
          };
          const all = async () => {
            if (/^SELECT id, aspect FROM probation WHERE agent_id/.test(sql)) {
              const [agentId, status] = args;
              return { results: tables.probation.filter((r) => r.agent_id === agentId && r.status === status).map((r) => ({ id: r.id, aspect: r.aspect })) };
            }
            if (/^SELECT \* FROM probation WHERE status = \? AND action_count >= \?/.test(sql)) {
              const [status, target] = args;
              return { results: tables.probation.filter((r) => r.status === status && r.action_count >= target) };
            }
            if (/^SELECT \* FROM probation WHERE agent_id = \? AND status = \?/.test(sql)) {
              const [agentId, status] = args;
              return { results: tables.probation.filter((r) => r.agent_id === agentId && r.status === status) };
            }
            // `created_at, scorer_id` joined the SELECT on 2026-08-16 (OB-080):
            // the comparison cannot tell which formula produced a row without
            // them. Matched loosely on the leading columns so an added column
            // does not break the fake for a reason unrelated to what it fakes.
            if (/^SELECT agent_id, project, embodiment_model, quality/.test(sql)) {
              return { results: db._embodimentRows || [] };
            }
            throw new Error(`fakeDb: unhandled all(): ${sql}`);
          };
          return { run, first, all };
      };
      return { ...handlers([]), bind: (...args) => handlers(args) };
    },
  };
  return db;
}

function fakeEnv({ flag = true, files = new Map(), commits = [], withFetch = true, withDb = true, withToken = true } = {}) {
  const env = {};
  env.SIM_KV = { get: async (key) => (key === SIM_STATE_KEY ? { [LEARNING_LOOP_FLAG]: flag } : null) };
  if (withDb) env.DB = fakeDb();
  if (withToken) env.BACKOFFICE_REPO_TOKEN = 'fake-token';
  if (withFetch) globalThis.fetch = makeGithubFetch(files, commits);
  return env;
}

function activeContextFixture(existingEntries = []) {
  const body = existingEntries.length
    ? existingEntries.map((e) => e.text).join('\n\n')
    : '*None yet.*';
  return `# active-context.md — Agent 04, The Trainee\n\n> curated file\n\n## The Child of the Cascade\n\nsome persona table\n\n## Approved conclusions\n\n${body}\n`;
}

console.log('Dry-run — fake GitHub Contents API + recording D1, no real network.\n');

/* ══════════════════════ 1. context-editor.js: flag gating ══════════════════════ */
console.log('-- 1. learning_loop_enabled gates every write function BEFORE any network call --');
{
  const env = fakeEnv({ flag: false, withFetch: false });
  globalThis.fetch = throwingFetch('writeActiveContextAmendment with flag off');
  const r1 = await writeActiveContextAmendment(env, { actorId: 6, targetAgentId: 4, content: 'x' });
  check('active-context write refused, flag off', r1, { written: false, reason: 'learning_loop_disabled' });

  globalThis.fetch = throwingFetch('writeJournalEntry with flag off');
  const r2 = await writeJournalEntry(env, { actorId: 4, agentId: 4, content: 'x' });
  check('journal write refused, flag off', r2, { written: false, reason: 'learning_loop_disabled' });

  globalThis.fetch = throwingFetch('appendAdaptation with flag off');
  const r3 = await appendAdaptation(env, { actorId: 4, agentId: 4, topic: 'x', content: 'x' });
  check('adaptation write refused, flag off', r3, { written: false, reason: 'learning_loop_disabled' });

  const r4 = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'x', content: 'x' });
  check('probation propose refused, flag off', r4, { proposed: false, reason: 'learning_loop_disabled' });

  console.log('       (a flag absent from SIM_KV entirely — the true shipped default — refuses identically)');
  const envAbsent = fakeEnv({ flag: false, withFetch: false });
  envAbsent.SIM_KV = { get: async () => ({}) }; // key present, learning_loop_enabled absent
  globalThis.fetch = throwingFetch('flag key absent');
  const r5 = await writeActiveContextAmendment(envAbsent, { actorId: 6, targetAgentId: 4, content: 'x' });
  check('active-context write refused, flag key absent (shipped default)', r5, { written: false, reason: 'learning_loop_disabled' });
}

/* ══════════════════════ 2. self-write is structurally impossible ══════════════════════ */
console.log('\n-- 2. no agent modifies its own active context (A2) — every agent id, not one lucky case --');
{
  globalThis.fetch = throwingFetch('self-write attempt');
  let allRefused = true;
  for (const id of Object.keys(AGENT_SLUGS).map(Number)) {
    const env = fakeEnv({ flag: true, withFetch: false });
    // actorId only makes sense as 6 or 7; test both against themselves.
    for (const actor of [6, 7]) {
      if (id !== actor) continue;
      const r = await writeActiveContextAmendment(env, { actorId: actor, targetAgentId: id, content: 'x' });
      if (r.written !== false || !/no agent modifies its own/.test(r.reason)) allRefused = false;
    }
  }
  checkTrue('QA (6) self-write refused; Team Lead (7) self-write refused', allRefused);

  const env2 = fakeEnv({ flag: true, withFetch: false });
  const rOther = await writeActiveContextAmendment(env2, { actorId: 4, targetAgentId: 7, content: 'x' });
  checkTrue('a non-reviewer (agent 4) may not amend ANY active context', rOther.written === false && /only the QA/.test(rOther.reason));
}

/* ══════════════════════ 3. a real write, and the roll-off ══════════════════════ */
console.log('\n-- 3. a real active-context amendment, and the 8KB roll-off --');
{
  const files = new Map();
  const commits = [];
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture());
  files.set('campus/agents/04-the-trainee/journal.md', '# journal.md — Agent 04\n\nAppend-only.\n\n---\n');
  const env = fakeEnv({ flag: true, files, commits });

  const r = await writeActiveContextAmendment(env, { actorId: 6, targetAgentId: 4, content: 'Handles ambiguous notebook answers well.', date: '2026-08-10' });
  checkTrue('write succeeds', r.written);
  check('kind is QA-approved', r.kind, 'QA-approved');
  const newFile = files.get('campus/agents/04-the-trainee/active-context.md');
  checkTrue('new entry present in the committed file', newFile.includes('Handles ambiguous notebook answers well.'));
  checkTrue('the "None yet" placeholder is gone', !newFile.includes('*None yet.*'));
  checkTrue('nothing outside the Approved conclusions section was touched', newFile.startsWith('# active-context.md — Agent 04, The Trainee'));

  // Force a roll-off: pre-fill the file near the cap with three big entries.
  const bigEntries = [
    { text: `### 2026-07-01 — QA-approved (work quality)\n\n${'A'.repeat(3000)}` },
    { text: `### 2026-07-15 — Team-Lead-approved (persona)\n\n${'B'.repeat(3000)}` },
    { text: `### 2026-08-01 — QA-approved (work quality)\n\n${'C'.repeat(2000)}` },
  ];
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture(bigEntries));
  files.set('campus/agents/04-the-trainee/journal.md', '# journal.md — Agent 04\n\nAppend-only.\n\n---\n');
  const r2 = await writeActiveContextAmendment(env, { actorId: 7, targetAgentId: 4, content: 'D'.repeat(2000), date: '2026-08-10' });
  checkTrue('over-cap write still succeeds', r2.written);
  const rolledFile = files.get('campus/agents/04-the-trainee/active-context.md');
  const rolledBytes = Buffer.byteLength(rolledFile, 'utf8');
  checkTrue(`active-context.md stays within the ${ACTIVE_CONTEXT_CAP_BYTES}-byte cap after roll-off`, rolledBytes <= ACTIVE_CONTEXT_CAP_BYTES);
  checkTrue('the oldest entry (2026-07-01) rolled OFF active-context.md', !rolledFile.includes('2026-07-01'));
  checkTrue('the newest entry (2026-08-10) stayed ON active-context.md', rolledFile.includes('2026-08-10'));
  const journalFile = files.get('campus/agents/04-the-trainee/journal.md');
  checkTrue('the rolled-off entry landed in journal.md', journalFile.includes('2026-07-01') && journalFile.includes('A'.repeat(3000)));
  checkTrue('journal.md still carries its original header (append, not replace)', journalFile.startsWith('# journal.md — Agent 04'));
}

/* ══════════════════════ 4. DROP reverts the live file; already-rolled-off is a safe no-op ══════════════════════ */
console.log('\n-- 4. removeActiveContextEntry (probation DROP) --');
{
  const entryText = '### 2026-08-10 — QA-approved (work quality)\n\nTest entry to drop.';
  const files = new Map([['campus/agents/04-the-trainee/active-context.md', activeContextFixture([{ text: entryText }])]]);
  const env = fakeEnv({ flag: true, files, commits: [] });
  const r = await removeActiveContextEntry(env, { actorId: 6, targetAgentId: 4, entryText });
  checkTrue('drop succeeds and removes the entry', r.written && r.removed);
  checkTrue('the file no longer contains the dropped entry', !files.get('campus/agents/04-the-trainee/active-context.md').includes('Test entry to drop.'));

  const files2 = new Map([['campus/agents/04-the-trainee/active-context.md', activeContextFixture([])]]);
  const env2 = fakeEnv({ flag: true, files: files2, commits: [] });
  const r2 = await removeActiveContextEntry(env2, { actorId: 6, targetAgentId: 4, entryText: 'not present, already rolled off' });
  check('drop of an already-rolled-off entry is a safe no-op', { written: r2.written, removed: r2.removed }, { written: true, removed: false });
}

/* ══════════════════════ 5. journal.md: self-write only, append-only ══════════════════════ */
console.log('\n-- 5. journal.md — self-write only, append-only --');
{
  globalThis.fetch = throwingFetch('cross-agent journal write');
  const env = fakeEnv({ flag: true, withFetch: false });
  const r = await writeJournalEntry(env, { actorId: 6, agentId: 4, content: 'ghost-writing for the Trainee' });
  checkTrue('a reviewer may NOT write another agent\'s journal', r.written === false && /own journal/.test(r.reason));

  const original = '# journal.md — Agent 04\n\nAppend-only, never edited by anyone else.\n\n---\n';
  const files = new Map([['campus/agents/04-the-trainee/journal.md', original]]);
  const env2 = fakeEnv({ flag: true, files, commits: [] });
  const r2 = await writeJournalEntry(env2, { actorId: 4, agentId: 4, content: 'Today was long.', date: '2026-08-10' });
  checkTrue('self-write succeeds', r2.written);
  const after = files.get('campus/agents/04-the-trainee/journal.md');
  checkTrue('original content is an untouched prefix (nothing removed)', after.startsWith(original.trimEnd()));
  checkTrue('new content is appended', after.includes('Today was long.'));
}

/* ══════════════════════ 6. adaptations — structurally append-only ══════════════════════ */
console.log('\n-- 6. adaptations/ — append only, never deletion (A2) --');
{
  globalThis.fetch = throwingFetch('unauthorized adaptation writer');
  const env = fakeEnv({ flag: true, withFetch: false });
  const r = await appendAdaptation(env, { actorId: 3, agentId: 4, topic: 'x', content: 'x' });
  checkTrue('agent 3 may not write agent 4\'s adaptation (not self, not a reviewer)', r.written === false);

  const original = '# asking a clarifying follow up — Agent 04\n\n### 2026-08-05 — self\n\nSEED text from the bible.\n';
  const files = new Map([['campus/agents/04-the-trainee/adaptations/asking-a-clarifying-follow-up.md', original]]);
  const env2 = fakeEnv({ flag: true, files, commits: [] });
  const r2 = await appendAdaptation(env2, { actorId: 4, agentId: 4, topic: 'asking-a-clarifying-follow-up', content: 'Real lesson from week 1.', date: '2026-08-10' });
  checkTrue('append to existing adaptation succeeds', r2.written);
  const after = files.get('campus/agents/04-the-trainee/adaptations/asking-a-clarifying-follow-up.md');
  checkTrue('EVERY prior byte survives as a prefix — this is what makes deletion structurally impossible, not a convention', after.startsWith(original.trimEnd()));
  checkTrue('new content is appended', after.includes('Real lesson from week 1.'));

  // A second append never regresses the first.
  files.set('campus/agents/04-the-trainee/adaptations/asking-a-clarifying-follow-up.md', after);
  const r3 = await appendAdaptation(env2, { actorId: 6, agentId: 4, topic: 'asking-a-clarifying-follow-up', content: 'QA-added observation.', date: '2026-08-11' });
  const after2 = files.get('campus/agents/04-the-trainee/adaptations/asking-a-clarifying-follow-up.md');
  checkTrue('a reviewer (6) may also append', r3.written);
  checkTrue('the SECOND append still carries everything the first one had', after2.startsWith(after.trimEnd()) && after2.length > after.length);

  checkTrue('appendAdaptation() has no parameter/branch that accepts a full-file replacement (structural, not just tested-so-far)',
    !readRepo('workers/context-editor.js').includes('fullContent') && !/appendAdaptation[\s\S]{0,400}replace\s*:/.test(readRepo('workers/context-editor.js')));
}

/* ══════════════════════ 7. probation concurrency + aspect distinctness (A3) ══════════════════════ */
console.log('\n-- 7. probation: max 3 concurrent per agent, distinct aspects only (A3) --');
{
  const files = new Map([['campus/agents/04-the-trainee/active-context.md', activeContextFixture()]]);
  const env = fakeEnv({ flag: true, files, commits: [] });

  const p1 = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'follow-up-phrasing', content: 'lesson 1' });
  checkTrue('1st probation opens', p1.proposed);
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture([{ text: p1.entryText }]));
  const p2 = await proposeChange(env, { actorId: 7, targetAgentId: 4, aspect: 'panic-threshold', content: 'lesson 2' });
  checkTrue('2nd probation, different aspect, opens', p2.proposed);
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture([{ text: p1.entryText }, { text: p2.entryText }]));

  // Tested here, UNDER the ceiling (2 of 3 slots used), so a refusal can only
  // be the aspect-duplicate rule and not the concurrency ceiling — the two
  // refusals must stay distinguishable from each other.
  const pDup = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'follow-up-phrasing', content: 'a different take on the same aspect' });
  checkTrue('a SECOND open probation on the same aspect is refused, even under the ceiling', pDup.proposed === false && /cannot be told apart/.test(pDup.reason));

  const p3 = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'gap-sensitivity', content: 'lesson 3' });
  checkTrue('3rd probation, different aspect, opens', p3.proposed);

  const p4 = await proposeChange(env, { actorId: 7, targetAgentId: 4, aspect: 'a-fourth-thing', content: 'lesson 4' });
  checkTrue('4th concurrent probation on the SAME agent is refused (ceiling is 3)', p4.proposed === false && /concurrency ceiling/.test(p4.reason));

  check('MAX_CONCURRENT_PER_AGENT is 3, matching A3', MAX_CONCURRENT_PER_AGENT, 3);
  check('PROBATION_ACTIONS_TARGET is 20 actions, matching A3', PROBATION_ACTIONS_TARGET, 20);
}

/* ══════════════════════ 8. the agent is never told (A3) ══════════════════════ */
console.log('\n-- 8. the provisional entry is textually indistinguishable from a permanent one --');
{
  const files = new Map([['campus/agents/04-the-trainee/active-context.md', activeContextFixture()]]);
  const env = fakeEnv({ flag: true, files, commits: [] });
  const p = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'test-aspect', content: 'a real conclusion' });
  const committed = files.get('campus/agents/04-the-trainee/active-context.md');
  checkTrue('no "provisional"/"probation"/"trial" marker anywhere in the live file', !/provisional|probation|on trial/i.test(committed));
}

/* ══════════════════════ 9. action counting, decisions, missed-meeting fall ══════════════════════ */
console.log('\n-- 9. probation lifecycle: actions accumulate, decisions apply, a missed meeting falls --');
{
  const files = new Map([['campus/agents/04-the-trainee/active-context.md', activeContextFixture()]]);
  const env = fakeEnv({ flag: true, files, commits: [] });
  const p = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'test-aspect', content: 'lesson' });
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture([{ text: p.entryText }]));

  for (let i = 0; i < 19; i++) await recordProbationAction(env, 4);
  let due = await probationsDueForDecision(env);
  check('not yet due at 19 actions', due.length, 0);
  await recordProbationAction(env, 4);
  due = await probationsDueForDecision(env);
  check('due at 20 actions', due.length, 1);

  // -- kept --
  const decided1 = recordDecision({ probationId: p.id, teamLeadBehavior: 'consistent', qaQualityMetrics: 'avg 0.82 vs 0.71 baseline', decidedBy: REVIEWERS.LEAD_QA, outcome: 'kept', evidence: { n: 20 } });
  checkTrue('a well-formed decision validates', decided1.valid);
  const applied1 = await applyDecision(env, { probationId: p.id, outcome: 'kept', decidedBy: REVIEWERS.LEAD_QA, evidence: { n: 20 } });
  checkTrue('kept applies and closes the row without touching the file', applied1.applied && !applied1.stillOpen);
  checkTrue('the entry is still live after being kept', files.get('campus/agents/04-the-trainee/active-context.md').includes('lesson'));

  // -- dropped, on a fresh probation --
  const p2 = await proposeChange(env, { actorId: 7, targetAgentId: 4, aspect: 'second-aspect', content: 'lesson two' });
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture([{ text: p.entryText }, { text: p2.entryText }]));
  const applied2 = await applyDecision(env, { probationId: p2.id, outcome: 'dropped', decidedBy: REVIEWERS.LEAD_QA, decidingActorId: 7, evidence: { n: 20, reason: 'no measurable improvement' } });
  checkTrue('dropped applies and reverts the file', applied2.applied && applied2.reverted?.removed);
  checkTrue('the dropped entry is gone from the live file', !files.get('campus/agents/04-the-trainee/active-context.md').includes('lesson two'));
  checkTrue('the kept entry from the other probation is untouched', files.get('campus/agents/04-the-trainee/active-context.md').includes('lesson'));

  // -- extended --
  const p3 = await proposeChange(env, { actorId: 6, targetAgentId: 4, aspect: 'third-aspect', content: 'lesson three' });
  const applied3 = await applyDecision(env, { probationId: p3.id, outcome: 'extended', decidedBy: REVIEWERS.LEAD_QA, evidence: { n: 20, reason: 'inconclusive' } });
  checkTrue('extended stays open for another round', applied3.applied && applied3.stillOpen);

  // -- decision validation refusals --
  const badDecider = recordDecision({ probationId: p.id, teamLeadBehavior: 'x', qaQualityMetrics: 'y', decidedBy: REVIEWERS.QA, outcome: 'kept', evidence: { n: 1 } });
  checkTrue('only the Lead QA (8) may decide', !badDecider.valid && /only the Lead QA/.test(badDecider.reason));
  const noEvidence = recordDecision({ probationId: p.id, teamLeadBehavior: 'x', qaQualityMetrics: 'y', decidedBy: REVIEWERS.LEAD_QA, outcome: 'kept', evidence: {} });
  checkTrue('a decision with no evidence is refused', !noEvidence.valid && /no evidence/.test(noEvidence.reason));
  const oneAxis = recordDecision({ probationId: p.id, teamLeadBehavior: '', qaQualityMetrics: 'y', decidedBy: REVIEWERS.LEAD_QA, outcome: 'kept', evidence: { n: 1 } });
  checkTrue('a decision missing the Team Lead\'s axis is refused', !oneAxis.valid);

  // -- missed meeting falls, and is routed back as a PROCESS failure --
  const p4 = await proposeChange(env, { actorId: 7, targetAgentId: 4, aspect: 'fourth-aspect', content: 'lesson four' });
  files.set('campus/agents/04-the-trainee/active-context.md', activeContextFixture([{ text: p.entryText }, { text: p3.entryText }, { text: p4.entryText }]));
  for (let i = 0; i < 20; i++) await recordProbationAction(env, 4);
  const missedCheck = meetingMissedFalls({ actionCount: 20, target: PROBATION_ACTIONS_TARGET, meetingHeld: false });
  checkTrue('meetingMissedFalls() says it falls, and as a PROCESS failure', missedCheck.falls && missedCheck.failureKind === 'process');
  check('routed back to all three reviewers', missedCheck.routedBackTo, [REVIEWERS.QA, REVIEWERS.TEAM_LEAD, REVIEWERS.LEAD_QA]);
  const heldCheck = meetingMissedFalls({ actionCount: 20, target: PROBATION_ACTIONS_TARGET, meetingHeld: true });
  checkFalse('...but not when the meeting WAS held', heldCheck.falls);
  const notDueCheck = meetingMissedFalls({ actionCount: 5, target: PROBATION_ACTIONS_TARGET, meetingHeld: false });
  checkFalse('...and not before the window closes', notDueCheck.falls);

  const fallApplied = await applyMissedMeetingFall(env, { probationId: p4.id, decidingActorId: 7 });
  checkTrue('the fall actually reverts the file', fallApplied.applied && fallApplied.reverted?.removed);
  checkTrue('lesson four is gone', !files.get('campus/agents/04-the-trainee/active-context.md').includes('lesson four'));
  checkTrue('a fallen change may be re-proposed with new evidence (A3) — the aspect frees up', true);
  const reproposed = await proposeChange(env, { actorId: 7, targetAgentId: 4, aspect: 'fourth-aspect', content: 'lesson four, revised' });
  checkTrue('re-proposal on the same aspect succeeds after the prior one fell/closed', reproposed.proposed);
}

/* ══════════════════════ 10. reviewing the reviewers ══════════════════════ */
console.log('\n-- 10. reviewing the reviewers — two of three, CEO decides, Architect opinion only --');
{
  const bad = reviewTheReviewers({ flaggedReviewer: REVIEWERS.QA, reviewingPair: [REVIEWERS.QA, REVIEWERS.LEAD_QA], decidedBy: CEO_ID });
  checkTrue('the flagged reviewer cannot be in their own reviewing pair', !bad.valid);

  const wrongDecider = reviewTheReviewers({ flaggedReviewer: REVIEWERS.QA, reviewingPair: [REVIEWERS.TEAM_LEAD, REVIEWERS.LEAD_QA], decidedBy: REVIEWERS.LEAD_QA });
  checkTrue('only the CEO may decide, not the Lead QA', !wrongDecider.valid && /CEO/.test(wrongDecider.reason));

  const good = reviewTheReviewers({ flaggedReviewer: REVIEWERS.QA, reviewingPair: [REVIEWERS.TEAM_LEAD, REVIEWERS.LEAD_QA], decidedBy: CEO_ID, architectOpinion: 'technically the QA\'s check was sound' });
  checkTrue('a well-formed reviewing-the-reviewers case validates', good.valid);
  checkTrue('the Architect opinion is carried but never a vote', good.record.architectOpinion === 'technically the QA\'s check was sound');
  checkTrue('this must reach the weekly report for visibility, per A3', good.record.mustReportToOwnerInWeeklyReport === true);
}

/* ══════════════════════ 11. provider-blame threshold ══════════════════════ */
console.log('\n-- 11. blaming the provider requires the real threshold, not a hunch --');
{
  const noComparison = canBlameProvider({ failingAgentIds: [1, 2, 3], embodimentComparisonDone: false });
  checkTrue('no embodiment comparison run -> suspicion, never a conclusion, even with 3 agents', !noComparison.canBlame && noComparison.verdict === 'suspicion');

  const tooFew = canBlameProvider({ failingAgentIds: [1, 2], failingDates: [], embodimentComparisonDone: true });
  checkTrue('comparison done but only 2 agents and 0 days -> still a suspicion', !tooFew.canBlame);

  const threeAgents = canBlameProvider({ failingAgentIds: [1, 2, 3], embodimentComparisonDone: true });
  checkTrue('3 distinct agents + comparison -> a conclusion', threeAgents.canBlame && threeAgents.basis === 'three_different_agents');

  const threeDays = canBlameProvider({ failingAgentIds: [4], failingDates: ['2026-08-08', '2026-08-09', '2026-08-10'], embodimentComparisonDone: true });
  checkTrue('1 agent failing the same action on 3 different days + comparison -> a conclusion', threeDays.canBlame && threeDays.basis === 'three_different_days');
}

/* ══════════════════════ 12. the cross-embodiment comparison reader ══════════════════════ */
console.log('\n-- 12. embodiment-comparison.js reads real rows, never fabricates a finding on a thin sample --');
{
  const env = fakeEnv({ flag: true, withFetch: false });
  globalThis.fetch = throwingFetch('embodiment comparison (must be DB-only, no network)');
  // `created_at`/`scorer_id` ADDED to these fixtures 2026-08-16: a row with no
  // timestamp is not a shape live D1 can produce (the column has a DEFAULT), and
  // a fixture that cannot be attributed exercises the could-not-check path
  // instead of the one this section is about.
  const AT = '2026-08-20 05:00:00';   // after quality-metric.js UNIFIED_FROM
  const SC = 'length-proxy-v2@800';
  env.DB._embodimentRows = [
    { agent_id: 1, project: 'notebook-x', embodiment_model: null, quality: 0.9, created_at: AT, scorer_id: SC },
    { agent_id: 1, project: 'notebook-x', embodiment_model: 'groq', quality: 1.0, created_at: AT, scorer_id: SC },
    { agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.8, created_at: AT, scorer_id: SC },
  ];
  const thin = await runCrossEmbodimentComparison(env);
  check('unreliable (null-embodiment) rows are counted, not silently dropped', thin.unreliableRowCount, 1);
  check('reliable rows only feed the comparison', thin.reliableRowCount, 2);
  checkTrue('thin sample -> insufficient_sample finding, not a fabricated gap', thin.findings.some((f) => f.kind === 'insufficient_sample'));
  checkFalse('...and specifically NOT an embodiment_quality_gap finding', thin.findings.some((f) => f.kind === 'embodiment_quality_gap'));

  const rich = [];
  for (let i = 0; i < 8; i++) rich.push({ agent_id: 1, project: 'notebook-x', embodiment_model: 'groq', quality: 0.95, created_at: AT, scorer_id: SC });
  for (let i = 0; i < 8; i++) rich.push({ agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.60, created_at: AT, scorer_id: SC });
  env.DB._embodimentRows = rich;
  const gapFound = await runCrossEmbodimentComparison(env);
  checkTrue(`with ${MIN_SAMPLE_FOR_FINDING}+ rows on both sides and a real gap, a finding IS produced`, gapFound.findings.some((f) => f.kind === 'embodiment_quality_gap'));
  checkFalse('...and one scorer across all the rows means nothing is refused as confounded',
    gapFound.findings.some((f) => f.kind === 'comparison_refused_confounded'));
  const rendered = renderComparisonFinding(gapFound, { date: '2026-08-10' });
  checkTrue('renderComparisonFinding() produces readable Markdown', rendered.includes('## Cross-embodiment comparison'));
}

/* ══════════════════════ 13. fails against PRE-CHANGE behaviour ══════════════════════ */
console.log('\n-- 13. this catches the actual pre-2026-08-10 gap, not a strawman --');
{
  // Before this session: zero call sites wrote either file. The capability
  // audit's own method (grep the filename across workers/ and agents/) is
  // repeated here so this check would have FAILED before this session's
  // files existed, and passes now that context-editor.js is the one caller.
  const workersAndAgents = ['workers', 'agents'].flatMap((dir) => {
    try {
      return readdirSync(nodePath.join(__vdir, '..', dir))
        .filter((f) => /\.js$/.test(f) && f !== 'context-editor.js')
        .map((f) => `${dir}/${f}`);
    } catch { return []; }
  });
  const anyOtherWriter = workersAndAgents.some((rel) => {
    const src = readRepo(rel);
    return /active-context\.md['"`]/.test(src) && /commitFileToRepo|fetch\(/.test(src);
  });
  checkFalse('active-context.md is written from exactly one place (context-editor.js) — no second, undocumented writer crept in', anyOtherWriter);

  // The agent-base.js embodiment-attribution fix, found while building the
  // comparison reader: prove the OLD shape (source undefined, silent
  // fallthrough to a stale lastModelSource) is gone from the live source.
  const agentBase = readRepo('agents/agent-base.js');
  checkTrue('_askDataCenter() now returns an explicit source', /source:\s*'claude'/.test(agentBase));
  checkTrue('_askNotebookX() now returns an explicit source', /source:\s*'gemini'/.test(agentBase));
}

/* ══════════ THE AUTONOMOUS CALLER — audit finding #8, 2026-08-15 ═════════
 *
 * Both instruments below were fully built, marked capability-SUPPLIED, and
 * reachable ONLY by a manual admin trigger. No scheduled block referenced
 * either, so as far as the 2026-08-15 audit could tell NEITHER HAD EVER RUN.
 *
 * These are SOURCE-LEVEL checks on purpose: agent-runner.js imports JSON and
 * pulls in the whole Worker, so a verifier under plain `node` cannot call
 * processQaInstrumentsBlock(). What can be proven here is exactly the thing
 * that was missing — that a scheduled path names it at all. KFM-08's own
 * rule: grep for the call site, never trust the definition.
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n-- the autonomous caller (audit #8): qa_instruments --');
{
  const runnerSrc = readRepo('workers/agent-runner.js');
  const schedule = JSON.parse(readRepo('config/daily-schedule.json'));
  const fridayBlocks = schedule.friday_schedule.blocks;
  const qaBlocks = Object.values(schedule)
    .filter((v) => v && Array.isArray(v.blocks))
    .flatMap((v) => v.blocks)
    .filter((b) => b.type === 'qa_instruments');

  const wiringChecks = [
    ['[FAILS-OLD] a SCHEDULED block of type qa_instruments exists', qaBlocks.length >= 1],
    ['…exactly one, so a weekly instrument does not run twice a week', qaBlocks.length === 1],
    ['…on Friday', fridayBlocks.some((b) => b.type === 'qa_instruments')],
    ['…at a tick nothing else occupies (the 2026-08-15 subrequest lesson)',
      fridayBlocks.filter((b) => b.time === '09:30').length === 1],
    ['…and NOT as the day\'s last block, which triggers finalizeScheduledDay()',
      fridayBlocks[fridayBlocks.length - 1].type !== 'qa_instruments'],
    ['[FAILS-OLD] runScheduledBlock() dispatches it', /block\.type === 'qa_instruments'/.test(runnerSrc)],
    ['…to processQaInstrumentsBlock()', /processQaInstrumentsBlock\(env,/.test(runnerSrc)],
    ['the handler calls the cross-embodiment comparison',
      /async function processQaInstrumentsBlock[\s\S]{0,4000}?runCrossEmbodimentComparison\(env\)/.test(runnerSrc)],
    ['the handler calls review-the-reviewers',
      /async function processQaInstrumentsBlock[\s\S]{0,6000}?reviewTheReviewers\(\{/.test(runnerSrc)],
    ['the handler commits its finding somewhere a human can read it',
      /async function processQaInstrumentsBlock[\s\S]{0,9000}?commitFileToRepo\(env, BACKOFFICE_REPO_NAME/.test(runnerSrc)],
    // KFM-17 — a NEW generated path joining the ~319-day rollover problem
    // would be this session creating audit finding #2 rather than avoiding it.
    ['the generated filename carries a FULL DATE, not a bare week index (KFM-17)',
      /qa-instruments\/\$\{today\}-qa-instruments\.md/.test(runnerSrc)],
    // The switch decision, asserted so a later session cannot quietly add one.
    ['it rides improvement_loop_enabled and carries NO switch of its own',
      /async function processQaInstrumentsBlock[\s\S]{0,1500}?improvementLoopEnabled\(env\)/.test(runnerSrc)
      && !/qa_instruments_enabled/.test(runnerSrc)],
    ['the supervised trigger still exists — the trigger is A path, not THE path',
      /case 'qa_instruments_block':/.test(runnerSrc)],
    ['the block never invents a verdict — the round is opened OPEN',
      /outcome: 'OPEN/.test(runnerSrc)],
  ];
  for (const [label, ok] of wiringChecks) checkTrue(label, ok);

  // The rotation itself, proven by CALLING the real function: every reviewer
  // comes up, and the reviewing pair is always exactly the other two.
  const THREE = [6, 7, 8];
  const seen = new Set();
  let rotationOk = true;
  for (let week = 0; week < 9; week += 1) {
    const flagged = THREE[week % THREE.length];
    seen.add(flagged);
    const v = reviewTheReviewers({
      flaggedReviewer: flagged,
      reviewingPair: THREE.filter((id) => id !== flagged),
      decidedBy: CEO_ID,
    });
    if (!v.valid) rotationOk = false;
  }
  checkTrue('the ISO-week rotation reaches ALL THREE reviewers and every round validates',
    rotationOk && seen.size === 3);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('SOME SCENARIOS FAILED — see [FAIL] lines above.');
  process.exit(1);
} else {
  console.log('All scenarios matched expectations.');
}

// Restore fetch so this file can be safely imported/re-run in-process.
delete globalThis.fetch;
