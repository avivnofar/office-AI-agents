/**
 * Data Center — AI Agent Simulation — agent runner Worker.
 *
 * Three responsibilities:
 *   1. `instantiateAgent()` / `runAgentSession()` — instantiate an agent
 *      (merging durable `configOverrides` from its Durable Object over the
 *      static agents-config.json entry via agent-base.js's loadState()) and
 *      run it against a single case.
 *   2. `runWorkDayCycle()` / `runWeeklyResetCycle()` — the simulation's
 *      cron-driven cycles: CRM case generation/assignment (crm-engine.js),
 *      per-agent behavioral loop, meeting-engine.js checks (daily standup,
 *      milestone reviews, audits, PIP sessions), side-plot lifecycle
 *      (side-plots.json), and year-tracker bookkeeping (year-tracker.json).
 *      Exposed via `scheduled()` for Cron Triggers and `/api/agents/trigger`
 *      for manual/admin runs.
 *   3. HTTP API for the Admin tab (dashboard/) — read-only status,
 *      live session feed, reports, suggestions, year/side-plot state, and
 *      simulation controls, all backed by D1.
 *
 * Bindings expected (see README.md):
 *   DB             - D1 database (schema.sql)
 *   AGENT_STATE    - Durable Object namespace (state-manager.js AgentStateDO)
 *   SIM_KV         - KV namespace for live simulation overrides
 *   GEMINI_API_KEY - secret
 *   GITHUB_TOKEN   - secret (optional; gates report/guide commits)
 *   ADMIN_TOKEN    - secret (validates X-Admin-Token on /api/agents/*)
 *
 * Status: DRAFT (Phase 1 foundation, Phase 2 office simulation).
 */

export { AgentStateDO } from './state-manager.js';

import agentsConfig from '../config/agents-config.json';
import simulationConfig from '../config/simulation-config.json';
import sidePlotsConfig from '../config/side-plots.json';
import yearTrackerSeed from '../config/year-tracker.json';
import dailyScheduleConfig from '../config/daily-schedule.json';
import aiToolsConfig from '../config/ai-tools.json';

import { PerfectionistAgent } from '../agents/agent-1-perfectionist.js';
import { ProductiveAgent } from '../agents/agent-2-productive.js';
import { StandardAgent } from '../agents/agent-3-standard.js';
import { TraineeAgent } from '../agents/agent-4-trainee.js';
import { StubAgent } from '../agents/agent-stub.js';

import { runMeeting, MEETING_TYPES } from './meeting-engine.js';
import { callCFRouter } from './gemini-client.js';
import {
  generateAssignedDailyBatch,
  persistCrmCases,
  recordCompareAlternatives,
  getModelUsageAdjustment,
} from './crm-engine.js';
import { resolveWriteTarget, resolveIssueTarget, checkCodeWriteAllowed } from './permission-guard.js';
import { runChoreRotationSlot } from './chore-runner.js';

const ALLOWED_ORIGINS = ['https://avivnofar.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500'];
const REPO_OWNER = 'avivnofar';
const REPO_NAME = 'office-AI-agents';
const ARCHIVE_REPO_NAME = 'data-center-archive';

// Maps this file's GitHub repo constants to config/project-permissions.json
// keys, so commitFileToRepo()/fileGitHubIssue() can enforce push permission
// per the General rule (see workers/permission-guard.js) for EVERY repo
// they might write to, including this one. REPO_NAME (office-AI-agents) is
// deliberately included, not exempted — as of the 2026-07-08 config-driven
// self-write session, self-repo writes are gated by the real
// "office-agents" project-permissions.json entry (push:true, currently)
// like any other project, not by a hardcoded bypass. If "office-agents"
// were ever missing or push:false, self-writes would be redirected into
// agent-output/office-agents/... same as any other blocked project — see
// project-permissions.json's office_agents_push_true_is_load_bearing note.
const REPO_TO_PROJECT_KEY = {
  [REPO_NAME]: 'office-agents',
  [ARCHIVE_REPO_NAME]: 'data-center',
};

/** Maps year-tracker.json milestone keys to the meeting they trigger (in
 * addition to the daily standup, which always runs). */
const MILESTONE_MEETINGS = {
  day_30: 'monthly',
  day_90: 'quarterly',
  day_180: 'semi_yearly',
  day_270: 'quarterly',
  day_365: 'yearly',
};

/** Phase 1 agents get full implementations; 5-11 use StubAgent (now driven
 * by their full agents-config.json specs — see agents/config _meta notes). */
export const AGENT_CLASSES = {
  1: PerfectionistAgent,
  2: ProductiveAgent,
  3: StandardAgent,
  4: TraineeAgent,
};

export function getAgentConfig(id) {
  return agentsConfig.agents.find((a) => a.id === id);
}

/**
 * Instantiates an agent. StubAgent-driven agents (5-11) whose
 * `model_usage_rate` in agents-config.json is a descriptive placeholder
 * (e.g. "optimized_dynamic", "uniquely_tailored_to_CEO_timeline") rather than
 * a number get a numeric runtime default of 0.5 so StubAgent's
 * `Math.random() < model_usage_rate` check works; the displayed config value
 * (and configOverrides, applied later via loadState()) are unaffected.
 */
export function instantiateAgent(id, env) {
  const config = getAgentConfig(id);
  if (!config) throw new Error(`Unknown agent id ${id}`);

  const AgentClass = AGENT_CLASSES[id] || StubAgent;
  const agentEnv = { ...env, SIM_CONFIG: simulationConfig };

  let runtimeConfig = config;
  if (AgentClass === StubAgent && typeof config.model_usage_rate !== 'number') {
    runtimeConfig = { ...config, model_usage_rate: 0.5 };
  }

  let doStub;
  if (env.AGENT_STATE) {
    const doId = env.AGENT_STATE.idFromName(config.durable_object_id);
    doStub = env.AGENT_STATE.get(doId);
  }

  return new AgentClass(runtimeConfig, agentEnv, doStub);
}

/**
 * Loads an agent's persisted state (including configOverrides — see
 * agent-base.js loadState()), runs one case through it, and returns a
 * summary suitable for logging.
 */
export async function runAgentSession(agentId, caseData, env, opts = {}) {
  const agent = instantiateAgent(agentId, env);
  await agent.loadState();
  const result = await agent.handleCase(caseData, opts);
  return {
    agentId,
    result,
    mood: agent.mood,
    irritation: agent.irritation,
    isHappy: agent.isHappy,
    isAngry: agent.isAngry,
    isPanic: agent.isPanic,
    panicLevel: agent.panicLevel,
    configOverrides: agent.configOverrides || {},
  };
}

/**
 * Direct queryGemini() smoke test for an agent — bypasses handleCase()'s
 * probabilistic app-usage logic so Gemini / the Cloudflare fallback can be
 * exercised deterministically. See POST /api/agents/test-gemini.
 */
export async function runGeminiTest(agentId, prompt, env, opts = {}) {
  const agent = instantiateAgent(agentId, env);
  await agent.loadState();
  const text = await agent.queryGemini(prompt, undefined, { forceFallback: !!opts.forceFallback });
  return { agentId, prompt, text, source: agent.lastModelSource };
}

function corsHeaders(origin) {
  const headers = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

/* ──────────────────────────── Status / read APIs ───────────────────────── */

async function getAllAgentStatuses(env) {
  const statuses = [];
  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();
    statuses.push({
      id: agent.id,
      key: agent.key,
      name: agent.name,
      role: config.role,
      tier: config.tier,
      clearance: config.clearance,
      status: config.status || 'active',
      mood: agent.mood,
      irritation: agent.irritation,
      isHappy: agent.isHappy,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
      panicLevel: agent.panicLevel,
      session: agent.session,
      quotas: config.quotas || null,
      configOverrides: agent.configOverrides || {},
      last_active: agent.session?.started_at || null,
    });
  }
  return statuses;
}

async function getRecentInteractions(env, limit = 50) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT i.*, a.name AS agent_name FROM interactions i
     JOIN agents a ON a.id = i.agent_id
     ORDER BY i.timestamp DESC LIMIT ?`
  ).bind(limit).all();
  return results;
}

async function getReports(env, type) {
  if (!env.DB) return [];
  const stmt = type
    ? env.DB.prepare(`SELECT * FROM reports WHERE type = ? ORDER BY created_at DESC LIMIT 100`).bind(type)
    : env.DB.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT 100`);
  const { results } = await stmt.all();
  return results;
}

