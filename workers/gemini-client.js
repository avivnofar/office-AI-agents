/**
 * Data Center — AI Agent Simulation — Gemini 3.1 Flash-Lite client (reports
 * only) + Cloudflare Workers AI helpers (routing + fallback).
 *
 * `callGemini()` is a thin wrapper around the Google AI Studio
 * "generateContent" REST endpoint. Per the distributed-AI architecture
 * (config/token-economy.json), Gemini is reserved for large-context
 * synthesis — monthly/quarterly/semi-yearly/yearly reports
 * (meeting-engine.js) — and is no longer called for routine per-case agent
 * work (see agent-base.js queryGroqRouted(), which calls groq-client.js
 * callGroq() for that). Never called directly by the frontend.
 *
 * Fallback: if Gemini responds with HTTP 429 (quota exhausted — a recurring
 * issue on the free tier, see TOKEN-BUDGET.md), the request is retried once
 * against Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`) via the
 * Worker's native `AI` binding (`wrangler.toml` `[ai] binding = "AI"`) so the
 * simulation can continue rather than halting. No extra credentials needed —
 * the binding is account-scoped like D1/KV. See
 * config/token-economy.json for the fallback's daily limit/reset.
 *
 * `callCFRouter()` uses the same Workers AI binding for lightweight case
 * classification/routing — instant, free, called before a case is dispatched
 * to an agent (see agent-runner.js processCaseBatch()).
 *
 * Status: DRAFT (Phase 1 foundation).
 */

import { NOT_REPORTED } from './provider-common.js';

// EXPORTED 2026-08-23 (Session 14, ITEM C) so the weekly retirement check names
// the identifier from THE ONE PLACE IT IS DEFINED. Workers AI publishes no
// catalogue the `AI` binding can list from inside a Worker, so this one comes
// back `not_checkable` WITH the command that does answer it — reported rather
// than omitted, because a checker that silently skips what it cannot see
// reports the same "0 problems" it would report if everything were fine.
export const CF_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE TWO FIELDS (SESSION 13, 2026-08-23, ITEM B)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * All three functions below now return a finish reason and an output-token
 * count alongside `{ text, source }`. They are ADDITIVE — every existing
 * caller destructures `text` and `source` and is byte-unchanged — and no
 * model, limit, prompt or route moves with them.
 *
 * The three providers reachable through this file report differently, and the
 * difference is recorded rather than flattened:
 *
 *   GEMINI              `candidates[0].finishReason` (STOP / MAX_TOKENS /
 *                       SAFETY / …) and `usageMetadata.candidatesTokenCount`.
 *                       Both real, both were being discarded.
 *   CLOUDFLARE WORKERS  **no finish reason of any kind.** `ai.run()` returns
 *   AI                  `{ response }` and, on some models, a `usage` block.
 *                       So `finishReason` is `NOT_REPORTED` — an explicit fact
 *                       about the provider — and `outputTokens` is whatever
 *                       `usage` carried, or null with
 *                       `outputTokensReported: false` when it carried nothing.
 *
 * An absent field reads as normal. That is the failure this change exists to
 * end, so nothing here is left absent. See provider-common.js's NOT_REPORTED
 * block for why the three states are kept apart.
 */

/**
 * @param {object} opts
 * @param {string} opts.apiKey - GEMINI_API_KEY (Worker secret)
 * @param {string} opts.model - e.g. "gemini-3.1-flash-lite" (gemini-3.5-flash is deprecated — never reintroduce it)
 * @param {string} opts.endpoint - base endpoint, e.g. simulation-config.json GEMINI.api_endpoint
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt] - system instruction (agent personality + state)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.ai] - env.AI (Workers AI binding), used for the 429 fallback
 * @param {boolean} [opts.forceFallback] - skip Gemini entirely and go straight to the
 *   Cloudflare fallback (testing only — see /api/agents/test-gemini)
 * @returns {Promise<{text: string, source: 'gemini'|'cloudflare-fallback',
 *   finishReason: string|null, outputTokens: number|null,
 *   outputTokensReported: boolean, usage: object|null}>}
 */
