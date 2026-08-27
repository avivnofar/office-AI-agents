/**
 * Data Center — AI Agent Simulation — Groq client (openai/gpt-oss-20b).
 *
 * Primary model for routine per-case agent work (agents 1-4, 5-9, 11 —
 * see agent-base.js queryGroqRouted()). Free tier (~14,400 req/day) — solves
 * the daily Gemini-quota problem for routine cases. Gemini 3.1 Flash-Lite
 * stays reserved for monthly/quarterly reports (large-context synthesis).
 * Never called directly by the frontend. See
 * config/token-economy.json for the model-distribution map.
 *
 * Status: DRAFT (Phase 1 foundation).
 */

import { normalizeOpenAiChat, NOT_REPORTED, parseRateLimitHeaders } from './provider-common.js';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * ── THE FOURTH RETIRED MODEL, 2026-08-09 ──────────────────────────────────
 *
 * Was `llama3-8b-8192` until this date. Groq deprecated it 2025-05-31 and
 * SHUT IT DOWN 2025-08-30 — nearly a year before this was noticed, because
 * the failure was silent by design: callGroq() returns null on any non-OK
 * status and every caller degrades to Cloudflare Workers AI, which answers
 * perfectly well. Nothing was ever broken enough to look at.
 *
 * The live 400 body, captured via `wrangler tail` on 2026-08-09:
 *
 *   {"error":{"message":"The model `llama3-8b-8192` has been decommissioned
 *    and is no longer supported...","type":"invalid_request_error",
 *    "code":"model_decommissioned"}}
 *
 * WHY THE STATUS CODE IS THE WHOLE LESSON: this is a **400**, not a 401. The
 * key authenticated fine — Groq accepted the request and rejected the model.
 * The symptom (every Groq call silently substituted) reads exactly like a
 * dead credential from the outside, and the owner holds four Groq keys with
 * confusable names, so a direct test with the wrong one would have "confirmed"
 * a key fault that did not exist. Read the BODY before blaming a secret; see
 * back-office-AI-agents/docs/decisions/ARCHITECTURAL-DECISIONS.md AD-030.
 *
 * `llama-3.1-8b-instant` is Groq's own documented replacement and was
 * verified present in the live production catalog on 2026-08-09 (131,072-token
 * context, vs. the old model's 8,192). Do not swap this ID without checking
 * the catalog first — this is the FOURTH model this project has had retired
 * out from under it (gemini-3.5-flash, gemini-2.5-flash, cerebras
 * llama-3.3-70b, and now this one).
 *
 * ── THE FIFTH RETIRED MODEL, 2026-08-23 ───────────────────────────────────
 *
 * The paragraph directly above is preserved as written (A15) and it is the most
 * instructive thing in this file, because every word of it was TRUE and it still
 * did not hold for two weeks.
 *
 * `llama-3.1-8b-instant` was Groq's own documented replacement. It WAS verified
 * present in the live production catalog on the day it was adopted. And it was
 * ALREADY ON GROQ'S PUBLISHED DEPRECATION LIST at that same moment, with a
 * shutdown date already set: announced deprecated 2026-06-17, SHUT DOWN
 * 2026-08-16. The 2026-08-09 check asked "is it in the catalogue" and got yes —
 * which is exactly what a healthy model and a model with seven days left both
 * answer. Presence is not health, and nothing here knew the difference.
 *
 * The live 404 body, captured 2026-08-23:
 *
 *   {"error":{"message":"The model `llama-3.1-8b-instant` does not exist or you
 *    do not have access to it.","type":"invalid_request_error",
 *    "code":"model_not_found"}}
 *
 * READ THAT MESSAGE CAREFULLY, BECAUSE IT IS BUILT TO MISLEAD. *"or you do not
 * have access to it"* is Groq's generic wording covering two different causes,
 * and one of them is a credential. It is NOT one here, and the thing that
 * resolves the ambiguity is a fact rather than a judgement: the catalogue
 * listing made with THE SAME KEY on the same day returned 13 models
 * successfully. AD-030 stands — no key rotation was proposed, considered, or
 * needed. Read the body, then read the catalogue.
 *
 * `openai/gpt-oss-20b` is Groq's own named replacement for it, on the same free
 * and developer tiers, and was VERIFIED PRESENT in the live catalogue from
 * inside the Worker on 2026-08-23 before this constant moved.
 *
 * IT IS AN OPEN-WEIGHTS MODEL HOSTED BY GROQ, NOT A CALL TO OPENAI. The
 * `openai/` prefix is the model family's name, not a vendor route: this uses the
 * existing `GROQ_API_KEY` against Groq's own endpoint, and no OpenAI credential
 * exists anywhere in this repo. The naming is genuinely misleading and the
 * question was worth asking; it was answered by making the call, not by citing
 * a page.
 *
 * ── IT IS ALSO A REASONING MODEL, AND NO FLOOR WAS ADDED ────────────────
 *
 * `gpt-oss-20b` reasons; `llama-3.1-8b-instant` did not. That is the one
 * behaviour change riding with this ID, and it is the same property that made
 * Cerebras' `gpt-oss-120b` return an EMPTY answer at small budgets — see
 * `workers/cerebras-client.js` `MIN_OUTPUT_TOKENS`, which exists for exactly
 * that and raises `max_tokens` to a 512 floor.
 *
 * NO SUCH FLOOR IS ADDED HERE, and the reason is a measurement rather than a
 * judgement. The first live routed call on the new model, at `max_tokens: 64` —
 * the SMALLEST budget anywhere in this repo, `routing_test`'s default — returned
 * the text `ok` with `finish_reason: "stop"` and `completion_tokens: 43`. It did
 * not come back empty. Adding a floor to prevent a failure that was tested for
 * and did not occur would be speculation shipped as a guardrail.
 *
 * WHAT THE MEASUREMENT ALSO SHOWS, recorded because the margin is the
 * interesting half: 43 output tokens were spent to say one word, against a
 * budget of 64. Most of that is reasoning. Every production caller passes 512 or
 * more (`callGroq`'s own default is 512; `agent-base.js` 512, `meeting-engine.js`
 * 1024, `judge-sampler.js` 700), so none of them is near this line. A NEW caller
 * that passes a small budget is the case to watch, and the symptom to expect is
 * `finishReason: "length"` with empty or truncated text — which both of those
 * fields now surface, since Session 13.
 *
 * ── AND THIS TIME SOMETHING CHECKS ───────────────────────────────────────
 *
 * `workers/model-catalog.js` (2026-08-23) asks this question of every configured
 * model identifier in the estate, weekly, from
 * `.github/workflows/weekly-capability-audit.yml`. It closes the found-seven-
 * days-LATE case. It does NOT close the found-seven-days-EARLY one — the story
 * above is the proof that a catalogue lookup cannot see a published end date —
 * and it says so in its own header rather than implying more than it does.
 */
// EXPORTED 2026-08-23 (Session 14, ITEM C) so that `workers/model-catalog.js`'s
// weekly retirement check reads the identifier from THE ONE PLACE IT IS
// DEFINED rather than carrying a sixth copy of it. A checker comparing its own
// copy against a provider is checking nothing.
export const GROQ_MODEL = 'openai/gpt-oss-20b';

/**
 * @param {object} opts
 * @param {string} opts.apiKey - GROQ_API_KEY (Worker secret)
 * @param {string} opts.prompt - the user-turn prompt
 * @param {string} [opts.systemPrompt] - system instruction (agent personality + state)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] - kept short (default 512) for routine case work
 * @param {number|string} [opts.agentId] - for warning logs only
 * @param {(info: {status: number|null, rateLimit?: object, error?: string}) => void} [opts.onResponse]
 *   Fired once the API responds, BEFORE the status checks, and again with the
 *   body text on a rejection. task-router.js uses it to count a consumed
 *   free-tier request and to carry the provider's own message into the attempt
 *   trail — see the block at the call site.
 * @returns {Promise<{text: string, source: 'groq', finishReason: string|null,
 *   outputTokens: number|null, usage: object|null, rateLimit: object}|null>}
 *   null on missing key, 429 (quota exhausted), or any other failure — caller
 *   falls back to Cloudflare Workers AI.
 *
 * ── THE TWO FIELDS, ADDED 2026-08-23 (SESSION 13, ITEM B) ────────────────
 *
 * This function used to return `{ text, source }` and throw the rest of the
 * body away. Groq is OpenAI-compatible and has always sent
 * `choices[0].finish_reason` and `usage.completion_tokens`; nothing here read
 * either. `agents/agent-base.js` `queryGroqRouted()` carries a comment saying
 * so — *"neither groq-client.js nor gemini-client.js surfaces a finish reason,
 * so a response cut off at the ceiling is indistinguishable from a short one
 * at the call site"* — and the report pipeline built a structural sentinel to
 * work around it. The field was there the whole time.
 *
 * PURELY ADDITIVE. Every existing caller destructures `text` and `source`; the
 * envelope is a superset, so no caller's behaviour changes. Nothing about the
 * model, the limits, the prompt or the routing moves with it.
 */
export async function callGroq({ apiKey, prompt, systemPrompt, temperature = 0.8, maxTokens = 512, agentId, onResponse }) {
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
    onResponse?.({ status: null, error: String(err?.message || err).slice(0, 200) });
    return null;
  }

  /*
   * ── THE BODY NOW REACHES THE ROUTER (2026-08-27, Session 27 ITEM B) ──────
   *
   * `onResponse` did not exist in this client. cerebras-client.js and
   * mistral-client.js have fired it since the router gained the hook; this file
   * never did, so `task-router.js` routeTask() saw `responded === false` for
   * EVERY Groq outcome and recorded `{ outcome: 'failed', reason: 'no_response',
   * status: null, providerMessage: '' }` — the same trail for a 413, a 429, a
   * decommissioned model and a dead key alike.
   *
   * That is this file's own header turned against itself. It says, about the
   * fourth retired model: "Read the BODY before blaming a secret." The body was
   * written to a console.warn and to nowhere a caller could read it, which is
   * precisely the log-tail race `responseError` was added to routeTask() to end.
   *
   * FOUND BY MEASUREMENT, not by reading. Session 27 sent the real 20,253-token
   * meeting prompt down `routine_volume` to establish Groq's input ceiling and
   * got back `reason=no_response, status=-, msg=""` — blind, on the one provider
   * whose 413 is the documented cause of the meetings defect. The 8,000 TPM
   * limit and the requested-token count were in the response body the whole
   * time, exactly as they were in 2026-08-09's captured 400.
   *
   * TWO EFFECTS, AND THE SECOND IS DELIBERATE. It carries the evidence; and,
   * because it fires BEFORE the status checks, a Groq call that reached the API
   * and was rejected is now recorded with `confirmed: true` rather than
   * `confirmed: false`. That is cerebras-client.js's documented reason for the
   * same placement — "a 429 or 5xx still consumed a free-tier request allowance
   * and must be counted" — and it applies identically here. Groq was
   * under-counting its rejected calls against its own free tier; the correction
   * is in the conservative direction.
   *
   * What does NOT change: the return contract. Every path that returned null
   * still returns null, and no caller's behaviour moves.
   */
  onResponse?.({ status: res.status, rateLimit: parseRateLimitHeaders(res) });

  if (res.status === 429) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Groq 429 — daily quota exhausted: ${errText.slice(0, 300)}`);
    onResponse?.({ status: res.status, error: `429 ${errText.slice(0, 240)}` });
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Groq API error (${res.status}): ${errText.slice(0, 300)}`);
    onResponse?.({ status: res.status, error: `${res.status} ${errText.slice(0, 240)}` });
    return null;
  }

  const data = await res.json();
  // normalizeOpenAiChat() is the SAME normaliser cerebras-client.js and
  // mistral-client.js already use. Reusing it rather than re-reading the body
  // here is the point: the shape of what a chat client hands back must not
  // differ per provider, which is the whole reason provider-common.js exists.
  const norm = normalizeOpenAiChat({ data, res, source: 'groq' });
  return {
    ...norm,
    // Promoted out of `usage` to a named field so a consumer that wants only
    // "how much did the model actually say" does not have to know each
    // provider's usage spelling. `null` here means Groq sent no usage block on
    // this response — an anomaly, not a property of the provider, which is why
    // it is null rather than NOT_REPORTED. See provider-common.js's block.
    outputTokens: norm.usage?.outputTokens ?? null,
    outputTokensReported: true,
  };
}

/** Re-exported so a caller can compare against the sentinel without importing
 *  provider-common.js directly. */
export { NOT_REPORTED };
