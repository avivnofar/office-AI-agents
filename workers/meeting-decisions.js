/**
 * workers/meeting-decisions.js — the meeting engine's PURE decision logic.
 *
 * Split out of meeting-engine.js on 2026-08-07 for exactly the reason
 * permission-guard.js was split on 2026-07-12, and the reason is worth
 * restating because it keeps recurring:
 *
 *   meeting-engine.js imports config JSON at module scope. That needs an
 *   import attribute esbuild/Workers accepts and plain `node` REJECTS, so a
 *   plain-Node verifier cannot import it. The alternative to splitting is a
 *   hand-written mirror of this logic inside the verifier — three copies of
 *   the same branching held together by a "keep in sync" comment, which is
 *   what the 2026-07-12 refactor existed to end.
 *
 * So everything here is a PURE FUNCTION: no env, no fetch, no D1, no JSON
 * import. scripts/verify-office-bureaucracy.js imports this module directly
 * and exercises the real code rather than a copy of it.
 *
 * meeting-engine.js re-exports every one of these, so callers and the module's
 * public surface are unchanged.
 */

/* ──────────────────────── Action items → board tasks ───────────────────── */

/**
 * THE SIXTH BRANCH. Until 2026-08-07, applyMeetingEffects() consumed five of
 * the six decision arrays and `action_items` was the one with no consumer: it
 * was rendered into the report as markdown checkboxes and dropped. The office
 * had been holding meetings that produced action items and discarding them.
 *
 * Analysis and the specification for all of this:
 * back-office campus/shared/board/DECISION-PIPELINE.md.
 *
 * SEQUENCING, and it was not negotiable: the schema landed before this
 * consumer. A consumer built against the old bare-string array would have had
 * to guess an assignee for every item, and a full board of confidently-wrong
 * assignments destroys the board's credibility on its first run.
 */

/** Office-day arithmetic: Saturday is not an office day (08:00–18:00 Israel,
 *  Sun–Fri). Matches the board's own definition in its README. */
export function addOfficeDays(from, days) {
  const d = new Date(from);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 6) remaining -= 1; // 6 = Saturday
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Validates action items. REFUSES rather than defaults, on every field that
 * a guess would corrupt.
 *
 * The `agent_id` rule is item 1.1's `track` rule applied to a different
 * field: a defaulted value silently corrupts the exact thing the field exists
 * to make possible. An item that cannot name an owner is DROPPED WITH A
 * LOGGED REASON, never assigned to whoever seems likely.
 *
 * A roster gap surfaces here as a logged drop too. As of 2026-08-07 agents 12
 * and 13 are in agents-config.json, so this is no longer the common case —
 * but the branch stays, because a model naming agent_id 14 must produce a
 * visible drop rather than a task nobody owns.
 *
 * @returns {{items: Array, dropped: Array<{item: any, reason: string}>}}
 */
export function normalizeActionItems(rawItems, { rosterIds }) {
  const items = [];
  const dropped = [];

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    // The pre-2026-08-07 shape. Recognised explicitly so the failure is
    // legible: a bare string is not a malformed object, it is the OLD schema,
    // and someone reading the log needs to know which.
    if (typeof raw === 'string') {
      dropped.push({ item: raw, reason: 'bare string — pre-2026-08-07 action_items schema, carries no owner, no artifact and no deadline' });
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      dropped.push({ item: raw, reason: 'not an object' });
      continue;
    }

    const agentId = Number(raw.agent_id);
    if (!Number.isInteger(agentId)) {
      dropped.push({ item: raw, reason: 'agent_id missing or not an integer — REFUSED, never defaulted: an item that cannot name an owner is not an action item' });
      continue;
    }
    if (!rosterIds.includes(agentId)) {
      dropped.push({ item: raw, reason: `agent_id ${agentId} is not in the roster (${rosterIds.join(',')}) — dropped rather than reassigned` });
      continue;
    }

    const task = String(raw.task || '').trim();
    if (!task) {
      dropped.push({ item: raw, reason: 'task is empty' });
      continue;
    }

    const delivered = String(raw.delivered || '').trim();
    if (!delivered) {
      dropped.push({ item: raw, reason: 'delivered is empty — REQUIRED, and must name an artifact: without it the deadline is unfalsifiable and the board metric is a formality' });
      continue;
    }

    const dueDays = Number.isFinite(Number(raw.due_days)) ? Math.max(1, Math.floor(Number(raw.due_days))) : null;
    if (dueDays === null) {
      dropped.push({ item: raw, reason: 'due_days missing or not a number' });
      continue;
    }

    // `decided` is first-class. Absent is treated as NOT decided, which is
    // the conservative direction: an item reaches the board as NOT-READY for
    // a person to resolve, rather than being dispatched on an assumption.
    const decided = raw.decided === true;

    items.push({ agentId, task, delivered, dueDays, decided, openQuestion: String(raw.open_question || '').trim() || null });
  }

  return { items, dropped };
}

/** Renders one validated action item as a board task block in the board's
 *  documented format (campus/shared/board/README.md). */
