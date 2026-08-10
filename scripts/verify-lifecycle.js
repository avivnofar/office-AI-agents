#!/usr/bin/env node
/**
 * scripts/verify-lifecycle.js
 *
 * Dry-run verifier for the 2026-08-10 deliverable-lifecycle session:
 *   §1  the stages, the single forward exit, and the roster mirror
 *   §2  reviewer-set composition — QA+Architect always, CEO is not a reviewer
 *   §3  SILENCE IS NEVER APPROVAL — coverage refuses the quiet admin  [FAILS-OLD]
 *   §4  gaps — unclassified BLOCKS, and a binding gap cannot skip its vote
 *   §5  voting — CEO double vote, veto, abstention, and the refused tie
 *   §6  the exit — only the CEO, only on a recommendation  [FAILS-OLD]
 *   §7  shifts — a phase cannot complete over a suspended shift, and a
 *       resume reads yesterday's artifacts rather than restarting
 *   §8  the allowance — a refusal ends a shift and never escalates to paid
 *   §9  the board Stage: projection — parsed back, refused when unreadable,
 *       and rewritten unconditionally by the one tool that reconciles it
 *   §10 refusals — the character line is mandatory and cannot be back-filled
 *   §11 source-level assertions: no JSON import, no provider-layer import,
 *       no warehouse token anywhere in this feature
 *
 * NO NETWORK. globalThis.fetch is replaced with a tripwire that throws.
 *
 * Sections marked [FAILS-OLD] transcribe the PRE-CHANGE logic and assert
 * against it, so the table catches a real defect rather than describing a fix.
 * The "old" logic here is the LINE model the owner corrected: build → Architect
 * review → done, with no admin round, no meeting, no vote and no CEO.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

globalThis.fetch = () => {
  throw new Error('TRIPWIRE: verify-lifecycle.js made a network call. It must not.');
};

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n--- ${title} ---`); }

const L = await import('../workers/deliverable-lifecycle.js');
const officeContext = await import('../workers/office-context.js');
const agentsConfig = JSON.parse(read('config/agents-config.json'));

/* ═════════════════════ §1 stages and the single exit ═══════════════════ */
section('§1 stages, the single forward exit, the roster mirror');

check('there are exactly eight stages', L.STAGES.length === 8, L.STAGES.join(','));
check('the exit stage is CLIENT-READY', L.EXIT_STAGE === 'CLIENT-READY');
check('IN_FLIGHT excludes both terminals',
  !L.IN_FLIGHT_STAGES.includes('CLIENT-READY') && !L.IN_FLIGHT_STAGES.includes('WITHDRAWN'));
check('every stage has a holder — a stage nobody waits on cannot be reported',
  L.STAGES.every((s) => typeof L.STAGE_HOLDER[s] === 'string' && L.STAGE_HOLDER[s].length));

// The loop actually closes: IN-REVIEW -> GAPS-RAISED -> IN-DISCUSSION ->
// IMPROVING -> IN-REVIEW. Asserted as a walk, not as a claim in a comment.
const loop = ['IN-REVIEW', 'GAPS-RAISED', 'IN-DISCUSSION', 'IMPROVING', 'IN-REVIEW'];
let loopOk = true;
for (let i = 0; i < loop.length - 1; i += 1) {
  if (!L.legalMovesFrom(loop[i]).includes(loop[i + 1])) loopOk = false;
}
check('the review loop is a closed cycle in the transition table', loopOk);

// Exactly one transition reaches the exit, and it starts at AWAITING-APPROVAL.
const intoExit = L.STAGES.filter((s) => L.legalMovesFrom(s).includes('CLIENT-READY'));
check('exactly ONE stage can reach CLIENT-READY, and it is AWAITING-APPROVAL',
  intoExit.length === 1 && intoExit[0] === 'AWAITING-APPROVAL', intoExit.join(','));

// ADMIN_IDS must mirror the real roster's sudo/root/specialist tier. A roster
// change that left this list behind would silently shrink every reviewer set.
const realAdmins = agentsConfig.agents
  .filter((a) => ['sudo', 'root', 'specialist'].includes(a.clearance))
  .map((a) => a.id).sort((x, y) => x - y);
check('ADMIN_IDS mirrors agents-config.json\'s admin tier exactly',
  JSON.stringify(realAdmins) === JSON.stringify([...L.ADMIN_IDS]),
  `config=${realAdmins.join(',')} module=${[...L.ADMIN_IDS].join(',')}`);

/* ═══════════════════ §2 reviewer-set composition (OB-026) ═════════════ */
section('§2 reviewer set — QA+Architect always, the CEO is not a reviewer');

const setPlain = L.composeReviewerSet({ type: 'guide', touches: [] });
check('QA (6) and Architect (10) are on every set',
  setPlain.required.includes(6) && setPlain.required.includes(10), setPlain.required.join(','));
check('the CEO is the approver and appears in NEITHER review list',
  setPlain.approver === 11 && !setPlain.required.includes(11) && !setPlain.mayComment.includes(11));
check('the Workflow (12) is named as the composer',
  setPlain.composedBy === 12);

const setVisual = L.composeReviewerSet({ type: 'front-page', touches: [] });
check('a front page pulls in the Designer (9) from its TYPE floor, with no touches declared',
  setVisual.required.includes(9), setVisual.required.join(','));

const setCfg = L.composeReviewerSet({ type: 'config-change', touches: [] });
check('a config change pulls in both the IT Chief (5) and the Cyber Expert (13)',
  setCfg.required.includes(5) && setCfg.required.includes(13), setCfg.required.join(','));

