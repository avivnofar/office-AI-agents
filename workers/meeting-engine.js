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

import agentsConfig from '../config/agents-config.json';
// The capability manifest supplies each role's `output_kinds` to the output
// census. Read from the SAME file workers/capability-audit.js reads, deliberately:
// "what this role is for" gets one definition, so the census and the audit cannot
// disagree about it.
import capabilityManifest from '../config/capability-manifest.json';
import relationships from '../config/relationships.json';
import officeProjects from '../config/office-projects.json';
import { callGemini, callCloudflareFallback } from './gemini-client.js';
import { callGroq } from './groq-client.js';
import { commitFileToRepo, REPO_NAME, BACKOFFICE_REPO_NAME } from './repo-write.js';
import { getOfficeContext, getOfficeSnapshot } from './office-context.js';
import {
  addOfficeDays, normalizeActionItems, renderBoardTask,
  computeWorkflowMetrics, renderWorkflowMetrics,
  computeOutputCensus, renderOutputCensus,
} from './meeting-decisions.js';
// B5 (2026-08-10) — refusal recording, office-wide. The meeting is where a QA
// rejects, an admin objects and the Workflow bounces something, and it is the
// one moment those are visible to code. See recordMeetingRefusals().
import { recordRefusalEvent } from './improvement-loop.js';

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

function resolveAttendeeIds(meetingType, opts) {
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

  return { window: 'today', todaysWork, samples, quality, workflowMetrics: null };
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
  closing_qa_review: (data) => `Run the CLOSING QA REVIEW — backward-looking, the end of the day, on TODAY'S OUTPUT ONLY. This is not a standup and not a planning meeting: do not discuss tomorrow.\nWhat was produced today:\n${JSON.stringify(data.todaysWork)}\nSampled output:\n${JSON.stringify(data.samples)}\nQuality scores recorded today:\n${JSON.stringify(data.quality)}\nThe QA (6) reviews WORK QUALITY; the Team Lead (7) reviews the WORKER MODEL — persona consistency, behavioural drift, context gaps. Produce conclusions specific enough to be written into an agent's character file TONIGHT. The whole point of running this at the end of the day rather than at tomorrow's standup is that conclusions reach the files before the next day opens, so a vague conclusion defeats the entire arrangement.`,
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

const DECISIONS_SCHEMA_HINT = `
Respond in two parts:
1. A realistic dialogue transcript between the attendees, staying strictly in character (use their personality, mood, and behavioral rules). Use "Name: line" format, one line per turn, 6-20 turns.
2. On a new line, the exact marker ---DECISIONS--- followed by a single JSON object (no markdown fences) with this shape:
{
  "summary": "1-3 sentence summary of outcomes",
  "mood_effects": [{ "agent_id": <int>, "delta": <int -20..20>, "reason": "<short reason>" }],
  "irritation_effects": [{ "agent_id": <int>, "delta": <int -2..2>, "reason": "<short reason>" }],
  "state_changes": [{ "agent_id": <int>, "field": "isHappy|isAngry|isPanic|panicLevel|isComplacent", "value": <bool|number>, "reason": "<short reason>" }],
  "action_items": [{ "agent_id": <int>, "task": "<one imperative sentence>", "delivered": "<the ARTIFACT that will exist>", "due_days": <int office-days>, "decided": <bool>, "open_question": "<if decided is false, what was left unsettled>" }],
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
- "due_days" counts OFFICE-DAYS from dispatch (a day the office is open; Saturday is not one).`;

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
    DECISIONS_SCHEMA_HINT,
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

/* ──────────────────────────── Response parsing ─────────────────────────── */

function parseMeetingResponse(text) {
  const marker = '---DECISIONS---';
  const endMarker = '---END---';
  const idx = text.indexOf(marker);

  if (idx === -1) {
    return { transcript: text.trim(), decisions: emptyDecisions() };
  }

  const transcript = text.slice(0, idx).trim();
  let jsonChunk = text.slice(idx + marker.length);
  const endIdx = jsonChunk.indexOf(endMarker);
  if (endIdx !== -1) jsonChunk = jsonChunk.slice(0, endIdx);

  let decisions;
  try {
    decisions = JSON.parse(jsonChunk.trim());
  } catch {
    decisions = emptyDecisions();
  }

  return { transcript, decisions: { ...emptyDecisions(), ...decisions } };
}

function emptyDecisions() {
  return {
    summary: '',
    mood_effects: [],
    irritation_effects: [],
    state_changes: [],
    action_items: [],
    config_overrides: [],
    suggestion_decisions: [],
  };
}

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
async function writeActionItemsToBoard(env, { meetingType, items, dropped }) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const blocks = items.map((item, i) => renderBoardTask(item, {
    id: `PROPOSED-${stamp}-${String(i + 1).padStart(2, '0')}`,
    meetingType,
    dateStr,
    agentName: getAgentConfig(item.agentId)?.name || null,
  }));

  const droppedBlock = dropped.length
    ? `\n## Dropped by the pipeline — ${dropped.length}\n\n**Not a failure to hide.** Each line is an item the meeting produced that could not become a task, with the reason. A missing owner or a roster gap surfaces HERE rather than as a guessed assignment.\n\n${dropped.map((d) => `- \`${String(JSON.stringify(d.item)).slice(0, 200)}\` — ${d.reason}`).join('\n')}\n`
    : '\n## Dropped by the pipeline — 0\n\n_Every action item this meeting produced passed validation._\n';

  const markdown = `# Proposed board tasks — ${meetingType} meeting, ${dateStr}

