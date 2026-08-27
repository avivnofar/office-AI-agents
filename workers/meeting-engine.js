/**
 * Data Center — AI Agent Simulation — meeting engine.
 *
 * Implements every meeting type referenced by agents-config.json,
 * relationships.json, and promotion-config.json / side-plots.json:
 *   daily_standup, weekly, monthly, quarterly, semi_yearly, yearly,
 *   emergency_huddle, audit_session, private_coaching, pip_session.
 *
 * For each meeting, runMeeting():
 *   1. resolves attendees (relationships.json meeting_default_attendees,
 *      or opts.attendees for trigger-dependent meetings)
 *   2. gathers D1 context relevant to the meeting type
 *   3. builds a single Gemini prompt containing every attendee's
 *      personality + current mood/irritation state + the agenda
 *   4. asks Gemini for an in-character dialogue transcript followed by a
 *      structured JSON "decisions" block
 *   5. applies mood/irritation/state effects to attendees (persisted to
 *      their Durable Objects)
 *   6. persists the meeting (transcript + decisions) to D1 (`meetings`
 *      table, added in schema.sql Part 10)
 *   7. renders a markdown report and (if GITHUB_TOKEN is configured)
 *      commits it to reports/meetings/
 *
 * Design note — "applying decisions to agents-config.json":
 * agents-config.json ships inside the Worker bundle and cannot be mutated
 * at runtime. Decisions that should durably change an agent's behavior
 * (PIP placement, promotion, trait tweaks) are written to that agent's
 * Durable Object state under `configOverrides`. agent-runner.js's
 * instantiateAgent() merges `configOverrides` over the static config when
 * loading an agent (see Part 9), so the *effective* config changes
 * immediately without redeploying. A human can later fold durable
 * overrides back into agents-config.json during a real review.
 *
 * Status: DRAFT (Phase 1 foundation, Phase 2 meeting system).
 */

import agentsConfig from '../config/agents-config.json' with { type: 'json' };
// The capability manifest supplies each role's `output_kinds` to the output
// census. Read from the SAME file workers/capability-audit.js reads, deliberately:
// "what this role is for" gets one definition, so the census and the audit cannot
// disagree about it.
import capabilityManifest from '../config/capability-manifest.json' with { type: 'json' };
import relationships from '../config/relationships.json' with { type: 'json' };
import officeProjects from '../config/office-projects.json' with { type: 'json' };
import { callGemini, callCloudflareFallback } from './gemini-client.js';
import { callGroq } from './groq-client.js';
// ITEM B (2026-08-27). The meeting's model choice becomes a CONFIG entry
// (config/model-routing.json) rather than a constant in this file — see
// composeMeetingCall() for why, and for what the direct chain below it is
// still there to do.
import { routeTaskTypeCall } from './model-router.js';
import { routingEnabled } from './task-router.js';
import { commitFileToRepo, BACKOFFICE_REPO_NAME } from './repo-write.js';
import { getOfficeContext, getOfficeSnapshot } from './office-context.js';
import { enforceAttendeeGate, GATED_EFFECT_FIELDS } from './meeting-attendance.js';
import {
  addOfficeDays, normalizeActionItems, renderBoardTask,
  computeWorkflowMetrics, renderWorkflowMetrics,
  computeOutputCensus, renderOutputCensus,
  normalizeContextAmendments,
  parseMeetingResponse, emptyDecisions,
} from './meeting-decisions.js';
// B5 (2026-08-10) — refusal recording, office-wide. The meeting is where a QA
// rejects, an admin objects and the Workflow bounces something, and it is the
// one moment those are visible to code. See recordMeetingRefusals().
import { recordRefusalEvent } from './improvement-loop.js';
// context_amendments consumer (2026-08-11) — see applyMeetingEffects() below.
// No circular import: context-editor.js only imports repo-write.js, and
// probation.js only imports context-editor.js — neither reaches back here.
import { learningLoopEnabled, writeJournalEntry } from './context-editor.js';
import { proposeChange } from './probation.js';

/*
 * The pure half of the action-items pipeline and the Workflow's metrics live
 * in ./meeting-decisions.js so a plain-Node verifier can import and exercise
 * the REAL functions rather than a hand-written mirror. This module imports
 * config JSON at module scope, which plain `node` refuses; the alternative to
 * splitting is the same three-copies-held-together-by-a-comment drift the
 * 2026-07-12 permission-guard refactor existed to end. Re-exported here so
 * this module's public surface is unchanged.
 */
export {
  addOfficeDays, normalizeActionItems, renderBoardTask,
  computeWorkflowMetrics, renderWorkflowMetrics,
  computeOutputCensus, renderOutputCensus,
  normalizeContextAmendments,
  parseMeetingResponse, emptyDecisions,
} from './meeting-decisions.js';

const SIM_STATE_KEY = 'simulation-state';
const ACTION_ITEMS_FLAG = 'action_items_to_board_enabled';

/**
 * The action_items -> board consumer's kill switch. Default OFF, `=== true`
 * only, off on every failure path (no SIM_KV, unreadable value, absent key).
 * Same shape as improvementLoopEnabled() and officeContextEnabled().
 *
 * ITS OWN SWITCH, not improvement_loop_enabled, deliberately: that flag
 * governs D1 CAPTURE, which is additive and local. This performs a WRITE TO
 * ANOTHER REPOSITORY. Sharing one flag would mean enabling capture silently
 * enabled cross-repo writes, and a graduated rollout whose steps cannot be
 * taken separately is not a graduated rollout.
 */
export async function actionItemsToBoardEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[ACTION_ITEMS_FLAG] === true;
}

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ITEM A (SESSION 26, 2026-08-27) — THE MEETING'S REACH INTO CHARACTER FILES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A meeting's `context_amendments` are the only effect it produces that
 * changes WHO AN AGENT IS. Every other effect it applies — mood, irritation,
 * state, durable config overrides — is state a later meeting can move back.
 * An amendment goes through proposeChange() into probation and from there
 * LIVE into the active-context file under `campus/agents/<slug>/`, which feeds that
 * agent's every prompt from the moment it lands.
 *
 * The attendee gate (2026-08-24) closed the case where the amendment was
 * proposed against an agent WHO WAS NOT IN THE ROOM. It cannot close the
 * case measured this session: 27 of the last 35 meetings produced no
 * decisions at all, every one of them composed by an 8B fallback model, and
 * one closing review asserted "it has been a week since the owner's
 * instruction and we seem to be stuck" three hours BEFORE that instruction
 * was read. That is not a fabricated attendee. It is a real attendee, in a
 * real meeting, reaching a conclusion about a conversation that did not
 * happen — and the gate has nothing to test it against.
 *
 * So this is a switch and not a fix. It does not make the conclusions better;
 * it decides whether a conclusion of unknown provenance is allowed to edit a
 * persona while Items B and C work on the provenance.
 *
 * ── DEFAULT ON, WHICH IS THE OPPOSITE OF EVERY OTHER SWITCH HERE ─────────
 *
 * `guides_enabled`, `routing_enabled`, `learning_loop_enabled` and the rest
 * all default OFF so that deploying a feature does not start it. This one
 * governs a path that is ALREADY RUNNING in production, so an OFF default
 * would mean the deploy itself silently stopped it — a behaviour change
 * smuggled in as a code change. The deploy must change nothing; the owner's
 * toggle is the decision. Same shape as `cases_enabled`, which defaults ON
 * for the same reason.
 *
 * The one exception is an ABSENT SIM_KV binding. A default-ON switch read
 * from nowhere is not a default, it is an unread switch — and this is the one
 * write in the engine that cannot be undone by a later meeting. With no
 * binding it refuses, and says so.
 */
const MEETING_AMENDMENTS_FLAG = 'meeting_context_amendments_enabled';

export async function meetingContextAmendmentsEnabled(env) {
  if (!env?.SIM_KV) return false; // unread, not defaulted — see the block above
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[MEETING_AMENDMENTS_FLAG] !== false;
}

/** Meeting types whose transcripts are synthesized by Gemini 3.1 Flash-Lite
 *  (large-context report writing) — see config/token-economy.json
 *  report_models_by_meeting_type. All other meeting types use Groq
 *  (llama3-8b-8192), falling back to Cloudflare Workers AI. */
const GEMINI_MEETING_TYPES = new Set(['monthly', 'quarterly', 'semi_yearly', 'yearly']);

// REPO_OWNER / REPO_NAME removed 2026-08-07. They were this file's private
// copies of the destination, used by a commitMeetingReport() that never
// consulted the guard. REPO_NAME now comes from repo-write.js, and the
// destination is RESOLVED rather than asserted.

/** All meeting types this engine knows how to run. */
export const MEETING_TYPES = {
  daily_standup: {
    label: 'Opening Standup',
    cadence: 'every simulated work day, at the START of the day',
    requiresOpts: [],
  },
  // ADDED 2026-08-07. The day's second meeting, at the other end of it.
  //
  // TWO RUNS, NOT ONE MERGED MEETING, and the reasoning is a full day of
  // latency. The opening standup is FORWARD-looking (dispatch, what is
  // stuck); the closing review is BACKWARD-looking, on THAT DAY'S OUTPUT.
  // Merged, the day's work could only be reviewed at the NEXT morning's
  // standup, which pushes every conclusion into the following day — the
  // improvement loop would close in two days instead of one. Run at the end
  // of the day, conclusions reach character files before the next day opens.
  // See docs/procedures/MEETING-PROTOCOL.md 4.1.
  closing_qa_review: {
    label: 'Closing QA Review',
    cadence: 'every simulated work day, at the END of the day',
    requiresOpts: [],
  },
  weekly: {
    label: 'Weekly Meeting',
    cadence: 'every simulated work week',
    requiresOpts: [],
  },
  monthly: {
    label: 'Monthly Review',
    cadence: 'every ~4 simulated weeks',
    requiresOpts: [],
  },
  quarterly: {
    label: 'Quarterly Review',
    cadence: 'every ~13 simulated weeks',
    requiresOpts: [],
  },
  semi_yearly: {
    label: 'Semi-Yearly Review',
    cadence: 'every ~26 simulated weeks',
    requiresOpts: [],
  },
  yearly: {
    label: 'Yearly Review',
    cadence: 'every ~52 simulated weeks',
    requiresOpts: [],
  },
  emergency_huddle: {
    label: 'Emergency Huddle',
    cadence: 'trigger-dependent',
    requiresOpts: ['trigger'],
  },
  audit_session: {
    label: 'Audit Session',
    cadence: '1 per agent under QA rank per week',
    requiresOpts: ['auditedAgentId'],
  },
  private_coaching: {
    label: 'Private Coaching Session',
    cadence: 'trigger-dependent',
    requiresOpts: ['targetAgentId', 'reason'],
  },
  pip_session: {
    label: 'PIP Session',
    cadence: 'trigger-dependent',
    requiresOpts: ['targetAgentId'],
  },
};

/* ─────────────────────────── Agent snapshots ───────────────────────────
 * Lightweight, dependency-free read/write of an agent's Durable Object
 * state. Avoids importing agent-runner.js (which will import this module
 * to trigger meetings — circular import otherwise).
 */

function getAgentConfig(id) {
  return agentsConfig.agents.find((a) => a.id === id);
}

async function loadAgentSnapshot(agentId, env) {
  const config = getAgentConfig(agentId);
  let state = {
    mood: 50,
    irritation: 0,
    isHappy: false,
    isAngry: false,
    isPanic: false,
    panicLevel: 0,
    configOverrides: {},
  };

  if (env.AGENT_STATE && config) {
    const doId = env.AGENT_STATE.idFromName(config.durable_object_id);
    const stub = env.AGENT_STATE.get(doId);
    const res = await stub.fetch('https://agent-state/state');
    const data = await res.json().catch(() => null);
    if (data) state = { ...state, ...data, configOverrides: data.configOverrides || {} };
  }

  return { id: agentId, config, state };
}

async function saveAgentSnapshot(agentId, env, state) {
  const config = getAgentConfig(agentId);
  if (!env.AGENT_STATE || !config) return;
  const doId = env.AGENT_STATE.idFromName(config.durable_object_id);
  const stub = env.AGENT_STATE.get(doId);
  await stub.fetch('https://agent-state/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state, updated_at: new Date().toISOString() }),
  });
}

/* ───────────────────────────── Attendees ──────────────────────────────── */

