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

/*
 * THE ONE IMPORT IN THIS FILE, added 2026-08-10 with B5's office-wide reach.
 *
 * `deliverable-lifecycle.js` imports nothing (asserted by
 * scripts/verify-lifecycle.js §11), so plain `node` can still load this module
 * and scripts/verify-improvement-loop.js still exercises the real code.
 *
 * It is imported rather than reimplemented for one reason: B5 defines a
 * refusal's SHAPE, and there must be exactly one validator and exactly one
 * renderer for it. Two implementations of "what counts as a recorded refusal"
 * is how the office would come to have two grammars for its own evidence.
 */
import { recordRefusal as validateRefusal, renderRefusal } from './deliverable-lifecycle.js';

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
  'refusal',           // B5, office-wide (2026-08-10) — see below
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
 * ── THE EXISTING ROWS: RELABELLED 2026-08-10, BY OWNER DECISION ──────────
 *
 * ~~WHAT WAS DELIBERATELY NOT DONE: THE 86 EXISTING ROWS STAND. They are NOT
 * relabelled, and this is a decision rather than an omission. An UPDATE would
 * make week-07's published "81 case_answer entries" unverifiable against the
 * database forever. Relabelling is boarded as an owner decision (OB-041), not
 * taken by a session.~~ — **struck 2026-08-10. The owner took that decision the
 * same day and chose to relabel: accuracy over stability. OB-041 is closed.**
 *
 * `UPDATE reports SET event_type='case_not_asked' WHERE type='office_event'
 *  AND event_type='case_answer' AND content LIKE '%"skipped":true%'`
 * changed **113 rows** — not 86, because the cron kept writing the old label
 * until this change reached production between 08:04:06 (last mislabelled row)
 * and 09:01:25 (first correct one). The two families do not overlap by a single
 * row, which is the evidence that no second capture site was still writing the
 * old label.
 *
 * The discriminator was verified exact BEFORE the UPDATE, in both directions:
 * every `skipped: true` row had `quality IS NULL` and every scored row did not,
 * with no mixed cases. Result: `case_answer` = 55 rows, **zero** null quality —
 * count and average now describe the same population, which was the whole point.
 *
 * The published figure was NOT rewritten underneath. The rule stands and was
 * followed the other way round: `reports/weekly/week-07-report.md` carries an
 * appended, dated **Correction 4** saying what the number was, what it is, and
 * that "81" is now unreproducible. The 113 row ids are in
 * `checkpoints/2026-08-10-ob-041-relabel-ids.txt` so the change is reversible
 * against the exact rows it touched.
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

/**
 * ══════════════════════════════════════════════════════════════════════════
 * `refusal` — B5 APPLIED TO THE WHOLE OFFICE, NOT ONLY THE NIGHT RUN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * OFFICE-POLICY.md B5 lives in the NIGHT ANNEX and closes with a sentence that
 * takes it straight back out again:
 *
 *   > **A refusal not recorded when it happens cannot be recovered.**
 *   > Reconstructing it later produces something that reads as evidence and is
 *   > an invention — indistinguishable from the real thing. **This applies to
 *   > the whole office, not only the night run.**
 *
 * As of 2026-08-10 the only implementation was
 * `workers/deliverable-lifecycle.js recordRefusal()`, which records refusals
 * INSIDE a deliverable's record — a QA rejecting a build, a vote against, the
 * CEO declining. That covers the review loop and nothing else. A QA rejecting
 * something that is not a deliverable, an admin objecting to a task under A8,
 * the Workflow bouncing an ambiguous dispatch: all of those are refusals under
 * B5 and none of them had anywhere to go.
 *
 * ── WHY HERE AND NOT A NEW TABLE ─────────────────────────────────────────
 *
 * A refusal IS a unit of office work — that is precisely B5's argument, that it
 * is evidence about how the office behaved. It has an actor, a moment, a track,
 * and an embodiment, which is the exact shape this table already carries. A
 * separate `refusals` table would need its own migration, its own consumers, and
 * its own reason to be joined back to the events it happened during.
 *
 * ── THE VALIDATION IS BORROWED, NOT COPIED ───────────────────────────────
 *
 * `validateRefusal()` above is deliverable-lifecycle.js's `recordRefusal()`, and
 * it REFUSES a refusal with no character line. That strictness is the whole
 * mechanism: B5 says the line cannot be supplied later, so a caller that cannot
 * produce one must record NO REFUSAL AND SAY SO, rather than record a refusal
 * with a plausible line somebody wrote afterwards.
 *
 * `quality` is always null on these rows and that is deliberate: a refusal has
 * no quality score, and this module already documents that null means "no score
 * exists here", never zero.
 */
