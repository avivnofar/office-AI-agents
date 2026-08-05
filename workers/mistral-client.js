/**
 * Data Center — AI Agent Simulation — Mistral client.
 *
 * Added 2026-08-05 (task-type routing session). OpenAI-compatible chat
 * completions against https://api.mistral.ai/v1, authenticated with the
 * MISTRAL_API_KEY Worker secret.
 *
 * ── WHAT THIS PROVIDER IS FOR ────────────────────────────────────────────
 *
 * Mistral is a BACKUP in two lanes and a primary in none:
 *   · long-document processing — behind Cerebras;
 *   · Hebrew composition — behind Gemini 3.1 Flash-Lite.
 *
 * The Hebrew role deserves a note, because it is the one place this lane
 * carries real quality risk. Hebrew composition is the office's internal
 * voice — gap notes and summaries written by an agent in its own persona
 * (agent-base.js queryGeminiDirect()). Gemini is the primary there for a
 * reason, and this client is what runs when Gemini's shared free-tier quota
 * is exhausted or paced out (workers/gemini-pacer.js). A backup that writes
 * noticeably worse Hebrew is still better than a skipped note — but the
 * difference is exactly the kind of thing the Lead QA's cross-embodiment
 * comparison exists to measure, so it should be measured rather than
 * assumed.
 *
 * Note also that the Front is ENGLISH ONLY (owner decision, 2026-08-05), so
 * this lane never touches published content. Hebrew here is internal only.
 *
 * ── ERROR SEMANTICS ──────────────────────────────────────────────────────
 *
 * Identical to workers/groq-client.js: every failure returns `null` after a
 * console.warn, never a throw.
 *
 * Status: added inert. Nothing imports this module as of this commit.
 */

import { estimatePromptTokens, normalizeOpenAiChat } from './provider-common.js';

const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1';

/**
 * UNVERIFIED against the live catalog as of 2026-08-05 — no network call was
 * made this session. Same standing caution as every other model ID here; the
 * supervised test procedure reads the catalog back before this lane runs
 * anything real.
 */
const DEFAULT_MODEL = 'mistral-small-latest';

/**
 * Free-tier limits. Mirrored in config/token-economy.json's
 * `providers.mistral` block; scripts/verify-providers.js asserts the two
 * agree.
 *
 * All null — unknown to this session, not unlimited. Mistral's free
 * ("experiment") tier publishes request-rate and monthly-token allowances
 * that have changed more than once, and this session made no call to
 * establish today's values.
 */
export const MISTRAL_LIMITS = {
  maxInputTokensPerRequest: null,
  maxOutputTokensPerRequest: null,
  requestsPerMinute: null,
  requestsPerDay: null,
  tokensPerMonth: null,
  resetUtc: null,
  paid: false,
};

/**
 * Network-free cap verdict, same signature as every other client this
 * session adds. Always `ok: true` while the limits above are null — this
 * module will not refuse a request against a number it does not know.
 */
export function checkInputWithinCaps({ prompt = '', systemPrompt = '', maxTokens = 1024 } = {}) {
  const estimatedInputTokens = estimatePromptTokens({ prompt, systemPrompt });
  const cap = MISTRAL_LIMITS.maxInputTokensPerRequest;

  if (cap !== null && estimatedInputTokens > cap) {
    return {
      ok: false,
      estimatedInputTokens,
      requestedOutputTokens: maxTokens,
      reason: `input is ~${estimatedInputTokens} tokens, over the Mistral free-tier cap of ${cap}. Not truncating.`,
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
 * @param {string} opts.apiKey - MISTRAL_API_KEY (Worker secret)
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.model]
 * @param {number|string} [opts.agentId] - for warning logs only
 * @returns {Promise<{text: string, source: 'mistral', finishReason: string|null,
 *   usage: object|null, rateLimit: object}|null>} null on missing key, 429, or
 *   any other failure.
 */
export async function callMistral({
  apiKey,
  prompt,
  systemPrompt,
  temperature = 0.7,
  maxTokens = 1024,
  model = DEFAULT_MODEL,
  agentId,
}) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] MISTRAL_API_KEY not configured — set it with \`npx wrangler secret put MISTRAL_API_KEY\``);
    return null;
  }

  const caps = checkInputWithinCaps({ prompt, systemPrompt, maxTokens });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] Mistral request refused: ${caps.reason}`);
    return null;
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let res;
  try {
    res = await fetch(`${MISTRAL_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (err) {
    console.warn(`[agent-${agentId}] Mistral request failed: ${err.message}`);
    return null;
  }

  if (res.status === 429) {
    console.warn(`[agent-${agentId}] Mistral 429 — free-tier rate limit hit`);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Mistral API error (${res.status}): ${errText.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();
  return normalizeOpenAiChat({ data, res, source: 'mistral' });
}

/** Uniform descriptor the router's provider registry consumes. */
export const PROVIDER = {
  id: 'mistral',
  kind: 'chat',
  secretName: 'MISTRAL_API_KEY',
  endpoint: MISTRAL_ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  limits: MISTRAL_LIMITS,
  checkInputWithinCaps,
  call: callMistral,
};

export { MISTRAL_ENDPOINT, DEFAULT_MODEL };