// EXPORTED 2026-08-16 for the same reason as task-router.js's
// checkUnknownCapPacing: it was UNPROVEN on the gate-call audit, and it is the
// function that decides who a meeting transcript may name. Every attribution
// claim enforceAttendeeGate() checks is checked against THIS function's output,
// so an error here is an error the gate cannot see — the declared list would
// simply be wrong, and a fabricated speaker who happens to be on it passes.
// scripts/verify-unproven-gates.js §5 exercises it directly.
export function resolveAttendeeIds(meetingType, opts) {
  if (Array.isArray(opts.attendees) && opts.attendees.length) return opts.attendees;

  const fromRelationships = relationships.meeting_default_attendees?.[meetingType];

  if (meetingType === 'audit_session') {
    return [...new Set([6, 7, opts.auditedAgentId])];
  }
  if (meetingType === 'private_coaching') {
    return [...new Set([opts.coachId ?? 5, opts.targetAgentId])];
  }
  if (meetingType === 'pip_session') {
    return [...new Set([7, opts.targetAgentId])];
  }
  if (meetingType === 'emergency_huddle') {
    return opts.attendees || [5, 6, 7];
  }

  if (fromRelationships === 'all') return agentsConfig.agents.map((a) => a.id);
  if (Array.isArray(fromRelationships)) return fromRelationships;

  // Fallback: leadership group.
  return [11, 7];
}

/* ─────────────────────────── Data gathering ───────────────────────────── */

async function gatherMeetingData(meetingType, env, attendeeIds, opts) {
  if (!env.DB) return { note: 'D1 not bound — no historical data available.' };

  switch (meetingType) {
    case 'daily_standup':
      return gatherDailyStandup(env, attendeeIds);
    case 'closing_qa_review':
      return gatherClosingQaReview(env, attendeeIds);
    case 'weekly':
      return gatherWeekly(env);
    case 'monthly':
    case 'quarterly':
    case 'semi_yearly':
    case 'yearly':
      return gatherLongRange(env, meetingType);
    case 'emergency_huddle':
      return gatherEmergencyHuddle(env, opts);
    case 'audit_session':
      return gatherAuditSession(env, opts.auditedAgentId);
    case 'private_coaching':
      return gatherPrivateCoaching(env, opts);
    case 'pip_session':
      return gatherPipSession(env, opts.targetAgentId);
    default:
      return {};
  }
}

async function gatherDailyStandup(env, attendeeIds) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { results: sessionStats } = await env.DB.prepare(
    `SELECT agent_id, COUNT(*) AS sessions, COALESCE(SUM(cases_handled),0) AS cases,
            AVG(mood_end) AS avg_mood, SUM(irritation_events) AS irritation_events,
            SUM(happy_events) AS happy_events
     FROM agent_sessions WHERE started_at >= ? GROUP BY agent_id`
  ).bind(since).all();

  const { results: openIncidents } = await env.DB.prepare(
    `SELECT r.*, a.name AS agent_name FROM reports r JOIN agents a ON a.id = r.agent_id
     WHERE r.type = 'incident' AND r.created_at >= ? AND r.acknowledged = 0
     ORDER BY r.created_at DESC LIMIT 10`
  ).bind(since).all();

  return { window: '24h', sessionStats, openIncidents };
}

/**
 * The closing review looks at THE DAY THAT JUST HAPPENED — its actual output,
 * not its session statistics. Where the opening standup reads
 * `agent_sessions` (who worked, what mood), this reads `interactions`,
 * `cases` and the day's quality scores: what was actually produced.
 */
async function gatherClosingQaReview(env, attendeeIds) {
  const since = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();

  const { results: todaysWork } = await env.DB.prepare(
    `SELECT i.agent_id, a.name AS agent_name, COUNT(*) AS interactions
     FROM interactions i JOIN agents a ON a.id = i.agent_id
     WHERE i.timestamp >= ? AND i.type != 'idle'
     GROUP BY i.agent_id ORDER BY interactions DESC`
  ).bind(since).all().catch(() => ({ results: [] }));

  const { results: samples } = await env.DB.prepare(
    `SELECT agent_id, type, query, response_summary FROM interactions
     WHERE timestamp >= ? AND type != 'idle' ORDER BY RANDOM() LIMIT 6`
  ).bind(since).all().catch(() => ({ results: [] }));

  // `scored` MEANS SCORED. The `AND quality IS NOT NULL` was added 2026-08-10:
  // COUNT(*) here was counting every row and labelling the total `scored`, while
  // AVG(quality) silently averaged only the rows that had one — the same
  // two-populations-one-sentence error week-07 published ("81 entries, average
  // 0.80"), in the closing QA review's own agenda data. `case_not_asked` now
  // keeps future non-events out of this query by event type; this predicate also
  // keeps the 86 pre-cutover rows out, which the event type cannot.
  const { results: quality } = await env.DB.prepare(
    `SELECT agent_id, AVG(quality) AS avg_quality, COUNT(*) AS scored
     FROM reports WHERE event_type = 'case_answer' AND quality IS NOT NULL AND created_at >= ?
     GROUP BY agent_id`
  ).bind(since).all().catch(() => ({ results: [] }));

  /*
   * ── THE EMPTY-DATA GUARD (SESSION 11, ITEM B, 2026-08-23) ──────────────
   *
   * The `quality` query above keys on `event_type = 'case_answer'`. Case work
   * was RETIRED on 2026-08-23 (R-001, `cases_enabled` reads false in live
   * SIM_KV), so `computeDailyQuestionVolume()` now returns 0 and no new
   * `case_answer` row will ever be written again. Today's 33 rows were written
   * before the switch flipped; from tomorrow this query returns nothing, every
   * day, permanently.
   *
   * That matters more here than in any other gatherer, because of what this
   * meeting's own prompt demands of it:
   *
   *   > "Produce conclusions specific enough to be written into an agent's
   *   >  character file TONIGHT."
   *
   * Those conclusions are real writes — `context_amendments` go through
   * `proposeChange()` into probation and from there into the campus character
   * files that shape how every agent behaves. A meeting handed three empty
   * arrays and told to be specific does not decline; it produces something.
   * The failure mode is not an error, it is a confident conclusion about work
   * that did not happen, filed against a persona, overnight.
   *
   * So emptiness is made a FACT IN THE DATA rather than left as an absence for
   * a model to fill. `nothingToReview` is read by the prompt builder below,
   * which then instructs the meeting to record that there was nothing to
   * review and to return NO conclusions. The meeting still runs — whether the
   * office should hold a review meeting on a day it produced nothing is a
   * separate decision and is the owner's, not this guard's.
   */
  const nothingToReview = !todaysWork?.length && !samples?.length && !quality?.length;

  return { window: 'today', todaysWork, samples, quality, workflowMetrics: null, nothingToReview };
}

async function gatherWeekly(env) {
  const { results: latestWeek } = await env.DB.prepare(
    `SELECT * FROM weekly_analytics WHERE week_start = (SELECT MAX(week_start) FROM weekly_analytics)`
  ).all();

  const { results: incidents } = await env.DB.prepare(
    `SELECT r.*, a.name AS agent_name FROM reports r JOIN agents a ON a.id = r.agent_id
     WHERE r.type = 'incident' AND r.created_at >= datetime('now', '-7 days')
     ORDER BY r.created_at DESC LIMIT 20`
  ).all();

  const { results: suggestions } = await env.DB.prepare(
    `SELECT s.*, a.name AS agent_name FROM suggestions s JOIN agents a ON a.id = s.agent_id
     WHERE s.status = 'pending' ORDER BY
       CASE s.permission_level WHEN 'root' THEN 0 WHEN 'sudo' THEN 1 ELSE 2 END, s.created_at DESC LIMIT 30`
  ).all();

  return { latestWeek, incidents, suggestions };
}

async function gatherLongRange(env, meetingType) {
  const weeks = { monthly: 4, quarterly: 13, semi_yearly: 26, yearly: 52 }[meetingType] || 4;

  const { results: history } = await env.DB.prepare(
    `SELECT agent_id, COUNT(*) AS weeks_recorded, AVG(avg_mood) AS avg_mood,
            SUM(total_cases) AS total_cases, SUM(cases_solved) AS cases_solved,
            SUM(irritation_count) AS irritation_count, SUM(happy_count) AS happy_count,
            SUM(overtime_days) AS overtime_days, SUM(suggestions_filed) AS suggestions_filed
     FROM (SELECT * FROM weekly_analytics ORDER BY week_start DESC LIMIT ?)
     GROUP BY agent_id`
  ).bind(weeks * agentsConfig.agents.length).all();

  const { results: pastMeetings } = await env.DB.prepare(
    `SELECT type, attendees, created_at FROM meetings ORDER BY created_at DESC LIMIT 10`
  ).all().catch(() => ({ results: [] }));

  const { results: yearStats } = await env.DB.prepare(
    `SELECT * FROM year_stats ORDER BY recorded_at DESC LIMIT 1`
  ).all().catch(() => ({ results: [] }));

  return { rangeWeeks: weeks, history, pastMeetings, yearStats: yearStats?.[0] || null };
}

async function gatherEmergencyHuddle(env, opts) {
  const { results: incidents } = await env.DB.prepare(
    `SELECT r.*, a.name AS agent_name FROM reports r JOIN agents a ON a.id = r.agent_id
     WHERE r.type = 'incident' AND r.created_at >= datetime('now', '-1 day')
     ORDER BY r.created_at DESC LIMIT 10`
  ).all();

  return { trigger: opts.trigger, triggerAgentId: opts.triggerAgentId || null, incidents };
}

async function gatherAuditSession(env, auditedAgentId) {
  const { results: recentCases } = await env.DB.prepare(
    `SELECT * FROM cases WHERE assigned_to = ? AND created_at >= datetime('now', '-7 days')
     ORDER BY RANDOM() LIMIT 5`
  ).bind(auditedAgentId).all();

  const { results: interactions } = await env.DB.prepare(
    `SELECT i.* FROM interactions i WHERE i.agent_id = ? ORDER BY i.timestamp DESC LIMIT 10`
  ).bind(auditedAgentId).all();

  const { results: sessionStats } = await env.DB.prepare(
    `SELECT COUNT(*) AS sessions, AVG(mood_end) AS avg_mood, SUM(irritation_events) AS irritation_events,
            SUM(happy_events) AS happy_events FROM agent_sessions
     WHERE agent_id = ? AND started_at >= datetime('now', '-7 days')`
  ).bind(auditedAgentId).all();

  return { auditedAgentId, recentCases, interactions, sessionStats: sessionStats?.[0] || null };
}

async function gatherPrivateCoaching(env, opts) {
  const { results: interactions } = await env.DB.prepare(
    `SELECT * FROM interactions WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 5`
  ).bind(opts.targetAgentId).all();

  return { targetAgentId: opts.targetAgentId, reason: opts.reason, caseData: opts.caseData || null, interactions };
}

async function gatherPipSession(env, targetAgentId) {
  const { results: history } = await env.DB.prepare(
    `SELECT * FROM weekly_analytics WHERE agent_id = ? ORDER BY week_start DESC LIMIT 4`
  ).bind(targetAgentId).all();

  const { results: pastPip } = await env.DB.prepare(
    `SELECT * FROM promotions WHERE agent_id = ? AND track = 'pip' ORDER BY created_at DESC LIMIT 5`
  ).bind(targetAgentId).all().catch(() => ({ results: [] }));

  return { targetAgentId, history, pastPip };
}

/* ──────────────────────────── Prompt building ─────────────────────────── */

function fillPlaceholders(text, snapshot) {
  return (text || '')
    .replace(/\[MOOD\]/g, String(snapshot.state.mood))
    .replace(/\[IRRITATION\]/g, String(snapshot.state.irritation))
    .replace(/\[ANGRY\]/g, String(snapshot.state.isAngry))
    .replace(/\[COMPLACENT\]/g, String(snapshot.state.isComplacent || false))
    .replace(/\[PANIC\]/g, String(snapshot.state.panicLevel))
    .replace(/\[PANIC_LEVEL\]/g, String(snapshot.state.panicLevel))
    .replace(/\[CURRENT_AUDIT_AGENT\]/g, String(snapshot.state.currentAuditAgent || 'n/a'))
    .replace(/\[HEALTH\]/g, String(snapshot.state.projectHealth || 'nominal'))
    .replace(/\[BOOL\]/g, 'true');
}

function relationshipNotesFor(attendeeIds) {
  const ids = new Set(attendeeIds);
  const notes = [];

  for (const r of relationships.rivalries || []) {
    if (r.agents.every((a) => ids.has(a))) {
      notes.push(`RIVALRY between Agent ${r.agents[0]} and Agent ${r.agents[1]}: ${r.description}`);
    }
  }
  for (const p of relationships.partnerships || []) {
    const agentIds = p.agents.filter((a) => typeof a === 'number');
    if (agentIds.length && agentIds.every((a) => ids.has(a))) {
      notes.push(`RELATIONSHIP (${p.type}) involving ${agentIds.map((a) => `Agent ${a}`).join(' & ')}: ${p.description}`);
    }
  }

  return notes;
}

