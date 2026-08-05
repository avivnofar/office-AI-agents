/**
 * Data Center — AI Agent Simulation — GitHub Models client.
 *
 * Added 2026-08-05 (task-type routing session). OpenAI-compatible chat
 * completions against https://models.github.ai/inference, authenticated with
 * the GITHUB_MODELS_TOKEN Worker secret.
 *
 * ── THE CONSTRAINT THAT DECIDES WHERE THIS LANE IS USED ──────────────────
 *
 * The GitHub Models FREE TIER caps a single request at roughly 8K input
 * tokens and 4K output tokens, and separately rate-limits by REQUEST RATE
 * (per-minute and per-day, both varying by the model's tier). Those caps are
 * small, and they are per-request — no amount of pacing works around them.
 *
 * That makes this provider RIGHT for short judgment calls — "score this
 * answer 0-1", "is this draft consistent with the persona", "APPROVE or
 * REVISE" — which is exactly the judgment/quality lane it is the primary
 * for. It makes it WRONG for long report processing: a day's batch of agent
 * reports does not fit in 8K tokens, and the long-document lane belongs to
 * workers/cerebras-client.js.
 *
 * ── WHY THIS MODULE REFUSES INSTEAD OF TRUNCATING ────────────────────────
 *
 * Oversized input is REJECTED here, before any network call, with a logged
 * reason naming the cap and the measured size. It is never trimmed to fit.
 *
 * This repo has already paid for the other behaviour once. On 2026-07-11 a
 * housekeeping job sent a model the first 2500 characters of a ~2000-line
 * file while asking for "the FULL updated code" back, and pushed the result:
 * notebook_backend.py went from 2002 lines to 79 and production stayed down
 * until the next day (CLAUDE.md, "Incident: 2026-07-11/12"). The mechanism
 * was retired wholesale rather than re-guarded, and the standing rule that
 * came out of it is explicit — the model must see the ENTIRE input, never a
 * truncated excerpt. Silently trimming a prompt to fit a free-tier cap is
 * that same mistake wearing a smaller hat: the call succeeds, the answer
 * looks complete, and nothing anywhere records that half the question was
 * thrown away.
 *
 * An over-cap OUTPUT request (maxTokens above the free-tier ceiling) is
 * refused for the same reason rather than clamped. A clamped output limit
 * produces a truncated answer that reads as a finished one — the exact bug
 * the Guides pipeline shipped and now carries two guards against.
 *
 * ── ERROR SEMANTICS ──────────────────────────────────────────────────────
 *
 * Identical to workers/groq-client.js: every failure path returns `null`
 * after a console.warn, never a throw. Callers on a user-facing path degrade
 * to the lane's backup provider instead of hard-failing. Callers that want
 * the REASON a request would be refused should call checkInputWithinCaps()
 * first — it returns a structured verdict without sending anything.
 *
 * Status: added inert. Nothing imports this module as of this commit.
 */

import { estimatePromptTokens, normalizeOpenAiChat, parseRateLimitHeaders } from './provider-common.js';

const GITHUB_MODELS_ENDPOINT = 'https://models.github.ai/inference';

/**
 * Default model. DELIBERATELY a low-tier, high-rate-allowance model rather
 * than a flagship: the judgment lane's value is many short scored calls, and
 * on the free tier the flagship tiers buy quality with a materially smaller
 * per-day request allowance.
 *
 * UNVERIFIED against the live catalog as of 2026-08-05 — no network call was
 * made this session. This project has been burned by a stale model ID twice
 * already (gemini-3.5-flash, then gemini-2.5-flash, both 404ing live — see
 * CLAUDE.md's token-economy section), so the supervised test procedure's
 * FIRST step for this lane is a model-existence read-back, not a chat call.
 * Override per-call with the `model` option.
 */
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

/**
 * Free-tier limits, as documented by the provider. Mirrored in
 * config/token-economy.json's `providers.github_models` block;
 * scripts/verify-providers.js asserts the two agree, so a change to either
 * one alone fails the verifier rather than drifting quietly.
 *
 * `requestsPerDay`/`requestsPerMinute` are null ON PURPOSE: GitHub Models
 * publishes DIFFERENT request-rate allowances per model tier, so there is no
 * single honest number to write here. Null means "this module does not
 * know" — the router treats that as "pace conservatively and believe the
 * response headers", never as "unlimited".
 */
export const GITHUB_MODELS_LIMITS = {
  maxInputTokensPerRequest: 8000,
  maxOutputTokensPerRequest: 4000,
  requestsPerMinute: null,
  requestsPerDay: null,
  resetUtc: null,
  paid: false,
};