export async function callGemini({
  apiKey,
  model,
  endpoint,
  prompt,
  systemPrompt,
  temperature = 0.8,
  maxTokens = 1024,
  ai,
  forceFallback = false,
}) {
  if (forceFallback) {
    return callCloudflareFallback({ ai, prompt, systemPrompt, temperature, maxTokens });
  }

  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const url = `${endpoint}/${model}:generateContent`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  // SESSION 41, ITEM B — the key moves from a `?key=` query param to this
  // header (Google's own supported alternative for the Generative Language
  // API). Cloudflare Workers Logs captures every outbound subrequest's URL;
  // a key in the URL is a key in the logs, on every call, forever.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    return callCloudflareFallback({ ai, prompt, systemPrompt, temperature, maxTokens });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  const usage = data?.usageMetadata || null;
  return {
    text,
    source: 'gemini',
    // Gemini DOES have this field, so a missing one is `null` — this response
    // did not carry it — never NOT_REPORTED, which would claim the provider
    // has no such concept. `MAX_TOKENS` here is the state that was previously
    // indistinguishable from a model that simply had little to say.
    finishReason: candidate?.finishReason ?? null,
    outputTokens: usage?.candidatesTokenCount ?? null,
    outputTokensReported: true,
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount ?? null,
          outputTokens: usage.candidatesTokenCount ?? null,
          totalTokens: usage.totalTokenCount ?? null,
        }
      : null,
  };
}

/**
 * Cloudflare Workers AI fallback, used when Gemini returns 429 (quota
 * exhausted), when Groq is unavailable for routine case work, or when
 * forceFallback is set. See config/token-economy.json
 * "cloudflare_fallback".
 * ── THE ONE CHAT PROVIDER WITH NO FINISH REASON ─────────────────────────
 *
 * `ai.run()` returns `{ response }` and nothing that says why generation
 * stopped. That is a property of the binding, not of any given call, so this
 * returns `finishReason: NOT_REPORTED` rather than `null`. The distinction is
 * load-bearing: a null would file a permanent capability gap as a per-call
 * anomaly, and every later reader would go hunting for the call that lost it.
 *
 * `usage` is model-dependent on Workers AI and frequently absent, so
 * `outputTokensReported` says which happened instead of leaving a null to be
 * read as zero.
 *
 * @returns {Promise<{text: string, source: 'cloudflare-fallback',
 *   finishReason: 'not_reported', outputTokens: number|null,
 *   outputTokensReported: boolean, usage: object|null}>}
 */
export async function callCloudflareFallback({ ai, prompt, systemPrompt, temperature, maxTokens }) {
  if (!ai) {
    throw new Error(
      'Cloudflare Workers AI fallback is not configured (missing AI binding — ' +
      'add [ai] binding = "AI" to wrangler.toml)'
    );
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const data = await ai.run(CF_WORKERS_AI_MODEL, {
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  const text = (data?.response || '').trim();
  const usage = data?.usage || null;
  return {
    text,
    source: 'cloudflare-fallback',
    finishReason: NOT_REPORTED,
    outputTokens: usage?.completion_tokens ?? null,
    outputTokensReported: !!usage && usage.completion_tokens !== undefined,
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens ?? null,
          outputTokens: usage.completion_tokens ?? null,
          totalTokens: usage.total_tokens ?? null,
        }
      : null,
  };
}

/**
 * Lightweight case classification/routing call via Cloudflare Workers AI —
 * instant, free, no Gemini/Groq spend. Used by agent-runner.js
 * processCaseBatch() to tag each case with a short triage category before
 * it's dispatched to an agent.
 * @param {object} opts
 * @param {object} opts.ai - env.AI (Workers AI binding)
 * @param {string} opts.caseDescription
 * @returns {Promise<{category: string, source: 'cloudflare-router',
 *   finishReason: 'not_reported', outputTokens: number|null,
 *   outputTokensReported: boolean}|null>}
 *   null if the AI binding is missing or the call fails — callers should
 *   treat routing as best-effort and continue without it.
 */
export async function callCFRouter({ ai, caseDescription }) {
  if (!ai) return null;

  try {
    const data = await ai.run(CF_WORKERS_AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Classify the IT support case in 1-3 words (e.g. "network", "disk", '
            + '"permissions", "linux", "windows", "security"). Reply with only the category, nothing else.',
        },
        { role: 'user', content: caseDescription },
      ],
      temperature: 0.2,
      max_tokens: 16,
    });

    const category = (data?.response || '').trim().split('\n')[0].slice(0, 40);
    const usage = data?.usage || null;
    return category
      ? {
          category,
          source: 'cloudflare-router',
          finishReason: NOT_REPORTED,
          outputTokens: usage?.completion_tokens ?? null,
          outputTokensReported: !!usage && usage.completion_tokens !== undefined,
        }
      : null;
  } catch (err) {
    console.warn(`[cf-router] case classification failed: ${err.message}`);
    return null;
  }
}

/** Re-exported so a caller can compare against the sentinel without
 *  importing provider-common.js directly. */
export { NOT_REPORTED };
