/**
 * Data Center — AI Agent Simulation — Q&A engine.
 *
 * Replaces workers/crm-engine.js (deleted 2026-07-18, Q&A-engine rebuild — see
 * CLAUDE.md and TOKEN-BUDGET.md for the full writeup). The Netvill-CRM model
 * (fictional clients, severity/is_unique_client/requires_it_chief escalation
 * routing, "compare alternatives" external-source checks) is retired outright,
 * not adapted — none of it fit the new purpose (agents ask real questions to
 * Claude/Gemini and evaluate the answer, they don't role-play support tickets).
 *
 * Question shape (persisted to the `cases` table — column names kept from the
 * old schema to avoid a breaking migration; see database/schema.sql's Part 11
 * note for the mapping):
 *   { id, title, platform, category, difficulty, description, project,
 *     kb_slug, assigned_to, status }
 *
 * Volume is NOT a fixed per-agent quota anymore (the old CASES_PER_AGENT=20).
 * generateAssignedDailyBatch() takes an explicit `maxTotalQuestions`, computed
 * by the caller (agent-runner.js) from the token economy's remaining budget at
 * the time each schedule block runs — see config/token-economy.json's
 * `shared_claude_budget` and `notebook_x_gemini_pacing` blocks, and
 * agent-runner.js's computeQuestionVolumeForBlock().
 */

import { TOPIC_POOL } from './qa-topics.js';
import agentsConfig from '../config/agents-config.json';

const WEEK_DAYS = 7;

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedPick(weighted, weightKey = 'weight') {
  const total = weighted.reduce((sum, w) => sum + w[weightKey], 0);
  let roll = Math.random() * total;
  for (const w of weighted) {
    if (roll < w[weightKey]) return w;
    roll -= w[weightKey];
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

function buildQuestionId(y, w, dayIndex, idNum) {
  return `qa-${y}-w${pad(w, 2)}-d${dayIndex}-${pad(idNum, 3)}`;
}

/**
 * Agents active in the daily Q&A flow: status 'active' or 'specified' in
 * agents-config.json, minus Agent 10 (The Architect) — dormant per this
 * session's rebuild, reserved for owner-directed special tasks only. This is
 * the SAME exclusion the old crm-engine.js applied, kept unchanged — the
 * Architect was never in the routine case/question flow either way.
 */
export function getActiveQaAgents() {
  return agentsConfig.agents.filter((a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10);
}

/** Back-compat alias — agent-runner.js's public API name during the transition. */
export const getActiveCaseAgents = getActiveQaAgents;

/**
 * Picks a topic template for a given agent, biased by that agent's
 * `topic_affinity` (config/agents-config.json — see this session's addition
 * for all 10 active personas). Per Step 3 of the rebuild: persona
 * differentiation lives in WHICH topics an agent gravitates toward, not in a
 * different task type — every agent still just asks-and-evaluates.
 *
 * Affinity match doubles an entry's effective pool weight (not an exclusive
 * filter) so an agent with a topic_affinity still occasionally asks outside
 * it — matching how a real specialist's questions aren't 100% on-topic.
 */
function selectTopicForAgent(agentId) {
  const agentConfig = agentsConfig.agents.find((a) => a.id === agentId);
  const affinity = agentConfig?.topic_affinity || [];

  if (!affinity.length) {
    return weightedPick(TOPIC_POOL.map((t) => ({ topic: t, weight: t.poolWeight })), 'weight').topic;
  }

  const weighted = TOPIC_POOL.map((t) => {
    const matches = affinity.includes(t.platform) || affinity.includes(t.category);
    return { topic: t, weight: matches ? t.poolWeight * 2 : t.poolWeight };
  });
  return weightedPick(weighted, 'weight').topic;
}

function buildQuestion(template, difficultyOverride, id, agentId) {
  return {
    id,
    title: template.title,
    category: template.category,
    platform: template.platform,
    difficulty: difficultyOverride || template.difficulty,
    description: template.description,
    project: template.project,
    kb_slug: template.kbSlug || null,
    assigned_to: agentId,
    status: 'open',
  };
}

/**
 * Generates `maxTotalQuestions` questions, round-robin assigned across active
 * agents (getActiveQaAgents()) so volume spreads evenly rather than
 * front-loading whichever agent is processed first — this matters more now
 * than under the old fixed-quota model because maxTotalQuestions varies
 * block to block with remaining token budget (see agent-runner.js
 * computeQuestionVolumeForBlock()).
 *
 * @param {number} dayIndex - 1-7, the simulated work day within the week
 * @param {object} opts
 * @param {number} opts.maxTotalQuestions - budget-driven cap for THIS batch
 *   (not a whole-day total — daily-schedule.json's case_batch blocks each
 *   call this separately across the day).
 * @param {number} [opts.weekNumber]
 * @param {number} [opts.year]
 * @returns {Array<object>} questions with `assigned_to` already populated
 */
export function generateAssignedDailyBatch(dayIndex, opts = {}) {
  const now = new Date();
  const weekNumber = opts.weekNumber ?? isoWeekNumber(now);
  const year = opts.year ?? now.getFullYear();
  const maxTotalQuestions = Math.max(0, opts.maxTotalQuestions ?? 0);

  const activeAgents = getActiveQaAgents();
  if (!activeAgents.length || maxTotalQuestions === 0) return [];

  const questions = [];
  let idNum = (opts.startIndex ?? 1);
  for (let i = 0; i < maxTotalQuestions; i++) {
    const agent = activeAgents[i % activeAgents.length];
    const template = selectTopicForAgent(agent.id);
    const id = buildQuestionId(year, weekNumber, dayIndex, idNum);
    questions.push(buildQuestion(template, null, id, agent.id));
    idNum += 1;
  }
  return questions;
}

/**
 * Generates a full simulated work week's questions (7 days), for any ad-hoc
 * tooling that still wants a whole-week shape. Not used by the live
 * per-block cron path (which calls generateAssignedDailyBatch() per block
 * with a budget-derived count) — kept for parity with the old
 * generateWeeklyCaseBatches().
 */
export function generateWeeklyQuestionBatches(questionsPerDay, opts = {}) {
  const batches = [];
  for (let day = 1; day <= WEEK_DAYS; day++) {
    batches.push(generateAssignedDailyBatch(day, { ...opts, maxTotalQuestions: questionsPerDay }));
  }
  return batches;
}

/* ───────────────────────────── Persistence ────────────────────────────── */

/**
 * Inserts a batch of questions into the `cases` table. Only writes the
 * columns the new Q&A model actually uses (see database/schema.sql Part 11)
 * — client_name/severity/is_unique_client/requires_it_chief are left NULL/
 * default, not populated (Netvill-CRM columns, retired, not migrated away to
 * avoid a destructive schema change against a live D1 instance).
 */
export async function persistQuestions(env, questions) {
  if (!env.DB || questions.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO cases
       (id, title, platform, difficulty, category, description, assigned_to, status, project, kb_slug)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  );
  await env.DB.batch(
    questions.map((q) =>
      stmt.bind(
        q.id,
        q.title,
        q.platform,
        q.difficulty,
        q.category,
        q.description,
        q.assigned_to ?? null,
        q.project,
        q.kb_slug ?? null
      )
    )
  );
}

/** Back-compat alias during the transition (agent-runner.js import name). */
export const persistCrmCases = persistQuestions;
