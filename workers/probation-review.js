/**
 * workers/probation-review.js — OFFICE-POLICY.md A3, the DECISION half.
 *
 * Pure decision logic only — no env, no fetch, no D1 — imports nothing, the
 * same deliberate shape as deliverable-lifecycle.js (see that file's header
 * for why: it is what lets `scripts/verify-learning-loop.js` exercise every
 * scenario with plain `node` and no live Worker). `workers/probation.js`
 * calls `applyDecision()`/`applyMissedMeetingFall()` to make an already-VALID
 * decision take effect; this module is where a decision becomes valid in the
 * first place.
 *
 * ── THE THREE MECHANISMS THIS FILE COVERS ──────────────────────────────────
 *
 * 1. recordDecision()      — the short meeting of three. Team Lead presents
 *                             behaviour, QA presents quality, Lead QA decides
 *                             on both axes. kept | dropped | extended.
 * 2. meetingMissedFalls()  — if the meeting didn't happen by the time the
 *                             20-action window closed, the change FALLS
 *                             (reverts) and is routed back to the three
 *                             reviewers as a PROCESS failure, not a verdict
 *                             on the change itself.
 * 3. reviewTheReviewers()  — two of the three review the third; the CEO
 *                             decides, with the Architect present for
 *                             technical opinion only.
 * 4. canBlameProvider()    — the threshold for attributing a failure to the
 *                             provider rather than the agent: three agents,
 *                             or three days, PLUS an embodiment comparison.
 *                             Below threshold it is a suspicion, never a
 *                             conclusion.
 */

export const REVIEWERS = Object.freeze({ QA: 6, TEAM_LEAD: 7, LEAD_QA: 8 });
export const CEO_ID = 11;
export const ARCHITECT_ID = 10;

export const DECISION_OUTCOMES = Object.freeze(['kept', 'dropped', 'extended']);

/**
 * Validates and shapes one decision. Refuses rather than defaults on
 * anything A3 requires by name:
 *   - the Lead QA (8), and only the Lead QA, decides
 *   - both axes must be presented — behaviour (Team Lead) AND quality (QA)
 *   - the outcome must be one of the three named ones
 *   - evidence must be shown — "not persuasion, evidence"
 *
 * @param {{probationId:string, teamLeadBehavior:string, qaQualityMetrics:string,
 *          decidedBy:number, outcome:'kept'|'dropped'|'extended', evidence:object}} r
 */
export function recordDecision({ probationId, teamLeadBehavior, qaQualityMetrics, decidedBy, outcome, evidence }) {
  if (!probationId) return { valid: false, reason: 'probationId is required' };
  if (decidedBy !== REVIEWERS.LEAD_QA) {
    return { valid: false, reason: `only the Lead QA (${REVIEWERS.LEAD_QA}) decides, on both axes together (A3) — got decider ${decidedBy}` };
  }
  if (!teamLeadBehavior || !String(teamLeadBehavior).trim()) {
    return { valid: false, reason: 'missing the Team Lead\'s behaviour presentation — the meeting requires both axes, not the Lead QA deciding alone' };
  }
  if (!qaQualityMetrics || !String(qaQualityMetrics).trim()) {
    return { valid: false, reason: 'missing the QA\'s quality-metrics presentation — the meeting requires both axes, not the Lead QA deciding alone' };
  }
  if (!DECISION_OUTCOMES.includes(outcome)) {
    return { valid: false, reason: `outcome must be one of ${DECISION_OUTCOMES.join('|')}, got "${outcome}"` };
  }
  if (!evidence || typeof evidence !== 'object' || !Object.keys(evidence).length) {
    return { valid: false, reason: 'a decision with no evidence shown is not a decision A3 recognizes — "not persuasion, evidence"' };
  }

  return {
    valid: true,
    decision: {
      probationId,
      outcome,
      decidedBy,
      teamLeadBehavior: String(teamLeadBehavior).trim(),
      qaQualityMetrics: String(qaQualityMetrics).trim(),
      evidence,
    },
  };
}

/**
 * Whether a probation that has reached its action target and has NOT had a
 * meeting held falls. This is a pure predicate — probation.js's
 * applyMissedMeetingFall() is what actually reverts the file; this function
 * only decides whether that call is warranted, so a caller can check without
 * side effects (e.g. a daily sweep reporting what is about to fall before it
 * does).
 *
 * "If the meeting does not happen, the change falls — the default is
 * reversion, because silence must never read as approval. And the fall is
 * routed back: the Workflow surfaces it, treats it as a process failure
 * rather than a change failure, and returns the item to the three
 * reviewers." (A3)
 */
