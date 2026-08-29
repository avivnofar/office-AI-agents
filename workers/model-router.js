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

import tokenEconomy from '../config/token-economy.json' with { type: 'json' };
import modelRouting from '../config/model-routing.json' with { type: 'json' };
import {
  routeTask,
  resolveLane,
  routingEnabled,
  routerModelTargets,
  assignEmbodiment,
  renderEmbodimentMap,
  // `checkProviderAllowance` was imported here for the retired wrapper below
  // and is gone with it — leaving the import would create a fresh dead
  // reference while closing one, which is KFM-12 recreated by its own fix.
  // It stays CALLED via its real site, task-router.js:1016.
  recordProviderCall,
  getProviderCallsToday,
  getProviderUsageToday,
  hasKnownCap,
  dailyCapFor,
  capFor,
  paceSpacingFor,
  PROVIDER_REGISTRY,
  LANE_KINDS,
  EMBODIMENT_KIND,
} from './task-router.js';

const CHORE = tokenEconomy.chore_automation;

/**
 * ══════════════════════════════════════════════════════════════════════════
 * CLAUDE PRICING — A FETCHED FACT WITH A DATE ON IT, NOT A GUESS (KFM-19)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Audit 2026-08-15, finding #15: `after` was a hardcoded post-change price
 * that nobody had checked, and `config/token-economy.json` said in its own
 * text to "double check the real published price at that time". The date was
 * 16 days out when the audit was written.
 *
 * ── VERIFIED 2026-08-15 AGAINST THE LIVE PUBLISHED PRICE ─────────────────
 *
 * Checked against Anthropic's own models overview
 * (platform.claude.com/docs/en/about-claude/models/overview), not from
 * memory. Both figures held:
 *
 *   `before` — Sonnet 5 is published TODAY at $2 / input MTok, $10 / output
 *              MTok. That is the introductory rate, and it is what this
 *              office is actually billed right now.
 *   `after`  — $3 / $15 is the documented standard rate the introductory
 *              price discounts from, and 2026-08-31 is the documented end of
 *              the introductory period.
 *
 * So the numbers were right. **That was never the defect.** The defect is
 * that nothing distinguished a checked number from an invented one, and
 * nothing would say a word when the switch happened.
 *
 * ── WHY THE EXPIRY IS NOW LOUD ───────────────────────────────────────────
 *
 * KFM-19 asks "is this a fetched fact or a guess with a date on it?" — and
 * this project has had THREE model IDs retired out from under it, every one
 * discovered by something breaking rather than by anything noticing. A price
 * is the same class of external fact, and a wrong one is quieter than a
 * retired model ID: spend keeps being recorded, the budget keeps being
 * enforced, and every figure is simply wrong by 50%.
 *
 * So the transition is announced three ways rather than happening silently:
 *
 *   1. `PRICING_VERIFIED_ON` records WHEN a human last checked. A date, not
 *      a boolean — "verified" with no date is the claim that goes stale.
 *   2. `currentClaudePricing()` returns `verified: false` past the change
 *      date and warns once per Worker instance, naming the figure in use.
 *   3. `scripts/verify-routing.js` FAILS once the change date is reached
 *      while `PRICING_VERIFIED_ON` still predates it. That is deliberate: a
 *      verifier that goes red on a calendar date is a time bomb, and a time
 *      bomb is exactly right here — it fires BEFORE the price moves, which
 *      is the only moment at which re-checking is cheap.
 *
 * **To clear it:** re-read the published price, update the figures if they
 * moved, and set `PRICING_VERIFIED_ON` to the date you checked.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ── THE TIME BOMB WENT OFF, AND THE ANSWER WAS "NO CHANGE" (2026-08-29) ────
 * ══════════════════════════════════════════════════════════════════════════
 *
 * SESSION 34, ITEM C. It fired two days early, exactly as designed, and the
 * re-check found the price is NOT moving:
 *
 *   > "The $2/$10 per million input/output token pricing for Claude Sonnet 5,
 *   >  announced at launch as introductory pricing through August 31, 2026, is
 *   >  now the standard price. The previously scheduled increase to $3/$15 per
 *   >  million input/output tokens on September 1, 2026 will not occur."
 *   > — platform.claude.com/docs/en/about-claude/pricing, read 2026-08-29
 *
 * $2/$10 is permanent. **THE `after` BRANCH IS DELETED, NOT CORRECTED**, and
 * that distinction is the whole of this change. Setting `after` to $2/$10 and
 * leaving the conditional standing would have left a date comparison, a warning
 * path and a verifier time bomb all guarding a transition that no longer
 * exists — dead machinery that the next reader has to decode before they can
 * trust the number. A stale conditional is what makes this recur.
 *
 * The $3/$15 figure was never wrong; it is now simply about a different model.
 * Sonnet 4.6 and 4.5 are the models published at $3/$15 today, and Sonnet 5 —
 * the one this office calls — is $2/$10 for good.
 *
 * ── WHAT IS KEPT, AND WHY ─────────────────────────────────────────────────
 *
 * `PRICING_VERIFIED_ON` STAYS. KFM-19's finding was never that the numbers were
 * wrong — it was that nothing distinguished a checked number from an invented
 * one. Removing the date because today's answer happens to be "no change" would
 * throw away the only part of this that was ever the point. A permanent price
 * is still an external fact about someone else's business, and the next time it
 * moves the office should find out by reading, not by being billed.
 *
 * What is gone is only the SCHEDULED transition: there is no future date to
 * count down to any more, so there is nothing for a countdown to guard.
 * `scripts/verify-routing.js` re-verifies against the published figures instead
 * of against a calendar.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * The date a person last checked these figures against Anthropic's published
 * price. A date, not a boolean — "verified" with no date is the claim that goes
 * stale. See the block above for what was read on 2026-08-29.
 */
