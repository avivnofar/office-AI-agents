/**
 * Data Center — AI Agent Simulation — Gemini IMAGE client.
 *
 * Added 2026-08-10 (plan item 5.1). The `polish` role of the `image` lane,
 * authenticated with the GEMINI_API_KEY Worker secret — the same secret the
 * Hebrew-composition lane and the Notebook-X asks already use.
 *
 * ── THE POLISH ROLE. THIS IS NOT A FALLBACK FOR CLOUDFLARE ───────────────
 *
 * Owner decision, 2026-08-10: **Cloudflare Workers AI by default, Gemini for
 * polish and final touches.** Those are two ROLES, and
 * `config/model-routing.json`'s `image` lane expresses them as roles rather
 * than as a primary/backup pair. Each role resolves to exactly one candidate.
 *
 * **A role never degrades to the other role.** Same family of rule as the
 * embeddings lane's "fail, don't degrade", and the reasoning transfers exactly:
 * substituting a fresh draft for a requested polish pass returns a plausible
 * image that is not the thing that was asked for — wrong in the worst way,
 * because it looks like an answer. A caller that asks for `polish` and cannot
 * have it is told so and stops.
 *
 * ── TWO CAPABILITIES, AND THEY ARE NOT THE SAME CALL ─────────────────────
 *
 * `generateImage()`     text -> image, same shape as the draft role.
 * `polishImage()`       image + instruction -> image. THIS is the role's actual
 *                       job: it takes the draft's bytes back in as an inline
 *                       data part and asks for a revision. A "polish" that
 *                       ignored the draft and re-generated from the prompt would
 *                       be a second draft wearing the polish role's name, which
 *                       is precisely the silent substitution the role split
 *                       exists to prevent — so polishImage() REFUSES a call with
 *                       no input image rather than falling back to generation.
 *
 * ── THE MODEL ID IS NOT WRITTEN FROM MEMORY ──────────────────────────────
 *
 * This project has had FOUR model IDs retired out from under it — two Gemini
 * (`gemini-3.5-flash`, then `gemini-2.5-flash`), Cerebras' `llama-3.3-70b`
 * which never existed on the key at all, and Groq's `llama3-8b-8192`, whose
 * HTTP 400 `model_decommissioned` was misread as a dead key for eleven months.
 * AD-030 makes "does the model ID still exist in the provider's live catalog?"
 * the FIRST of four mandatory checks before an auth failure may even be
 * attributed to a key.
 *
 * So this module ships `listImageCapableModels()` — a live `GET /v1beta/models`
 * read-back — and `DEFAULT_MODEL` was set from its output on 2026-08-10 rather
 * than from anybody's recollection. See the constant's own note for the
 * verification and the alternatives that were live beside it.
 *
 * ── FREE TIER, AND THE ONE THING THAT COULD MAKE THIS UNUSABLE ───────────
 *
 * Every provider in this repo stays on its free tier and there is no automatic
 * escalation to a paid one, for any provider, ever. Gemini's free tier covers
 * image *generation* on the flash-image models at a low daily request count, and
 * that count is **not published in a header this client can read**. So
 * `requestsPerDay` is null, the router paces this provider by wall clock, and a
 * 429 is treated as the free tier being spent — refused and logged, never
 * retried into an overage.
 *
 * ── ERROR SEMANTICS ──────────────────────────────────────────────────────
 *
 * Identical to workers/gemini-client.js and every other client here: failures
 * return `null` after a console.warn, never a throw.
 */

import { imageEnvelope, parseRateLimitHeaders, sniffImageMime } from './provider-common.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * VERIFIED against the live catalog on 2026-08-10 via
 * `listImageCapableModels()` below, called from inside the Worker with the
 * GEMINI_API_KEY the Worker actually holds — not with a key from a `.env` or a
 * chat scrollback. That distinction is AD-030's: *a secret you cannot read is a
 * secret you cannot verify*, so the only meaningful catalog check is the one
 * made by the thing that will make the call.
 *
 * The read-back is recorded in the session log; `{"type":"image_catalog"}`
 * re-runs it at any time and makes no generation call.
 *
 * NOTE ON THE TEXT MODELS: this repo standardised on `gemini-3.1-flash-lite`
 * for text and both `gemini-3.5-flash` and `gemini-2.5-flash` are DEPRECATED and
 * must never be reintroduced. That standard is about the TEXT lanes. Image
 * generation is a different model family and this constant does not touch it.
 */
