/**
 * Model selection + Claude budget tracking, originally built for the
 * TODO.md-driven chore automation (Notebook-X / data-center / archive-alpha
 * rotation — see config/daily-schedule.json's night sweep and
 * config/token-economy.json's `chore_automation` block).
 *
 * UPDATED 2026-07-18 (Q&A-engine rebuild): getClaudeBudgetStatus()/
 * recordClaudeSpend() are now ALSO called directly by agents/agent-base.js's
 * _askDataCenter() for the 11-agent office simulation's own Claude asks —
 * this is the SAME shared $4.50/month soft-stop budget (under the account's own $5/month spend ceiling) (config/token-economy.json's
 * top-level `shared_claude_budget`, claude_budget_usd_per_month below), by
 * design, not two separate economies anymore. The old 11-agent-only per-day
 * CALL-COUNT cap (tokenEconomy.claude_daily_cap) this comment used to
 * contrast against has been removed from config/token-economy.json.
 *
 * UPDATED (Guides feature): added a SECOND, independent sub-budget for the
 * Guides pipeline (workers/guide-engine.js — Architect review/finalize calls
 * and the weekly verification pass, both via workers/claude-client.js's
 * direct Anthropic API call). Same table (`claude_budget_usage`), same
 * functions, distinguished by an explicit `component: 'qa' | 'guides'`
 * option that defaults to `'qa'` — every existing caller (which never passes
 * `component`) is byte-for-byte unaffected. Guides rows use month key
 * `'YYYY-MM#guides'` instead of `'YYYY-MM'`, so the two sub-budgets can never
 * collide or drain each other regardless of read/write order.
 */

import tokenEconomy from '../config/token-economy.json';
import modelRouting from '../config/model-routing.json';
import {
  routeTask,
  resolveLane,
  routingEnabled,
  assignEmbodiment,
  renderEmbodimentMap,
  checkProviderAllowance,
  recordProviderCall,
  getProviderCallsToday,
  getProviderUsageToday,
  hasKnownCap,
  dailyCapFor,
  PROVIDER_REGISTRY,
} from './task-router.js';

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

function currentMonthKey(date = new Date(), component = 'qa') {
  const base = date.toISOString().slice(0, 7); // 'YYYY-MM'
  return component === 'guides' ? `${base}#guides` : base;
}

/** Per-component monthly $ cap. 'qa' keeps reading the pre-existing
 * chore_automation/shared_claude_budget value (unchanged); 'guides' reads
 * the new config/token-economy.json `guides_claude_budget` block. */
function capUsdForComponent(component) {
  if (component === 'guides') return tokenEconomy.guides_claude_budget?.cap_usd_per_month ?? 4.5;
  return CHORE.claude_budget_usd_per_month;
}

/**
 * Reads this month's Claude spend against a component's soft cap —
 * 'qa' (default, config/token-economy.json chore_automation.claude_budget_usd_per_month
 * == shared_claude_budget.cap_usd_per_month, the account's own $5/month
 * spend ceiling is the hard backstop) or 'guides' (guides_claude_budget.cap_usd_per_month).
 * No-ops (reports $0 spent, allowed) if env.DB isn't available.
 */
export async function getClaudeBudgetStatus(env, { asOf = new Date(), component = 'qa' } = {}) {
  const capUsd = capUsdForComponent(component);
  const month = currentMonthKey(asOf, component);

  if (!env?.DB) {
    console.warn(`[model-router] No D1 binding — Claude ${component}-budget tracking skipped (treated as $0 spent).`);
    return { month, spentUsd: 0, capUsd, remainingUsd: capUsd, overBudget: false };
  }

  await env.DB.prepare(BUDGET_TABLE_SQL).run();
  const row = await env.DB.prepare('SELECT spent_usd, call_count FROM claude_budget_usage WHERE month = ?').bind(month).first();
  const spentUsd = row?.spent_usd ?? 0;
  return { month, spentUsd, capUsd, remainingUsd: Math.max(0, capUsd - spentUsd), overBudget: spentUsd >= capUsd };
}

/**
 * Counts today's (UTC calendar day, repo DATE('now') convention) Claude
 * calls — success, failure and all: every _askDataCenter() attempt logs an
 * interactions row with model_source='claude', including follow-ups, and a
 * failed call still consumed request tokens. Used by _askDataCenter()'s
 * per-day call-cap backstop (config/token-economy.json
 * shared_claude_budget.max_calls_per_day, added 2026-07-19). Degrades open
 * (0) without env.DB, same posture as the rest of this module.
 */
