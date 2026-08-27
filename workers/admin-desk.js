/**
 * workers/admin-desk.js — the admin tier's scheduled draw from real queues.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-11 the admin tier was removed from the daily Q&A case rotation
 * (`in_case_rotation: false` on agents 5-9 and 11, config/agents-config.json).
 * **That removal was correct** — admins were solving support cases while their
 * real roles went unenforced. Nothing replaced it.
 *
 * Measured 2026-08-17 against live D1: agents 5, 6, 7, 8, 9 and 11 have no
 * `reports` row later than `2026-08-11 13:00`. Six days, half the office, zero
 * output. The one admin still producing is Agent 10 — and only because the
 * Architect liaison block files his unattended sessions.
 *
 * ── THE LINE THIS FILE IS BUILT AGAINST ─────────────────────────────────────
 *
 *   REAL:         an admin reviews something that exists, judges an artifact
 *                 that was produced, decides a question that is open.
 *   MANUFACTURED: a scheduled block that runs whether or not there is anything
 *                 to do, producing output because it is scheduled.
 *
 * The second is worse than silence, because it looks like activity. This
 * project has shipped it more than once — `tool_task_window` fired every
 * weekday for weeks recording `decision: run` and returning `not_eligible`
 * (OB-132), and `spare_time` reached all thirteen agents while
 * `logInteraction()` discarded nine of the rows (OB-131).
 *
 * So every desk below is a QUEUE READER. It draws from a queue that exists for
 * its own reasons, that something else fills, and that is routinely empty. **An
 * empty queue produces nothing at all** — no file, no `reports` row, no D1
 * write, no model call. Not a "nothing to do" artifact; nothing.
 *
 * ── THE QUEUES, AND WHO FILLS THEM ──────────────────────────────────────────
 *
 * | Desk                 | Agents      | Queue                                    | Filled by |
 * |----------------------|-------------|------------------------------------------|-----------|
 * | `deliverable_review` | 5,6,7,8,9,  | in-flight deliverables at `IN-REVIEW`      | a build finishing, then `scripts/lifecycle.mjs` |
 * |                      | 11,12,13    | whose `owed_by` names this agent          | |
 * | `ceo_approval`       | 11          | in-flight deliverables at `AWAITING-APPROVAL` | the review loop converging |
 * | `probation_decision` | 7,6,8       | `probation` rows at 20 actions            | `recordProbationAction()`, one per case answer |
 * | `incident_triage`    | 5           | `reports` rows `type='incident'`, last 24h | failing ticks and irritation stacks |
 *
 * None of the four is invented for this block. `owed_by` has been published in
 * `campus/shared/lifecycle/IN-FLIGHT.md` since 2026-08-10 and is already read
 * into every office-context build (`office-context.js` line ~1779 filters it
 * per agent for the agent's own prompt) — **it was told to the agents and
 * nothing acted on it.** `probationsDueForDecision()` has existed since
 * 2026-08-10 with no caller but a manual admin trigger. The incident rows are
 * written by `logScheduledError()` and the irritation stack.
 *
 * ── AGENT 10 IS NOT A DESK ─────────────────────────────────────────────────
 *
 * The Architect is dormant (CLAUDE.md, "The 11 agents") and reserved for
 * owner-directed work. He appears on `owed_by` lists and this file skips him
 * there — `architect_liaison` is his scheduled path and he is the one admin who
 * already has one. Skipping him is not the same as pretending he does not owe
 * the review: `reviewAssignments()` reports him in `skipped` so a reader sees
 * that the queue is deeper than what was drawn from it (NO SILENT CAPS).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NO IMPORTS IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Same rule as `deliverable-lifecycle.js`, `task-router.js` and
 * `permission-guard.js`, for the same reason: a module-scope JSON import needs
 * an attribute esbuild accepts and plain `node` rejects, so
 * `scripts/verify-admin-desk.js` could not import this module and would
 * hand-mirror it instead — and a verifier that mirrors the logic it checks
 * proves only that someone copied it correctly once.
 *
 * Every function here is pure. The fetching, the model calls and the writes
 * live in `agent-runner.js` `processAdminDeskBlock()`.
 */

/* ────────────────────────────── The roster ─────────────────────────────── */

