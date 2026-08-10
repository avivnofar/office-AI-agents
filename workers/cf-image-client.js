/**
 * Data Center — AI Agent Simulation — Cloudflare Workers AI IMAGE client.
 *
 * Added 2026-08-10 (plan item 5.1). Text-to-image through the account-scoped
 * `AI` binding — no secret, no endpoint, no credential of its own.
 *
 * ── WHY THIS EXISTS, AND WHAT IT SAYS ABOUT THE PROJECT ──────────────────
 *
 * The Designer (agent 9) has existed on paper since 2026-06 and had never
 * worked. Not blocked — she never had the means. `AGENTS-CHARACTER-CORE-v2.md`
 * AGENT 9 says she *"generates visual assets through the office's image-capable
 * providers"*; **no image-capable provider was wired anywhere in this repo**,
 * plan 5.1 specified one and it was never built, and four board tasks
 * (`OB-013`, `OB-014`, `OB-015`) plus `REQ-002` sat behind it.
 *
 * That is a NEW VARIANT of this project's dominant defect
 * (`ARCHITECTURAL-DECISIONS.md` §7): not *a gate that is never called* but **a
 * role that was never activated.** Documentation asserted a capability; no code
 * path supplied it. And the reason nobody caught it is the part worth keeping:
 * `meeting-decisions.js` `computeWorkflowMetrics()` measures who has not worked
 * from ACTIVITY rows and dispatched tasks. The Designer was never dispatched
 * anything, so she never read as idle — **she read as absent from the
 * question.** See `workers/capability-audit.js`, which asks the other half.
 *
 * ── THE DRAFT ROLE. NOT A PRIMARY WITH A FALLBACK ────────────────────────
 *
 * Owner decision, 2026-08-10: **Cloudflare by default, Gemini for polish and
 * final touches.** The `image` lane in `config/model-routing.json` therefore
 * carries two ROLES, not a primary/backup pair, and this client holds `draft`.
 *
 * A role does NOT degrade to the other role, and that is a correctness rule of
 * the same family as the embeddings lane's "fail, don't degrade": asking for a
 * polish pass and silently receiving a fresh draft returns a plausible image
 * that is not the thing that was asked for. Wrong in the worst way — it looks
 * like an answer. `resolveLane()` gives each role a single candidate.
 *
 * ── THE FREE TIER HERE IS NOT DENOMINATED IN REQUESTS ────────────────────
 *
 * Workers AI's free allowance is **10,000 Neurons per day**, and a Neuron is
 * not a request: one 8-step 1024px image costs far more of the allowance than
 * one short text completion. So `requestsPerDay` is **null** — not because the
 * number is secret, but because *a request count is the wrong unit* and writing
 * a plausible one would give the router a soft stop against a quantity that
 * does not bind. Null keeps the 20s wall-clock pacing on
 * (`task-router.js` checkUnknownCapPacing()), which is the only constraint this
 * repo can actually apply to a balance it cannot read.
 *
 * ⚠️ **The image lane and the classification lane share one allowance.** The
 * `AI` binding is account-scoped, so every Neuron this client spends is a
 * Neuron unavailable to `cloudflare-ai`, which is the classification lane's
 * PRIMARY and the routine-volume lane's BACKUP. Stated here rather than
 * discovered later: heavy Designer output can degrade two chat lanes, and the
 * counters are separate (`cloudflare-images` vs `cloudflare_ai` in
 * `provider_usage`) because the two are different work — but the pool is one.
 *
 * ── ERROR SEMANTICS ──────────────────────────────────────────────────────
 *
 * Identical to every other client here: failures return `null` after a
 * console.warn, never a throw. There is no automatic escalation to a paid tier,
 * for any provider, ever — `overtime_required` is a refusal.
 */

import { imageEnvelope, parseRateLimitHeaders, sniffImageMime } from './provider-common.js';

/**
 * VERIFIED against the live catalog on 2026-08-10 with `npx wrangler ai models`
 * on this account — the account whose binding actually serves the call, which
 * is the check AD-030 makes mandatory before an auth error may even be
 * *attributed* to a key. This repo has been burned FOUR times by a model
 * retired out from under it, so the ID is not written from memory.
 *
 * `@cf/black-forest-labs/flux-1-schnell` was present, alongside
 * `flux-2-klein-4b`, `flux-2-klein-9b`, `flux-2-dev`,
 * `stable-diffusion-xl-base-1.0`, `stable-diffusion-xl-lightning`,
 * `dreamshaper-8-lcm`, `phoenix-1.0` and `stable-diffusion-v1-5-inpainting`.
 *
 * flux-1-schnell is chosen over the newer flux-2 family deliberately: it is a
 * distilled 4-step model, so it is the CHEAPEST per image in a lane whose free
 * allowance is measured in Neurons and shared with two chat lanes. The draft
 * role wants many cheap images; the polish role is where quality is bought.
 * Alternatives are listed above so a later session can move up without
 * re-deriving the catalog.
 */