export async function getClaudeCallsToday(env) {
  if (!env?.DB) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM interactions WHERE model_source = 'claude' AND DATE(timestamp) = DATE('now')`
  ).first().catch(() => null);
  return row?.n ?? 0;
}

/** The per-day Claude call cap (0/undefined = no daily cap, monthly $ cap still applies). */
export const CLAUDE_MAX_CALLS_PER_DAY = tokenEconomy.shared_claude_budget?.max_calls_per_day ?? 0;

/** Records a Claude call's cost against this month's soft cap for the given
 * component ('qa' default, or 'guides'). No-ops without env.DB. */
export async function recordClaudeSpend(env, { inputTokens, outputTokens, asOf = new Date(), component = 'qa' }) {
  if (!env?.DB) return { recorded: false, reason: 'no DB binding' };

  const month = currentMonthKey(asOf, component);
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
 *   the $4.50/mo soft cap is a hard stop for this router (falls back to Gemini).
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

/* ════════════════════════════════════════════════════════════════════════
 * TASK-TYPE ROUTING (added 2026-08-05, plan Phase 3)
 * Shipped OFF 2026-08-05 · ENABLED IN PRODUCTION 2026-08-10.
 * The code default is still OFF; production is not. Read the live flag back
 * with `{"type":"routing_status"}` rather than trusting this line — see
 * workers/task-router.js's header.
 *
 * Everything above this line is the pre-existing budget router and is
 * unchanged: selectModelForChoreTask() still returns the same model for the
 * same inputs, and getClaudeBudgetStatus()/recordClaudeSpend() still behave
 * exactly as they did. Nothing below is reachable from any of it.
 *
 * This section binds workers/task-router.js — which deliberately imports no
 * JSON so its verifier can load it under plain `node` — to the two real
 * config files and re-exports the result. model-router.js stays the module
 * name the plan and CLAUDE.md point at for "routing"; task-router.js is
 * where the logic lives so it can be tested by calling it rather than by
 * grepping it.
 *
 * THE SWITCH: routeTaskTypeCall() refuses with `routing_disabled` while
 * SIM_KV's simulation-state `routing_enabled` flag is absent or false, which
 * is the state this ships in. It contacts no provider, creates no D1 table
 * and touches no counter while off.
 *
 * ANTHROPIC IS NOT REACHABLE FROM ANY OF THIS. There is no Anthropic entry
 * in PROVIDER_REGISTRY and no Anthropic id in config/model-routing.json.
 * The pre-existing Anthropic callers — agents/agent-base.js _askDataCenter()
 * through the APP_API service binding, and workers/claude-client.js's direct
 * Messages API calls for the Guides pipeline — never went through this
 * router and are untouched by it. Their budgets remain the ones above.
 * ════════════════════════════════════════════════════════════════════════ */

/** The lane table as loaded (config/model-routing.json). */
export const MODEL_ROUTING = modelRouting;

/**
 * Routes one task by task type and calls the resolved provider.
 * Never throws. See task-router.js routeTask() for the degradation ladder.
 *
 * @param {object} env - Worker env
 * @param {string} taskType - a lane key: 'judgment' | 'long_document' |
 *   'hebrew_composition' | 'routine_volume' | 'classification' |
 *   'conversation' | 'embeddings'. ('architect' resolves to a refusal.)
 * @param {object} [opts] - prompt/systemPrompt/maxTokens/personas/etc.,
 *   plus `bypassGate: true` for supervised testing only.
 */
export async function routeTaskTypeCall(env, taskType, opts = {}) {
  return routeTask({ env, taskType, routingConfig: modelRouting, tokenEconomy, ...opts });
}

/** Resolves a task type to its ordered candidate providers without calling
 * anything. Used by the verifier and the supervised-test read-back. */
export function resolveTaskLane(taskType, opts = {}) {
  return resolveLane(modelRouting, taskType, opts);
}

/** Per-provider allowance check bound to the real config. */
export async function checkRoutedProviderAllowance(env, providerId, opts = {}) {
  return checkProviderAllowance(env, providerId, { tokenEconomy, routingConfig: modelRouting, ...opts });
}

/** Today's per-provider usage plus each provider's known cap and soft-stop —
 * the quota view for the admin status endpoint (plan item 3.5). */
export async function getRoutingQuotaStatus(env, asOf = new Date()) {
  const usage = await getProviderUsageToday(env, asOf);
  const byProvider = Object.fromEntries(usage.map((r) => [r.provider, r]));
  const fraction = modelRouting.soft_stop_fraction ?? 0.6;

  return {
    routingEnabled: await routingEnabled(env),
    softStopFraction: fraction,
    day: asOf.toISOString().slice(0, 10),
    providers: Object.keys(PROVIDER_REGISTRY).map((id) => {
      const cap = dailyCapFor(tokenEconomy, id);
      const row = byProvider[id];
      return {
        provider: id,
        callsToday: row?.call_count ?? 0,
        confirmedToday: row?.confirmed_count ?? 0,
        inputTokensToday: row?.input_tokens ?? 0,
        outputTokensToday: row?.output_tokens ?? 0,
        dailyCap: cap,
        softStop: cap === null ? null : Math.floor(cap * fraction),
        // null cap means UNKNOWN, never unlimited — such a provider is
        // constrained by wall-clock pacing instead of a count.
        capUnknown: cap === null,
      };
    }),
  };
}

export {
  routingEnabled,
  assignEmbodiment,
  renderEmbodimentMap,
  recordProviderCall,
  getProviderCallsToday,
  getProviderUsageToday,
  hasKnownCap,
  dailyCapFor,
  PROVIDER_REGISTRY,
};
