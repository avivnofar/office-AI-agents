/**
 * workers/deliverable-lifecycle.js — what happens to a deliverable AFTER it is
 * built, and how it survives the day it was not finished in.
 *
 * Written 2026-08-10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-09 the board was dispatched from for the first time: OB-018 moved
 * READY → IN-PROGRESS and `dispatch.js applyToBoard()` wrote a `Dispatched:`
 * line naming a holder. Dispatch works.
 *
 * NOTHING THEN DOES THE WORK, AND NOTHING AT ALL HAPPENS AFTER IT.
 * `run-controller.js decide()` walks the warehouse task's `## Phases` list,
 * builds the next incomplete phase, and when the last one lands it returns
 * `{action:'NOTHING', reason:'every task with a valid spec is complete'}`.
 * That sentence is this module's whole reason to exist. `tasks/office-site/`
 * has carried `completed: [scaffold, interface, delivery, depth]` since
 * 2026-08-07 — four phases, four build records, a real client-facing artifact
 * against REQ-003 — and no admin has ever reviewed it, no meeting has ever
 * discussed it, no vote has ever bound anything about it, and the CEO has
 * never approved it. It is finished and it is nowhere.
 *
 * The model that was in the code was a LINE: worker builds → Architect reviews
 * → done. The owner's correction, 2026-08-10, is that the Architect is not the
 * end of the story:
 *
 *   > After him the office continues. Morning meetings also assign tasks to
 *   > review the standing projects; admins get tasks to check the deliverables,
 *   > raise gaps in meetings, discuss them and vote if needed, and the
 *   > Architect — and the Designer, the QA, other admins when needed — go over
 *   > the product again and keep improving it until the office reaches a
 *   > version it feels can be shown to the client. This does not happen after
 *   > one build. There is a whole development and quality-control process. It
 *   > cannot be fire-and-forget.
 *
 * So the shape is a LOOP WITH AN EXIT CONDITION, and the exit is a person:
 * the CEO approves the final version after a recommendation. He already holds
 * a veto and a double vote in the bible, so making him the exit is consistent
 * with what is written rather than a new power.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE STAGES, AND WHY THESE NAMES
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   BUILDING          the spec's phases are being built
 *   IN-REVIEW         admins hold assigned review tasks against it
 *   GAPS-RAISED       reviews are in and at least one gap was raised
 *   IN-DISCUSSION     a meeting has the gaps on its agenda
 *   IMPROVING         an improvement round is assigned back to the builder
 *   AWAITING-APPROVAL no open gaps, a recommendation exists, the CEO has not
 *                     yet answered
 *   CLIENT-READY      the CEO approved. THE ONE FORWARD EXIT.
 *   WITHDRAWN         killed. The one sideways exit.
 *
 * The loop is IN-REVIEW → GAPS-RAISED → IN-DISCUSSION → IMPROVING → IN-REVIEW.
 * It is a cycle on purpose and it has NO ROUND CAP (owner-stated). A cap would
 * be a rule that says "ship it anyway on the fourth pass", which is the
 * opposite of what the quality-control process is for.
 *
 * `GAPS-RAISED` and `IN-DISCUSSION` are two stages rather than one because
 * they are held by DIFFERENT PARTIES and the hand-off between them is the
 * owner's actual instruction: *gaps go to a meeting, not straight back to the
 * builder.* Collapsing them would put the reviewer and the builder in a private
 * loop and delete the meeting, which is where a gap becomes a decision. A
 * deliverable sitting in GAPS-RAISED is waiting for the office; one in
 * IN-DISCUSSION is being decided.
 *
 * ── WHY NON-CONVERGENCE IS NOT A STAGE ───────────────────────────────────
 *
 * The owner: *there is no cap on rounds — but a deliverable that has been
 * round the loop without converging is itself a finding. Surface it rather
 * than looping silently.* A `STALLED` stage would halt the loop, which is the
 * cap he ruled out wearing a different name. So non-convergence is a DERIVED
 * FINDING (`convergenceFinding()`), computed from the record, rendered into
 * the meeting agenda and the weekly report, and it changes no stage. The
 * deliverable keeps going round; the office is told it is going round.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHERE THE RECORD LIVES, AND WHY THE WORKER CANNOT WRITE IT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Owner decision, 2026-08-10: **work in progress lives in the warehouse — all
 * of it.** So the lifecycle record is a `lifecycle` object inside the task's
 * existing `warehouse-office-AI-agents/tasks/<slug>/STATE.json`, beside the
 * `completed`/`history` that `run-controller.js` already reads. One file, with
 * the artifact, so a record cannot outlive or drift from the thing it records.
 *
 * **The live Worker cannot write there and MUST NOT BE MADE ABLE TO.**
 * `WAREHOUSE_REPO_TOKEN` is mapped in `config/project-permissions.json` and
 * deliberately unset — two independent locks (the code rule and the absent
 * token), and this module does not touch either. That is a constraint on the
 * design, and the design absorbs it rather than working around it:
 *
 *   THE OFFICE DECIDES IN BACK-OFFICE. THE WAREHOUSE-SIDE RUN APPLIES.
 *
 * A review, a raised gap, a vote, a recommendation and an approval are all
 * produced by the office (meetings, agents, the Worker) and written to
 * `back-office-AI-agents/campus/shared/lifecycle-inbox/<slug>/` — the same
 * inbox shape `MEETING-PROTOCOL.md` §3 already uses for action items, through
 * the same `resolveRepoWrite()` path with `BACKOFFICE_REPO_TOKEN`. The next
 * warehouse-side run (`scripts/lifecycle.mjs ingest`, which the Architect's
 * unattended run invokes) drains the inbox into `STATE.json` and, IN THE SAME
 * WRITE, updates the `- **Stage:**` line on `BOARD.md`.
 *
 * This is not a workaround for a missing token. It is the same one-writer
 * discipline `Dispatched:` already has: two parties may PROPOSE, exactly one
 * party APPLIES, and every application is a git commit somebody can read.
 *
 * ── THE BOARD LINE IS A PROJECTION AND SAYS SO ───────────────────────────
 *
 * `- **Stage:** <STAGE> · round <N> · <who it is waiting on>` is written onto
 * the board task so the office can see a deliverable's state without reading
 * a private repo it has no credential for. It is DERIVED from the warehouse
 * record and the warehouse record is authoritative; if the two disagree the
 * board line is the stale one, exactly as the board's own hand-maintained
 * `Counts:` line is stale against `parseBoard()`.
 *
 * **That is a real, named gap and not a solved problem**: nothing inside the
 * Worker can detect the disagreement, because detecting it needs a warehouse
 * read the Worker cannot make. It is reconciled at exactly one point — every
 * `scripts/lifecycle.mjs` run rewrites the line from the record it just wrote,
 * so a drift can only survive between two runs of the one tool that fixes it.
 * `verify-lifecycle.js` §7 proves the rewrite is unconditional rather than
 * conditional on the line having changed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NO JSON IMPORT IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Same rule as `permission-guard.js`, `task-router.js` and
 * `meeting-decisions.js`, for the same reason: a module-scope JSON import
 * needs an attribute esbuild accepts and plain `node` rejects, so a verifier
 * could not import this module and would hand-mirror it instead. The roster
 * and the agent names are PASSED IN by callers who already import config.
 */

/* ────────────────────────────── The stages ─────────────────────────────── */

export const STAGES = Object.freeze([
  'BUILDING',
  'IN-REVIEW',
  'GAPS-RAISED',
  'IN-DISCUSSION',
  'IMPROVING',
  'AWAITING-APPROVAL',
  'CLIENT-READY',
  'WITHDRAWN',
]);

/** The one forward exit. Nothing reaches a client without passing through it. */
export const EXIT_STAGE = 'CLIENT-READY';

/** Stages a deliverable can sit in while still being worked. Used by the
 *  "what is in flight" renderers, which must NOT list finished or killed work
 *  as though the office still owed something on it. */
export const IN_FLIGHT_STAGES = Object.freeze(
  STAGES.filter((s) => s !== 'CLIENT-READY' && s !== 'WITHDRAWN')
);

/**
 * Who a stage is waiting on. This is the single most useful thing a prompt or
 * a report can say about a deliverable, and it is derived from the stage rather
 * than stored, so it cannot go stale against the stage it describes.
 */
export const STAGE_HOLDER = Object.freeze({
  BUILDING: 'the builder',
  'IN-REVIEW': 'the assigned reviewers',
  'GAPS-RAISED': 'the next meeting',
  'IN-DISCUSSION': 'the meeting in progress',
  IMPROVING: 'the builder',
  'AWAITING-APPROVAL': 'the CEO (Agent 11)',
  'CLIENT-READY': 'nobody — approved',
  WITHDRAWN: 'nobody — withdrawn',
});

/* ─────────────────────────────── The roles ─────────────────────────────── */

/** The QA and the Architect are on every reviewer set. MEETING-PROTOCOL.md
 *  §4.4, owner decision 2026-08-07. */
export const ALWAYS_REVIEW = Object.freeze([6, 10]);

/** The CEO. He is the APPROVER, not a reviewer — see composeReviewerSet(). */
export const CEO_AGENT_ID = 11;

/** The Workflow composes the reviewer set (§4.4). Named so the rendered
 *  assignment can say whose job it was, which is what stops the composition
 *  being read as a rule nobody owns. */
export const COMPOSER_AGENT_ID = 12;