async function getSuggestions(env) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM suggestions
     ORDER BY CASE permission_level WHEN 'root' THEN 0 WHEN 'sudo' THEN 1 ELSE 2 END, created_at DESC
     LIMIT 100`
  ).all();
  return results;
}

/* ─────────────────────────── Simulation state ─────────────────────────── */

/**
 * Simulation control state lives in KV (binding: SIM_KV) as a small JSON
 * override merged over simulation-config.json's SIMULATION block. Falls
 * back to the static config defaults if SIM_KV isn't bound yet.
 */
const SIM_STATE_KEY = 'simulation-state';

async function getSimulationState(env) {
  const base = { ...simulationConfig.SIMULATION, paused: false };
  if (!env.SIM_KV) return base;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json');
  return { ...base, ...(stored || {}) };
}

async function updateSimulationState(env, patch) {
  const current = await getSimulationState(env);
  const allowedKeys = ['inspection_mode', 'paused', 'phase'];
  const next = { ...current };
  for (const key of allowedKeys) {
    if (key in patch) next[key] = patch[key];
  }
  if (env.SIM_KV) await env.SIM_KV.put(SIM_STATE_KEY, JSON.stringify(next));
  return next;
}

/* ───────────────────────────── Year tracker ────────────────────────────── */

function emptyYearStats() {
  return { ...JSON.parse(JSON.stringify(yearTrackerSeed.stats)), year_number: 1 };
}

/** Reads the latest `year_stats` row, seeding from year-tracker.json if none exists yet. */
async function getYearState(env) {
  if (!env.DB) {
    return {
      simulation_start: null,
      current_day: 0,
      current_week: 0,
      current_month: 0,
      current_quarter: 0,
      total_days: yearTrackerSeed.total_days,
      stats: emptyYearStats(),
    };
  }

  const row = await env.DB.prepare(`SELECT * FROM year_stats ORDER BY recorded_at DESC LIMIT 1`).first().catch(() => null);
  if (!row) {
    return {
      simulation_start: new Date().toISOString(),
      current_day: 0,
      current_week: 0,
      current_month: 0,
      current_quarter: 0,
      total_days: yearTrackerSeed.total_days,
      stats: emptyYearStats(),
    };
  }

  return {
    simulation_start: row.simulation_start,
    current_day: row.current_day,
    current_week: row.current_week,
    current_month: row.current_month,
    current_quarter: row.current_quarter,
    total_days: yearTrackerSeed.total_days,
    stats: { ...emptyYearStats(), ...JSON.parse(row.stats || '{}') },
  };
}

async function persistYearState(env, state) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO year_stats (id, simulation_start, current_day, current_week, current_month, current_quarter, stats, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(
    crypto.randomUUID(),
    state.simulation_start,
    state.current_day,
    state.current_week,
    state.current_month,
    state.current_quarter,
    JSON.stringify(state.stats || {})
  ).run().catch(() => {});
}

function updateYearStats(prevStats, { summary, standup, sidePlotStarted, sidePlotUpdates }) {
  const stats = { ...emptyYearStats(), ...(prevStats || {}) };

  for (const a of summary.agents) {
    stats.total_cases_handled += a.handled || 0;
    stats.total_cases_by_agent[a.agentId] = (stats.total_cases_by_agent[a.agentId] || 0) + (a.handled || 0);
    stats.total_trainee_panic_escalations += a.escalations || 0;
    stats.avg_mood_by_agent[a.agentId] = a.mood;
  }

  if (standup && !standup.error) {
    stats.total_meetings += 1;
    stats.total_meetings_by_type.daily_standup = (stats.total_meetings_by_type.daily_standup || 0) + 1;
  }

  for (const plot of sidePlotStarted || []) {
    stats.total_side_plots += 1;
    stats.total_side_plots_by_type[plot.type] = (stats.total_side_plots_by_type[plot.type] || 0) + 1;
    if (plot.type === 'rivalry_escalation') stats.rivalry_escalation_count += 1;
  }

  for (const u of sidePlotUpdates || []) {
    if (u.status === 'resolved' && u.type === 'pip_drama') {
      stats.total_pip_placements += 1;
    }
  }

  return stats;
}

/* ─────────────────────────────── GitHub ────────────────────────────────── */

/**
 * Commits a file to a repo via the GitHub Contents API. No-ops if
 * env.GITHUB_TOKEN (a Worker secret, never shipped to the browser) isn't
 * configured.
 *
 * Enforces the two General agent-conduct rules before ever calling GitHub:
 *   1. Code-file writes are blocked unless `opts.explicitCodeTask` is true
 *      (agents don't write code files unless directly instructed).
 *   2. Writes to a project repo (including this one — see
 *      REPO_TO_PROJECT_KEY's comment) are redirected into REPO_NAME under
 *      agent-output/<projectKey>/ when that project's
 *      config/project-permissions.json entry has push:false (agents may
 *      only recommend/write-to-own-repo for those projects).
 * See workers/permission-guard.js.
 */
async function commitFileToRepo(env, repoName, path, content, message, opts = {}) {
  const codeCheck = checkCodeWriteAllowed({ filePath: path, explicitCodeTask: opts.explicitCodeTask });
  if (!codeCheck.allowed) {
    return { committed: false, reason: codeCheck.reason, blocked: 'code-write-guard' };
  }

  const projectKey = REPO_TO_PROJECT_KEY[repoName];
  if (projectKey) {
    const target = resolveWriteTarget({ projectKey, ownRepoName: REPO_NAME, targetRepoName: repoName, path });
    repoName = target.repoName;
    path = target.path;
    if (target.redirected) message = `${message} [redirected: push disabled for "${target.projectKey}"]`;
  }

  if (!env.GITHUB_TOKEN) return { committed: false, reason: 'GITHUB_TOKEN not configured' };

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };
  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/contents/${path}`;

  // Updating an existing file requires its current blob sha.
  let sha;
  const existing = await fetch(url, { headers }).catch(() => null);
  if (existing?.ok) {
    const data = await existing.json().catch(() => null);
    sha = data?.sha;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: btoa(unescape(encodeURIComponent(content))), ...(sha ? { sha } : {}) }),
  });
  return { committed: res.ok, status: res.status, path };
}

/**
 * Generic GitHub Issue creation. No-ops without env.GITHUB_TOKEN.
 *
 * Enforces the same "no external push when push:false" General rule as
 * commitFileToRepo() (see workers/permission-guard.js) — a filed-Issue is a
 * write to that project's repo just as much as a file commit is, so an
 * attempt to open an Issue in a push:false project gets redirected into
 * REPO_NAME instead of landing in the external repo.
 */
async function fileGitHubIssue(env, repoName, { title, body, labels }) {
  const projectKey = REPO_TO_PROJECT_KEY[repoName];
  if (projectKey) {
    const target = resolveIssueTarget({ projectKey, ownRepoName: REPO_NAME, targetRepoName: repoName, title, body });
    repoName = target.repoName;
    title = target.title;
    body = target.body;
  }

  if (!env.GITHUB_TOKEN) return { created: false, reason: 'GITHUB_TOKEN not configured' };

  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  return { created: res.ok, status: res.status };
}

/** Reads reports/asset-pipeline/board.json from the repo (read-only, public). Returns { items: [] } on any failure. */
async function fetchAssetBoard(env) {
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/reports/asset-pipeline/board.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { items: [] };
    return await res.json();
  } catch {
    return { items: [] };
  }
}

/** Only project the model-education program covers today (data-center-api's
 * AI Search). Add per-case project routing here if it ever covers more than
 * one target project. */
const MODEL_EDUCATION_PROJECT = 'data-center';

/**
 * Batches today's model-education case studies (already generated by
 * runDailyAiExperienceReports, each with its responsible agent's own
 * root-cause writeup) into ONE report file under
 * reports/model-education/<project>/<date>.md, then files AT MOST ONE
 * 'claude-action' + 'model-education' Issue in REPO_NAME (office-AI-agents
 * — never data-center directly, see fileGitHubIssue()'s permission-guard
 * check) linking to that file. No-ops (returns null) if there were no case
 * studies today — never files an empty digest.
 */
async function fileModelEducationDigest(env, caseStudies) {
  if (!caseStudies.length) return null;

  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = `reports/model-education/${MODEL_EDUCATION_PROJECT}/${dateStr}.md`;
  const plural = caseStudies.length === 1 ? '' : 's';

  const fileContent = `# Model Education — ${MODEL_EDUCATION_PROJECT} — ${dateStr}\n\n`
    + `${caseStudies.length} case${plural} fell below the model-education quality threshold today. `
    + `Each write-up below is the responsible agent's own root-cause analysis (query, mode, ownership).\n\n`
    + caseStudies.map((c) => `## Case \`${c.caseId}\` — Agent ${c.agentId} (${c.agentName}), quality ${c.quality.toFixed(2)}/1.0\n\n${c.writeup}`).join('\n\n');

  const commit = await commitFileToRepo(
    env, REPO_NAME, reportPath, fileContent,
    `chore(model-education): ${dateStr} digest (${caseStudies.length} case${plural})`
  );

  const reportUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/master/${reportPath}`;
  const issueBody = [
    `${caseStudies.length} case${plural} flagged for model-education review today (quality below `
      + `${dailyScheduleConfig.model_education_program.model_education_case_study.quality_threshold}). `
      + `Full root-cause write-ups: [${reportPath}](${reportUrl}).`,
    '',
    ...caseStudies.map((c) => `- **${c.caseId}** (Agent ${c.agentId}, quality ${c.quality.toFixed(2)}/1.0) — ${c.writeup.split(/(?<=[.!?])\s/)[0]}`),
  ].join('\n');

  const issue = await fileGitHubIssue(env, REPO_NAME, {
    title: `[Model Education] Daily digest — ${dateStr} (${caseStudies.length} case${plural})`,
    body: issueBody,
    labels: ['claude-action', 'model-education'],
  });

  return { reportPath, committed: commit.committed, issue };
}

/**
 * Opens an asset-task for a queued asset-pipeline board item: files a
 * GitHub Issue (labels: asset-task, AGENT-N) describing the spec, and marks
 * the board item so it isn't re-filed. No-ops without env.GITHUB_TOKEN.
 */
async function fileAssetTaskIssue(env, item, ownerAgentIds) {
  const labels = ['asset-task', ...ownerAgentIds.map((id) => `AGENT-${id}`)];
  return fileGitHubIssue(env, REPO_NAME, {
    title: `[Asset Task] ${item.title}`,
    body: `Board item: \`${item.id}\`\nSpec: ${item.spec_file}\n\nSee the spec file for the full goal, schema, and acceptance criteria. Update reports/asset-pipeline/board.json's \`${item.id}\` entry as the work progresses.`,
    labels,
  });
}

/* ─────────────────────────── Config overrides ──────────────────────────── */

/**
 * Merges `overrides` into an agent's durable `configOverrides` (DO state).
 * agent-base.js's loadState() merges configOverrides over the static
 * agents-config.json entry the next time the agent is instantiated.
 */
