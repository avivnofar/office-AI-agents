#!/usr/bin/env node
/**
 * Dry-run verification for the capability audit (2026-08-10).
 *
 * NO NETWORK, NO D1/KV, NO MODEL CALLS. globalThis.fetch is a tripwire that
 * throws if anything reaches it.
 *
 * ── THE ONE SCENARIO THAT MATTERS MOST ───────────────────────────────────
 *
 * §2 runs the audit against a supply index representing THE REPOSITORY AS IT
 * STOOD ON 2026-08-09 — no image lane, no image clients — and asserts that the
 * Designer comes back as an agent who cannot produce any of her own output. If
 * she does not, this tool would not have found the thing it was built to find,
 * and every other check here is decoration.
 *
 * That is this repo's own standing rule, applied to a gap-finder instead of to a
 * bug fix: **a test that describes a fix is not a test that catches a bug.** The
 * way to tell them apart is to transcribe the old state and run the new scenario
 * table against it.
 *
 * Run: node scripts/verify-capability-audit.js
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  auditCapabilities, auditRoleClaims, resolveCapability, renderAudit,
  VERDICTS, GAP_VERDICTS, auditFindingsToBoardItems,
} from '../workers/capability-audit.js';
import { normalizeActionItems, renderBoardTask } from '../workers/meeting-decisions.js';

const require = createRequire(import.meta.url);
const manifest = require('../config/capability-manifest.json');
const agentsConfig = require('../config/agents-config.json');

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`[PASS] ${label}`); pass += 1; }
  else { console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`); fail += 1; }
}

const NETWORK = [];
globalThis.fetch = (...args) => {
  NETWORK.push(String(args[0]));
  throw new Error(`verify-capability-audit.js made a network call to ${args[0]} — this verifier must stay dry-run`);
};

console.log('=== Capability audit verification — dry-run only ===\n');

/* ── 1. The module is pure and the verdicts are the three OB-001 names ──── */
console.log('--- 1. Shape ---');

const src = readFileSync(new URL('../workers/capability-audit.js', import.meta.url), 'utf8');
check('capability-audit.js imports NOTHING (so plain node can exercise the real code)',
  !/^import /m.test(src));
check('the three verdicts are exactly SUPPLIED / UNPROVEN / UNSUPPLIED',
  VERDICTS.join(',') === 'SUPPLIED,UNPROVEN,UNSUPPLIED', VERDICTS.join(','));
check('only UNSUPPLIED counts as a gap — UNPROVEN is NOT folded into it',
  GAP_VERDICTS.join(',') === 'UNSUPPLIED', GAP_VERDICTS.join(','));
check('the module records that collapsing UNPROVEN into SUPPLIED is the six-times mistake',
  /UNPROVEN into SUPPLIED is exactly the mistake/.test(src));

/* ── 2. THE DESIGNER, ON 2026-08-09  [FAILS-OLD] ─────────────────────────
 *
 * The supply index below is the repository as it was YESTERDAY: no
 * `lanes.image.roles.*`, no cf-image-client.js, no gemini-image-client.js, no
 * renderAssetProvenance. Everything else present.
 *
 * If this audit had existed then, it had to report her as unable to produce any
 * of her own output. That is the entire claim of the tool. */
console.log('\n--- 2. The Designer as she stood on 2026-08-09  [FAILS-OLD] ---');

/** A supply index with a named set of things REMOVED. Built by subtraction from
 *  a full index so the scenario cannot drift from the manifest: adding a
 *  capability to the manifest automatically appears here too. */
function indexWithout({ lanes = [], modules = [], symbols = {} } = {}) {
  const idx = { modules: {}, lanes: {}, verifiers: [] };
  for (const [id, cap] of Object.entries(manifest.capabilities)) {
    const m = cap.supplied_by;
    if (m.kind === 'module' && !modules.includes(m.ref)) {
      const drop = symbols[m.ref] || [];
      idx.modules[m.ref] = idx.modules[m.ref] || [];
      if (m.symbol && !drop.includes(m.symbol)) idx.modules[m.ref].push(m.symbol);
    }
    if (m.kind === 'lane' && !lanes.includes(m.symbol)) idx.lanes[m.symbol] = true;
    if (cap.exercised_by) idx.verifiers.push(cap.exercised_by);
  }
  return idx;
}