export function renderBoardTask(item, { id, meetingType, dateStr, agentName, sourceLabel = null }) {
  const state = item.decided ? 'READY' : 'NOT-READY';
  // sourceLabel (2026-08-11, Phase 5): the "Source:" line's default is
  // byte-identical to before (`meeting ${dateStr} (${meetingType})`, below).
  // The "blocked by" sentence's default now names WHICH meeting rather than
  // just "the meeting" — a small, deliberate wording improvement made while
  // this was being touched anyway, not a behavior change any verifier
  // depends on (checked: no script asserts the old exact string).
  const label = sourceLabel || `the ${meetingType} meeting`;
  const blockedBy = item.decided
    ? 'nothing'
    : `**an owner decision.** ${label[0].toUpperCase()}${label.slice(1)} did not settle this. Open question: ${item.openQuestion || 'not stated — a person must establish what was left undecided before this can be dispatched.'}`;

  return `### ${id} — ${item.task}

- **Assignee:** Agent ${item.agentId}${agentName ? ` — ${agentName}` : ''}
- **State:** ${state}
- **Metric:** ${item.dueDays} office-days from dispatch (${addOfficeDays(dateStr, item.dueDays)} if dispatched today) · delivered = ${item.delivered}
- **Blocked by:** ${blockedBy}
- **Source:** ${sourceLabel || `meeting ${dateStr} (${meetingType})`}
- **Task:** ${item.task}
- **Notes:** *(${dateStr}, opened by ${label} via the action_items pipeline)*${item.decided ? '' : ' `decided: false` is a real outcome, not a parse failure. It reaches the board as NOT-READY by design, because removing the ability to say "not decided yet" is what forces a fabricated decision.'}
`;
}

/* ──────────────────────────── Response parsing ─────────────────────────── */
// Moved here from meeting-engine.js on 2026-08-11 — same reason every other
// pure decision function lives in this file (see the module header): plain
// `node` cannot load meeting-engine.js (it imports config JSON at module
// scope), and a parser this load-bearing needs a real regression test
// against a captured live transcript, not a text-proximity check on source.

export function emptyDecisions() {
  return {
    summary: '',
    mood_effects: [],
    irritation_effects: [],
    state_changes: [],
    action_items: [],
    context_amendments: [],
    config_overrides: [],
    suggestion_decisions: [],
  };
}

/**
 * Locates the DECISIONS marker. Exact match first — `---DECISIONS---`,
 * byte-for-byte what the prompt specifies — and ONLY when that is absent
 * does a lenient fallback run.
 *
 * WHY THE FALLBACK EXISTS (found 2026-08-11, first live run of the newly-
 * scheduled closing_qa_review): the exact-marker parser silently discarded a
 * real, otherwise-compliant decisions block — the model wrote `**DECISIONS**`
 * instead of the literal marker, `text.indexOf(marker)` returned -1, and
 * EVERY array came back empty, including a genuine, policy-compliant
 * `context_amendments` proposal sitting right there in the model's own text.
 * Same shape this project keeps finding elsewhere (checkCodeWriteAllowedForModel(),
 * finishReason): a contract stated in a prompt with zero tolerance in the
 * code that is supposed to honour it the moment the model misses it by one
 * character.
 *
 * The fallback matches a line that is just the word DECISIONS, optionally
 * wrapped in markdown emphasis/heading/quote punctuation — narrow enough
 * that it will not fire inside ordinary transcript prose (which discusses
 * decisions in sentences, never as an isolated line), and permissive enough
 * to survive `**DECISIONS**`, `## DECISIONS`, `> DECISIONS`, etc.
 */
export function findDecisionsMarker(text) {
  const exact = '---DECISIONS---';
  const idx = text.indexOf(exact);
  if (idx !== -1) return { idx, length: exact.length };

  const lenient = /^[\s>]*[-*_#]{0,4}\s*DECISIONS\s*[-*_#]{0,4}\s*$/im.exec(text);
  return lenient ? { idx: lenient.index, length: lenient[0].length } : { idx: -1, length: 0 };
}

/**
 * Splits a meeting's raw model response into its transcript and its
 * DECISIONS JSON block. See findDecisionsMarker() for the marker-tolerance
 * fix and its header for why it exists.
 */
export function parseMeetingResponse(text) {
  const endMarker = '---END---';
  const { idx, length } = findDecisionsMarker(text);

  if (idx === -1) {
    return { transcript: text.trim(), decisions: emptyDecisions() };
  }

  const transcript = text.slice(0, idx).trim();
  let jsonChunk = text.slice(idx + length);
  const endIdx = jsonChunk.indexOf(endMarker);
  if (endIdx !== -1) jsonChunk = jsonChunk.slice(0, endIdx);

  // Located by OUTERMOST braces rather than assumed to start immediately
  // after the marker — the same live run that motivated the lenient marker
  // above also wrote a stray "---" line between "**DECISIONS**" and the
  // actual `{...}`, which an immediate-slice would have handed to
  // JSON.parse() as leading garbage and failed on.
  const firstBrace = jsonChunk.indexOf('{');
  const lastBrace = jsonChunk.lastIndexOf('}');

  let decisions = emptyDecisions();
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      decisions = { ...emptyDecisions(), ...JSON.parse(jsonChunk.slice(firstBrace, lastBrace + 1)) };
    } catch {
      decisions = emptyDecisions();
    }
  }

  return { transcript, decisions };
}