const setBoth = L.composeReviewerSet({ type: 'warehouse-build', touches: ['visual'] });
check('declared touches ADD to the type floor rather than replacing it',
  setBoth.required.includes(5) && setBoth.required.includes(9), setBoth.required.join(','));

const setUnknown = L.composeReviewerSet({ type: 'warehouse-build', touches: ['security'] });
check('an unknown touches value is REPORTED, never silently dropped',
  setUnknown.warnings.some((w) => /unknown touches value/.test(w)), setUnknown.warnings.join('|'));
check('an unknown deliverable TYPE is reported too',
  L.composeReviewerSet({ type: 'poster' }).warnings.some((w) => /not in TYPE_TOUCHES/.test(w)));

// The two extremes MEETING-PROTOCOL.md §4.4 rules out, asserted rather than
// trusted: not everybody reviews everything, and it is not a fixed short chain.
check('the set is neither "all nine review" nor a fixed three-step chain',
  setPlain.required.length >= 2 && setPlain.required.length < 9 && setPlain.mayComment.length > 0,
  `required=${setPlain.required.length} mayComment=${setPlain.mayComment.length}`);

/* ══════════════ §3 silence is never approval  [FAILS-OLD] ═════════════ */
section('§3 coverage — SILENCE IS NEVER APPROVAL');

function recordWith(reviews, extra = {}) {
  const made = L.newRecord({ slug: 'fixture', type: 'warehouse-build' });
  return { ...made.record, stage: 'IN-REVIEW', reviews, ...extra };
}

const fullSet = L.composeReviewerSet({ type: 'warehouse-build' });
const everyRequired = fullSet.required.map((id) => ({ agent_id: id, round: 0, kind: 'review', verdict: 'accept' }));
const quietRest = []; // the mayComment admins say nothing at all

const quietRecord = recordWith([...everyRequired, ...quietRest]);
const quietCov = L.reviewerCoverage(quietRecord);
check('an admin who said NOTHING is counted MISSING, not as assent',
  !quietCov.satisfied && quietCov.missing.length === fullSet.mayComment.length,
  `missing=${quietCov.missing.length} mayComment=${fullSet.mayComment.length}`);
check('the refusal names silence explicitly, so a reader knows why it blocked',
  quietCov.missing.every((m) => /Silence is never approval/.test(m.why)));

// [FAILS-OLD] The line model: "the Architect reviewed it, we are done." A
// transcription of that rule, run against the same record.
const OLD_MODEL_approved = (rec) => (rec.reviews || []).some((r) => r.agent_id === 10 && r.verdict === 'accept');
check('[FAILS-OLD] the old line model APPROVES this record on the Architect alone',
  OLD_MODEL_approved(quietRecord) === true);
check('[FAILS-OLD] the new model REFUSES the identical record',
  L.canAdvance(quietRecord, 'AWAITING-APPROVAL', {}).ok === false);

const abstained = recordWith([
  ...everyRequired,
  ...fullSet.mayComment.map((id) => ({ agent_id: id, round: 0, kind: 'abstain' })),
]);
const abstCov = L.reviewerCoverage(abstained);
check('an EXPLICIT abstention satisfies coverage where silence did not',
  abstCov.satisfied === true, JSON.stringify(abstCov.missing));
check('the abstentions are recorded by name, not merged into a count',
  abstCov.abstained.length === fullSet.mayComment.length);

// A required admin who only comments has not reviewed.
const commentOnly = recordWith([
  ...fullSet.required.map((id) => (id === 6 ? { agent_id: id, round: 0, kind: 'comment' } : { agent_id: id, round: 0, kind: 'review', verdict: 'accept' })),
  ...fullSet.mayComment.map((id) => ({ agent_id: id, round: 0, kind: 'abstain' })),
]);
check('a REQUIRED admin who only commented does not satisfy his obligation',
  L.reviewerCoverage(commentOnly).missing.some((m) => m.agentId === 6));

// Round matching: a full round-0 review must not satisfy round 1.
const staleRound = { ...abstained, round: 1 };
check('reviews from an earlier round do NOT satisfy a later one',
  L.reviewerCoverage(staleRound).satisfied === false);

/* ═══════════════════════════ §4 gaps ══════════════════════════════════ */
section('§4 gaps — unclassified blocks, binding cannot skip its vote');

const gapRec = { ...abstained, stage: 'IN-DISCUSSION', gaps: [{ id: 'G1', title: 'the message box loses focus', class: 'routine' }] };
check('a routine gap is classed routine', L.gapClass(gapRec.gaps[0]) === 'routine');

const unclassRec = { ...abstained, stage: 'IN-DISCUSSION', gaps: [{ id: 'G1', title: 'no class stated' }] };
check('an unclassified gap reads UNCLASSIFIED, never a defaulted "routine"',
  L.gapClass(unclassRec.gaps[0]) === 'UNCLASSIFIED');
check('an unclassified gap is still OPEN — it is not dropped',
  L.openGaps(unclassRec).length === 1);
check('an unclassified gap BLOCKS the meeting from acting',
  L.canAdvance(unclassRec, 'IMPROVING', {}).ok === false
  && /carry no class/.test(L.canAdvance(unclassRec, 'IMPROVING', {}).reason));

const bindingRec = { ...abstained, stage: 'IN-DISCUSSION', gaps: [{ id: 'G1', title: 'changes what the client sees', class: 'binding' }] };
check('a binding gap with no vote blocks the improvement round',
  L.canAdvance(bindingRec, 'IMPROVING', {}).ok === false
  && /have not been voted on/.test(L.canAdvance(bindingRec, 'IMPROVING', {}).reason));