export const DEFAULT_MODEL = 'gemini-3-pro-image-preview';

/**
 * Free-tier limits. Mirrored in `config/token-economy.json`'s
 * `providers.gemini_images` block; `scripts/verify-providers.js` asserts the two
 * agree.
 *
 * Every null is an honest null — THIS REPO DOES NOT KNOW the number, which is a
 * different statement from "unlimited" and is the one the router is required to
 * act on (owner instruction, 2026-08-05). A null cap switches the provider onto
 * 20s wall-clock pacing instead of a count check; filling a real number into the
 * config switches it back automatically with no code change.
 *
 * `sharedAllowanceWith: 'gemini'` is the load-bearing entry. This is the SAME
 * API key as the Hebrew-composition lane, the report synthesis and the
 * Notebook-X asks, whose quota `workers/gemini-pacer.js` already paces at 20s
 * *because two consumers this repo cannot observe share it*. Image calls are a
 * THIRD consumer on that key. Recorded here so that "why did the gap digests
 * start getting paced out" has an answer that does not require an incident.
 */
export const GEMINI_IMAGE_LIMITS = {
  maxPromptChars: 4000,
  maxInputImages: 3,
  requestsPerMinute: null,
  requestsPerDay: null,
  sharedAllowanceWith: 'gemini',
  resetIsrael: '11:00',
  paid: false,
};

/**
 * Network-free cap verdict, same signature as every other client. Refuses
 * rather than truncating, for the reason cf-image-client.js states: a truncated
 * image prompt does not fail, it draws the wrong thing confidently.
 *
 * ── IT READS `instruction` AS WELL AS `prompt`, AND IT HAS TO ─────────────
 *
 * Caught by `scripts/verify-routing.js` §8d on 2026-08-10, before this ever ran
 * live. This function is called by the ROUTER through
 * `PROVIDER_REGISTRY['gemini-images'].checkInputWithinCaps`, ahead of `invoke`,
 * against the caller's whole options object. A polish call carries its text in
 * `instruction` — not in `prompt`, deliberately, because "make the type larger"
 * and "a logo for the office" are different fields for a reason. Reading only
 * `prompt` therefore refused every legitimate polish call with *"no prompt"*, and
 * the provider was never reached.
 *
 * The shape of that bug is this project's own: a check written against one
 * caller's field names, applied to another caller, refusing correct work for a
 * reason that was never true. It is recorded here because the fix is one line and
 * the lesson is not — **a cap check the router calls uniformly must accept every
 * shape the router can hand it.**
 */
export function checkInputWithinCaps({ prompt = '', instruction = null, inputImages = null } = {}) {
  // instruction wins when present: a polish call's text lives there.
  const text = instruction || prompt;
  const chars = String(text || '').length;
  const images = Array.isArray(inputImages) ? inputImages.length : 0;

  if (!chars) {
    return { ok: false, promptChars: 0, reason: 'no prompt or instruction — there is nothing to draw or revise', capUnknown: false };
  }
  if (chars > GEMINI_IMAGE_LIMITS.maxPromptChars) {
    return {
      ok: false,
      promptChars: chars,
      reason: `prompt is ${chars} characters, over the ${GEMINI_IMAGE_LIMITS.maxPromptChars} cap this client enforces. Not truncating.`,
      capUnknown: false,
    };
  }
  if (images > GEMINI_IMAGE_LIMITS.maxInputImages) {
    return {
      ok: false,
      promptChars: chars,
      reason: `${images} input images is over the per-request cap of ${GEMINI_IMAGE_LIMITS.maxInputImages}. Not dropping any — send fewer.`,
      capUnknown: false,
    };
  }
  return { ok: true, promptChars: chars, inputImages: images, reason: null, capUnknown: true };
}