/**
 * The admin tier. Passed in by callers in production (from agents-config.json);
 * this is the fallback and the verifier's fixture, and the two are asserted
 * equal by scripts/verify-lifecycle.js §1 so a roster change cannot leave this
 * list quietly behind.
 */
export const ADMIN_IDS = Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13]);

/**
 * `touches` → the admin whose full reasoned review that subject requires.
 * This is MEETING-PROTOCOL.md §4.4's table as data, and it is the mapping
 * OB-026 asks the Workflow to define in practice.
 *
 * It is a MAPPING, NOT A CHAIN — owner instruction, restated because the
 * temptation to turn it into an ordered pipeline is constant and the ordering
 * would be invented. A deliverable that touches three subjects gets one
 * reviewer set containing all three admins, with no order between them.
 */
export const TOUCH_REVIEWERS = Object.freeze({
  visual: 9,             // The Designer
  permissions: 13,       // The Cyber Expert — credentials, tokens, gates
  infrastructure: 5,     // The IT Chief
  persona: 7,            // The Team Lead — agent behaviour
  'quality-trends': 8,   // The Lead QA — cross-agent quality
});

export const TOUCHES = Object.freeze(Object.keys(TOUCH_REVIEWERS));

/**
 * Deliverable type → the `touches` the office has established that type always
 * has. This is the second half of OB-026: §4.4 gives the rule, this gives the
 * rule applied to what the office actually produces.
 *
 * A type's touches are a FLOOR, never a ceiling — a caller may add more. There
 * is deliberately no way to subtract one, because the subtraction is exactly
 * the judgement an unattended run must not make.
 */
export const TYPE_TOUCHES = Object.freeze({
  'warehouse-build': ['infrastructure'],
  'front-page': ['visual'],
  guide: [],
  report: [],
  'config-change': ['infrastructure', 'permissions'],
  finding: ['quality-trends'],
  'agent-behaviour': ['persona'],
});

/* ───────────────────────── Reviewer-set composition ────────────────────── */

/**
 * Composes the reviewer set for one deliverable.
 *
 * THREE ROLES, and the third one is the whole point:
 *
 *   required    — a full reasoned review is expected. QA + Architect always,
 *                 plus one admin per `touches` subject.
 *   mayComment  — every other admin. **They must comment briefly OR explicitly
 *                 abstain**, and the abstention is recorded.
 *   approver    — the CEO. He is not in either list above, deliberately.
 *
 * ── WHY THE CEO IS NOT A REVIEWER ────────────────────────────────────────
 *
 * He is the exit condition. If he also sat in `mayComment`, his approval would
 * satisfy his own review obligation and the two acts would collapse into one —
 * which is precisely the "the Architect reviews and we are done" shape this
 * module exists to break, moved one seat up the org chart. He answers once, at
 * AWAITING-APPROVAL, on a recommendation the office produced. He may of course
 * say anything he likes in a meeting; that is not a recorded review.
 *
 * ── SILENCE IS NEVER APPROVAL ────────────────────────────────────────────
 *
 * Owner-stated, and it is enforced structurally rather than by exhortation:
 * `reviewerCoverage()` treats an admin with NO RECORDED RESPONSE as missing,
 * and `canAdvance()` refuses IN-REVIEW → AWAITING-APPROVAL while any are
 * missing. An admin who has nothing to say must say that. The cost of the
 * rule is a required act from someone with no opinion; the cost of not having
 * it is a deliverable reaching the client because eight people were busy.
 *
 * @param {object} d  {type, touches}
 * @param {object} [opts] {roster} — admin ids, from agents-config.json
 */
export function composeReviewerSet(d = {}, opts = {}) {
  const roster = (opts.roster && opts.roster.length ? opts.roster : ADMIN_IDS).slice();

  const declared = Array.isArray(d.touches) ? d.touches : [];
  const fromType = TYPE_TOUCHES[d.type] || [];
  const unknownTouches = declared.filter((t) => !TOUCHES.includes(t));
  const touches = Array.from(new Set([...fromType, ...declared.filter((t) => TOUCHES.includes(t))]));

  const required = Array.from(new Set([
    ...ALWAYS_REVIEW,
    ...touches.map((t) => TOUCH_REVIEWERS[t]),
  ])).filter((id) => roster.includes(id)).sort((a, b) => a - b);

  const mayComment = roster
    .filter((id) => id !== CEO_AGENT_ID && !required.includes(id))
    .sort((a, b) => a - b);

  // An unknown `touches` value is REPORTED, never dropped and never mapped to
  // a plausible neighbour. A deliverable tagged `security` (not a key here)
  // that silently composed as though it touched nothing would omit the Cyber
  // Expert from a set he belongs in, and the omission would be invisible.
  const warnings = unknownTouches.length
    ? [`unknown touches value(s) ${unknownTouches.join(', ')} — not mapped to a reviewer. Known values: ${TOUCHES.join(', ')}. The set below is composed WITHOUT them and is therefore possibly short.`]
    : [];
  if (!TYPE_TOUCHES[d.type]) {
    warnings.push(`deliverable type "${d.type ?? 'absent'}" is not in TYPE_TOUCHES — no floor was applied, only the declared touches. Known types: ${Object.keys(TYPE_TOUCHES).join(', ')}.`);
  }

  return {
    required,
    mayComment,
    approver: CEO_AGENT_ID,
    composedBy: COMPOSER_AGENT_ID,
    touches,
    warnings,
  };
}

/**
 * Who still owes a response.
 *
 * `required` owes a full review (`kind: 'review'`). `mayComment` owes either a
 * comment or an abstention — and BOTH are responses. An abstention is recorded
 * with its author and date and is not counted as assent anywhere.
 */