export function meetingMissedFalls({ actionCount, target, meetingHeld }) {
  if (meetingHeld) return { falls: false };
  if (typeof actionCount !== 'number' || typeof target !== 'number') {
    return { falls: false, reason: 'actionCount and target must be numbers' };
  }
  if (actionCount < target) return { falls: false, reason: 'not yet due — action_count has not reached the measurement window' };
  return {
    falls: true,
    outcome: 'fell',
    failureKind: 'process',
    reason: 'no decision meeting was held by the time the measurement window closed — silence must never read as approval (A3)',
    routedBackTo: [REVIEWERS.QA, REVIEWERS.TEAM_LEAD, REVIEWERS.LEAD_QA],
  };
}

/**
 * "Reviewing the reviewers." Two of the three review the third. The CEO
 * decides, with the Architect present for technical opinion — opinion, not
 * verdict; he is outside the education loop entirely. Any change to one of
 * the three reviewers is reported to the owner in the weekly report, for
 * visibility, not approval.
 */
export function reviewTheReviewers({ flaggedReviewer, reviewingPair, decidedBy, architectOpinion }) {
  const all = [REVIEWERS.QA, REVIEWERS.TEAM_LEAD, REVIEWERS.LEAD_QA];
  if (!all.includes(flaggedReviewer)) {
    return { valid: false, reason: `flaggedReviewer must be one of the three reviewers (${all.join(', ')}) — got ${flaggedReviewer}` };
  }
  const expectedPair = all.filter((id) => id !== flaggedReviewer);
  const gotPair = [...(reviewingPair || [])].sort((a, b) => a - b);
  if (JSON.stringify(gotPair) !== JSON.stringify(expectedPair)) {
    return { valid: false, reason: `exactly the other two reviewers (${expectedPair.join(', ')}) review the flagged one — got ${JSON.stringify(reviewingPair)}` };
  }
  if (decidedBy !== CEO_ID) {
    return { valid: false, reason: `the CEO (${CEO_ID}) decides — got ${decidedBy}` };
  }

  return {
    valid: true,
    record: {
      flaggedReviewer,
      reviewingPair: expectedPair,
      decidedBy: CEO_ID,
      // Opinion, not verdict — the Architect is outside the education loop
      // entirely (A3) and this field is never treated as a vote.
      architectOpinion: architectOpinion ? String(architectOpinion).trim() : null,
      mustReportToOwnerInWeeklyReport: true,
    },
  };
}

/**
 * The provider-blame threshold. "Blaming the provider rather than the agent
 * requires: the same failure across three different agents, or the same
 * action failing on three different days, plus an embodiment comparison —
 * the same task on a different provider. Without that it is recorded as a
 * suspicion, never a conclusion. Agents may not take the easy answer." (A3)
 *
 * @param {{failingAgentIds:number[], failingDates:string[], embodimentComparisonDone:boolean}} r
 *   failingAgentIds — distinct agents that hit the SAME failure.
 *   failingDates    — distinct days the SAME action failed (single-agent case).
 *   embodimentComparisonDone — whether the same task was actually run through
 *     a different provider and compared, not merely asserted.
 */
export function canBlameProvider({ failingAgentIds = [], failingDates = [], embodimentComparisonDone = false }) {
  const threeAgents = new Set(failingAgentIds).size >= 3;
  const threeDays = new Set(failingDates).size >= 3;

  if (!embodimentComparisonDone) {
    return {
      canBlame: false,
      verdict: 'suspicion',
      reason: 'no embodiment comparison was run — the same task on a different provider. Without it this is a suspicion, never a conclusion (A3).',
    };
  }
  if (!threeAgents && !threeDays) {
    return {
      canBlame: false,
      verdict: 'suspicion',
      reason: `neither three different agents (got ${new Set(failingAgentIds).size}) nor the same action failing on three different days (got ${new Set(failingDates).size}) — A3's threshold is not met`,
    };
  }
  return {
    canBlame: true,
    verdict: 'conclusion',
    basis: threeAgents ? 'three_different_agents' : 'three_different_days',
  };
}