/* ──────────────────── Context amendments → probation (A2/A3) ───────────── */

/**
 * THE MISSING CONSUMER, closed 2026-08-11. closing_qa_review's own prompt
 * has always promised "conclusions specific enough to be written into an
 * agent's character file TONIGHT" (meeting-engine.js AGENDA_BUILDERS) — but
 * until this function existed, applyMeetingEffects() had no branch that
 * wrote anything to active context from ANY meeting's decisions. The exact
 * shape action_items was in before 2026-08-07: promised in a prompt,
 * produced by the model, read by nobody.
 *
 * REFUSES rather than guesses, same posture as normalizeActionItems() and
 * owner-channel.js's parseOwnerMessage() — a malformed or policy-violating
 * entry here would either corrupt an agent's live prompt or violate A2's
 * "no agent modifies its own active context" in code, not just in theory.
 *
 * @returns {{items: Array, dropped: Array<{item: any, reason: string}>}}
 */
export function normalizeContextAmendments(rawItems, { rosterIds, proposerIds = [6, 7] }) {
  const items = [];
  const dropped = [];

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || typeof raw !== 'object') {
      dropped.push({ item: raw, reason: 'not an object' });
      continue;
    }

    const agentId = Number(raw.agent_id);
    if (!Number.isInteger(agentId)) {
      dropped.push({ item: raw, reason: 'agent_id missing or not an integer — REFUSED, never defaulted' });
      continue;
    }
    if (!rosterIds.includes(agentId)) {
      dropped.push({ item: raw, reason: `agent_id ${agentId} is not in the roster (${rosterIds.join(',')})` });
      continue;
    }

    const proposedBy = Number(raw.proposed_by);
    if (!Number.isInteger(proposedBy) || !proposerIds.includes(proposedBy)) {
      dropped.push({ item: raw, reason: `proposed_by must be one of ${proposerIds.join(',')} (the QA/Team Lead) — got ${raw.proposed_by}` });
      continue;
    }
    // A2: "No agent modifies its own active context." Enforced here, in
    // code, not left to the prompt's own instruction to hold.
    if (agentId === proposedBy) {
      dropped.push({ item: raw, reason: `agent_id equals proposed_by (${agentId}) — A2 forbids an agent amending its own active context` });
      continue;
    }

    const aspect = String(raw.aspect || '').trim();
    if (!aspect) {
      dropped.push({ item: raw, reason: 'aspect is empty — required so two concurrent changes on the same agent are distinguishable (A3)' });
      continue;
    }

    const content = String(raw.content || '').trim();
    if (!content) {
      dropped.push({ item: raw, reason: 'content is empty — a probation entry with nothing to measure is not an entry' });
      continue;
    }

    items.push({ agentId, proposedBy, aspect, content });
  }

  return { items, dropped };
}

/* ───────────── What each attendee actually has (Session 39, Item C) ──────── */