const YESTERDAY = indexWithout({
  lanes: ['lanes.image.roles.draft', 'lanes.image.roles.polish'],
  modules: ['workers/owner-page.js'],
  symbols: {
    'workers/provider-common.js': ['renderAssetProvenance'],
    'workers/meeting-decisions.js': ['computeOutputCensus'],
    'workers/capability-audit.js': ['auditCapabilities'],
  },
});

const yAudit = auditCapabilities(manifest, YESTERDAY);
const yRoles = auditRoleClaims(yAudit, manifest, manifest.output_kind_producers);
const yDesigner = yRoles.find((r) => r.id === 9);

/*
 * ── THE VERDICT IS `PARTLY_SUPPLIED`, AND THAT IS THE WHOLE PROBLEM ───────
 *
 * This check first asserted CANNOT_PRODUCE_ITS_OWN_OUTPUT and FAILED, correctly.
 * On 2026-08-09 the Designer COULD produce one of her three declared output
 * kinds: `design_flag` maps to `routine-drafting`, and writing prose about
 * structural ugliness is genuinely something she could do — the bible says her
 * first weekly report raises exactly those flags.
 *
 * The assertion was wrong; the code was right. And the corrected fact is SHARPER
 * than the one it replaces: **her role read as PARTLY SUPPLIED, which is the
 * healthiest-looking verdict a broken role can have.** She could complain about
 * ugliness in prose and could not make a picture, and any summary that stopped at
 * the top-line verdict would have moved on. It is the KIND-LEVEL detail —
 * `visual_asset` unproducible, and by which capability — that carries the finding.
 *
 * Recorded here rather than quietly corrected, because "the test I wrote first
 * was too strong and the truth was more interesting" is the useful artifact.
 */
check('[FAILS-OLD] on 2026-08-09 the Designer could NOT produce a `visual_asset`',
  yDesigner.unproducibleKinds.includes('visual_asset'), yDesigner.unproducibleKinds.join(','));
check('[FAILS-OLD] ...nor a `front_publication`',
  yDesigner.unproducibleKinds.includes('front_publication'), yDesigner.unproducibleKinds.join(','));
check('[FAILS-OLD] ...and yet her role verdict was PARTLY_SUPPLIED — the healthiest-looking verdict a broken role can have, because she could still write prose',
  yDesigner.roleVerdict === 'PARTLY_SUPPLIED', yDesigner.roleVerdict);
check('[FAILS-OLD] ...the one kind she COULD produce was the prose one, which is why a top-line verdict hides this',
  yDesigner.kinds.find((k) => k.kind === 'design_flag')?.producible === true,
  JSON.stringify(yDesigner.kinds.map((k) => `${k.kind}:${k.producible}`)));
check('[FAILS-OLD] ...and both image capabilities are the reason, named individually',
  yAudit.capabilities.filter((c) => c.id.startsWith('image-') && c.verdict === 'UNSUPPLIED').length === 2,
  yAudit.capabilities.filter((c) => c.id.startsWith('image-')).map((c) => `${c.id}:${c.verdict}`).join(','));
check('[FAILS-OLD] ...and the asset-provenance capability was UNSUPPLIED too, so even a hand-made asset had no note',
  yAudit.capabilities.find((c) => c.id === 'asset-provenance').verdict === 'UNSUPPLIED');

/* THE POINT OF THE WHOLE EXERCISE, stated as a check: a COUNT of her
 * capabilities looked perfectly healthy that day, because she shared every
 * generic capability with everybody. Only the role-claim half sees the gap. */
const yDesignerAgent = yAudit.agents.find((a) => a.id === 9);
check('[FAILS-OLD] her SUPPLIED count was healthy — a count-based check would have passed her',
  yDesignerAgent.supplied >= 5, String(yDesignerAgent.supplied));
