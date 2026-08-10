/**
 * Data Center — AI Agent Simulation — Cerebras client.
 *
 * Added 2026-08-05 (task-type routing session). OpenAI-compatible chat
 * completions against https://api.cerebras.ai/v1, authenticated with the
 * CEREBRAS_API_KEY Worker secret.
 *
 * ── TWO LANES, ONE PROVIDER — AN ACCEPTED CONCENTRATION RISK ─────────────
 *
 * As of 2026-08-06 this client is PRIMARY on BOTH routing lanes that carry
 * chat work of consequence:
 *
 *   judgment       — short scored calls (QA, Lead QA, Team Lead reviews)
 *   long_document  — daily report batches, cross-report input
 *
 * It got the judgment lane because GitHub Models, which used to hold it, was
 * permanently retired on 2026-07-30 (see workers/task-router.js's header).
 *
 * **One Cerebras outage now takes out both lanes**, and both degrade to the
 * same backup (Mistral), so the failure concentrates rather than spreads.
 * That is a known, owner-accepted risk, recorded here rather than left to be
 * discovered during an incident. The intended fix if it ever bites is
 * **OpenRouter** as a third chat provider, giving the two lanes different
 * primaries again — deliberately not added now, because adding a provider to
 * solve a risk that has not materialised spends a free tier and a secret on a
 * hypothetical.
 *
 * ── THE CONTEXT CEILING IS MEASURED, NOT GUESSED ─────────────────────────
 *
 * `maxInputTokensPerRequest` was null until 2026-08-06 — an honest gap on the
 * module whose entire job is long input. It is now **131000**, and that is a
 * read-back from the live API, not an estimate:
 *
 *   POST /v1/chat/completions, model gpt-oss-120b, 2026-08-06
 *     200068-token prompt -> HTTP 400
 *       "Please reduce the length of the messages or completion.
 *        Current length is 200068 while limit is 131000"
 *     130868-token prompt -> HTTP 200
 *     131018-token prompt -> HTTP 400 (same message, limit 131000)
 *
 * The number the provider compares against is the PROMPT length; `max_tokens`
 * is not added to it (131018 was refused while carrying max_tokens 128, and
 * the reported "current length" matched the prompt alone).
 *
 * The estimator that feeds this check over-counts on purpose
 * (provider-common.js, chars/3), so the local refusal fires slightly before
 * the provider's would. That is the safe direction.
 *
 * ── ERROR SEMANTICS ──────────────────────────────────────────────────────
 *
 * Identical to workers/groq-client.js: every failure returns `null` after a
 * console.warn, never a throw.
 *
 * Status: added inert. Nothing imports this module as of this commit.
 */

import { estimatePromptTokens, normalizeOpenAiChat, parseRateLimitHeaders } from './provider-common.js';

const CEREBRAS_ENDPOINT = 'https://api.cerebras.ai/v1';

/**
 * VERIFIED against the live catalog on 2026-08-06.
 *
 * The previous value, `llama-3.3-70b`, DID NOT EXIST — it was written from
 * memory in the build session and the supervised test's Step 1 found it
 * returned `model_not_found` on a 404 while the same key served a 200 for the
 * model below (so: a dead model ID, not a bad key). That is the third time
 * this project has been burned by a model retired out from under it, after
 * two Gemini IDs.
 *
 * The full catalog on this key at that date was exactly three models:
 *   gpt-oss-120b, zai-glm-4.7, gemma-4-31b
 *
 * gpt-oss-120b is the only one with the size and context to serve the
 * long-document lane; gemma-4-31b is far too small for a lane that exists to
 * absorb overflow. Re-check with the monthly model-currency job (plan item
 * 3.6) rather than assuming this ID outlives the next catalog change.
 */
const DEFAULT_MODEL = 'gpt-oss-120b';

/**
 * Free-tier limits. Mirrored in config/token-economy.json's
 * `providers.cerebras` block; scripts/verify-providers.js asserts the two
 * agree, so changing one alone fails the verifier instead of drifting.
 *
 * MEASURED 2026-08-06 against the live API (see the header for the read-back).
 *
 * `requestsPerDay` stays NULL on purpose, and it is the interesting one. The
 * response headers DO carry an `x-ratelimit-limit-requests-day` of 1,440,000
 * — but that is exactly 1,000/min x 1,440 min, i.e. the per-minute limit
 * multiplied out, which is what a provider emits when it is not publishing a
 * real daily ceiling. Writing it here would hand the router a 864,000-call
 * soft stop, which is not a limit in any useful sense. The binding
 * constraint on this provider is REQUESTS PER MINUTE, so the daily field
 * stays null and the router's wall-clock pacing keeps applying.
 */
