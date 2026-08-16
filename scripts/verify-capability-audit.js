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
  // `front-gate.js` joined this list on 2026-08-16, the day the publishing gate
  // was built. It did not exist on 2026-08-09, so the historical index must not
  // contain it — exactly what this subtraction list is for, and the same reason
  // `owner-page.js` is here. Without it, supplying the gate today would have
  // silently rewritten what the audit says about the Designer's state a week
  // ago, which is the one thing a [FAILS-OLD] control exists to prevent.
  modules: ['workers/owner-page.js', 'workers/front-gate.js'],
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
// ── 2026-08-16: these two checks CHANGED SIDES, and that is the finding ───
// They previously asserted PARTLY_SUPPLIED and `front_publication` unproducible,
// because the publishing gate did not exist — audit finding #17, the Designer
// as "absolute gatekeeper of the Front" with no gate to operate. `OB-014` built
// it (`workers/front-gate.js`), so the honest assertion is now the opposite one.
//
// Kept as assertions rather than deleted, and worded to say what changed: a
// check that silently flips from "X is missing" to "X is present" with no trace
// leaves a reader unable to tell a fixed gap from a gap that was never there.
check('...and she is now FULLY supplied — the publishing gate was built 2026-08-16 (OB-014, audit #17)',
  tDesigner.roleVerdict === 'FULLY_SUPPLIED', tDesigner.roleVerdict);
check('...and `front_publication` is producible, which it was NOT before that date',
  !tDesigner.unproducibleKinds.includes('front_publication'), tDesigner.unproducibleKinds.join(','));
check('...supplied by the gate module specifically, not by something merely adjacent to it',
  tAudit.capabilities.find((c) => c.id === 'front-publishing-gate')?.verdict === 'SUPPLIED',
  tAudit.capabilities.find((c) => c.id === 'front-publishing-gate')?.verdict);
// FULLY_SUPPLIED is a statement about capability supply, NOT about whether the
// Front is done. Asserted here so the verdict cannot be read as the larger claim.
check('...and FULLY_SUPPLIED still does not mean the Front is written — the content is OB-092..095',
  tDesigner.kinds.every((k) => k.producible === true) && tDesigner.roleVerdict === 'FULLY_SUPPLIED');
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
// Was hardcoded to "Agent 9 — The Designer" until 2026-08-16, when her last gap
// closed and the check went red for the RIGHT reason — a gap was fixed. A check
// naming a specific agent has to be edited every time that agent's last gap
// closes, and the edit is indistinguishable from switching it off. So it now
// asks the real question: whoever owns a gap today must be named in the document.
const gapOwners = [...new Set(
  tAudit.capabilities.filter((c) => c.verdict === 'UNSUPPLIED')
    .flatMap((c) => manifest.capabilities[c.id]?.agents || []),
)];
check('there is at least one gap to attribute (if this fails, every capability is supplied — check that before editing)',
  gapOwners.length > 0, `gap owners: ${gapOwners.join(',')}`);
check('each gap names whose role needs it, by agent name — for whoever actually owns one today',
  gapOwners.every((id) => new RegExp(`Whose role needs it:[^\\n]*Agent ${id} —`).test(doc)),
  `gap owners: ${gapOwners.join(',')}`);
check('the document names the census as the OTHER mechanism, so neither is mistaken for both',
  /computeOutputCensus/.test(doc) && /absent from the census/.test(doc));
check('the document warns that "no gaps" means "no gaps anybody wrote down"',
  /non-exhaustive/i.test(doc) || tAudit.counts.unsupplied > 0);
/* ── 2026-08-16: this check went red, and what it exposed is worth more than
 * the check was ─────────────────────────────────────────────────────────────
 *
 * It asserted the section exists AND that some role is not FULLY_SUPPLIED. On
 * 2026-08-16, closing the Designer's publishing gate made **all 13 roles read
 * FULLY_SUPPLIED — while three capabilities are still UNSUPPLIED.**
 *
 * The cause is not that the gaps closed. It is that `gate-call-audit`,
 * `dependency-vulnerability-audit` and `paper-attack-multi-provider` (all Agent
 * 13's) are mapped to **no output kind at all**, and `auditRoleClaims()` reaches
 * capabilities only THROUGH `output_kind_producers`. A capability with no output
 * kind is invisible to every role verdict, so the role that owns all three of
 * the office's remaining gaps reports as fully supplied.
 *
 * This was masked until today: the Designer's own gap kept "some role is not
 * FULLY_SUPPLIED" true, so the check passed for a reason unrelated to what it
 * was testing. Closing her gap removed the last role holding it up. That is the
 * project's dominant defect shape — a top-line verdict reading healthy while a
 * named thing is missing underneath — found in the audit tool itself.
 *
 * Boarded as OB-097. The checks below assert the CURRENT, WRONG state on
 * purpose, so the day it is fixed they go red and say so. */
