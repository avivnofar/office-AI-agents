/**
 * Data Center — AI Agent Simulation — Cerebras client.
 *
 * Added 2026-08-05 (task-type routing session). OpenAI-compatible chat
 * completions against https://api.cerebras.ai/v1, authenticated with the
 * CEREBRAS_API_KEY Worker secret.
 *
 * ── THE LONG-CONTEXT LANE ────────────────────────────────────────────────
 *
 * This is where long report processing goes — a day's batch of agent
 * reports, cross-report comparison input, anything that does not fit the
 * ~8K-token per-request ceiling on the judgment lane
 * (workers/github-models-client.js). It is also the judgment lane's backup,
 * so a judgment call that overflows GitHub Models has somewhere to land
 * instead of failing.
 *
 * ── AN HONEST GAP, STATED RATHER THAN PAPERED OVER ───────────────────────
 *
 * `maxInputTokensPerRequest` below is null, and that is uncomfortable for a
 * module whose entire job is long input. The free-tier context ceiling on
 * this provider varies by model and has moved more than once, and no network
 * call was made this session to establish today's real number. Writing a
 * plausible-looking figure would be worse than writing none: the router
 * would enforce a cap this repo invented, and the first over-long report
 * batch would be refused for a reason that was never true.
 *
 * So the cap is null — meaning "unknown, do not enforce locally" — and the
 * supervised test procedure for this lane has to establish the real number
 * against the live API before the long-document lane carries real volume.
 * Until then this client's protection against an over-long request is the
 * provider's own 400, surfaced as a logged null like every other failure.
 * See docs/procedures/ in back-office-AI-agents for the read-back step.
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
 * UNVERIFIED against the live catalog as of 2026-08-05 — no network call was
 * made this session. Same standing caution as every other model ID in this
 * repo: two Gemini IDs have already been retired out from under this project
 * (CLAUDE.md, token economy). The supervised test procedure reads the model
 * catalog back before this lane runs anything real.
 */
const DEFAULT_MODEL = 'llama-3.3-70b';

/**
 * Free-tier limits. Mirrored in config/token-economy.json's
 * `providers.cerebras` block; scripts/verify-providers.js asserts the two
 * agree, so changing one alone fails the verifier instead of drifting.
 *
 * Every numeric field is null — genuinely unknown to this session, not
 * "unlimited". The router must treat null as "pace conservatively and
 * believe the response headers".
 */
export const CEREBRAS_LIMITS = {
  maxInputTokensPerRequest: null,
  maxOutputTokensPerRequest: null,
  requestsPerMinute: null,
  requestsPerDay: null,
  tokensPerMinute: null,
  resetUtc: null,
  paid: false,
};

/**
 * Network-free cap verdict, same signature as every other client this
 * session adds so the router can call it uniformly without knowing which
 * provider it holds.
 *
 * Always `ok: true` while the limits above are null — this module will not
 * refuse a request against a number it does not actually know. It still
 * reports the estimate, so the router and the verifier can see the size it
 * measured and a future session can turn the cap on by filling in one
 * constant rather than rewriting this function.
 */
export function checkInputWithinCaps({ prompt = '', systemPrompt = '', maxTokens = 1024 } = {}) {
  const estimatedInputTokens = estimatePromptTokens({ prompt, systemPrompt });
  const cap = CEREBRAS_LIMITS.maxInputTokensPerRequest;

  if (cap !== null && estimatedInputTokens > cap) {
    return {
      ok: false,
      estimatedInputTokens,
      requestedOutputTokens: maxTokens,
      reason: `input is ~${estimatedInputTokens} tokens, over the Cerebras free-tier cap of ${cap}. Not truncating.`,
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
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
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
