/**
 * IMPROVEMENT LOOP — REPORT CAPTURE (plan item 1.1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The capture half of the two-axis daily loop. Every agent interaction and
 * office event lands one structured row so that the QA (agent 6), the Team
 * Lead (agent 7) and the Lead QA (agent 8) have something real to review.
 *
 * THIS MODULE IS CAPTURE ONLY. The review jobs (plan 1.2-1.5) are deliberately
 * NOT here and are NOT built — see "the sequencing constraint" below.
 *
 * ── SHIPPED OFF ────────────────────────────────────────────────────────────
 *
 * Everything here is gated on SIM_KV `simulation-state.improvement_loop_enabled`,
 * the exact shape of `guides_enabled` and `routing_enabled` before it. While
 * the flag is off or absent — and absent is the shipped default —
 * recordOfficeEvent() returns `{recorded:false, reason:'improvement_loop_disabled'}`
 * having touched no database and made no call. Flipping it needs no redeploy.
 *
 * ── WHY THIS EXISTS AT ALL: QUALITY WAS BEING THROWN AWAY ─────────────────
 *
 * Found 2026-08-06 while scoping this item. `result.quality` is computed on
 * every Q&A answer in agents/agent-base.js, drives the follow-up band (0.3 to
 * 0.65), drives mood and irritation, and drives capability-gap detection — and
 * was then DISCARDED. It appeared in no INSERT and no bind() anywhere in the
 * repo: not in `cases`, not in `interactions`, not in `reports`.
 *
 * So the improvement loop had been specified, in the plan, on top of a value
 * that was never collected. No amount of schema work fixes that; something has
 * to start writing it at the point it is computed. That is what this module is
 * for, and it is why item 1.1 reaches into the live Track A path at all.
 *
 * ── THE WRITE IS PURELY ADDITIVE, AND THAT IS A HARD REQUIREMENT ──────────
 *
 * Persisting a value must not change any decision that value already drives.
 * recordOfficeEvent() is called AFTER askAssignedProject() has finished all of
 * its follow-up rounds, it reads `result` and never mutates it, it returns a
 * status object nobody branches on, and it cannot throw — every failure path
 * returns a reason instead. Escalation, gap detection, mood and the follow-up
 * loop behave identically with the flag on and with it off.
 * scripts/verify-improvement-loop.js proves that rather than asserting it.
 *
 * ── `type` VERSUS `event_type`: THE RULE ──────────────────────────────────
 *
 *   `type`       — WHAT KIND OF DOCUMENT this row is.
 *                  Pre-existing values: status, incident, gap_hebrew, weekly,
 *                  day, disabled. Untouched by this module's arrival.
 *   `event_type` — WHAT THE OFFICE DID.
 *                  case_answer, qa_review, team_lead_review, lead_qa_weekly,
 *                  meeting, guide_review.
 *
 * They are two different axes and the separation is deliberate (owner
 * decision, 2026-08-06). Overloading `type` would make "yesterday's QA
 * reviews" the same query shape as "incident reports", and 1.2 through 1.5 all
 * query BY EVENT. Rows written by this module carry type='office_event' so a
 * pre-existing consumer that filters on the old `type` values sees nothing new.
 *
 * ── `track`: WHY IT IS NOT COSMETIC ───────────────────────────────────────
 *
 * 'client' is the Q&A engine against data-center and Notebook-X — Track A,
 * whose quotas come first. 'office' is office-building work — Track B, which
 * runs on the headroom Track A leaves. The plan requires per-track quota
 * consumption to be SEPARABLE BEFORE any rebalancing is proposed, and this
 * column is the only thing that makes it separable. A row without a track is
 * refused rather than defaulted: guessing here would silently attribute office
 * work to the client budget, which is the exact measurement the rebalancing
 * decision depends on.
 *
 * ── `embodiment_model`: WHAT ANSWERED, NEVER WHAT WAS ASKED FOR ───────────
 *
 * This records the provider that ACTUALLY SERVED the call, including after a
 * degradation. workers/task-router.js's routeTask() returns `provider` (the
 * one that served) alongside `attempts` (the whole ladder), and
 * agent-base.js tracks `lastModelSource` from the real call. Writing the
 * lane's CONFIGURED primary instead would make the Lead QA's cross-embodiment
 * comparison (1.5) measure the routing table rather than reality — it would
 * report on which provider was supposed to answer, which is precisely the
 * thing nobody needs to be told.
 *
 * ── THE SEQUENCING CONSTRAINT (owner decision, 2026-08-06) ────────────────
 *
 * 1.2 through 1.5 CANNOT produce anything useful until quality has been
 * accumulating for a day or two. The order is: land this, enable capture
 * only, let it run, THEN build the review jobs against real data. A future
 * session must not build the review jobs against an empty table and call them
 * done — a QA review of zero rows passes every test and means nothing.
 */