/**
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING IS SAID IN A MEETING WITHOUT A RECORD BEHIND IT.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT AN ATTENDEE HAD BEFORE THIS, MEASURED ──────────────────────────
 *
 * `buildMeetingPrompt()` gives every attendee its persona, its mood and
 * irritation, its durable config overrides, the office-wide context block, and
 * the agenda data. Of all of that, exactly ONE item is per-agent and factual:
 * `gatherDailyStandup()`'s `sessionStats` row. Live, for 2026-08-27..29, every
 * attendee's row was
 *
 *     { agent_id, sessions: 4, cases: 0, avg_mood: 100,
 *       irritation_events: 0, happy_events: 0 }
 *
 * Six numbers, five of them constant or zero, and NOT ONE of them says what
 * that agent produced, what it owes, or what is blocked on it. The Workflow
 * (Agent 12) is the sole exception, because `renderWorkflowMetrics()` hands him
 * real board figures — and his contributions are the ones that are correct.
 *
 * Then the standup told each attendee to "give a 1-2 sentence status". On both
 * 2026-08-27 and 2026-08-28 the IT Chief's line was, verbatim:
 *
 *     "Network optimization continues on schedule, firewall rules updated
 *      yesterday; no client escalations pending, so I'm clear to assist where
 *      needed."
 *
 * The office has no network, no firewall, no clients and no escalations. The
 * attendance was real and the content was invented — and it was invented in the
 * only direction available to a model asked to speak and given nothing about
 * itself. **This is not a persona failure. It is an empty input.**
 *
 * ── WHAT THIS BLOCK IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────
 *
 * One line per attendee, every field read from a record: the board (`BOARD.md`,
 * parsed by office-context.js), the lifecycle digest (`IN-FLIGHT.md`), and D1's
 * own output counts. It is NOT a summary and NOT an interpretation — an empty
 * field renders as the words "none recorded", because the whole purpose is that
 * "nothing is on record" must be sayable.
 *
 * NO ROLE IS REMOVED (C4). The IT Chief invents because he has no facts, not
 * because he has no place, and dropping him from the meeting would delete the
 * symptom while leaving every other silent attendee free to do the same thing.
 *
 * ── AND SILENCE IS NAMED AS A CONTRIBUTION ──────────────────────────────
 *
 * The rules below say, in as many words, that an attendee with an empty line
 * says it has no report and that this is complete and correct. Without that
 * sentence the grounding alone would not help: a model handed an empty line and
 * an instruction to speak fills the gap exactly as before. The same argument
 * `gatherClosingQaReview()`'s `nothingToReview` guard already makes — a meeting
 * handed empty arrays and told to be specific does not decline, it produces
 * something.
 *
 * Pure, like everything else in this module, so the verifier exercises it
 * without D1 or the network.
 *
 * @param {object} opts
 * @param {Array<{id:number,name?:string,role?:string}>} opts.attendees
 * @param {Array} opts.boardTasks           parseBoard()'s tasks, or []
 * @param {Array} opts.lifecycleRecords     parseInFlight()'s records, or []
 * @param {object} opts.outputByAgent       `{ id: { lastAt, kinds } }`
 * @param {object} opts.writesByAgent       `{ id: { lastAt, n, paths } }` —
 *   committed files attributed to that agent by `repo_writes.author`. Session
 *   40, Item B. Defaults to `{}`, which renders exactly as this function did
 *   before the field existed, so a caller that has not been updated (and a
 *   Worker running without D1) loses nothing.
 * @param {number} [opts.windowDays]
 * @param {number} [opts.now]
 * @param {boolean} [opts.boardRead]        false when BOARD.md could not be read
 * @param {boolean} [opts.lifecycleRead]    false when IN-FLIGHT.md could not be read
 */