async function applyConfigOverride(env, agentId, overrides) {
  const config = getAgentConfig(agentId);
  if (!env.AGENT_STATE || !config) return;

  const doId = env.AGENT_STATE.idFromName(config.durable_object_id);
  const stub = env.AGENT_STATE.get(doId);

  const res = await stub.fetch('https://agent-state/state');
  const data = await res.json().catch(() => ({}));
  const merged = { ...(data.configOverrides || {}), ...overrides };

  await stub.fetch('https://agent-state/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, configOverrides: merged, updated_at: new Date().toISOString() }),
  });
}

/* ──────────────────────────────── Side plots ───────────────────────────── */

async function getSidePlots(env, status) {
  if (!env.DB) return [];
  const stmt = status
    ? env.DB.prepare(`SELECT * FROM side_plots WHERE status = ? ORDER BY created_at DESC LIMIT 50`).bind(status)
    : env.DB.prepare(`SELECT * FROM side_plots ORDER BY created_at DESC LIMIT 50`);
  const { results } = await stmt.all();
  return results.map((r) => ({ ...r, agents: JSON.parse(r.agents || '[]') }));
}

async function countActiveSidePlots(env) {
  if (!env.DB) return 0;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM side_plots WHERE status = 'active'`).first().catch(() => null);
  return row?.n || 0;
}

async function hasActiveSidePlot(env, type) {
  if (!env.DB) return false;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM side_plots WHERE status = 'active' AND type = ?`).bind(type).first().catch(() => null);
  return (row?.n || 0) > 0;
}

/** Starts a new side plot (side-plots.json side_plot_types[type]) if under max_concurrent and not already active. */
async function startSidePlot(env, type, agentIds, startDay) {
  const typeConfig = sidePlotsConfig.side_plot_types[type];
  if (!typeConfig || !env.DB) return null;
  if (await countActiveSidePlots(env) >= sidePlotsConfig.lifecycle.max_concurrent) return null;
  if (await hasActiveSidePlot(env, type)) return null;

  const duration = Array.isArray(typeConfig.duration_days)
    ? typeConfig.duration_days[typeConfig.duration_days.length - 1]
    : typeConfig.duration_days;

  const id = crypto.randomUUID();
  const reportPath = typeConfig.output_path
    .replace('{{type}}', type)
    .replace('{{start_date}}', new Date().toISOString().slice(0, 10));

  await env.DB.prepare(
    `INSERT INTO side_plots (id, type, agents, start_day, duration_days, current_stage, status, log, report_path, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'active', '', ?, CURRENT_TIMESTAMP)`
  ).bind(id, type, JSON.stringify(agentIds), startDay, duration, reportPath).run().catch(() => {});

  return { id, type, agents: agentIds, start_day: startDay, duration_days: duration, report_path: reportPath };
}

function renderSidePlotReport(plot, typeConfig, log) {
  const agents = JSON.parse(plot.agents || '[]');
  return `# ${typeConfig.label} — started day ${plot.start_day}

## Agents involved

${agents.map((a) => `- Agent ${a}`).join('\n')}

## Timeline

${log}

## Resolution

${typeConfig.resolution}
`;
}

/** Advances `current_stage` for every active side plot whose stage list has an entry for `currentDay`. */
async function advanceSidePlots(env, currentDay) {
  if (!env.DB) return [];
  const { results: active } = await env.DB.prepare(`SELECT * FROM side_plots WHERE status = 'active'`).all();
  const updates = [];

  for (const plot of active) {
    const typeConfig = sidePlotsConfig.side_plot_types[plot.type];
    if (!typeConfig) continue;

    const dayOffset = currentDay - plot.start_day + 1;
    const stage = typeConfig.stages.find((s) => s.day === dayOffset);
    if (!stage || dayOffset <= plot.current_stage) continue;

    const logLine = `Day ${dayOffset}: ${stage.event}`;
    const newLog = plot.log ? `${plot.log}\n${logLine}` : logLine;
    const lastStageDay = typeConfig.stages[typeConfig.stages.length - 1].day;
    const isFinal = dayOffset >= lastStageDay;
    const status = isFinal ? 'resolved' : 'active';

    await env.DB.prepare(
      `UPDATE side_plots SET current_stage = ?, log = ?, status = ?, resolved_at = ? WHERE id = ?`
    ).bind(dayOffset, newLog, status, isFinal ? new Date().toISOString() : null, plot.id).run().catch(() => {});

    if (isFinal) {
      const markdown = renderSidePlotReport(plot, typeConfig, newLog);
      await commitFileToRepo(env, REPO_NAME, plot.report_path, markdown, `chore(agents): ${plot.type} side plot resolved [skip ci]`);
    }

    updates.push({ id: plot.id, type: plot.type, dayOffset, stage: stage.event, status });
  }

  return updates;
}

/**
 * Heuristic checks run once per work-day cycle to seed new side plots
 * (side-plots.json side_plot_types triggers).
 */
async function maybeStartSidePlots(env, { day, summary, cases, standup }) {
  const started = [];

  // rivalry_escalation: Architect (10) repeatedly irritated by audits.
  const architect = summary.agents.find((a) => a.agentId === 10);
  if (architect && architect.irritation >= 2) {
    const plot = await startSidePlot(env, 'rivalry_escalation', [10, 8], day);
    if (plot) started.push(plot);
  }

  // client_crisis: a critical, unique-client, IT-Chief-required case today.
  const crisisCase = (cases || []).find((c) => c.severity === 'critical' && c.is_unique_client && c.requires_it_chief);
  if (crisisCase) {
    const plot = await startSidePlot(env, 'client_crisis', [5, crisisCase.assigned_to, 11], day);
    if (plot) started.push(plot);
  }

  // breakthrough: an agent ended HAPPY after handling an advanced case.
  const breakthroughAgent = summary.agents.find((a) => a.isHappy && a.advancedCases > 0);
  if (breakthroughAgent && Math.random() < 0.5) {
    const senior = breakthroughAgent.agentId === 5 || breakthroughAgent.agentId === 10
      ? null
      : (Math.random() < 0.5 ? 5 : 10);
    const agents = senior ? [breakthroughAgent.agentId, senior] : [breakthroughAgent.agentId];
    const plot = await startSidePlot(env, 'breakthrough', agents, day);
    if (plot) started.push(plot);
  }

  // comparison_event: an agent logged a "compare alternatives" event today.
  const comparisonAgent = summary.agents.find((a) => a.comparisons > 0);
  if (comparisonAgent) {
    const agents = Math.random() < 0.5 ? [comparisonAgent.agentId, 6] : [comparisonAgent.agentId];
    const plot = await startSidePlot(env, 'comparison_event', agents, day);
    if (plot) started.push(plot);
  }

  // inspiration_event: Designer (9) crosses inspired_threshold.
  const designer = instantiateAgent(9, env);
  await designer.loadState();
  const inspiredThreshold = designer.config.inspired_threshold ?? 51;
  if (designer.mood >= inspiredThreshold) {
    const source = Math.random() < 0.5 ? 11 : 10;
    const plot = await startSidePlot(env, 'inspiration_event', [9, source], day);
    if (plot) started.push(plot);
  }

  // meeting_tension: today's standup left 2+ agents irritated.
  if (standup && !standup.error && (standup.decisions?.irritation_effects?.length || 0) >= 2) {
    const plot = await startSidePlot(env, 'meeting_tension', standup.attendees, day);
    if (plot) started.push(plot);
  }

  return started;
}

/* ─────────────────────────────── Reporting ─────────────────────────────── */

function renderDailySummary(yearState, summary, standup, sidePlotStarted, sidePlotUpdates, milestone, scheduleInfo) {
  const agentLines = summary.agents
    .map((a) => `- Agent ${a.agentId}: ${a.handled}/${a.caseCount} cases, mood ${a.mood}, irritation ${a.irritation}${a.isAngry ? ' (ANGRY)' : ''}${a.isPanic ? ' (PANIC)' : ''}`)
    .join('\n') || '_No agents processed cases today._';

  const startedLines = sidePlotStarted.map((p) => `- Started: ${p.type} (agents ${p.agents.join(', ')})`).join('\n');
  const updateLines = sidePlotUpdates.map((u) => `- ${u.type}: ${u.stage} (${u.status})`).join('\n');
  const sidePlotLines = [startedLines, updateLines].filter(Boolean).join('\n') || '_None._';

  const scheduleSection = scheduleInfo ? renderScheduleSection(scheduleInfo) : '';

  return `# Day ${yearState.current_day} Summary — ${new Date().toISOString()}

Week ${yearState.current_week}, Month ${yearState.current_month}, Quarter ${yearState.current_quarter} (Year ${yearState.stats.year_number || 1}).
${milestone ? `\n**Milestone: ${milestone.label}** — ${milestone.description}\n` : ''}
## Case Handling

${agentLines}

## Daily Standup

${standup?.transcript ? standup.transcript : standup?.error ? `_Standup error: ${standup.error}_` : '_No standup recorded._'}

## Side Plot Activity

${sidePlotLines}
${scheduleSection}`;
}