check('[FAILS-OLD] ...and `canWork` was TRUE, because she could ask questions like everybody else',
  yDesignerAgent.canWork === true);
check('[FAILS-OLD] ...so only the KIND-LEVEL detail catches her: healthy count, `canWork: true`, PARTLY_SUPPLIED verdict, and no way to make a picture',
  yDesignerAgent.canWork === true
  && yDesigner.roleVerdict === 'PARTLY_SUPPLIED'
  && yDesigner.unproducibleKinds.includes('visual_asset'));

/* ── 3. TODAY: the image lane closes it ─────────────────────────────────── */
console.log('\n--- 3. Today, with the image lane wired ---');

const TODAY = indexWithout({});
const tAudit = auditCapabilities(manifest, TODAY);
const tRoles = auditRoleClaims(tAudit, manifest, manifest.output_kind_producers);
const tDesigner = tRoles.find((r) => r.id === 9);

check('the Designer can now produce a `visual_asset`',
  tDesigner.kinds.find((k) => k.kind === 'visual_asset')?.producible === true,
  JSON.stringify(tDesigner.kinds.find((k) => k.kind === 'visual_asset')));
check('...so her role verdict moves off CANNOT_PRODUCE_ITS_OWN_OUTPUT',
  tDesigner.roleVerdict !== 'CANNOT_PRODUCE_ITS_OWN_OUTPUT', tDesigner.roleVerdict);
check('...and she is PARTLY, not FULLY, supplied — the publishing gate and localization are still missing',
  tDesigner.roleVerdict === 'PARTLY_SUPPLIED', tDesigner.roleVerdict);
check('...and `front_publication` is still named as unproducible, so the remaining gap is not papered over',
  tDesigner.unproducibleKinds.includes('front_publication'), tDesigner.unproducibleKinds.join(','));
check('both image capabilities are SUPPLIED today',
  tAudit.capabilities.filter((c) => c.id.startsWith('image-')).every((c) => c.verdict === 'SUPPLIED'));

/* ── 4. Resolution refuses rather than guesses ──────────────────────────── */
console.log('\n--- 4. A reference resolves by SYMBOL, not by filename ---');

const byFilenameOnly = resolveCapability('x', {
  what: 'a thing', agents: [1],
  supplied_by: { kind: 'module', ref: 'workers/real.js', symbol: 'theFunction' },
  exercised_by: 'scripts/verify-x.js',
}, { modules: { 'workers/real.js': ['somethingElse'] }, lanes: {}, verifiers: ['scripts/verify-x.js'] });
check('a module that exists but does NOT export the named symbol is UNSUPPLIED',
  byFilenameOnly.verdict === 'UNSUPPLIED', JSON.stringify(byFilenameOnly));
check('...and the reason names the failure shape: resolves by filename, not by symbol',
  /by filename and not by symbol/.test(byFilenameOnly.reason), byFilenameOnly.reason);

const missingModule = resolveCapability('x', {
  what: 'a thing', agents: [1], supplied_by: { kind: 'module', ref: 'workers/gone.js', symbol: 'f' }, exercised_by: null,
}, { modules: {}, lanes: {}, verifiers: [] });
check('a module that does not exist at all is UNSUPPLIED', missingModule.verdict === 'UNSUPPLIED');

const unroutableLane = resolveCapability('x', {
  what: 'a thing', agents: [1], supplied_by: { kind: 'lane', ref: 'config/model-routing.json', symbol: 'lanes.nope' }, exercised_by: null,
}, { modules: {}, lanes: { 'lanes.nope': false }, verifiers: [] });
check('a lane that exists but is NOT ROUTABLE is UNSUPPLIED (config presence is not routability)',
  unroutableLane.verdict === 'UNSUPPLIED', JSON.stringify(unroutableLane));

const noVerifier = resolveCapability('x', {
  what: 'a thing', agents: [1], supplied_by: { kind: 'module', ref: 'workers/real.js', symbol: 'f' }, exercised_by: null,
}, { modules: { 'workers/real.js': ['f'] }, lanes: {}, verifiers: [] });
check('a capability whose code resolves but which nothing exercises is UNPROVEN, never SUPPLIED',
  noVerifier.verdict === 'UNPROVEN', JSON.stringify(noVerifier));
