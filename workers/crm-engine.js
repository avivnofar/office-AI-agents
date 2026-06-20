/**
 * Data Center — AI Agent Simulation — CRM engine.
 *
 * Generates Netvill-style IT support cases for the simulated office's
 * client base, assigns them to agents per their case_focus / clearance,
 * and tracks "compare alternatives" events (an agent finding a better/worse
 * answer outside the app) which feed back into that agent's effective
 * model_usage_rate over time.
 *
 * Volume: 20 cases per active agent per day (CASES_PER_AGENT) — 10 active
 * agents (all but Agent 10/The Architect) x 20 = 200 cases/day, generated
 * by agent-runner.js's daily cycle. Sized so Claude gets meaningful,
 * distributed usage across all agents per config/token-economy.json's
 * claude_cap_rationale (model training is the primary goal).
 *
 * Case shape (persisted to the `cases` table — see schema.sql Part 10 for
 * the added client_name/severity/is_unique_client/requires_it_chief columns):
 *   { id, title, client_name, severity, category, description, assigned_to,
 *     difficulty, platform, is_unique_client, requires_it_chief, status }
 *
 * Status: DRAFT (Phase 1 foundation, Phase 2 CRM system).
 */

import { CASE_POOL } from './case-generator.js';
import agentsConfig from '../config/agents-config.json';

/** Netvill-style client roster. "unique" clients are wealthy/VIP accounts. */
export const CLIENT_POOL = [
  { name: 'Northgate Logistics', tier: 'standard', industry: 'logistics' },
  { name: 'Solaris Biotech', tier: 'standard', industry: 'biotech' },
  { name: 'Meridian Law Group', tier: 'standard', industry: 'legal' },
  { name: 'Pinegrove School District', tier: 'standard', industry: 'education' },
  { name: 'Cobalt Retail Co.', tier: 'standard', industry: 'retail' },
  { name: 'BrightPath Insurance', tier: 'standard', industry: 'insurance' },
  { name: 'Quarry Manufacturing', tier: 'standard', industry: 'manufacturing' },
  { name: 'Lumen Media Group', tier: 'standard', industry: 'media' },
  { name: 'Ridgeline Construction', tier: 'standard', industry: 'construction' },
  { name: 'Falcon Freight', tier: 'standard', industry: 'logistics' },
  { name: 'Nimbus Cloud Startups', tier: 'standard', industry: 'tech' },
  { name: 'Cedarwood Hotels', tier: 'standard', industry: 'hospitality' },
  { name: 'Vanta Capital Partners', tier: 'unique', industry: 'finance' },
  { name: 'Aurora Medical Center', tier: 'unique', industry: 'healthcare' },
  { name: 'Heritage Bank & Trust', tier: 'unique', industry: 'finance' },
];

/** Severity distribution weights (sum need not be 1 — relative weights). */
const SEVERITY_WEIGHTS = [
  { severity: 'low', weight: 35 },
  { severity: 'medium', weight: 40 },
  { severity: 'high', weight: 18 },
  { severity: 'critical', weight: 7 },
];

/**
 * Platform distribution weights: 1COM (30%), MirtaPBX (20%), general IT (50%).
 * Matches config/simulation-config.json case_distribution and the
 * knowledge-base expansion in data/1com.json + data/mirtapbx.json.
 */
const PLATFORM_WEIGHTS = [
  { platform: '1com',    weight: 30 },
  { platform: 'mirtapbx', weight: 20 },
  { platform: 'general', weight: 50 },
];

/** Picks a case template using weighted platform selection. */
function selectCaseTemplate() {
  const platformPick = weightedPick(PLATFORM_WEIGHTS).platform;
  const subset = platformPick === 'general'
    ? CASE_POOL.filter((t) => t.platform !== '1com' && t.platform !== 'mirtapbx')
    : CASE_POOL.filter((t) => t.platform === platformPick);
  return randomItem(subset.length ? subset : CASE_POOL);
}

/**
 * Cases are generated PER ACTIVE AGENT (not as one flat daily pool) so
 * Claude gets meaningful, distributed usage across all agents per
 * config/token-economy.json's claude_cap_rationale. "Active" here means
 * status 'active' or 'specified' in agents-config.json, i.e. all 11
 * agents, minus Agent 10 (The Architect) — per
 * config/token-economy.json's architect_model: "human+claude-code",
 * the Architect never calls a model for routine cases and is handled
 * separately (agent-runner.js processArchitectCaseBatch()).
 */
