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
 *
 * ── THE DIVISOR WAS 3, AND THE PARAGRAPHS ABOVE WERE WRONG (2026-08-27) ──
 *
 * Everything above is preserved because the REASONING is right and the NUMBER
 * it justified was not. The argument concludes that this estimate is
 * pessimistic. It was optimistic, on precisely the traffic reason 1 names.
 *
 * MEASURED, and by a provider rather than by another estimate. A real
 * `daily_standup` meeting prompt — mixed English and Hebrew, the office context
 * block included — was sent down `routine_volume` on 2026-08-27. Groq refused it
 * and its own tokenizer counted the request in the 413 body:
 *
 *     Groq 413: "... on tokens per minute (TPM): Limit 8000, Requested 21832"
 *     chars/3 on the identical prompt:                          20253
 *
 * 60,759 characters against 21,832 real tokens is **2.783 characters per
 * token** — so `/3` under-counted by **7.8%**, and a cap enforced with it was,
 * in this file's own words, "not enforced".
 *
 * WHY 2.75 AND NOT 2.783. The measured ratio is the point where the estimate
 * becomes exactly right, which is the one place a safety margin must not sit.
 * 2.75 clears the single measurement by ~1.2% and finally makes the direction
 * match the docstring. It is deliberately NOT a large margin: this rests on ONE
 * prompt from ONE tokenizer, so the number is defensible rather than confident,
 * and a second measurement on a different provider should revise it.
 *
 * NOT a real tokenizer, deliberately — that is a dependency and a per-call cost
 * for a function called on every routed request.
 *
 * THE DIVISOR IS A LITERAL IN FOUR FILES, and it stays that way. office-context.js
 * is forbidden by its own verifier from importing this layer at all, so a shared
 * constant cannot reach it; the four copies are held together instead by
 * scripts/verify-office-bureaucracy.js asserting them character-for-character
 * identical. All four moved 3 -> 2.75 in one commit. A future change to one of
 * them that is not made to the others fails a check rather than drifting.
 *
 * ── EVERY BUDGET CALIBRATED AGAINST THE OLD DIVISOR MOVED WITH IT ────────
 *
 * The `BUDGETS` in office-context.js were set by measuring what content fitted,
 * not by converting from a provider ceiling — see their own notes ("At 400 the
 * ADMIN agent shape measured 327 tokens … while dropping deliverables-count and
 * questions-headline outright"). A stricter estimator against unchanged budgets
 * would therefore have silently dropped board sections that fit yesterday, which
 * is a regression introduced by a fix rather than a fix. They were rescaled by
 * the same 3/2.75 ratio in the same commit so the SAME CONTENT still fits and
 * only the number describing it became honest.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 2.75);
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
 * ══════════════════════════════════════════════════════════════════════════
 * THE TWO FIELDS, AND WHY `not_reported` IS NOT `null` (SESSION 13, 2026-08-23)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every model client in this estate now hands back a finish reason and an
 * output-token count. Before today, `groq-client.js` and `gemini-client.js`
 * discarded both at the client, and the consequence was general rather than
 * local: **"the model was cut off" and "the model ignored the instruction"
 * were indistinguishable in the record**, everywhere the office calls a model.
 * `agents/agent-base.js` `queryGroqRouted()` said so in a comment and worked
 * around it structurally instead of fixing it.
 *
 * This estate has already paid for the missing field once. `routeTask()`
 * returned an empty answer as a success for five days because `finishReason`
 * existed on the Cerebras path for exactly that check and was never read
 * (fixed 2026-08-10). The fix was never carried anywhere else.
 *
 * ── THREE STATES, NOT TWO ────────────────────────────────────────────────
 *
 * A field that is simply absent reads as normal, and that is the failure this
 * whole change exists to end. So a missing value is never left to be inferred:
 *
 *   a real value        — the provider reported it, this is what it said
 *   `null`              — the provider HAS this field and did not send it on
 *                         THIS response. An anomaly worth seeing.
 *   `NOT_REPORTED`      — the provider has no equivalent at all, ever. A fact
 *                         about the provider, not about this call.
 *
 * Cloudflare Workers AI is the one chat provider in the registry with no
 * finish reason of any kind, so it is the reason this constant exists rather
 * than being a hypothetical third case. Recording it as `null` would file a
 * permanent property of the provider as a per-call anomaly, and every future
 * reader would go looking for the call that lost it.
 */