export function buildAttendeeGrounding({
  attendees = [],
  boardTasks = [],
  lifecycleRecords = [],
  outputByAgent = {},
  writesByAgent = {},
  windowDays = 7,
  now = Date.now(),
  boardRead = true,
  lifecycleRead = true,
} = {}) {
  if (!attendees.length) return '';
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cap = (list, n) => (list.length > n ? `${list.slice(0, n).join(', ')} +${list.length - n} more` : list.join(', '));

  const lines = attendees.map((a) => {
    const id = Number(a?.id);
    const who = `Agent ${id}${a?.name ? ` — ${a.name}` : ''}`;
    const mine = boardTasks.filter((t) => t.agentId === id);

    const unstarted = mine.filter((t) => t.state === 'READY').map((t) => `${t.id}${t.urgency ? ' [URGENT]' : ''}`);
    const doing = mine.filter((t) => t.state === 'IN-PROGRESS').map((t) => t.id);
    // The `Blocked by:` line is prose and can run to 200 characters of
    // reasoning (OB-011's does). One clause is what a meeting needs; the rest
    // is on the board. Truncation SAYS it truncated — the same NO SILENT CAPS
    // rule office-context.js keeps, applied to the same class of field.
    const why = (t) => {
      const b = String(t.blockedBy || '').trim();
      if (!b) return 'something unstated';
      return b.length > 90 ? `${b.slice(0, 90).trimEnd()}… [truncated; the whole reason is on the board]` : b;
    };
    const blocked = mine.filter((t) => t.state === 'BLOCKED').map((t) => `${t.id} (waiting on ${why(t)})`);
    const reviews = lifecycleRecords
      .filter((r) => (r.owed_by || []).includes(id))
      .map((r) => `${r.slug} r${r.round}`);

    const out = outputByAgent[id];
    const kinds = out?.kinds || {};
    const inWindow = out?.lastAt && (now - out.lastAt) <= windowMs;
    // Three distinguishable states, not two — the same discrimination
    // computeOutputCensus() makes, for the same reason: "produced before,
    // nothing lately" and "nothing ever" call for different sentences.
    const produced = !out || !out.lastAt
      ? 'NOTHING ever recorded'
      : inWindow
        ? `${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')} (last ${new Date(out.lastAt).toISOString().slice(0, 10)})`
        : `nothing in the last ${windowDays} days; its last output was ${new Date(out.lastAt).toISOString().slice(0, 10)}`;

    /*
     * ── COMMITTED FILES, ADDED BESIDE THE DOCUMENT COUNT (session 40, B4) ──
     *
     * The `reports` half above kept its exact wording, because it is not wrong
     * — it went quiet on 2026-08-23 when the case work was retired, and an
     * agent with no `reports` row genuinely authored no document. What it is
     * not is the whole picture: the office commits files every day and none of
     * it reached this line.
     *
     * A COUNT IS NOT ENOUGH HERE. "3 files" is a number an attendee can recite
     * without knowing what it did; the paths are what make the line usable in
     * the sentence the meeting actually needs — "I appended to my journal" is
     * grounded, "I produced three artifacts" is a number wearing a claim. Three
     * paths, and the cap SAYS it capped, per this file's own no-silent-caps rule.
     *
     * The empty case stays honest and stays SEPARATE: an agent with no writes
     * is told there are none, not left with a blank half-sentence.
     */
    const w = writesByAgent[id];
    const wInWindow = w?.lastAt && (now - w.lastAt) <= windowMs;
    const wPaths = (w?.paths || []).slice(0, 3);
    const committedFiles = !w || !w.n
      ? 'no file it committed is on record'
      : `${w.n} file${w.n === 1 ? '' : 's'} committed, last ${new Date(w.lastAt).toISOString().slice(0, 10)}`
        + `${wInWindow ? '' : ` (NOT in the last ${windowDays} days)`}`
        + `: ${wPaths.join(', ')}${w.n > wPaths.length ? ` +${w.n - wPaths.length} more not listed here` : ''}`;

    const parts = [
      `UNSTARTED WORK: ${boardRead ? (unstarted.length ? cap(unstarted, 5) : 'none') : 'THE BOARD COULD NOT BE READ THIS CYCLE'}`,
      `IN PROGRESS: ${boardRead ? (doing.length ? doing.join(', ') : 'none') : 'unknown'}`,
      `BLOCKED ON IT: ${boardRead ? (blocked.length ? cap(blocked, 3) : 'none') : 'unknown'}`,
      `REVIEWS OWED: ${lifecycleRead ? (reviews.length ? reviews.join(', ') : 'none') : 'THE LIFECYCLE DIGEST COULD NOT BE READ THIS CYCLE'}`,
      `PRODUCED: ${produced}; COMMITTED: ${committedFiles}`,
    ];
    // A committed file counts as something on record. Without this an agent
    // that committed to git yesterday would still be told its correct
    // contribution is to say it has no report — the exact failure this line
    // exists to prevent, arriving from the other direction.
    const empty = boardRead && lifecycleRead
      && !unstarted.length && !doing.length && !blocked.length && !reviews.length
      && (!out || !out.lastAt) && (!w || !w.n);
    return `- ${who}: ${parts.join('. ')}.${empty ? ' ** THIS ATTENDEE HAS NOTHING ON RECORD — its correct contribution is to say it has no report. **' : ''}`;
  });

  return [
    '=== WHAT IS ACTUALLY ON RECORD FOR EACH ATTENDEE ===',
    'Every field below is read from the delegation board, the deliverable-lifecycle digest, the office\'s own document records and the git writes it actually made. It is the WHOLE of what the office knows about what these agents have done and owe. There is no other source, and an attendee has no memory of anything not written here or in the agenda data.',
    '',
    ...lines,
    '',
    'HOW TO SPEAK FROM THIS — these are conditions on the transcript, not style advice:',
    '1. An attendee speaks only from its own line above, from the agenda data below, or from what another attendee has just said in this meeting.',
    '2. AN ATTENDEE WITH NOTHING ON ITS LINE SAYS SO — "I have no completed work, no open obligation and nothing blocked, so I have no report." That is a COMPLETE and CORRECT contribution, it is expected, and it is not a failure. Nobody is asked to fill it.',
    '3. THIS OFFICE HAS NO CLIENTS, NO NETWORK, NO FIREWALL, NO SERVERS, NO TICKETS AND NO ESCALATIONS. It builds software artifacts in three git repositories and carries them through review. A status line about network optimisation, firewall rules, client escalations, uptime or deployments to customers is fabricated by construction, because there is nothing for it to be about.',
    '4. Naming a board id, a deliverable slug or an output kind that does not appear above is inventing a record. If you believe something exists that is not listed, SAY THAT IT IS NOT ON THE RECORD rather than describing it.',
  ].join('\n');
}

/* ─────────────────── The Workflow's productivity picture ───────────────── */

/**
 * MEASUREMENT, NOT A SCORE — and this is a design constraint, not a
 * preference (owner decision, 2026-08-07).
 *
 * There is deliberately NO single productivity percentage here. One number
 * would be actionable in exactly one way — "make it go up" — and the four
 * things below need four different responses: work sitting unstarted needs
 * dispatch, an idle agent needs assignment, work past its line needs a
 * check-in or an escalation, free capacity needs filling. Averaging them into
 * one figure destroys the only information the Workflow could act on. A
 * healthy 82% and a sick 82% look identical.
 *
 * It maps directly to the Workflow's disposition in the bible: he is pained
 * by work sitting in the backlog and by agents sitting idle. Those are the
 * first two measures because they are the two things that hurt him.
 *
 * Pure function of the board snapshot + activity rows, so the verifier can
 * exercise every branch without D1 or the network.
 */