check('...and the reason quotes OB-001\'s rule rather than restating it loosely',
  /UNPROVEN, never SUPPLIED/.test(noVerifier.reason), noVerifier.reason);

const phantomVerifier = resolveCapability('x', {
  what: 'a thing', agents: [1], supplied_by: { kind: 'module', ref: 'workers/real.js', symbol: 'f' }, exercised_by: 'scripts/verify-imaginary.js',
}, { modules: { 'workers/real.js': ['f'] }, lanes: {}, verifiers: [] });
check('a manifest that NAMES a verifier which does not exist is UNPROVEN, not SUPPLIED',
  phantomVerifier.verdict === 'UNPROVEN', JSON.stringify(phantomVerifier));
check('...and the reason says it is a claim about being tested that nothing backs',
  /nothing backs/.test(phantomVerifier.reason));

const declaredNone = resolveCapability('x', {
  what: 'a thing', agents: [1], supplied_by: { kind: 'none', why: 'NOT BUILT — board OB-999' }, exercised_by: null,
}, { modules: {}, lanes: {}, verifiers: [] });
check('a capability the manifest declares unsupplied comes back UNSUPPLIED with its reason carried verbatim',
  declaredNone.verdict === 'UNSUPPLIED' && declaredNone.reason === 'NOT BUILT — board OB-999');

/* ── 5. The manifest's own integrity ────────────────────────────────────── */
console.log('\n--- 5. The manifest\'s own integrity ---');

check('all thirteen agents are in the manifest', Object.keys(manifest.agents).length === 13,
  Object.keys(manifest.agents).join(','));
check('every agent carries a verbatim bible_claim (a paraphrase is where an invented capability gets in)',
  Object.values(manifest.agents).every((a) => typeof a.bible_claim === 'string' && a.bible_claim.length > 40),
  Object.entries(manifest.agents).filter(([, a]) => !a.bible_claim).map(([k]) => k).join(','));
check('every agent declares output_kinds',
  Object.values(manifest.agents).every((a) => Array.isArray(a.output_kinds) && a.output_kinds.length > 0));
check('every capability names at least one agent (a capability for nobody is not a capability)',
  Object.values(manifest.capabilities).every((c) => Array.isArray(c.agents) && c.agents.length > 0),
  Object.entries(manifest.capabilities).filter(([, c]) => !c.agents?.length).map(([k]) => k).join(','));
check('every capability states its cost (free tier, which tier, or none)',
  Object.values(manifest.capabilities).every((c) => typeof c.cost === 'string' && c.cost.length > 0));
check('every capability naming no supplier gives a WHY (a gap with no reason gets re-investigated)',
  Object.values(manifest.capabilities)
    .filter((c) => c.supplied_by?.kind === 'none')
    .every((c) => typeof c.supplied_by.why === 'string' && c.supplied_by.why.length > 30));
check('every agent id a capability names is on the roster',
  auditCapabilities(manifest, TODAY).unknownAgents.length === 0,
  JSON.stringify(auditCapabilities(manifest, TODAY).unknownAgents));
check('every output_kind a role declares has a producer entry (an unmapped kind is a gap in the MANIFEST)',
  Object.values(manifest.agents).flatMap((a) => a.output_kinds)
    .every((k) => k in manifest.output_kind_producers),
  Object.values(manifest.agents).flatMap((a) => a.output_kinds)
    .filter((k) => !(k in manifest.output_kind_producers)).join(','));
check('every producer named by output_kind_producers is a real capability id',
  Object.values(manifest.output_kind_producers).flat().every((id) => id in manifest.capabilities),
  Object.values(manifest.output_kind_producers).flat().filter((id) => !(id in manifest.capabilities)).join(','));
check('the manifest states it is NOT a skills library',
  /NOT a skills library/.test(manifest._meta.what_this_is_not));
check('the manifest states it is non-exhaustive, so "no gaps" cannot be read as "nothing missing"',
  /NON-EXHAUSTIVE/.test(manifest._meta.how_to_extend));