/**
 * The admin ids this block acts for. Agent 10 is deliberately absent — see the
 * header. Agents 12 and 13 ARE here: they joined the roster 2026-08-07, carry
 * `in_case_rotation: false` like the rest of the tier, appear on live `owed_by`
 * lists, and have produced nothing either. Finding #1 named 5-9 and 11 because
 * those are the ones that USED to produce; 12 and 13 never did.
 */
export const DESK_AGENTS = Object.freeze([5, 6, 7, 8, 9, 11, 12, 13]);

/** Dormant, and the one admin who already has a scheduled path. */
export const ARCHITECT_ID = 10;

/** The CEO — the deliverable lifecycle's one forward exit. */
export const CEO_ID = 11;

/** The three of A3's probation decision meeting: presenter, presenter, decider. */
export const PROBATION_TEAM_LEAD = 7;
export const PROBATION_QA = 6;
export const PROBATION_DECIDER = 8;

/** The IT Chief. */
export const IT_CHIEF_ID = 5;

/* ─────────────────────────────── The caps ──────────────────────────────── */

/**
 * How many reviews one tick may draw.
 *
 * Two, not eight. The queue measured 2026-08-17 held 21 owed reviews across
 * three deliverables; drawing all of them would be one invocation making 21
 * model calls against Cloudflare's 50-subrequest ceiling, which is the incident
 * OB-074 exists because of. Two per weekday drains 21 in eleven office days and
 * the queue refills slower than that.
 *
 * **The cap is reported, never silent** — `reviewAssignments()` returns
 * `deferred` with everything it did not draw. A block that draws 2 of 21 and
 * says "2 reviews filed" is the same lie as a truncated owner-message list.
 */
export const MAX_REVIEWS_PER_TICK = 2;

/** How far back `incident_triage` looks. A day, so a daily block sees each incident once. */
export const INCIDENT_WINDOW_HOURS = 24;

/**
 * How many incidents one triage note covers. Above this the note says so and
 * triages the newest — an IT Chief reading 40 identical irritation stacks is
 * not doing better work than one reading 12 and being told there were 40.
 */
export const MAX_INCIDENTS_PER_NOTE = 12;

/* ──────────────────────── Which deliverables count ──────────────────────── */

/**
 * Board states that mean **the office is not carrying this deliverable**.
 *
 * `OB-043`'s office-site build was reassigned to the owner on 2026-08-17 and
 * moved to `NOT-READY`; its board `Stage:` line says in words *"frozen at the
 * reassignment; the office is not carrying it further."* An admin-review desk
 * that kept filing reviews against it would be the office doing work on
 * something taken off it — the exact opposite of drawing from a real queue.
 *
 * The rule is read from `State:`, never from that prose. `State:` is the one
 * field the board lets decide what a task is (see `parseBoard()`'s `Stage:`
 * comment), and a rule that parsed the sentence would break the first time
 * someone reworded it.
 */
export const NOT_CARRIED_STATES = Object.freeze(['NOT-READY', 'DONE']);

/**
 * The in-flight records the office is actively carrying.
 *
 * A record with `board_task: null` IS carried. It is in the lifecycle's own
 * live index, which is the authority on what is in flight; the absence of a
 * board id means nobody opened a board task for it, not that it was dropped.
 * Refusing it would be absence read as fact.
 *
 * @param {Array<object>} records - `parseInFlight().records`
 * @param {Array<object>} boardTasks - `parseBoard().tasks`
 * @returns {{carried: Array<object>, frozen: Array<{slug: string, boardTask: string, state: string}>}}
 */
export function carriedDeliverables(records = [], boardTasks = []) {
  const stateById = new Map((boardTasks || []).map((t) => [t.id, t.state]));
  const carried = [];
  const frozen = [];
  for (const r of records || []) {
    if (!r || typeof r.slug !== 'string') continue;
    const state = r.board_task ? stateById.get(r.board_task) : null;
    if (state && NOT_CARRIED_STATES.includes(state)) {
      frozen.push({ slug: r.slug, boardTask: r.board_task, state });
      continue;
    }
    carried.push(r);
  }
  return { carried, frozen };
}

/* ───────────────────────── Desk 1: deliverable review ───────────────────── */