/** Meetings where the Workflow presents his picture: the opening standup
 *  (he dispatches) and the substantive meetings (agenda item 4). */
/*
 * ── EVERY MEETING IN THIS SET MUST ALSO RENDER THEM (fixed 2026-08-10) ────
 *
 * This set decides which meetings COMPUTE the Workflow's measures. Until
 * 2026-08-10, `quarterly`, `semi_yearly` and `yearly` were in it and their
 * agenda builders below rendered neither `data.workflowMetrics` nor anything
 * derived from it — so the four measures were computed, for three meeting types,
 * and consumed by nobody.
 *
 * That is `ARCHITECTURAL-DECISIONS.md` §7.2 exactly, found while adding the
 * output census beside them: a value produced at the right moment, by the right
 * component, for the right reason, and read by nothing. Membership of this set
 * and rendering in the agenda are two facts that must agree, and nothing tied
 * them together. All six now render both blocks;
 * `scripts/verify-office-bureaucracy.js` asserts the two lists match, so adding a
 * meeting type to this set without rendering it fails a check instead of quietly
 * computing into a void.
 */
const WORKFLOW_METRICS_MEETINGS = new Set(['daily_standup', 'weekly', 'monthly', 'quarterly', 'semi_yearly', 'yearly']);

/**
 * Last recorded activity per agent, in epoch ms. Absent from the map means NO
 * activity has ever been recorded — deliberately distinct from "zero days
 * ago", because computeWorkflowMetrics() reports those two differently and
 * only one of them is a problem to act on.
 */
async function lastActivityByAgent(env) {
  if (!env?.DB) return {};
  const { results } = await env.DB.prepare(
    `SELECT agent_id, MAX(timestamp) AS last_at FROM interactions
     WHERE type != 'idle' GROUP BY agent_id`
  ).all().catch(() => ({ results: [] }));
  const out = {};
  for (const r of results || []) {
    const t = Date.parse(r.last_at);
    if (!Number.isNaN(t)) out[r.agent_id] = t;
  }
  return out;
}

/**
 * OUTPUT per agent, by KIND — the input to computeOutputCensus().
 *
 * ── WHY THIS IS A DIFFERENT QUERY FROM lastActivityByAgent() ─────────────
 *
 * That one reads `interactions`, which is EVERY ask the Q&A engine makes. This
 * reads `reports`, which is what the office PRODUCED. The distinction is the
 * whole point of the census: an agent that asks questions all day has a warm
 * `interactions` row and may have produced nothing, and that is exactly how the
 * Designer went two months without ever reading as idle.
 *
 * The kind is `event_type` where the improvement loop supplied one (`case_answer`,
 * `qa_review`, `lead_qa_weekly`, …) and falls back to `type` for the pre-existing
 * document rows (`status`, `incident`, `gap_hebrew`, `weekly`). Those are the two
 * axes `database/schema.sql` deliberately keeps separate — WHAT KIND OF DOCUMENT
 * versus WHAT THE OFFICE DID — and COALESCE takes the more specific one when both
 * are present, which is the axis a role's `output_kinds` are written against.
 *
 * Returns `{}` without D1. An empty map makes every agent read NEVER, which is
 * loud rather than quiet — the safe direction for a census.
 */
async function outputByAgent(env) {
  if (!env?.DB) return {};
  const { results } = await env.DB.prepare(
    `SELECT agent_id,
            COALESCE(event_type, type) AS kind,
            COUNT(*) AS n,
            MAX(created_at) AS last_at
     FROM reports
     GROUP BY agent_id, COALESCE(event_type, type)`
  ).all().catch(() => ({ results: [] }));

  const out = {};
  for (const r of results || []) {
    const entry = out[r.agent_id] || (out[r.agent_id] = { lastAt: null, kinds: {} });
    entry.kinds[r.kind] = (entry.kinds[r.kind] || 0) + Number(r.n || 0);
    const t = Date.parse(r.last_at);
    if (!Number.isNaN(t) && (entry.lastAt === null || t > entry.lastAt)) entry.lastAt = t;
  }
  return out;
}

/** The standing agenda for the substantive meetings, in order
 *  (MEETING-PROTOCOL.md 4.2). Item 1 is prepended separately in
 *  buildMeetingPrompt() so a new meeting type cannot omit it. */
const SUBSTANTIVE_AGENDA = `Then, IN THIS ORDER:
2. PRODUCT DECISIONS — only after the relevant agents have reviewed the preliminary work. The Architect (Agent 10) is substantively involved in product planning and speaks at length here; he is not a rubber stamp and not a closing summary.
3. CONFLICT RESOLUTION — anything unresolved between agents.
4. THE WORKFLOW'S PRODUCTIVITY PICTURE — Agent 12 presents the four measures as given. He does not average them into one number.
5. OPEN QUESTIONS TO THE CLIENT — the office's questions to the owner are listed above (back-office channel/to-owner/OPEN-QUESTIONS.md). This item is NOT "answer them" — the office cannot. For each open question, check three things: does it still block what it claims to block; is its stated fallback still the right fallback; and has it been open long enough that the fallback should simply be TAKEN. A question the office has already worked around is a question to WITHDRAW, not to keep waiting on. If the list is absent from the context above, say so — do not assume the office has nothing to ask.
6. DELIVERABLES IN FLIGHT — the office's own built work, listed in the context above. Three things, in this order. (a) ASSIGN THE OUTSTANDING REVIEWS BY NAME, the same way you assign any other task: reviewing is work, not a courtesy someone performs when they notice. An admin who has nothing to say ABSTAINS EXPLICITLY and the abstention is recorded — silence is never approval and it will block the deliverable. (b) TAKE UP THE GAPS raised in review. A gap becomes a DECISION here; it does not go back to whoever built it in a private message. Class each gap binding or routine before acting on it. (c) A deliverable reported as NOT CONVERGING is a FINDING to discuss — not a reason to stop it and not a reason to ship it. There is no cap on review rounds.
7. VOTES — every binding decision reached above is put to a vote. ADMINS ONLY vote. The CEO (Agent 11) leads, holds a DOUBLE VOTE and a VETO. Routine work distribution is NOT voted on — only product decisions, conflict resolution, and anything touching the client, or the mechanism stops meaning anything. Record each vote as: the question, who voted which way, the outcome, the date. On a TIE, the meeting decides whether to keep investigating the question, defer it, or drop it — and that resolution is itself recorded.`;

const AGENDA_BUILDERS = {
  daily_standup: (data) => `Run the OPENING STANDUP — forward-looking, the start of the day. The Workflow (Agent 12) dispatches: he states what is going out to whom today, presents his metrics, and names what is stuck. HE ALSO ASSIGNS REVIEW WORK: any deliverable listed as IN FLIGHT in the context above with reviews still owed gets those reviews assigned TODAY, BY NAME, exactly as build work is assigned. Reviewing is work, not a courtesy someone performs when they notice; an admin with nothing to say abstains explicitly and it is recorded. Each other attendee gives a 1-2 sentence status.\nSession data:\n${JSON.stringify(data.sessionStats)}\nOpen incidents to address: ${JSON.stringify(data.openIncidents)}\n${data.workflowMetrics || ''}
${data.outputCensus || ''}`,
  // ITEM B (2026-08-23): the guard fires BEFORE the prompt is built. A meeting
  // with nothing to review is told to say so and to return no conclusions —
  // rather than being handed three empty arrays and an instruction to be
  // specific, which is a request for invention. See gatherClosingQaReview().
  closing_qa_review: (data) => (data.nothingToReview
    ? `Run the CLOSING QA REVIEW. THERE IS NOTHING TO REVIEW TODAY: the office recorded no interactions, no sampled output and no quality scores in this window. This is a fact, not a gap in your information.
Say so plainly, in one or two lines, and STOP. Do NOT infer what the agents were probably doing. Do NOT restate yesterday. Do NOT produce conclusions, context_amendments, action_items, mood_effects or state_changes — every one of those must be an EMPTY ARRAY. A conclusion written into an agent's character file tonight on the strength of no data is worse than no conclusion, because it is indistinguishable from one that was earned.`
    : `Run the CLOSING QA REVIEW — backward-looking, the end of the day, on TODAY'S OUTPUT ONLY. This is not a standup and not a planning meeting: do not discuss tomorrow.\nWhat was produced today:\n${JSON.stringify(data.todaysWork)}\nSampled output:\n${JSON.stringify(data.samples)}\nQuality scores recorded today:\n${JSON.stringify(data.quality)}\nThe QA (6) reviews WORK QUALITY; the Team Lead (7) reviews the WORKER MODEL — persona consistency, behavioural drift, context gaps. Produce conclusions specific enough to be written into an agent's character file TONIGHT. The whole point of running this at the end of the day rather than at tomorrow's standup is that conclusions reach the files before the next day opens, so a vague conclusion defeats the entire arrangement.`),
  weekly: (data) => `Run the weekly meeting. Review last week's metrics:\n${JSON.stringify(data.latestWeek)}\nIncidents: ${JSON.stringify(data.incidents)}\nPending suggestions (decide approve/reject for at least the root and sudo ones): ${JSON.stringify(data.suggestions)}\n${data.workflowMetrics || ''}
${data.outputCensus || ''}\n\n${SUBSTANTIVE_AGENDA}`,
  monthly: (data) => `Run the monthly review. Trends over the last ${data.rangeWeeks} weeks:\n${JSON.stringify(data.history)}\nRecent meetings: ${JSON.stringify(data.pastMeetings)}\n${data.workflowMetrics || ''}
${data.outputCensus || ''}\n\n${SUBSTANTIVE_AGENDA}`,
  quarterly: (data) => `Run the quarterly review. Trends over the last ${data.rangeWeeks} weeks:\n${JSON.stringify(data.history)}\nDiscuss the IT Chief's quarterly equipment/network/programming optimization demands and the Architect's quarterly big-project update. Year stats: ${JSON.stringify(data.yearStats)}
${data.workflowMetrics || ''}
${data.outputCensus || ''}`,
  semi_yearly: (data) => `Run the semi-yearly review. Trends over the last ${data.rangeWeeks} weeks:\n${JSON.stringify(data.history)}\nDiscuss promotion candidates and any rivalry/relationship developments.
${data.workflowMetrics || ''}
${data.outputCensus || ''}`,
  yearly: (data) => `Run the yearly review. Full-year trends:\n${JSON.stringify(data.history)}\nYear stats: ${JSON.stringify(data.yearStats)}\nThis is the year-end meeting: discuss promotion nominations (CEO + admin majority vote), the executive summary, and recommendations for next year.
${data.workflowMetrics || ''}
${data.outputCensus || ''}`,
  emergency_huddle: (data) => `EMERGENCY HUDDLE. Trigger: ${data.trigger}. Triggering agent: ${data.triggerAgentId}. Recent incidents: ${JSON.stringify(data.incidents)}\nDiscuss root cause and produce concrete action items.`,
  audit_session: (data) => `AUDIT SESSION for Agent ${data.auditedAgentId}. Sample cases: ${JSON.stringify(data.recentCases)}\nRecent interactions: ${JSON.stringify(data.interactions)}\nSession stats (7d): ${JSON.stringify(data.sessionStats)}\nQA and Team Lead troubleshoot the sampled cases together with Claude (in character — describe what you'd ask), then rate model performance vs the audited agent's performance (1-10 each) with optimization suggestions for both.`,
  private_coaching: (data) => `PRIVATE COACHING SESSION for Agent ${data.targetAgentId}. Reason: ${data.reason}. Related case: ${JSON.stringify(data.caseData)}\nRecent interactions: ${JSON.stringify(data.interactions)}\nReview the workflow that led to the issue and agree on a documentation/process update.`,
  pip_session: (data) => `PIP SESSION for Agent ${data.targetAgentId}. Recent weekly history: ${JSON.stringify(data.history)}\nPast PIP records: ${JSON.stringify(data.pastPip)}\nDecide: place on PIP / continue existing PIP / graduate from PIP, with specific, measurable improvement targets and a 1-simulated-month duration.`,
};

/*
 * ITEM C (2026-08-27). The JSON shape and its rules, lifted out of
 * DECISIONS_SCHEMA_HINT below so that BOTH the old combined prompt and the new
 * decisions-only prompt read the SAME text. Not one character of the schema
 * moved: C2 is explicit that this session changes the wiring and not what a
 * meeting is asked to produce, and two copies of a schema held together by a
 * comment is the exact drift this repo has a name for.
 */