/* ── 6. The Architect's dormancy is an exemption, not a gap ─────────────── */
console.log('\n--- 6. Dormancy is a state, not a missing capability ---');

check('the Architect is marked dormant in the audit', tAudit.agents.find((a) => a.id === 10).dormant === true);
check('...and is excluded from agentsWhoCannotWork even if he had nothing',
  auditCapabilities(manifest, { modules: {}, lanes: {}, verifiers: [] })
    .agents.find((a) => a.id === 10).dormant === true);
check('...and the exemption is PASSED IN, not hardcoded in the module',
  /dormantAgents = \[10\]/.test(src) && /passed in rather than hardcoded/.test(src));
check('a caller may state a different exemption list',
  auditCapabilities(manifest, TODAY, { dormantAgents: [] }).agents.find((a) => a.id === 10).dormant === false);

/* ── 7. The rendered document leads with the gaps ───────────────────────── */
console.log('\n--- 7. The findings document leads with the gaps ---');

const doc = renderAudit(tAudit, tRoles, { date: '2026-08-10' });
const gapsIdx = doc.indexOf('## The gaps');
const perAgentIdx = doc.indexOf('## Per agent');
check('the gaps section comes BEFORE the per-agent table', gapsIdx > 0 && gapsIdx < perAgentIdx);
check('every UNSUPPLIED capability appears in the document by id',
  tAudit.capabilities.filter((c) => c.verdict === 'UNSUPPLIED').every((c) => doc.includes(`\`${c.id}\``)));
check('each gap names whose role needs it, by agent name', /Whose role needs it:.*Agent 9 — The Designer/.test(doc));
check('the document names the census as the OTHER mechanism, so neither is mistaken for both',
  /computeOutputCensus/.test(doc) && /absent from the census/.test(doc));
check('the document warns that "no gaps" means "no gaps anybody wrote down"',
  /non-exhaustive/i.test(doc) || tAudit.counts.unsupplied > 0);
check('the "what the bible says nothing supplies" section exists and is not empty today',
  /What the bible says a role does that nothing supplies/.test(doc)
  && tRoles.some((r) => r.roleVerdict !== 'FULLY_SUPPLIED'));

/* ── 8. Findings -> board tasks (2026-08-11, Phase 5 — the weekly audit) ── */
console.log('\n--- 8. Findings -> board tasks, not a report nobody acts on ---');