/**
 * Live catalog read-back — AD-030 check 1, as code rather than as a habit.
 *
 * Makes no generation call and costs no image quota.
 *
 * ── IT REPORTS TWO LISTS, AND THE SECOND ONE IS AN ADMISSION ──────────────
 *
 * `imageCapable` is the STRUCTURAL answer: models whose
 * `supportedGenerationMethods` include `predict` (the Imagen family) or which
 * declare an IMAGE output modality. A structural test is the right primary,
 * because a name test would keep calling a retired `…-flash-image` model
 * image-capable and would miss a rename.
 *
 * **On the live catalog, 2026-08-10, the structural test found only three
 * models — all three Imagen — and missed every one that actually works.** The
 * `models.list` response does not populate `outputModalities` for the
 * flash-image / pro-image family, so `gemini-3-pro-image-preview` (the model this
 * client uses, live-verified by a real generation the same day),
 * `gemini-3-pro-image`, `gemini-3.1-flash-image` and `gemini-2.5-flash-image` all
 * report `outputs: null` and no `predict` method. They are image models and the
 * catalog does not say so in any field this code can read.
 *
 * So `nameCandidates` exists, it is derived from the name, and it is LABELLED as
 * name-derived rather than quietly merged into the structural list. Two lists
 * that disagree is the honest output here; one list that looks authoritative and
 * is missing the working model is how a later session concludes the configured
 * model does not exist and reaches for the key.
 *
 * **`defaultModelPresent` is the check that actually matters**, and it is
 * computed against `all` — the raw catalog — not against either subset. "Is the
 * ID this client is configured with in the catalog at all" is the question
 * AD-030 asks, and it is answerable without classifying anything.
 *
 * @returns {Promise<{ok: boolean, total?: number, imageCapable?: Array,
 *   nameCandidates?: string[], all?: string[], defaultModelPresent?: boolean,
 *   reason?: string, status?: number, body?: string}>}
 */