const votedRec = {
  ...bindingRec,
  votes: [{ id: 'V1', gap_ids: ['G1'], question: 'Do we change what the client sees?', date: '2026-08-10', votes: [{ agent_id: 11, choice: 'for' }, { agent_id: 6, choice: 'against' }] }],
};
check('once voted, the binding gap no longer blocks',
  L.canAdvance(votedRec, 'IMPROVING', {}).ok === true, L.canAdvance(votedRec, 'IMPROVING', {}).reason || '');

check('a resolved gap leaves the open set', L.openGaps({ gaps: [{ id: 'G1', status: 'resolved' }] }).length === 0);
check('a dismissed gap leaves the open set too', L.openGaps({ gaps: [{ id: 'G1', status: 'dismissed' }] }).length === 0);

/* ═══════════════════════════ §5 voting ════════════════════════════════ */
section('§5 voting — double vote, veto, abstention, refused tie');

// One CEO "for" against two admin "against" is 2–2, not 1–2. If the double
// vote were left to the caller, this vote and its report could disagree.
const t1 = L.tallyVote({ question: 'Ship it?', date: '2026-08-10', votes: [{ agent_id: 11, choice: 'for' }, { agent_id: 6, choice: 'against' }, { agent_id: 8, choice: 'against' }] });
check('the CEO\'s double vote is applied by the tally, not by the caller — 1 "for" weighs 2',
  t1.tally.for === 2 && t1.tally.against === 2, JSON.stringify(t1));

const t2 = L.tallyVote({ question: 'Ship it?', date: '2026-08-10', resolution: 'defer', votes: [{ agent_id: 11, choice: 'for' }, { agent_id: 6, choice: 'against' }, { agent_id: 8, choice: 'against' }] });
check('a tie WITH a recorded resolution is accepted and keeps the resolution',
  t2.ok && t2.outcome === 'tie' && t2.resolution === 'defer');
check('a tie WITHOUT a resolution is REFUSED — §4.3 requires the resolution recorded',
  t1.ok === false && /no recorded resolution/.test(t1.reason));

const t3 = L.tallyVote({ question: 'Ship it?', votes: [{ agent_id: 6, choice: 'for' }, { agent_id: 8, choice: 'for' }, { agent_id: 5, choice: 'abstain' }] });
check('abstentions are carried and counted toward neither side',
  t3.ok && t3.tally.for === 2 && t3.tally.against === 0 && t3.tally.abstained.length === 1);

const t4 = L.tallyVote({ question: 'Ship it?', veto_used: true, votes: [{ agent_id: 6, choice: 'for' }, { agent_id: 8, choice: 'for' }] });
check('a veto produces its OWN outcome — never a silent "rejected"',
  t4.ok && t4.outcome === 'vetoed' && t4.tally.for === 2,
  'the room voting for it and the CEO stopping it is the fact worth keeping');

const t5 = L.tallyVote({ question: 'Ship it?', votes: [{ agent_id: 3, choice: 'for' }] });
check('a NON-ADMIN vote is refused, not ignored — the tally must match the recorded table',
  t5.ok === false && /admins only/.test(t5.reason));

const t6 = L.tallyVote({ votes: [{ agent_id: 6, choice: 'for' }] });
check('a vote with no question is refused', t6.ok === false && /no question/.test(t6.reason));

const rendered = L.renderVote(
  { question: 'Ship it?', date: '2026-08-10', veto_used: false, votes: [{ agent_id: 11, choice: 'for' }, { agent_id: 6, choice: 'abstain' }] },
  t3, { names: { 11: 'The CEO', 6: 'The QA' } }
);
check('the rendered vote matches MEETING-PROTOCOL.md §4.3\'s table shape',
  /### Vote — Ship it\?/.test(rendered) && /\| Agent \| Vote \| Note \|/.test(rendered)
  && /\(×2, leads\)/.test(rendered) && /- \*\*Veto used:\*\* no/.test(rendered));
check('an abstention renders with the "not counted as assent" note by default',
  /recorded, not counted as assent/.test(rendered));

/* ══════════════ §6 the exit — only the CEO  [FAILS-OLD] ══════════════ */
section('§6 the exit — only the CEO, only on a recommendation');

const readyBase = {
  ...abstained,
  stage: 'AWAITING-APPROVAL',
  gaps: [],
  recommendation: { text: 'The office recommends this version be shown to the client.', by: 12, at: '2026-08-10' },
};

check('no approval at all → refused, and the refusal says why in the owner\'s words',
  L.canAdvance(readyBase, 'CLIENT-READY', {}).ok === false
  && /NOTHING REACHES THE CLIENT WITHOUT THE CEO/.test(L.canAdvance(readyBase, 'CLIENT-READY', {}).reason));

const architectApproved = { ...readyBase, approval: { by: 10, decision: 'approve', at: '2026-08-10' } };
check('[FAILS-OLD] the old line model treats the Architect\'s approval as the end',
  OLD_MODEL_approved({ reviews: [{ agent_id: 10, verdict: 'accept' }] }) === true);
check('[FAILS-OLD] the new model REFUSES the Architect standing in for the CEO',
  L.canAdvance(architectApproved, 'CLIENT-READY', {}).ok === false
  && /not by the CEO/.test(L.canAdvance(architectApproved, 'CLIENT-READY', {}).reason));