/** Renders the tactical-schedule section (case batches, tool-task window, AI-experience reports, spare time, weekly summary). */
function renderScheduleSection(scheduleInfo) {
  const { schedule, batches, toolTask, aiExperience, spareTime, weeklySummary, versionBumps, choreRotation } = scheduleInfo;

  const batchLines = batches
    .map((b) => `- ${b.block.time || '—'} ${b.block.label}: ${b.cases.length} case(s)`)
    .join('\n') || '_No case batches (off day)._';

  const toolTaskLine = toolTask
    ? toolTask.opened
      ? `Opened asset-task for \`${toolTask.item}\` (tool: ${toolTask.tool}, agents ${toolTask.agents?.join(', ')}).`
      : `No new asset-task opened (${toolTask.reason || 'n/a'}).`
    : '_Not a tool-task day (Fri/Sat)._';

  const choreRotationLine = choreRotation
    ? `**${choreRotation.projectKey}**: ${choreRotation.reason}${choreRotation.routedModel ? ` (would route to ${choreRotation.routedModel})` : ''}`
    : '_No chore-rotation block today._';

  const statusReportLines = (aiExperience?.statusReports || [])
    .map((r) => `- Agent ${r.agentId}: "${r.note}"`).join('\n') || '_None filed today._';
  const caseStudyLines = (aiExperience?.caseStudies || [])
    .map((c) => `- Agent ${c.agentId}, case ${c.caseId} (quality ${c.quality.toFixed(2)}/1.0) -> reports row \`${c.reportId}\``).join('\n') || '_None — no interactions below the model-education quality threshold today._';
  const digestLine = aiExperience?.digest
    ? `[\`${aiExperience.digest.reportPath}\`](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/master/${aiExperience.digest.reportPath})`
      + `${aiExperience.digest.issue?.created ? ' — GitHub Issue filed' : ' — queued (no GITHUB_TOKEN, or Issue creation failed)'}`
    : '_No model-education digest filed today (no cases below threshold)._';

  const spareTimeLines = spareTime
    .map((s) => s.mode === 'idle' ? `- Agent ${s.agentId}: idle (token-saving)` : `- Agent ${s.agentId}: chatted with agent ${s.partner}`)
    .join('\n') || '_No agents reached spare time today._';

  let weeklySection = '';
  if (weeklySummary) {
    const bumpLines = versionBumps.length
      ? versionBumps.map((b) => `- \`${b.id}\` -> v${b.version.toFixed(2)}`).join('\n')
      : '_No products reached "implemented" this week._';
    weeklySection = `

## Weekly Executive Summary (Friday)

Generated \`reports/weekly/week-${pad(weeklySummary.weekNumber, 2)}-{summary.md,data.csv,public-summary.md}\`.

**Product version bumps:**
${bumpLines}`;
  }

  return `
## Daily Schedule

**Day type:** ${schedule === dailyScheduleConfig.saturday_schedule ? 'Saturday (off)' : schedule === dailyScheduleConfig.friday_schedule ? 'Friday (short)' : 'Sun-Thu (full)'}

### Case Batches

${batchLines}

### AI-Tool Task Window

${toolTaskLine}

### Cross-Project Chore Rotation

${choreRotationLine}

### Daily AI-Experience Reports

${statusReportLines}

### Model-Education Case Studies

${caseStudyLines}

**Daily digest**: ${digestLine}

### Spare Time

${spareTimeLines}${weeklySection}
`;
}

function renderPromotionResults(yearNumber, meeting) {
  const decisions = meeting.decisions || {};
  const overrides = (decisions.config_overrides || [])
    .map((o) => `- Agent ${o.agent_id}: ${JSON.stringify(o.overrides)} — ${o.reason}`)
    .join('\n') || '_None recorded._';

  return `# Year ${yearNumber} Promotion Results

## Summary

${decisions.summary || '_No summary provided._'}

## Approved Promotions / Config Overrides

${overrides}

## Action Items for Year ${yearNumber + 1}

${(decisions.action_items || []).map((a) => `- [ ] ${a}`).join('\n') || '_None._'}

## Full Yearly Meeting Transcript

${meeting.transcript || '_Not available._'}
`;
}

/* ─────────────────────────────── Work day cycle ────────────────────────── */

/** Normalizes the differing handleCase() return shapes across agent classes. */
function extractOutcome(raw) {
  if (!raw) return { result: null, escalation: null, quality: undefined };
  if (Object.prototype.hasOwnProperty.call(raw, 'escalation') || Object.prototype.hasOwnProperty.call(raw, 'guide')) {
    return { result: raw.result || null, escalation: raw.escalation || null, quality: raw.result?.quality };
  }
  return { result: raw, escalation: null, quality: raw.quality };
}

/**
 * Joint session: the escalated agent (selected by TraineeAgent's
 * escalation protocol) also works the trainee's case. If a guide was
 * generated, commits it to data-center-archive/guides/.
 */
async function handleTraineePanic(env, event) {
  const helper = instantiateAgent(event.selectedAgent, env);
  await helper.loadState();
  await helper.handleCase(event.caseData, { archiveGuides: [] });

  let guideCommit = null;
  if (event.generatedGuide) {
    guideCommit = await commitFileToRepo(
      env,
      ARCHIVE_REPO_NAME,
      event.generatedGuide.path,
      event.generatedGuide.content,
      `docs: auto-generated guide for ${event.generatedGuide.path} [skip ci]`
    );
  }

  return { helperAgentId: event.selectedAgent, guideCommit };
}

/* ─────────────────────────── Daily schedule (Phase 2) ──────────────────── */

/** Returns the day-type schedule block for a 1-7 dayOfWeek (1=Sun..7=Sat), per daily-schedule.json week_mapping. */
function getDaySchedule(dayOfWeek) {
  if (dailyScheduleConfig.friday_schedule.applies_to_day_of_week.includes(dayOfWeek)) return dailyScheduleConfig.friday_schedule;
  if (dailyScheduleConfig.saturday_schedule.applies_to_day_of_week.includes(dayOfWeek)) return dailyScheduleConfig.saturday_schedule;
  return dailyScheduleConfig.full_day_schedule;
}

/** Splits `cases` (in original order) across the schedule's `case_batch` blocks per their case_share; the last batch absorbs any rounding remainder. */
function partitionCasesByShare(cases, blocks) {
  const batchBlocks = blocks.filter((b) => b.type === 'case_batch');
  if (!batchBlocks.length) return [{ block: { label: 'All cases', time: null }, cases }];

  const total = cases.length;
  const counts = batchBlocks.map((b) => Math.round(total * (b.case_share || 0)));
  const sum = counts.reduce((a, b) => a + b, 0);
  counts[counts.length - 1] += total - sum;

  const out = [];
  let idx = 0;
  for (let i = 0; i < batchBlocks.length; i++) {
    const n = Math.max(0, counts[i]);
    out.push({ block: batchBlocks[i], cases: cases.slice(idx, idx + n) });
    idx += n;
  }
  return out;
}

/**
 * Processes one scheduled case batch: groups by assigned agent, instantiates
 * (and caches across batches) each agent, runs handleCase() per case, and
 * accumulates per-agent stats + the model-education low-quality log.
 */
async function processCaseBatch(env, batchCases, agentInstances, agentStats, lowQualityLog) {
  // Lightweight, free case classification/routing via Cloudflare Workers AI
  // (config/token-economy.json routing_model). Best-effort — null on
  // any failure, never blocks dispatch.
  for (const c of batchCases) {
    const routing = await callCFRouter({ ai: env.AI, caseDescription: `${c.title}. ${c.description || ''}` });
    if (routing) c.cf_category = routing.category;
  }

  const byAgent = new Map();
  for (const c of batchCases) {
    if (!byAgent.has(c.assigned_to)) byAgent.set(c.assigned_to, []);
    byAgent.get(c.assigned_to).push(c);
  }

  for (const [agentId, agentCases] of byAgent) {
    let agent = agentInstances.get(agentId);
    if (!agent) {
      agent = instantiateAgent(agentId, env);
      await agent.loadState();
      agentInstances.set(agentId, agent);
    }

    if (!agentStats.has(agentId)) {
      agentStats.set(agentId, { agentId, caseCount: 0, handled: 0, escalations: 0, comparisons: 0, advancedCases: 0 });
    }
    const stats = agentStats.get(agentId);
    stats.caseCount += agentCases.length;

    if (agent.isAngry) continue;

    // Agent 10 (The Architect) never calls an AI model for routine cases
    // (config/token-economy.json architect_model: "human+claude-code")
    // — root-level escalations are filed as a GitHub Issue for human/
    // Claude-Code review instead of being handled in-sim.
    if (agentId === 10) {
      await processArchitectCaseBatch(env, agent, agentCases, stats);
      continue;
    }

    for (const c of agentCases) {
      const raw = await agent.handleCase(c, { archiveGuides: [] });
      const outcome = extractOutcome(raw);
      stats.handled += 1;
      if (c.difficulty === 'advanced') stats.advancedCases += 1;

      if (outcome.escalation?.type === 'TRAINEE_PANIC') {
        await handleTraineePanic(env, outcome.escalation);
        stats.escalations += 1;
      }

      // Lightweight "compare alternatives" sampling: when an interaction
      // left the agent unhappy, occasionally simulate checking an external
      // source (Agent 2's FOUND-OUTSIDE PATTERN and similar behaviors).
      if (outcome.quality !== undefined && outcome.quality < 0.5 && Math.random() < 0.3) {
        const claudeWasBetter = Math.random() < (outcome.quality + 0.3);
        await recordCompareAlternatives(env, {
          agentId,
          sessionId: agent.session?.id,
          caseId: c.id,
          claudeWasBetter,
          details: claudeWasBetter
            ? `${agent.name} found Claude's answer held up against an external source for case ${c.id}.`
            : `${agent.name} found an external source resolved case ${c.id} faster than Claude.`,
        });
        stats.comparisons += 1;
      }

      // Model education: the model didn't handle this case flawlessly.
      const meThreshold = dailyScheduleConfig.model_education_program.model_education_case_study.quality_threshold;
      if (outcome.quality !== undefined && outcome.quality < meThreshold) {
        lowQualityLog.push({
          agentId,
          caseId: c.id,
          quality: outcome.quality,
          caseSummary: c.title || c.category || c.id,
        });
      }

      if (agent.isAngry) break;
    }
  }
}

/**
 * Agent 10 (The Architect)'s case-batch handler. Each case routed to the
 * Architect is a root-level escalation (requires_it_chief and/or
 * advanced-difficulty — see crm-engine.js assignCase()). Per
 * config/token-economy.json (architect_model: "human+claude-code"),
 * the Architect does not call Groq/Gemini/Cloudflare for these — sessions
 * are logged for mood/state bookkeeping only, and the batch is filed as a
 * single 'claude-action' + 'architect-task' GitHub Issue for human/
 * Claude-Code review. No-ops without env.GITHUB_TOKEN.
 */