export const NOT_REPORTED = 'not_reported';

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
          /*
           * ── SESSION 35, ITEM E — READ, NOT ENABLED (2026-08-29) ──────────
           *
           * How many of `inputTokens` the provider served from ITS OWN prompt
           * cache. `null` on a provider that does not report it, which is not
           * the same fact as zero and must not be rendered as one.
           *
           * **Cerebras' prompt caching is on by default on `gpt-oss-120b` and
           * has no toggle** (verified against inference-docs.cerebras.ai/
           * capabilities/prompt-caching, 2026-08-29): it matches in 128-token
           * blocks, it is scoped to this organisation, **it carries no extra
           * fee and input is billed identically whether cached or not**, and
           * `usage.prompt_tokens_details.cached_tokens` is the only way to see
           * it working. So there was nothing to switch on — the office was
           * already paying (nothing) for it and simply could not observe it.
           *
           * That distinction matters for the brain audit specifically: its
           * five lens calls send a byte-identical harvest slice, which is the
           * one prompt in this office that should hit. Whether it DOES is now
           * a number rather than an expectation.
           *
           * Nothing acts on this field. It is a measurement, and the last
           * caching attempt in this repo (Session 34, items C3/C4, against the
           * office's one paid-model client — deliberately not named here, see
           * verify-providers.js: no module in this set may mention that
           * provider) was reasoned correctly and measured to zero effect.
           * Which is exactly why this one is read before it is believed.
           */
          cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens ?? null,
        }
      : null,
    rateLimit: parseRateLimitHeaders(res),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * IMAGE PROVIDERS (added 2026-08-10, plan 5.1)
 *
 * The Designer (agent 9) is the office's only artist and the bible has said
 * since 2026-08-05 that *"she generates visual assets through the office's
 * image-capable providers, always leaving a provenance note (model, date)"*.
 * No image-capable provider existed anywhere in this repo until this date.
 * Documentation asserted a capability and no code path supplied it — the same
 * shape as the unwired gates in ARCHITECTURAL-DECISIONS.md §7, one level up
 * from code: **a role that was never activated rather than a gate never
 * called.**
 *
 * These two helpers live here, beside normalizeOpenAiChat(), for the reason
 * this module exists at all: the thing that must not diverge between two
 * clients is the SHAPE of what they hand back. An image envelope that differs
 * between providers puts a provider-specific branch into every consumer, and
 * the provenance note is a bible requirement — one renderer, not two that
 * drift.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The envelope EVERY image provider returns, so a caller stays provider-blind
 * exactly as it does for chat.
 *
 * `base64` is the payload and it is deliberately the ONLY representation. The
 * two providers hand back bytes two different ways — Cloudflare's flux models
 * return a JSON body with a base64 string, the SDXL family returns a raw PNG
 * stream, and Gemini returns inline data parts — and a consumer that had to
 * know which would have to know which provider answered. Base64 is also what
 * the GitHub Contents API wants, so the one place this is written to a repo
 * needs no re-encoding step that could corrupt it.
 *
 * `finishReason` mirrors the chat envelope on purpose. It was added to the chat
 * envelope for one stated purpose, was never read for five days, and let an
 * empty answer through as a success (task-router.js routeTask(), fixed
 * 2026-08-10). The image path gets the same field AND its consumer in the same
 * commit — an empty image is checked in routeTask() beside the empty answer.
 */
export function imageEnvelope({
  base64,
  source,
  model,
  mimeType = 'image/png',
  finishReason = null,
  usage = null,
  rateLimit = null,
  revisedPrompt = null,
}) {
  const b64 = String(base64 || '');
  // Padding-aware, because the byte count is what routeTask()'s empty-image
  // guard tests and an off-by-two on a decorative field would be invisible.
  const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  return {
    base64: b64,
    bytes: b64 ? Math.max(0, Math.floor((b64.length * 3) / 4) - padding) : 0,
    mimeType,
    model: model || null,
    source,
    finishReason,
    usage,
    rateLimit,
    revisedPrompt,
    // No `text` field, deliberately. routeTask()'s empty-answer guard keys on
    // `resolved.kind === 'chat'`, so an image result must not carry a `text`
    // that a future edit could make that guard reach for.
  };
}

