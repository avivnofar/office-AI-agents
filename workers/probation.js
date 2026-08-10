/**
 * workers/probation.js — OFFICE-POLICY.md A3, the probation half of the
 * improvement loop.
 *
 * A change to active context is never written as a fait accompli. It is
 * written LIVE (via context-editor.js writeActiveContextAmendment(), so it
 * genuinely affects the agent's prompt and can be measured) and tracked here
 * as PROVISIONAL until a decision meeting (probation-review.js) rules on it.
 *
 * ── WHAT THE AGENT NEVER SEES ───────────────────────────────────────────────
 *
 * "The agent is not told a change is in probation until it is decided.
 * Knowing distorts the measurement." (A3) — so the provisional bookkeeping
 * lives ENTIRELY in this D1 table. The active-context.md entry itself
 * (context-editor.js) carries no marker, no tag, nothing that would let the
 * agent infer it is being watched. The only link between a live entry and its
 * probation row is the exact rendered entry text, stored in `content` here
 * and matched verbatim by removeActiveContextEntry() on a DROP.
 *
 * ── ACTIONS, NOT DAYS ───────────────────────────────────────────────────────
 *
 * `action_count` increments once per unit of real work that agent does —
 * wired from improvement-loop.js's recordOfficeEvent() on every successful
 * `case_answer` row, so the counter reflects actual office volume rather than
 * calendar time (A3: "an agent's weekly volume is unpredictable").
 *
 * Gated behind the same `learning_loop_enabled` flag as context-editor.js —
 * see that module for the toggle mechanics.
 */

import { learningLoopEnabled, writeActiveContextAmendment, removeActiveContextEntry } from './context-editor.js';