export function reviewerCoverage(record = {}) {
  const set = record.reviewer_set || { required: [], mayComment: [] };
  const responses = Array.isArray(record.reviews) ? record.reviews : [];
  const round = record.round ?? 0;

  // Only THIS round's responses count. A review written against round 2 says
  // nothing about the round-3 artifact, and carrying it forward would let one
  // early full review satisfy every later round — the loop's exit condition
  // quietly satisfied by work done on a different version.
  const forRound = responses.filter((r) => (r.round ?? 0) === round);
  const byAgent = new Map(forRound.map((r) => [r.agent_id, r]));

  const missing = [];
  for (const id of set.required || []) {
    const r = byAgent.get(id);
    if (!r) missing.push({ agentId: id, why: `no response recorded for round ${round} — a full reasoned review is required from this admin` });
    else if (r.kind !== 'review') missing.push({ agentId: id, why: `responded with "${r.kind}" but a full reasoned review is required from this admin` });
  }
  for (const id of set.mayComment || []) {
    if (!byAgent.has(id)) {
      missing.push({ agentId: id, why: `no response recorded for round ${round} — a brief comment or an EXPLICIT abstention is required. Silence is never approval.` });
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
    round,
    responded: forRound.length,
    abstained: forRound.filter((r) => r.kind === 'abstain').map((r) => r.agent_id),
  };
}

/* ──────────────────────────────── Gaps ─────────────────────────────────── */

/**
 * A gap's class decides whether the meeting must VOTE on it.
 *
 *   binding — product decisions, conflicts, anything touching the client.
 *             MEETING-PROTOCOL.md §4.3's scope, verbatim.
 *   routine — ordinary iteration. Decided in the meeting, no vote.
 *
 * ── AN UNCLASSIFIED GAP BLOCKS; IT IS NEITHER DROPPED NOR DEFAULTED ──────
 *
 * The house rule everywhere else in this codebase is REFUSE, NEVER DEFAULT —
 * and applied literally here it would DROP a gap that named no class, which is
 * worse than either mistake it prevents. Defaulting is worse still in one
 * direction specifically: a client-touching decision silently classed
 * `routine` skips the vote, and the vote is the mechanism.
 *
 * So there is a third outcome. An unclassified gap is RECORDED, counted as
 * OPEN, and cannot be resolved until a meeting classifies it. Nothing is lost,
 * nothing skips a vote, and the deliverable cannot reach the CEO while one is
 * outstanding. `nextAction()` surfaces it by name.
 */
export const GAP_CLASSES = Object.freeze(['binding', 'routine']);

export function gapClass(gap = {}) {
  const c = String(gap.class || '').trim().toLowerCase();
  return GAP_CLASSES.includes(c) ? c : 'UNCLASSIFIED';
}

/** A gap is open until it is `resolved` or `dismissed`, and a dismissal needs
 *  a decision behind it — see canAdvance()'s IN-DISCUSSION rules. */
export function openGaps(record = {}) {
  return (Array.isArray(record.gaps) ? record.gaps : [])
    .filter((g) => g.status !== 'resolved' && g.status !== 'dismissed');
}

export function unclassifiedGaps(record = {}) {
  return openGaps(record).filter((g) => gapClass(g) === 'UNCLASSIFIED');
}

/**
 * Binding gaps that have not yet been put to a vote. These are what stop
 * IN-DISCUSSION advancing: the meeting is where a gap becomes a decision, and
 * for a binding gap the decision IS the vote.
 */
export function bindingGapsAwaitingVote(record = {}) {
  const votes = Array.isArray(record.votes) ? record.votes : [];
  const voted = new Set(votes.flatMap((v) => (Array.isArray(v.gap_ids) ? v.gap_ids : [])));
  return openGaps(record).filter((g) => gapClass(g) === 'binding' && !voted.has(g.id));
}

/* ─────────────────────────────── Voting ────────────────────────────────── */

/**
 * Tallies one vote. MEETING-PROTOCOL.md §4.3, and the bible: admins only, the
 * CEO leads, holds a DOUBLE VOTE and a VETO.
 *
 * Four refusals, each protecting a different thing:
 *
 *  - A NON-ADMIN vote is refused, not ignored. Ignoring it would produce a
 *    tally that silently differs from the recorded table a human reads.
 *  - An ABSTENTION counts toward neither side and is carried in the result, so
 *    a report can say "3 for, 1 against, 5 abstained" — which is a different
 *    decision from "3 for, 1 against" and should never render as one.
 *  - A TIE with no `resolution` is refused. §4.3 requires the meeting to
 *    decide investigate/defer/drop and to record THAT, so a tie that stops
 *    there is an unfinished record, not an outcome.
 *  - A VETO overrides the count and is reported as its own outcome. It never
 *    silently changes `carried` to `rejected`, because "the room voted for it
 *    and the CEO stopped it" is the fact worth keeping.
 */
export const VOTE_CHOICES = Object.freeze(['for', 'against', 'abstain']);
export const TIE_RESOLUTIONS = Object.freeze(['investigate', 'defer', 'drop']);

export function tallyVote(vote = {}, opts = {}) {
  const roster = (opts.roster && opts.roster.length ? opts.roster : ADMIN_IDS);
  const cast = Array.isArray(vote.votes) ? vote.votes : [];

  if (!String(vote.question || '').trim()) {
    return { ok: false, reason: 'vote has no question — §4.3 records the question as stated, and a vote whose question was never written down cannot bind anything' };
  }

  const invalid = [];
  let forCount = 0;
  let againstCount = 0;
  const abstained = [];

  for (const v of cast) {
    const id = Number(v.agent_id);
    const choice = String(v.choice || '').trim().toLowerCase();
    if (!roster.includes(id)) { invalid.push({ agent_id: v.agent_id, why: 'not an admin — admins only vote (bible, §4.3)' }); continue; }
    if (!VOTE_CHOICES.includes(choice)) { invalid.push({ agent_id: id, why: `unreadable choice "${v.choice}"` }); continue; }
    // The CEO's double vote. Applied here rather than by the caller so a
    // report and a gate can never weight it differently.
    const weight = id === CEO_AGENT_ID ? 2 : 1;
    if (choice === 'for') forCount += weight;
    else if (choice === 'against') againstCount += weight;
    else abstained.push(id);
  }

  if (invalid.length) {
    return { ok: false, reason: `refused: ${invalid.map((i) => `agent ${i.agent_id} — ${i.why}`).join('; ')}`, invalid };
  }
  if (!forCount && !againstCount && !abstained.length) {
    return { ok: false, reason: 'no votes cast' };
  }

  const vetoed = vote.veto_used === true;
  let outcome;
  if (vetoed) outcome = 'vetoed';
  else if (forCount > againstCount) outcome = 'carried';
  else if (againstCount > forCount) outcome = 'rejected';
  else outcome = 'tie';

  if (outcome === 'tie') {
    const res = String(vote.resolution || '').trim().toLowerCase();
    if (!TIE_RESOLUTIONS.includes(res)) {
      return {
        ok: false,
        reason: `tie (${forCount}–${againstCount}) with no recorded resolution — §4.3 requires the meeting to decide ${TIE_RESOLUTIONS.join(' | ')} and to record that resolution`,
        tally: { for: forCount, against: againstCount, abstained },
      };
    }
    return { ok: true, outcome: 'tie', resolution: res, tally: { for: forCount, against: againstCount, abstained }, vetoed: false };
  }

  return { ok: true, outcome, resolution: null, tally: { for: forCount, against: againstCount, abstained }, vetoed };
}

/** Renders one vote in MEETING-PROTOCOL.md §4.3's exact recorded format, so a
 *  meeting report and this module cannot present the same vote differently. */
export function renderVote(vote, tally, { names = {} } = {}) {
  const rows = (vote.votes || []).map((v) => {
    const id = Number(v.agent_id);
    const label = `${id} — ${names[id] || 'Agent ' + id}`;
    const choice = id === CEO_AGENT_ID ? `${v.choice} (×2, leads)` : v.choice;
    const note = v.note || (String(v.choice).toLowerCase() === 'abstain' ? 'recorded, not counted as assent' : '');
    return `| ${label} | ${choice} | ${note} |`;
  });
  const outcome = tally.outcome === 'tie' ? `TIE → ${tally.resolution}` : tally.outcome;
  return [
    `### Vote — ${vote.question}`,
    '',
    '| Agent | Vote | Note |',
    '|---|---|---|',
    ...rows,
    '',
    `- **Outcome:** ${outcome}`,
    `- **Date:** ${vote.date || 'undated'}`,
    `- **Veto used:** ${vote.veto_used === true ? 'yes' : 'no'}`,
  ].join('\n');
}

/* ───────────────────────── Transitions and their guards ────────────────── */

/**
 * Every legal move, with the guard that must hold. A move not in this table is
 * refused with `no_such_transition` — the table is the whole grammar, so a
 * caller cannot invent a shortcut to CLIENT-READY by passing a plausible stage
 * name.
 *
 * Read the CLIENT-READY row first. It is the only forward exit and it carries
 * the only guard that names a specific human role.
 */
const TRANSITION_GUARDS = {
  'BUILDING->IN-REVIEW': (r, ctx) => {
    const phases = ctx.phases || [];
    const done = new Set(r.build_completed || ctx.completed || []);
    const remaining = phases.filter((p) => !done.has(p.id ?? p));
    if (phases.length && remaining.length) {
      return `${remaining.length} spec phase(s) are not built: ${remaining.map((p) => p.id ?? p).join(', ')}`;
    }
    if (!phases.length) return 'no "## Phases" list was supplied — a build cannot be declared complete against a spec nobody read';
    const openShift = r.shift && r.shift.status === 'SUSPENDED';
    if (openShift) return `the last shift on phase "${r.shift.phase}" is SUSPENDED and was never closed — a suspended shift means work stopped mid-phase, and a phase list that looks complete over an open shift is exactly the partial-that-looks-finished failure this project has hit three times`;
    if (!r.reviewer_set || !(r.reviewer_set.required || []).length) return 'no reviewer set has been composed — the Workflow (Agent 12) composes it per deliverable (MEETING-PROTOCOL.md §4.4)';
    return null;
  },

  'IN-REVIEW->GAPS-RAISED': (r) => {
    const cov = reviewerCoverage(r);
    if (!cov.satisfied) return `${cov.missing.length} admin(s) have not responded this round: ${cov.missing.map((m) => `Agent ${m.agentId}`).join(', ')}`;
    if (!openGaps(r).length) return 'no open gaps — a review round that raised nothing goes to AWAITING-APPROVAL, not to a meeting';
    return null;
  },

  'IN-REVIEW->AWAITING-APPROVAL': (r) => {
    const cov = reviewerCoverage(r);
    if (!cov.satisfied) {
      return `${cov.missing.length} admin(s) have not responded this round — SILENCE IS NEVER APPROVAL: ${cov.missing.map((m) => `Agent ${m.agentId} (${m.why})`).join('; ')}`;
    }
    const open = openGaps(r);
    if (open.length) return `${open.length} gap(s) still open: ${open.map((g) => g.id).join(', ')}`;
    if (!r.recommendation || !String(r.recommendation.text || '').trim()) {
      return 'no recommendation recorded — the CEO approves a final version AFTER a recommendation, and a recommendation that says nothing is an approval request wearing its name';
    }
    return null;
  },

  'GAPS-RAISED->IN-DISCUSSION': (r, ctx) => {
    if (!ctx.meetingId) return 'no meeting named — a gap becomes a decision in a meeting, so the meeting has to exist before the stage moves';
    return null;
  },

  // A meeting may send the deliverable back to the builder…
  'IN-DISCUSSION->IMPROVING': (r) => {
    const unclassified = unclassifiedGaps(r);
    if (unclassified.length) return `${unclassified.length} gap(s) carry no class: ${unclassified.map((g) => g.id).join(', ')}. A meeting must classify each as binding or routine before it can act on them — an unclassified gap silently treated as routine is a client-touching decision that skipped its vote`;
    const awaiting = bindingGapsAwaitingVote(r);
    if (awaiting.length) return `${awaiting.length} binding gap(s) have not been voted on: ${awaiting.map((g) => g.id).join(', ')}. §4.3 puts product decisions, conflicts and anything touching the client to a vote`;
    if (!openGaps(r).length) return 'no open gaps to improve against — an improvement round with nothing to fix is a round the office will not be able to review';
    return null;
  },

  // …or decide the gaps do not need work, having recorded why.
  'IN-DISCUSSION->AWAITING-APPROVAL': (r) => {
    const unclassified = unclassifiedGaps(r);
    if (unclassified.length) return `${unclassified.length} gap(s) carry no class: ${unclassified.map((g) => g.id).join(', ')}`;
    const awaiting = bindingGapsAwaitingVote(r);
    if (awaiting.length) return `${awaiting.length} binding gap(s) have not been voted on: ${awaiting.map((g) => g.id).join(', ')}`;
    const open = openGaps(r);
    if (open.length) return `${open.length} gap(s) still open — dismissing a gap requires recording the decision that dismissed it, not moving past it: ${open.map((g) => g.id).join(', ')}`;
    if (!r.recommendation || !String(r.recommendation.text || '').trim()) return 'no recommendation recorded';
    return null;
  },

  'IMPROVING->IN-REVIEW': (r, ctx) => {
    const openShift = r.shift && r.shift.status === 'SUSPENDED';
    if (openShift) return `the improvement shift on "${r.shift.phase}" is SUSPENDED — it stopped part-way and the work is not ready to be reviewed. Resume it first`;
    if (!ctx.roundIncremented) return 'an improvement round must increment `round` — reviews are matched to the round they were written against, and a round that does not advance lets one early review satisfy every later pass';
    return null;
  },

  'AWAITING-APPROVAL->CLIENT-READY': (r, ctx) => {
    const a = r.approval;
    if (!a) return 'no approval recorded — NOTHING REACHES THE CLIENT WITHOUT THE CEO';
    if (Number(a.by) !== CEO_AGENT_ID) return `approval is recorded by Agent ${a.by}, not by the CEO (Agent ${CEO_AGENT_ID}). The CEO approves the final version; no other admin may stand in for him`;
    if (a.decision !== 'approve') return `the CEO's recorded decision is "${a.decision}", not "approve"`;
    if (!r.recommendation || !String(r.recommendation.text || '').trim()) return 'the CEO approved with no recommendation on record — §4.3 has him answering a recommendation, and an approval with nothing behind it cannot be reviewed later';
    if (openGaps(r).length) return `${openGaps(r).length} gap(s) reopened after the recommendation and are still open`;
    if (ctx.strict !== false && !(r.reviewer_set && reviewerCoverage(r).satisfied)) return 'the current round is not fully covered by the reviewer set';
    return null;
  },

  // The CEO's veto, or a plain "not yet". Back to the room, not to the builder:
  // he is answering the office's recommendation, so the office takes it back.
  'AWAITING-APPROVAL->IN-DISCUSSION': (r) => {
    const a = r.approval;
    if (!a) return 'no CEO answer recorded';
    if (a.decision === 'approve') return 'the CEO approved — that goes to CLIENT-READY, not back to discussion';
    if (!String(a.reason || '').trim()) return 'a returned deliverable must carry the CEO\'s stated reason, or the next round has nothing to aim at';
    return null;
  },

  // Withdrawal is legal from anywhere that is still in flight, and it always
  // needs a reason. It is NOT an exit to the client; see EXIT_STAGE.
  'ANY->WITHDRAWN': (r, ctx) => (String(ctx.reason || '').trim() ? null : 'a withdrawal with no stated reason erases why the office stopped'),
};

/**
 * May this record move to `to`?
 *
 * @returns {{ok: boolean, reason: string|null, code: string}}
 */
export function canAdvance(record = {}, to, ctx = {}) {
  const from = record.stage;
  if (!STAGES.includes(from)) return { ok: false, code: 'unreadable_stage', reason: `current stage "${from ?? 'absent'}" is not one of ${STAGES.join(', ')}` };
  if (!STAGES.includes(to)) return { ok: false, code: 'unknown_stage', reason: `"${to}" is not a stage` };
  if (from === to) return { ok: false, code: 'no_move', reason: `already ${from}` };
  if (from === 'CLIENT-READY' || from === 'WITHDRAWN') {
    return { ok: false, code: 'terminal', reason: `${from} is terminal — a deliverable that needs more work is a NEW round on a NEW record, not a reopened approval` };
  }

  const guard = to === 'WITHDRAWN' ? TRANSITION_GUARDS['ANY->WITHDRAWN'] : TRANSITION_GUARDS[`${from}->${to}`];
  if (!guard) {
    return { ok: false, code: 'no_such_transition', reason: `${from} → ${to} is not a legal move. Legal from ${from}: ${legalMovesFrom(from).join(', ') || 'none'}` };
  }
  const why = guard(record, ctx);
  return why ? { ok: false, code: 'guard_refused', reason: why } : { ok: true, code: 'ok', reason: null };
}

export function legalMovesFrom(stage) {
  const out = Object.keys(TRANSITION_GUARDS)
    .filter((k) => k.startsWith(`${stage}->`))
    .map((k) => k.split('->')[1]);
  if (stage !== 'CLIENT-READY' && stage !== 'WITHDRAWN') out.push('WITHDRAWN');
  return out;
}

/* ───────────────────────── What should happen next ─────────────────────── */

/**
 * The office's own next move on this deliverable, in one sentence, addressed to
 * whoever holds it.
 *
 * This is what turns a state machine into a loop that runs: a meeting prompt, a
 * morning assignment and a report all need the SAME answer to "what does this
 * thing need", and deriving it in three places is how the three drift. It
 * returns an `action` a caller can branch on and a `say` a prompt can print.
 */
export function nextAction(record = {}, ctx = {}) {
  const stage = record.stage;
  const round = record.round ?? 0;

  if (stage === 'CLIENT-READY') return { action: 'none', holder: null, say: 'Approved by the CEO and ready for the client. Nothing is owed.' };
  if (stage === 'WITHDRAWN') return { action: 'none', holder: null, say: `Withdrawn: ${record.withdrawn_reason || 'no reason recorded'}.` };

  if (stage === 'BUILDING') {
    if (record.shift && record.shift.status === 'SUSPENDED') {
      return { action: 'resume_build', holder: 'the builder', say: `Build shift on phase "${record.shift.phase}" is SUSPENDED — resume it. It stopped because: ${record.shift.stopped_because || 'no reason recorded'}. Next step recorded as: ${record.shift.next || 'not recorded'}.` };
    }
    return { action: 'build', holder: 'the builder', say: 'Still building. The next unbuilt phase in the spec is the next unit of work.' };
  }

  if (stage === 'IN-REVIEW') {
    const cov = reviewerCoverage(record);
    if (!cov.satisfied) {
      return {
        action: 'assign_reviews',
        holder: 'the assigned reviewers',
        agentIds: cov.missing.map((m) => m.agentId),
        say: `Round ${round} review is incomplete. Still owed by: ${cov.missing.map((m) => `Agent ${m.agentId}`).join(', ')}. A required admin owes a full reasoned review; everyone else owes a brief comment or an explicit abstention — silence is never approval.`,
      };
    }
    if (openGaps(record).length) return { action: 'take_to_meeting', holder: 'the next meeting', say: `Round ${round} review is complete and raised ${openGaps(record).length} gap(s). They go to a meeting, not back to the builder.` };
    return { action: 'recommend', holder: 'the assigned reviewers', say: `Round ${round} review is complete with no open gaps. The office owes a recommendation to the CEO.` };
  }

  if (stage === 'GAPS-RAISED') {
    return { action: 'take_to_meeting', holder: 'the next meeting', gapIds: openGaps(record).map((g) => g.id), say: `${openGaps(record).length} gap(s) are waiting for a meeting to take them up: ${openGaps(record).map((g) => g.id).join(', ')}.` };
  }

  if (stage === 'IN-DISCUSSION') {
    const unclassified = unclassifiedGaps(record);
    if (unclassified.length) return { action: 'classify_gaps', holder: 'the meeting in progress', gapIds: unclassified.map((g) => g.id), say: `${unclassified.length} gap(s) carry no class and the meeting must set one — binding (product decision, conflict, or anything touching the client → a vote) or routine: ${unclassified.map((g) => g.id).join(', ')}.` };
    const awaiting = bindingGapsAwaitingVote(record);
    if (awaiting.length) return { action: 'vote', holder: 'the meeting in progress', gapIds: awaiting.map((g) => g.id), say: `${awaiting.length} binding gap(s) need a recorded vote before anything moves: ${awaiting.map((g) => g.id).join(', ')}. Admins only; the CEO leads with a double vote and a veto.` };
    return { action: 'decide_round', holder: 'the meeting in progress', say: 'Every gap is classified and every binding one is voted. The meeting now either opens an improvement round or dismisses the remaining gaps with its recorded decision.' };
  }

  if (stage === 'IMPROVING') {
    if (record.shift && record.shift.status === 'SUSPENDED') {
      return { action: 'resume_improve', holder: 'the builder', say: `Improvement shift on "${record.shift.phase}" is SUSPENDED — resume it. Stopped because: ${record.shift.stopped_because || 'no reason recorded'}.` };
    }
    return { action: 'improve', holder: 'the builder', gapIds: openGaps(record).map((g) => g.id), say: `Improvement round ${round + 1} against ${openGaps(record).length} gap(s): ${openGaps(record).map((g) => g.id).join(', ')}.` };
  }

  if (stage === 'AWAITING-APPROVAL') {
    return { action: 'ceo_approval', holder: `the CEO (Agent ${CEO_AGENT_ID})`, say: `The office recommends: "${record.recommendation?.text || '(no recommendation text on record — this is a defect)'}" — the CEO approves or returns it. Nothing reaches the client without him.` };
  }

  return { action: 'unknown', holder: null, say: `Stage "${stage}" has no defined next action — this is a defect, not a state.` };
}

/* ──────────────────────── The non-convergence finding ──────────────────── */

/**
 * Is this deliverable going round the loop without getting closer?
 *
 * NOT A GATE. It changes nothing, blocks nothing and caps nothing — it
 * produces a sentence for a meeting agenda and a report. See the header for
 * why a `STALLED` stage was rejected.
 *
 * Two independent signals, because "many rounds" alone is a bad measure — a
 * deliverable can legitimately take five rounds and be improving every time:
 *
 *   1. ROUNDS — `roundThreshold` or more completed rounds.
 *   2. NOT SHRINKING — the count of open gaps at the end of the last two
 *      rounds did not go down. This is the one that actually means "not
 *      converging", and it is why round history is recorded per round rather
 *      than as a single counter.
 *
 * Reported separately and never summed into a score, for the same reason
 * `computeWorkflowMetrics()` refuses a single productivity percentage.
 */
export function convergenceFinding(record = {}, { roundThreshold = 3 } = {}) {
  const round = record.round ?? 0;
  const hist = Array.isArray(record.round_history) ? record.round_history : [];
  const signals = [];

  if (round >= roundThreshold) {
    signals.push(`${round} completed rounds (threshold ${roundThreshold})`);
  }
  if (hist.length >= 2) {
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (Number(last.open_gaps_at_close) >= Number(prev.open_gaps_at_close)) {
      signals.push(`open gaps did not fall between round ${prev.round} (${prev.open_gaps_at_close}) and round ${last.round} (${last.open_gaps_at_close})`);
    }
  }

  if (!signals.length) return { concern: false, signals: [], say: null };
  return {
    concern: true,
    signals,
    say: `${record.slug || 'this deliverable'} has been round the review loop without converging — ${signals.join('; ')}. This is a FINDING for the meeting, not a reason to stop or to ship it: there is no cap on rounds.`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * WORK THAT SURVIVES A DAY — shifts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The owner's second decision, 2026-08-10: **a task spans days; it is not
 * expected to finish in one block.** That reframes the quota question he
 * raised. If a task had to finish in one block, a quota running out mid-build
 * would be a failure. Because a task spans days by design, the same event is
 * THE END OF A SHIFT — and a shift that ends is a normal thing that has to
 * leave a legible handover, not an error to be recovered from.
 *
 * ── WHAT A SHIFT IS ──────────────────────────────────────────────────────
 *
 * One agent, one phase, one sitting. It opens when work on a phase starts and
 * closes exactly once, one of two ways:
 *
 *   COMPLETED  — the phase is finished. Only now may the phase id join
 *                `completed`, and `assertPhaseCompletable()` enforces that.
 *   SUSPENDED  — the allowance ran out, or the sitting ended. The phase does
 *                NOT join `completed`, the board task stays IN-PROGRESS, and
 *                the record carries `done` / `next` / `artifacts` /
 *                `incomplete_artifacts`.
 *
 * ── HOW THE RESUME ACTUALLY READS YESTERDAY'S OUTPUT ─────────────────────
 *
 * Concretely, and this is the part that has to be concrete or it is a promise:
 *
 *   1. `run-controller.js decide()` finds the first phase not in `completed`.
 *      A SUSPENDED shift on that phase makes the action RESUME, not BUILD.
 *   2. `resumeBrief(record)` renders the suspended shift into the agent's
 *      prompt: what was finished (`done`, named), where it stopped (`next`,
 *      one sentence), which files it wrote (`artifacts`, real paths) and which
 *      files are HALF-WRITTEN and must not be trusted (`incomplete_artifacts`).
 *   3. The agent READS THOSE FILES from the warehouse checkout. It does not
 *      reconstruct them from the brief; the brief tells it which files to open.
 *      That is the whole difference between a resume and a restart — the
 *      artifacts are the state, and the shift record is the index into them.
 *   4. It continues at `next`, and closes a new shift when it stops.
 *
 * The failure this shape exists to prevent, and it has bitten this project
 * three times: A PARTIAL WRITE THAT LOOKS COMPLETE. `incomplete_artifacts` is
 * the reason it is a list and not a boolean — the next shift has to be able to
 * distinguish "this file is finished" from "this file was open when the lights
 * went out", and only the shift that stopped knows which.
 */

export const SHIFT_STATUSES = Object.freeze(['OPEN', 'SUSPENDED', 'COMPLETED']);

export function openShift({ phase, agentId = null, at = null, note = null } = {}) {
  if (!String(phase || '').trim()) return { ok: false, reason: 'a shift must name the phase it is working on' };
  return {
    ok: true,
    shift: {
      phase: String(phase),
      agent_id: agentId,
      status: 'OPEN',
      opened: at,
      closed: null,
      stopped_because: null,
      done: [],
      next: null,
      artifacts: [],
      incomplete_artifacts: [],
      note,
    },
  };
}

/**
 * Closes a shift. REFUSES the closes that would produce a lie:
 *
 *  - SUSPENDED with no `next` — the next shift would have to guess where the
 *    last one stopped, which is a restart wearing a resume's name.
 *  - SUSPENDED with no `stopped_because` — "why did work stop" is the single
 *    fact a person reading the board tomorrow needs, and it is unrecoverable
 *    after the fact.
 *  - COMPLETED with `incomplete_artifacts` — a phase cannot be finished while
 *    one of its own files is known to be half-written.
 */
export function closeShift(shift, { status, stoppedBecause = null, next = null, done = null, artifacts = null, incompleteArtifacts = null, at = null } = {}) {
  if (!shift) return { ok: false, reason: 'no open shift to close' };
  if (status !== 'SUSPENDED' && status !== 'COMPLETED') {
    return { ok: false, reason: `a shift closes SUSPENDED or COMPLETED, not "${status}"` };
  }
  const out = {
    ...shift,
    status,
    closed: at,
    stopped_because: stoppedBecause ?? shift.stopped_because,
    next: next ?? shift.next,
    done: done ?? shift.done ?? [],
    artifacts: artifacts ?? shift.artifacts ?? [],
    incomplete_artifacts: incompleteArtifacts ?? shift.incomplete_artifacts ?? [],
  };

  if (status === 'SUSPENDED') {
    if (!String(out.stopped_because || '').trim()) return { ok: false, reason: 'a SUSPENDED shift must record why it stopped — an unexplained suspension reads tomorrow as a crash' };
    if (!String(out.next || '').trim()) return { ok: false, reason: 'a SUSPENDED shift must record where it stopped (`next`) — without it the next shift restarts rather than resumes' };
  }
  if (status === 'COMPLETED' && out.incomplete_artifacts.length) {
    return { ok: false, reason: `cannot close COMPLETED while ${out.incomplete_artifacts.length} artifact(s) are recorded incomplete: ${out.incomplete_artifacts.join(', ')}` };
  }
  return { ok: true, shift: out };
}

/**
 * THE STRUCTURAL GATE. A phase may join `completed` only over a shift that
 * closed COMPLETED.
 *
 * This is the same class of gate the report pipeline's structural check is —
 * and it is here for the same reason. The report pipeline was built because a
 * draft could be published while structurally unfinished; this exists because a
 * PHASE could be marked done while its shift stopped half-way, and everything
 * downstream (`decide()`, `canAdvance('BUILDING'→'IN-REVIEW')`, the board, the
 * weekly report) reads `completed` as truth.
 */
export function assertPhaseCompletable(record = {}, phaseId) {
  const shift = record.shift;
  if (!shift) return { ok: false, reason: `no shift recorded for phase "${phaseId}" — a phase that nobody opened a shift on cannot be shown to have been worked` };
  if (shift.phase !== phaseId) return { ok: false, reason: `the recorded shift is on phase "${shift.phase}", not "${phaseId}"` };
  if (shift.status !== 'COMPLETED') return { ok: false, reason: `the shift on "${phaseId}" closed ${shift.status}, not COMPLETED — a suspended shift means the phase is not finished` };
  if ((shift.incomplete_artifacts || []).length) return { ok: false, reason: `phase "${phaseId}" has incomplete artifacts recorded: ${shift.incomplete_artifacts.join(', ')}` };
  return { ok: true, reason: null };
}

/** The brief an agent resuming tomorrow actually reads. Returns null when
 *  there is nothing to resume — a caller must not print an empty resume block,
 *  because "resume: nothing" reads as "there was nothing to do". */
export function resumeBrief(record = {}) {
  const s = record.shift;
  if (!s || s.status !== 'SUSPENDED') return null;
  const lines = [
    `RESUMING PHASE "${s.phase}". You are continuing work you stopped part-way through. DO NOT START OVER.`,
    `It stopped because: ${s.stopped_because}`,
    `Where it stopped: ${s.next}`,
  ];
  if ((s.done || []).length) lines.push(`Already finished in this phase (do not redo): ${s.done.join('; ')}`);
  if ((s.artifacts || []).length) {
    lines.push(`READ THESE FILES FIRST — they are the state, this brief is only the index into them: ${s.artifacts.join(', ')}`);
  }
  if ((s.incomplete_artifacts || []).length) {
    lines.push(`HALF-WRITTEN — do not trust the contents of these, finish or rewrite them: ${s.incomplete_artifacts.join(', ')}`);
  } else if ((s.artifacts || []).length) {
    lines.push('No artifact was recorded half-written, so everything listed above is complete as far as it goes.');
  }
  return lines.join('\n');
}

/**
 * The allowance decision, taken BEFORE a call rather than discovered by one
 * failing.
 *
 * ── WHY THIS TAKES A CHECKER RESULT RATHER THAN CALLING THE ROUTER ───────
 *
 * `task-router.js checkProviderAllowance()` already does the real work — it
 * knows the per-provider counters, the 60% `soft_stop_fraction`, and the
 * wall-clock pacing that stands in for an unknown cap. This module must not
 * import it: `scripts/verify-providers.js` enforces that nothing outside
 * `task-router.js` reaches into the provider layer, and weakening that guard to
 * admit a convenience is how guards stop meaning anything (the same reasoning
 * `office-context.js` records for its duplicated `estimateTokens`).
 *
 * So the CALLER checks and passes the result in. What is decided here is the
 * only part that is this module's business: what a refusal MEANS to a shift.
 *
 * ── AND IT IS ALWAYS A SHIFT END, NEVER AN ESCALATION ────────────────────
 *
 * `overtime_required` is a REFUSAL. There is no automatic escalation to a paid
 * tier, for any provider, ever — paid usage needs the owner's explicit
 * per-instance approval at the time. This function's answer to an exhausted
 * allowance is "close the shift", and there is deliberately no third branch.
 */
export function shiftAllowance(allowance = {}, { phase = null } = {}) {
  if (allowance.allowed === true) return { proceed: true, reason: null, stopBecause: null };

  const reason = allowance.reason || 'unknown';
  const detail = allowance.capUnknown
    ? `${allowance.providerId || 'provider'} has no known cap and is wall-clock paced; the slot is not open yet`
    : `${allowance.providerId || 'provider'} is at ${allowance.callsToday ?? '?'} calls against a ${allowance.softStop ?? '?'} soft stop (60% of ${allowance.cap ?? '?'})`;

  return {
    proceed: false,
    reason,
    stopBecause: `${reason}: ${detail}. This ends the shift${phase ? ` on phase "${phase}"` : ''}; it is not an error and it is NOT a reason to escalate to a paid tier — that needs the owner's explicit approval at the time.`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * REFUSALS — one line, written when it happens
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Owner instruction, 2026-08-10, delivered mid-build and deliberately scoped to
 * one line rather than a system:
 *
 *   > Whatever records a run must also record refusals, in this shape:
 *   >     refusal: <who> declined <what>, and the line of their character it
 *   >     came from
 *
 * ── WHY IT COULD NOT WAIT FOR THE SECOND RUN ─────────────────────────────
 *
 * A refusal that is not recorded when it happens cannot be recovered
 * afterwards. Reconstructing one later produces something that READS AS
 * EVIDENCE AND IS AN INVENTION — which is strictly worse than an admitted gap,
 * and is the same failure this project has recorded under "a confident
 * invention reads as history". So this landed before the lifecycle's first
 * record was written, not after its first run.
 *
 * ── WHY THE CHARACTER LINE IS NOT OPTIONAL ───────────────────────────────
 *
 * Without it, `Agent 6 declined the draft` is a log line: it says a process
 * fired. With it, it is evidence that a CHARACTER did something — the QA
 * refused because refusing is what that persona is, and the bible says so in a
 * sentence somebody can go and read. That is the difference between an audit
 * trail of a state machine and a record of an office.
 *
 * So `recordRefusal()` REFUSES a refusal with no character line, and the
 * refusal-to-record is returned to the caller rather than swallowed. It
 * deliberately does not fall back to a generic line: a plausible sentence
 * attributed to a persona that never said it is the invention this exists to
 * prevent, aimed at the bible.
 *
 * ── WHAT THIS CAPTURES ───────────────────────────────────────────────────
 *
 * A QA rejecting a deliverable. An Architect returning work. The Workflow
 * flagging a missed metric line. A CEO declining to approve. Each is one line.
 * Unrecorded, each is gone.
 *
 * It is stored on the same record, in the same file, written by the same
 * writer — `refusals: []` beside `reviews`, `gaps` and `votes`. No new store,
 * no new token, no second source of truth.
 */

/**
 * @param {object} r  {who, declined, characterLine, at, source}
 *   who           — the persona, named as a person: "Agent 6 — The QA".
 *   declined      — what they refused, in their own terms.
 *   characterLine — the line of their character it came from, quoted.
 *   source        — where that line lives, so a reader can check it.
 */
export function recordRefusal(r = {}) {
  const who = String(r.who || '').trim();
  const declined = String(r.declined || '').trim();
  const line = String(r.characterLine || '').trim();

  if (!who) return { ok: false, reason: 'a refusal must name who refused — "the office declined" is a process event, not a character acting' };
  if (!declined) return { ok: false, reason: 'a refusal must name what was declined' };
  if (!line) {
    return {
      ok: false,
      reason: 'a refusal must carry the line of the refuser\'s character it came from, and it CANNOT be supplied later — '
        + 'a character line back-filled after the fact reads as evidence and is an invention. Quote the bible or the '
        + 'persona\'s character file at the moment of the refusal, or record no refusal and say that instead.',
    };
  }
  return { ok: true, refusal: { who, declined, character_line: line, source: r.source || null, at: r.at || null } };
}

/** The one line, in the owner's shape. Nothing else renders a refusal. */
export function renderRefusal(refusal = {}) {
  return `refusal: ${refusal.who} declined ${refusal.declined}, and the line of their character it came from: "${refusal.character_line}"`
    + (refusal.source ? ` (${refusal.source})` : '');
}

export function refusalsOf(record = {}) {
  return Array.isArray(record.refusals) ? record.refusals : [];
}

/**
 * The four moments in this lifecycle that ARE refusals, named here so a caller
 * cannot record three of them and quietly miss the fourth. Each maps to a
 * decision this module already models; none of them is a new event.
 *
 * `detectRefusals()` reads a record and returns the refusals that SHOULD exist
 * for the declines it can see. It returns `missing` for any it cannot find —
 * and `missing` is a defect report, NOT a template to fill in. The line has to
 * come from the moment; this function only proves that a moment went
 * unrecorded.
 */
export const REFUSAL_MOMENTS = Object.freeze([
  'review_rejected',      // a reviewer's verdict was reject/return
  'gap_raised',           // a reviewer refused to pass something — a raised gap IS a refusal
  'vote_against',         // an admin voted against a binding decision
  'ceo_declined',         // the CEO did not approve
]);

export function detectRefusals(record = {}) {
  const have = refusalsOf(record);
  const seen = new Set(have.map((x) => x.moment).filter(Boolean));
  const missing = [];

  const round = record.round ?? 0;
  for (const rev of (record.reviews || [])) {
    if (rev.verdict === 'reject' || rev.verdict === 'return') {
      const key = `review_rejected:${rev.agent_id}:${rev.round ?? 0}`;
      if (!seen.has(key)) missing.push({ moment: key, what: `Agent ${rev.agent_id} returned round ${rev.round ?? 0} and no refusal line was recorded at the time` });
    }
  }
  // ── ONE REVIEW IS ONE REFUSAL, NOT ONE PER GAP ─────────────────────────
  //
  // Corrected 2026-08-10, on the first real run: the QA's round-0 review of
  // office-site raised EIGHT gaps in one act, and the first cut of this
  // function reported eight unrecorded refusals against a review that had
  // recorded its refusal line properly. The owner's instruction is *each is one
  // line* — a QA rejecting a deliverable is ONE refusal, whatever the gap count.
  //
  // A gap raised WITHOUT a rejecting review behind it is still its own moment,
  // and that is the case worth keeping: the Workflow flagging a missed metric
  // line is a refusal nobody wrote a review for.
  const coveredBy = new Set(
    have.filter((x) => /^review_rejected:/.test(x.moment || ''))
      .map((x) => x.moment.split(':').slice(1).join(':'))
  );
  for (const g of (record.gaps || [])) {
    if (!g.raised_by) continue;
    const gapRound = g.round ?? round;
    if (coveredBy.has(`${g.raised_by}:${gapRound}`)) continue;
    const key = `gap_raised:${g.id}`;
    if (!seen.has(key)) missing.push({ moment: key, what: `gap ${g.id} was raised by Agent ${g.raised_by} outside any rejecting review, and no refusal line was recorded at the time` });
  }
  for (const v of (record.votes || [])) {
    for (const c of (v.votes || [])) {
      if (String(c.choice).toLowerCase() === 'against') {
        const key = `vote_against:${v.id || v.question}:${c.agent_id}`;
        if (!seen.has(key)) missing.push({ moment: key, what: `Agent ${c.agent_id} voted against "${v.question}" and no refusal line was recorded at the time` });
      }
    }
  }
  if (record.approval && record.approval.decision && record.approval.decision !== 'approve') {
    const key = `ceo_declined:${record.approval.at || 'undated'}`;
    if (!seen.has(key)) missing.push({ moment: key, what: `the CEO's decision was "${record.approval.decision}" and no refusal line was recorded at the time` });
  }

  return {
    recorded: have.length,
    missing,
    // Stated rather than implied: this is a report that a moment passed
    // unrecorded. It is not recoverable, and nothing here should write one.
    note: missing.length
      ? 'These refusals were NOT recorded when they happened and cannot be reconstructed. Record the gap; do not write the line now — a character line supplied after the fact is an invention that reads as evidence.'
      : null,
    round,
  };
}

/* ─────────────────────── The board's Stage: projection ─────────────────── */

/**
 * The one line the board carries for a deliverable.
 *
 *   - **Stage:** IN-REVIEW · round 1 · waiting on the assigned reviewers · warehouse `tasks/office-site/`
 *
 * Same grammar as `Dispatched:` and `Offered:` — a `- **Field:** value` line
 * inside the task block. And the same rule: **it is not a state and moves no
 * state count.** `State:` stays the one thing that decides what a task is. A
 * deliverable in IN-REVIEW is still an IN-PROGRESS board task, because the
 * office still owes work on it.
 */
export function renderStageLine(record = {}) {
  const stage = record.stage;
  const holder = STAGE_HOLDER[stage] || 'unknown';
  const parts = [stage, `round ${record.round ?? 0}`, `waiting on ${holder}`];
  if (record.slug) parts.push(`warehouse \`tasks/${record.slug}/\``);
  const conv = convergenceFinding(record);
  if (conv.concern) parts.push('NOT CONVERGING — see the meeting agenda');
  return `- **Stage:** ${parts.join(' · ')}`;
}

/**
 * Reads a `Stage:` value back. REFUSES an unreadable stage rather than
 * defaulting, exactly as `parseBoard()` refuses an unreadable `State:` — a
 * deliverable silently reported as BUILDING when it is AWAITING-APPROVAL is a
 * status the next meeting would "correct" in the wrong direction.
 */
export function parseStageValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, reason: 'empty Stage value' };
  const stage = raw.split('·')[0].replace(/\*\*/g, '').trim();
  if (!STAGES.includes(stage)) return { ok: false, reason: `unreadable Stage "${stage}" — expected one of ${STAGES.join(', ')}` };
  const roundM = /round\s+(\d+)/i.exec(raw);
  const slugM = /tasks\/([A-Za-z0-9._-]+)\//.exec(raw);
  return {
    ok: true,
    stage,
    round: roundM ? Number(roundM[1]) : 0,
    slug: slugM ? slugM[1] : null,
    notConverging: /NOT CONVERGING/.test(raw),
    holder: STAGE_HOLDER[stage],
  };
}

/* ═══════════════ The office-readable digest: IN-FLIGHT.md ═══════════════
 *
 * The board's `Stage:` line is one line, and one line cannot carry seventeen
 * gaps. The meeting needs the gaps themselves — *gaps go to a meeting* is the
 * owner's instruction and a meeting handed a COUNT cannot act on it.
 *
 * So there is a second projection, in back-office where the Worker CAN read:
 * `campus/shared/lifecycle/IN-FLIGHT.md`, rewritten WHOLESALE from every
 * warehouse record on every writing run of `scripts/lifecycle.mjs`.
 *
 * ── WHY WHOLESALE, AND WHY ONE FILE ──────────────────────────────────────
 *
 * One file so the office spends ONE GitHub round-trip per context refresh
 * rather than one per deliverable — the same reasoning `office-context.js`'s
 * cache already applies to the board.
 *
 * Wholesale so a deliverable that reached CLIENT-READY DISAPPEARS from the file
 * rather than lingering as a stale section. An append-only digest would grow a
 * tail of finished work that every meeting would keep reading as in flight.
 *
 * ── TWO PROJECTIONS OF ONE RECORD IS NOT THE DRIFT THIS PROJECT HATES ────
 *
 * Stated plainly because it looks like it: the board line and this file are
 * both derived from the same `STATE.json`, both written by the same tool in the
 * SAME act, and both declare the warehouse authoritative. Neither is ever
 * written by anything else. The drift this project has been burned by is two
 * things maintained SEPARATELY that are supposed to agree; these two cannot be
 * maintained separately, because there is no code path that writes one without
 * the other.
 */

export const IN_FLIGHT_PATH = 'campus/shared/lifecycle/IN-FLIGHT.md';

export function renderInFlightFile(records = [], { at = null } = {}) {
  const live = records.filter((r) => IN_FLIGHT_STAGES.includes(r.stage));
  const head = [
    '# DELIVERABLES IN FLIGHT',
    '',
    '**Classification:** private · **Derived — do not hand-edit.**',
    '',
    '> Rewritten WHOLESALE by `office-AI-agents/scripts/lifecycle.mjs` on every run,',
    '> from each warehouse task\'s own `STATE.json`. **The warehouse record is',
    '> authoritative**; if this file and it disagree, this file is the stale one and',
    '> the next run of that tool fixes it. It exists because the live Worker cannot',
    '> read the warehouse — `WAREHOUSE_REPO_TOKEN` is deliberately unset — and a',
    '> meeting handed a gap COUNT cannot act on it.',
    '',
    `*(Generated ${at || 'undated'} · ${live.length} in flight)*`,
    '',
  ];
  if (!live.length) {
    head.push('No deliverable is currently in the review loop.', '');
    return head.join('\n');
  }

  const out = [...head];
  for (const r of live) {
    const na = nextAction(r);
    const cov = reviewerCoverage(r);
    const conv = convergenceFinding(r);
    out.push(`## ${r.slug}${r.board_task ? ` — ${r.board_task}` : ''}`, '');
    out.push(`- **Stage:** ${r.stage}`);
    out.push(`- **Round:** ${r.round ?? 0}`);
    out.push(`- **Waiting on:** ${STAGE_HOLDER[r.stage]}`);
    out.push(`- **Next:** ${na.say}`);
    out.push(`- **Owed by:** ${cov.missing.length ? cov.missing.map((m) => m.agentId).join(', ') : 'nobody — this round is fully covered'}`);
    out.push(`- **Required reviewers:** ${(r.reviewer_set?.required || []).join(', ') || 'none composed'}`);
    out.push(`- **Open gaps:** ${openGaps(r).length} (${bindingGapsAwaitingVote(r).length} awaiting a vote, ${unclassifiedGaps(r).length} unclassified)`);
    out.push(`- **Converging:** ${conv.concern ? `NO — ${conv.signals.join('; ')}` : 'no concern'}`);
    for (const g of openGaps(r)) {
      out.push(`- **Gap:** ${g.id} [${gapClass(g)}]${g.raised_by ? ` raised by Agent ${g.raised_by}` : ''} — ${g.title || g.text || '(no text)'}`);
    }
    for (const x of refusalsOf(r)) out.push(`- **Refusal:** ${renderRefusal(x)}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Reads IN-FLIGHT.md back into records the prompt renderers can use.
 *
 * REFUSES rather than guesses, the posture `parseBoard()` sets: a section whose
 * `Stage:` cannot be read is reported as malformed and does not reach the
 * office. A deliverable silently reported as BUILDING when it is
 * AWAITING-APPROVAL is a status the next meeting would correct in the wrong
 * direction.
 */
export function parseInFlight(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, reason: 'in-flight markdown was empty or not a string' };
  }
  const headingRe = /^## ([A-Za-z0-9._-]+)(?: — (OB-\d{3}))?\s*$/gm;
  const starts = [];
  let m;
  while ((m = headingRe.exec(markdown)) !== null) starts.push({ slug: m[1], task: m[2] || null, index: m.index });

  // An EMPTY file is legitimate and healthy — the office has nothing in the
  // loop. It is not a parse failure, and reporting it as one would put a
  // spurious error into every prompt for as long as that were true.
  if (!starts.length) return { ok: true, records: [], counts: { total: 0 }, malformed: [] };

  const field = (block, name) => {
    const r = new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'm');
    const x = block.match(r);
    return x ? x[1].trim() : null;
  };
  const allFields = (block, name) => {
    const r = new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'gm');
    const out = [];
    let x;
    while ((x = r.exec(block)) !== null) out.push(x[1].trim());
    return out;
  };

  const records = [];
  const malformed = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : markdown.length;
    const block = markdown.slice(starts[i].index, end);
    const stage = field(block, 'Stage');
    if (!stage || !STAGES.includes(stage)) {
      malformed.push(`${starts[i].slug}: unreadable Stage ("${stage ?? 'absent'}")`);
      continue;
    }
    const gapsRaw = field(block, 'Open gaps') || '';
    const gm = /^(\d+)\s*\((\d+) awaiting a vote, (\d+) unclassified\)/.exec(gapsRaw);
    records.push({
      slug: starts[i].slug,
      board_task: starts[i].task,
      stage,
      round: Number((field(block, 'Round') || '0').replace(/\D/g, '')) || 0,
      waiting_on: field(block, 'Waiting on'),
      next: field(block, 'Next'),
      owed_by: (field(block, 'Owed by') || '').match(/\d+/g)?.map(Number) || [],
      required: (field(block, 'Required reviewers') || '').match(/\d+/g)?.map(Number) || [],
      open_gaps: gm ? Number(gm[1]) : 0,
      awaiting_vote: gm ? Number(gm[2]) : 0,
      unclassified: gm ? Number(gm[3]) : 0,
      converging: !/^NO/.test(field(block, 'Converging') || ''),
      convergence_note: /^NO/.test(field(block, 'Converging') || '') ? field(block, 'Converging') : null,
      gaps: allFields(block, 'Gap'),
      refusals: allFields(block, 'Refusal'),
    });
  }
  if (!records.length) return { ok: false, reason: `found ${starts.length} section(s) but none had a readable Stage — ${malformed.join('; ')}` };
  return { ok: true, records, counts: { total: records.length }, malformed };
}

/* ─────────────── Prompt rendering, from the parsed digest ──────────────── */

/**
 * The three prompt blocks the office needs, built from `parseInFlight()`'s
 * records rather than from the full warehouse record — because the Worker only
 * ever has the digest.
 *
 * Returned as item lists so `fitToBudget()` can shrink them by item, never
 * below one, never with a silent cap.
 */
export function inFlightSections(records = [], { names = {} } = {}) {
  const out = { flight: null, assignments: null, agenda: null };
  if (!records.length) {
    out.flight = { header: 'DELIVERABLES IN FLIGHT — none. No built deliverable is currently in the review loop.', items: [] };
    return out;
  }

  out.flight = {
    header: `DELIVERABLES IN FLIGHT — ${records.length}. These are things the office has BUILT and is carrying through review to a version it can show the client. A board task can be IN-PROGRESS while its deliverable sits in review; the two are different facts`,
    items: records.map((r) => `- ${r.slug}${r.board_task ? ` (${r.board_task})` : ''} [${r.stage}, round ${r.round}] waiting on ${r.waiting_on}${r.open_gaps ? ` — ${r.open_gaps} open gap(s), ${r.awaiting_vote} awaiting a vote` : ''}${r.converging ? '' : ` — ${r.convergence_note}`}`),
  };

  const assigns = [];
  for (const r of records) {
    if (r.stage !== 'IN-REVIEW') continue;
    for (const id of r.owed_by) {
      assigns.push(`- Agent ${id}${names[id] ? ` — ${names[id]}` : ''}: ${r.required.includes(id) ? 'FULL REASONED REVIEW' : 'a brief comment OR an explicit abstention'} of \`${r.slug}\` (round ${r.round}).`);
    }
  }
  if (assigns.length) {
    out.assignments = {
      header: `ASSIGN THIS REVIEW WORK NOW, by name, the same way you assign any other task — reviewing is work, not a courtesy someone performs when they notice. An admin who has nothing to say ABSTAINS EXPLICITLY and the abstention is recorded. SILENCE IS NEVER APPROVAL`,
      items: assigns,
    };
  }

  const agenda = [];
  for (const r of records) {
    if (r.stage !== 'GAPS-RAISED' && r.stage !== 'IN-DISCUSSION') continue;
    for (const g of r.gaps) agenda.push(`- ${r.slug} ${g}`);
    if (r.unclassified) agenda.push(`- ${r.slug}: ${r.unclassified} gap(s) carry NO CLASS. Class each binding or routine BEFORE acting on it — an unclassified gap treated as routine is a client-touching decision that skipped its vote.`);
    if (r.awaiting_vote) agenda.push(`- ${r.slug}: ${r.awaiting_vote} binding gap(s) need a RECORDED VOTE before anything moves. Admins only; the CEO leads with a double vote and a veto.`);
    if (!r.converging) agenda.push(`- ${r.slug}: ${r.convergence_note}. This is a FINDING for this meeting, not a reason to stop or to ship it — there is no cap on rounds.`);
  }
  if (agenda.length) {
    out.agenda = {
      header: 'GAPS RAISED IN REVIEW, FOR THIS MEETING TO DECIDE. A gap becomes a decision here, not in a message back to whoever built it',
      items: agenda,
    };
  }
  return out;
}

/* ──────────────────────────── Prompt rendering ─────────────────────────── */

/**
 * "What is in flight, at what stage, and what is waiting on a vote."
 *
 * Returned as an ITEM LIST rather than a blob, so `office-context.js`'s
 * `fitToBudget()` can shrink it by item the way it shrinks the board — never
 * below one item, and never with a silent cap. A deliverable list that says
 * "3 in flight" while showing one of them, without saying so, is the same
 * failure `renderSection()` already refuses.
 */
export function renderInFlight(records = [], { names = {} } = {}) {
  const live = records.filter((r) => IN_FLIGHT_STAGES.includes(r.stage));
  const ready = records.filter((r) => r.stage === 'CLIENT-READY');

  const header = live.length
    ? `DELIVERABLES IN FLIGHT — ${live.length}. These are things the office has BUILT and is carrying through review. They are not board tasks and not cases; a board task can be IN-PROGRESS while its deliverable sits in review.`
    : 'DELIVERABLES IN FLIGHT — none. No built deliverable is currently in the review loop.';

  const items = live.map((r) => {
    const na = nextAction(r);
    const votes = bindingGapsAwaitingVote(r).length;
    const conv = convergenceFinding(r);
    return `- ${r.slug || r.board_task || 'unnamed'}${r.board_task ? ` (${r.board_task})` : ''} [${r.stage}, round ${r.round ?? 0}] — ${na.say}`
      + (votes ? ` AWAITING A VOTE on ${votes} binding gap(s).` : '')
      + (conv.concern ? ` NOT CONVERGING: ${conv.signals.join('; ')}.` : '');
  });

  const tail = ready.length
    ? [`- ${ready.length} deliverable(s) are CLIENT-READY (CEO-approved): ${ready.map((r) => r.slug).join(', ')}.`]
    : [];

  return { header, items: [...items, ...tail], count: live.length, readyCount: ready.length };
}

/**
 * The morning meeting's review assignments, rendered as instructions rather
 * than as a status list.
 *
 * ── WHY THIS IS AN ASSIGNMENT AND NOT A NOTICE ───────────────────────────
 *
 * Owner-stated: *admins are assigned review tasks in the morning meeting, the
 * same way any other work is assigned — reviewing is work, not a courtesy
 * someone performs when they notice.* A prompt that lists what is in review
 * produces a meeting that observes; a prompt that names an agent and what he
 * owes produces one that assigns. The difference is entirely in the wording,
 * which is why the wording is here and not left to the meeting's own phrasing.
 */
export function renderReviewAssignments(records = [], { names = {} } = {}) {
  const rows = [];
  for (const r of records) {
    if (!IN_FLIGHT_STAGES.includes(r.stage)) continue;
    const na = nextAction(r);
    if (na.action !== 'assign_reviews') continue;
    const cov = reviewerCoverage(r);
    const req = new Set(r.reviewer_set?.required || []);
    for (const m of cov.missing) {
      const who = `Agent ${m.agentId}${names[m.agentId] ? ` — ${names[m.agentId]}` : ''}`;
      rows.push(`- ${who}: ${req.has(m.agentId) ? 'FULL REASONED REVIEW' : 'brief comment OR an explicit abstention'} of \`${r.slug}\` (round ${r.round ?? 0}).`);
    }
  }
  if (!rows.length) return { header: null, items: [] };
  return {
    header: `ASSIGN THIS REVIEW WORK NOW, by name, the same way you assign any other task — reviewing is work, not a courtesy. The Workflow (Agent ${COMPOSER_AGENT_ID}) composed each set; an admin who has nothing to say ABSTAINS EXPLICITLY, and the abstention is recorded. Silence is never approval`,
    items: rows,
  };
}

/**
 * Gaps that are waiting for a meeting — the agenda items the loop produces.
 *
 * Owner-stated: *gaps go to a meeting, not straight back to the builder. The
 * meeting is where a gap becomes a decision.*
 */
export function renderGapAgenda(records = []) {
  const items = [];
  for (const r of records) {
    if (r.stage !== 'GAPS-RAISED' && r.stage !== 'IN-DISCUSSION') continue;
    for (const g of openGaps(r)) {
      const cls = gapClass(g);
      const suffix = cls === 'binding'
        ? ' — BINDING: this needs a recorded vote (admins only; the CEO leads with a double vote and a veto).'
        : cls === 'routine'
          ? ' — routine: decide it in the room, no vote needed.'
          : ' — UNCLASSIFIED: the meeting must class this binding or routine BEFORE acting on it. An unclassified gap treated as routine is a client-touching decision that skipped its vote.';
      items.push(`- ${r.slug} ${g.id}: ${g.title || g.text || '(no text recorded)'}${g.raised_by ? ` (raised by Agent ${g.raised_by})` : ''}${suffix}`);
    }
    const conv = convergenceFinding(r);
    if (conv.concern) items.push(`- ${r.slug}: ${conv.say}`);
  }
  if (!items.length) return { header: null, items: [] };
  return {
    header: 'GAPS RAISED IN REVIEW, FOR THIS MEETING TO DECIDE. A gap becomes a decision here, not in a message back to whoever built it',
    items,
  };
}

/* ─────────────────────────── Record construction ───────────────────────── */

/**
 * A fresh lifecycle record. `stage` starts at BUILDING even for a deliverable
 * whose phases are already complete — the BUILDING → IN-REVIEW guard is what
 * establishes that they are, and starting anywhere else would let a record be
 * born past its own first check.
 */
export function newRecord({ slug, boardTask = null, type = 'warehouse-build', touches = [], roster = null, at = null } = {}) {
  if (!String(slug || '').trim()) return { ok: false, reason: 'a lifecycle record must name the warehouse task slug it belongs to' };
  const set = composeReviewerSet({ type, touches }, { roster });
  return {
    ok: true,
    record: {
      slug: String(slug),
      board_task: boardTask,
      type,
      stage: 'BUILDING',
      round: 0,
      opened: at,
      reviewer_set: set,
      reviews: [],
      gaps: [],
      votes: [],
      round_history: [],
      recommendation: null,
      approval: null,
      // Present from the record's first moment, deliberately. A refusals array
      // added later would have a birthday, and every refusal before it would be
      // unrecoverable — see the REFUSALS section.
      refusals: [],
      shift: null,
      transitions: [],
      build_completed: [],
    },
    warnings: set.warnings,
  };
}

/** Applies a transition after `canAdvance()` allowed it, appending the audit
 *  row. The audit row is not decoration: `round_history` and the transition log
 *  are what `convergenceFinding()` reads, and a stage change that left no trace
 *  would make non-convergence undetectable. */
export function applyTransition(record, to, { at = null, by = null, note = null, meetingId = null } = {}) {
  const next = { ...record, stage: to };
  next.transitions = [...(record.transitions || []), { from: record.stage, to, at, by, note, meeting: meetingId }];
  if (to === 'IN-REVIEW' && record.stage === 'IMPROVING') {
    next.round = (record.round ?? 0) + 1;
  }
  if (to === 'IMPROVING') {
    next.round_history = [...(record.round_history || []), {
      round: record.round ?? 0,
      open_gaps_at_close: openGaps(record).length,
      closed_at: at,
    }];
  }
  return next;
}