export const CASES_PER_AGENT = 20;

export function getActiveCaseAgents() {
  return agentsConfig.agents.filter((a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10);
}

const WEEK_DAYS = 7;

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedPick(weighted) {
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * total;
  for (const w of weighted) {
    if (roll < w.weight) return w;
    roll -= w.weight;
  }
  return weighted[weighted.length - 1];
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function buildCaseId(y, w, dayIndex, idNum) {
  return `crm-${y}-w${pad(w, 2)}-d${dayIndex}-${pad(idNum, 3)}`;
}

function buildCase(template, client, severity, id) {
  const isUniqueClient = client.tier === 'unique';
  // Hard/critical cases may require the IT Chief — includes VoIP platforms
  // because 1COM/MirtaPBX cluster and integration issues are senior work.
  const requiresItChief =
    severity === 'critical' ||
    (severity === 'high' && (
      ['network', 'firewall', 'routing'].includes(template.category) ||
      ['1com', 'mirtapbx'].includes(template.platform)
    ) && Math.random() < 0.5);

  return {
    id,
    title: template.title,
    client_name: client.name,
    severity,
    category: template.category,
    platform: template.platform,
    difficulty: template.difficulty,
    description: `[${client.name}] ${template.description}`,
    is_unique_client: isUniqueClient,
    requires_it_chief: requiresItChief,
    status: 'open',
  };
}

const LEGACY_FLAT_VOLUME = 50;

/**
 * Generates one simulated work day's worth of CRM cases as a flat,
 * unassigned pool (legacy path — kept for generateWeeklyCaseBatches() and
 * any ad-hoc tooling). The live simulation uses
 * generateAssignedDailyBatch() instead, which generates per-agent so every
 * active agent gets exactly CASES_PER_AGENT cases.
 * @param {number} dayIndex - 1-7, the simulated work day within the week
 * @param {object} [opts]
 * @param {number} [opts.count] - override LEGACY_FLAT_VOLUME
 * @param {number} [opts.weekNumber]
 * @param {number} [opts.year]
 */
export function generateDailyCaseBatch(dayIndex, opts = {}) {
  const now = new Date();
  const w = opts.weekNumber ?? isoWeekNumber(now);
  const y = opts.year ?? now.getFullYear();
  const count = opts.count ?? LEGACY_FLAT_VOLUME;

  const cases = [];
  for (let i = 1; i <= count; i++) {
    const template = selectCaseTemplate();
    const client = randomItem(CLIENT_POOL);
    const { severity } = weightedPick(SEVERITY_WEIGHTS);
    cases.push(buildCase(template, client, severity, buildCaseId(y, w, dayIndex, i)));
  }
  return cases;
}

/**
 * Generates a full simulated work week (7 days x ~50 cases = ~350).
 * Legacy flat-pool path — see generateDailyCaseBatch().
 * @param {object} [opts] - forwarded to generateDailyCaseBatch per day
 * @returns {Array<Array<object>>} one array of cases per day
 */
export function generateWeeklyCaseBatches(opts = {}) {
  const batches = [];
  for (let day = 1; day <= WEEK_DAYS; day++) {
    batches.push(generateDailyCaseBatch(day, opts));
  }
  return batches;
}

/* ───────────────────────────── Assignment ─────────────────────────────── */

/** Per-agent difficulty weighting — biases case selection toward the kind
 * of work each role actually does, while still drawing from the same
 * CASE_POOL/PLATFORM_WEIGHTS templates used everywhere else. Agents not
 * listed here use the unbiased selectCaseTemplate(). */
const DIFFICULTY_BIAS_BY_AGENT = {
  4: { beginner: 50, intermediate: 40, advanced: 10 }, // Trainee: building confidence
  5: { beginner: 10, intermediate: 30, advanced: 60 }, // IT Chief: hard cases + escalations
};

/** Like selectCaseTemplate(), but applies an agent's DIFFICULTY_BIAS_BY_AGENT entry if one exists. */
function selectCaseTemplateForAgent(agentId) {
  const bias = DIFFICULTY_BIAS_BY_AGENT[agentId];
  if (!bias) return selectCaseTemplate();

  const platformPick = weightedPick(PLATFORM_WEIGHTS).platform;
  const platformSubset = platformPick === 'general'
    ? CASE_POOL.filter((t) => t.platform !== '1com' && t.platform !== 'mirtapbx')
    : CASE_POOL.filter((t) => t.platform === platformPick);
  const pool = platformSubset.length ? platformSubset : CASE_POOL;

  const { difficulty } = weightedPick(
    Object.entries(bias).map(([d, weight]) => ({ difficulty: d, weight }))
  );
  const filtered = pool.filter((t) => t.difficulty === difficulty);
  return randomItem(filtered.length ? filtered : pool);
}

/**
 * Generates one case pre-assigned to `agentId`. Case content (template,
 * client, severity) is drawn from the same pools as the legacy path, with
 * difficulty biased per DIFFICULTY_BIAS_BY_AGENT and a slice of Agent 11's
 * (CEO) cases forced to unique/VIP clients per its
 * unique_client_cases (~20%) config.
 */
function generateCaseForAgent(agentId, dayIndex, idNum, ctx) {
  const template = selectCaseTemplateForAgent(agentId);
  const client = agentId === 11 && Math.random() < 0.2
    ? randomItem(CLIENT_POOL.filter((c) => c.tier === 'unique'))
    : randomItem(CLIENT_POOL);
  const { severity } = weightedPick(SEVERITY_WEIGHTS);
  const id = buildCaseId(ctx.year, ctx.weekNumber, dayIndex, idNum);
  return { ...buildCase(template, client, severity, id), assigned_to: agentId };
}

/**
 * Legacy random-routing helper — no longer used by
 * generateAssignedDailyBatch() (cases are now pre-assigned per agent at
 * generation time, see generateCaseForAgent()), but kept for any ad-hoc
 * reassignment/testing needs.
 * @param {object} caseObj - a case from generateDailyCaseBatch
 * @returns {number} agent id (1-11)
 */
export function assignCase(caseObj) {
  if (caseObj.requires_it_chief) {
    return caseObj.severity === 'critical' && Math.random() < 0.25 ? 10 : 5;
  }
  if (caseObj.is_unique_client) {
    return Math.random() < 0.4 ? 11 : 5;
  }
  if (caseObj.difficulty === 'beginner' && Math.random() < 0.4) return 4;
  if (caseObj.difficulty === 'intermediate' && Math.random() < 0.2) return 4;
  if (caseObj.difficulty === 'advanced' && Math.random() < 0.1) return 10;
  const adminRoll = Math.random();
  if (adminRoll < 0.05) return 6;
  if (adminRoll < 0.10) return 7;
  if (adminRoll < 0.15) return 8;
  if (adminRoll < 0.20) return 9;
  return randomItem([1, 2, 3]);
}

/**
 * Generates one simulated work day's CRM cases, CASES_PER_AGENT (20) per
 * active agent (status 'active' or 'specified' in agents-config.json,
 * excluding Agent 10/The Architect — see getActiveCaseAgents()). Each
 * case is generated already assigned to its agent (generateCaseForAgent()),
 * so every active agent gets exactly casesPerAgent cases per day —
 * 10 agents x 20 = 200 cases/day by default.
 * @param {number} dayIndex - 1-7, the simulated work day within the week
 * @param {object} [opts]
 * @param {number} [opts.casesPerAgent] - override CASES_PER_AGENT (e.g. doubled for inspection_mode)
 * @param {number} [opts.weekNumber]
 * @param {number} [opts.year]
 * @returns {Array<object>} cases with `assigned_to` already populated
 */
export function generateAssignedDailyBatch(dayIndex, opts = {}) {
  const now = new Date();
  const ctx = {
    weekNumber: opts.weekNumber ?? isoWeekNumber(now),
    year: opts.year ?? now.getFullYear(),
  };
  const casesPerAgent = opts.casesPerAgent ?? CASES_PER_AGENT;
  const activeAgents = getActiveCaseAgents();

  const cases = [];
  let idNum = 1;
  for (const agent of activeAgents) {
    for (let i = 0; i < casesPerAgent; i++) {
      cases.push(generateCaseForAgent(agent.id, dayIndex, idNum, ctx));
      idNum += 1;
    }
  }
  return cases;
}

/* ───────────────────────────── Persistence ────────────────────────────── */

/**
 * Inserts a batch of CRM cases into the `cases` table, including the
 * client_name/severity/is_unique_client/requires_it_chief columns added
 * in schema.sql Part 10.
 */
export async function persistCrmCases(env, cases) {
  if (!env.DB || cases.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO cases
       (id, title, platform, difficulty, category, description, assigned_to, status, client_name, severity, is_unique_client, requires_it_chief)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  );
  await env.DB.batch(
    cases.map((c) =>
      stmt.bind(
        c.id,
        c.title,
        c.platform,
        c.difficulty,
        c.category,
        c.description,
        c.assigned_to ?? null,
        c.client_name,
        c.severity,
        c.is_unique_client ? 1 : 0,
        c.requires_it_chief ? 1 : 0
      )
    )
  );
}

/* ─────────────────────────── Compare alternatives ──────────────────────── */

/**
 * Records a "compare alternatives" event: an agent (typically Agent 2, The
 * Productive — see its FOUND-OUTSIDE PATTERN behavioral rule) compared
 * Claude's answer against an externally-found answer for the same case.
 *
 * Stored as an `interactions` row (type='compare_alternatives') so it
 * shows up in the existing session feed without new schema.
 *
 * @param {object} env
 * @param {object} opts
 * @param {number} opts.agentId
 * @param {string} [opts.sessionId] - current session id, if any
 * @param {string} opts.caseId
 * @param {boolean} opts.claudeWasBetter - true if Claude's answer won the comparison
 * @param {string} [opts.details] - short free-text note (mock report summary, etc.)
 */
export async function recordCompareAlternatives(env, { agentId, sessionId, caseId, claudeWasBetter, details }) {
  if (!env.DB) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO interactions
       (id, session_id, agent_id, timestamp, type, query, response_summary, state_change)
     VALUES (?, ?, ?, ?, 'compare_alternatives', ?, ?, ?)`
  ).bind(
    id,
    sessionId || 'no-session',
    agentId,
    new Date().toISOString(),
    caseId,
    details || '',
    claudeWasBetter ? 'claude_better' : 'external_better'
  ).run().catch(() => {});
  return id;
}

/**
 * Computes a model_usage_rate adjustment for an agent based on the
 * outcome history of its recent "compare alternatives" events.
 *
 * - If Claude wins most recent comparisons (>= 70%), nudge usage rate up
 *   (the agent is learning to trust the app).
 * - If Claude loses most recent comparisons (<= 30%), nudge usage rate
 *   down (the agent is learning the app is often not worth checking).
 * - Otherwise, no adjustment.
 *
 * The returned delta is meant to be added to the agent's
 * `model_usage_rate` (clamped to [0, 1] by the caller) and/or written to
 * `configOverrides.model_usage_rate_delta` via meeting-engine.js's
 * durable-override mechanism.
 *
 * @param {object} env
 * @param {number} agentId
 * @param {number} [sampleSize=20] - how many recent events to consider
 * @returns {Promise<{ delta: number, sample: number, claudeWinRate: number|null }>}
 */
export async function getModelUsageAdjustment(env, agentId, sampleSize = 20) {
  if (!env.DB) return { delta: 0, sample: 0, claudeWinRate: null };

  const { results } = await env.DB.prepare(
    `SELECT state_change FROM interactions
     WHERE agent_id = ? AND type = 'compare_alternatives'
     ORDER BY timestamp DESC LIMIT ?`
  ).bind(agentId, sampleSize).all();

  if (!results.length) return { delta: 0, sample: 0, claudeWinRate: null };

  const wins = results.filter((r) => r.state_change === 'claude_better').length;
  const claudeWinRate = wins / results.length;

  let delta = 0;
  if (results.length >= 5) {
    if (claudeWinRate >= 0.7) delta = 0.05;
    else if (claudeWinRate <= 0.3) delta = -0.05;
  }

  return { delta, sample: results.length, claudeWinRate };
}