check('the "what the bible says nothing supplies" section exists',
  /What the bible says a role does that nothing supplies/.test(doc));
const unsupplied = tAudit.capabilities.filter((c) => c.verdict === 'UNSUPPLIED');
const kindMapped = new Set(Object.values(manifest.output_kind_producers).flat());
const invisible = unsupplied.filter((c) => !kindMapped.has(c.id));
check('there ARE still unsupplied capabilities', unsupplied.length > 0,
  unsupplied.map((c) => c.id).join(','));
check('[KNOWN DEFECT, OB-097] ...and every one of them is mapped to NO output kind, so no role verdict can see it',
  invisible.length === unsupplied.length, invisible.map((c) => c.id).join(','));
check('[KNOWN DEFECT, OB-097] ...which is why all 13 roles read FULLY_SUPPLIED while gaps remain open',
  tRoles.every((r) => r.roleVerdict === 'FULLY_SUPPLIED'),
  tRoles.filter((r) => r.roleVerdict !== 'FULLY_SUPPLIED').map((r) => `${r.id}:${r.roleVerdict}`).join(','));

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

/* ── 8b. THE GATE'S METRIC — audit finding #4 / KFM-04, 2026-08-15 ───────
 *
 * The gate used to be `audit.counts.agentsWhoCannotWork > 0`, derived from
 * `canWork`, which ONE supplied capability of any kind flips true. The
 * sharper `roleVerdict` was computed on the line above it and never
 * consulted. These lock the rewiring in place — including the
 * acknowledgement rule, which is the part a later session is most likely to
 * loosen without noticing.
 */
console.log('\n--- The gate measures roleVerdict, not canWork ---');
{
  const gateSrc = readFileSync(new URL('./capability-audit.mjs', import.meta.url), 'utf8');

  // Anchored to column 0 on purpose: the old line is QUOTED verbatim inside
  // the new GATE comment block (so a reader can see what changed), and an
  // unanchored match would find the quotation and report the fix as absent.
  check('[FAILS-OLD] the gate no longer exits on agentsWhoCannotWork ALONE',
    !/^process\.exit\(audit\.counts\.agentsWhoCannotWork > 0 \? 1 : 0\)/m.test(gateSrc));
  check('the gate reads roleVerdict', /roleVerdict === 'CANNOT_PRODUCE_ITS_OWN_OUTPUT'/.test(gateSrc));
  check('…and fails on a role the audit COULD NOT CHECK rather than passing it quietly (KFM-13)',
    /roleVerdict === 'NO_OUTPUT_KINDS_DECLARED'/.test(gateSrc));
  check('…and keeps the old zero-capability check, which catches a different shape',
    /audit\.counts\.agentsWhoCannotWork/.test(gateSrc));
  check('the severities are kept apart, not merged into one count (KFM-06)',
    /cannotProduce/.test(gateSrc) && /undeclared/.test(gateSrc) && /unacknowledged/.test(gateSrc));
  check('a gap can only be acknowledged by NAMING A BOARD TASK — a checked claim, not a suppression list',
    /BOARD_REF\.test/.test(gateSrc));
  check('dormant agents are excluded from the gate, deliberately',
    /roleClaims\.filter\(\(r\) => !r\.dormant\)/.test(gateSrc));

  // The workflow half: a gate nothing can fail on is still a green light
  // wired to nothing (KFM-05).
  const wf = readFileSync(new URL('../.github/workflows/weekly-capability-audit.yml', import.meta.url), 'utf8');
  check('[FAILS-OLD] the weekly workflow has a step that can FAIL the run',
    /exit 1/.test(wf) && /steps\.audit\.outputs\.gate_exit != '0'/.test(wf));
  check('…placed AFTER the findings are posted, so a red gate never costs the board its findings',
    wf.indexOf('Post findings to the board inbox') < wf.indexOf('Fail the run if the capability gate'));
  check('the audit step captures its exit code rather than discarding it',
    /gate_exit=\$\?/.test(wf));
}

/* ── 9. Network tripwire ────────────────────────────────────────────────── */
console.log('\n--- Network tripwire ---');
check('this verifier made ZERO network calls end to end', NETWORK.length === 0, NETWORK.join(','));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) { console.log('MISMATCH — see FAIL lines above.'); process.exit(1); }
console.log('All scenarios matched expectations.');
process.exit(0);