/** SIM_KV key, and the flag inside it. Mirrors guides_enabled / routing_enabled. */
export const SIM_STATE_KEY = 'simulation-state';
export const IMPROVEMENT_LOOP_FLAG = 'improvement_loop_enabled';

/** The two mission tracks. A row must name one; there is no default. */
export const TRACKS = Object.freeze(['client', 'office']);

/**
 * Closed set. New values go here rather than being passed as free strings, so
 * a typo in a caller is a refused row at write time instead of a silently
 * missing slice of a review three days later.
 */
export const EVENT_TYPES = Object.freeze([
  'case_answer',       // one Q&A unit of work (1.1) — see the note in buildOfficeEventRow
  'case_not_asked',    // an ask that never reached a provider (2026-08-10) — see below
  'qa_review',         // 1.2, not built
  'team_lead_review',  // 1.3, not built
  'lead_qa_weekly',    // 1.5, not built
  'meeting',
  'guide_review',
]);

/**
 * ══════════════════════════════════════════════════════════════════════════
 * `case_not_asked` — THE DECISION TAKEN 2026-08-10, AND WHY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE MEASUREMENT ──────────────────────────────────────────────────────
 *
 * Live D1, 2026-08-10: **129 `case_answer` rows, 86 with `quality IS NULL`.
 * All 86 carry `skipped: true` in their content JSON. All 86 are
 * `project: notebook-x`. Zero exceptions.** So two thirds of the loop's only
 * table recorded asks THAT NEVER HAPPENED — gemini-pacer.js denied the slot,
 * `_askNotebookX()` returned `{ skipped: true, quality: undefined }`, and the
 * capture line wrote the non-event as a row.
 *
 * The null was CORRECT at its origin. This module documents that null means
 * "no score exists here, never zero", and a paced-out ask genuinely has no
 * score. **That correctness is exactly why nothing noticed**: a review job that
 * counts rows sees 129 units of work, and `AVG(quality)` silently answers over
 * a different population than `COUNT(*)` — which is how week-07 came to publish
 * "81 case_answer entries with an average quality of 0.80" as one sentence
 * about one population when it was two.
 *
 * ── THE CHOICE, AND WHY IT IS NOT "STOP CAPTURING THEM" ──────────────────
 *
 * The two options were: don't capture a paced-out ask, or capture it under a
 * status that cannot be mistaken for a scored answer. **Not capturing was
 * rejected**, and the reason is that the pacer turning away two thirds of the
 * office's Notebook-X work is the single most important operational fact this
 * table holds. Dropping the row would delete it — and would delete it INTO the
 * same defect family, since nothing else anywhere records a paced-out ask. The
 * cure would have reproduced the disease with a cleaner-looking table.
 *
 * ── WHY A DISTINCT `event_type` AND NOT A NEW COLUMN ─────────────────────
 *
 * Every consumer of this table already groups by `event_type` — plan items
 * 1.2–1.5 are specified that way, `meeting-engine.js` filters on it, and
 * `buildReportFacts()` does `GROUP BY event_type`. So splitting on this axis
 * makes every existing consumer correct WITHOUT EDITING ANY OF THEM: a query
 * for `case_answer` now returns only asks that reached a provider and carry a
 * real score, and the paced-out ones become separately countable rather than
 * separately invisible. A new column would have required every consumer to
 * learn about it, and the ones that did not would have kept reading 129.
 *
 * ── WHAT WAS DELIBERATELY NOT DONE: THE 86 EXISTING ROWS STAND ───────────
 *
 * They are NOT relabelled, and this is a decision rather than an omission.
 * `reports/weekly/week-07-report.md` published "81 case_answer entries" —
 * an UPDATE would make that published figure unverifiable against the database
 * forever, and this project's standing rule is that a correction to published
 * work is APPENDED AND DATED, never achieved by rewriting the data underneath
 * it. The discriminator for pre-2026-08-10 rows is
 * `content LIKE '%"skipped":true%'`, and it is exact — all 86, no exceptions.
 * Relabelling is boarded as an owner decision, not taken by a session.
 *
 * ── THIS DOES NOT ANSWER OB-027 ─────────────────────────────────────────
 *
 * It opens it. OB-027 owes a yes/no on whether the sample supports building the
 * review jobs, and the two facts that disqualify most of it are unchanged by
 * this: the scored sample is **43**, not 129, and it is **39 notebook-x against
 * 4 data-center** — not a base for a cross-project quality judgement. And the
 * `office` track still has zero rows, which is a different verdict from "not yet
 * enough". What this changes is that the numbers are now separable by query
 * instead of by knowing to look inside a JSON blob.
 */
export const NOT_ASKED_EVENT = 'case_not_asked';