const DECISIONS_JSON_SHAPE = `{
  "summary": "1-3 sentence summary of outcomes",
  "mood_effects": [{ "agent_id": <int>, "delta": <int -20..20>, "reason": "<short reason>" }],
  "irritation_effects": [{ "agent_id": <int>, "delta": <int -2..2>, "reason": "<short reason>" }],
  "state_changes": [{ "agent_id": <int>, "field": "isHappy|isAngry|isPanic|panicLevel|isComplacent", "value": <bool|number>, "reason": "<short reason>" }],
  "action_items": [{ "agent_id": <int>, "task": "<one imperative sentence>", "delivered": "<the ARTIFACT that will exist>", "due_days": <int office-days>, "decided": <bool>, "open_question": "<if decided is false, what was left unsettled>" }],
  "context_amendments": [{ "agent_id": <int>, "aspect": "<short slug, e.g. 'escalation-tone'>", "content": "<the exact text to add to that agent's active context>", "proposed_by": <int, the agent id actually proposing it — the QA or the Team Lead, never the target agent itself> }],
  "config_overrides": [{ "agent_id": <int>, "overrides": { "<config_key>": <value> }, "reason": "<short reason>" }],
  "suggestion_decisions": [{ "suggestion_id": "<id or empty>", "decision": "approved|rejected", "reason": "<short reason>" }],
  "refusals": [{ "agent_id": <int>, "declined": "<what this character declined, in one clause>", "character_line": "<the line of THEIR OWN character or role this refusal came from, quoted or closely paraphrased from their persona above>" }]
}
Then the marker ---END---.
Every array may be empty. Keep the JSON valid and self-contained.

RULES FOR refusals — the office policy's B5, and it binds the whole office, not only the night run:
- A REFUSAL IS ANY MOMENT A CHARACTER DECLINED SOMETHING. The QA rejecting a deliverable. An admin objecting to a task. The Workflow bouncing an ambiguous item back. A vote cast against. Someone refusing to sign off. If it happened in the transcript above, it belongs here.
- "character_line" is REQUIRED and must come from THAT AGENT'S OWN persona text in this prompt. It answers "which part of who they are made them say no".
- IF YOU CANNOT NAME THE LINE, OMIT THE ENTRY. Do not invent one. A refusal recorded with a manufactured character line reads as evidence and is an invention — and an entry without the line is DROPPED at parse time anyway, so inventing one only makes the record worse.
- Do not manufacture refusals to fill the array. An empty array is the correct answer for a meeting where nobody declined anything.

RULES FOR action_items — these are ENFORCED, and an item breaking them is DROPPED, not repaired:
- "agent_id" is REQUIRED and must be a real staff id. If you cannot say who owns an item, DO NOT INVENT AN OWNER — omit the item. An unowned action item is not an action item.
- "delivered" must name an ARTIFACT that will exist, not an activity. "Audit the gates" is an activity and will be dropped. "A table in findings/gate-call-audit.md with one row per gate and a CALLED/NOT-CALLED/UNPROVEN verdict" is an artifact. The test: could two people disagree about whether it exists?
- "decided": use FALSE when the meeting did NOT settle the item, and put the unsettled part in "open_question". This is a real and expected outcome, not a failure — say so rather than manufacturing agreement. A decided:false item is recorded as NOT-READY and a person resolves it.
- "due_days" counts OFFICE-DAYS from dispatch (a day the office is open; Saturday is not one).

RULES FOR context_amendments — OFFICE-POLICY A2/A3. This is ONLY meaningful for the Closing QA Review, where the QA (6) reviews work quality and the Team Lead (7) reviews the worker model:
- "agent_id" is the OTHER agent this change is about. NEVER the QA or the Team Lead proposing it — A2: "No agent modifies its own active context." An entry where agent_id equals proposed_by is DROPPED.
- "proposed_by" must be 6 (the QA) or 7 (the Team Lead) — those are the only two roles this policy lets change another agent's context.
- "content" is the EXACT text to add — specific enough to change behaviour, not a vague impression. "Be more careful" is not usable; "when a case cites a firewall rule, name the specific rule number before recommending a change" is.
- Every entry here enters PROBATION, not a permanent change — do not write as though this is final. If nothing concrete changed today, the correct answer is an empty array, not a manufactured entry to fill it.`;

/**
 * The ORIGINAL combined instruction, rebuilt from the shape above so it is
 * byte-for-byte what it has always been. Kept because it is what a single-call
 * meeting asks for, and single-call is still the shape a caller gets if the
 * two-call split is ever unwound.
 */
const DECISIONS_SCHEMA_HINT = `
Respond in two parts:
1. A realistic dialogue transcript between the attendees, staying strictly in character (use their personality, mood, and behavioral rules). Use "Name: line" format, one line per turn, 6-20 turns.
2. On a new line, the exact marker ---DECISIONS--- followed by a single JSON object (no markdown fences) with this shape:
${DECISIONS_JSON_SHAPE}`;

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ITEM C — THE TRANSCRIPT AND THE DECISIONS STOPPED COMPETING
 * ══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED, 2026-08-26: `output_tokens = 1024` against a `maxTokens: 1024`
 * ceiling, with the JSON cut mid-word inside the block. Three of the seven
 * meetings recorded since the instrumentation landed ended on that exact
 * number. One budget was serving two products, the dialogue was written
 * first, and so the dialogue always won — the truncation lands in the
 * decisions every time, which is why 27 of the last 35 meetings have empty
 * decision arrays.
 *
 * A bigger single budget was the obvious move and it is the wrong one: it
 * makes truncation rarer without making it impossible, and it leaves the
 * order of consumption unchanged. Two calls with two budgets is a structural
 * answer to a structural problem.
 *
 * THE SECOND CALL'S INPUT IS THE TRANSCRIPT, NOT THE AGENDA (C3). That is the
 * more important half. The office has a recorded case of a closing review
 * asserting "it has been a week since the owner's instruction and we seem to
 * be stuck" three hours BEFORE that instruction was read — a model handed an
 * agenda and told to produce conclusions produces conclusions about the
 * meeting it was ASKED to hold, not the one that happened. Reading decisions
 * off the transcript that actually exists is what removes the gap that
 * invention fills.
 */
const TRANSCRIPT_ONLY_HINT = `Produce ONE thing and nothing else: a realistic dialogue transcript between the attendees, staying strictly in character (use their personality, mood, and behavioral rules). Use "Name: line" format, one line per turn, 6-20 turns.

Let the meeting reach its natural end and then stop. Do NOT write a JSON block, do NOT write the marker ---DECISIONS---, and do NOT append a summary. A separate pass reads the decisions off this transcript, so anything decided here must be VISIBLE HERE as something someone said. There is no budget being shared with anything else: write the conversation the agenda actually calls for.`;

const DECISIONS_ONLY_HINT = `A meeting has ALREADY HAPPENED. Its transcript is printed below. Your one job is to record what it decided.

Every entry you write must be traceable to a line in that transcript. If the transcript does not show something being settled, the correct answer is an EMPTY ARRAY — an agenda item that was raised and not resolved produces no entry, and a decision that is not in the transcript did not happen no matter what the agenda asked for. Do not complete the meeting on its behalf.

Output the exact marker ---DECISIONS--- on its own line, then a single JSON object (no markdown fences) with this shape:
${DECISIONS_JSON_SHAPE}`;

/**
 * Meeting types that get the office's own work in their prompt.
 *
 * NOT every meeting. A standup is dispatch and blockers; a monthly review is
 * where the client requirements get examined. Handing the same block to both
 * would cost the same and mean less. Per-type, not one blob, because
 * AGENDA_BUILDERS is already a per-type table and this follows it.
 */
const OFFICE_CONTEXT_MEETINGS = new Set([
  'daily_standup', 'closing_qa_review', 'weekly', 'monthly', 'quarterly', 'semi_yearly', 'yearly',
]);

/** Meetings whose FIRST agenda item is the client requirements
 *  (MEETING-PROTOCOL.md 4.2). Weekly and up — never the dailies, which are
 *  about the day, and never the 1:1s. */
const CLIENT_REQUIREMENTS_MEETINGS = new Set([
  'weekly', 'monthly', 'quarterly', 'semi_yearly', 'yearly',
]);

function buildMeetingPrompt(meetingType, attendeeSnapshots, data, opts) {
  const meta = MEETING_TYPES[meetingType];

  const personas = attendeeSnapshots
    .map((snap) => {
      const persona = fillPlaceholders(snap.config?.system_prompt_additions || `You are ${snap.config?.name}.`, snap);
      const overrideNote = Object.keys(snap.state.configOverrides || {}).length
        ? `\nActive durable overrides: ${JSON.stringify(snap.state.configOverrides)}`
        : '';
      return `=== Agent ${snap.id} — ${snap.config?.name} (${snap.config?.role}) ===\n${persona}${overrideNote}`;
    })
    .join('\n\n');

  const relNotes = relationshipNotesFor(attendeeSnapshots.map((s) => s.id));

  // The office's own work. Empty when the switch is off, when this meeting
  // type does not take it, or when back-office could not be read — and in the
  // last case the caller has already logged the reason.
  const officeBlock = OFFICE_CONTEXT_MEETINGS.has(meetingType) && opts?.officeContext?.text
    ? opts.officeContext.text
    : '';

  const systemPrompt = [
    `You are simulating a "${meta.label}" at a small IT company's office. The following personas are attendees. Roleplay all of them faithfully and consistently with their states and behavioral rules.`,
    personas,
    relNotes.length ? `Known dynamics:\n- ${relNotes.join('\n- ')}` : '',
    officeBlock,
    // ITEM C: this call now asks for the transcript ALONE. The decisions are
    // asked for separately, by buildDecisionsPrompt() below, off the
    // transcript this produces. DECISIONS_SCHEMA_HINT — the combined
    // instruction — is unchanged and simply has no caller on this path.
    TRANSCRIPT_ONLY_HINT,
  ].filter(Boolean).join('\n\n');

  const agendaBuilder = AGENDA_BUILDERS[meetingType] || (() => 'Run a general meeting and produce decisions.');

  // The standing agenda's FIRST item (MEETING-PROTOCOL.md 4.2). Prepended
  // rather than woven into each AGENDA_BUILDERS entry, so that adding a
  // meeting type cannot accidentally omit it.
  const requirementsFirst = CLIENT_REQUIREMENTS_MEETINGS.has(meetingType) && officeBlock
    ? 'AGENDA ITEM 1 (ALWAYS FIRST, never a closing summary): Where do we stand against the client requirements listed above? Name each requirement by its REQ id, say whether its status is still accurate, and if it is not, say what it should be and why. If nothing has moved on a requirement, SAY THAT PLAINLY rather than inventing progress.\n\n'
    : '';

  // ── THE ARCHITECT'S NIGHT WORK — A CONDITIONAL AGENDA ITEM ─────────────
  //
  // Added 2026-08-10 with the bible's "He sometimes doesn't sleep" block. The
  // Architect occasionally works unattended overnight; the office is supposed to
  // discuss what a night produced.
  //
  // CONDITIONAL, AND THAT IS THE DESIGN, NOT A SHORTCUT. A standing agenda item
  // about a thing that may not have happened teaches a meeting to report on
  // nothing — and this project has a name for what comes next: a model handed
  // "discuss last night's run" on a night with no run will discuss one anyway.
  // So the item exists only when `architectRuns` carries real rows, and the rows
  // come from D1 (`reports.type = 'architect_session'`, filed by
  // architect-liaison.js from the run's own session record) rather than from an
  // assumption about a schedule. NO RUN → NO ITEM, and nothing anywhere says a
  // run was expected, because none ever is.
  const runs = Array.isArray(opts?.architectRuns) ? opts.architectRuns : [];
  const architectNight = runs.length
    ? `AGENDA ITEM — THE ARCHITECT'S NIGHT WORK. ${runs.length} unattended Architect session(s) have been filed since this meeting last ran:\n`
      + runs.map((r) => `- ${r.created_at} · ${r.title}${r.content ? ` · ${String(r.content).slice(0, 400)}` : ''}`).join('\n')
      + '\nDiscuss WHAT IT PRODUCED, as work: is it right, does it need review, does it change anything already decided, and does anything now need to go back to him. Two things not to do. Do NOT treat these runs as a schedule or a shift — they are occasional, unannounced, and may not happen again for a while; an office that plans around the next one is planning around something nobody promised. And do NOT congratulate the run in place of reviewing it — he is the office\'s final technical authority and his output is still output.\n\n'
    : '';

  const prompt = `Meeting type: ${meta.label}\nDate: ${new Date().toISOString()}\n\n${requirementsFirst}${architectNight}Agenda data:\n${agendaBuilder(data)}`;

  return { systemPrompt, prompt };
}