const noRec = { ...readyBase, recommendation: null, approval: { by: 11, decision: 'approve', at: '2026-08-10' } };
check('a CEO approval with NO recommendation behind it is refused',
  L.canAdvance(noRec, 'CLIENT-READY', {}).ok === false && /no recommendation/.test(L.canAdvance(noRec, 'CLIENT-READY', {}).reason));

const ceoApproved = { ...readyBase, approval: { by: 11, decision: 'approve', at: '2026-08-10' } };
check('the CEO\'s approval on a recommendation is the ONE way out',
  L.canAdvance(ceoApproved, 'CLIENT-READY', {}).ok === true, L.canAdvance(ceoApproved, 'CLIENT-READY', {}).reason || '');

const returned = { ...readyBase, approval: { by: 11, decision: 'return', reason: 'the activity feed is a snapshot and reads as live', at: '2026-08-10' } };
check('a returned deliverable goes back to the ROOM (IN-DISCUSSION), not to the builder',
  L.canAdvance(returned, 'IN-DISCUSSION', {}).ok === true);
check('a return with no stated reason is refused',
  L.canAdvance({ ...returned, approval: { by: 11, decision: 'return' } }, 'IN-DISCUSSION', {}).ok === false);

check('CLIENT-READY is terminal — an approval cannot be quietly reopened',
  L.canAdvance({ ...ceoApproved, stage: 'CLIENT-READY' }, 'IN-REVIEW', {}).code === 'terminal');
check('an invented stage name cannot reach the exit',
  L.canAdvance({ ...readyBase, stage: 'REVIEWED' }, 'CLIENT-READY', {}).code === 'unreadable_stage');
check('a withdrawal always needs a reason',
  L.canAdvance(readyBase, 'WITHDRAWN', {}).ok === false
  && L.canAdvance(readyBase, 'WITHDRAWN', { reason: 'superseded by the new site' }).ok === true);

/* ═══════════════ §7 shifts — a day-spanning unit of work ══════════════ */
section('§7 shifts — resume reads yesterday, and a partial never looks complete');

const phases = [{ id: 'scaffold' }, { id: 'interface' }];
const opened = L.openShift({ phase: 'interface', agentId: 4, at: '2026-08-10T14:00:00Z' });
check('a shift must name its phase', L.openShift({}).ok === false);
check('an opened shift starts OPEN with empty artifact lists',
  opened.ok && opened.shift.status === 'OPEN' && opened.shift.artifacts.length === 0);

const badSuspend = L.closeShift(opened.shift, { status: 'SUSPENDED', stoppedBecause: 'overtime_required' });
check('a SUSPENDED close with no `next` is REFUSED — without it the next shift restarts',
  badSuspend.ok === false && /where it stopped/.test(badSuspend.reason));

const badSuspend2 = L.closeShift(opened.shift, { status: 'SUSPENDED', next: 'write renderBlock' });
check('a SUSPENDED close with no reason is refused — an unexplained stop reads as a crash',
  badSuspend2.ok === false && /why it stopped/.test(badSuspend2.reason));

const suspended = L.closeShift(opened.shift, {
  status: 'SUSPENDED',
  stoppedBecause: 'overtime_required: cerebras at 600 calls against a 600 soft stop',
  next: 'renderBlock — the format is decided in LEDGER.md §2; nothing is written yet',
  done: ['extractCount', 'countResultLines'],
  artifacts: ['tasks/verifier-count-ledger/run-verifiers.js'],
  incompleteArtifacts: ['tasks/verifier-count-ledger/LEDGER.md'],
  at: '2026-08-10T16:00:00Z',
});
check('a well-formed SUSPENDED close is accepted', suspended.ok === true, suspended.reason || '');

const suspendedRec = { ...L.newRecord({ slug: 'verifier-count-ledger' }).record, shift: suspended.shift, build_completed: ['scaffold'] };

const brief = L.resumeBrief(suspendedRec);
check('the resume brief says DO NOT START OVER', /DO NOT START OVER/.test(brief));
check('the resume brief names the real files to READ, and calls them the state',
  /run-verifiers\.js/.test(brief) && /they are the state/.test(brief));
check('the resume brief names the HALF-WRITTEN file separately from the finished ones',
  /HALF-WRITTEN/.test(brief) && /LEDGER\.md/.test(brief));
check('the resume brief carries where it stopped, verbatim',
  /renderBlock/.test(brief) && /nothing is written yet/.test(brief));
check('a record with no suspended shift returns NO brief — "resume: nothing" must never print',
  L.resumeBrief({ shift: null }) === null && L.resumeBrief({ shift: { status: 'COMPLETED' } }) === null);

const completable = L.assertPhaseCompletable(suspendedRec, 'interface');
check('THE STRUCTURAL GATE: a phase cannot be marked complete over a SUSPENDED shift',
  completable.ok === false && /closed SUSPENDED/.test(completable.reason));
check('a phase with no shift at all cannot be marked complete either',
  L.assertPhaseCompletable({ shift: null }, 'interface').ok === false);

const cannotComplete = L.closeShift(opened.shift, { status: 'COMPLETED', incompleteArtifacts: ['half.md'] });
check('a shift cannot close COMPLETED while it knows one of its own files is half-written',
  cannotComplete.ok === false && /recorded incomplete/.test(cannotComplete.reason));

const done = L.closeShift(opened.shift, { status: 'COMPLETED', artifacts: ['a.js'], at: '2026-08-10T17:00:00Z' });
check('a clean COMPLETED close passes the gate',
  done.ok && L.assertPhaseCompletable({ shift: done.shift }, 'interface').ok === true);