async function processArchitectCaseBatch(env, agent, agentCases, stats) {
  for (const c of agentCases) {
    await agent.startSession(c, 'search');
    agent.session.cases_handled = 1;
    await agent.endSession();
    stats.handled += 1;
    if (c.difficulty === 'advanced') stats.advancedCases += 1;
  }

  const body = agentCases.map((c) => {
    const tags = [c.category, c.difficulty, c.requires_it_chief ? 'IT-chief escalation' : null, c.cf_category ? `routed as "${c.cf_category}"` : null]
      .filter(Boolean).join(', ');
    return `- **${c.title}** (\`${c.id}\`${tags ? ` — ${tags}` : ''})\n  ${c.description || ''}`;
  }).join('\n');

  await fileGitHubIssue(env, REPO_NAME, {
    title: `[Architect] ${agentCases.length} root-level case${agentCases.length === 1 ? '' : 's'} escalated`,
    body: `Agent 10 (The Architect) received the following root-level escalation(s) this batch. Per config/token-economy.json, the Architect does not call an AI model for routine cases — these are queued here for human/Claude-Code review:\n\n${body}`,
    labels: ['claude-action', 'architect-task'],
  });
}

/**
 * Friday/full-day 'report' block: every agent who handled >=1 case today
 * files a casual AI-experience status report, and the worst-quality
 * interactions (up to model_education_case_study.max_per_day) become
 * model-education case studies queued for the Gemini-Claude bridge.
 */
async function runDailyAiExperienceReports(env, agentInstances, lowQualityLog) {
  const program = dailyScheduleConfig.model_education_program;
  const statusReports = [];
  const caseStudies = [];

  for (const [agentId, agent] of agentInstances) {
    if (!agent.session || !agent.session.cases_handled) continue;
    let note;
    try {
      note = await agent.queryGemini(
        "In 1-2 short, casual sentences (in character), describe today's experience using the AI Search assistant for your cases — what worked, what didn't."
      );
    } catch (err) {
      note = `(AI-experience report unavailable: ${err.message})`;
    }
    await agent.fileStatusReport(note);
    statusReports.push({ agentId, note });
  }

  const worst = [...lowQualityLog]
    .sort((a, b) => a.quality - b.quality)
    .slice(0, program.model_education_case_study.max_per_day);

  for (const entry of worst) {
    const agent = agentInstances.get(entry.agentId);
    if (!agent) continue;

    // Ownership: the responsible agent produces its own root-cause writeup
    // (existing Groq/Gemini budget via queryGemini()) rather than just
    // re-flagging the quality score — what likely failed, where the
    // knowledge-base gap probably is, and a suggested direction.
    let writeup;
    try {
      writeup = await agent.queryGemini(
        `You handled case ${entry.caseId} today: ${entry.caseSummary}. The AI Search assistant's response scored `
        + `${entry.quality.toFixed(2)}/1.0 and did not fully resolve it. Write a short root-cause case study (3-5 `
        + `sentences, in character) covering: (1) what most likely caused the response to fall short, (2) where the `
        + `underlying data-center knowledge-base gap probably is, (3) one concrete suggested direction to close it.`
      );
    } catch (err) {
      writeup = `Case ${entry.caseId} (quality ${entry.quality.toFixed(2)}/1.0): ${entry.caseSummary}. The AI Search `
        + `response did not fully resolve this case — flagged for model-education review. (Root-cause writeup `
        + `unavailable: ${err.message})`;
    }

    const reportId = await agent.fileModelEducationCaseStudy(writeup);
    caseStudies.push({ agentId: entry.agentId, agentName: agent.name, caseId: entry.caseId, quality: entry.quality, reportId, writeup });
  }

  const digest = await fileModelEducationDigest(env, caseStudies);

  return { statusReports, caseStudies, digest };
}

/**
 * Spare-time block for one agent: 20% chance of a short logged coworker-chat
 * (1 Gemini call), 80% chance (always on force_idle days) of going idle with
 * ZERO Gemini/Claude calls — the primary token-discipline lever.
 */
async function runSpareTimeForAgent(env, agent, { forceIdle }) {
  const program = dailyScheduleConfig.spare_time_program;
  const doInteract = !forceIdle && Math.random() < program.coworker_interaction_chance;

  if (!doInteract) {
    await agent.logInteraction({
      type: 'idle',
      query: '',
      response_summary: 'Spare time: agent went idle to preserve tokens (no API calls made).',
      mood_before: agent.mood,
      mood_after: agent.mood,
      irritation_change: 0,
      state_change: null,
    });
    return { agentId: agent.id, mode: 'idle' };
  }

  const others = agentsConfig.agents.filter((a) => a.id !== agent.id);
  const partner = others[Math.floor(Math.random() * others.length)];
  let text;
  try {
    text = await agent.queryGemini(
      `Write one short, in-character line of casual chat you'd say to your coworker ${partner.name} during a quiet moment at the office. Keep it to 1-2 sentences.`
    );
  } catch (err) {
    text = `(coworker chat unavailable: ${err.message})`;
  }

  await agent.logInteraction({
    type: 'coworker_chat',
    query: `chat with ${partner.name}`,
    response_summary: String(text).slice(0, 500),
    mood_before: agent.mood,
    mood_after: agent.mood,
    irritation_change: 0,
    state_change: null,
  });
  return { agentId: agent.id, mode: 'coworker_chat', partner: partner.id, text };
}

/**
 * Sun-Thu 'tool_task_window' block: per ai-tools.json's weekly_rotation,
 * checks whether today's assigned standing-project board item is queued and
 * not yet filed, and if so opens its asset-task GitHub Issue (human picks it
 * up in the real tool — no programmatic tool calls).
 */
async function maybeOpenAssetTask(env, dayOfWeek, nextDay) {
  const rotation = aiToolsConfig.weekly_rotation[String(dayOfWeek)];
  if (!rotation) return { opened: false, reason: 'no_rotation_for_day' };

  const board = await fetchAssetBoard(env);
  const item = (board.items || []).find((i) => i.id === rotation.standing_project_ref);
  if (!item) return { opened: false, reason: 'board_item_not_found', ref: rotation.standing_project_ref };

  if (item.stage !== 'queued' || item.asset_task_issue_filed) {
    return { opened: false, reason: 'not_eligible', item: item.id, stage: item.stage, tool: rotation.tool };
  }

  const issue = await fileAssetTaskIssue(env, item, rotation.agents);
  if (issue.created) {
    item.asset_task_issue_filed = true;
    item.history = [...(item.history || []), { day: nextDay, stage: item.stage, note: 'asset-task issue filed (auto, tool_task_window)' }];
    await commitFileToRepo(
      env, REPO_NAME, 'reports/asset-pipeline/board.json', JSON.stringify(board, null, 2) + '\n',
      `chore(agents): file asset-task issue for ${item.id} [skip ci]`
    );
  }

  return { opened: issue.created, tool: rotation.tool, agents: rotation.agents, item: item.id, issue };
}

/**
 * Friday 'weekly_summary' block: generates the 10-section executive markdown
 * ("PDF" — print-ready, see CLAUDE.md PDF Export convention), a per-agent CSV
 * ("Excel"), and a short public excerpt, all under reports/weekly/.
 * Also runs the existing 'weekly' meeting type.
 */
async function generateWeeklySummary(env, yearState, weekNumber) {
  const board = await fetchAssetBoard(env);

  const agentRows = [];
  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();
    const weeklyCases = await getWeeklyCasesHandled(env, config.id);
    agentRows.push({ agentId: config.id, name: agent.name, weeklyCases, mood: agent.mood, irritation: agent.irritation });
  }

  const csv = ['agent_id,name,weekly_cases,mood,irritation']
    .concat(agentRows.map((r) => `${r.agentId},${r.name},${r.weeklyCases},${r.mood},${r.irritation}`))
    .join('\n') + '\n';

  const pipelineLines = (board.items || [])
    .map((i) => `- **${i.title}** (\`${i.id}\`): stage=${i.stage}${typeof i.version === 'number' ? `, v${i.version.toFixed(2)}` : ''}`)
    .join('\n') || '_No pipeline items._';

  const md = `# Weekly Executive Summary — Week ${weekNumber}

*Permission: private/special (AI staff + owner). See reports/weekly/week-${pad(weekNumber, 2)}-public-summary.md for the public excerpt.*

## Executive Summary

Week ${weekNumber} of the data-center office simulation, ${agentRows.length} agents on roster.

## Case Volume & Categories

${agentRows.map((r) => `- Agent ${r.agentId} (${r.name}): ${r.weeklyCases} cases this week`).join('\n')}

## Agent Performance & Mood

${agentRows.map((r) => `- Agent ${r.agentId} (${r.name}): mood ${r.mood}, irritation ${r.irritation}/5`).join('\n')}

## Model (Claude) Performance & Education Findings

See \`reports\` rows of type \`model_education\` filed this week (and any resulting \`claude-action\`/\`model-education\` GitHub Issues).

## Incidents & Escalations

See \`reports\` rows of type \`incident\` filed this week.

## Side Plots & Narrative Highlights

See \`side_plots\` rows active or resolved during week ${weekNumber}.

## Asset Pipeline Status

${pipelineLines}

## Suggestions Queue (by permission tier)

See \`suggestions\` rows, grouped by \`permission_level\`.

## Cost & Token Usage Estimate

Gemini (gemini-3.5-flash, office simulation): tracking toward the
~$2-3/quarter target. Claude (claude-sonnet-4-6, data-center-api): tracking
toward the $5-15/mo ceiling. See CLAUDE.md "Launch Decisions" cost model.

## Action Items for Next Week

- [ ] Review this week's model-education case studies.
- [ ] Advance any 'returned' asset-pipeline items toward 'tested'/'optimized'/'implemented'.
- [ ] Re-check any agent at irritation >= 4/5 or mood <= 20.
`;

  const publicMd = `# Weekly Summary — Week ${weekNumber} (Public)

This week, the simulated IT support office continued operating across
${agentRows.length} staff roles, handling support cases with AI-assisted
diagnostics. No customer-facing issues to report.
`;

  const base = 'reports/weekly';
  const files = {
    summary: await commitFileToRepo(env, REPO_NAME, `${base}/week-${pad(weekNumber, 2)}-summary.md`, md, `chore(agents): week ${weekNumber} executive summary [skip ci]`),
    csv: await commitFileToRepo(env, REPO_NAME, `${base}/week-${pad(weekNumber, 2)}-data.csv`, csv, `chore(agents): week ${weekNumber} data export [skip ci]`),
    public: await commitFileToRepo(env, REPO_NAME, `${base}/week-${pad(weekNumber, 2)}-public-summary.md`, publicMd, `chore(agents): week ${weekNumber} public summary [skip ci]`),
  };

  let weeklyMeeting = null;
  try {
    weeklyMeeting = await runMeeting('weekly', env);
  } catch (err) {
    weeklyMeeting = { error: err.message };
  }

  return { weekNumber, files, agentRows, weeklyMeeting };
}