const PRICING_VERIFIED_ON = '2026-08-29';

/**
 * Claude Sonnet 5, first-party Claude API, USD per million tokens.
 *
 * FLAT, not `{ before, after }`. There is no scheduled change to branch on —
 * the 2026-09-01 increase was withdrawn (see above), and a conditional kept
 * "just in case" would be a second thing to keep true.
 */
const CLAUDE_PRICING = { inputPerMillion: 2, outputPerMillion: 10 };

/**
 * Prompt-caching multipliers, relative to `inputPerMillion` (Session 34, C3).
 *
 * Read from the same published pricing page on 2026-08-29 and cross-checked
 * against its Sonnet 5 row in dollars: base input $2, 5m cache write $2.50
 * (1.25x), 1h cache write $4 (2x), cache hit $0.20 (0.1x).
 *
 * These exist so `recordClaudeSpend()` can charge cache tokens at what they
 * ACTUALLY cost. Before this, a cached call would have been under-recorded:
 * `usage.input_tokens` excludes cached tokens entirely, so cache reads and
 * cache writes would both have been billed by Anthropic and counted as zero
 * here. Enabling caching without this would have made the spend guard blind in
 * the one direction a spend guard must never be blind.
 */
const CACHE_MULTIPLIERS = { write5m: 1.25, write1h: 2, read: 0.1 };

function currentClaudePricing() {
  return { ...CLAUDE_PRICING, verified: true, verifiedOn: PRICING_VERIFIED_ON };
}

/**
 * Is the price this router is charging against a checked fact right now?
 *
 * Exported so a status endpoint or a report can say so out loud rather than
 * a reader having to know that a console warning exists. Makes no model call.
 */
export function claudePricingStatus() {
  const p = currentClaudePricing();
  return {
    inputPerMillion: p.inputPerMillion,
    outputPerMillion: p.outputPerMillion,
    cacheWrite5mPerMillion: p.inputPerMillion * CACHE_MULTIPLIERS.write5m,
    cacheWrite1hPerMillion: p.inputPerMillion * CACHE_MULTIPLIERS.write1h,
    cacheReadPerMillion: p.inputPerMillion * CACHE_MULTIPLIERS.read,
    verified: p.verified,
    verifiedOn: PRICING_VERIFIED_ON,
    // `changeDate` is deliberately gone rather than nulled: there is no
    // scheduled change to report. A field reading `null` invites the reading
    // "we do not know when it changes"; its absence says "it does not".
    model: 'claude-sonnet-5',
    note: `Claude Sonnet 5 at $${p.inputPerMillion}/M input, $${p.outputPerMillion}/M output — `
      + `verified against Anthropic's published pricing page on ${PRICING_VERIFIED_ON}, which states that `
      + 'this is now the STANDARD price and the 2026-09-01 increase to $3/$15 will not occur. '
      + 'No scheduled change remains to count down to.',
  };
}