// BUILDING -> IN-REVIEW must see the whole spec built AND no open shift.
const halfBuilt = { ...L.newRecord({ slug: 'x' }).record, build_completed: ['scaffold'] };
check('BUILDING → IN-REVIEW refuses while a spec phase is unbuilt',
  L.canAdvance(halfBuilt, 'IN-REVIEW', { phases }).ok === false
  && /are not built/.test(L.canAdvance(halfBuilt, 'IN-REVIEW', { phases }).reason));

const builtOverOpenShift = { ...L.newRecord({ slug: 'x' }).record, build_completed: ['scaffold', 'interface'], shift: suspended.shift };
check('BUILDING → IN-REVIEW refuses a phase list that LOOKS complete over a suspended shift',
  L.canAdvance(builtOverOpenShift, 'IN-REVIEW', { phases }).ok === false
  && /SUSPENDED/.test(L.canAdvance(builtOverOpenShift, 'IN-REVIEW', { phases }).reason));

const builtClean = { ...L.newRecord({ slug: 'x' }).record, build_completed: ['scaffold', 'interface'], shift: done.shift };
check('BUILDING → IN-REVIEW passes once every phase is built over closed shifts',
  L.canAdvance(builtClean, 'IN-REVIEW', { phases }).ok === true,
  L.canAdvance(builtClean, 'IN-REVIEW', { phases }).reason || '');
check('…and refuses when NO phase list was supplied at all',
  L.canAdvance({ ...builtClean }, 'IN-REVIEW', { phases: [] }).ok === false);

/* ════════════════ §8 the allowance — a shift end, never an escalation ═ */
section('§8 allowance — a refusal ends a shift and never escalates');

check('an allowed call proceeds', L.shiftAllowance({ allowed: true }).proceed === true);

const over = L.shiftAllowance({ allowed: false, reason: 'overtime_required', providerId: 'cerebras', callsToday: 600, cap: 1000, softStop: 600, capUnknown: false }, { phase: 'runner' });
check('overtime_required does NOT proceed', over.proceed === false);
check('the stop reason carries the real numbers, so tomorrow can read what happened',
  /600 calls against a 600 soft stop/.test(over.stopBecause));
check('the stop reason states there is no escalation to a paid tier',
  /NOT a reason to escalate to a paid tier/.test(over.stopBecause));
check('an unknown-cap pacing refusal is described as pacing, not as exhaustion',
  /wall-clock paced/.test(L.shiftAllowance({ allowed: false, reason: 'unknown_cap_paced', providerId: 'mistral', capUnknown: true }).stopBecause));

// The whole reframing, asserted: the refusal has no third branch.
const lifecycleSrc = read('workers/deliverable-lifecycle.js');
check('shiftAllowance has exactly two outcomes — proceed, or end the shift',
  !/paid[_ ]?tier\s*[:=]\s*true/i.test(lifecycleSrc) && /there is deliberately no third branch/i.test(lifecycleSrc));

/* ═════════════════ §9 the board Stage: projection ════════════════════ */
section('§9 the board Stage: line — parsed back, refused when unreadable');

const projRec = { ...builtClean, slug: 'office-site', stage: 'IN-REVIEW', round: 1 };
const line = L.renderStageLine(projRec);
check('the Stage line follows the board\'s `- **Field:** value` grammar',
  /^- \*\*Stage:\*\* /.test(line), line);
const back = L.parseStageValue(line.replace('- **Stage:** ', ''));
check('the line round-trips: stage, round and slug all read back',
  back.ok && back.stage === 'IN-REVIEW' && back.round === 1 && back.slug === 'office-site', JSON.stringify(back));
check('an unreadable Stage is REFUSED, not defaulted to BUILDING',
  L.parseStageValue('REVIEWED · round 1').ok === false);
check('an empty Stage is refused', L.parseStageValue('').ok === false);

// parseBoard must SEE it, and it must move no state count — the same rule
// Dispatched: and Offered: already keep.
const BOARD_FIXTURE = `# THE OFFICE BOARD

### OB-050 — Build the thing

- **Assignee:** Agent 4 — The Trainee
- **State:** IN-PROGRESS
- **Dispatched:** 2026-08-09 · held by the headless Architect run · deadline 2026-08-13
- **Stage:** IN-REVIEW · round 1 · waiting on the assigned reviewers · warehouse \`tasks/office-site/\`
- **Metric:** 2 office-days from dispatch · delivered = a thing
- **Blocked by:** nothing
- **Source:** owner
- **Task:** do it
- **Notes:** —
`;
const parsed = officeContext.parseBoard(BOARD_FIXTURE);
check('parseBoard() reads the Stage line', parsed.ok && parsed.tasks[0].stage === 'IN-REVIEW · round 1 · waiting on the assigned reviewers · warehouse `tasks/office-site/`', JSON.stringify(parsed.tasks[0]?.stage));
check('Stage moves NO state count — State: remains the one thing that decides what a task is',
  parsed.counts['IN-PROGRESS'] === 1 && parsed.counts.total === 1
  && !Object.keys(parsed.counts).includes('IN-REVIEW'));

