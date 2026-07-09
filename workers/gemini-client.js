/**
 * Data Center — AI Agent Simulation — Gemini 2.5 Flash-Lite client (reports
 * only) + Cloudflare Workers AI helpers (routing + fallback).
 *
 * `callGemini()` is a thin wrapper around the Google AI Studio
 * "generateContent" REST endpoint. Per the distributed-AI architecture
 * (config/token-economy.json), Gemini is reserved for large-context
 * synthesis — monthly/quarterly/semi-yearly/yearly reports
 * (meeting-engine.js) — and is no longer called for routine per-case agent
 * work (see agent-base.js queryGemini(), which now calls groq-client.js
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

const CF_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/**
 * @param {object} opts
 * @param {string} opts.apiKey - GEMINI_API_KEY (Worker secret)
 * @param {string} opts.model - e.g. "gemini-3.1-flash-lite"
 * @param {string} opts.endpoint - base endpoint, e.g. simulation-config.json GEMINI.api_endpoint
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt] - system instruction (agent personality + state)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.ai] - env.AI (Workers AI binding), used for the 429 fallback
 * @param {boolean} [opts.forceFallback] - skip Gemini entirely and go straight to the
 *   Cloudflare fallback (testing only — see /api/agents/test-gemini)
 * @returns {Promise<{text: string, source: 'gemini'|'cloudflare-fallback'}>}
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

  const url = `${endpoint}/${model}:generateContent?key=${apiKey}`;

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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return { text, source: 'gemini' };
}

/**
 * Cloudflare Workers AI fallback, used when Gemini returns 429 (quota
 * exhausted), when Groq is unavailable for routine case work, or when
 * forceFallback is set. See config/token-economy.json
 * "cloudflare_fallback".
 * @returns {Promise<{text: string, source: 'cloudflare-fallback'}>}
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
  return { text, source: 'cloudflare-fallback' };
}

/**
 * Lightweight case classification/routing call via Cloudflare Workers AI —
 * instant, free, no Gemini/Groq spend. Used by agent-runner.js
 * processCaseBatch() to tag each case with a short triage category before
 * it's dispatched to an agent.
 * @param {object} opts
 * @param {object} opts.ai - env.AI (Workers AI binding)
 * @param {string} opts.caseDescription
 * @returns {Promise<{category: string, source: 'cloudflare-router'}|null>}
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
    return category ? { category, source: 'cloudflare-router' } : null;
  } catch (err) {
    console.warn(`[cf-router] case classification failed: ${err.message}`);
    return null;
  }
}