/**
 * Who owes a review right now, in draw order, minus what is already answered.
 *
 * ── WHY `alreadyFiled` IS A PARAMETER AND NOT AN ASSUMPTION ────────────────
 *
 * `owed_by` comes from `IN-FLIGHT.md`, which is regenerated only when
 * `scripts/lifecycle.mjs` runs. A review this block files today does not leave
 * `owed_by` until the next warehouse-side ingest — which may be days. Without
 * the caller passing in what is already sitting in the lifecycle inbox, this
 * desk would re-file the same two reviews every weekday and each one would look
 * like new work. That is the manufactured shape wearing a real queue's clothes.
 *
 * The caller reads the inbox directory per slug (one GET) and passes
 * `alreadyFiled: { '<slug>': [5, 6] }`.
 *
 * ── REVIEW OR COMMENT ──────────────────────────────────────────────────────
 *
 * `required` on the record is the lifecycle's own distinction: a required admin
 * owes a full reasoned review, everyone else owes a brief comment or an
 * EXPLICIT abstention. It is carried through to `kind` so the prompt and the
 * inbox file both say which was owed, rather than filing everything as a full
 * review and overstating what was done.
 *
 * ── THE DOABILITY CHECK RUNS BEFORE THE SLOT IS CONSUMED (2026-08-27) ──────
 *
 * Fixed session 30, item A. The board's fixed order put a warehouse-located
 * deliverable (`office-site`) first, and the pre-fix code filled BOTH of
 * `MAX_REVIEWS_PER_TICK`'s slots from its `owed_by` before anything asked
 * whether the artifact could even be read — the artifact check happened one
 * layer up, in `agent-runner.js`, AFTER the draw. Every slot spent on an
 * unreadable deliverable is a slot a readable one never got, and because
 * `office-site` sorts first, this happened on **every tick**, every day,
 * from 2026-08-23 (the day `office-site` re-entered `carried`) onward.
 *
 * The fix: readability is a property of the SLUG, decided by the caller (this
 * file makes no fetch — see the header) and handed in as `unreadableSlugs`,
 * checked per candidate right before it would enter `draw`. An unreadable
 * slug's candidates are recorded in `skipped`, never in `draw` or `deferred`
 * — they never had a slot to begin with, so there is nothing to defer.
 *
 * @param {Array<object>} carried - output of `carriedDeliverables().carried`
 * @param {object} [opts]
 * @param {object} [opts.alreadyFiled] - `{ slug: number[] }`, agents with a review already in the inbox
 * @param {Set<string>|Array<string>} [opts.unreadableSlugs] - slugs whose artifact the caller could not read this tick
 * @param {number} [opts.max] - cap, default MAX_REVIEWS_PER_TICK
 * @param {Array<number>} [opts.agents] - which ids this block acts for
 * @returns {{draw: Array<object>, deferred: Array<object>, skipped: Array<object>}}
 */
export function reviewAssignments(carried = [], opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_REVIEWS_PER_TICK;
  const agents = opts.agents || DESK_AGENTS;
  const alreadyFiled = opts.alreadyFiled || {};
  const unreadableSlugs = opts.unreadableSlugs instanceof Set
    ? opts.unreadableSlugs
    : new Set(opts.unreadableSlugs || []);

  const draw = [];
  const deferred = [];
  const skipped = [];

  for (const record of carried || []) {
    if (record?.stage !== 'IN-REVIEW') continue;
    const required = new Set((record.required || []).map(Number));
    const filed = new Set((alreadyFiled[record.slug] || []).map(Number));

    for (const rawId of record.owed_by || []) {
      const agentId = Number(rawId);
      if (!Number.isInteger(agentId)) continue;

      if (agentId === ARCHITECT_ID) {
        skipped.push({ slug: record.slug, agentId, why: 'the Architect is dormant and has architect_liaison as his scheduled path — he still owes this review' });
        continue;
      }
      if (!agents.includes(agentId)) {
        skipped.push({ slug: record.slug, agentId, why: 'not an admin-desk agent' });
        continue;
      }
      if (filed.has(agentId)) {
        skipped.push({ slug: record.slug, agentId, why: 'a review from this agent is already in the lifecycle inbox awaiting ingest' });
        continue;
      }
      if (unreadableSlugs.has(record.slug)) {
        skipped.push({ slug: record.slug, agentId, why: 'no readable artifact for this deliverable (most likely warehouse-located) — no slot drawn for it, so it never displaced a reviewable deliverable' });
        continue;
      }

      const item = {
        slug: record.slug,
        boardTask: record.board_task || null,
        agentId,
        round: Number.isInteger(record.round) ? record.round : 0,
        kind: required.has(agentId) ? 'review' : 'comment',
        openGaps: record.open_gaps || 0,
        gaps: record.gaps || [],
        next: record.next || null,
      };
      if (draw.length < max) draw.push(item);
      else deferred.push(item);
    }
  }

  return { draw, deferred, skipped };
}