/**
 * The image type read from the BYTES, not asserted by the caller.
 *
 * ── WHY THIS EXISTS: A FILE WHOSE EXTENSION LIED ─────────────────────────
 *
 * Found 2026-08-10, on the very first asset the office ever committed.
 * `cf-image-client.js` hardcoded `mimeType: 'image/png'` — reasonable, since
 * every Workers AI image model is documented as returning PNG — and the file
 * landed in back-office as `2026-08-10-office-mark.png` carrying `ff d8 ff e0
 * ... JFIF`. It was a JPEG. The bytes were perfect; the NAME was wrong.
 *
 * It is a small bug with a shape this project keeps meeting: **a value asserted
 * by the code that wanted it rather than read from the thing that produced it.**
 * Nothing would have failed. The image opens in every viewer, because viewers
 * sniff. It would have been discovered by whichever tool eventually did not —
 * a build step, a browser with a strict `Content-Type`, or a reviewer wondering
 * why a PNG was 76KB.
 *
 * The Workers AI binding returns bytes and no content type, so the type cannot
 * be *asked for*. It can be *read*. Returns null when the bytes match nothing
 * known, and null means UNKNOWN — the caller then says so instead of picking a
 * plausible extension, which is the whole point.
 */
export function sniffImageMime(base64) {
  const b64 = String(base64 || '');
  if (!b64) return null;
  // 12 bytes is enough for every signature below and costs one small decode.
  let head;
  try {
    head = atob(b64.slice(0, 24));
  } catch {
    return null;
  }
  const b = [];
  for (let i = 0; i < head.length; i += 1) b.push(head.charCodeAt(i));

  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x3c && (b[1] === 0x3f || b[1] === 0x73)) return 'image/svg+xml'; // "<?" or "<s"
  return null;
}

/** The file extension for a sniffed mime type. Returns 'bin' for an unknown
 *  type rather than guessing 'png': a file named `.bin` is obviously wrong and
 *  gets looked at, while a file named `.png` that is not one gets trusted. */
export function extensionForMime(mimeType) {
  switch (mimeType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    default: return 'bin';
  }
}

/**
 * The provenance note the bible requires on every asset.
 *
 * *"always leaving a provenance note (model, date)"* — AGENTS-CHARACTER-CORE-v2.md
 * AGENT 9, and plan item 5.2 repeats it as *"a one-line provenance note (model,
 * prompt date)"*. It is rendered by ONE function so an asset committed by the
 * scheduled path and an asset committed by a supervised trigger cannot carry
 * two different shapes of note.
 *
 * It records the PROMPT as well as the model and the date, which is more than
 * the bible asks for and is the part that makes the note usable: a model name
 * and a date tell you what made an asset and not what it was asked for, so the
 * asset cannot be regenerated or judged against its brief. `role` is recorded
 * because this lane has two of them and *which role produced this* is the fact
 * a reviewer needs first.
 */
export function renderAssetProvenance({
  assetPath,
  prompt,
  model,
  provider,
  role,
  date,
  agent = 'Agent 9 — The Designer',
  bytes = null,
  note = null,
}) {
  const lines = [
    `# Provenance — ${assetPath}`,
    '',
    `- **Asset:** \`${assetPath}\``,
    `- **Generated by:** ${agent}`,
    `- **Model:** \`${model}\` (provider \`${provider}\`, image lane role \`${role}\`)`,
    `- **Date:** ${date}`,
    `- **Prompt:** ${String(prompt || '').replace(/\s+/g, ' ').trim()}`,
  ];
  if (bytes !== null) lines.push(`- **Size:** ${bytes} bytes`);
  if (note) lines.push(`- **Note:** ${note}`);
  lines.push('');
  lines.push('*Required by `AGENTS-CHARACTER-CORE-v2.md` AGENT 9 — "always leaving a'
    + ' provenance note (model, date)" — and by plan item 5.2. Rendered by'
    + ' `office-AI-agents/workers/provider-common.js` `renderAssetProvenance()`, which is'
    + ' the only renderer, so a scheduled asset and a supervised one cannot carry'
    + ' two different shapes of note.*');
  return lines.join('\n');
}