export function computeWorkflowMetrics({ boardTasks = [], activityByAgent = {}, rosterIds = [], now = Date.now(), lapseDays = null }) {
  const unstarted = boardTasks.filter((t) => t.state === 'READY');
  const inProgress = boardTasks.filter((t) => t.state === 'IN-PROGRESS');
  const stuck = boardTasks.filter((t) => t.state === 'BLOCKED' || t.state === 'NOT-READY');

  // Work past its metric line. The board stamps an absolute date into the
  // Metric line at dispatch; anything we cannot parse a date from is reported
  // as UNKNOWN rather than assumed on time — an unparseable deadline that
  // silently counts as "fine" is how a deadline stops meaning anything.
  const overdue = [];
  const undated = [];
  for (const t of inProgress) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(t.metric || '');
    if (!m) { undated.push(t.id); continue; }
    if (new Date(`${m[1]}T23:59:59Z`).getTime() < now) overdue.push({ id: t.id, due: m[1], assignee: t.assignee });
  }

  // Agents who have not worked. `activityByAgent` maps agent id -> last
  // activity timestamp (ms). An agent absent from the map has no recorded
  // activity at all, which is reported as "never recorded", NOT as zero days
  // — those are different facts and only one of them is a problem.
  const idle = [];
  for (const id of rosterIds) {
    const last = activityByAgent[id];
    if (!last) { idle.push({ agentId: id, days: null, note: 'no activity ever recorded' }); continue; }
    const days = Math.floor((now - last) / (24 * 60 * 60 * 1000));
    if (days >= 1) idle.push({ agentId: id, days, note: null });
  }

  // Free capacity: on the roster, holding no IN-PROGRESS task.
  const busy = new Set(inProgress.map((t) => t.agentId).filter((x) => x != null));
  const freeCapacity = rosterIds.filter((id) => !busy.has(id));

  /*
   * ── SESSION 39, ITEM B: MEASURE 1 CARRIES THE AGE ─────────────────────
   *
   * `own-assignment` (office-context.js) puts ONE unstarted assignment in front
   * of an agent in imperative voice, and after `ASSIGNMENT_LAPSE_DAYS` it stops
   * addressing that agent and says the item "is the Workflow's measure 1 now
   * and is reported, dated, at every standup."
   *
   * That sentence was a claim about THIS function, and until now it would have
   * been false: measure 1 listed ids and nothing else, so an item that lapsed
   * out of one surface arrived at the other with its age discarded — an
   * escalation to a place that could not tell a two-day-old assignment from a
   * twenty-three-day-old one. An obligation that clears INTO a mechanism which
   * cannot see what it was handed has not escalated, it has been dropped
   * politely.
   *
   * `lapseDays` is PASSED IN, never defaulted here. office-context.js owns the
   * number (`ASSIGNMENT_LAPSE_DAYS`) because that is where the agent-facing
   * line is worded; a second copy living in this file is the drift both modules
   * already have a rule against. `null` means the caller did not state one, and
   * then no item is called lapsed — "not classified" rather than "not lapsed".
   */
  const ageOf = (t) => {
    const d = Date.parse(`${t.opened}T00:00:00Z`);
    return Number.isNaN(d) ? null : Math.floor((now - d) / 86400000);
  };
  const unstartedRows = unstarted.map((t) => ({
    id: t.id, title: t.title, assignee: t.assignee, urgent: !!t.urgency,
    opened: t.opened || null,
    days: t.opened ? ageOf(t) : null,
  }));
  // Undated ones are their own list, not folded in as zero. The board carries
  // 12 tasks whose Notes line has no date, and counting them as fresh is how a
  // backlog stops being visible.
  const lapsedUnstarted = lapseDays === null
    ? []
    : unstartedRows.filter((r) => r.days !== null && r.days >= lapseDays).sort((a, b) => b.days - a.days);
  const undatedUnstarted = unstartedRows.filter((r) => r.days === null);

  return {
    unstarted: unstartedRows,
    lapseDays,
    lapsedUnstarted,
    undatedUnstarted,
    idle,
    overdue,
    undated,
    freeCapacity,
    stuck: stuck.map((t) => ({ id: t.id, state: t.state, blockedBy: t.blockedBy })),
  };
}

/* ─────────────────────── The output census (2026-08-10) ─────────────────── */