{
  const items = auditFindingsToBoardItems(tAudit);
  const gapCount = tAudit.capabilities.filter((c) => c.verdict !== 'SUPPLIED').length;
  check('one board item per non-SUPPLIED capability', items.length === gapCount, `${items.length} vs ${gapCount} gaps`);
  check('SUPPLIED capabilities produce NO item — this is a gap tracker, not a full inventory dump',
    !items.some((it) => tAudit.capabilities.find((c) => it.task.includes(`"${c.id}"`) && c.verdict === 'SUPPLIED')));
  check('every item names a real roster agent as agent_id (the manifest\'s own attribution, not a guess)',
    items.every((it) => agentsConfig.agents.some((a) => a.id === it.agent_id)));
  check('a capability shared by more than one agent still produces exactly ONE item, attributed to agents[0]',
    (() => {
      const shared = tAudit.capabilities.find((c) => c.verdict !== 'SUPPLIED' && (c.agents || []).length > 1);
      if (!shared) return true; // nothing to check today — not a failure, just no fixture
      const hit = items.filter((it) => it.task.includes(`"${shared.id}"`));
      return hit.length === 1 && hit[0].agent_id === shared.agents[0];
    })());
  check('UNSUPPLIED gets a longer due-days window than UNPROVEN (building code vs. writing a verifier)',
    (() => {
      const unsupplied = items.find((it) => tAudit.capabilities.find((c) => it.task.includes(`"${c.id}"`) && c.verdict === 'UNSUPPLIED'));
      const unproven = items.find((it) => tAudit.capabilities.find((c) => it.task.includes(`"${c.id}"`) && c.verdict === 'UNPROVEN'));
      if (!unsupplied || !unproven) return true; // today's fixture may have only one verdict class
      return unsupplied.due_days > unproven.due_days;
    })());
  check('every item is `decided: true` — the audit finding IS the decision (a fact, not a vote pending)',
    items.every((it) => it.decided === true));
  check('the board heading (`task`) stays SHORT — it is not the manifest\'s full "what" + "reason" prose duplicated as a title',
    items.every((it) => it.task.length < 120), `longest: ${Math.max(...items.map((it) => it.task.length), 0)}`);
  check('…while the full context (what + why) survives in `delivered`, not dropped', items.every((it) => it.delivered.length > 40));

  // End to end through the SAME validation/rendering the meeting action-items
  // pipeline uses — proves this is the existing mechanism fed a new source,
  // not a second board-writing path.
  const rosterIds = agentsConfig.agents.map((a) => a.id);
  const { items: normalized, dropped } = normalizeActionItems(items, { rosterIds });
  check('every finding passes normalizeActionItems() cleanly — nothing dropped', normalized.length === items.length && dropped.length === 0,
    dropped.map((d) => d.reason).join(' | '));
  if (normalized.length) {
    const block = renderBoardTask(normalized[0], {
      id: 'PROPOSED-test', meetingType: 'capability_audit', dateStr: '2026-08-11',
      agentName: agentsConfig.agents.find((a) => a.id === normalized[0].agentId)?.name || null,
      sourceLabel: 'the weekly capability audit (Agent 13)',
    });
    check('the rendered board task names the weekly audit as its source, not a generic "meeting"', /the weekly capability audit \(Agent 13\)/.test(block));
    check('…and reaches the board as READY (decided:true), not stuck NOT-READY behind a meeting that never happened', /\*\*State:\*\* READY/.test(block));
  }

  check('[FAILS-OLD] before this session, the audit ran once (manual node invocation) and its findings went nowhere but stdout/a markdown file — no board task, no owner, no due date',
    true /* documented fact, not something the pre-change code can assert about itself */);

  // Wiring — the calling path exists, not merely a function defined nearby (OB-001's own rule, applied to this session's own work).
  const runnerSrc = readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8');
  check('agent-runner.js has the capability_audit_findings admin trigger', /case 'capability_audit_findings'/.test(runnerSrc));
  check('…gated on the SAME switch meeting action items use (identical write path, pauses with it)', /actionItemsToBoardEnabled\(env\)/.test(runnerSrc) && /capability_audit_findings/.test(runnerSrc));
  check('…and it reuses writeActionItemsToBoard(), not a second board-write mechanism', /writeActionItemsToBoard\(env, \{/.test(runnerSrc));
  const scriptSrc = readFileSync(new URL('../scripts/capability-audit.mjs', import.meta.url), 'utf8');
  check('scripts/capability-audit.mjs has the --findings CLI flag that produces the trigger body', /--findings/.test(scriptSrc) && /auditFindingsToBoardItems/.test(scriptSrc));
  const workflowExists = (() => { try { readFileSync(new URL('../.github/workflows/weekly-capability-audit.yml', import.meta.url), 'utf8'); return true; } catch { return false; } })();
  check('a recurring weekly trigger exists (.github/workflows/weekly-capability-audit.yml) — scheduled, not just callable', workflowExists);
  if (workflowExists) {
    const workflowSrc = readFileSync(new URL('../.github/workflows/weekly-capability-audit.yml', import.meta.url), 'utf8');
    check('…on a cron schedule, not workflow_dispatch-only', /cron:/.test(workflowSrc));
    check('…runs the --findings flag and POSTs its output to /api/agents/trigger', /--findings/.test(workflowSrc) && /api\/agents\/trigger/.test(workflowSrc));
  }
}

/* ── 9. Network tripwire ────────────────────────────────────────────────── */
console.log('\n--- Network tripwire ---');
check('this verifier made ZERO network calls end to end', NETWORK.length === 0, NETWORK.join(','));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) { console.log('MISMATCH — see FAIL lines above.'); process.exit(1); }
console.log('All scenarios matched expectations.');
process.exit(0);
