/**
 * Data Center — AI Agent Simulation — Cohere client.
 *
 * Added 2026-08-05 (task-type routing session). EMBEDDINGS AND SEMANTIC
 * SEARCH ONLY — https://api.cohere.com/v2/embed, authenticated with the
 * COHERE_API_KEY Worker secret.
 *
 * ── THIS MODULE HAS NO CHAT FUNCTION, AND THAT IS ON PURPOSE ─────────────
 *
 * Cohere sells a chat API too. This module deliberately does not wrap it.
 * The routing table gives Cohere exactly one lane — embeddings / semantic
 * search — and gives that lane NO backup: if embeddings are unavailable the
 * call fails rather than degrading to some other provider's vectors.
 *
 * That "no backup" is a correctness rule, not an oversight. Embeddings from
 * two different models are not interchangeable: vectors from model A and
 * model B do not share a space, so a similarity score computed across them
 * is meaningless — and meaningless in the worst way, because it still
 * returns a confident-looking number between 0 and 1. Silently degrading an
 * embeddings call to a backup provider would corrupt a search index rather
 * than slow it down. Failing loudly is the only safe degradation.
 *
 * ── IT WILL HAVE NO CALLERS FOR A WHILE, AND THAT IS EXPECTED ────────────
 *
 * This client exists for two capabilities that are DESIGNED BUT NOT BUILT:
 *
 *   · the local brain's search — semantic retrieval across
 *     campus/agents/<NN-slug>/adaptations/ in back-office-AI-agents, so the
 *     QA and Team Lead can find the relevant prior adaptation during the
 *     daily review instead of re-reading every file;
 *   · cross-report comparison — the Lead QA's weekly instrument, comparing
 *     report quality across agents AND across embodiment models
 *     (plans/OFFICE-SCALING-TODO.md items 1.5 and 2.7).
 *
 * Neither exists yet. Until one of them is built this module is dead code
 * with a live key, which is a deliberate and stated condition rather than an
 * accident to be cleaned up. It ships now because it ships with the other
 * three clients, on the one set of secrets the owner installs once.
 *
 * ── ERROR SEMANTICS ──────────────────────────────────────────────────────
 *
 * Same as workers/groq-client.js: failures return `null` after a
 * console.warn, never a throw. "Fail, don't degrade" is about ROUTING — the
 * router must not substitute another provider — not about crashing a tick.
 *
 * Status: added inert. Nothing imports this module as of this commit, and
 * nothing is expected to until the local brain's search is built.
 */

import { estimateTokens, parseRateLimitHeaders } from './provider-common.js';

const COHERE_ENDPOINT = 'https://api.cohere.com/v2';

/**
 * MULTILINGUAL by default, not the English model. The corpus this will
 * actually index is bilingual: the office's internal notes, gap digests and
 * summaries are HEBREW by standing rule, while guides, adaptations and the
 * Front are English. An English-only embedding model would quietly produce
 * poor vectors for exactly the Hebrew half — poor, not absent, which is the
 * hard failure mode to notice.
 *
 * VERIFIED against the live catalog on 2026-08-06 — present, alongside
 * embed-v4.0 and the light/english variants. A live call returned a
 * 1024-dimension vector.
 */
const DEFAULT_MODEL = 'embed-multilingual-v3.0';

/**
 * Free-tier limits. Mirrored in config/token-economy.json's
 * `providers.cohere` block; scripts/verify-providers.js asserts the two
 * agree.
 *
 * MEASURED 2026-08-06 from live response headers on a v2/embed call:
 *   x-trial-endpoint-call-limit     100   (per minute)
 *   x-endpoint-monthly-call-limit  1000   (per MONTH)
 *
 * ── THIS IS A TRIAL KEY, NOT A FREE PRODUCTION TIER ──────────────────────
 *
 * The header is literally named `x-trial-endpoint-call-limit`. Trial keys are
 * rate-limited harder than production keys, are not licensed for production
 * use under Cohere's terms, and can be expired or revoked on a schedule this
 * repo does not control. If the local brain's semantic search ever becomes
 * load-bearing, moving to a production key is an OWNER decision under the
 * overtime rule — not a config edit.
 *
 * ── THE CAP IS MONTHLY, AND THAT IS WHY requests_per_day DOES NOT EXIST ──
 *
 * 1000 calls per MONTH is the real allowance, and there is no honest daily
 * equivalent. Dividing by 30 gives ~33/day, and the router's 60% soft stop
 * would then refuse at ~20 calls/day while 980 monthly calls sat unused;
 * treating it as a daily number would let one busy day spend the whole month.
 * So workers/task-router.js's capFor() reads `requests_per_month` and buckets
 * this provider's counter as '<provider>#YYYY-MM'. Cohere is the only
 * provider in this repo on a monthly period.
 */
export const COHERE_LIMITS = {
  maxInputTokensPerRequest: null,
  maxTextsPerRequest: null,
  requestsPerMinute: 100,
  requestsPerDay: null,
  requestsPerMonth: 1000,
  embeddingDimensions: 1024,
  trialKey: true,
  resetUtc: null,
  paid: false,
};

