/**
 * workers/meeting-attendance.js — THE ATTRIBUTION GATE.
 *
 * Audit 2026-08-15, finding #1: a meeting's `## Attendees` header has always
 * been truthful (rendered from `resolveAttendeeIds()`), while the transcript
 * BODY is unvalidated model text. Nothing reconciled the two. A degraded
 * fallback provider, handed three personas and a thirteen-name roster, voiced
 * all thirteen — and one invented line became a real board task (OB-067,
 * assigned to Agent 9 off a review she did not attend).
 *
 * ── WHY THE FILE IS STILL CALLED meeting-attendance.js  (2026-08-15, OB-075) ─
 *
 * It started as the meeting gate and it is now the office's ONE attribution
 * gate: `checkAttribution()` below is the whole mechanism, and everything else
 * here and in `workers/deliverable-lifecycle.js` is that one function handed a
 * different pair of lists. Meeting transcripts were merely the first artifact
 * caught asserting participation that did not happen; vote tallies, review
 * records, lifecycle sign-offs and the CEO approval that turns a deliverable
 * CLIENT-READY are written by the same class of mechanism and were, until
 * OB-075, ungated.
 *
 * The file keeps its name deliberately. It is cited by path in
 * `docs/KNOWN-FAILURE-MODES.md` KFM-01, in the 35 corrected transcripts, in
 * `config/capability-manifest.json` and in the gate-call audit's registry; a
 * rename would silently invalidate every one of those references to buy a
 * better name. The module doc is the honest place to record the widened scope.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────
 *
 * It IMPORTS NOTHING — the roster is passed in rather than read from
 * `config/agents-config.json`. That is the same split `workers/task-router.js`
 * made from `model-router.js`, and for the same reason: a module that imports
 * JSON cannot be loaded by plain `node`, so its verifier could only ever
 * regex the source instead of calling the function. A gate this consequential
 * has to be *executed* by its tests, not pattern-matched.
 */

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE MECHANISM. Every gate in this project that asks "did this agent really
 * do this?" is this function with different arguments.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * KFM-01 asks two questions of any artifact recording who did something, and
 * they are DIFFERENT questions with different remedies, so they are returned
 * separately rather than merged into one refusal count:
 *
 *   `unknown`          — the named agent is not on the roster at all. It does
 *                        not exist and nothing runs as it. Remedy: the artifact
 *                        is fiction, or the roster is stale.
 *   `nonParticipants`  — the agent exists, and was not on THIS artifact's own
 *                        declared participant list. Remedy: either the agent
 *                        did not do this, or the participant list is wrong.
 *
 * An empty roster means "the caller did not supply one", and existence is then
 * NOT checked — reported by `rosterChecked: false` rather than passed off as a
 * clean result. Collapsing "checked and fine" into "not checked" is KFM-13's
 * defect, and a gate committing it would be the fourth instance in this file's
 * own history.
 *
 * @param {Array<number|string>} namedIds  who the artifact says acted
 * @param {Array<number>} declaredIds      who the artifact's own header says could
 * @param {Array<{id:number}>|Array<number>} [roster]  every agent that exists
 * @returns {{ok:boolean, named:number[], unknown:number[], nonParticipants:number[], rosterChecked:boolean}}
 */
