/**
 * Model selection + Claude budget tracking for the TODO.md-driven chore
 * automation (Notebook-X / data-center / archive-alpha rotation — see
 * config/daily-schedule.json's night sweep and config/token-economy.json's
 * `chore_automation` block). This is a SEPARATE economy from the 11-agent
 * office-simulation's per-day Claude cap (agents/agent-base.js
 * interactWithApp() / tokenEconomy.claude_daily_cap) — the two do not share
 * state or budget.
 */

import tokenEconomy from '../config/token-economy.json';

const CHORE = tokenEconomy.chore_automation;

// Current Sonnet 5 intro pricing. Per config/token-economy.json
// chore_automation.claude_pricing_note: this changes to $3/M input /
// $15/M output after 2026-08-31 — verify the real published price when
// that date arrives rather than trusting this estimate blindly.
const PRICING_CHANGE_DATE = '2026-08-31';
const CLAUDE_PRICING = {
  before: { inputPerMillion: 2, outputPerMillion: 10 },
  after: { inputPerMillion: 3, outputPerMillion: 15 },
};

function currentClaudePricing(asOf = new Date()) {
  return asOf.toISOString().slice(0, 10) > PRICING_CHANGE_DATE ? CLAUDE_PRICING.after : CLAUDE_PRICING.before;
}

/** Estimated USD cost for a Claude call at current (date-aware) pricing. */
export function estimateClaudeCostUsd(inputTokens, outputTokens, asOf = new Date()) {
  const pricing = currentClaudePricing(asOf);
  return (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}

const BUDGET_TABLE_SQL = `CREATE TABLE IF NOT EXISTS claude_budget_usage (
  month TEXT PRIMARY KEY,
  spent_usd REAL DEFAULT 0,
  call_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

function currentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // 'YYYY-MM'
}

/**
 * Reads this month's chore-automation Claude spend against the shared
 * $4.50/mo soft cap (config/token-economy.json chore_automation.claude_budget_usd_per_month).
 * No-ops (reports $0 spent, allowed) if env.DB isn't available.
 */
export async function getClaudeBudgetStatus(env, { asOf = new Date() } = {}) {
  const capUsd = CHORE.claude_budget_usd_per_month;
  const month = currentMonthKey(asOf);

  if (!env?.DB) {
    console.warn('[model-router] No D1 binding — Claude chore-budget tracking skipped (treated as $0 spent).');
    return { month, spentUsd: 0, capUsd, remainingUsd: capUsd, overBudget: false };
  }

  await env.DB.prepare(BUDGET_TABLE_SQL).run();
  const row = await env.DB.prepare('SELECT spent_usd, call_count FROM claude_budget_usage WHERE month = ?').bind(month).first();
  const spentUsd = row?.spent_usd ?? 0;
  return { month, spentUsd, capUsd, remainingUsd: Math.max(0, capUsd - spentUsd), overBudget: spentUsd >= capUsd };
}

/** Records a chore-automation Claude call's estimated cost against this month's soft cap. No-ops without env.DB. */
export async function recordClaudeSpend(env, { inputTokens, outputTokens, asOf = new Date() }) {
  if (!env?.DB) return { recorded: false, reason: 'no DB binding' };

  const month = currentMonthKey(asOf);
  const costUsd = estimateClaudeCostUsd(inputTokens, outputTokens, asOf);

  await env.DB.prepare(BUDGET_TABLE_SQL).run();
  await env.DB.prepare(
    `INSERT INTO claude_budget_usage (month, spent_usd, call_count, updated_at)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(month) DO UPDATE SET
       spent_usd = spent_usd + excluded.spent_usd,
       call_count = call_count + 1,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(month, costUsd).run();

  return { recorded: true, month, costUsd };
}

/**
 * Picks which model handles a chore-automation task.
 *
 * @param {object} params
 * @param {string} params.projectKey - 'notebook-x' | 'data-center' | 'archive-alpha' | ...
 * @param {'easy'|'content'|'code'|'approval'} params.taskType
 * @param {boolean} [params.requiresHighQuality] - true when task complexity/quality
 *   genuinely demands Claude (Notebook-X override trigger).
 * @param {boolean} [params.overBudget] - result of getClaudeBudgetStatus().overBudget;
 *   when true, Claude is never selected regardless of taskType/requiresHighQuality —
 *   the $4.50/mo cap is a hard stop for this router (falls back to Gemini).
 * @returns {{ model: 'gemini'|'groq'|'claude', reason: string }}
 */
export function selectModelForChoreTask({ projectKey, taskType, requiresHighQuality = false, overBudget = false }) {
  if (projectKey === 'notebook-x') {
    if (taskType === 'easy') {
      return { model: 'groq', reason: 'Notebook-X override: groq_scope covers easy sub-tasks (simple formatting, short lookups).' };
    }
    if (requiresHighQuality && !overBudget) {
      return { model: 'claude', reason: 'Notebook-X override: task complexity/quality genuinely demands Claude (drawn from the shared $4.50/mo cap).' };
    }
    if (requiresHighQuality && overBudget) {
      return { model: 'gemini', reason: 'Notebook-X override wanted Claude, but the $4.50/mo chore-automation cap is exhausted this month — falling back to Gemini (default writer).' };
    }
    return { model: 'gemini', reason: 'Notebook-X override: Gemini is the default writer for content generation.' };
  }

  // General chore_automation economy (all other projects).
  if (taskType === 'easy') {
    return { model: 'groq', reason: 'General economy: Groq handles routine/easy work.' };
  }
  if ((taskType === 'code' || taskType === 'approval') && !overBudget) {
    return { model: 'claude', reason: 'General economy: Claude is scoped to code-writing tasks and approvals.' };
  }
  if ((taskType === 'code' || taskType === 'approval') && overBudget) {
    return { model: 'gemini', reason: 'General economy wanted Claude for a code/approval task, but the $4.50/mo chore-automation cap is exhausted this month — falling back to Gemini.' };
  }
  return { model: 'gemini', reason: 'General economy: Gemini is the expanded-role default writer for content generation.' };
}