/**
 * ITEM C's second call. Deliberately NOT a variant of buildMeetingPrompt():
 * the two prompts share the personas and nothing else, and that is the point.
 *
 * WHAT THIS PROMPT DOES NOT CARRY: the agenda, the office context block, the
 * board, the metrics, the census — everything the transcript call was given in
 * order to HOLD the meeting. A decisions pass that can still see the agenda can
 * still answer from it, which is the failure this split exists to remove. What
 * it can see is the conversation that actually happened.
 *
 * WHAT IT DOES CARRY: the personas, in full. `refusals` requires a
 * `character_line` quoted from that agent's own persona text "in this prompt" —
 * a rule that silently becomes unfollowable, and a field that silently becomes
 * empty, if the personas are dropped here to save tokens.
 */
function buildDecisionsPrompt(meetingType, attendeeSnapshots, transcript) {
  const meta = MEETING_TYPES[meetingType];

  const personas = attendeeSnapshots
    .map((snap) => {
      const persona = fillPlaceholders(snap.config?.system_prompt_additions || `You are ${snap.config?.name}.`, snap);
      return `=== Agent ${snap.id} — ${snap.config?.name} (${snap.config?.role}) ===\n${persona}`;
    })
    .join('\n\n');

  const systemPrompt = [
    `You are recording the decisions of a "${meta.label}" that has already taken place at a small IT company's office. These are the people who were in the room.`,
    personas,
    DECISIONS_ONLY_HINT,
  ].filter(Boolean).join('\n\n');

  const prompt = `Meeting type: ${meta.label}\nDate: ${new Date().toISOString()}\n`
    + 'Attendees (authoritative — nobody else was in the room): '
    + `${attendeeSnapshots.map((s) => `Agent ${s.id} — ${s.config?.name}`).join(', ')}\n\n`
    + `TRANSCRIPT OF THE MEETING:\n\n${transcript}`;

  return { systemPrompt, prompt };
}

/* ──────────────────────────── Response parsing ─────────────────────────── */
// parseMeetingResponse(), findDecisionsMarker() and emptyDecisions() moved to
// meeting-decisions.js on 2026-08-11 — same reason every other pure decision
// function lives there (this module's header): it imports config JSON at
// module scope, so plain `node` cannot load it, and a parser this important
// needs a real regression test against a captured live transcript, not a
// text-proximity check on the source. Re-exported below via the existing
// `export { ... } from './meeting-decisions.js'` block.

/* ──────────────────── Action items -> board tasks (I/O) ────────────────── */

/**
 * THE SIXTH BRANCH. Until 2026-08-07, applyMeetingEffects() consumed five of
 * the six decision arrays and `action_items` was the one with no consumer: it
 * was rendered into the report as markdown checkboxes and dropped. The office
 * had been holding meetings that produced action items and discarding them.
 *
 * Specification: back-office campus/shared/board/DECISION-PIPELINE.md.
 * Validation and rendering: ./meeting-decisions.js (pure, verifier-testable).
 *
 * back-office is code_write:false, so this is a MARKDOWN write through
 * resolveRepoWrite() with BACKOFFICE_REPO_TOKEN — the path plan item 0.3
 * built, and the reason it was built.
 *
 * Appends to a dated INBOX file rather than editing BOARD.md. Two reasons,
 * both deliberate: BOARD.md's ID sequence is the Workflow's to allocate (its
 * README: one writer), and IDs are never reused, so allocation cannot be done
 * by an appending process that has not read the board. The Workflow accepts
 * items from the inbox and assigns real OB-NNN ids — the same accept/reject
 * step OB-022 already established for proposed tasks.
 */
export async function writeActionItemsToBoard(env, { meetingType, items, dropped, sourceLabel = null }) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // `sourceLabel` (2026-08-11, Phase 5): the original caller is always a
  // meeting, so the default reproduces its exact prior wording byte for
  // byte. The capability-audit caller (agent-runner.js) is not a meeting and
  // passes its own label so the inbox file does not misreport a fact —
  // "capability_audit meeting" would be wrong, not just awkward.
  const label = sourceLabel || `${meetingType} meeting`;

  const blocks = items.map((item, i) => renderBoardTask(item, {
    id: `PROPOSED-${stamp}-${String(i + 1).padStart(2, '0')}`,
    meetingType,
    dateStr,
    agentName: getAgentConfig(item.agentId)?.name || null,
    sourceLabel: label,
  }));

  const droppedBlock = dropped.length
    ? `\n## Dropped by the pipeline — ${dropped.length}\n\n**Not a failure to hide.** Each line is an item the ${label} produced that could not become a task, with the reason. A missing owner or a roster gap surfaces HERE rather than as a guessed assignment.\n\n${dropped.map((d) => `- \`${String(JSON.stringify(d.item)).slice(0, 200)}\` — ${d.reason}`).join('\n')}\n`
    : `\n## Dropped by the pipeline — 0\n\n_Every item the ${label} produced passed validation._\n`;

  const markdown = `# Proposed board tasks — ${label}, ${dateStr}

**Classification:** private · **Generated by:** \`workers/meeting-engine.js\` action_items pipeline
**Status:** PROPOSED. Not on the board yet.

> The Workflow (Agent 12) accepts or rejects these and allocates real
> \`OB-NNN\` ids. This file never edits \`BOARD.md\` directly — the board has
> one writer by contract, and IDs are never reused.

## Proposed tasks — ${items.length}

${blocks.join('\n') || `_None. The ${label} produced no action item that passed validation._`}
${droppedBlock}`;

  const path = `campus/shared/board/inbox/${dateStr}-${meetingType}-${stamp}.md`;
  const result = await commitFileToRepo(
    env,
    BACKOFFICE_REPO_NAME,
    path,
    markdown,
    `chore(office): ${label} action items -> board inbox [skip ci]`
  );

  if (!result.committed) {
    console.warn(`[meeting-engine] action_items board write DENIED or failed: ${result.reason || result.status} (blocked=${result.blocked || 'n/a'})`);
  }
  return { ...result, proposed: items.length, dropped: dropped.length, path };
}

/* ────────────────────────────── Effects ───────────────────────────────── */

/**
 * B5 — RECORD EVERY REFUSAL AT THE MOMENT IT HAPPENS. Office-wide.
 *
 * Runs at the end of the meeting, which IS the moment: the meeting is one
 * model call, the refusals are reported in its own decisions block, and this is
 * the first code to see them. B5's argument is that a refusal reconstructed
 * later is an invention; recording them here is the only point at which they
 * are not.
 *
 * REFUSES an entry with no character line and SAYS SO. `recordRefusalEvent()`
 * returns `refusalLost: true` in that case, and this function logs the loss
 * rather than dropping it silently — "a refusal happened and we could not
 * record it" is a different and more useful fact than nothing at all.
 *
 * Cannot throw. A meeting that failed to file its paperwork must still have
 * happened; the transcript, the decisions and the mood effects are the meeting.
 */
async function recordMeetingRefusals(meetingType, attendeeSnapshots, decisions, env) {
  const entries = Array.isArray(decisions?.refusals) ? decisions.refusals : [];
  if (!entries.length) return { recorded: 0, lost: 0 };

  const byId = new Map(attendeeSnapshots.map((s) => [s.id, s]));
  let recorded = 0;
  let lost = 0;
  for (const e of entries) {
    // An id that was not in the room is dropped: a character who was not at the
    // meeting did not refuse anything at it, and attributing a refusal to an
    // absent agent is the same invention B5 forbids, one step removed.
    const snap = byId.get(e?.agent_id);
    if (!snap) { lost += 1; console.warn(`[meeting-engine] refusal names agent ${e?.agent_id}, who was not an attendee — dropped`); continue; }
    const res = await recordRefusalEvent(env, {
      agentId: e.agent_id,
      who: `Agent ${e.agent_id} — ${snap.config?.name || 'unknown'}`,
      declined: e.declined,
      characterLine: e.character_line,
      source: `${meetingType} meeting`,
      track: 'office',
    }).catch((err) => ({ recorded: false, refusalLost: true, reason: err?.message }));
    if (res?.recorded) recorded += 1;
    else { lost += 1; console.warn(`[meeting-engine] REFUSAL LOST (agent ${e.agent_id}): ${res?.reason}`); }
  }
  return { recorded, lost };
}

async function applyMeetingEffects(meetingType, attendeeSnapshots, decisions, env) {
  const snapshotsById = new Map(attendeeSnapshots.map((s) => [s.id, s]));
  const attendeeIds = new Set(attendeeSnapshots.map((s) => s.id));

  // CEO's "zone of influence": joint sessions she attends get +20% morale.
  const ceoPresent = attendeeIds.has(11);
  // Lead QA's meeting_trigger_amplifier: when present, mood deltas for
  // everyone else in the meeting are amplified.
  const leadQaPresent = attendeeIds.has(8);
  const amplifier = leadQaPresent ? 1.5 : 1;
  const ceoBoost = ceoPresent ? 1.2 : 1;

  for (const effect of decisions.mood_effects || []) {
    const snap = snapshotsById.get(effect.agent_id) || (await loadAgentSnapshot(effect.agent_id, env));
    const factor = effect.agent_id === 8 ? 1 : amplifier * ceoBoost;
    const delta = Math.round((effect.delta || 0) * factor);
    snap.state.mood = Math.min(100, Math.max(0, snap.state.mood + delta));
    await saveAgentSnapshot(effect.agent_id, env, snap.state);
  }

  for (const effect of decisions.irritation_effects || []) {
    const snap = snapshotsById.get(effect.agent_id) || (await loadAgentSnapshot(effect.agent_id, env));
    snap.state.irritation = Math.min(5, Math.max(0, snap.state.irritation + (effect.delta || 0)));
    if (snap.state.irritation === 0) snap.state.isAngry = false;
    await saveAgentSnapshot(effect.agent_id, env, snap.state);
  }

  for (const change of decisions.state_changes || []) {
    const snap = snapshotsById.get(change.agent_id) || (await loadAgentSnapshot(change.agent_id, env));
    snap.state[change.field] = change.value;
    await saveAgentSnapshot(change.agent_id, env, snap.state);
  }

  // Durable overrides — see module doc. Merged into each affected agent's
  // DO state; agent-runner.js's instantiateAgent() merges these over the
  // static agents-config.json entry at load time (Part 9).
  for (const override of decisions.config_overrides || []) {
    const snap = snapshotsById.get(override.agent_id) || (await loadAgentSnapshot(override.agent_id, env));
    snap.state.configOverrides = { ...(snap.state.configOverrides || {}), ...(override.overrides || {}) };
    await saveAgentSnapshot(override.agent_id, env, snap.state);
  }

  // Suggestion approve/reject decisions made during the meeting.
  if (env.DB) {
    for (const sd of decisions.suggestion_decisions || []) {
      if (!sd.suggestion_id) continue;
      const status = sd.decision === 'approved' ? 'approved' : sd.decision === 'rejected' ? 'rejected' : 'pending';
      if (status === 'pending') continue;
      await env.DB.prepare(`UPDATE suggestions SET status = ? WHERE id = ?`).bind(status, sd.suggestion_id).run().catch(() => {});
    }
  }

  // SIXTH BRANCH — action items become board tasks. Behind its own switch,
  // default OFF. See actionItemsToBoardEnabled() for why it is not sharing
  // improvement_loop_enabled.
  if (await actionItemsToBoardEnabled(env)) {
    const rosterIds = agentsConfig.agents.map((a) => a.id);
    const { items, dropped } = normalizeActionItems(decisions.action_items, { rosterIds });
    for (const d of dropped) console.warn(`[meeting-engine] action item DROPPED: ${d.reason}`);
    if (items.length || dropped.length) {
      await writeActionItemsToBoard(env, { meetingType, items, dropped }).catch((err) => {
        console.warn(`[meeting-engine] action_items board write threw: ${err.message}`);
      });
    }
  }

  // context_amendments -> probation (A2/A3), closed 2026-08-11. See
  // normalizeContextAmendments() for why this is validated in code rather
  // than trusted from the model, and the module header note on why
  // closing_qa_review had produced conclusions with nowhere to go until now.
  // Gated on the SAME switch as every other probation write
  // (learning_loop_enabled) — this is not a new kill switch, it is the
  // existing one finally having a real caller for this meeting type.
  if (await learningLoopEnabled(env)) {
    const rosterIds = agentsConfig.agents.map((a) => a.id);
    const { items, dropped } = normalizeContextAmendments(decisions.context_amendments, { rosterIds });
    for (const d of dropped) console.warn(`[meeting-engine] context_amendment DROPPED: ${d.reason}`);

    /*
     * ITEM A's gate (2026-08-27). Placed HERE, after normalization and before
     * proposeChange(), for two reasons:
     *
     *   1. The record has to say what would have been written, not merely that
     *      something was. A refusal that reports a count is unauditable; the
     *      normalised item carries the target agent, the aspect and the exact
     *      text, which is what makes a later "was this one right after all?"
     *      answerable.
     *   2. It is scoped to THE MEETING PATH ONLY. proposeChange() has a second
     *      caller — agent-runner.js's supervised `learning_loop_active_context_write`
     *      trigger, which the owner drives by hand with a real conclusion in it.
     *      Gating inside probation.js would have taken that down too, and the
     *      thing being distrusted this session is a small model's unattended
     *      judgement, not the owner's.
     *
     * Everything else applyMeetingEffects() does is untouched — mood,
     * irritation, state_changes, config_overrides, suggestion decisions and
     * the action_items -> board write all still run. Only the write into a
     * character file stops.
     */
    if (!(await meetingContextAmendmentsEnabled(env))) {
      if (items.length) {
        /*
         * Recorded, not discarded — the same convention `refused_action_items`
         * follows above. An effect that simply vanishes is the same defect as
         * an effect applied on no evidence, pointing the other way: the office
         * would show a meeting that reached conclusions and a set of character
         * files that never received them, with nothing anywhere saying why.
         */
        decisions.refused_context_amendments = {
          reason: `${MEETING_AMENDMENTS_FLAG} is off — a meeting may not amend a character file`,
          refused_amendments: items.map((it) => ({
            agent_id: it.agentId,
            aspect: it.aspect,
            content: it.content,
            proposed_by: it.proposedBy,
          })),
        };
        console.warn(`[meeting-engine] ${items.length} context amendment(s) REFUSED (${MEETING_AMENDMENTS_FLAG} off): `
          + items.map((it) => `agent ${it.agentId}/${it.aspect}`).join(', ')
          + '. Recorded on the meeting record, not applied.');
      }
    } else {
      for (const item of items) {
        const result = await proposeChange(env, {
          actorId: item.proposedBy,
          targetAgentId: item.agentId,
          aspect: item.aspect,
          content: item.content,
        }).catch((err) => ({ proposed: false, reason: `threw: ${err.message}` }));
        if (!result.proposed) {
          console.warn(`[meeting-engine] context_amendment for agent ${item.agentId} (${item.aspect}) NOT entered into probation: ${result.reason}`);
        }
      }
    }
  }

  // PIP session: record the outcome in `promotions` (track='pip').
  if (meetingType === 'pip_session' && env.DB) {
    const targetId = attendeeSnapshots.find((s) => s.config?.tier !== 'admin')?.id;
    if (targetId) {
      await env.DB.prepare(
        `INSERT INTO promotions (id, agent_id, track, status, details, created_at)
         VALUES (?, ?, 'pip', 'recorded', ?, CURRENT_TIMESTAMP)`
      ).bind(crypto.randomUUID(), targetId, decisions.summary || '').run().catch(() => {});
    }
  }
}

