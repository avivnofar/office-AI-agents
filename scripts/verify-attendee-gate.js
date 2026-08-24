#!/usr/bin/env node
/**
 * verify-attendee-gate — the meeting attendee gate (audit 2026-08-15, #1).
 *
 * Proves the gate refuses fabricated participation WITHOUT breaking the
 * second hop MEETING-PROTOCOL.md:352-356 explicitly permits. Those two are
 * the whole design; a gate that gets either wrong is worse than none.
 *
 * No network, no D1, no KV. Run: node scripts/verify-attendee-gate.js
 */
import { readFileSync } from 'node:fs';
import { transcriptSpeakerIds, enforceAttendeeGate, checkAttribution, attributedAgentIds, GATED_EFFECT_FIELDS } from '../workers/meeting-attendance.js';

// The REAL roster, read as data. meeting-attendance.js imports nothing so it
// can be executed by this verifier rather than regexed; the roster is the
// caller's job, and using the real one keeps the name-matching checks honest.
const ROSTER = JSON.parse(readFileSync(new URL('../config/agents-config.json', import.meta.url), 'utf8')).agents;

const NETWORK = [];
globalThis.fetch = (...a) => { NETWORK.push(a[0]); throw new Error('verify-attendee-gate made a network call'); };

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);

/* ── §1  Speaker extraction, against the real emitted forms ─────────────── */
section('§1  Speaker labels are recognised in the forms the models actually emit');

// Every line below is copied in shape from a real affected transcript.
const realish = `
**Agent 5 — The IT Chief**: Morning. Two things stuck.
**Agent 13 — The Cyber Expert**: I've been reviewing the meeting pipeline's inbox proposals. I'll take on OB-035, OB-047.
**Agent 11 (not mentioned)**: I encountered conflict in the link between OB-001 and OB-013.
**The Team Lead**: Noted.
Agent 9 — The Designer: I didn't feel like I had enough context.
`;
const spk = transcriptSpeakerIds(realish, ROSTER);
check('`**Agent N — Name**:` is recognised', spk.has(5) && spk.has(13), [...spk].join(','));
check('the invented `**Agent 11 (not mentioned)**:` label is recognised', spk.has(11));
check('a bare `**Name**:` label resolves via agents-config', spk.has(7), [...spk].join(','));
check('an unbolded `Agent N — Name:` label is recognised', spk.has(9));
check('nothing else is invented as a speaker', [...spk].sort((a, b) => a - b).join(',') === '5,7,9,11,13', [...spk].join(','));

check('prose containing a colon is not read as a speaker line',
  !transcriptSpeakerIds('The board has 74 tasks: 46 are READY.', ROSTER).has(74));

/* ── §2  The refusal ────────────────────────────────────────────────────── */
section('§2  Fabricated participation is detected and its action items refused');

const standup = {
  transcript: `**Agent 5 — The IT Chief**: Morning.\n**Agent 13 — The Cyber Expert**: I'll take OB-035.`,
  decisions: {
    action_items: [
      { agent_id: 5, task: 'chase the pull cap' },
      { agent_id: 13, task: 'run the security review of the owner channel' },
    ],
  },
};
const g = enforceAttendeeGate(standup.transcript, standup.decisions, [5, 7, 12], ROSTER);
check('[FAILS-OLD] a speaker who is not an attendee is detected',
  g.fabricated.join(',') === '13', g.fabricated.join(','));
check('[FAILS-OLD] an action item assigned to that fabricated speaker is refused',
  g.removed.length === 1 && g.removed[0].agent_id === 13);
check('[new] the genuine attendee\'s action item survives',
  g.kept.length === 1 && g.kept[0].agent_id === 5);

/* ── §3  The second hop the protocol PERMITS must not be broken ─────────── */
section('§3  MEETING-PROTOCOL.md:352-356 — work may reach someone who was not in the room');

const secondHop = enforceAttendeeGate(
  `**Agent 7 — The Team Lead**: I'll pass the localisation work to the Designer.`,
  { action_items: [{ agent_id: 9, task: 'localise the front' }] },
  [5, 7, 12], ROSTER,
);
check('a non-attendee who NEVER SPOKE keeps their assigned item (the legitimate second hop)',
  secondHop.removed.length === 0 && secondHop.kept.length === 1,
  `removed=${secondHop.removed.length}`);
