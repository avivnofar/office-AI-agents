#!/usr/bin/env node
/**
 * scripts/verify-brain-audit.js — the brain audit (Session 33, Item D).
 *
 * `globalThis.fetch` is a tripwire. `workers/brain-audit.js` is slicing,
 * prompt-building and validation; every fetch on this path belongs to
 * `agent-runner.js`.
 *
 * ── WHAT THIS IS ACTUALLY GUARDING ────────────────────────────────────────
 *
 * §3 is the item. `parseDecomposition()` has to REFUSE a decomposition that
 * is not executable, and refuse it rather than repair it — a five-task list
 * this code quietly patched would be filed as the Architect's and would not be
 * his, and the whole question D3 asks is what he actually produces.
 *
 *   node scripts/verify-brain-audit.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AUDIT_LENSES, AUDIT_DELIVERABLES, HARVEST_SLICES, ALREADY_PACKAGED_FOR_EXPORT,
  sliceHarvest, buildDecomposePrompt, parseDecomposition, looksLikeATitleWithAVerb,
  renderDecomposition, buildTaskPrompt, deliverablePath, renderDeliverable,
} from '../workers/brain-audit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-brain-audit.js made a network call'); };

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

/* ═══ §1 — five lenses, five DIFFERENT questions ═══ */
section('§1 five lenses — five different questions, not five opinions on one');

check('there are exactly five', AUDIT_LENSES.length === 5);
check('each is bound to a distinct agent',
  new Set(AUDIT_LENSES.map((l) => l.agentId)).size === 5);
check('each asks a distinct question',
  new Set(AUDIT_LENSES.map((l) => l.question)).size === 5);
check('the five are the five the brief named — Architect, Team Lead, QA, Cyber, IT Chief',
  JSON.stringify(AUDIT_LENSES.map((l) => l.agentId)) === JSON.stringify([10, 7, 6, 13, 5]));
check("the IT Chief's is the operability one — how would you know it had failed",
  /how would you know one had failed/i.test(AUDIT_LENSES.find((l) => l.agentId === 5).question));
check('the lens list is frozen — a session that swaps one has changed what the audit measured',
  Object.isFrozen(AUDIT_LENSES));

/* ═══ §2 — three deliverables, and D7's fourth question is NOT one ═══ */
section("§2 three deliverables — and the toolbox question is not the fourth");

check('exactly three', AUDIT_DELIVERABLES.length === 3);
check('none of them is "what skills does the office need"',
  !AUDIT_DELIVERABLES.some((d) => /need|toolbox|should build/i.test(d.title)));
const decomposePrompt = buildDecomposePrompt({ harvestSlice: 'x', sliceLabel: 'y', standardSlice: 'z' });
check('and the Architect is told in the prompt that it is OUT OF SCOPE',
  /OUT OF SCOPE/.test(decomposePrompt) && /what skills does the office NEED/i.test(decomposePrompt));
check('...with the reason, so a later session does not read it as an oversight',
  /depends on knowing what already exists/i.test(decomposePrompt));
check('D6: deliverable 3 starts from the three already-packaged items, not a blank page',
  ALREADY_PACKAGED_FOR_EXPORT.length === 3
  && ALREADY_PACKAGED_FOR_EXPORT.every((s) => decomposePrompt.includes(s)));
check('and those three are the ones the brief named',
  /regression-proof-by-transcription/.test(ALREADY_PACKAGED_FOR_EXPORT[0])
  && /three-way-blind-evaluation/.test(ALREADY_PACKAGED_FOR_EXPORT[1])
  && /three-signals-agreeing/.test(ALREADY_PACKAGED_FOR_EXPORT[2]));

/* ═══ §3 — THE ITEM: a title with a verb in front of it is REFUSED ═══ */
section('§3 the refusals — a title with a verb in front of it is not an executable task');

check('"audit the brain" is refused', looksLikeATitleWithAVerb('Audit the brain.'));
check('"handle OB-023" — the exact shape the Workflow emitted on 2026-08-28 — is refused',
  looksLikeATitleWithAVerb('handle OB-023'));
check('"review the templates" is refused', looksLikeATitleWithAVerb('Review the templates'));
check('an empty instruction is refused', looksLikeATitleWithAVerb(''));
check('a real instruction — two sentences, named objects, a stated method — is accepted',
  !looksLikeATitleWithAVerb(
    'Read the four brain templates in full plus the measured intake standard table. For each template, '
    + 'identify at least one concrete structural weakness that shows up specifically at scale, and propose one '
    + 'concrete template change rather than a general observation.'
  ));