export async function listImageCapableModels({ apiKey, agentId }) {
  if (!apiKey) {
    return { ok: false, reason: 'missing_credential:GEMINI_API_KEY' };
  }

  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/models?key=${apiKey}&pageSize=1000`, {
      headers: { 'User-Agent': 'data-center-agent-sim' },
    });
  } catch (err) {
    return { ok: false, reason: `transport_error: ${String(err?.message || err).slice(0, 200)}` };
  }

  if (!res.ok) {
    // The FULL body, not the status. AD-030 check 2: a retired model and a bad
    // key are indistinguishable from a status code alone, and discarding the
    // body is what destroys the evidence needed to tell them apart.
    const body = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Gemini catalog read failed (${res.status}): ${body.slice(0, 400)}`);
    return { ok: false, reason: 'catalog_error', status: res.status, body: body.slice(0, 600) };
  }

  const data = await res.json().catch(() => null);
  const models = data?.models || [];
  const imageCapable = models
    .filter((m) => {
      const methods = m.supportedGenerationMethods || [];
      const outputs = (m.outputModalities || m.supportedOutputModalities || []).map((x) => String(x).toUpperCase());
      // `predict` is the Imagen family's method; an IMAGE output modality is
      // what the flash-image family declares. Either qualifies.
      return methods.includes('predict') || outputs.includes('IMAGE');
    })
    .map((m) => ({
      name: String(m.name || '').replace(/^models\//, ''),
      methods: m.supportedGenerationMethods || [],
      outputs: m.outputModalities || m.supportedOutputModalities || null,
      displayName: m.displayName || null,
    }));

  const all = models.map((m) => String(m.name || '').replace(/^models\//, ''));

  // Name-derived, and labelled as such. See the header: the catalog does not
  // populate an output modality for the flash-image / pro-image family, so the
  // structural test above misses every model that actually generates images
  // through generateContent. Excludes video (`veo`) and audio (`lyria`, `tts`).
  const nameCandidates = all.filter((n) => /image|nano-banana|imagen/i.test(n) && !/veo|lyria|tts|audio/i.test(n));

  return {
    ok: true,
    total: models.length,
    imageCapable,
    nameCandidates,
    _two_lists_why: imageCapable.length < nameCandidates.length
      ? 'The STRUCTURAL list is shorter than the name-derived one because models.list does not populate outputModalities for the flash-image/pro-image family. Both are reported rather than merged: a single authoritative-looking list that omits the working model is how a session concludes the configured ID is gone and reaches for the key. Verify a candidate with one real generation, never by its name.'
      : 'The structural list covers the name-derived one; no admission needed this time.',
    all,
    defaultModelPresent: all.includes(DEFAULT_MODEL),
    defaultModel: DEFAULT_MODEL,
  };
}

/** Pulls the first inline image part out of a generateContent response. Returns
 *  null rather than an empty string when there is none, so the caller's refusal
 *  is about a missing image and not about a falsy string. */
function firstInlineImage(data) {
  for (const cand of data?.candidates || []) {
    for (const part of cand?.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) return { base64: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
    }
  }
  return null;
}

/** The text the model returned alongside the image, if any — these models
 *  narrate what they changed, and for a polish pass that narration is the most
 *  useful line in the provenance note. */
function firstText(data) {
  for (const cand of data?.candidates || []) {
    for (const part of cand?.content?.parts || []) {
      if (typeof part.text === 'string' && part.text.trim()) return part.text.trim();
    }
  }
  return null;
}

/** Shared request path for both capabilities. `parts` is already assembled so
 *  the two entry points differ only in what they put in it — which keeps the
 *  polish/generate distinction in the CALLERS' contracts and out of a branch in
 *  here that a later edit could collapse. */
async function callGeminiImageApi({ apiKey, model, parts, agentId, onResponse, label }) {
  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'data-center-agent-sim' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
  } catch (err) {
    console.warn(`[agent-${agentId}] Gemini image ${label} request failed: ${String(err?.message || err).slice(0, 300)}`);
    onResponse?.({ status: null, error: String(err?.message || err).slice(0, 200) });
    return null;
  }

  // Fires before the status checks: a 429 or a 5xx still consumed free-tier
  // allowance and must be counted. Same rule cohere-client.js states.
  onResponse?.({ status: res.status, rateLimit: parseRateLimitHeaders(res) });

  if (res.status === 429) {
    // The free tier is spent. THERE IS NO ESCALATION. This returns null, the
    // router logs the refusal, and the role does NOT degrade to the draft
    // provider — a polish request answered by a fresh draft is the silent
    // substitution this lane's role split exists to prevent.
    console.warn(`[agent-${agentId}] Gemini image ${label}: HTTP 429 — free-tier allowance spent for now. Refused, not retried, and NOT degraded to the draft role. No paid tier, ever.`);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[agent-${agentId}] Gemini image ${label} error (${res.status}) on model "${model}": ${body.slice(0, 400)}`);
    // The BODY reaches the caller, not just the status. AD-030 check 2: a
    // retired model, a model the free tier cannot use, and a rejected key all
    // produce a 4xx, and only the body says which. The router puts this in the
    // attempt trail (task-router.js onResponse) so a supervised test reads it
    // from its own response instead of racing a log tail.
    onResponse?.({ status: res.status, error: `${res.status} ${body.slice(0, 240)}` });
    return null;
  }

  const data = await res.json().catch(() => null);
  const img = firstInlineImage(data);
  const finishReason = data?.candidates?.[0]?.finishReason || null;

  if (!img) {
    onResponse?.({
      status: 200,
      error: `200 with no image part (finishReason=${finishReason || 'null'}${data?.promptFeedback?.blockReason ? `, blockReason=${data.promptFeedback.blockReason}` : ''})`,
    });
    // A 200 with no image in it. This is exactly the shape that let an empty
    // chat answer pass as a success for five days (task-router.js, fixed
    // 2026-08-10): a well-formed envelope with nothing in it. Refused here AND
    // guarded again in routeTask() — two independent checks, because one of them
    // being deleted must not open the path.
    console.warn(`[agent-${agentId}] Gemini image ${label}: HTTP 200 with NO image part (finishReason=${finishReason || 'null'}${data?.promptFeedback?.blockReason ? `, blockReason=${data.promptFeedback.blockReason}` : ''}) — refusing rather than returning an empty asset`);
    return null;
  }

  /*
   * This API DOES declare a mime type, and the bytes are still checked against
   * it. Not distrust for its own sake: `cf-image-client.js` shipped an asserted
   * `image/png` that turned out to be a JPEG, and the lesson generalises —
   * **the bytes are the fact and everything else is a claim about them.** Where
   * the two disagree the bytes win and the disagreement is logged, because a
   * provider whose declared type drifts from its output is worth knowing about
   * before it is worth debugging.
   */
  const sniffed = sniffImageMime(img.base64);
  if (sniffed && img.mimeType && sniffed !== img.mimeType) {
    console.warn(`[agent-${agentId}] Gemini image ${label}: declared mimeType "${img.mimeType}" but the bytes are "${sniffed}" — trusting the bytes`);
  }

  return imageEnvelope({
    base64: img.base64,
    source: 'gemini-images',
    model,
    mimeType: sniffed || img.mimeType,
    finishReason,
    usage: data?.usageMetadata
      ? {
          inputTokens: data.usageMetadata.promptTokenCount ?? null,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? null,
          totalTokens: data.usageMetadata.totalTokenCount ?? null,
        }
      : null,
    rateLimit: parseRateLimitHeaders(res),
    revisedPrompt: firstText(data),
  });
}

/**
 * Text -> image on the polish provider.
 *
 * Present because the polish role must be exercisable on its own — a verifier
 * and a supervised test need to reach this provider without first producing a
 * draft — and because the Designer may legitimately want a final asset drawn
 * here directly. It is NOT the role's main job; see polishImage().
 */
export async function callGeminiImage({ apiKey, prompt, model = DEFAULT_MODEL, agentId, onResponse }) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] GEMINI_API_KEY not configured — set it with \`npx wrangler secret put GEMINI_API_KEY\``);
    return null;
  }
  const caps = checkInputWithinCaps({ prompt });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] Gemini image refused: ${caps.reason}`);
    return null;
  }
  return callGeminiImageApi({
    apiKey, model, agentId, onResponse, label: 'generate',
    parts: [{ text: prompt }],
  });
}

/**
 * Image + instruction -> image. **The polish role's actual job.**
 *
 * REFUSES a call with no input image. That refusal is the whole point of the
 * role split: without it, "polish" degrades to "generate again", the caller gets
 * a plausible image back, and nothing anywhere reports that the draft it was
 * asked to improve was never looked at.
 *
 * @param {object} opts
 * @param {string} opts.instruction - what to change. Not the original prompt —
 *   the original is already in the pixels, and repeating it invites a redraw.
 * @param {Array<{base64: string, mimeType?: string}>} opts.inputImages
 */
export async function polishImage({
  apiKey,
  instruction,
  inputImages,
  model = DEFAULT_MODEL,
  agentId,
  onResponse,
}) {
  if (!apiKey) {
    console.warn(`[agent-${agentId}] GEMINI_API_KEY not configured — the image lane's polish role cannot run`);
    return null;
  }

  const images = (inputImages || []).filter((i) => i && typeof i.base64 === 'string' && i.base64.length > 0);
  if (!images.length) {
    console.warn(`[agent-${agentId}] polishImage() refused: no input image. A polish pass with nothing to polish would be a fresh draft returned under the polish role's name — refused rather than degraded (see this module's header).`);
    return null;
  }

  const caps = checkInputWithinCaps({ instruction, inputImages: images });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] Gemini image polish refused: ${caps.reason}`);
    return null;
  }

  return callGeminiImageApi({
    apiKey, model, agentId, onResponse, label: 'polish',
    parts: [
      { text: instruction },
      ...images.map((i) => ({ inlineData: { mimeType: i.mimeType || 'image/png', data: i.base64 } })),
    ],
  });
}

/** Uniform descriptor the router's provider registry consumes. `kind` is
 *  'image' — the guard that keeps this provider out of every chat lane and out
 *  of the embodiment shuffle, enforced independently in `resolveLane()` and in
 *  `assignEmbodiment()`. */
export const PROVIDER = {
  id: 'gemini-images',
  kind: 'image',
  secretName: 'GEMINI_API_KEY',
  endpoint: GEMINI_ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  limits: GEMINI_IMAGE_LIMITS,
  checkInputWithinCaps,
  call: callGeminiImage,
  polish: polishImage,
  role: 'polish',
};

export { GEMINI_ENDPOINT };