/**
 * Estimated USD cost for one Claude call.
 *
 * Return shape unchanged — a number — so no existing caller had to change, and
 * the two extra arguments are optional for the same reason: a call that passes
 * neither is priced exactly as it was before Session 34.
 *
 * ── WHY CACHE TOKENS ARE A SEPARATE ARGUMENT (Session 34, C3/C5) ──────────
 *
 * Anthropic's `usage.input_tokens` is the UNCACHED REMAINDER only. Total prompt
 * size is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 * So the moment any call carries `cache_control`, pricing it from
 * `input_tokens` alone silently under-charges the office for tokens it was
 * really billed for — and a spend guard that under-counts is worse than no
 * guard, because it still looks like one.
 *
 * The guard's threshold is untouched. Only the arithmetic feeding it is now
 * complete.
 *
 * @param {number} inputTokens  usage.input_tokens — the UNCACHED remainder
 * @param {number} outputTokens usage.output_tokens
 * @param {number} [cacheWriteTokens] usage.cache_creation_input_tokens
 * @param {number} [cacheReadTokens]  usage.cache_read_input_tokens
 * @param {'5m'|'1h'} [cacheTtl] which write multiplier applies (default '5m')
 */
export function estimateClaudeCostUsd(inputTokens, outputTokens, cacheWriteTokens = 0, cacheReadTokens = 0, cacheTtl = '5m') {
  const p = currentClaudePricing();
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const writeMult = cacheTtl === '1h' ? CACHE_MULTIPLIERS.write1h : CACHE_MULTIPLIERS.write5m;
  return (
    (n(inputTokens) / 1_000_000) * p.inputPerMillion
    + (n(outputTokens) / 1_000_000) * p.outputPerMillion
    + (n(cacheWriteTokens) / 1_000_000) * p.inputPerMillion * writeMult
    + (n(cacheReadTokens) / 1_000_000) * p.inputPerMillion * CACHE_MULTIPLIERS.read
  );
}

const BUDGET_TABLE_SQL = `CREATE TABLE IF NOT EXISTS claude_budget_usage (
  month TEXT PRIMARY KEY,
  spent_usd REAL DEFAULT 0,
  call_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

function currentMonthKey(date = new Date(), component = 'qa') {
  const base = date.toISOString().slice(0, 7); // 'YYYY-MM'
  if (component === 'guides') return `${base}#guides`;
  if (component === 'architect') return `${base}#architect`;
  return base;
}

/** Per-component monthly $ cap. 'qa' keeps reading the pre-existing
 * chore_automation/shared_claude_budget value (unchanged); 'guides' reads
 * config/token-economy.json `guides_claude_budget`; 'architect' (session 31,
 * Item A — workers/architect-spec.js) reads the new `architect_claude_budget`
 * block, a third sub-budget disjoint from both by month-key suffix, same as
 * 'guides' is disjoint from 'qa'. */