check('...and no fabrication is reported for that meeting',
  secondHop.fabricated.length === 0, secondHop.fabricated.join(','));

// The discriminator, stated as a test: speech, not assignment.
const spokeAndAssigned = enforceAttendeeGate(
  `**Agent 9 — The Designer**: Happy to revisit them and add examples.`,
  { action_items: [{ agent_id: 9, task: 'include code examples' }] },
  [6, 7, 12], ROSTER,
);
check('[FAILS-OLD] the same assignee IS refused when the transcript gave them speaking lines',
  spokeAndAssigned.removed.length === 1 && spokeAndAssigned.fabricated.join(',') === '9');

/* ── §4  A clean meeting is untouched ───────────────────────────────────── */
section('§4  A clean meeting passes through unchanged');

const clean = enforceAttendeeGate(
  `**Agent 6 — The QA**: Two guides reviewed.\n**Agent 7 — The Team Lead**: Good.`,
  { action_items: [{ agent_id: 6, task: 'file the review' }] },
  [6, 7, 12], ROSTER,
);
check('no fabricated speakers', clean.fabricated.length === 0);
check('no action item is refused', clean.removed.length === 0 && clean.kept.length === 1);

/* ── §5  Degenerate input ───────────────────────────────────────────────── */
section('§5  Degenerate input does not throw or invent a refusal');

for (const [label, t, d] of [
  ['empty transcript', '', {}],
  ['null transcript', null, { action_items: [] }],
  ['no action_items key', '**Agent 6 — The QA**: hi', {}],
  ['action_items not an array', '**Agent 6 — The QA**: hi', { action_items: 'nope' }],
]) {
  let ok = true;
  try { const r = enforceAttendeeGate(t, d, [6, 7], ROSTER); ok = Array.isArray(r.kept) && Array.isArray(r.removed); }
  catch { ok = false; }
  check(`${label} is handled without throwing`, ok);
}

/* ── §6  The primitive the four OB-075 gates share ──────────────────────── */
section('§6  checkAttribution() — the one mechanism, and its two populations');

check('a named agent on the declared list passes',
  checkAttribution([6], [6, 7], ROSTER).ok);
check('a named agent NOT on the declared list is a nonParticipant, not an unknown',
  checkAttribution([9], [6, 7], ROSTER).nonParticipants.join(',') === '9'
  && checkAttribution([9], [6, 7], ROSTER).unknown.length === 0);
check('an id that is on no roster is an UNKNOWN — a different fact with a different remedy',
  checkAttribution([99], [6, 7], ROSTER).unknown.join(',') === '99'
  && checkAttribution([99], [6, 7], ROSTER).nonParticipants.length === 0);
check('an unknown id is never double-counted as a nonParticipant',
  checkAttribution([99, 9], [6], ROSTER).unknown.length + checkAttribution([99, 9], [6], ROSTER).nonParticipants.length === 2);
check('KFM-13: an empty roster reports rosterChecked:false rather than a clean existence check',
  checkAttribution([99], [6], []).rosterChecked === false && checkAttribution([99], [6], []).unknown.length === 0);
check('…and still refuses on the participation half, so an absent roster never opens the gate',
  !checkAttribution([99], [6], []).ok);
check('duplicate names collapse — one agent named twice is one finding',
  checkAttribution([9, 9, 9], [6], ROSTER).nonParticipants.join(',') === '9');
check('degenerate input returns a clean pass rather than throwing',
  checkAttribution(null, null, null).ok === true);

section('§7  attributedAgentIds() — prose that names an agent, and prose that does not');
check('"supervised lifecycle session" claims no agent — the honest form must stay legal',
  attributedAgentIds('supervised lifecycle session', ROSTER).length === 0);
check('the live record form "10 (Architect, this session)" is read as a claim about Agent 10',
  attributedAgentIds('10 (Architect, this session)', ROSTER).join(',') === '10');
check('"Agent 6 — The QA" is read once, not twice, despite id and name both matching',
  attributedAgentIds('Agent 6 — The QA', ROSTER).join(',') === '6');
check('a bare persona name resolves through the roster',
  attributedAgentIds('handled by The Designer', ROSTER).join(',') === '9');
check('empty and null claim nothing',
  attributedAgentIds('', ROSTER).length === 0 && attributedAgentIds(null, ROSTER).length === 0);

