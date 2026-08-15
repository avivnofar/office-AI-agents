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
import { transcriptSpeakerIds, enforceAttendeeGate, checkAttribution, attributedAgentIds } from '../workers/meeting-attendance.js';

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

console.log(`\n  ${pass} passed, ${fail} failed  (${pass + fail} checks)`);
console.log(`  network calls attempted: ${NETWORK.length}`);
if (failures.length) { console.log('\n  Failures:'); for (const f of failures) console.log(`    - ${f}`); }
process.exit(fail === 0 && NETWORK.length === 0 ? 0 : 1);