function capUsdForComponent(component) {
  if (component === 'guides') return tokenEconomy.guides_claude_budget?.cap_usd_per_month ?? 4.5;
  if (component === 'architect') return tokenEconomy.architect_claude_budget?.cap_usd_per_month ?? 1.0;
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
export async function recordClaudeSpend(env, {
  inputTokens, outputTokens, asOf = new Date(), component = 'qa',
  // Session 34, C3/C5. Absent on every pre-existing caller, which is why they
  // did not have to change: a call with no cache tokens costs exactly what it
  // cost before. `asOf` was previously passed to estimateClaudeCostUsd() as a
  // third positional argument for date-aware pricing; there is no longer a date
  // to be aware of (see CLAUDE_PRICING), so it is used only for the month key.
  cacheWriteTokens = 0, cacheReadTokens = 0, cacheTtl = '5m',
}) {
  if (!env?.DB) return { recorded: false, reason: 'no DB binding' };

  const month = currentMonthKey(asOf, component);
  const costUsd = estimateClaudeCostUsd(
    inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, cacheTtl
  );

  await env.DB.prepare(BUDGET_TABLE_SQL).run();
  await env.DB.prepare(
    `INSERT INTO claude_budget_usage (month, spent_usd, call_count, updated_at)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(month) DO UPDATE SET
       spent_usd = spent_usd + excluded.spent_usd,
       call_count = call_count + 1,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(month, costUsd).run();

  return {
    recorded: true, month, costUsd,
    // Surfaced so a caller (and SESSION-34's C4 measurement) can see whether a
    // cache breakpoint actually HIT, rather than inferring it from the total.
    // A write with no matching read on the next call is the signature of a
    // cache that costs 1.25x and returns nothing.
    cacheWriteTokens: cacheWriteTokens || 0,
    cacheReadTokens: cacheReadTokens || 0,
  };
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
 *   'hebrew_composition' | 'report_drafting' | 'routine_volume' |
 *   'classification' | 'conversation' | 'embeddings' | 'image'.
 *   ('architect' resolves to a refusal.)
 * @param {object} [opts] - prompt/systemPrompt/maxTokens/personas/etc.,
 *   plus `bypassGate: true` for supervised testing only.
 *   For the `image` lane: `role: 'draft' | 'polish'` (absent uses the lane's
 *   default_role, which is 'draft'), `imageModel`, `steps`, and for a polish
 *   pass `instruction` + `inputImages: [{base64, mimeType}]`. A role resolves to
 *   exactly one provider and NEVER degrades to the other role.
 */
export async function routeTaskTypeCall(env, taskType, opts = {}) {
  return routeTask({ env, taskType, routingConfig: modelRouting, tokenEconomy, ...opts });
}

/** Resolves a task type to its ordered candidate providers without calling
 * anything. Used by the verifier and the supervised-test read-back. */
export function resolveTaskLane(taskType, opts = {}) {
  return resolveLane(modelRouting, taskType, opts);
}

/**
 * RETIRED 2026-08-15 — `checkRoutedProviderAllowance()` was here.
 *
 * A three-line config-binding wrapper over `checkProviderAllowance()` with
 * **zero callers anywhere**, found independently by two routes on the same
 * day: `AUDIT-2026-08-15-UNSEEN-CORNERS.md` #25 (by reading) and OB-001's
 * gate-call audit (by mechanism). Two independent methods agreeing on a dead
 * export is as settled as this project's evidence rules get.
 *
 * **It was never needed.** The only path that checks a provider's allowance is
 * `task-router.js routeTask()`, which already holds `tokenEconomy` and
 * `routingConfig` in scope and calls `checkProviderAllowance()` directly at
 * `task-router.js:1016`. The binding this wrapper provided is binding the
 * caller does not need. Nothing lost capability; the sibling gate is CALLED
 * and verifier-covered (8 sites in `scripts/verify-routing.js`).
 *
 * Deleted rather than left in place — unlike `checkAndRecordPull()` above it,
 * which is kept because a real caller could plausibly appear one day. Nothing
 * will ever want this one: any future caller inside the router already has the
 * config, and any caller outside it should not be making allowance decisions.
 * Recovering it is `git show` on this commit.
 */

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
      // OB-100: report the pacing a null-cap provider is ACTUALLY held at, and
      // what that number was derived from. Before this, every null-cap provider
      // read identically here — `capUnknown: true` and nothing else — so
      // Cerebras, paced at 3 calls/min against a MEASURED 1,000/min ceiling,
      // was indistinguishable from a provider nobody had ever measured. The
      // wrong number was not hidden by a bug; it was simply never displayed.
      //
      // capFor(), NOT dailyCapFor(). The first cut of this used dailyCapFor and
      // reported a 1000ms pacing for Cohere — which is never paced at all, its
      // cap being MONTHLY, so capFor() finds it and checkProviderAllowance()
      // takes the counted branch. A status line must show the branch the code
      // ACTUALLY takes; showing a different one is the defect this whole field
      // was added to expose, reintroduced by the display of it.
      const pace = capFor(tokenEconomy, id).cap === null
        ? paceSpacingFor(tokenEconomy, id, modelRouting)
        : null;
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
        pacingMs: pace?.spacingMs ?? null,
        pacingBasis: pace?.basis ?? null,
        ratePerMinute: pace?.ratePerMinute ?? null,
      };
    }),
  };
}

/**
 * The `image` lane's two roles, resolved without calling anything — the
 * read-back the supervised image test uses and the shape the capability audit
 * asks for. Returns one entry per role, each naming its single provider, so
 * "which provider serves polish" is answerable without reading the config by eye.
 *
 * Kept here rather than generalised over every lane because `roles` mode has
 * exactly one lane today, and a generic helper over one instance is a shape
 * nobody has tested against a second case.
 */
export function resolveImageRoles() {
  const lane = modelRouting.lanes?.image;
  const roles = Object.keys(lane?.roles || {});
  return {
    mode: lane?.mode ?? null,
    kind: lane?.kind ?? null,
    defaultRole: lane?.default_role ?? null,
    onUnavailable: lane?.on_unavailable ?? null,
    roles: Object.fromEntries(roles.map((r) => [r, resolveLane(modelRouting, 'image', { role: r })])),
  };
}

export {
  routingEnabled,
  // The five router-side model identifiers, for the weekly catalogue-retirement
  // check (2026-08-23, workers/model-catalog.js). Re-exported here for the same
  // reason everything else in this block is: agent-runner.js takes routing
  // through model-router.js, not through task-router.js directly.
  routerModelTargets,
  assignEmbodiment,
  renderEmbodimentMap,
  recordProviderCall,
  getProviderCallsToday,
  getProviderUsageToday,
  hasKnownCap,
  dailyCapFor,
  capFor,
  paceSpacingFor,
  PROVIDER_REGISTRY,
  LANE_KINDS,
  EMBODIMENT_KIND,
};