/* ───────────────────────────── Persistence ────────────────────────────── */

/**
 * ══════════════════════════════════════════════════════════════════════════
 * WHO COMPOSED THIS MEETING — RECORDED UNCONDITIONALLY (SESSION 13, ITEM B)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This row carried NO provider at all until 2026-08-23. The one place the
 * meeting engine ever wrote `composed_by` was inside
 * `decisions.fabricated_participation`, which is only built **when the
 * attendee gate fires** — so the office knew which model composed a meeting
 * exactly when a model had hallucinated an attendee, and never otherwise.
 * Every clean meeting was silent about its own author.
 *
 * That is why a prior session could only find eleven rows naming a provider
 * and all eleven said `cloudflare-fallback`: those were not eleven meetings
 * that fell back, they were **the eleven meetings that tripped an unrelated
 * gate.** A sample selected by a defect is not a sample.
 *
 * Three columns, added by ALTER TABLE (see database/schema.sql's migration
 * note — `CREATE TABLE IF NOT EXISTS` will not retrofit them):
 *
 *   `composed_by`    the provider that ACTUALLY served the call, after any
 *                    degradation — never the one that was asked for. Same
 *                    rule improvement-loop.js's `embodiment_model` states.
 *   `finish_reason`  provider-reported, or the `not_reported` sentinel for a
 *                    provider that has no such concept (Cloudflare Workers
 *                    AI). Never absent — an absent field reads as normal.
 *   `output_tokens`  provider-reported output length.
 *
 * INSTRUMENTATION ONLY. Nothing here changes what a meeting is asked, which
 * model answers, what limits it runs under, or what the office does with the
 * result. The meeting engine's behaviour is deliberately untouched this
 * session; this only makes it observable.
 *
 * The write is still `.catch(() => {})`, unchanged: a lost measurement must
 * never cost a meeting, the same rule repo-write.js states for its own
 * recording call.
 */
async function persistMeeting(env, record) {
  if (!env.DB) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO meetings (id, type, attendees, transcript, decisions, created_at, composed_by, finish_reason, output_tokens)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`
  ).bind(
    id, record.meetingType, JSON.stringify(record.attendees), record.transcript, JSON.stringify(record.decisions),
    record.composedBy ?? null,
    record.finishReason ?? null,
    typeof record.outputTokens === 'number' ? record.outputTokens : null,
  ).run().catch(() => {});
  return id;
}

/* ──────────────────────────────── Report ──────────────────────────────── */

function renderMeetingReport(meetingType, attendeeSnapshots, transcript, decisions, opts) {
  const meta = MEETING_TYPES[meetingType];
  const date = new Date().toISOString();
  const attendeeList = attendeeSnapshots.map((s) => `- Agent ${s.id} — ${s.config?.name} (${s.config?.role})`).join('\n');

  const moodTable = (decisions.mood_effects || [])
    .map((e) => `| Agent ${e.agent_id} | ${e.delta >= 0 ? '+' : ''}${e.delta} | ${e.reason} |`)
    .join('\n');

  // Rendered from the 2026-08-07 object schema. The old renderer was
  // `- [ ] ${a}` over bare strings, and the checkbox was the convincing part:
  // the report looked like a working system while nothing consumed the array.
  const rawItems = decisions.action_items || [];
  const actionItems = rawItems.length
    ? rawItems.map((a) => {
        if (typeof a === 'string') return `- [ ] WARNING ${a} _(old bare-string schema — no owner, artifact or deadline; the board pipeline DROPS this rather than repairing it)_`;
        const undecided = a?.decided === true ? '' : ' **[NOT DECIDED — reaches the board as NOT-READY]**';
        return `- [ ] **Agent ${a?.agent_id ?? '?'}** — ${a?.task ?? '(no task)'}${undecided}\n  - delivered: ${a?.delivered ?? '_(missing — will be dropped)_'}\n  - due: ${a?.due_days ?? '?'} office-days`;
      }).join('\n')
    : '_None._';

  const overridesList = (decisions.config_overrides || [])
    .map((o) => `- Agent ${o.agent_id}: ${JSON.stringify(o.overrides)} — ${o.reason}`)
    .join('\n') || '_None._';

  // The artifact carries its own warning. A meeting whose transcript invented
  // speakers must not be readable as a clean record — the 2026-08-11 standups
  // sat in the same directory as the true ones with nothing to tell them
  // apart, which is what let a hallucinated line become board task OB-067.
  const fab = decisions.fabricated_participation;
  const fabricationBanner = fab?.agent_ids?.length
    ? `> ⚠️ **FABRICATED PARTICIPATION — this transcript is not a reliable record of who spoke.**
> The **Attendees** list below is authoritative. The transcript body contains
> speaking lines attributed to agent(s) **${fab.agent_ids.join(', ')}**, who did not
> attend. ${fab.refused_action_items?.length
      ? `${fab.refused_action_items.length} action item(s) assigned to them were **refused** and are recorded below rather than acted on.`
      : 'No action items were assigned to them.'}${fab.refused_effects?.length
      ? ` ${fab.refused_effects.length} mood/state/config/context effect(s) for them were **refused** and are recorded below rather than applied.`
      : ''}
> Composed by \`${fab.composed_by || 'unknown provider'}\`. Detected automatically at composition time.

`
    : '';
  const refusedList = fab?.refused_action_items?.length
    ? `\n## Refused Action Items (fabricated participation)\n\n${fab.refused_action_items
      .map((it) => `- Agent ${it?.agent_id}: ${it?.task || it?.description || JSON.stringify(it)} — **refused**, this agent did not attend`)
      .join('\n')}\n`
    : '';

  // The refusals that used to be applications. Rendered beside the action-item
  // refusals because they are the same fact about the same meeting, and a
  // reader shown only half a correction reads it as the whole of one.
  const refusedEffectsList = fab?.refused_effects?.length
    ? `\n## Refused Effects (fabricated participation)\n\n${fab.refused_effects
      .map((r) => `- \`${r?.field}\` for agent(s) ${(r?.refused_for || []).join(', ')}: ${JSON.stringify(r?.entry)} — **refused**, not applied`)
      .join('\n')}\n`
    : '';

  /*
   * ITEM A (2026-08-27). Rendered beside the two refusal sections above and in
   * the same words, because it is the same kind of fact: something this
   * meeting decided, which the office declined to act on. The reader of a
   * meeting report is the owner, and the question this section exists to
   * answer for him is "what did this meeting try to change about my agents,
   * and why didn't it?"
   */
  const refusedAmendments = decisions.refused_context_amendments;
  const refusedAmendmentsList = refusedAmendments?.refused_amendments?.length
    ? `\n## Refused Character-File Amendments\n\n_${refusedAmendments.reason}_\n\n${refusedAmendments.refused_amendments
      .map((a) => `- Agent ${a.agent_id} — \`${a.aspect}\` (proposed by agent ${a.proposed_by}): ${a.content} — **refused**, not written to the character file`)
      .join('\n')}\n`
    : '';

  return `# ${meta.label} — ${date}

${fabricationBanner}${opts?.trigger ? `**Trigger:** ${opts.trigger}\n` : ''}
## Attendees

${attendeeList}

## Transcript

${transcript}
${refusedList}${refusedEffectsList}${refusedAmendmentsList}

## Summary

${decisions.summary || '_No summary provided._'}

## Mood Effects

| Agent | Delta | Reason |
|-------|-------|--------|
${moodTable || '| - | - | _None_ |'}

## Action Items

${actionItems}

## Durable Config Overrides

