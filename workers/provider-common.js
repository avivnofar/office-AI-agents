/**
 * Shared, dependency-free helpers for the free-tier provider clients added
 * 2026-08-05 for task-type routing: github-models-client.js,
 * cerebras-client.js, mistral-client.js, cohere-client.js.
 *
 * WHY A SHARED MODULE RATHER THAN FOUR COPIES: all four clients need the
 * same two primitives, and both are the kind that rot silently when
 * duplicated —
 *
 *   (a) a CONSERVATIVE input-size estimate, so a documented per-request
 *       token cap can be enforced BEFORE a request is sent rather than by
 *       truncating input after (see github-models-client.js's header for
 *       why truncation specifically is forbidden here);
 *   (b) a TOLERANT rate-limit header reader — every provider spells these
 *       headers differently, several spell them inconsistently across
 *       endpoints, and none of them are guaranteed to be present at all.
 *
 * Nothing in this file imports config or any other module, and nothing here
 * makes a network call or holds provider state. That is deliberate: it lets
 * scripts/verify-providers.js import every client directly under plain
 * `node`, the same constraint workers/guide-engine.js satisfies for
 * scripts/verify-guide-engine.js. (workers/model-router.js cannot be
 * imported that way — it imports config/token-economy.json — which is why
 * that verifier reads it as text instead.)
 *
 * Status: added inert. Nothing imports these clients as of this commit.
 */

/**
 * Deliberately PESSIMISTIC token estimate: characters / 3, rounded up.
 *
 * Real tokenizers land nearer chars/4 on English prose, so this
 * over-estimates — on purpose, for two reasons:
 *
 *  1. This office writes Hebrew (gap digests, internal summaries, and every
 *     note composed by queryGeminiDirect()). Hebrew tokenizes materially
 *     worse than English on the tokenizers these providers use, so an
 *     English-calibrated divisor would under-count exactly the traffic most
 *     likely to sit near a cap.
 *  2. A cap enforced with an optimistic estimate is not enforced. It just
 *     moves the failure from our code, where the router can degrade to the
 *     lane's backup, to a provider-side 400, where it becomes a dead call.
 *
 * Over-estimating costs a few borderline requests that get routed to the
 * backup lane instead. Under-estimating costs a silent failure inside a
 * judgment path. The asymmetry is the whole argument.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3);
}

/** Combined conservative estimate for a chat-style request's input side. */
export function estimatePromptTokens({ prompt = '', systemPrompt = '' } = {}) {
  return estimateTokens(prompt) + estimateTokens(systemPrompt);
}

/**
 * Best-effort read of a response's rate-limit headers.
 *
 * Returns nulls rather than guesses — an absent header means "this provider
 * did not tell us", which is a different fact from "zero remaining", and the
 * router must be able to tell those apart. Values that parse as numbers come
 * back as numbers; values that do not (some providers send `60s`, some send
 * an HTTP-date in `retry-after`) come back as the raw string, so a caller
 * can log them without this helper inventing a unit.
 *
 * @param {Response} res
 * @returns {{remainingRequests: number|string|null, limitRequests: number|string|null,
 *            remainingTokens: number|string|null, resetSeconds: number|string|null}}
 */
export function parseRateLimitHeaders(res) {
  const read = (names) => {
    for (const name of names) {
      const raw = res?.headers?.get?.(name);
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      return Number.isFinite(num) ? num : raw;
    }
    return null;
  };

  return {
    remainingRequests: read([
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining',
      'ratelimit-remaining',
    ]),
    limitRequests: read([
      'x-ratelimit-limit-requests',
      'x-ratelimit-limit',
      'ratelimit-limit',
    ]),
    remainingTokens: read([
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-remaining-tokens-minute',
    ]),
    resetSeconds: read([
      'x-ratelimit-reset-requests',
      'x-ratelimit-reset',
      'ratelimit-reset',
      'retry-after',
    ]),
  };
}

/**
 * Normalizes an OpenAI-compatible chat completion body into this repo's
 * response envelope. Three of the four new providers (GitHub Models,
 * Cerebras, Mistral) are OpenAI-compatible, so they share this.
 *
 * The envelope is a SUPERSET of workers/groq-client.js's `{ text, source }`:
 * every existing caller destructures those two fields and is unaffected by
 * the additions. The additions exist because the router needs them —
 *
 *   `finishReason` — so a max_tokens-truncated answer can be REJECTED rather
 *     than parsed as if it were complete. That is not a hypothetical: the
 *     Guides pipeline shipped a bug of exactly this shape and now carries
 *     two dedicated guards against it (see scripts/verify-guide-engine.js's
 *     "Fail-closed publish guards" section).
 *   `usage` — real provider-reported token counts, so the token economy can
 *     record a call on EVIDENCE it happened rather than on the fact that it
 *     was requested.
 *   `rateLimit` — see parseRateLimitHeaders() above.
 */
export function normalizeOpenAiChat({ data, res, source }) {
  const choice = data?.choices?.[0];
  return {
    text: (choice?.message?.content || '').trim(),
    source,
    finishReason: choice?.finish_reason ?? null,
    usage: data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? null,
          outputTokens: data.usage.completion_tokens ?? null,
          totalTokens: data.usage.total_tokens ?? null,
        }
      : null,
    rateLimit: parseRateLimitHeaders(res),
  };
}