export const DEFAULT_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/** Models known to answer with `{ image: "<base64>" }` rather than a raw byte
 *  stream. Both shapes are handled below; this set only decides which is
 *  EXPECTED, so an unexpected shape is reported instead of silently coerced. */
const JSON_BASE64_MODELS = new Set([
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/black-forest-labs/flux-2-klein-4b',
  '@cf/black-forest-labs/flux-2-klein-9b',
  '@cf/black-forest-labs/flux-2-dev',
]);

/**
 * Free-tier limits. Mirrored in `config/token-economy.json`'s
 * `providers.cloudflare_images` block; `scripts/verify-providers.js` asserts
 * the two agree, so changing one alone fails the verifier instead of drifting.
 *
 * ── EVERY NULL HERE IS AN HONEST NULL ────────────────────────────────────
 *
 * `requestsPerDay: null` — see the header. The allowance is 10,000 Neurons/day
 *   and a Neuron is not a request. A null cap means THIS REPO DOES NOT KNOW the
 *   request ceiling, never that there isn't one, and the router paces by wall
 *   clock instead of counting (owner instruction, 2026-08-05).
 * `requestsPerMinute: null` — the AI binding returns no rate-limit headers at
 *   all (it is not an HTTP response this code sees), so there is nothing to
 *   read back. parseRateLimitHeaders() is still applied to the raw-stream path
 *   for the same reason it is everywhere else: absent is a different fact from
 *   zero.
 * `neuronsPerDay: 10000` is recorded because it is the REAL unit, even though
 *   nothing can enforce it from inside the Worker — the binding does not report
 *   a balance. Writing the true limit in the true unit and admitting it is
 *   unenforceable is better than enforcing a false one in a convenient unit.
 */
export const CF_IMAGE_LIMITS = {
  maxPromptChars: 2048,
  maxSteps: 8,
  requestsPerMinute: null,
  requestsPerDay: null,
  neuronsPerDay: 10000,
  neuronBalanceReadable: false,
  sharedAllowanceWith: 'cloudflare_ai',
  resetUtc: '00:00',
  paid: false,
};

/**
 * Network-free cap verdict, same signature as every other client so the router
 * can call it uniformly through `PROVIDER_REGISTRY[id].checkInputWithinCaps`.
 *
 * REFUSES an over-long prompt rather than truncating it — the same rule the
 * chat clients keep, and it matters more here: a truncated image prompt does
 * not fail, it produces a confident picture of the wrong thing.
 */
export function checkInputWithinCaps({ prompt = '', steps = null } = {}) {
  const chars = String(prompt || '').length;

  if (!chars) {
    return { ok: false, promptChars: 0, reason: 'no prompt — there is nothing to draw', capUnknown: false };
  }
  if (chars > CF_IMAGE_LIMITS.maxPromptChars) {
    return {
      ok: false,
      promptChars: chars,
      reason: `prompt is ${chars} characters, over the Workers AI per-request cap of ${CF_IMAGE_LIMITS.maxPromptChars}. Not truncating — a truncated image prompt produces a confident picture of the wrong thing.`,
      capUnknown: false,
    };
  }
  if (steps !== null && steps > CF_IMAGE_LIMITS.maxSteps) {
    return {
      ok: false,
      promptChars: chars,
      reason: `steps=${steps} is over flux-schnell's maximum of ${CF_IMAGE_LIMITS.maxSteps}`,
      capUnknown: false,
    };
  }

  // capUnknown is TRUE and says so: the binding-level allowance is in Neurons
  // and cannot be read, so this verdict is about the PROMPT only. A caller that
  // reads ok:true as "the free tier has room" is reading more than is here.
  return { ok: true, promptChars: chars, reason: null, capUnknown: true };
}

/** Reads a ReadableStream / ArrayBuffer response body into base64 without
 *  assuming a `Buffer` (Workers has none) and without `String.fromCharCode`
 *  over a whole megabyte at once, which blows the argument limit. */