const goodTask = (lens, slice) => ({
  lens, agent_id: AUDIT_LENSES.find((l) => l.key === lens).agentId, harvest_slice: slice,
  question: 'A real question with a wrong answer?',
  instruction: 'Read the named slice and produce a list of concrete findings. For each finding, name the exact item it '
    + 'is about and state in one sentence what should change about it.',
  deliverable: 'A list. Feeds deliverable 1.',
});
const FIVE = AUDIT_LENSES.map((l) => goodTask(l.key, 'templates'));

check('a well-formed five-task decomposition is ACCEPTED',
  parseDecomposition(JSON.stringify({ tasks: FIVE })).ok === true);
check('four tasks are refused', !parseDecomposition(JSON.stringify({ tasks: FIVE.slice(0, 4) })).ok);
check('six tasks are refused', !parseDecomposition(JSON.stringify({ tasks: [...FIVE, FIVE[0]] })).ok);
check('a repeated lens is refused — five opinions on one question is the failure this exists to catch',
  !parseDecomposition(JSON.stringify({ tasks: [FIVE[0], FIVE[0], FIVE[2], FIVE[3], FIVE[4]] })).ok);
check('a slice that does not exist is refused, never silently fallen back to the whole digest',
  !parseDecomposition(JSON.stringify({ tasks: [goodTask('templates', 'everything'), ...FIVE.slice(1)] })).ok);
check('a task whose instruction is a title with a verb is refused, and the refusal QUOTES it',
  (() => {
    const bad = { ...FIVE[0], instruction: 'Audit the brain.' };
    const r = parseDecomposition(JSON.stringify({ tasks: [bad, ...FIVE.slice(1)] }));
    return !r.ok && /title with a verb/.test(r.reason) && /Audit the brain/.test(r.reason);
  })());
check('a refusal still RETURNS the parsed tasks, so a human can read what he actually said',
  Array.isArray(parseDecomposition(JSON.stringify({ tasks: [{ ...FIVE[0], instruction: 'x' }, ...FIVE.slice(1)] })).tasks));
check('non-JSON is refused with a reason, not a guess', !parseDecomposition('sorry, I cannot do that').ok);
check('a missing tasks array is refused', !parseDecomposition('{"plan":"..."}').ok);

/* ═══ §4 — the slices ═══ */
section('§4 slicing the harvest — cut on headings, never on offsets');

const FAKE = [
  '# HARVEST', '', '## What is here', 'table', '',
  '## The intake standard, measured across both libraries', 'counts', '',
  '## The brain\'s packaging templates, in full', 'templates', '',
  '## The brain\'s governance, excerpted', 'pipeline', '',
  '## `aviv-brain` — skills', 'brain rows', '',
  '## The office\'s own skills (`campus/brain-export/skills/`)', 'office rows', '',
  '## Every request this harvest made to `aviv-brain` (129)', 'log',
].join('\n');

check('the templates slice stops before the governance excerpts',
  (() => { const r = sliceHarvest(FAKE, 'templates'); return r.ok && r.text.includes('templates') && !r.text.includes('pipeline'); })());
check('the brain-library slice carries the brain rows and not the office rows',
  (() => { const r = sliceHarvest(FAKE, 'brain-library'); return r.ok && r.text.includes('brain rows') && !r.text.includes('office rows'); })());
check('the office-library slice stops before the request log',
  (() => { const r = sliceHarvest(FAKE, 'office-library'); return r.ok && r.text.includes('office rows') && !r.text.includes('log'); })());
check('standard-only carries the counts and not the templates',
  (() => { const r = sliceHarvest(FAKE, 'standard-only'); return r.ok && r.text.includes('counts') && !r.text.includes('templates'); })());
check('an unknown slice key is refused and the legal keys are named',
  (() => { const r = sliceHarvest(FAKE, 'nope'); return !r.ok && /legal keys are/.test(r.reason); })());
check('a harvest whose SHAPE HAS CHANGED is refused, never silently fallen back to the whole file',
  (() => { const r = sliceHarvest('# HARVEST\n\nnothing familiar here', 'templates'); return !r.ok && /shape has changed/.test(r.reason); })());
check('truncation is applied AND declared, so the writer knows it was cut',
  (() => { const r = sliceHarvest(FAKE, 'templates', { maxChars: 20 }); return r.ok && r.truncated && /TRUNCATED/.test(r.text); })());