/* ─────────────────────────── Desk 2: CEO approval ───────────────────────── */

/**
 * Deliverables sitting at `AWAITING-APPROVAL` — the CEO's queue, and the
 * lifecycle's one forward exit.
 *
 * Measured 2026-08-17: empty. All three in-flight deliverables are at
 * `IN-REVIEW` round 0. **That is the expected state and the desk produces
 * nothing on it**, which is the whole point — this desk is here to be the
 * honest empty one, and the day it is not empty it will be because the review
 * loop actually converged.
 */
export function approvalQueue(carried = []) {
  return (carried || []).filter((r) => r?.stage === 'AWAITING-APPROVAL');
}

/* ────────────────────── Desk 3: the probation decision ──────────────────── */

/**
 * A3's three-person decision meeting, from `probationsDueForDecision()`.
 *
 * `OB-062` names this gap exactly: *"the separate three-person PROBATION
 * DECISION meeting (kept/dropped/extended after 20 actions) still has no
 * dialogue generation of its own."* `recordDecision()` in
 * `workers/probation-review.js` has validated such a decision since 2026-08-10
 * and the only thing that ever called it is a `curl` the owner has not run.
 *
 * Measured 2026-08-17: two open probations on Agent 2 at 13 of 20 actions and
 * two on Agent 9 at 0. **Nothing is due, so this desk produces nothing today.**
 * The counter moves one per real case answer, so it fills on its own.
 *
 * One per tick. A decision meeting is three model calls (behaviour, quality,
 * verdict) and two due at once would double that inside one invocation.
 */
export function probationDecisionDraw(dueRows = []) {
  const rows = (dueRows || []).filter((r) => r && r.id);
  return { draw: rows.slice(0, 1), deferred: rows.slice(1) };
}

/* ────────────────────── Desk 4: the IT Chief's incidents ────────────────── */

/**
 * Incidents inside the window, newest first, capped and honest about the cap.
 *
 * `at` is compared as an ISO-ish string against a computed cutoff rather than
 * parsed into Dates, because D1 hands these back as `'YYYY-MM-DD HH:MM:SS'`
 * (space, no zone) and `new Date()` on that is implementation-defined. String
 * comparison on a fixed-width timestamp is exact; the caller builds the cutoff
 * in the same shape.
 *
 * @param {Array<{created_at: string, title: string, content: string}>} rows
 * @param {string} cutoff - `'YYYY-MM-DD HH:MM:SS'`, inclusive lower bound
 */
export function recentIncidents(rows = [], cutoff, opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_INCIDENTS_PER_NOTE;
  const inWindow = (rows || [])
    .filter((r) => r && typeof r.created_at === 'string' && r.created_at >= String(cutoff))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return {
    triaged: inWindow.slice(0, max),
    total: inWindow.length,
    overflow: Math.max(0, inWindow.length - max),
  };
}

/* ───────────────────────────── The honest report ────────────────────────── */

/**
 * One line per desk, in the block's return value and in nothing else.
 *
 * A desk that drew nothing says so HERE and writes nothing anywhere. The
 * distinction this project keeps having to relearn: a return value is a
 * measurement of what happened, a committed file is a claim that work was done.
 * `tool_task_window` conflated them for weeks.
 */
export function deskSummary(results = []) {
  return (results || []).map((r) => {
    if (!r) return '- (a desk returned nothing at all — that is a defect, not an empty queue)';
    if (r.produced > 0) return `- **${r.desk}** (Agent ${r.agentIds.join(', ')}): ${r.produced} produced from a queue of ${r.queued}.`;
    if (r.queued === 0) return `- **${r.desk}**: queue empty — nothing written, nothing recorded.`;
    return `- **${r.desk}**: ${r.queued} queued and 0 produced — ${r.reason || 'no reason given, which is itself a defect'}.`;
  });
}

/**
 * Did this tick do anything at all?
 *
 * Used by the caller to decide whether to write a block artifact. It must be
 * possible for this to be false on most days without that being a failure.
 */
export function producedAnything(results = []) {
  return (results || []).some((r) => (r?.produced || 0) > 0);
}
