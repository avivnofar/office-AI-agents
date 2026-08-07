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
export function renderBoardTask(item, { id, meetingType, dateStr, agentName }) {
  const state = item.decided ? 'READY' : 'NOT-READY';
  const blockedBy = item.decided
    ? 'nothing'
    : `**an owner decision.** The meeting did not settle this. Open question: ${item.openQuestion || 'not stated by the meeting — a person must establish what was left undecided before this can be dispatched.'}`;

  return `### ${id} — ${item.task}

- **Assignee:** Agent ${item.agentId}${agentName ? ` — ${agentName}` : ''}
- **State:** ${state}
- **Metric:** ${item.dueDays} office-days from dispatch (${addOfficeDays(dateStr, item.dueDays)} if dispatched today) · delivered = ${item.delivered}
- **Blocked by:** ${blockedBy}
- **Source:** meeting ${dateStr} (${meetingType})
- **Task:** ${item.task}
- **Notes:** *(${dateStr}, opened by the ${meetingType} meeting via the action_items pipeline)*${item.decided ? '' : ' The meeting reported `decided: false` — this is a real outcome, not a parse failure. It reaches the board as NOT-READY by design, because removing a meeting\'s ability to say "we did not decide" is what forces it to fabricate a decision.'}
`;
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
export function computeWorkflowMetrics({ boardTasks = [], activityByAgent = {}, rosterIds = [], now = Date.now() }) {
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

  return {
    unstarted: unstarted.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, urgent: !!t.urgency })),
    idle,
    overdue,
    undated,
    freeCapacity,
    stuck: stuck.map((t) => ({ id: t.id, state: t.state, blockedBy: t.blockedBy })),
  };
}

/** Renders the metrics as the Workflow would present them in a meeting. */
export function renderWorkflowMetrics(m) {
  if (!m) return '';
  const lines = [
    'THE WORKFLOW\'S PRODUCTIVITY PICTURE (Agent 12). Four separate measures — do NOT collapse these into one percentage.',
    `1. UNSTARTED WORK — ${m.unstarted.length} task(s) READY and undispatched${m.unstarted.filter((t) => t.urgent).length ? `, ${m.unstarted.filter((t) => t.urgent).length} of them URGENT` : ''}.${m.unstarted.length ? ` ${m.unstarted.slice(0, 8).map((t) => t.id).join(', ')}` : ''}`,
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