check('every slice key HARVEST_SLICES declares actually resolves against a real harvest shape',
  Object.keys(HARVEST_SLICES).every((k) => sliceHarvest(FAKE, k).ok));

/* ═══ §5 — the prompts carry the anti-fabrication instruction ═══ */
section('§5 the prompts — what the writer has, said in the prompt');

const taskPrompt = buildTaskPrompt({
  task: { question: 'q?', instruction: 'i', deliverable: 'd' },
  sliceText: 's', sliceLabel: 'l', deliverableTitle: 't',
});
check('the writer is told exactly what it has', /WHAT YOU HAVE, EXACTLY/.test(taskPrompt));
check('...and that it has NOT opened a repository or run anything',
  /You have NOT opened any repository, run any command/.test(taskPrompt));
check('...and that "I cannot tell from this" is a real finding, so refusing is available',
  /cannot tell\s*\n?from this" is a real finding|cannot tell/i.test(taskPrompt));
check('...and that a finding naming no skill is not a finding about a library',
  /names no skill is not a finding/.test(taskPrompt));
check('the slice is reproduced, not summarised at it', taskPrompt.includes('\ns\n'));

/* ═══ §6 — the output ═══ */
section('§6 what the owner gets, and where');

check('a deliverable lands in the channel, where he already reads',
  deliverablePath('2026-08-28', 'brain-packaging-templates') === 'channel/from-office/2026-08-28-review-brain-audit-brain-packaging-templates.md');
check('and its name matches the daily-obligation classifier\'s artifact rule, so it COUNTS as output',
  /^channel\/from-office\/\d{4}-\d{2}-\d{2}-review-.+\.md$/.test(deliverablePath('2026-08-28', 'x')));

const del = renderDeliverable({
  today: '2026-08-28', n: 1, title: 'T', lens: 'templates', agentId: 10, agentName: 'The Architect',
  question: 'q?', sliceLabel: 'the templates', truncated: true, text: 'body', provider: 'cerebras',
});
check('it carries the channel README\'s own header', /^---\nfrom: office\n/.test(del) && /kind: delivery/.test(del));
check('it says which slice the writer had, and that it was truncated',
  /the templates/.test(del) && /TRUNCATED/.test(del));
check('it says the slice carried headings and NOT bodies — so a body-dependent claim reads as unchecked',
  /not its body/.test(del) && /could not have checked/.test(del));

const doc = renderDecomposition({ today: '2026-08-28', tasks: parseDecomposition(JSON.stringify({ tasks: FIVE })).tasks, model: 'claude-x' });
check('the decomposition document carries the machine-readable JSON the executor reads back',
  /```json/.test(doc) && /"tasks"/.test(doc));
check('...and one readable section per task', (doc.match(/^## Task \d/gm) || []).length === 5);
check('...and names the test it is: the office\'s other decomposer emitted "handle OB-023"',
  /handle OB-023/.test(doc));

/* ═══ §7 — the wiring ═══ */
section('§7 the wiring');
check('processBrainAuditDecompose() exists', /async function processBrainAuditDecompose\(/.test(runner));
check('processBrainAuditTask() exists', /async function processBrainAuditTask\(/.test(runner));
check('both are reachable — supervised triggers, deliberately not on a schedule',
  /case 'brain_audit_decompose':/.test(runner) && /case 'brain_audit_task':/.test(runner));
check('the decompose call is guarded by the SAME architect sub-budget as the spec and the approval',
  /getClaudeBudgetStatus\(env, \{ component: 'architect' \}\)/.test(
    runner.slice(runner.indexOf('async function processBrainAuditDecompose('), runner.indexOf('async function processBrainAuditTask('))
  ));
check('a REFUSED decomposition is NOT filed, and the raw reply is kept',
  /was REFUSED: \$\{parsed\.reason\}/.test(runner) && /raw: result\.text/.test(runner));
check('the executor reads the task back OUT of the committed decomposition, so what runs is what was filed',
  /the decomposition carries no JSON block/.test(runner));
check('a missing harvest is a refusal that names the workflow to run, not an invented library',
  /nothing here invents a library it could not read/.test(runner));
check('the deliverables are written by the ROUTED lane, never by the Architect\'s Anthropic path',
  /adminDeskJudgment\(env, \{[\s\S]{0,400}eventId: `brain-audit:/.test(runner));

/* ═══════════════ done ═══════════════ */
console.log(`\n${fail === 0 ? '✅' : '❌'} verify-brain-audit: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
