/**
 * Data Center — AI Agent Simulation — Groq client (llama3-8b-8192).
 *
 * Primary model for routine per-case agent work (agents 1-4, 5-9, 11 —
 * see agent-base.js queryGemini()). Free tier (~14,400 req/day) — solves
 * the daily Gemini-quota problem for routine cases. Gemini 3.1 Flash-Lite
 * stays reserved for monthly/quarterly reports (large-context synthesis).
 * Never called directly by the frontend. See
 * config/token-economy.json for the model-distribution map.
 *
 * Status: DRAFT (Phase 1 foundation).
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama3-8b-8192';

/**
 * @param {object} opts
 * @param {string} opts.apiKey - GROQ_API_KEY (Worker secret)
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt] - system instruction (agent personality + state)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] - kept short (default 512) for routine case work
 * @param {number|string} [opts.agentId] - for warning logs only
 * @returns {Promise<{text: string, source: 'groq'}|null>} null on missing
 *   key, 429 (quota exhausted), or any other failure — caller falls back
 *   to Cloudflare Workers AI.
 */
export async function callGroq({ apiKey, prompt, systemPrompt, temperature = 0.8, maxTokens = 512, agentId }) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] GROQ_API_KEY not configured`);
    return null;
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let res;
  try {
    res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (err) {
    console.warn(`[agent-${agentId}] Groq request failed: ${err.message}`);
    return null;
  }

  if (res.status === 429) {
    console.warn(`[agent-${agentId}] Groq 429 — daily quota exhausted`);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Groq API error (${res.status}): ${errText.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();
  const text = (data?.choices?.[0]?.message?.content || '').trim();
  return { text, source: 'groq' };
}