${overridesList}
`;
}

/**
 * Commits a meeting report markdown file to reports/meetings/.
 *
 * ── REWRITTEN 2026-08-07: THIS FUNCTION USED TO BYPASS THE GUARD ─────────
 *
 * It built its own request — `Authorization: Bearer ${env.GITHUB_TOKEN}` —
 * against hardcoded REPO_OWNER/REPO_NAME constants, having never called
 * resolveRepoWrite(). CLAUDE.md and plan 0.3 both stated resolveRepoWrite()
 * was "the single entry point for every repo write". For this path that was
 * false, and had been for every meeting report ever filed.
 *
 * NOTHING WAS EVER MIS-WRITTEN, and that is the interesting part. GITHUB_TOKEN
 * is the correct credential for the public repo, so the outcome was right
 * every time — right because two hardcoded constants happened to agree, not
 * because any rule compared them. This project's own recorded corollary: TWO
 * MECHANISMS AGREEING BY ACCIDENT IS NOT A GUARD. A scenario that passes for
 * the wrong reason keeps passing until the coincidence breaks, and the break
 * was already scheduled — writeActionItemsToBoard() above writes to
 * BACK-OFFICE from this same file, and would have been the first caller to
 * need a different token than the one hardcoded here.
 *
 * Found by the 2026-08-07 context survey while answering a different
 * question, which is also how the 2026-08-06 fail-open hole was found.
 */
async function commitMeetingReport(env, meetingType, markdown) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Moved to back-office 2026-08-11 (plan 0.4, stage 1 of 5): raw meeting
  // minutes are internal plumbing, not visitor content — DOC-POLICY.md's
  // "campus/shared/meetings/<date>-<type>.md" convention, with the full
  // stamp appended (not just the date) so same-day, same-type meetings
  // (e.g. two ad hoc audits) never collide.
  const dateStr = stamp.slice(0, 10);
  const path = `campus/shared/meetings/${dateStr}-${meetingType}-${stamp}.md`;
  return commitFileToRepo(
    env,
    BACKOFFICE_REPO_NAME,
    path,
    markdown,
    `chore(office): ${meetingType} meeting report ${stamp} [skip ci]`
  );
}

/* ─────────────────────────────── Orchestrator ──────────────────────────── */

/**
 * PROVIDER RULE — READ BEFORE "FIXING" THE ARCHITECT'S ROUTING.
 *
 * The Architect (Agent 10) participates substantively in weekly and monthly
 * meetings as of 2026-08-07. HIS MEETING PARTICIPATION MUST NEVER USE
 * ANTHROPIC.
 *
 * That budget is reserved for the Architect's own owner-directed work and for
 * genuine data-center Q&A, inside a $4.50/mo soft-stop and a $5 hard ceiling.
 * Office meeting participation is exactly the office flavour / persona chatter
 * the budget rule forbids — and the rule has no exception for "but it is the
 * Architect", because his is the one persona whose chatter would be most
 * tempting to route there.
 *
 * Enforced STRUCTURALLY rather than by a check: this module calls Gemini or
 * Groq (Cloudflare Workers AI fallback) and imports no Anthropic client.
 * There is no Anthropic path in this file to disable. A future session must
 * not "fix the inconsistency" by giving him one.
 *
 * Note what his exclusion was actually about, because it is easy to conflate:
 * he was NEVER excluded from MEETINGS — relationships.json already seated him
 * at monthly, quarterly, semi-yearly and yearly. He is excluded from the
 * EMBODIMENT SHUFFLE (assignEmbodiment() in task-router.js skips him by id AND
 * by name), which is a different mechanism, and it STAYS AS IT IS. Adding him
 * to `weekly` on 2026-08-07 changed an attendee list and touched nothing about
 * embodiment.
 */

/**
 * Runs a full meeting cycle and returns a summary.
 * @param {keyof MEETING_TYPES} meetingType
 * @param {object} env - Worker env (DB, AGENT_STATE, GEMINI_API_KEY, GITHUB_TOKEN, SIM_CONFIG)
 * @param {object} [opts] - meeting-type-specific options (see MEETING_TYPES[type].requiresOpts)
 */
/*
 * ══════════════════════════════════════════════════════════════════════════
 * ITEM B — WHY EVERY MEETING FOR MONTHS WAS COMPOSED BY AN 8B MODEL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE 2026-08-25 MODEL FIX DID REACH THIS CALL SITE. That was the suspicion,
 * it is wrong, and the wrong answer is worth writing down because it is the
 * one anyone will reach for again. `meeting-engine.js` imports `callGroq` from
 * `groq-client.js` like every other Groq consumer, and `callGroq` sends
 * `GROQ_MODEL` — the single exported constant. There is no second model
 * identifier in this file and there never was.
 *
 * WHAT ACTUALLY HAPPENS, captured live from `wrangler tail` on 2026-08-27
 * against a real `daily_standup`:
 *
 *   [agent-meeting-daily_standup] Groq API error (413): Request too large for
 *   model `openai/gpt-oss-20b` in organization `org_...` service tier
 *   `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17836
 *
 * A meeting prompt is 17,836 tokens — personas for the attendees, the office
 * context block, the board, the Workflow's metrics, the output census. Groq's
 * free tier admits 8,000 tokens per minute, which is also its effective
 * per-request ceiling. The model was never the problem; the request has been
 * more than twice too big for the tier for as long as the office context block
 * has existed.
 *
 * AND IT IS A 413, NOT A 429. `callGroq`'s `!res.ok` branch returns null on
 * both, every caller degrades to Cloudflare Workers AI, and Cloudflare answers
 * perfectly well — so nothing was ever broken enough to look at. Same failure
 * shape as the two retired Groq models this file's sibling header documents,
 * arriving by a third route: a silent, successful degradation. The evidence
 * was in the logged response body the whole time and nothing read it.
 *
 * ── SO THE FIX IS A LANE, NOT A MODEL ID ────────────────────────────────
 *
 * A meeting is routed like everything else the office does now, through
 * `config/model-routing.json`. `long_document` is the lane whose stated job is
 * "anything past what a single judgment call should carry": Cerebras primary,
 * per-request input MEASURED at 131,000 tokens, Mistral behind it. 17,836
 * tokens sits comfortably inside that. A future model change reaches this call
 * site because the lane is data — which is what B2 was actually asking for.
 *
 * THE `conversation` LANE WAS NOT USED, AND THE OWNER SHOULD KNOW WHY. That
 * lane names meetings and standups in its own description and is the designed
 * home for this. It is `controlled_random` across five providers, and three of
 * them — groq at 8,000 TPM, cloudflare-ai, and gemini on a shared free quota —
 * cannot reliably accept a 17,836-token prompt. Its backup is null, so a call
 * landing on one of those does not degrade, it fails. Pointing meetings there
 * today would replace a silent degradation with an intermittent one. Choosing
 * between the two lanes is a design decision about who composes the office's
 * display surface, and it is the owner's, not this session's.
 *
 * ── THE CLOUDFLARE FALLBACK IS NOT REMOVED (B4) ─────────────────────────
 *
 * It is what kept meetings running at all, and it stays exactly where it was:
 * routing off, or a routed call that comes back empty, still walks the
 * original Groq → Cloudflare chain untouched. What changes is that it is now
 * the third thing tried rather than, in practice, the only one.
 */
const MEETING_LANE = 'long_document';

/*
 * ITEM C4 — THE TWO BUDGETS, FROM THE MEASUREMENT AND NOT FROM A ROUND NUMBER.
 *
 * What was measured across the seven meetings recorded since the
 * instrumentation landed (D1 `meetings`, 2026-08-23..26): `output_tokens` of
 * 1024, 1024, 993, 655 and 490 against a shared ceiling of 1024 — three of
 * them ON the ceiling. Transcript lengths 1,445-4,129 characters; decisions
 * objects 165-1,128 characters.
 *
 * Both figures are LOWER BOUNDS, which is exactly why they cannot be used
 * directly: those transcripts were cut off BY the shared ceiling, so the
 * length a real meeting wants has never once been observed here.
 *
 * TRANSCRIPT: 3,000. The agenda asks for 6-20 turns; twenty turns of a genuine
 * sentence or two is 1,300-1,800 tokens, and the longest transcript ever
 * recorded (4,129 chars, roughly 1,030 tokens) was still being truncated when
 * it stopped. 3,000 is a little under three times that truncated observation,
 * and C5 is explicit that this must not be capped below what a real
 * conversation needs — the owner reads these.
 *
 * DECISIONS: 1,500. The largest decisions object on record is 1,128
 * characters, about 280 tokens — but it was written second, out of whatever
 * the dialogue left, so it measures the defect rather than the need. Eight
 * arrays with several entries each is plausibly 700-900 tokens. 1,500 also has
 * to clear the reasoning overhead Cerebras' `gpt-oss-120b` charges against
 * `max_tokens` — the property `cerebras-client.js` `MIN_OUTPUT_TOKENS` exists
 * for, and which returns an EMPTY answer rather than a short one when the
 * budget is too tight.
 *
 * Both are stamped onto the meeting record beside the `finish_reason` they
 * belong with, so the next session revises them from evidence.
 */
const TRANSCRIPT_MAX_TOKENS = 3000;
const DECISIONS_MAX_TOKENS = 1500;

/**
 * ONE call, however it ends up being served. Both of Item C's calls go through
 * here so the transcript and the decisions cannot quietly be composed under
 * different rules.
 *
 * Order: the routed lane, then the pre-existing direct chain, unchanged.
 * Returns the same envelope `callGroq`/`callGemini` return — `{ text, source,
 * finishReason, outputTokens }` — where `source` is the provider that ACTUALLY
 * answered, never the one that was asked for. The same rule the `composed_by`
 * column states.
 */
async function composeMeetingCall(env, meetingType, { prompt, systemPrompt, maxTokens, label }) {
  const simConfig = env.SIM_CONFIG?.GEMINI || {};
  const agentId = `meeting-${meetingType}-${label}`;

  // Gemini keeps the long-range meetings it has always had — those are report
  // synthesis and are not what Item B measured. Untouched, including the
  // Cloudflare fallback inside callGemini() itself.
  if (GEMINI_MEETING_TYPES.has(meetingType)) {
    const r = await callGemini({
      apiKey: env.GEMINI_API_KEY,
      model: simConfig.model || 'gemini-3.1-flash-lite', // gemini-3.5-flash is deprecated — never reintroduce it, see CLAUDE.md
      endpoint: simConfig.api_endpoint || 'https://generativelanguage.googleapis.com/v1beta/models',
      temperature: simConfig.temperature ?? 0.9,
      maxTokens: Math.max(simConfig.max_tokens ?? 1024, maxTokens),
      prompt,
      systemPrompt,
      ai: env.AI,
    });
    if (r?.source === 'cloudflare-fallback') {
      console.warn(`[meeting-engine] Gemini quota exhausted (${meetingType}/${label}) — used cloudflare-fallback (@cf/meta/llama-3.1-8b-instruct-fp8)`);
    }
    return r;
  }

  if (await routingEnabled(env)) {
    const routed = await routeTaskTypeCall(env, MEETING_LANE, {
      prompt, systemPrompt, maxTokens,
      geminiModel: simConfig.model,
      geminiEndpoint: simConfig.api_endpoint,
      agentId,
    });
    if (routed?.ok && routed.result?.text) {
      return {
        text: routed.result.text,
        // The provider that answered, after any degradation inside the lane —
        // routed.provider, never the lane's planned primary.
        source: routed.provider || routed.result.source || null,
        finishReason: routed.result.finishReason ?? null,
        outputTokens: typeof routed.result.outputTokens === 'number'
          ? routed.result.outputTokens
          : (routed.result.usage?.outputTokens ?? null),
      };
    }
    console.warn(`[meeting-engine] routed lane "${MEETING_LANE}" did not answer (${meetingType}/${label}): `
      + `${routed?.reason || 'no text returned'}. Falling through to the direct Groq -> Cloudflare chain.`);
  }

  // ── THE ORIGINAL CHAIN, UNCHANGED (B4) ────────────────────────────────
  const groqResult = await callGroq({
    apiKey: env.GROQ_API_KEY,
    prompt,
    systemPrompt,
    temperature: 0.9,
    maxTokens,
    agentId,
  });
  if (groqResult) return groqResult;

  console.warn(`[meeting-engine] Groq unavailable (${meetingType}/${label}) — used cloudflare-fallback (@cf/meta/llama-3.1-8b-instruct-fp8)`);
  return callCloudflareFallback({
    ai: env.AI,
    prompt,
    systemPrompt,
    temperature: 0.9,
    maxTokens,
  });
}