**Classification:** private · **Generated by:** \`workers/meeting-engine.js\` action_items pipeline
**Status:** PROPOSED. Not on the board yet.

> The Workflow (Agent 12) accepts or rejects these and allocates real
> \`OB-NNN\` ids. This file never edits \`BOARD.md\` directly — the board has
> one writer by contract, and IDs are never reused.

## Proposed tasks — ${items.length}

${blocks.join('\n') || '_None. The meeting produced no action item that passed validation._'}
${droppedBlock}`;

  const path = `campus/shared/board/inbox/${dateStr}-${meetingType}-${stamp}.md`;
  const result = await commitFileToRepo(
    env,
    BACKOFFICE_REPO_NAME,
    path,
    markdown,
    `chore(office): ${meetingType} meeting action items -> board inbox [skip ci]`
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

async function persistMeeting(env, record) {
  if (!env.DB) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO meetings (id, type, attendees, transcript, decisions, created_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(id, record.meetingType, JSON.stringify(record.attendees), record.transcript, JSON.stringify(record.decisions)).run().catch(() => {});
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

  return `# ${meta.label} — ${date}

${opts?.trigger ? `**Trigger:** ${opts.trigger}\n` : ''}
## Attendees

${attendeeList}

## Transcript

${transcript}

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
  const path = `reports/meetings/${meetingType}-${stamp}.md`;
  return commitFileToRepo(
    env,
    REPO_NAME,
    path,
    markdown,
    `chore(agents): ${meetingType} meeting report ${stamp} [skip ci]`
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

  let modelResult;
  if (GEMINI_MEETING_TYPES.has(meetingType)) {
    const simConfig = env.SIM_CONFIG?.GEMINI || {};
    modelResult = await callGemini({
      apiKey: env.GEMINI_API_KEY,
      model: simConfig.model || 'gemini-3.1-flash-lite', // gemini-3.5-flash is deprecated — never reintroduce it, see CLAUDE.md
      endpoint: simConfig.api_endpoint || 'https://generativelanguage.googleapis.com/v1beta/models',
      temperature: simConfig.temperature ?? 0.9,
      maxTokens: Math.max(simConfig.max_tokens ?? 1024, 2048),
      prompt,
      systemPrompt,
      ai: env.AI,
    });
    if (modelResult.source === 'cloudflare-fallback') {
      console.warn(`[meeting-engine] Gemini quota exhausted (${meetingType}) — used cloudflare-fallback (@cf/meta/llama-3.1-8b-instruct-fp8)`);
    }
  } else {
    const groqResult = await callGroq({
      apiKey: env.GROQ_API_KEY,
      prompt,
      systemPrompt,
      temperature: 0.9,
      maxTokens: 1024,
      agentId: `meeting-${meetingType}`,
    });
    if (groqResult) {
      modelResult = groqResult;
    } else {
      console.warn(`[meeting-engine] Groq unavailable (${meetingType}) — used cloudflare-fallback (@cf/meta/llama-3.1-8b-instruct-fp8)`);
      modelResult = await callCloudflareFallback({
        ai: env.AI,
        prompt,
        systemPrompt,
        temperature: 0.9,
        maxTokens: 1024,
      });
    }
  }

  const responseText = modelResult.text;

  const { transcript, decisions } = parseMeetingResponse(responseText);

  await applyMeetingEffects(meetingType, attendeeSnapshots, decisions, env);

  // B5, at the moment it happened. Before the persist, so a failure to store the
  // meeting row does not also lose the refusals — they are separate records of
  // separate facts and the more fragile one goes first.
  const refusals = await recordMeetingRefusals(meetingType, attendeeSnapshots, decisions, env)
    .catch((err) => { console.warn(`[meeting-engine] refusal recording failed: ${err?.message}`); return { recorded: 0, lost: 0, error: err?.message }; });

  const dbId = await persistMeeting(env, { meetingType, attendees: attendeeIds, transcript, decisions });

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
