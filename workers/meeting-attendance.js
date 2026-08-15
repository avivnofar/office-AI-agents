/**
 * workers/meeting-attendance.js — the attendee gate.
 *
 * Audit 2026-08-15, finding #1: a meeting's `## Attendees` header has always
 * been truthful (rendered from `resolveAttendeeIds()`), while the transcript
 * BODY is unvalidated model text. Nothing reconciled the two. A degraded
 * fallback provider, handed three personas and a thirteen-name roster, voiced
 * all thirteen — and one invented line became a real board task (OB-067,
 * assigned to Agent 9 off a review she did not attend).
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
  const attendees = new Set(attendeeIds || []);
  const speakers = transcriptSpeakerIds(transcript, roster);
  const fabricated = [...speakers].filter((id) => !attendees.has(id)).sort((a, b) => a - b);
  const items = Array.isArray(decisions?.action_items) ? decisions.action_items : [];
  const fabricatedSet = new Set(fabricated);
  return {
    fabricated,
    removed: items.filter((it) => fabricatedSet.has(Number(it?.agent_id))),
    kept: items.filter((it) => !fabricatedSet.has(Number(it?.agent_id))),
  };
}