export const REFUSAL_EVENT = 'refusal';

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
  scorerId = null,
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
    // ── A SCORE MUST NAME ITS SCORER (OB-080, 2026-08-16) ──────────────────
    // REFUSED, not defaulted, and the reason is measured rather than
    // theoretical. Two divisors (800 for data-center, 600 for notebook-x) ran
    // side by side for four weeks and produced a published finding that a
    // degraded fallback outscored the office's primary provider. It survived
    // that long for exactly one reason: **the rows did not record which
    // formula scored them**, so no reader and no query could tell. Stamping a
    // default here would rebuild that hole — a wrong scorer id is worse than a
    // refused row, because it looks checked.
    //
    // The 134 rows written before this date legitimately have no scorer_id and
    // are read by `scorerForRow()`'s date-and-project inference; that path is
    // exact for them and is NOT a licence to write new rows without one.
    if (typeof scorerId !== 'string' || !scorerId) {
      return { valid: false, reason: `a row carrying quality ${quality} must also carry scorerId naming the function that produced it (workers/quality-metric.js SCORER_ID) — refused rather than defaulted, because an unlabelled score is how two divisors went four weeks undetected` };
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
      // Null whenever quality is null — an unscored row has no scorer, and
      // writing one would claim a measurement that does not exist.
      scorer_id: (quality === null || quality === undefined) ? null : scorerId,
      title: title || `${eventType} — agent ${agentId}`,
      content: content || '',
      severity,
      project: project || null,
    },
  };
}

/** Kept identical to the ALTER-TABLE'd shape. See database/schema.sql. */
export const OFFICE_EVENT_INSERT_SQL = `INSERT INTO reports
  (id, agent_id, type, title, content, severity, project, event_type, embodiment_model, track, quality, scorer_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
      .bind(id, r.agent_id, r.type, r.title, r.content, r.severity, r.project, r.event_type, r.embodiment_model, r.track, r.quality, r.scorer_id)
      .run();

    // ── PROBATION ACTION COUNT (A3, 2026-08-10) ─────────────────────────────
    // "Measured over 20 actions — actions, not days." A `case_answer` row IS
    // one action, so this is the one real place to count them. Deliberately
    // its OWN try/catch, nested inside this function's outer one: a probation
    // bookkeeping failure must never be reported as "the case_answer failed
    // to record" — the INSERT above already succeeded, and that is the fact
    // this function exists to protect. See workers/probation.js
    // recordProbationAction() for what it does with the count. Dynamic
    // import (not a top-level one) to avoid a circular import — probation.js
    // -> context-editor.js -> repo-write.js, none of which import this file,
    // but a static import here would still make improvement-loop.js's own
    // load order depend on a module three files away for a feature most
    // callers never touch.
    if (r.event_type === 'case_answer') {
      try {
        const { recordProbationAction } = await import('./probation.js');
        await recordProbationAction(env, r.agent_id);
      } catch (err) {
        console.warn(`[improvement-loop] probation action count failed, continuing: ${err?.message || err}`);
      }
    }

    return { recorded: true, id, eventType: r.event_type, track: r.track, embodimentModel: r.embodiment_model, quality: r.quality };
  } catch (err) {
    // Deliberately swallowed. A capture failure must not take down a cron
    // tick or lose a client answer — the same posture the provider clients
    // take (null + warn, never throw).
    console.warn(`[improvement-loop] capture failed, continuing: ${err?.message || err}`);
    return { recorded: false, reason: 'capture_error' };
  }
}

/**
 * Records one refusal, anywhere in the office. B5.
 *
 * @param {object} env
 * @param {{agentId:number, who:string, declined:string, characterLine:string,
 *          track?:'client'|'office', source?:string, embodimentModel?:string}} r
 *
 * REFUSES a refusal it cannot record honestly, and RETURNS the refusal-to-record
 * rather than swallowing it — the caller must be able to say "a refusal happened
 * and I could not record it", which is a different and more useful statement
 * than silence. That is deliberately unlike `recordOfficeEvent()`, which sits on
 * the client answer path and must never surface anything; a refusal is not on
 * that path and the asymmetry is the point.
 *
 * `track` defaults to 'office' HERE and only here. Everywhere else in this
 * module a defaulted track is refused, because a wrong track corrupts the
 * per-track quota measurement. A refusal is not a quota-consuming call — nothing
 * was spent, something was declined — so 'office' is a true statement about
 * where the act belongs rather than a guess about where the tokens went.
 */
export async function recordRefusalEvent(env, r = {}) {
  // `characterLine`, not `line` — that is the field name recordRefusal() reads.
  // The first version passed `line`, every refusal was rejected as missing its
  // character line, and the rejection message was so plausible that it read as
  // the mechanism working. Caught by the verifier scenario that asserts a VALID
  // refusal is refused by the FLAG rather than by validation — which is the
  // whole reason that scenario distinguishes the two.
  const validated = validateRefusal({
    who: r.who,
    declined: r.declined,
    characterLine: r.characterLine,
    source: r.source,
    at: r.at,
  });
  if (!validated.ok) {
    console.warn(`[improvement-loop] REFUSAL NOT RECORDED: ${validated.reason}`);
    return { recorded: false, reason: validated.reason, refusalLost: true };
  }

  const result = await recordOfficeEvent(env, {
    agentId: r.agentId,
    eventType: REFUSAL_EVENT,
    track: r.track || 'office',
    embodimentModel: r.embodimentModel || null,
    quality: null,
    title: `refusal — ${validated.refusal.who} declined ${String(validated.refusal.declined).slice(0, 80)}`,
    // The rendered line IS the record. Stored as the office's one shape
    // (renderRefusal) so a reader of this table and a reader of a lifecycle
    // record see the same sentence.
    content: renderRefusal(validated.refusal),
    severity: 'info',
  });

  // A refusal that could not be written is REPORTED as lost, not as absent.
  // B5's whole argument is that it cannot be reconstructed later, so the loss
  // is the thing worth knowing.
  return result.recorded ? result : { ...result, refusalLost: true };
}