section('§8  ONE mechanism — the meeting gate is not a second copy of it');
const gateSrc = readFileSync(new URL('../workers/meeting-attendance.js', import.meta.url), 'utf8');
check('enforceAttendeeGate() delegates to checkAttribution() rather than re-deriving the set',
  /export function enforceAttendeeGate[\s\S]{0,700}?checkAttribution\(/.test(gateSrc));
check('…and no longer carries its own `filter((id) => !attendees.has(id))` copy of the rule',
  !/attendees\.has\(id\)/.test(gateSrc));
check('the module still imports nothing, so every gate above is EXECUTED by this file, not regexed',
  !/^import\s/m.test(gateSrc));

/* ── §9  THE FIVE QUIET FIELDS, against the real meeting row ────────────── */
section('§9  The five unguarded effect fields (2026-08-24) — live meeting 5ee1f725');

/*
 * Not a constructed example. `decisions` below is copied verbatim from D1:
 *
 *   SELECT decisions FROM meetings
 *    WHERE id = '5ee1f725-4bc4-4be8-8b69-606c39f54957';
 *
 * A closing_qa_review held 2026-08-24 12:31:27 UTC. Attendees [6,7,12].
 * Agent 13 was given speaking lines and was not there. The stored row's own
 * `fabricated_participation` proves the gate SAW this at composition time and
 * refused the action item — and the same row carries a mood delta, a state
 * change and a character-file amendment for Agent 13 that were all applied.
 *
 * Four such applications reached production (2026-08-19, -21, -23, -24). This
 * section is the reason a fifth does not.
 */
const liveDecisions = {
  summary: 'Closing QA Review',
  mood_effects: [
    { agent_id: 6, delta: 10, reason: 'productive team interaction' },
    { agent_id: 13, delta: 10, reason: 'positive feedback' },
    { agent_id: 7, delta: 5, reason: 'happy team interaction' },
  ],
  irritation_effects: [],
  state_changes: [
    { agent_id: 6, field: 'isHappy', value: true, reason: 'good team interaction' },
    { agent_id: 13, field: 'isComplacent', value: false, reason: 'positive feedback' },
  ],
  action_items: [],
  context_amendments: [
    { agent_id: 13, aspect: 'communication skills', content: 'When flagging findings, be sure to suggest specific actions to prevent future code divergence', proposed_by: 6 },
  ],
  config_overrides: [],
  suggestion_decisions: [],
  refusals: [],
};
const liveTranscript = [
  '**Agent 6 — The QA**: Reviewing the closing quality picture for today.',
  '**Agent 7 — The Team Lead**: Worker model looks steady.',
  '**Agent 12 — The Workflow**: Board is drained.',
  '**Agent 13 — The Cyber Expert**: I flagged the divergence before it hit live.',
].join('\n');

const live = enforceAttendeeGate(liveTranscript, liveDecisions, [6, 7, 12], ROSTER);

check('the live row’s fabricated set is exactly [13], as the stored row itself recorded',
  live.fabricated.join(',') === '13', live.fabricated.join(','));
check('[FAILS-OLD] exactly three effects are refused — mood, state and the character amendment',
  live.removedEffects.length === 3, String(live.removedEffects.length));
check('[FAILS-OLD] the mood_effects +10 for Agent 13 is refused',
  live.removedEffects.some((r) => r.field === 'mood_effects' && r.refused_for.includes(13)));
check('[FAILS-OLD] the state_changes {isComplacent:false} for Agent 13 is refused',
  live.removedEffects.some((r) => r.field === 'state_changes' && r.refused_for.includes(13)));
check('[FAILS-OLD] the context_amendments proposal against Agent 13’s character file is refused',
  live.removedEffects.some((r) => r.field === 'context_amendments' && r.refused_for.includes(13)));

// THE WIDTH CHECK. A gate that refuses an attending agent is a worse defect
// than the one being fixed: it would silently drop real meeting outcomes.
const liveKeptIds = GATED_EFFECT_FIELDS.flatMap((f) => live.keptEffects[f].map((e) => Number(e.agent_id)));
check('GATE WIDTH: no attending agent (6, 7, 12) had anything refused',
  live.removedEffects.every((r) => !r.refused_for.some((id) => [6, 7, 12].includes(id))));
check('both attending mood effects (6 and 7) pass unchanged',
  live.keptEffects.mood_effects.length === 2
  && live.keptEffects.mood_effects.every((e) => [6, 7].includes(e.agent_id)));
check('the attending state change (6) passes unchanged',
  live.keptEffects.state_changes.length === 1 && live.keptEffects.state_changes[0].agent_id === 6);
check('Agent 13 appears nowhere in what is kept',
  !liveKeptIds.includes(13) && liveKeptIds.every((id) => [6, 7, 12].includes(id)), liveKeptIds.join(','));

// A3 — a blocked effect is RECORDED, not dropped. Silently discarding it is
// the same defect inverted, and A15 requires the correction to be visible.
check('every refusal carries its field, the ids it was refused for, and the whole entry',
  live.removedEffects.every((r) => typeof r.field === 'string'
    && Array.isArray(r.refused_for) && r.refused_for.length
    && r.entry && typeof r.entry === 'object'));
check('the refused entries are the real ones, not summaries — the amendment text survives intact',
  live.removedEffects.find((r) => r.field === 'context_amendments')
    ?.entry.content.startsWith('When flagging findings'));

/* The second hop must still work for effects, exactly as it does for action
 * items: the discriminator is SPEECH. An effect naming an agent who never
 * spoke is not fabrication and must pass. */
const secondHopEffects = enforceAttendeeGate(
  '**Agent 5 — The IT Chief**: Morning.',
  { mood_effects: [{ agent_id: 9, delta: 5 }], state_changes: [], irritation_effects: [], config_overrides: [], context_amendments: [] },
  [5, 7],
  ROSTER,
);
check('an effect for a non-attendee who never spoke is NOT refused — the second hop survives',
  secondHopEffects.removedEffects.length === 0 && secondHopEffects.keptEffects.mood_effects.length === 1);

// A context amendment names TWO agents. A proposal attributed to a fabricated
// proposer is fabricated however real its target is.
const fabProposer = enforceAttendeeGate(
  '**Agent 6 — The QA**: fine.\n**Agent 8 — The Lead QA**: I propose an amendment for Agent 4.',
  { context_amendments: [{ agent_id: 4, aspect: 'tone', content: 'x', proposed_by: 8 }] },
  [6, 7],
  ROSTER,
);
check('an amendment PROPOSED BY a fabricated speaker is refused, though its target is fine',
  fabProposer.removedEffects.length === 1
  && fabProposer.removedEffects[0].refused_for.join(',') === '8');

check('degenerate decisions do not throw or invent an effect refusal',
  (() => {
    try {
      const r = enforceAttendeeGate('x', null, [1], ROSTER);
      const r2 = enforceAttendeeGate('x', { mood_effects: 'not an array' }, [1], ROSTER);
      return r.removedEffects.length === 0 && r2.removedEffects.length === 0
        && GATED_EFFECT_FIELDS.every((f) => Array.isArray(r.keptEffects[f]));
    } catch { return false; }
  })());

/* The call site is the half that acts. Source-checked because meeting-engine.js
 * imports config JSON and cannot be loaded by plain node (this file's header). */
const engineSrc = readFileSync(new URL('../workers/meeting-engine.js', import.meta.url), 'utf8');
check('[FAILS-OLD] meeting-engine.js assigns the gate’s kept effects back onto decisions',
  /for \(const field of GATED_EFFECT_FIELDS\)[\s\S]{0,200}?decisions\[field\] = gate\.keptEffects\[field\]/.test(engineSrc));
check('[FAILS-OLD] refused effects are carried on the record beside refused_action_items',
  /refused_action_items: gate\.removed,[\s\S]{0,120}?refused_effects: gate\.removedEffects,/.test(engineSrc));
check('the refused effects are rendered into the meeting report, not only stored',
  /refusedEffectsList/.test(engineSrc) && /## Refused Effects \(fabricated participation\)/.test(engineSrc));
check('applyMeetingEffects() was NOT given a second, parallel attendance check',
  !/applyMeetingEffects[\s\S]*?fabricatedSet/.test(engineSrc));

console.log(`\n  ${pass} passed, ${fail} failed  (${pass + fail} checks)`);
console.log(`  network calls attempted: ${NETWORK.length}`);
if (failures.length) { console.log('\n  Failures:'); for (const f of failures) console.log(`    - ${f}`); }
process.exit(fail === 0 && NETWORK.length === 0 ? 0 : 1);
