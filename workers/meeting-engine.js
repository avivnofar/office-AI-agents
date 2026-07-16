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
import relationships from '../config/relationships.json';
import { callGemini, callCloudflareFallback } from './gemini-client.js';
import { callGroq } from './groq-client.js';

/** Meeting types whose transcripts are synthesized by Gemini 2.5 Flash-Lite
 *  (large-context report writing) — see config/token-economy.json
 *  report_models_by_meeting_type. All other meeting types use Groq
 *  (llama3-8b-8192), falling back to Cloudflare Workers AI. */
const GEMINI_MEETING_TYPES = new Set(['monthly', 'quarterly', 'semi_yearly', 'yearly']);

const REPO_OWNER = 'avivnofar';
const REPO_NAME = 'office-AI-agents';

/** All meeting types this engine knows how to run. */
export const MEETING_TYPES = {
  daily_standup: {
    label: 'Daily Standup',
    cadence: 'every simulated work day',
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

const AGENDA_BUILDERS = {
  daily_standup: (data) => `Run a brief daily standup. Each attendee gives a 1-2 sentence status based on this data:\n${JSON.stringify(data.sessionStats)}\nOpen incidents to address: ${JSON.stringify(data.openIncidents)}`,
  weekly: (data) => `Run the weekly meeting. Review last week's metrics:\n${JSON.stringify(data.latestWeek)}\nIncidents: ${JSON.stringify(data.incidents)}\nPending suggestions (decide approve/reject for at least the root and sudo ones): ${JSON.stringify(data.suggestions)}`,
  monthly: (data) => `Run the monthly review. Trends over the last ${data.rangeWeeks} weeks:\n${JSON.stringify(data.history)}\nRecent meetings: ${JSON.stringify(data.pastMeetings)}`,
  quarterly: (data) => `Run the quarterly review. Trends over the last ${data.rangeWeeks} weeks:\n${JSON.stringify(data.history)}\nDiscuss the IT Chief's quarterly equipment/network/programming optimization demands and the Architect's quarterly big-project update. Year stats: ${JSON.stringify(data.yearStats)}`,
  semi_yearly: (data) => `Run the semi-yearly review. Trends over the last ${data.rangeWeeks} weeks:\n${JSON.stringify(data.history)}\nDiscuss promotion candidates and any rivalry/relationship developments.`,
  yearly: (data) => `Run the yearly review. Full-year trends:\n${JSON.stringify(data.history)}\nYear stats: ${JSON.stringify(data.yearStats)}\nThis is the year-end meeting: discuss promotion nominations (CEO + admin majority vote), the executive summary, and recommendations for next year.`,
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
  "action_items": ["<short action item>", ...],
  "config_overrides": [{ "agent_id": <int>, "overrides": { "<config_key>": <value> }, "reason": "<short reason>" }],
  "suggestion_decisions": [{ "suggestion_id": "<id or empty>", "decision": "approved|rejected", "reason": "<short reason>" }]
}
Then the marker ---END---.
Every array may be empty. Keep the JSON valid and self-contained.`;

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

  const systemPrompt = [
    `You are simulating a "${meta.label}" at a small IT company's office. The following personas are attendees. Roleplay all of them faithfully and consistently with their states and behavioral rules.`,
    personas,
    relNotes.length ? `Known dynamics:\n- ${relNotes.join('\n- ')}` : '',
    DECISIONS_SCHEMA_HINT,
  ].filter(Boolean).join('\n\n');

  const agendaBuilder = AGENDA_BUILDERS[meetingType] || (() => 'Run a general meeting and produce decisions.');
  const prompt = `Meeting type: ${meta.label}\nDate: ${new Date().toISOString()}\n\nAgenda data:\n${agendaBuilder(data)}`;

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

/* ────────────────────────────── Effects ───────────────────────────────── */

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

  const actionItems = (decisions.action_items || []).map((a) => `- [ ] ${a}`).join('\n') || '_None._';

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
 * Commits a meeting report markdown file to reports/meetings/ in
 * this repo via the GitHub Contents API. No-ops if env.GITHUB_TOKEN
 * (a Worker secret, never shipped to the browser) isn't configured.
 */
async function commitMeetingReport(env, meetingType, markdown) {
  if (!env.GITHUB_TOKEN) return { committed: false, reason: 'GITHUB_TOKEN not configured' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `reports/meetings/${meetingType}-${stamp}.md`;
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      message: `chore(agents): ${meetingType} meeting report ${stamp} [skip ci]`,
      content: btoa(unescape(encodeURIComponent(markdown))),
    }),
  });

  return { committed: res.ok, status: res.status, path };
}

/* ─────────────────────────────── Orchestrator ──────────────────────────── */

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
  const { systemPrompt, prompt } = buildMeetingPrompt(meetingType, attendeeSnapshots, data, opts);

  let modelResult;
  if (GEMINI_MEETING_TYPES.has(meetingType)) {
    const simConfig = env.SIM_CONFIG?.GEMINI || {};
    modelResult = await callGemini({
      apiKey: env.GEMINI_API_KEY,
      model: simConfig.model || 'gemini-3.5-flash',
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

  const dbId = await persistMeeting(env, { meetingType, attendees: attendeeIds, transcript, decisions });

  const markdown = renderMeetingReport(meetingType, attendeeSnapshots, transcript, decisions, opts);
  const commit = await commitMeetingReport(env, meetingType, markdown);

  return {
    meetingType,
    attendees: attendeeIds,
    transcript,
    decisions,
    dbId,
    report: { markdown, ...commit },
  };
}