/** Valid Cohere v2 `input_type` values. Using the wrong one silently degrades
 * retrieval quality: a corpus embedded as a query, or vice versa, still
 * returns vectors — just worse ones. */
export const INPUT_TYPES = ['search_document', 'search_query', 'classification', 'clustering'];

/**
 * Network-free cap verdict, same signature as the chat clients so the router
 * can call it uniformly. Accepts `texts` (this is a batch API) and falls back
 * to `prompt` so a caller holding the chat-shaped options object still gets a
 * sane answer.
 */
export function checkInputWithinCaps({ texts = null, prompt = '', maxTexts = null } = {}) {
  const items = Array.isArray(texts) ? texts : (prompt ? [prompt] : []);
  const estimatedInputTokens = items.reduce((sum, t) => sum + estimateTokens(t), 0);
  const capTexts = maxTexts ?? COHERE_LIMITS.maxTextsPerRequest;
  const capTokens = COHERE_LIMITS.maxInputTokensPerRequest;

  if (capTexts !== null && items.length > capTexts) {
    return {
      ok: false,
      estimatedInputTokens,
      textCount: items.length,
      reason: `batch of ${items.length} texts is over the Cohere per-request cap of ${capTexts}. Not dropping any — split the batch.`,
    };
  }

  if (capTokens !== null && estimatedInputTokens > capTokens) {
    return {
      ok: false,
      estimatedInputTokens,
      textCount: items.length,
      reason: `batch is ~${estimatedInputTokens} tokens, over the Cohere per-request cap of ${capTokens}. Not truncating — split the batch.`,
    };
  }

  return {
    ok: true,
    estimatedInputTokens,
    textCount: items.length,
    reason: null,
    capUnknown: capTexts === null && capTokens === null,
  };
}

/**
 * Embeds a batch of texts.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - COHERE_API_KEY (Worker secret)
 * @param {string[]} opts.texts - the batch to embed
 * @param {'search_document'|'search_query'|'classification'|'clustering'} [opts.inputType]
 *   REQUIRED by the v2 API and it matters — see INPUT_TYPES above. Defaults to
 *   'search_document' (indexing a corpus); pass 'search_query' when embedding
 *   the thing being searched FOR.
 * @param {string} [opts.model]
 * @param {number|string} [opts.agentId] - for warning logs only
 * @returns {Promise<{embeddings: number[][], model: string, source: 'cohere',
 *   usage: object|null, rateLimit: object}|null>} null on missing key, refused
 *   caps, bad input type, 429, or any other failure. The caller must NOT
 *   substitute another provider's vectors — see the header.
 */
export async function callCohereEmbed({
  apiKey,
  texts,
  inputType = 'search_document',
  model = DEFAULT_MODEL,
  agentId,
  onResponse,
}) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] COHERE_API_KEY not configured — set it with \`npx wrangler secret put COHERE_API_KEY\``);
    return null;
  }

  if (!Array.isArray(texts) || texts.length === 0) {
    console.warn(`[agent-${agentId}] Cohere embed called with no texts — nothing to embed`);
    return null;
  }

  if (!INPUT_TYPES.includes(inputType)) {
    console.warn(`[agent-${agentId}] Cohere embed refused: input_type "${inputType}" is not one of ${INPUT_TYPES.join('/')}`);
    return null;
  }

  const caps = checkInputWithinCaps({ texts });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] Cohere embed refused: ${caps.reason}`);
    return null;
  }

  let res;
  try {
    res = await fetch(`${COHERE_ENDPOINT}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        texts,
        input_type: inputType,
        embedding_types: ['float'],
      }),
    });
  } catch (err) {
    console.warn(`[agent-${agentId}] Cohere request failed: ${err.message}`);
    return null;
  }

  // Fires before the status checks: a 429 or 5xx still consumed a free-tier
  // request allowance and must be counted. See task-router.js.
  onResponse?.({ status: res.status, rateLimit: parseRateLimitHeaders(res) });

  if (res.status === 429) {
    console.warn(`[agent-${agentId}] Cohere 429 — free-tier rate limit hit`);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Cohere API error (${res.status}): ${errText.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();
  const embeddings = data?.embeddings?.float || [];

  if (embeddings.length !== texts.length) {
    console.warn(`[agent-${agentId}] Cohere returned ${embeddings.length} embeddings for ${texts.length} texts — refusing a partial batch rather than misaligning vectors with their sources`);
    return null;
  }

  return {
    embeddings,
    model,
    source: 'cohere',
    usage: data?.meta?.billed_units
      ? { inputTokens: data.meta.billed_units.input_tokens ?? null, outputTokens: null, totalTokens: null }
      : null,
    rateLimit: parseRateLimitHeaders(res),
  };
}

/** Uniform descriptor the router's provider registry consumes. `kind` is
 * 'embeddings', which is how the router knows this provider can never serve a
 * chat lane — including as a backup. */
export const PROVIDER = {
  id: 'cohere',
  kind: 'embeddings',
  secretName: 'COHERE_API_KEY',
  endpoint: COHERE_ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  limits: COHERE_LIMITS,
  checkInputWithinCaps,
  call: callCohereEmbed,
};

export { COHERE_ENDPOINT, DEFAULT_MODEL };