/**
 * FOR EVERY AGENT: HAS IT PRODUCED ANYTHING IN N DAYS, AND OF WHAT KIND?
 *
 * ── WHAT THIS COMPLETES, AND WHY THE OLD MEASURE WAS NOT ENOUGH ──────────
 *
 * `computeWorkflowMetrics()`'s measure 2 above already asks "who has not
 * worked", and it was nearly right. Two things were wrong with it as an OUTPUT
 * census, and both are the kind that flatter the office:
 *
 *  1. **It measured ACTIVITY, not OUTPUT.** Its input is the last row in
 *     `interactions` — which includes every Q&A ask. An agent that asks
 *     questions all day and produces nothing has a warm activity row and never
 *     appears. That is not a hypothetical: it is precisely how The Designer
 *     (agent 9) went two months without producing a single thing her role is for
 *     while never once reading as idle. **She was not idle. She was absent from
 *     the question.**
 *  2. **It had no window and no kinds.** `days >= 1` flags almost everyone
 *     almost always, so the signal is noise; and a count with no KINDS cannot
 *     tell "produced plenty, none of it her job" from "produced nothing".
 *
 * So this measures output, over a stated window, BY KIND, and reports three
 * distinguishable states rather than one:
 *
 *   NEVER     no output row of any kind, ever. `days: null`.
 *   SILENT    has produced before, nothing inside the window.
 *   PRODUCING something inside the window.
 *
 * And then the finding that matters: **PRODUCING_OFF_ROLE** — inside the window,
 * but none of it is a kind this agent's own role is for. That is the Designer's
 * state made visible, and it is the whole reason the census was worth completing
 * rather than replacing.
 *
 * ── WHAT IT STILL CANNOT SEE, STATED SO IT IS NOT ASSUMED ────────────────
 *
 * A census can only count kinds something is able to produce. It cannot tell you
 * that no code path exists to produce `visual_asset` at all — from in here, an
 * agent with no means and an agent with no assignment look identical. That is
 * `workers/capability-audit.js`'s question, and it is a SECOND mechanism because
 * one cannot do both jobs.
 *
 * Pure function of its inputs, like everything else in this module, so the
 * verifier exercises every branch without D1.
 *
 * @param {object} opts
 * @param {number[]} opts.rosterIds
 * @param {object} opts.outputByAgent - `{ <agentId>: { lastAt: ms|null,
 *   kinds: { '<kind>': count } } }`. An agent ABSENT from this map has produced
 *   nothing ever, which is deliberately distinct from `{ lastAt: null }`.
 * @param {object} [opts.roleKinds] - `{ <agentId>: ['<kind>', ...] }`, the kinds
 *   each role is FOR (config/capability-manifest.json's `output_kinds`). Absent
 *   means the off-role check cannot run for that agent, and it says so rather
 *   than passing it.
 * @param {number} [opts.windowDays]
 * @param {number[]} [opts.dormantAgents] - passed in, never hardcoded, so a
 *   caller has to state the exemption rather than inherit it.
 */
export function computeOutputCensus({
  rosterIds = [],
  outputByAgent = {},
  roleKinds = {},
  windowDays = 7,
  dormantAgents = [10],
  now = Date.now(),
} = {}) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const agents = rosterIds.map((id) => {
    const row = outputByAgent[id];
    const kinds = row?.kinds || {};
    const kindNames = Object.keys(kinds);
    const total = kindNames.reduce((sum, k) => sum + (kinds[k] || 0), 0);
    const dormant = dormantAgents.includes(id);

    if (!row || !row.lastAt || total === 0) {
      return {
        agentId: id, verdict: 'NEVER', days: null, total: 0, kinds: {},
        onRoleKinds: [], offRole: false, dormant,
        note: 'no output of any kind has ever been recorded for this agent',
      };
    }

    const days = Math.floor((now - row.lastAt) / (24 * 60 * 60 * 1000));
    const withinWindow = (now - row.lastAt) <= windowMs;

    // The off-role check. `expected` empty means the manifest declares no output
    // kinds for this agent, and the honest answer is then "cannot say" — NOT
    // "on role", which would be the flattering default and would hide exactly the
    // agent nobody has described the job of.
    const expected = roleKinds[id] || [];
    const onRoleKinds = kindNames.filter((k) => expected.includes(k));
    const offRole = withinWindow && expected.length > 0 && onRoleKinds.length === 0;

    return {
      agentId: id,
      verdict: withinWindow ? (offRole ? 'PRODUCING_OFF_ROLE' : 'PRODUCING') : 'SILENT',
      days,
      total,
      kinds,
      onRoleKinds,
      offRole,
      dormant,
      note: expected.length === 0
        ? 'no output_kinds declared for this role in config/capability-manifest.json — the off-role check could NOT run, which is not the same as passing it'
        : null,
    };
  });

  return {
    windowDays,
    agents,
    never: agents.filter((a) => a.verdict === 'NEVER' && !a.dormant),
    silent: agents.filter((a) => a.verdict === 'SILENT' && !a.dormant),
    offRole: agents.filter((a) => a.verdict === 'PRODUCING_OFF_ROLE' && !a.dormant),
    producing: agents.filter((a) => a.verdict === 'PRODUCING'),
    // Agents the check could not be run for. Reported as its own list, because
    // "we checked and it was fine" and "we could not check" must never share a
    // number — this project's single most-repeated defect shape.
    uncheckable: agents.filter((a) => !!a.note && a.verdict !== 'NEVER'),
    dormantExcluded: agents.filter((a) => a.dormant).map((a) => a.agentId),
  };
}

/** Renders the census as the Workflow presents it. GAPS FIRST — a reader who
 *  stops after two lines should have read the worst of it. */