/** The `type` value every row from this module carries. See the rule above. */
export const OFFICE_EVENT_TYPE = 'office_event';

/**
 * Reads the flag. Defaults to OFF on every failure path — no SIM_KV binding,
 * unreadable value, absent key. `=== true` rather than truthiness, so a
 * stray "false" string cannot enable the loop.
 */
export async function improvementLoopEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[IMPROVEMENT_LOOP_FLAG] === true;
}

/**
 * Validates and normalises one row. Pure — no env, no I/O — so the verifier
 * can exercise every rejection without a database.
 *
 * REFUSES rather than defaults on anything it cannot honestly fill in. A
 * defaulted `track` corrupts the per-track quota measurement; a defaulted
 * `event_type` corrupts every review query. A missing `quality` is different
 * and is allowed through as null: plenty of real office events have no score,
 * and null means "no score exists here", never "zero".
 *
 * @returns {{valid: true, row: object} | {valid: false, reason: string}}
 */
export function buildOfficeEventRow({
  agentId,
  eventType,
  track,
  embodimentModel = null,
  quality = null,
  title = null,
  content = null,
  project = null,
  severity = 'info',
}) {
  if (!Number.isInteger(agentId)) {
    return { valid: false, reason: `agentId must be an integer, got ${JSON.stringify(agentId)}` };
  }
  if (!EVENT_TYPES.includes(eventType)) {
    return { valid: false, reason: `unknown event_type "${eventType}" — add it to EVENT_TYPES rather than passing a free string` };
  }
  if (!TRACKS.includes(track)) {
    return { valid: false, reason: `track must be one of ${TRACKS.join('|')} — refused rather than defaulted, because a wrong track silently misattributes quota consumption` };
  }
  if (quality !== null && quality !== undefined) {
    if (typeof quality !== 'number' || Number.isNaN(quality) || quality < 0 || quality > 1) {
      return { valid: false, reason: `quality must be null or a number in [0,1], got ${JSON.stringify(quality)}` };
    }
    // A `case_not_asked` row with a score is a contradiction: the ask never
    // reached a provider, so there was nothing to score. REFUSED rather than
    // dropped-silently, because the only way this happens is a caller wiring the
    // wrong event type onto a real answer — which would put a scored row into
    // the population every consumer now trusts to be unscored.
    if (eventType === NOT_ASKED_EVENT) {
      return { valid: false, reason: `${NOT_ASKED_EVENT} rows must carry quality null — the ask never reached a provider, so a score cannot exist. Got ${JSON.stringify(quality)}` };
    }
  }

  return {
    valid: true,
    row: {
      agent_id: agentId,
      type: OFFICE_EVENT_TYPE,
      event_type: eventType,
      track,
      embodiment_model: embodimentModel || null,
      quality: quality ?? null,
      title: title || `${eventType} — agent ${agentId}`,
      content: content || '',
      severity,
      project: project || null,
    },
  };
}

/** Kept identical to the ALTER-TABLE'd shape. See database/schema.sql. */
export const OFFICE_EVENT_INSERT_SQL = `INSERT INTO reports
  (id, agent_id, type, title, content, severity, project, event_type, embodiment_model, track, quality)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Records one office event. NEVER THROWS and never returns anything a caller
 * is expected to branch on — it sits on the live Q&A path, where a hard
 * failure would cost a real answer to save a metric.
 *
 * Order of refusal matters and is asserted by the verifier:
 *   1. flag off  -> nothing read, nothing written, no D1 touched
 *   2. no D1     -> nothing written
 *   3. bad row   -> nothing written, reason returned
 */
export async function recordOfficeEvent(env, fields) {
  try {
    if (!(await improvementLoopEnabled(env))) {
      return { recorded: false, reason: 'improvement_loop_disabled' };
    }
    if (!env?.DB) {
      return { recorded: false, reason: 'no_db_binding' };
    }

    const built = buildOfficeEventRow(fields);
    if (!built.valid) {
      console.warn(`[improvement-loop] refused row: ${built.reason}`);
      return { recorded: false, reason: built.reason };
    }

    const r = built.row;
    const id = crypto.randomUUID();
    await env.DB.prepare(OFFICE_EVENT_INSERT_SQL)
      .bind(id, r.agent_id, r.type, r.title, r.content, r.severity, r.project, r.event_type, r.embodiment_model, r.track, r.quality)
      .run();

    return { recorded: true, id, eventType: r.event_type, track: r.track, embodimentModel: r.embodiment_model, quality: r.quality };
  } catch (err) {
    // Deliberately swallowed. A capture failure must not take down a cron
    // tick or lose a client answer — the same posture the provider clients
    // take (null + warn, never throw).
    console.warn(`[improvement-loop] capture failed, continuing: ${err?.message || err}`);
    return { recorded: false, reason: 'capture_error' };
  }
}