/**
 * MINIMUM output budget for this provider, added 2026-08-10.
 *
 * ── `gpt-oss-120b` IS A REASONING MODEL, AND max_tokens INCLUDES THE THINKING
 *
 * It spends output tokens reasoning BEFORE it emits any visible content, and
 * `max_tokens` bounds the two together. A budget large enough for the answer
 * but not for the reasoning does not produce a short answer — it produces NO
 * answer, with `finish_reason: "length"` and an empty `content`.
 *
 * Measured against the live API on 2026-08-10, same 87-token prompt
 * ("Rate this answer 0-1 and reply with only the number"):
 *
 *     max_tokens  64 -> content ""     finish_reason "length"
 *     max_tokens 600 -> content "0.8"  finish_reason "stop"    154 output tokens
 *
 * 154 output tokens to emit three characters. A second data point, a real
 * report-review call carrying a 5,046-token prompt, came back in 137 output
 * tokens — so the overhead is a property of how much the model DELIBERATES,
 * not of how long the prompt or the answer is, and the smallest, most
 * ambiguous asks are the expensive ones. That is the opposite of the intuition
 * a caller brings, which is why this floor exists in the client rather than as
 * advice to callers.
 *
 * THE JUDGMENT LANE IS THE ONE THIS PROTECTS. Its whole description is "short
 * scored calls" — precisely the shape a caller gives a small budget, and
 * precisely the shape that returns empty.
 *
 * 512 is ~3.3x the largest overhead measured, and it is a FLOOR, not a cap: a
 * caller asking for more still gets what it asked for. The bump is logged, so
 * a caller whose budget is being overridden can see it rather than infer it.
 *
 * This is not a substitute for the router's empty-answer check (task-router.js
 * routeTask()) and does not make it redundant — the floor makes the common
 * case work, the router's check catches the case where it still comes back
 * empty and degrades to the lane's backup instead of returning nothing.
 */
export const MIN_OUTPUT_TOKENS = 512;

export const CEREBRAS_LIMITS = {
  maxInputTokensPerRequest: 131000,
  maxOutputTokensPerRequest: null,
  requestsPerMinute: 1000,
  requestsPerDay: null,
  tokensPerMinute: 1000000,
  resetUtc: null,
  paid: false,
};

/**
 * Network-free cap verdict, same signature as every other client this
 * session adds so the router can call it uniformly without knowing which
 * provider it holds.
 *
 * LIVE since 2026-08-06: the input cap is a measured 131000, so this now
 * genuinely refuses. It refuses rather than truncating, for the reason the
 * whole repo refuses to truncate — a silently shortened report batch produces
 * a confident summary of the part that fit. The lane has no larger provider
 * to fall through to, so an over-131K input is a REAL failure that must
 * surface, not be quietly resized.
 */
export function checkInputWithinCaps({ prompt = '', systemPrompt = '', maxTokens = 1024 } = {}) {
  const estimatedInputTokens = estimatePromptTokens({ prompt, systemPrompt });
  const cap = CEREBRAS_LIMITS.maxInputTokensPerRequest;

  if (cap !== null && estimatedInputTokens > cap) {
    return {
      ok: false,
      estimatedInputTokens,
      requestedOutputTokens: maxTokens,
      reason: `input is ~${estimatedInputTokens} tokens, over the Cerebras per-request context limit of ${cap} (measured 2026-08-06). Not truncating — this is the long-document lane, there is no larger provider behind it.`,
    };
  }

  return {
    ok: true,
    estimatedInputTokens,
    requestedOutputTokens: maxTokens,
    reason: null,
    capUnknown: cap === null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey - CEREBRAS_API_KEY (Worker secret)
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] - larger default than the judgment lane; this
 *   lane exists for long work
 * @param {string} [opts.model]
 * @param {number|string} [opts.agentId] - for warning logs only
 * @returns {Promise<{text: string, source: 'cerebras', finishReason: string|null,
 *   usage: object|null, rateLimit: object}|null>} null on missing key, 429, or
 *   any other failure — the caller degrades to the lane's backup.
 */
export async function callCerebras({
  apiKey,
  prompt,
  systemPrompt,
  temperature = 0.7,
  maxTokens = 2048,
  model = DEFAULT_MODEL,
  agentId,
  onResponse,
}) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] CEREBRAS_API_KEY not configured — set it with \`npx wrangler secret put CEREBRAS_API_KEY\``);
    return null;
  }

  const caps = checkInputWithinCaps({ prompt, systemPrompt, maxTokens });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] Cerebras request refused: ${caps.reason}`);
    return null;
  }

  // See MIN_OUTPUT_TOKENS: this model's reasoning is charged against
  // max_tokens, so a budget below the floor returns an empty answer rather
  // than a short one. Raising is safe (free tier is counted in REQUESTS, and
  // the model stops when it is done); leaving it alone is not.
  const effectiveMaxTokens = Math.max(maxTokens, MIN_OUTPUT_TOKENS);
  if (effectiveMaxTokens !== maxTokens) {
    console.log(`[agent-${agentId}] Cerebras max_tokens raised ${maxTokens} -> ${effectiveMaxTokens} (reasoning-model floor; a smaller budget returns empty content)`);
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let res;
  try {
    res = await fetch(`${CEREBRAS_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: effectiveMaxTokens }),
    });
  } catch (err) {
    console.warn(`[agent-${agentId}] Cerebras request failed: ${err.message}`);
    return null;
  }

  // Fires before the status checks: a 429 or 5xx still consumed a free-tier
  // request allowance and must be counted. See task-router.js.
  onResponse?.({ status: res.status, rateLimit: parseRateLimitHeaders(res) });

  if (res.status === 429) {
    console.warn(`[agent-${agentId}] Cerebras 429 — free-tier rate limit hit`);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Cerebras API error (${res.status}): ${errText.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();
  return normalizeOpenAiChat({ data, res, source: 'cerebras' });
}

/** Uniform descriptor the router's provider registry consumes. */
export const PROVIDER = {
  id: 'cerebras',
  kind: 'chat',
  secretName: 'CEREBRAS_API_KEY',
  endpoint: CEREBRAS_ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  limits: CEREBRAS_LIMITS,
  checkInputWithinCaps,
  call: callCerebras,
};

export { CEREBRAS_ENDPOINT, DEFAULT_MODEL };