export async function runMeeting(meetingType, env, opts = {}) {
  const meta = MEETING_TYPES[meetingType];
  if (!meta) throw new Error(`Unknown meeting type: ${meetingType}`);

  for (const required of meta.requiresOpts) {
    if (opts[required] === undefined) throw new Error(`Meeting type "${meetingType}" requires opts.${required}`);
  }

  const attendeeIds = resolveAttendeeIds(meetingType, opts);
  const attendeeSnapshots = await Promise.all(attendeeIds.map((id) => loadAgentSnapshot(id, env)));

  const data = await gatherMeetingData(meetingType, env, attendeeIds, opts);

  // The office's own work. `allowFetch: true` — a meeting runs once per
  // cycle, so it is one of the few callers permitted to spend the GitHub
  // round-trips that refresh the cache. Null / {text:null} with the switch
  // off, and buildMeetingPrompt() then omits the block entirely.
  const snapshot = await getOfficeSnapshot(env, { allowFetch: true });
  const officeContext = await getOfficeContext(env, {
    shape: 'meeting', snapshot, projects: officeProjects.projects,
    // Names, so a review assignment reads "Agent 6 — The QA" rather than
    // "Agent 6". A meeting that assigns work to a number assigns it to nobody.
    agentNames: Object.fromEntries(agentsConfig.agents.map((a) => [a.id, a.name])),
  });

  // The Workflow's four measures, computed from the SAME snapshot the context
  // block came from — so the numbers in the agenda and the tasks in the
  // context cannot disagree with each other.
  if (snapshot?.board && WORKFLOW_METRICS_MEETINGS.has(meetingType)) {
    data.workflowMetrics = renderWorkflowMetrics(computeWorkflowMetrics({
      boardTasks: snapshot.board.tasks,
      activityByAgent: await lastActivityByAgent(env),
      rosterIds: agentsConfig.agents.map((a) => a.id),
    }));

    /*
     * THE OUTPUT CENSUS, added 2026-08-10 — rendered BESIDE the four measures,
     * not folded into them.
     *
     * It is a fifth block rather than a fifth measure because it answers a
     * different question and would be misread as a restatement of measure 2. That
     * measure reads ACTIVITY (every Q&A ask counts); this reads OUTPUT, by kind.
     * The Designer had a warm activity row for two months and produced nothing her
     * role is for, and measure 2 could not have said so.
     *
     * `roleKinds` comes from config/capability-manifest.json's `output_kinds` —
     * the same file the capability audit reads, deliberately, so "what this role
     * is for" has ONE definition and the census and the audit cannot disagree
     * about it.
     */
    data.outputCensus = renderOutputCensus(computeOutputCensus({
      rosterIds: agentsConfig.agents.map((a) => a.id),
      outputByAgent: await outputByAgent(env),
      roleKinds: Object.fromEntries(
        Object.entries(capabilityManifest.agents || {}).map(([id, a]) => [Number(id), a.output_kinds || []])
      ),
      windowDays: 7,
    }));
  }

  // Unattended Architect sessions filed SINCE THIS MEETING TYPE LAST RAN.
  //
  // The window is "since the last meeting of this type", not "since midnight" —
  // the run is not on a schedule, so a fixed lookback would either miss a run
  // (window too short) or re-table one already discussed (window too long). A
  // meeting type that has never run gets every session ever filed, which is
  // correct for a first run and self-limiting thereafter.
  //
  // Fails to NO ITEM, never to a claim: an unreadable query yields an empty
  // array, and buildMeetingPrompt() then omits the agenda item entirely. It does
  // NOT say "no runs occurred" — nothing here can establish that.
  let architectRuns = [];
  if (env.DB && OFFICE_CONTEXT_MEETINGS.has(meetingType)) {
    const lastSame = await env.DB.prepare(
      'SELECT MAX(created_at) AS last_at FROM meetings WHERE type = ?'
    ).bind(meetingType).first().catch(() => null);
    const since = lastSame?.last_at || '1970-01-01';
    const rows = await env.DB.prepare(
      `SELECT title, content, created_at FROM reports
        WHERE type = 'architect_session' AND created_at > ?
        ORDER BY created_at ASC LIMIT 5`
    ).bind(since).all().catch(() => null);
    architectRuns = rows?.results || [];
  }

  const { systemPrompt, prompt } = buildMeetingPrompt(meetingType, attendeeSnapshots, data, { ...opts, officeContext, architectRuns });

  const modelResult = await composeMeetingCall(env, meetingType, {
    prompt, systemPrompt, maxTokens: TRANSCRIPT_MAX_TOKENS, label: 'transcript',
  });

  /*
   * ITEM C, the second call. The transcript is parsed FIRST, with the same
   * parser, because a transcript call is now expected to contain no
   * ---DECISIONS--- marker: parseMeetingResponse() returns the whole text as
   * the transcript and empty decisions, which is exactly right here. Running
   * it anyway rather than assigning `modelResult.text` straight across means a
   * model that ignores the instruction and appends a JSON block still gets it
   * stripped out of the transcript instead of printed into the report.
   */
  const { transcript } = parseMeetingResponse(modelResult.text);

  /*
   * A DECISIONS CALL IS NOT MADE ON A TRANSCRIPT THAT IS NOT THERE. An empty
   * or failed first call would otherwise be handed to a second model with
   * "record what this meeting decided" — a prompt with nothing in it, which is
   * the shape that produces invention. Empty decisions here are the honest
   * answer and the meeting still persists, with its own reason recorded.
   */
  let decisionsResult = null;
  let decisions;
  if (!transcript || !transcript.trim()) {
    console.warn(`[meeting-engine] ${meetingType}: the transcript call returned nothing `
      + `(composed_by ${modelResult?.source || 'unknown'}, finish_reason ${modelResult?.finishReason || 'unknown'}). `
      + 'No decisions call was made — there is nothing to read decisions off.');
    decisions = emptyDecisions();
    decisions.no_transcript = {
      reason: 'the transcript call returned no text; the decisions call was not made',
      composed_by: modelResult?.source || null,
      finish_reason: modelResult?.finishReason || null,
    };
  } else {
    const dPrompt = buildDecisionsPrompt(meetingType, attendeeSnapshots, transcript);
    decisionsResult = await composeMeetingCall(env, meetingType, {
      prompt: dPrompt.prompt, systemPrompt: dPrompt.systemPrompt,
      maxTokens: DECISIONS_MAX_TOKENS, label: 'decisions',
    });
    ({ decisions } = parseMeetingResponse(decisionsResult.text));
    /*
     * ITEM C. There are two calls now and the `meetings` row has three columns
     * for one of them, so the decisions call's own numbers ride on the
     * decisions object — beside the arrays they explain. "Were the decisions
     * truncated?" is then answerable from the record rather than from a log
     * line that expires in three days.
     */
    decisions.composed = {
      transcript: {
        composed_by: modelResult?.source ?? null,
        finish_reason: modelResult?.finishReason ?? null,
        output_tokens: typeof modelResult?.outputTokens === 'number' ? modelResult.outputTokens : null,
        max_tokens: TRANSCRIPT_MAX_TOKENS,
      },
      decisions: {
        composed_by: decisionsResult?.source ?? null,
        finish_reason: decisionsResult?.finishReason ?? null,
        output_tokens: typeof decisionsResult?.outputTokens === 'number' ? decisionsResult.outputTokens : null,
        max_tokens: DECISIONS_MAX_TOKENS,
      },
    };
    if (decisionsResult?.finishReason === 'length') {
      console.warn(`[meeting-engine] ${meetingType}: the DECISIONS call stopped at its ceiling `
        + `(${DECISIONS_MAX_TOKENS}) — the object may be truncated. Item C makes this visible rather `
        + 'than impossible; a ceiling reached is a budget to revisit, not a defect to hide.');
    }
  }

  // The attendee gate (audit 2026-08-15, finding #1). Placed here on purpose:
  // this is the only point where the resolved attendee set and the composed
  // transcript both exist, and it is upstream of EVERY consumer — mood
  // effects, refusals, journals, the D1 row and the rendered report. A check
  // any later would let one of them act on fabricated participation first.
  const gate = enforceAttendeeGate(transcript, decisions, attendeeIds, agentsConfig.agents);
  if (gate.fabricated.length) {
    console.warn(
      `[meeting-engine] FABRICATED PARTICIPATION (${meetingType}): agent(s) ${gate.fabricated.join(', ')} `
      + `have speaking lines but are not attendees (${attendeeIds.join(', ')}). `
      + `${gate.removed.length} action item(s) and ${gate.removedEffects.length} effect(s) refused.`,
    );
    // Refused items are dropped from what the office ACTS on, and carried on
    // the record so the refusal is visible rather than a silent shrink.
    decisions.action_items = gate.kept;
    /*
     * -- THE FIVE QUIET FIELDS (2026-08-24) ------------------------------
     *
     * This loop is the whole of the fix. `action_items` above has been
     * filtered since 2026-08-15; the five fields below were handed to
     * applyMeetingEffects() unfiltered, and it resolves any agent id it is
     * given via `snapshotsById.get(id) || await loadAgentSnapshot(id, env)`
     * -- so an agent who was never in the room was simply loaded from
     * storage and written to. Four applications reached production
     * (2026-08-19, -21, -23 and -24), including a context_amendments
     * proposal against Agent 13's character file off a review they did not
     * attend. The gate caught the loud path and missed the quiet one.
     *
     * Same predicate, same gate call, five more fields. What a meeting
     * COMPOSES is unchanged -- the model may keep inventing attendees; this
     * is the office declining to act on the invention.
     */
    for (const field of GATED_EFFECT_FIELDS) {
      if (gate.keptEffects[field]) decisions[field] = gate.keptEffects[field];
    }
    decisions.fabricated_participation = {
      agent_ids: gate.fabricated,
      refused_action_items: gate.removed,
      refused_effects: gate.removedEffects,
      composed_by: modelResult?.source || null,
    };
  }

  /*
   * ── ITEM B, THE ENFORCING HALF (2026-08-23) ────────────────────────────
   *
   * The prompt above ASKS a meeting with no data to return nothing. This
   * REFUSES the write regardless of what it returned, because the prompt is
   * the half a model can ignore and the write is the half that lands in an
   * agent's character file overnight.
   *
   * Only the conclusion-shaped fields are cleared. The meeting still happened,
   * its transcript is still persisted, and `nothing_to_review` is recorded ON
   * THE MEETING so the record says "there was nothing to review" rather than
   * showing an empty meeting and leaving a reader to guess whether the office
   * was idle or the pipeline was broken.
   */
  if (data?.nothingToReview) {
    const would = {
      context_amendments: (decisions.context_amendments || []).length,
      action_items: (decisions.action_items || []).length,
      state_changes: (decisions.state_changes || []).length,
    };
    decisions.nothing_to_review = {
      reason: 'no interactions, no sampled output and no quality scores in this window',
      conclusions_refused: would,
    };
    decisions.summary = decisions.summary
      || 'Nothing to review: the office recorded no work in this window. No conclusions were drawn.';
    decisions.context_amendments = [];
    decisions.action_items = [];
    decisions.state_changes = [];
    decisions.mood_effects = [];
    decisions.irritation_effects = [];
    if (would.context_amendments || would.action_items || would.state_changes) {
      console.warn(`[meeting-engine] ${meetingType}: NOTHING TO REVIEW, but the meeting still returned `
        + `${would.context_amendments} context amendment(s), ${would.action_items} action item(s) and `
        + `${would.state_changes} state change(s). All refused — they would have been written from no data.`);
    }
  }

  await applyMeetingEffects(meetingType, attendeeSnapshots, decisions, env);

  // B5, at the moment it happened. Before the persist, so a failure to store the
  // meeting row does not also lose the refusals — they are separate records of
  // separate facts and the more fragile one goes first.
  const refusals = await recordMeetingRefusals(meetingType, attendeeSnapshots, decisions, env)
    .catch((err) => { console.warn(`[meeting-engine] refusal recording failed: ${err?.message}`); return { recorded: 0, lost: 0, error: err?.message }; });

  // journal.md capture for meeting attendance — OFFICE-POLICY.md's journal
  // requirement covers every action, not only the case pipeline (see
  // agent-base.js's askAssignedProject for the case-side hook). Meetings
  // have no persistent agent instance here (this module works off plain
  // snapshots/ids, not AgentBase objects), so this writes directly via
  // writeJournalEntry rather than through an agent's buffer — one commit
  // per attendee per meeting is acceptable volume (meetings run a handful
  // of times a day at most, unlike the hundreds of daily cases). Best-effort
  // and never allowed to affect the meeting's own outcome: every failure is
  // swallowed, never thrown.
  for (const snap of attendeeSnapshots) {
    try {
      const nameEsc = String(snap.config?.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lineMatch = new RegExp(`\\*\\*${nameEsc}[^*]*\\*\\*:?\\s*(.+)`, 'i').exec(transcript || '');
      const refusal = Array.isArray(decisions?.refusals) ? decisions.refusals.find((r) => r?.agent_id === snap.id) : null;
      await writeJournalEntry(env, {
        actorId: snap.id,
        agentId: snap.id,
        content:
          `**${meetingType} meeting**\n` +
          `- Planned: attend the ${meetingType} meeting\n` +
          `- Happened: ${lineMatch ? `"${lineMatch[1].trim().slice(0, 300)}"` : 'no individually attributable line found in the transcript'}\n` +
          `- Capabilities/lanes used: ${modelResult?.source || (GEMINI_MEETING_TYPES.has(meetingType) ? 'gemini' : 'groq')} composed the meeting\n` +
          `- Problems/unclear: ${refusal ? `declined "${refusal.declined}" — ${refusal.character_line || 'no character line given'}` : 'none recorded for this agent'}`,
      });
    } catch (err) {
      console.warn(`[meeting-engine] journal write failed for agent ${snap.id}: ${err?.message}`);
    }
  }

  const dbId = await persistMeeting(env, {
    meetingType, attendees: attendeeIds, transcript, decisions,
    // Read off the SAME `modelResult` the transcript was parsed from, so the
    // row cannot name a provider other than the one whose words it stores.
    composedBy: modelResult?.source ?? null,
    finishReason: modelResult?.finishReason ?? null,
    outputTokens: typeof modelResult?.outputTokens === 'number' ? modelResult.outputTokens : null,
    /*
     * ITEM C. There are two calls now and three columns, so the row can only
     * carry one call's numbers. It carries the TRANSCRIPT call's, unchanged —
     * that is what `transcript` in the same row is the text of, and a row whose
     * `output_tokens` described a different call than its own `transcript`
     * would be worse than one that described neither. The decisions call's
     * numbers go on the decisions object itself, where the arrays they explain
     * already live, so "were the decisions truncated?" stays answerable from
     * the record rather than from a log line.
     */
  });

  const markdown = renderMeetingReport(meetingType, attendeeSnapshots, transcript, decisions, opts);
  const commit = await commitMeetingReport(env, meetingType, markdown);

  return {
    meetingType,
    attendees: attendeeIds,
    transcript,
    decisions,
    dbId,
    // Surfaced, not swallowed. `lost` is the number that matters: a refusal
    // that happened and could not be recorded is unrecoverable per B5, and a
    // caller that cannot see the count cannot report it.
    refusals,
    report: { markdown, ...commit },
  };
}