export const PROBATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS probation (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  aspect TEXT NOT NULL,
  proposed_by INTEGER NOT NULL,
  active_context_kind TEXT,
  entry_text TEXT,
  entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  action_count INTEGER NOT NULL DEFAULT 0,
  rounds INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  decided_at TIMESTAMP,
  decision TEXT,
  evidence TEXT,
  decided_by INTEGER
)`;

/** Measured over 20 ACTIONS (A3), never days. */
export const PROBATION_ACTIONS_TARGET = 20;
/** Up to three in probation on one agent, and only on distinct aspects (A3). */
export const MAX_CONCURRENT_PER_AGENT = 3;
/** Open statuses vs. terminal/paused ones — 'open' is the only measurable state. */
export const OPEN_STATUS = 'open';

async function ensureTable(env) {
  await env.DB.prepare(PROBATION_TABLE_SQL).run();
}

/**
 * Proposes and LIVE-WRITES a change to active context, entering it into
 * probation. One call does both — a probation row with no corresponding live
 * write would measure nothing, and a live write with no probation row would
 * be a permanent change with no review, which is exactly the gap A3 exists to
 * close.
 *
 * @param {object} env
 * @param {{actorId:number, targetAgentId:number, aspect:string, content:string}} r
 * @returns {Promise<{proposed:boolean, id?:string, reason?:string}>}
 */
export async function proposeChange(env, { actorId, targetAgentId, aspect, content }) {
  if (!(await learningLoopEnabled(env))) return { proposed: false, reason: 'learning_loop_disabled' };
  if (!env?.DB) return { proposed: false, reason: 'no_db_binding' };
  if (!aspect || typeof aspect !== 'string' || !aspect.trim()) {
    return { proposed: false, reason: 'aspect must be a non-empty string — it is what makes two concurrent changes on the same agent distinguishable (A3)' };
  }

  await ensureTable(env);

  const open = await env.DB.prepare(
    `SELECT id, aspect FROM probation WHERE agent_id = ? AND status = ?`
  ).bind(targetAgentId, OPEN_STATUS).all();
  const openRows = open.results || [];

  if (openRows.length >= MAX_CONCURRENT_PER_AGENT) {
    return {
      proposed: false,
      reason: `agent ${targetAgentId} already has ${openRows.length} change(s) in probation — the concurrency ceiling is ${MAX_CONCURRENT_PER_AGENT} (A3)`,
    };
  }
  if (openRows.some((r) => r.aspect === aspect)) {
    return {
      proposed: false,
      reason: `agent ${targetAgentId} already has an open probation on aspect "${aspect}" — two changes affecting the same aspect cannot be told apart and are refused (A3)`,
    };
  }

  const written = await writeActiveContextAmendment(env, { actorId, targetAgentId, content });
  if (!written.written) {
    return { proposed: false, reason: `the live write was refused, so no probation was opened: ${written.reason}` };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO probation (id, agent_id, aspect, proposed_by, active_context_kind, entry_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, targetAgentId, aspect, actorId, written.kind, written.entryText).run();

  return { proposed: true, id, aspect, entryText: written.entryText, rolledToJournal: written.rolledToJournal };
}

/**
 * Bumps every OPEN probation on `agentId` by one action. Called from
 * improvement-loop.js after a real `case_answer` is recorded — see that
 * module's recordOfficeEvent() for the call site and why it is placed after
 * the capture, not before (same purely-additive discipline: this must never
 * be able to affect whether the underlying work succeeded).
 */
export async function recordProbationAction(env, agentId) {
  if (!(await learningLoopEnabled(env))) return { recorded: false, reason: 'learning_loop_disabled' };
  if (!env?.DB) return { recorded: false, reason: 'no_db_binding' };
  await ensureTable(env);
  const r = await env.DB.prepare(
    `UPDATE probation SET action_count = action_count + 1 WHERE agent_id = ? AND status = ?`
  ).bind(agentId, OPEN_STATUS).run();
  return { recorded: true, changed: r?.meta?.changes ?? null };
}

/** Every open probation that has reached its 20-action measurement window and is due for a decision meeting. */
export async function probationsDueForDecision(env) {
  if (!env?.DB) return [];
  await ensureTable(env);
  const r = await env.DB.prepare(
    `SELECT * FROM probation WHERE status = ? AND action_count >= ? ORDER BY entered_at ASC`
  ).bind(OPEN_STATUS, PROBATION_ACTIONS_TARGET).all();
  return r.results || [];
}

/** Full state for one agent — used by the "up to three, distinct aspects" concurrency check and by reporting. */
export async function openProbationsForAgent(env, agentId) {
  if (!env?.DB) return [];
  await ensureTable(env);
  const r = await env.DB.prepare(
    `SELECT * FROM probation WHERE agent_id = ? AND status = ? ORDER BY entered_at ASC`
  ).bind(agentId, OPEN_STATUS).all();
  return r.results || [];
}

/**
 * Applies a decided outcome to the row and, for 'dropped', reverts the live
 * file. 'kept' needs no file change (the entry is already live and simply
 * stops being provisional). 'extended' resets the counter for one more round
 * rather than closing the row.
 *
 * Decision VALIDATION (who may decide, evidence shape, outcome vocabulary)
 * lives in probation-review.js — this function only APPLIES an already-valid
 * decision, so there is exactly one place a decision can be accepted and one
 * place it takes effect.
 */
export async function applyDecision(env, { probationId, outcome, decidedBy, evidence, decidingActorId }) {
  if (!(await learningLoopEnabled(env))) return { applied: false, reason: 'learning_loop_disabled' };
  if (!env?.DB) return { applied: false, reason: 'no_db_binding' };
  await ensureTable(env);

  const row = await env.DB.prepare(`SELECT * FROM probation WHERE id = ?`).bind(probationId).first();
  if (!row) return { applied: false, reason: `no probation row ${probationId}` };
  if (row.status !== OPEN_STATUS) return { applied: false, reason: `probation ${probationId} is already "${row.status}" — a decision cannot be applied twice` };

  if (outcome === 'extended') {
    await env.DB.prepare(
      `UPDATE probation SET rounds = rounds + 1, action_count = 0, decision = ?, evidence = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(outcome, JSON.stringify(evidence || {}), decidedBy, probationId).run();
    return { applied: true, outcome, stillOpen: true };
  }

  if (outcome === 'kept') {
    await env.DB.prepare(
      `UPDATE probation SET status = 'kept', decision = ?, evidence = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(outcome, JSON.stringify(evidence || {}), decidedBy, probationId).run();
    return { applied: true, outcome, stillOpen: false };
  }

  if (outcome === 'dropped') {
    const reverted = await removeActiveContextEntry(env, {
      actorId: decidingActorId ?? row.proposed_by,
      targetAgentId: row.agent_id,
      entryText: row.entry_text,
    });
    await env.DB.prepare(
      `UPDATE probation SET status = 'dropped', decision = ?, evidence = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(outcome, JSON.stringify(evidence || {}), decidedBy, probationId).run();
    return { applied: true, outcome, stillOpen: false, reverted };
  }

  return { applied: false, reason: `unknown outcome "${outcome}" — must be kept|dropped|extended` };
}

/**
 * B5 applied to a missed decision meeting: the change FALLS (reverts), never
 * silently stays live. Distinct from applyDecision('dropped') in one respect
 * that matters for reporting: this path records the fall as a PROCESS
 * failure (the meeting didn't happen) rather than a CHANGE failure (the
 * change was judged and found wanting) — probation-review.js's
 * meetingMissedFalls() computes which one applies; this function only
 * executes the fall once told to.
 */
export async function applyMissedMeetingFall(env, { probationId, decidingActorId }) {
  if (!(await learningLoopEnabled(env))) return { applied: false, reason: 'learning_loop_disabled' };
  if (!env?.DB) return { applied: false, reason: 'no_db_binding' };
  await ensureTable(env);

  const row = await env.DB.prepare(`SELECT * FROM probation WHERE id = ?`).bind(probationId).first();
  if (!row) return { applied: false, reason: `no probation row ${probationId}` };
  if (row.status !== OPEN_STATUS) return { applied: false, reason: `probation ${probationId} is already "${row.status}"` };

  const reverted = await removeActiveContextEntry(env, {
    actorId: decidingActorId ?? row.proposed_by,
    targetAgentId: row.agent_id,
    entryText: row.entry_text,
  });
  const evidence = { reason: 'no decision meeting was held by the time the 20-action window closed — silence must never read as approval (A3)' };
  await env.DB.prepare(
    `UPDATE probation SET status = 'fell', decision = 'fell_process_failure', evidence = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(JSON.stringify(evidence), probationId).run();

  return { applied: true, outcome: 'fell', failureKind: 'process', reverted, routedBackTo: [6, 7, 8] };
}