// The reconciliation point: the one tool that writes the record rewrites the
// line unconditionally. A conditional rewrite would let a drift survive.
const cliSrc = read('scripts/lifecycle.mjs');
check('scripts/lifecycle.mjs rewrites the Stage line UNCONDITIONALLY on every run',
  /writeStageLine\(/.test(cliSrc) && /unconditional/i.test(cliSrc));
check('the CLI writes STATE.json and BOARD.md in the same run — one writer, one act',
  /STATE\.json/.test(cliSrc) && /BOARD\.md|boardPath/.test(cliSrc));

/* ═══════════ §10 refusals — the character line cannot be back-filled ═══ */
section('§10 refusals — one line, at the moment, with the character line');

const noLine = L.recordRefusal({ who: 'Agent 6 — The QA', declined: 'the round-1 build' });
check('a refusal with NO character line is refused',
  noLine.ok === false && /cannot be supplied later/i.test(noLine.reason));
check('the refusal-to-record says WHY it cannot be back-filled',
  /reads as evidence and is an invention/.test(noLine.reason));
check('a refusal with no `who` is refused', L.recordRefusal({ declined: 'x', characterLine: 'y' }).ok === false);
check('a refusal with no `declined` is refused', L.recordRefusal({ who: 'x', characterLine: 'y' }).ok === false);

const good = L.recordRefusal({
  who: 'Agent 6 — The QA',
  declined: 'the round-1 office-site build, on the activity feed reading as live when it is a snapshot',
  characterLine: 'She does not sign off on what she has not checked herself.',
  source: 'AGENTS-CHARACTER-CORE-v2.md, AGENT 6',
  at: '2026-08-10',
});
check('a complete refusal is accepted', good.ok === true, good.reason || '');
const oneLine = L.renderRefusal(good.refusal);
check('it renders in the owner\'s exact shape: refusal: <who> declined <what>, and the line of their character it came from',
  /^refusal: Agent 6 — The QA declined the round-1 office-site build/.test(oneLine)
  && /and the line of their character it came from: "She does not sign off/.test(oneLine), oneLine);

const newRec = L.newRecord({ slug: 'fixture' });
check('`refusals` exists from the record\'s FIRST moment — an array added later would have a birthday',
  Array.isArray(newRec.record.refusals) && newRec.record.refusals.length === 0);

const unrecorded = L.detectRefusals({
  round: 0,
  reviews: [{ agent_id: 6, round: 0, kind: 'review', verdict: 'reject' }],
  gaps: [{ id: 'G1', raised_by: 6 }],
  votes: [{ id: 'V1', question: 'Ship?', votes: [{ agent_id: 8, choice: 'against' }] }],
  approval: { by: 11, decision: 'return', at: '2026-08-10' },
  refusals: [],
});
check('detectRefusals finds all four unrecorded refusal moments',
  unrecorded.missing.length === 4, JSON.stringify(unrecorded.missing.map((m) => m.moment)));

// Caught on the FIRST real run: the QA's round-0 review of office-site raised
// eight gaps in one act, and the first cut reported eight unrecorded refusals
// against a review whose refusal line was recorded correctly. One review is one
// refusal — the owner's instruction is *each is one line*.
const oneAct = L.detectRefusals({
  round: 0,
  reviews: [{ agent_id: 6, round: 0, kind: 'review', verdict: 'revise' }],
  gaps: Array.from({ length: 8 }, (_, i) => ({ id: `G${i + 1}`, raised_by: 6 })),
  refusals: [{ moment: 'review_rejected:6:0', who: 'Agent 6 — The QA', declined: 'the round-0 build', character_line: 'He reports every bug he sees.' }],
});
check('one rejecting review covers its own gaps — 8 gaps do NOT become 8 unrecorded refusals',
  oneAct.missing.length === 0, JSON.stringify(oneAct.missing.map((m) => m.moment)));

// …but a gap raised with no review behind it is still its own moment. This is
// the Workflow flagging a missed metric line — a refusal nobody wrote up.
const loneGap = L.detectRefusals({ round: 0, gaps: [{ id: 'G9', raised_by: 12 }], refusals: [] });
check('a gap raised OUTSIDE a rejecting review is still its own unrecorded refusal',
  loneGap.missing.length === 1 && /outside any rejecting review/.test(loneGap.missing[0].what));
check('…and says they are NOT recoverable rather than offering to write them',
  /cannot be reconstructed/.test(unrecorded.note) && /do not write the line now/.test(unrecorded.note));
check('the four moments are named in the module so a caller cannot miss one',
  L.REFUSAL_MOMENTS.length === 4);

/* ══════════════════════ §11 source-level assertions ═══════════════════ */
section('§11 source — no JSON import, no provider layer, no warehouse token');

check('deliverable-lifecycle.js imports NO json (a verifier must be able to import it)',
  !/from\s+['"][^'"]+\.json['"]/.test(lifecycleSrc));
check('…and imports nothing at all — it is pure',
  !/^import\s/m.test(lifecycleSrc));
// The rule is about IMPORTS, not mentions: the module names task-router.js in
// prose precisely to explain why it does not import it, and a check that
// banned the word would push that explanation out of the file.
const importsOf = (src) => (src.match(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm) || []).join('|');
check('it does NOT import the provider layer (verify-providers.js\'s rule)',
  !/task-router|provider-common|cerebras-client|mistral-client|cohere-client/.test(importsOf(lifecycleSrc)));

// Same distinction, and it matters more here: both files NAME the warehouse
// token to record that it is deliberately unset. What must not exist is a READ
// of it. A check that banned the string would delete the only place the lock
// is written down.
const readsWarehouseToken = (src) => /(?:env|process\.env)\s*[.[]\s*['"]?WAREHOUSE_REPO_TOKEN/.test(src);
check('the lifecycle module never READS WAREHOUSE_REPO_TOKEN', !readsWarehouseToken(lifecycleSrc));
check('…nor does the CLI', !readsWarehouseToken(cliSrc));
check('…and both still SAY it is deliberately unset, so the lock is documented where it binds',
  /deliberately unset/.test(lifecycleSrc) && /deliberately unset/.test(cliSrc));
check('the module states, in the file, that the Worker cannot write the warehouse and must not be made able to',
  /MUST NOT BE MADE ABLE TO/.test(lifecycleSrc));

// nextAction() must answer for every in-flight stage. A stage with no next
// action is a deliverable the office cannot be told what to do with.
const stagesAnswered = L.IN_FLIGHT_STAGES.every((s) => {
  const na = L.nextAction({ ...readyBase, stage: s, gaps: [{ id: 'G1', class: 'routine' }] });
  return na.action !== 'unknown' && typeof na.say === 'string' && na.say.length > 0;
});
check('nextAction() answers for EVERY in-flight stage', stagesAnswered);

// The renderers must never emit a silent cap.
const flight = L.renderInFlight([projRec, { ...ceoApproved, slug: 'guide-x', stage: 'CLIENT-READY' }]);
check('renderInFlight counts in-flight and CLIENT-READY separately',
  flight.count === 1 && flight.readyCount === 1);
check('an empty in-flight list SAYS none rather than rendering nothing',
  /none\. No built deliverable/.test(L.renderInFlight([]).header));

// Nobody has responded at all — so the assignment list must contain BOTH
// kinds of obligation, which is the distinction the rendering exists to make.
const nobodyResponded = recordWith([]);
const assigns = L.renderReviewAssignments([nobodyResponded], { names: { 5: 'The IT Chief', 6: 'The QA' } });
check('review assignments are worded as ASSIGNMENTS, by name, not as a status list',
  /ASSIGN THIS REVIEW WORK NOW, by name/.test(assigns.header) && assigns.items.length > 0);
check('the assignment distinguishes a FULL REASONED REVIEW from a comment-or-abstain',
  assigns.items.some((i) => /FULL REASONED REVIEW/.test(i)) && assigns.items.some((i) => /explicit abstention/.test(i)));

const agenda = L.renderGapAgenda([{ ...unclassRec, slug: 'office-site', stage: 'GAPS-RAISED' }]);
check('an unclassified gap reaches the agenda demanding classification FIRST',
  /UNCLASSIFIED/.test(agenda.items[0]) && /skipped its vote/.test(agenda.items[0]));

// Non-convergence: a finding, never a stage and never a cap.
const conv = L.convergenceFinding({ slug: 'x', round: 3, round_history: [{ round: 1, open_gaps_at_close: 4 }, { round: 2, open_gaps_at_close: 5 }] });
check('non-convergence reports BOTH signals separately, never summed into a score',
  conv.concern && conv.signals.length === 2, JSON.stringify(conv.signals));
check('the finding says explicitly there is no cap on rounds',
  /there is no cap on rounds/.test(conv.say));
check('STALLED is not a stage — non-convergence changes nothing',
  !L.STAGES.includes('STALLED'));
check('a converging deliverable raises no concern',
  L.convergenceFinding({ round: 2, round_history: [{ round: 1, open_gaps_at_close: 5 }, { round: 2, open_gaps_at_close: 2 }] }).concern === false);

// applyTransition must leave the audit trail convergenceFinding() reads.
const improving = L.applyTransition({ ...votedRec, round: 0 }, 'IMPROVING', { at: '2026-08-10' });
check('entering IMPROVING records the round\'s open-gap count, which is what non-convergence reads',
  improving.round_history.length === 1 && improving.round_history[0].open_gaps_at_close === 1);
const backToReview = L.applyTransition(improving, 'IN-REVIEW', { at: '2026-08-11' });
check('IMPROVING → IN-REVIEW increments the round', backToReview.round === 1);
check('every transition leaves an audit row', backToReview.transitions.length === 2);

/* ═══════ §12 the wiring — meetings, agent prompts, reports, midnight run ═ */
section('§12 wiring — the office can actually see a deliverable in flight');

// Nobody has responded yet — so the assignment list below carries BOTH kinds of
// obligation. A fixture where the required admins have already reviewed renders
// only the comment-or-abstain rows and makes the distinction check pass for the
// wrong reason; that is how this line came to be written twice.
const IN_FLIGHT_FIXTURE = L.renderInFlightFile([
  { ...nobodyResponded, slug: 'office-site', board_task: 'OB-043', stage: 'IN-REVIEW', round: 0,
    gaps: [{ id: 'G8', class: 'binding', raised_by: 6, title: 'the page renders an error into one section and leaves the rest blank' }],
    refusals: [{ who: 'Agent 6 — The QA', declined: 'the round-0 build', character_line: 'He reports every bug he sees.' }] },
], { at: '2026-08-10' });

const round = L.parseInFlight(IN_FLIGHT_FIXTURE);
check('the digest round-trips through its own parser', round.ok && round.records.length === 1, round.reason || '');
check('…carrying the stage, round, board task and who still owes a review',
  round.records[0].stage === 'IN-REVIEW' && round.records[0].board_task === 'OB-043' && round.records[0].owed_by.length > 0);
check('…and the gaps themselves, not just a count — a meeting handed a count cannot decide anything',
  round.records[0].gaps.length === 1 && /renders an error/.test(round.records[0].gaps[0]));
check('…and the refusals, with their character lines',
  round.records[0].refusals.length === 1 && /He reports every bug he sees/.test(round.records[0].refusals[0]));
check('an UNREADABLE Stage in the digest is refused, not defaulted',
  L.parseInFlight('## x — OB-001\n\n- **Stage:** REVIEWED\n').ok === false);
check('an EMPTY digest is a legitimate healthy state, not a parse failure',
  L.parseInFlight('# DELIVERABLES IN FLIGHT\n\nNo deliverable is currently in the review loop.\n').ok === true);
check('a CLIENT-READY deliverable DISAPPEARS from the digest rather than lingering as in flight',
  !/## guide-x/.test(L.renderInFlightFile([{ ...ceoApproved, slug: 'guide-x', stage: 'CLIENT-READY' }])));

// The three prompt blocks, built from the parsed digest the Worker actually has.
const built = L.inFlightSections(round.records, { names: { 6: 'The QA' } });
check('the office-context sections carry the in-flight list', /DELIVERABLES IN FLIGHT — 1/.test(built.flight.header));
check('…and the review assignment, worded as an assignment', /ASSIGN THIS REVIEW WORK NOW, by name/.test(built.assignments.header));
check('…which distinguishes a required full review from a comment-or-abstain',
  built.assignments.items.some((i) => /FULL REASONED REVIEW/.test(i)) && built.assignments.items.some((i) => /explicit abstention/.test(i)));
check('a deliverable at IN-REVIEW produces NO gap agenda — gaps reach a meeting at GAPS-RAISED, not before',
  built.agenda === null);
const gapsRaised = L.parseInFlight(IN_FLIGHT_FIXTURE.replace('- **Stage:** IN-REVIEW', '- **Stage:** GAPS-RAISED'));
const built2 = L.inFlightSections(gapsRaised.records);
check('…and at GAPS-RAISED the gaps DO reach the agenda, with the vote demand attached',
  /GAPS RAISED IN REVIEW/.test(built2.agenda.header) && built2.agenda.items.some((i) => /RECORDED VOTE/.test(i)));

// office-context.js
const ocSrc = read('workers/office-context.js');
check('office-context.js fetches the digest', /campus\/shared\/lifecycle\/IN-FLIGHT\.md/.test(ocSrc));
check('…treats a 404 on it as the healthy empty state, like the questions channel',
  /lifecycleFile\.reason/.test(ocSrc) && /HTTP 404/.test(ocSrc));
check('…renders the three sections at `status` priority, above task titles',
  /label: 'deliverables'/.test(ocSrc) && /label: 'review-work'/.test(ocSrc) && /label: 'gap-agenda'/.test(ocSrc));
check('…and says "none" out loud rather than rendering nothing when the loop is empty',
  /DELIVERABLES IN FLIGHT — none/.test(ocSrc));
check('an agent\'s OWN outstanding review rides at headline priority, so the 400-token shape cannot drop it',
  /label: 'own-review'/.test(ocSrc) && /priority: PRIORITY\.headline/.test(ocSrc.split("label: 'own-review'")[1].slice(0, 200)));
check('…and tells the agent that his silence is recorded as an obligation, not read as approval',
  /your silence will never be read as approval/.test(ocSrc));
check('the digest\'s malformed entries join the SAME log line the board\'s and the questions\' do',
  /snapshot\?\.lifecycle\?\.malformed/.test(ocSrc));

// meeting-engine.js
const meSrc = read('workers/meeting-engine.js');
check('the standing agenda gained a DELIVERABLES item, and VOTES is still last',
  /6\. DELIVERABLES IN FLIGHT/.test(meSrc) && /7\. VOTES/.test(meSrc));
check('the agenda says a gap becomes a DECISION in the meeting, not a message to the builder',
  /it does not go back to whoever built it in a private message/.test(meSrc));
check('the agenda names non-convergence a FINDING and repeats that there is no cap on rounds',
  /a FINDING to discuss/.test(meSrc) && /no cap on review rounds/.test(meSrc));
check('the MORNING standup assigns review work by name, not only build work',
  /HE ALSO ASSIGNS REVIEW WORK/.test(meSrc));
check('the meeting passes real agent NAMES, so an assignment is made to a person and not a number',
  /agentNames: Object\.fromEntries/.test(meSrc));

// report-pipeline.js
const rpSrc = read('workers/report-pipeline.js');
check('the fact pack has a deliverables-in-flight section',
  /4a-bis\. DELIVERABLES IN FLIGHT/.test(rpSrc));
check('…which says what is AWAITING A VOTE, the thing the owner asked the weekly report to be able to say',
  /AWAITING A VOTE/.test(rpSrc));
check('…and keeps ABSENT and EMPTY apart — the §7.6 rule this pipeline exists for',
  /is a REAL measurement, not an absent one/.test(rpSrc) && /UNREADABLE — the deliverable-lifecycle digest/.test(rpSrc));
check('agent-runner passes the lifecycle snapshot through to the fact pack',
  /lifecycle,/.test(read('workers/agent-runner.js')));

// the midnight run
const rcSrc = readFileSync(path.join(root, '..', 'back-office-AI-agents', 'campus', 'agents', '10-the-architect', 'automation', 'run-controller.js'), 'utf8');
check('the midnight run\'s decide() no longer answers a build-complete deliverable with NOTHING',
  /action: 'LIFECYCLE'/.test(rcSrc));
check('…and resumes a suspended shift instead of rebuilding the phase',
  /action: 'RESUME'/.test(rcSrc));
check('…while holding NO lifecycle logic of its own — it points at the tool that has it',
  /lifecycle\.mjs status/.test(rcSrc) && !/AWAITING-APPROVAL|reviewerCoverage|tallyVote/.test(rcSrc));
check('the midnight run claims work through the SAME hold token the office uses, so the two cannot double-hold',
  /Dispatched/.test(readFileSync(path.join(root, '..', 'back-office-AI-agents', 'campus', 'agents', '10-the-architect', 'automation', 'dispatch.js'), 'utf8')));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
process.exit(0);