async function bodyToBase64(body) {
  let bytes;
  if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (body instanceof Uint8Array) bytes = body;
  else if (body && typeof body.arrayBuffer === 'function') bytes = new Uint8Array(await body.arrayBuffer());
  else if (body && typeof body.getReader === 'function') {
    const chunks = [];
    let total = 0;
    const reader = body.getReader();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
  } else return null;

  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Generates one image.
 *
 * @param {object} opts
 * @param {object} opts.ai        - the account-scoped `AI` binding (env.AI)
 * @param {string} opts.prompt    - what to draw
 * @param {string} [opts.model]
 * @param {number} [opts.steps]   - 1..8 for flux-schnell; 4 is its sweet spot
 * @param {string} [opts.negativePrompt] - SDXL-family only; flux ignores it
 * @param {number|string} [opts.agentId] - for warning logs only
 * @param {function} [opts.onResponse]   - fires before any failure return, so a
 *   refused or errored call is still COUNTED. A failed request consumes free
 *   allowance; see task-router.js recordProviderCall()'s note on evidence.
 * @returns {Promise<object|null>} imageEnvelope(), or null on any failure.
 */
export async function callCloudflareImage({
  ai,
  prompt,
  model = DEFAULT_MODEL,
  steps = 4,
  negativePrompt = null,
  agentId,
  onResponse,
}) {
  if (!ai) {
    console.warn(`[agent-${agentId}] Workers AI binding (env.AI) is absent — the image lane's draft role cannot run. This is a binding, not a secret: check wrangler.toml's [ai] block.`);
    return null;
  }

  const caps = checkInputWithinCaps({ prompt, steps });
  if (!caps.ok) {
    console.warn(`[agent-${agentId}] Workers AI image refused: ${caps.reason}`);
    return null;
  }

  let raw;
  try {
    raw = await ai.run(model, {
      prompt,
      steps,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    });
  } catch (err) {
    // The binding throws on a retired model ID, on a quota refusal, and on a
    // transport failure, and the MESSAGE is the only thing that discriminates
    // them. AD-030: read the body, do not infer a credential. Logged whole
    // (truncated) rather than summarised, because a silent fallback that
    // discards the message is what made a dead MODEL look like a dead KEY for
    // eleven months in this repo.
    console.warn(`[agent-${agentId}] Workers AI image call failed for model "${model}": ${String(err?.message || err).slice(0, 400)}`);
    onResponse?.({ status: null, error: String(err?.message || err).slice(0, 200) });
    return null;
  }

  onResponse?.({ status: 200, rateLimit: raw?.headers ? parseRateLimitHeaders(raw) : null });

  // Two response shapes, both handled, neither assumed.
  let base64 = null;
  let shape = null;
  if (raw && typeof raw === 'object' && typeof raw.image === 'string') {
    base64 = raw.image;
    shape = 'json_base64';
  } else if (raw) {
    base64 = await bodyToBase64(raw.body ?? raw);
    shape = 'byte_stream';
  }

  if (!base64) {
    const why = `no image data for "${model}" (expected ${JSON_BASE64_MODELS.has(model) ? 'a JSON base64 body' : 'a byte stream'}, got ${shape || typeof raw}; keys=${raw && typeof raw === 'object' ? Object.keys(raw).join('|') : 'n/a'})`;
    console.warn(`[agent-${agentId}] Workers AI image returned ${why} — refusing rather than returning an empty asset`);
    onResponse?.({ status: 200, error: why });
    return null;
  }

  /*
   * The type is READ FROM THE BYTES, never asserted.
   *
   * This line asserted a hardcoded PNG type when it was written — every Workers
   * AI image model is documented as returning PNG, and the assumption was
   * reasonable. The first asset the office ever committed landed as
   * `office-mark.png` and was a JPEG (`ff d8 ff e0 ... JFIF`). The bytes were
   * perfect and the NAME was a lie, which is the worse of the two failures:
   * nothing breaks, viewers sniff, and it is discovered later by whichever tool
   * does not. The binding returns no content type, so the type cannot be asked
   * for — it can be read. An unrecognised signature yields null, and the caller
   * names the file `.bin` rather than picking a plausible extension.
   */
  return imageEnvelope({
    base64,
    source: 'cloudflare-images',
    model,
    mimeType: sniffImageMime(base64),
    // The binding reports no finish reason. `null` says "the provider did not
    // tell us", which is a different fact from "complete" — and routeTask()'s
    // empty-image guard does not need it, because zero bytes is the signal.
    finishReason: null,
    usage: { steps, promptChars: String(prompt).length },
    rateLimit: null,
  });
}

/** Uniform descriptor the router's provider registry consumes. `kind` is
 *  'image', which is how the router knows this provider can never serve a chat
 *  lane — including as a backup, and including through the embodiment shuffle. */
export const PROVIDER = {
  id: 'cloudflare-images',
  kind: 'image',
  // Not a secret. The AI binding is account-scoped, exactly as the pre-existing
  // `cloudflare-ai` chat entry is; `hasCredential` checks the binding instead.
  secretName: null,
  endpoint: null,
  defaultModel: DEFAULT_MODEL,
  limits: CF_IMAGE_LIMITS,
  checkInputWithinCaps,
  call: callCloudflareImage,
  role: 'draft',
};