export function checkAttribution(namedIds, declaredIds, roster = []) {
  const declared = new Set((declaredIds || []).map(Number).filter(Number.isInteger));
  const known = new Set(
    (roster || []).map((a) => Number(typeof a === 'object' && a !== null ? a.id : a)).filter(Number.isInteger),
  );
  const named = [...new Set((namedIds || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b);

  const rosterChecked = known.size > 0;
  const unknown = rosterChecked ? named.filter((id) => !known.has(id)) : [];
  const unknownSet = new Set(unknown);
  const nonParticipants = named.filter((id) => !unknownSet.has(id) && !declared.has(id));

  return { ok: unknown.length === 0 && nonParticipants.length === 0, named, unknown, nonParticipants, rosterChecked };
}

/**
 * The agent ids a free-text attribution string claims.
 *
 * A lifecycle sign-off's `by` and a refusal's `who` are prose, not ids — the
 * live records hold `"10 (Architect, this session)"` and `"Agent 6 — The QA"`
 * alongside the honest `"supervised lifecycle session"`. The first two ASSERT
 * an agent acted and are checkable; the third asserts nothing about any agent
 * and must not be refused for it. So this returns the ids a string actually
 * claims, and an empty result means "this text names no agent" — which the
 * callers treat as unattributed, never as fabricated.
 *
 * @param {string} text
 * @param {Array<{id:number,name:string}>} [roster] resolves bare persona names
 * @returns {number[]}
 */
export function attributedAgentIds(text, roster = []) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const ids = new Set();
  // `Agent 6`, `agent-6`, and the bare leading `10 (Architect…)` the live
  // records actually carry.
  for (const m of s.matchAll(/\bagents?[\s\-_#]*(\d{1,2})\b/gi)) ids.add(Number(m[1]));
  const bare = /^\s*(\d{1,2})\b/.exec(s);
  if (bare) ids.add(Number(bare[1]));
  const lower = s.toLowerCase();
  for (const a of roster || []) {
    const n = String(a?.name || '').toLowerCase();
    if (n && n.length > 3 && lower.includes(n)) ids.add(Number(a.id));
  }
  return [...ids].filter(Number.isInteger).sort((a, b) => a - b);
}

/**
 * Who actually speaks in a transcript, as agent ids.
 *
 * Recognises the forms the composing models really emit, taken from the 34
 * affected transcripts: `**Agent 13 — The Cyber Expert**:`, `**The QA**:`,
 * `Agent 9 — The Designer:`, and the invented `**Agent 11 (not mentioned)**:`.
 *
 * @param {string} transcript
 * @param {Array<{id:number,name:string}>} roster  full agent roster
 * @returns {Set<number>} agent ids with at least one speaking line
 */
export function transcriptSpeakerIds(transcript, roster = []) {
  const ids = new Set();
  for (const raw of String(transcript || '').split('\n')) {
    // A speaker label is the run before the first colon, optionally bolded.
    const m = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*([^:*\n]{2,60}?)\s*(?:\*\*)?\s*:/.exec(raw);
    if (!m) continue;
    const label = m[1].trim();
    const byNumber = /\bAgent\s+(\d{1,2})\b/i.exec(label);
    if (byNumber) { ids.add(Number(byNumber[1])); continue; }
    const lower = label.toLowerCase();
    const hit = (roster || []).find((a) => {
      const n = String(a?.name || '').toLowerCase();
      return n && lower.includes(n);
    });
    if (hit) ids.add(hit.id);
  }
  return ids;
}

/**
 * ── WHAT THIS REFUSES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *
 * `docs/procedures/MEETING-PROTOCOL.md:352-356` explicitly permits work
 * reaching someone who was not in the room: *"the Team Lead may pass work
 * onward to agents who were not in the room."* A blanket "assignee must be an
 * attendee" rule would break that legitimate second hop, so this gate does
 * not use one.
 *
 * **The discriminator is SPEECH, not assignment.** An action item assigned to
 * a non-attendee who never spoke is the protocol's second hop and passes. An
 * action item assigned to a non-attendee *who was given speaking lines* is
 * downstream of fabricated participation and is refused — that agent did not
 * accept the work, because that agent was not there.
 *
 * Refusals are carried on the record, never silently dropped: A15 requires a
 * correction to be visible, and a transcript that quietly lost an action item
 * is a second, quieter version of the same defect.
 *
 * @returns {{fabricated: number[], removed: object[], kept: object[]}}
 */
export function enforceAttendeeGate(transcript, decisions, attendeeIds, roster = []) {
  // One mechanism, not a second copy of it. `fabricated` merges checkAttribution's
  // two populations here — for a transcript the remedy is identical (the line was
  // not spoken), and the pre-OB-075 shape of this return value is consumed by
  // meeting-engine.js and by 35 published corrections.
  const speakers = transcriptSpeakerIds(transcript, roster);
  const a = checkAttribution([...speakers], attendeeIds, roster);
  const fabricated = [...a.unknown, ...a.nonParticipants].sort((x, y) => x - y);
  const items = Array.isArray(decisions?.action_items) ? decisions.action_items : [];
  const fabricatedSet = new Set(fabricated);
  return {
    fabricated,
    removed: items.filter((it) => fabricatedSet.has(Number(it?.agent_id))),
    kept: items.filter((it) => !fabricatedSet.has(Number(it?.agent_id))),
  };
}