/**
 * On the weekly_summary block, bumps +0.01 the version of any asset-pipeline
 * board item that reached 'implemented' THIS day (per product_versioning in
 * daily-schedule.json), recording the new version in both board.json and
 * year_stats.stats.product_versions.
 */
async function checkProductVersionBumps(env, yearState, nextDay) {
  const versioning = dailyScheduleConfig.product_versioning;
  const board = await fetchAssetBoard(env);
  const bumps = [];

  for (const item of board.items || []) {
    if (item.stage !== 'implemented') continue;
    const last = item.history?.[item.history.length - 1];
    if (last?.day !== nextDay || last?.stage !== 'implemented' || last?.version_bumped) continue;

    const current = yearState.stats.product_versions?.[item.id] ?? (versioning.starting_version - versioning.increment);
    const next = Math.round((current + versioning.increment) * 100) / 100;

    yearState.stats.product_versions = { ...(yearState.stats.product_versions || {}), [item.id]: next };
    item.version = next;
    last.version_bumped = true;
    bumps.push({ id: item.id, version: next });
  }

  if (bumps.length) {
    await commitFileToRepo(
      env, REPO_NAME, 'reports/asset-pipeline/board.json', JSON.stringify(board, null, 2) + '\n',
      `chore(agents): version bump for ${bumps.map((b) => b.id).join(', ')} [skip ci]`
    );
  }

  return bumps;
}

/**
 * One simulated work day:
 *  1. CRM case generation + assignment + persistence (crm-engine.js)
 *  2. per-agent case-handling loop — mood/escalation handling, "compare
 *     alternatives" sampling, rolling model_usage_rate adjustment
 *  3. daily standup (meeting-engine.js)
 *  4. side plot lifecycle — start new / advance / resolve
 *  5. year-tracker update + milestone-triggered meeting (+ promotion
 *     results report on day 365)
 *  6. GitHub-committed daily summary
 *
 * As of the Phase-2 daily-automation build, steps 1-2 are driven by
 * config/daily-schedule.json (case batches spread across the day,
 * Sun-Thu/Fri/Sat day types), and the schedule's tool_task_window, report,
 * spare_time, and weekly_summary blocks are processed alongside it (see
 * config/ai-tools.json for the tool-access matrix). No cron is wired
 * to per-block times yet — see daily-schedule.json _meta.cron_status.
 */
export async function runWorkDayCycle(env) {
  const sim = await getSimulationState(env);
  if (sim.paused) return { skipped: true, reason: 'paused' };

  const yearState = await getYearState(env);
  const nextDay = (yearState.current_day || 0) + 1;
  const dayOfWeek = ((nextDay - 1) % 7) + 1;
  const schedule = getDaySchedule(dayOfWeek);
  const isOffDay = schedule === dailyScheduleConfig.saturday_schedule;

  const work = simulationConfig.WORK_DAY;
  const multiplier = sim.inspection_mode ? work.inspection_mode_multiplier : 1;
  const casesPerAgent = Math.round((simulationConfig.cases_per_day_per_agent || 20) * multiplier);

  const cases = isOffDay
    ? []
    : generateAssignedDailyBatch(dayOfWeek, { casesPerAgent, weekNumber: yearState.current_week || 1 });
  if (cases.length) await persistCrmCases(env, cases);

  // ── Case batches, spread across the day per daily-schedule.json ──
  const batches = partitionCasesByShare(cases, schedule.blocks);
  const agentInstances = new Map();
  const agentStats = new Map();
  const lowQualityLog = [];

  for (const batch of batches) {
    await processCaseBatch(env, batch.cases, agentInstances, agentStats, lowQualityLog);
  }

  const summary = { day: nextDay, dayOfWeek, inspection: sim.inspection_mode, agents: [] };

  for (const [agentId, agent] of agentInstances) {
    const stats = agentStats.get(agentId) || { agentId, caseCount: 0, handled: 0, escalations: 0, comparisons: 0, advancedCases: 0 };

    if (!agent.isAngry) {
      const adj = await getModelUsageAdjustment(env, agentId);
      if (adj.delta !== 0 && typeof agent.config.model_usage_rate === 'number') {
        const next = Math.min(1, Math.max(0, agent.config.model_usage_rate + adj.delta));
        await applyConfigOverride(env, agentId, { model_usage_rate: next });
      }
    }

    summary.agents.push({
      agentId,
      caseCount: stats.caseCount,
      handled: stats.handled,
      escalations: stats.escalations,
      comparisons: stats.comparisons,
      advancedCases: stats.advancedCases,
      mood: agent.mood,
      irritation: agent.irritation,
      isHappy: agent.isHappy,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
    });
  }

  // ── Remaining tactical blocks: tool-task window, AI-experience reports,
  // spare time, and (Friday) the weekly summary ──
  let toolTask = null;
  let aiExperience = null;
  const spareTime = [];
  let weeklySummary = null;
  let versionBumps = [];

  for (const block of schedule.blocks) {
    if (block.type === 'tool_task_window') {
      toolTask = await maybeOpenAssetTask(env, dayOfWeek, nextDay);
    } else if (block.type === 'report') {
      aiExperience = await runDailyAiExperienceReports(env, agentInstances, lowQualityLog);
    } else if (block.type === 'spare_time') {
      for (const [, agent] of agentInstances) {
        spareTime.push(await runSpareTimeForAgent(env, agent, { forceIdle: !!block.force_idle }));
      }
    } else if (block.type === 'weekly_summary') {
      weeklySummary = await generateWeeklySummary(env, yearState, yearState.current_week || 1);
      versionBumps = await checkProductVersionBumps(env, yearState, nextDay);
    }
  }

  // Daily standup only runs on days the schedule defines it (not the Saturday off day).
  let standup = null;
  if (schedule.blocks.some((b) => b.type === 'meeting' && b.meeting_type === 'daily_standup')) {
    try {
      standup = await runMeeting('daily_standup', env);
    } catch (err) {
      standup = { error: err.message };
    }
  }

  const sidePlotStarted = await maybeStartSidePlots(env, { day: nextDay, summary, cases, standup });
  const sidePlotUpdates = await advanceSidePlots(env, nextDay);

  const milestoneKey = `day_${nextDay}`;
  const milestone = yearTrackerSeed.milestones[milestoneKey] || null;
  let milestoneMeeting = null;
  if (milestone && MILESTONE_MEETINGS[milestoneKey] && !isOffDay) {
    try {
      milestoneMeeting = await runMeeting(MILESTONE_MEETINGS[milestoneKey], env);
    } catch (err) {
      milestoneMeeting = { error: err.message };
    }
  }

  const newStats = updateYearStats(yearState.stats, { summary, standup, sidePlotStarted, sidePlotUpdates });
  const isYearEnd = nextDay >= yearTrackerSeed.total_days;

  const newState = {
    simulation_start: yearState.simulation_start || new Date().toISOString(),
    current_day: isYearEnd ? 0 : nextDay,
    current_week: isYearEnd ? 0 : Math.ceil(nextDay / 7),
    current_month: isYearEnd ? 0 : Math.ceil(nextDay / 30),
    current_quarter: isYearEnd ? 0 : Math.ceil(nextDay / 91),
    stats: isYearEnd ? { ...newStats, year_number: (newStats.year_number || 1) + 1 } : newStats,
  };
  await persistYearState(env, newState);

  if (milestoneKey === 'day_365' && milestoneMeeting && !milestoneMeeting.error) {
    const yearNumber = newStats.year_number || 1;
    const promoMarkdown = renderPromotionResults(yearNumber, milestoneMeeting);
    await commitFileToRepo(
      env, REPO_NAME, `reports/promotion-results-year-${yearNumber}.md`, promoMarkdown,
      `chore(agents): year ${yearNumber} promotion results [skip ci]`
    );
  }

  const displayYearState = {
    ...yearState,
    current_day: nextDay,
    current_week: Math.ceil(nextDay / 7),
    current_month: Math.ceil(nextDay / 30),
    current_quarter: Math.ceil(nextDay / 91),
    stats: newStats,
  };
  const scheduleInfo = { schedule, dayOfWeek, batches, toolTask, aiExperience, spareTime, weeklySummary, versionBumps };
  const markdown = renderDailySummary(displayYearState, summary, standup, sidePlotStarted, sidePlotUpdates, milestone, scheduleInfo);
  const report = await commitFileToRepo(
    env, REPO_NAME, `reports/daily/day-${pad(nextDay, 3)}-summary.md`, markdown,
    `chore(agents): day ${nextDay} summary [skip ci]`
  );

  return {
    ...summary, year: newState, standup, sidePlotsStarted: sidePlotStarted, sidePlotUpdates, milestone, milestoneMeeting, report,
    schedule: { dayOfWeek, toolTask, aiExperience, spareTime, weeklySummary, versionBumps },
  };
}