/**
 * Structured, network-free verdict on whether a request fits the free-tier
 * per-request caps. Used by the router to pre-check before choosing this
 * lane, and by scripts/verify-providers.js to prove the caps are enforced.
 *
 * @returns {{ok: boolean, estimatedInputTokens: number, requestedOutputTokens: number,
 *            reason: string|null}} `reason` is null when ok.
 */
export function checkInputWithinCaps({ prompt = '', systemPrompt = '', maxTokens = 512 } = {}) {
  const estimatedInputTokens = estimatePromptTokens({ prompt, systemPrompt });

  if (estimatedInputTokens > GITHUB_MODELS_LIMITS.maxInputTokensPerRequest) {
    return {
      ok: false,
      estimatedInputTokens,
      requestedOutputTokens: maxTokens,
      reason:
        `input is ~${estimatedInputTokens} tokens, over the GitHub Models free-tier cap of `
        + `${GITHUB_MODELS_LIMITS.maxInputTokensPerRequest}. Not truncating — route long input to `
        + 'the long-context lane (workers/cerebras-client.js).',
    };
  }

  if (maxTokens > GITHUB_MODELS_LIMITS.maxOutputTokensPerRequest) {
    return {
      ok: false,
      estimatedInputTokens,
      requestedOutputTokens: maxTokens,
      reason:
        `requested ${maxTokens} output tokens, over the GitHub Models free-tier cap of `
        + `${GITHUB_MODELS_LIMITS.maxOutputTokensPerRequest}. Not clamping — a silently clamped `
        + 'output limit yields a truncated answer that reads as a complete one.',
    };
  }

  return { ok: true, estimatedInputTokens, requestedOutputTokens: maxTokens, reason: null };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey - GITHUB_MODELS_TOKEN (Worker secret). NOTE: this is
 *   deliberately NOT allowed to fall back to the existing GITHUB_TOKEN. That token
 *   carries repo WRITE scope for report/guide commits; handing it to an inference
 *   path would give a model-calling code path more reach than its work requires —
 *   the precise thing the one-scoped-token-per-target decision exists to prevent
 *   (plan item 0.8).
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt] - system instruction (persona + state)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] - short by default; hard-capped at 4000 (see above)
 * @param {string} [opts.model]
 * @param {number|string} [opts.agentId] - for warning logs only
 * @returns {Promise<{text: string, source: 'github-models', finishReason: string|null,
 *   usage: object|null, rateLimit: object}|null>} null on missing key, refused
 *   caps, 429, or any other failure — the caller degrades to the lane's backup.
 */
export async function callGithubModels({
  apiKey,
  prompt,
  systemPrompt,
  temperature = 0.7,
  maxTokens = 512,
  model = DEFAULT_MODEL,
  agentId,
  onResponse,
}) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] GITHUB_MODELS_TOKEN not configured — set it with \`npx wrangler secret put GITHUB_MODELS_TOKEN\``);
    return null;
  }

  const caps = checkInputWithinCaps({ prompt, systemPrompt, maxTokens });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] GitHub Models request refused: ${caps.reason}`);
    return null;
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let res;
  try {
    res = await fetch(`${GITHUB_MODELS_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (err) {
    console.warn(`[agent-${agentId}] GitHub Models request failed: ${err.message}`);
    return null;
  }

  // The provider responded — whatever it said. This fires BEFORE the status
  // checks below on purpose: a 429 or a 500 still consumed a free-tier
  // request allowance, and the token economy has to count it. See
  // task-router.js recordProviderCall()'s note on confirmed evidence.
  onResponse?.({ status: res.status, rateLimit: parseRateLimitHeaders(res) });

  if (res.status === 429) {
    console.warn(`[agent-${agentId}] GitHub Models 429 — free-tier request rate exhausted`);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] GitHub Models API error (${res.status}): ${errText.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();
  return normalizeOpenAiChat({ data, res, source: 'github-models' });
}

/** Uniform descriptor the router's provider registry consumes. Every provider
 * client added this session exports one with this exact shape. */
export const PROVIDER = {
  id: 'github-models',
  kind: 'chat',
  secretName: 'GITHUB_MODELS_TOKEN',
  endpoint: GITHUB_MODELS_ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  limits: GITHUB_MODELS_LIMITS,
  checkInputWithinCaps,
  call: callGithubModels,
};

export { GITHUB_MODELS_ENDPOINT, DEFAULT_MODEL };
