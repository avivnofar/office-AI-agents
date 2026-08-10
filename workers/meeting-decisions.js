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