/* ───────────────────── Per-block scheduled dispatcher ───────────────────── */

// Cloudflare Cron Triggers fire in UTC; daily-schedule.json's block times are
// Israel local time. IDT (UTC+3) applies roughly Mar-Oct, IST (UTC+2) the
// rest of the year. Update this constant (and wrangler.toml's cron window)
// when Israel's clocks change — see CLAUDE.md "Daily Automation" DST note.
const ISRAEL_UTC_OFFSET_HOURS = 3;

/** Converts a UTC Date to { time: "HH:MM", dayOfWeek } in Israel local time. dayOfWeek matches daily-schedule.json's week_mapping (1=Sun..7=Sat). */
function israelTimeParts(date) {
  const israel = new Date(date.getTime() + ISRAEL_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const hh = String(israel.getUTCHours()).padStart(2, '0');
  const mm = String(israel.getUTCMinutes()).padStart(2, '0');
  return { time: `${hh}:${mm}`, dayOfWeek: israel.getUTCDay() + 1 };
}

const CYCLE_STATE_KEY = 'daily-cycle-state';

async function getCycleState(env) {
  if (!env.SIM_KV) return null;
  return env.SIM_KV.get(CYCLE_STATE_KEY, 'json');
}

async function setCycleState(env, state) {
  if (!env.SIM_KV) return;
  await env.SIM_KV.put(CYCLE_STATE_KEY, JSON.stringify(state));
}

async function clearCycleState(env) {
  if (!env.SIM_KV) return;
  await env.SIM_KV.delete(CYCLE_STATE_KEY);
}

/**
 * Logs a scheduled-block failure (e.g. a Gemini 429) as a `reports` row
 * without throwing, so one bad tick can't cascade or trigger Cloudflare cron
 * retries. Filed under agent 10 (The Architect) as the simulation's
 * system/ops agent — `reports.agent_id` is NOT NULL with a FK to `agents`.
 */
async function logScheduledError(env, { israelTime, dayOfWeek, blockType, error }) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO reports (id, agent_id, type, title, content, severity) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      10,
      'incident',
      `Scheduled block error — ${blockType} @ ${israelTime} (day-of-week ${dayOfWeek})`,
      String(error?.message || error),
      'warning'
    ).run();
  } catch {
    // best-effort only — never let logging itself break the cron tick
  }
}

/**
 * Cron entry point for one Israel-time tick (called from `scheduled()` with
 * the tick's { time, dayOfWeek }). Looks up which daily-schedule.json
 * block(s), if any, are due right now; on the day's first due block it
 * starts a fresh day-in-progress "cycle" (generates + persists the day's
 * CRM cases and partitions them per daily-schedule.json), processes the due
 * block(s) with per-block error containment (`logScheduledError`, never
 * throws), persists the cycle to SIM_KV between ticks, and on the day's
 * last due block finalizes the day (`finalizeScheduledDay`) and clears the
 * cycle. Ticks with no due block (most of them, given the 30-minute cron)
 * are a cheap no-op.
 */
export async function runScheduledBlock(env, israelTime, dayOfWeek) {
  const sim = await getSimulationState(env);
  if (sim.paused) return { skipped: true, reason: 'paused' };

  const schedule = getDaySchedule(dayOfWeek);
  const dueBlocks = schedule.blocks.filter((b) => b.time === israelTime);
  if (!dueBlocks.length) return { skipped: true, reason: 'no_block_at_time', israelTime, dayOfWeek };

  const isOffDay = schedule === dailyScheduleConfig.saturday_schedule;
  const isFirstBlock = israelTime === schedule.blocks[0].time;
  const isLastBlock = israelTime === schedule.blocks[schedule.blocks.length - 1].time;

  let cycle = await getCycleState(env);
  if (isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek) {
    const yearState = await getYearState(env);
    const nextDay = (yearState.current_day || 0) + 1;

    const work = simulationConfig.WORK_DAY;
    const multiplier = sim.inspection_mode ? work.inspection_mode_multiplier : 1;
    const casesPerAgent = Math.round((simulationConfig.cases_per_day_per_agent || 20) * multiplier);

    const cases = isOffDay
      ? []
      : generateAssignedDailyBatch(dayOfWeek, { casesPerAgent, weekNumber: yearState.current_week || 1 });
    if (cases.length) await persistCrmCases(env, cases);

    cycle = {
      day: nextDay,
      dayOfWeek,
      inspection: sim.inspection_mode,
      cases,
      batches: partitionCasesByShare(cases, schedule.blocks).map((b) => ({ ...b, done: false })),
      agentStats: {},
      lowQualityLog: [],
      results: { toolTask: null, aiExperience: null, standup: null, spareTime: [], weeklySummary: null, versionBumps: [], choreRotation: null },
    };
  }

  const agentStats = new Map(Object.entries(cycle.agentStats).map(([k, v]) => [Number(k), v]));
  const agentInstances = new Map();

  // Pass includeAll=true for report/spare-time blocks so admin agents
  // (6-9) that handled zero cases still participate in daily standup
  // and file their presence in D1.
  const ensureAgentInstances = async (includeAll = false) => {
    const ids = includeAll
      ? agentsConfig.agents.map((a) => a.id)
      : Array.from(agentStats.keys());
    for (const id of ids) {
      if (!agentInstances.has(id)) {
        const agent = instantiateAgent(id, env);
        await agent.loadState();
        agentInstances.set(id, agent);
      }
    }
  };

  for (const block of dueBlocks) {
    try {
      if (block.type === 'case_batch') {
        const batch = cycle.batches.find((b) => b.block.time === block.time && b.block.label === block.label);
        if (batch && !batch.done) {
          await processCaseBatch(env, batch.cases, agentInstances, agentStats, cycle.lowQualityLog);
          batch.done = true;
        }
      } else if (block.type === 'tool_task_window') {
        cycle.results.toolTask = await maybeOpenAssetTask(env, dayOfWeek, cycle.day);
      } else if (block.type === 'report') {
        await ensureAgentInstances(true);
        cycle.results.aiExperience = await runDailyAiExperienceReports(env, agentInstances, cycle.lowQualityLog);
      } else if (block.type === 'meeting' && block.meeting_type === 'daily_standup') {
        cycle.results.standup = await runMeeting('daily_standup', env);
      } else if (block.type === 'spare_time') {
        await ensureAgentInstances(true);
        for (const [, agent] of agentInstances) {
          cycle.results.spareTime.push(await runSpareTimeForAgent(env, agent, { forceIdle: !!block.force_idle }));
        }
      } else if (block.type === 'weekly_summary') {
        const yearState = await getYearState(env);
        cycle.results.weeklySummary = await generateWeeklySummary(env, yearState, yearState.current_week || 1);
        cycle.results.versionBumps = await checkProductVersionBumps(env, yearState, cycle.day);
      } else if (block.type === 'chore_rotation') {
        // Cross-project chore rotation (Notebook-X/data-center/archive-alpha),
        // see config/chore-schedule.json + workers/chore-runner.js. Reuses
        // this existing cron tick — no wrangler.toml change. Wiring-only:
        // resolves/logs model routing, never calls a model, per the
        // 2026-07-08 session scope (TOKEN-BUDGET.md).
        cycle.results.choreRotation = await runChoreRotationSlot(env, { label: `${israelTime} chore_rotation` });
      }
    } catch (err) {
      await logScheduledError(env, { israelTime, dayOfWeek, blockType: block.type, error: err });
    }
  }

  cycle.agentStats = Object.fromEntries(agentStats);

  if (!isLastBlock) {
    await setCycleState(env, cycle);
    return { ok: true, day: cycle.day, dayOfWeek, israelTime, blocks: dueBlocks.map((b) => b.type) };
  }

  let finalize;
  try {
    finalize = await finalizeScheduledDay(env, cycle, schedule, isOffDay);
  } catch (err) {
    await logScheduledError(env, { israelTime, dayOfWeek, blockType: 'finalize', error: err });
    finalize = { error: err.message };
  }
  await clearCycleState(env);
  return { ok: true, day: cycle.day, dayOfWeek, israelTime, blocks: dueBlocks.map((b) => b.type), finalize };
}

/**
 * Day-end tail for the scheduled (per-block) path: builds the agents
 * summary from the day-in-progress `cycle`, advances side plots/year stats,
 * runs the day-365 promotion meeting if due, and writes the daily summary
 * report. Mirrors the tail of `runWorkDayCycle()`, but reads cases/batches/
 * agentStats/block results from `cycle` (accumulated tick by tick by
 * `runScheduledBlock`) instead of computing everything in one pass.
 */