export function renderOutputCensus(c) {
  if (!c) return '';
  const name = (a) => `Agent ${a.agentId}`;
  const lines = [
    `THE OUTPUT CENSUS (Agent 12) — has each agent PRODUCED anything in the last ${c.windowDays} days, and of what kind?`,
    'This is not measure 2 above restated. Measure 2 reads ACTIVITY, which a Q&A ask keeps warm; this reads OUTPUT, by kind.',
  ];

  lines.push(`A. NEVER PRODUCED ANYTHING — ${c.never.length}.${c.never.length ? ` ${c.never.map(name).join(', ')}. Not "quiet lately": no output row of any kind has ever existed for these.` : ''}`);
  lines.push(`B. PRODUCING, BUT NONE OF IT ITS OWN JOB — ${c.offRole.length}.${c.offRole.length ? ` ${c.offRole.map((a) => `${name(a)} (produced ${Object.keys(a.kinds).join('/')}; its role is for ${a.onRoleKinds.length ? a.onRoleKinds.join('/') : 'none of those'})`).join('; ')}. THIS IS THE STATE THE OLD MEASURE COULD NOT SEE — a warm activity row and nothing the role is for.` : ''}`);
  lines.push(`C. SILENT — produced before, nothing in the window — ${c.silent.length}.${c.silent.length ? ` ${c.silent.map((a) => `${name(a)} (${a.days}d)`).join(', ')}` : ''}`);
  lines.push(`D. PRODUCING ON ROLE — ${c.producing.length}.${c.producing.length ? ` ${c.producing.map(name).join(', ')}` : ''}`);

  if (c.uncheckable.length) {
    lines.push(`E. COULD NOT BE CHECKED — ${c.uncheckable.length}: ${c.uncheckable.map(name).join(', ')}. No output_kinds are declared for these roles, so the off-role test did not run. "Could not check" is NOT "checked and fine".`);
  }
  if (c.dormantExcluded.length) {
    lines.push(`Excluded as deliberately dormant: ${c.dormantExcluded.map((id) => `Agent ${id}`).join(', ')}.`);
  }

  lines.push('A census sees a role that STOPPED working. It cannot see a role that NEVER STARTED — an agent nobody dispatched anything to is not idle, it is absent from this question. That is the capability audit\'s job (workers/capability-audit.js), and it is a separate mechanism on purpose.');
  return lines.join('\n');
}

/** Renders the metrics as the Workflow would present them in a meeting. */
export function renderWorkflowMetrics(m) {
  if (!m) return '';
  const lines = [
    'THE WORKFLOW\'S PRODUCTIVITY PICTURE (Agent 12). Four separate measures — do NOT collapse these into one percentage.',
    `1. UNSTARTED WORK — ${m.unstarted.length} task(s) READY and undispatched${m.unstarted.filter((t) => t.urgent).length ? `, ${m.unstarted.filter((t) => t.urgent).length} of them URGENT` : ''}.${m.unstarted.length ? ` ${m.unstarted.slice(0, 8).map((t) => `${t.id}${t.days === null ? ' (undated)' : ` (${t.days}d)`}`).join(', ')}` : ''}`
      // 1a is where `own-assignment` escalates TO. It names the oldest first
      // and it names them WITH their age, because the whole point of the lapse
      // is that a number nobody says out loud is a number nobody acts on.
      + (m.lapsedUnstarted?.length
        ? `
   1a. OF THOSE, LAPSED — unstarted ${m.lapseDays}+ calendar days, oldest first: ${m.lapsedUnstarted.slice(0, 10).map((t) => `${t.id} ${t.days}d (${t.assignee || 'unassigned'})`).join('; ')}. Each has ALSO stopped being an instruction in its owner's own prompt and is now yours. Nothing has been deleted; every one is still on the board with its whole history.`
        : '')
      + (m.undatedUnstarted?.length
        ? `
   1b. AND ${m.undatedUnstarted.length} unstarted task(s) carry NO assignment date on the board (${m.undatedUnstarted.slice(0, 10).map((t) => t.id).join(', ')}) — their age is UNMEASURABLE, which is not the same as recent, and they are excluded from 1a rather than passed by it.`
        : ''),
    `2. AGENTS NOT WORKING — ${m.idle.length}.${m.idle.length ? ` ${m.idle.map((i) => `Agent ${i.agentId} (${i.note || `${i.days}d`})`).join('; ')}` : ''}`,
    `3. PAST THE METRIC LINE — ${m.overdue.length} overdue.${m.overdue.length ? ` ${m.overdue.map((o) => `${o.id} due ${o.due} (${o.assignee || 'unassigned'})`).join('; ')}` : ''}${m.undated.length ? ` PLUS ${m.undated.length} dispatched task(s) with no parseable deadline — reported as UNKNOWN, not as on-time: ${m.undated.join(', ')}` : ''}`,
    `4. FREE CAPACITY — ${m.freeCapacity.length} agent(s) holding no in-progress task: ${m.freeCapacity.map((id) => `Agent ${id}`).join(', ') || 'none'}`,
  ];
  if (m.stuck.length) {
    lines.push(`ALSO STUCK (not dispatchable, not a capacity problem) — ${m.stuck.map((s) => `${s.id} [${s.state}]`).join(', ')}`);
  }
  lines.push('The Workflow raises these as flags and then DELEGATES TO WHOEVER IS PRESENT. The Team Lead (Agent 7) may pass work onward to agents who are not in the room — that hand-off is expected and is how work reaches someone who was not at the meeting.');
  return lines.join('\n');
}