async function finalizeScheduledDay(env, cycle, schedule, isOffDay) {
  const yearState = await getYearState(env);
  const nextDay = cycle.day;
  const dayOfWeek = cycle.dayOfWeek;

  const agentInstances = new Map();
  const summary = { day: nextDay, dayOfWeek, inspection: cycle.inspection, agents: [] };

  for (const [agentIdStr, stats] of Object.entries(cycle.agentStats)) {
    const agentId = Number(agentIdStr);
    const agent = instantiateAgent(agentId, env);
    await agent.loadState();
    agentInstances.set(agentId, agent);

    if (!agent.isAngry) {
      const adj = await getModelUsageAdjustment(env, agentId);
      if (adj.delta !== 0 && typeof agent.config.model_usage_rate === 'number') {
        const next = Math.min(1, Math.max(0, agent.config.model_usage_rate + adj.delta));
        await applyConfigOverride(env, agentId, { model_usage_rate: next });
      }
    }

    summary.agents.push({
      agentId,
      caseCount: stats.caseCount,
      handled: stats.handled,
      escalations: stats.escalations,
      comparisons: stats.comparisons,
      advancedCases: stats.advancedCases,
      mood: agent.mood,
      irritation: agent.irritation,
      isHappy: agent.isHappy,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
    });
  }

  const { standup, toolTask, aiExperience, spareTime, weeklySummary, versionBumps, choreRotation } = cycle.results;

  const sidePlotStarted = await maybeStartSidePlots(env, { day: nextDay, summary, cases: cycle.cases, standup });
  const sidePlotUpdates = await advanceSidePlots(env, nextDay);

  const milestoneKey = `day_${nextDay}`;
  const milestone = yearTrackerSeed.milestones[milestoneKey] || null;
  let milestoneMeeting = null;
  if (milestone && MILESTONE_MEETINGS[milestoneKey] && !isOffDay) {
    try {
      milestoneMeeting = await runMeeting(MILESTONE_MEETINGS[milestoneKey], env);
    } catch (err) {
      milestoneMeeting = { error: err.message };
    }
  }

  const newStats = updateYearStats(yearState.stats, { summary, standup, sidePlotStarted, sidePlotUpdates });
  const isYearEnd = nextDay >= yearTrackerSeed.total_days;

  const newState = {
    simulation_start: yearState.simulation_start || new Date().toISOString(),
    current_day: isYearEnd ? 0 : nextDay,
    current_week: isYearEnd ? 0 : Math.ceil(nextDay / 7),
    current_month: isYearEnd ? 0 : Math.ceil(nextDay / 30),
    current_quarter: isYearEnd ? 0 : Math.ceil(nextDay / 91),
    stats: isYearEnd ? { ...newStats, year_number: (newStats.year_number || 1) + 1 } : newStats,
  };
  await persistYearState(env, newState);

  if (milestoneKey === 'day_365' && milestoneMeeting && !milestoneMeeting.error) {
    const yearNumber = newStats.year_number || 1;
    const promoMarkdown = renderPromotionResults(yearNumber, milestoneMeeting);
    await commitFileToRepo(
      env, REPO_NAME, `reports/promotion-results-year-${yearNumber}.md`, promoMarkdown,
      `chore(agents): year ${yearNumber} promotion results [skip ci]`
    );
  }

  const displayYearState = {
    ...yearState,
    current_day: nextDay,
    current_week: Math.ceil(nextDay / 7),
    current_month: Math.ceil(nextDay / 30),
    current_quarter: Math.ceil(nextDay / 91),
    stats: newStats,
  };
  const scheduleInfo = { schedule, dayOfWeek, batches: cycle.batches, toolTask, aiExperience, spareTime, weeklySummary, versionBumps, choreRotation };
  const markdown = renderDailySummary(displayYearState, summary, standup, sidePlotStarted, sidePlotUpdates, milestone, scheduleInfo);
  const report = await commitFileToRepo(
    env, REPO_NAME, `reports/daily/day-${pad(nextDay, 3)}-summary.md`, markdown,
    `chore(agents): day ${nextDay} summary [skip ci]`
  );

  return {
    ...summary, year: newState, standup, sidePlotsStarted: sidePlotStarted, sidePlotUpdates, milestone, milestoneMeeting, report,
    schedule: { dayOfWeek, toolTask, aiExperience, spareTime, weeklySummary, versionBumps },
  };
}

/* ─────────────────────────── Weekly reset cycle ─────────────────────────── */

async function getWeeklyCasesHandled(env, agentId) {
  if (!env.DB) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cases_handled), 0) AS total FROM agent_sessions WHERE agent_id = ? AND started_at >= ?`
  ).bind(agentId, since).first();
  return row?.total || 0;
}

async function writeWeeklyAnalytics(env, summary) {
  if (!env.DB) return;
  const stmt = env.DB.prepare(
    `INSERT INTO weekly_analytics (id, week_start, agent_id, total_cases, cases_solved, avg_mood)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(
    summary.agents.map((a) => stmt.bind(crypto.randomUUID(), summary.week_start, a.agentId, a.weeklyCases, a.weeklyCases, a.moodAfter))
  );
}

/**
 * One simulated work week:
 *  1-2. weekly report + partial mood reset for every agent
 *  3. Agent 2 bonus-day check -> bonus_day_drama side plot
 *  4. weekly meeting + a rotating per-agent (1-4) audit_session
 *  5. a low-mood agent (1-4) triggers a pip_session + pip_drama side plot
 *  6. weekly_analytics aggregate
 */
export async function runWeeklyResetCycle(env) {
  const yearState = await getYearState(env);
  const summary = { week_start: new Date().toISOString(), agents: [] };

  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();

    const moodBefore = agent.mood;
    const weeklyCases = await getWeeklyCasesHandled(env, config.id);

    await agent.fileWeeklyReport(
      `Weekly report for ${agent.name}: ${weeklyCases} cases handled, mood ${moodBefore} -> regressing to mean, irritation ${agent.irritation}/5.`
    );

    if (typeof agent.checkWeeklyBonus === 'function') {
      const target = simulationConfig.WORK_DAY.cases_per_day_min * 5;
      const bonus = await agent.checkWeeklyBonus(weeklyCases, target);
      if (bonus && config.id === 2) {
        await startSidePlot(env, 'bonus_day_drama', [2, 1, 3, 4], yearState.current_day || 1);
      }
    }

    await agent.resetWeeklyState();
    summary.agents.push({ agentId: config.id, weeklyCases, moodBefore, moodAfter: agent.mood });
  }

  await writeWeeklyAnalytics(env, summary);

  let weekly = null;
  try {
    weekly = await runMeeting('weekly', env);
  } catch (err) {
    weekly = { error: err.message };
  }

  const auditTarget = ((yearState.current_week || 1) - 1) % 4 + 1;
  let audit = null;
  try {
    audit = await runMeeting('audit_session', env, { auditedAgentId: auditTarget });
  } catch (err) {
    audit = { error: err.message };
  }

  let pip = null;
  const lowMoodAgent = summary.agents.find((a) => a.agentId >= 1 && a.agentId <= 4 && a.moodAfter <= 20);
  if (lowMoodAgent) {
    try {
      pip = await runMeeting('pip_session', env, { targetAgentId: lowMoodAgent.agentId });
      await startSidePlot(env, 'pip_drama', [7, lowMoodAgent.agentId], yearState.current_day || 1);
    } catch (err) {
      pip = { error: err.message };
    }
  }

  return { ...summary, weekly, audit, pip };
}

/* ────────────────────────────────── HTTP API ───────────────────────────── */

export default {
  /**
   * Cron Trigger (configured in this Worker's wrangler.toml):
   *   "*\/30 5-13 * * *" -> every 30 min, 05:00-13:30 UTC = 08:00-16:30 IDT.
   * Each tick converts event.scheduledTime to Israel local time and calls
   * runScheduledBlock(), which is a no-op unless daily-schedule.json has a
   * block at that exact time for that day-of-week. See "Daily Automation"
   * in CLAUDE.md.
   */
  async scheduled(event, env, ctx) {
    const { time, dayOfWeek } = israelTimeParts(new Date(event.scheduledTime));
    ctx.waitUntil(runScheduledBlock(env, time, dayOfWeek));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // All /api/agents/* endpoints require the admin token configured as a
    // Worker secret (env.ADMIN_TOKEN). The browser never embeds this value
    // — the admin types it into the dashboard once and it's sent back as
    // X-Admin-Token, so the real check always happens server-side here.
    if (url.pathname.startsWith('/api/agents/')) {
      const token = request.headers.get('X-Admin-Token') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401, origin);
      }
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/agents/status') {
        return json(await getAllAgentStatuses(env), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/sessions') {
        const limit = Number(url.searchParams.get('limit')) || 50;
        return json(await getRecentInteractions(env, limit), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/reports') {
        return json(await getReports(env, url.searchParams.get('type')), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/suggestions') {
        return json(await getSuggestions(env), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/year') {
        return json(await getYearState(env), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/side-plots') {
        return json(await getSidePlots(env, url.searchParams.get('status')), 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/run') {
        // Manual single-case trigger for local testing: { agentId, caseData, opts }
        const body = await request.json();
        const result = await runAgentSession(body.agentId, body.caseData, env, body.opts || {});
        return json(result, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/test-gemini') {
        // Direct queryGemini() smoke test: { agentId, prompt, opts: { forceFallback } }
        const body = await request.json();
        const result = await runGeminiTest(body.agentId, body.prompt, env, body.opts || {});
        return json(result, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/trigger') {
        // Unified admin trigger: { type: 'day'|'meeting'|'inspection'|'week_reset', ...opts }
        const body = await request.json();
        let result;
        switch (body.type) {
          case 'day':
            result = await runWorkDayCycle(env);
            break;
          case 'meeting': {
            if (!body.meetingType || !MEETING_TYPES[body.meetingType]) {
              return json({ error: 'invalid_meeting_type' }, 400, origin);
            }
            try {
              result = await runMeeting(body.meetingType, env, body.opts || {});
            } catch (err) {
              return json({ error: 'meeting_error', message: err.message }, 400, origin);
            }
            break;
          }
          case 'inspection':
            result = await updateSimulationState(env, { inspection_mode: !!body.active });
            break;
          case 'week_reset':
            result = await runWeeklyResetCycle(env);
            break;
          default:
            return json({ error: 'invalid_trigger_type' }, 400, origin);
        }
        return json({ ok: true, type: body.type, result }, 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/simulation') {
        return json(await getSimulationState(env), 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/simulation') {
        const body = await request.json();
        return json(await updateSimulationState(env, body), 200, origin);
      }
    } catch (err) {
      return json({ error: 'general', message: err.message }, 500, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  },
};
