/**
 * Data Center — AI Agent Simulation — TASK-TYPE ROUTING.
 *
 * Added 2026-08-05 (plan Phase 3). Routes a task to a provider by WHAT KIND
 * OF WORK IT IS, never by which agent is doing it: a persona's voice lives
 * in its prompts and character files, not in which key answered. The lane
 * table itself is DATA (config/model-routing.json) — this module contains no
 * per-lane conditionals, so changing a lane is a config edit.
 *
 * ── SHIPPED OFF 2026-08-05 · ENABLED IN PRODUCTION 2026-08-10 ────────────
 *
 * Every routed call passes through routingEnabled() first. While the
 * `routing_enabled` flag in SIM_KV's `simulation-state` is absent or false —
 * which is the CODE DEFAULT — routeTask() refuses with `routing_disabled` and
 * does nothing else: no provider contacted, no counter touched, no table
 * created. That is still true of the default and is what the verifier pins.
 *
 * It is NO LONGER true of production. The flag was turned on 2026-08-10 after
 * the supervised test (back-office docs/procedures/ROUTING-SUPERVISED-TEST.md)
 * was run lane by lane. **A documented switch state is a claim about
 * production and goes stale the moment someone toggles it** — read it back
 * with `{"type":"routing_status"}`; do not trust this comment or any other.
 *
 * This mirrors `guides_enabled` (agent-runner.js guidesEnabled(), 2026-08-02),
 * which is the proven shape in this repo for shipping a feature dark.
 *
 * ── WHAT ENABLING IT ACTUALLY CHANGED ────────────────────────────────────
 *
 * One live consumer, not none: workers/report-pipeline.js planReportProviders()
 * returns `mode: 'routed'` when the flag is on, which moves the weekly report's
 * REVIEW onto the judgment lane (Cerebras, 131,000-token input) and its DRAFT
 * onto the report_drafting lane (Gemini, holding AD-028). The daily Q&A engine
 * and the Guides pipeline were NOT rewired and use the providers they always
 * did.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM model-router.js ─────────────────────
 *
 * model-router.js imports config/token-economy.json, which means plain
 * `node` cannot load it and its verifier has to check it as TEXT. Regex
 * assertions about routing would be worth very little — "Anthropic is
 * unreachable from every routing path" has to be proven by CALLING the
 * resolver, not by grepping for a string. So the logic lives here, importing
 * no JSON, and model-router.js binds it to the real config and re-exports
 * it. Same reasoning that keeps workers/guide-engine.js JSON-free for
 * scripts/verify-guide-engine.js.
 *
 * ── ANTHROPIC IS UNREACHABLE, TWICE OVER ─────────────────────────────────
 *
 *  1. resolveLane() refuses any lane marked `routable: false` — the
 *     `architect` lane, which names no provider at all.
 *  2. PROVIDER_REGISTRY below imports no Anthropic client. A lane that named
 *     one would resolve to `unknown_provider` and be denied.
 *
 * The two are independent: breaking one does not open the path.
 * scripts/verify-routing.js proves both, including by deliberately pointing
 * a lane at 'anthropic' and asserting the denial.
 *
 * ── GITHUB MODELS WAS REMOVED, 2026-08-06 ────────────────────────────────
 *
 * The judgment lane originally ran on GitHub Models with Cerebras behind it.
 * GitHub Models was **fully retired on 2026-07-30** — playground, catalog,
 * inference API and BYOK, permanently, for all customers. The supervised
 * test's Step 1 caught it: both the catalog and the inference endpoint return
 * HTTP 410, and they return it *with no Authorization header at all*, which
 * is what distinguishes a dead service from a bad key.
 *
 * The provider is gone from this registry, from config/model-routing.json,
 * from config/token-economy.json, and workers/github-models-client.js is
 * deleted. **Do not re-add it as a fallback.** The 410 body still says
 * "temporarily unavailable ... brownout"; that text is stale and outlived the
 * service it describes. Trust the retirement date, not the error string.
 *
 * ── CONCENTRATION RISK, STATED SO IT IS NOT DISCOVERED LATER ─────────────
 *
 * The replacement puts Cerebras PRIMARY on both `judgment` and
 * `long_document`. That is a deliberate accepted risk, not an oversight:
 * **one Cerebras outage now takes out two lanes at once**, and judgment
 * degrades to Mistral while long_document degrades to the same Mistral — so
 * a Cerebras failure concentrates both lanes onto a single backup.
 *
 * The intended diversification, if this ever bites, is **OpenRouter** as a
 * third chat provider so the two lanes can hold different primaries again.
 * It is deliberately NOT added now (owner decision, 2026-08-06): adding a
 * provider to solve a risk that has not yet materialised spends a free tier
 * and a secret on a hypothetical. Name it here so the option is found by
 * whoever hits the outage, rather than rediscovered under pressure.
 */

import { callCerebras, PROVIDER as CEREBRAS_PROVIDER } from './cerebras-client.js';
import { callMistral, PROVIDER as MISTRAL_PROVIDER } from './mistral-client.js';
import { callCohereEmbed, PROVIDER as COHERE_PROVIDER } from './cohere-client.js';
import { callGroq } from './groq-client.js';
import { callGemini, callCloudflareFallback } from './gemini-client.js';
import { callCloudflareImage, PROVIDER as CF_IMAGE_PROVIDER } from './cf-image-client.js';
import { callGeminiImage, polishImage, PROVIDER as GEMINI_IMAGE_PROVIDER } from './gemini-image-client.js';
// The ONE KV pacing primitive (audit #13). gemini-pacer.js imports nothing, so
// this preserves the rule that task-router.js stays loadable by its verifier.
import { checkKvPacingSlot } from './gemini-pacer.js';

/** Must match agent-runner.js's SIM_STATE_KEY. verify-routing.js asserts it does. */
export const SIM_STATE_KEY = 'simulation-state';
export const ROUTING_FLAG = 'routing_enabled';

/**
 * Reads the kill switch. Defaults CLOSED — `=== true`, so an absent flag, a
 * missing KV binding, or any non-boolean value all mean OFF. Same test
 * guidesEnabled() uses.
 */
export async function routingEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[ROUTING_FLAG] === true;
}

/* ────────────────────────────────────────────────────────────────────────
 * PROVIDER REGISTRY
 *
 * One entry per provider the router may select. The four clients added in
 * Phase A expose a uniform PROVIDER descriptor; the three pre-existing
 * clients (groq, gemini, cloudflare) predate that convention and are wrapped
 * here rather than modified — they have live callers on the daily Q&A path
 * and this session does not touch them.
 *
 * `invoke` normalizes every provider to one envelope so a caller can never
 * tell which one answered. `tokenEconomyKey` points at the provider's block
 * in config/token-economy.json, which is where daily caps live.
 * ──────────────────────────────────────────────────────────────────────── */

/** Envelope every provider returns, so callers stay provider-blind. */
function envelope({ text, source, finishReason = null, usage = null, rateLimit = null }) {
  return { text, source, finishReason, usage, rateLimit };
}

export const PROVIDER_REGISTRY = {
  // GitHub Models was removed on 2026-08-06 — see the header note. Do not
  // re-add it: the service is retired, not degraded.
  cerebras: {
    id: 'cerebras',
    kind: 'chat',
    tokenEconomyKey: 'cerebras',
    secretName: CEREBRAS_PROVIDER.secretName,
    checkInputWithinCaps: CEREBRAS_PROVIDER.checkInputWithinCaps,
    hasCredential: (env) => !!env?.CEREBRAS_API_KEY,
    invoke: (env, opts) => callCerebras({ ...opts, apiKey: env.CEREBRAS_API_KEY }),
  },
  mistral: {
    id: 'mistral',
    kind: 'chat',
    tokenEconomyKey: 'mistral',
    secretName: MISTRAL_PROVIDER.secretName,
    checkInputWithinCaps: MISTRAL_PROVIDER.checkInputWithinCaps,
    hasCredential: (env) => !!env?.MISTRAL_API_KEY,
    invoke: (env, opts) => callMistral({ ...opts, apiKey: env.MISTRAL_API_KEY }),
  },
  cohere: {
    id: 'cohere',
    kind: 'embeddings',
    tokenEconomyKey: 'cohere',
    secretName: COHERE_PROVIDER.secretName,
    checkInputWithinCaps: COHERE_PROVIDER.checkInputWithinCaps,
    hasCredential: (env) => !!env?.COHERE_API_KEY,
    invoke: (env, opts) => callCohereEmbed({
      apiKey: env.COHERE_API_KEY,
      texts: opts.texts,
      inputType: opts.inputType,
      model: opts.model,
      agentId: opts.agentId,
    }),
  },

  // ── Pre-existing clients, wrapped not modified ────────────────────────
  groq: {
    id: 'groq',
    kind: 'chat',
    tokenEconomyKey: 'groq',
    secretName: 'GROQ_API_KEY',
    checkInputWithinCaps: () => ({ ok: true, capUnknown: false, reason: null }),
    hasCredential: (env) => !!env?.GROQ_API_KEY,
    invoke: async (env, opts) => {
      const r = await callGroq({ ...opts, apiKey: env.GROQ_API_KEY });
      // SESSION 13 (2026-08-23): the wrapper used to rebuild the envelope from
      // `text` and `source` alone, so even after the client carried a finish
      // reason the ROUTER still lost it here. Carried through now, same as
      // cerebras/mistral, which return the envelope directly.
      return r ? envelope({
        text: r.text, source: r.source,
        finishReason: r.finishReason ?? null,
        usage: r.usage ?? null,
        rateLimit: r.rateLimit ?? null,
      }) : null;
    },
  },
  'cloudflare-ai': {
    id: 'cloudflare-ai',
    kind: 'chat',
    tokenEconomyKey: 'cloudflare_ai',
    secretName: null, // account-scoped AI binding, not a secret
    checkInputWithinCaps: () => ({ ok: true, capUnknown: false, reason: null }),
    hasCredential: (env) => !!env?.AI,
    invoke: async (env, opts) => {
      try {
        const r = await callCloudflareFallback({
          ai: env.AI,
          prompt: opts.prompt,
          systemPrompt: opts.systemPrompt,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
        });
        // `finishReason` here is the NOT_REPORTED sentinel, never null —
        // Workers AI has no finish reason at all, and routeTask()'s
        // truncation check must be able to tell "not reported" from "the
        // provider reported nothing this time". See gemini-client.js.
        return r ? envelope({
          text: r.text, source: r.source,
          finishReason: r.finishReason ?? null,
          usage: r.usage ?? null,
        }) : null;
      } catch (err) {
        // callCloudflareFallback throws when the binding is missing; the
        // router never propagates a provider failure to a caller.
        console.warn(`[routing] cloudflare-ai call failed: ${err.message}`);
        return null;
      }
    },
  },
  gemini: {
    id: 'gemini',
    kind: 'chat',
    tokenEconomyKey: 'gemini',
    secretName: 'GEMINI_API_KEY',
    checkInputWithinCaps: () => ({ ok: true, capUnknown: false, reason: null }),
    hasCredential: (env) => !!env?.GEMINI_API_KEY,
    invoke: async (env, opts) => {
      try {
        const r = await callGemini({
          apiKey: env.GEMINI_API_KEY,
          model: opts.geminiModel,
          endpoint: opts.geminiEndpoint,
          prompt: opts.prompt,
          systemPrompt: opts.systemPrompt,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          ai: env.AI,
        });
        return r ? envelope({
          text: r.text, source: r.source,
          finishReason: r.finishReason ?? null,
          usage: r.usage ?? null,
        }) : null;
      } catch (err) {
        console.warn(`[routing] gemini call failed: ${err.message}`);
        return null;
      }
    },
  },

  /* ── IMAGE PROVIDERS (2026-08-10, plan 5.1) ────────────────────────────
   *
   * The office's first image-capable providers. `kind: 'image'` is the guard,
   * and it is the same mechanism Cohere's `kind: 'embeddings'` has always been:
   * a provider whose kind does not match the lane's is REFUSED, so an image
   * model can never serve a chat lane and a chat model can never serve the
   * image lane — including as a backup, and including through the embodiment
   * shuffle, which filters on kind independently.
   *
   * These two are ROLES of one lane, not a primary and a backup. See
   * config/model-routing.json's `image` lane and each client's header.
   * ──────────────────────────────────────────────────────────────────────── */
  'cloudflare-images': {
    id: 'cloudflare-images',
    kind: 'image',
    role: 'draft',
    tokenEconomyKey: 'cloudflare_images',
    secretName: null, // account-scoped AI binding, not a secret
    checkInputWithinCaps: CF_IMAGE_PROVIDER.checkInputWithinCaps,
    hasCredential: (env) => !!env?.AI,
    /*
     * `?? undefined` on every optional passthrough, and it is not noise.
     *
     * A JS default parameter fires on `undefined` and NOT on `null`. Callers on
     * this path normalise absent fields to null (`body.imageModel || null` in
     * the trigger), so passing them straight through replaced each client
     * default with null. The first real image call this router ever made came
     * back `5007: No such model null or task` — the CATALOG-VERIFIED model ID was
     * present in the client the whole time and was being overwritten by an
     * absent request field. A default parameter is not a null guard.
     */
    invoke: (env, opts) => callCloudflareImage({
      ai: env.AI,
      prompt: opts.prompt,
      model: opts.imageModel ?? undefined,
      steps: opts.steps ?? undefined,
      negativePrompt: opts.negativePrompt ?? undefined,
      agentId: opts.agentId,
      onResponse: opts.onResponse,
    }),
  },
  'gemini-images': {
    id: 'gemini-images',
    kind: 'image',
    role: 'polish',
    tokenEconomyKey: 'gemini_images',
    secretName: 'GEMINI_API_KEY',
    checkInputWithinCaps: GEMINI_IMAGE_PROVIDER.checkInputWithinCaps,
    hasCredential: (env) => !!env?.GEMINI_API_KEY,
    /*
     * ONE invoke, TWO capabilities, and the branch is on what the CALLER
     * supplied rather than on a flag it could forget to set. A `polish` call
     * carries input images; a bare generation does not. polishImage() itself
     * refuses an empty image list, so a caller that asks for a polish pass and
     * sends nothing to polish gets a refusal from the client too — the same
     * rule enforced in two independent places, because the failure it prevents
     * (a fresh draft returned under the polish role's name) is silent.
     */
    invoke: (env, opts) => {
      const images = (opts.inputImages || []).filter((i) => i && i.base64);
      if (images.length || opts.instruction) {
        return polishImage({
          apiKey: env.GEMINI_API_KEY,
          instruction: opts.instruction || opts.prompt,
          inputImages: images,
          model: opts.imageModel ?? undefined, // see the draft entry: a default parameter is not a null guard
          agentId: opts.agentId,
          onResponse: opts.onResponse,
        });
      }
      return callGeminiImage({
        apiKey: env.GEMINI_API_KEY,
        prompt: opts.prompt,
        model: opts.imageModel,
        agentId: opts.agentId,
        onResponse: opts.onResponse,
      });
    },
  },
};

/**
 * The kinds a lane may declare. A lane whose kind is not in this set is refused
 * rather than treated as chat — see resolveLane()'s `lane_kind_unstated` note
 * for why an absent or unknown kind became a real hazard on 2026-08-10.
 */
export const LANE_KINDS = Object.freeze(['chat', 'embeddings', 'image']);

/** The kind the embodiment shuffle may use. Embodiment is a CHAT instrument:
 *  it exists so the Lead QA can compare how personas read under different
 *  providers, and an image model has no voice to compare. Named as a constant
 *  because it is asserted by the verifier and read in two places. */
export const EMBODIMENT_KIND = 'chat';

/* ────────────────────────────────────────────────────────────────────────
 * LANE RESOLUTION
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Resolves a task type to an ORDERED candidate list.
 *
 * @param {object} routingConfig
 * @param {string} taskType
 * @param {object} [opts]
 * @param {function} [opts.rng]
 * @param {function} [opts.knownCapFirst]
 * @param {string} [opts.role] - for a `mode: 'roles'` lane (today: `image`),
 *   WHICH ROLE is being asked for. Absent falls back to the lane's
 *   `default_role`, and a lane with neither is refused rather than guessed at.
 *   An UNRECOGNISED role is refused — never quietly served by the default —
 *   because the default would be this router deciding that a request for a
 *   polish pass may be answered with a fresh draft.
 * @returns {{routable: boolean, lane: string, candidates: string[], mode: string,
 *            kind: string, role: string|null, reason: string|null}}
 *   `routable: false` with a reason for: an unknown task type, a lane marked
 *   non-routable (the Architect), a lane that declares no `kind`, a lane naming
 *   a provider that is not in the registry, or a provider whose kind does not
 *   match the lane's. Never throws.
 */
export function resolveLane(routingConfig, taskType, { rng = Math.random, knownCapFirst = null, role = null } = {}) {
  const lane = routingConfig?.lanes?.[taskType];

  if (!lane) {
    return { routable: false, lane: taskType, candidates: [], mode: null, kind: null, role: null, reason: 'unknown_task_type' };
  }

  if (lane.routable === false) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode: null,
      kind: lane.kind || null,
      role: null,
      reason: 'lane_never_routed',
    };
  }

  /* ── A ROUTABLE LANE MUST DECLARE ITS KIND  (added 2026-08-10) ──────────
   *
   * This check did not exist, and until 2026-08-10 its absence was harmless.
   * The wrong-kind check further down was written `if (lane.kind && ...)`, so a
   * lane that simply OMITTED the field accepted any provider in the registry —
   * and every provider was chat or embeddings, so the worst case was an
   * embeddings model on a text lane, which fails loudly and immediately.
   *
   * Adding an IMAGE provider changed that. A kind-less text lane pointed at an
   * image model would resolve, route, and return an envelope with no `text`
   * field at all — and routeTask()'s empty-answer guard keys on
   * `resolved.kind === 'chat'`, so a lane with no kind would ALSO skip the guard
   * that catches it. Two silent failures compounding: the wrong provider, and
   * the check that would have caught it switched off by the same missing field.
   *
   * A missing kind is now `lane_kind_unstated`, and an unrecognised one is
   * `unknown_lane_kind`. Refused, not defaulted to 'chat' — the default is
   * exactly the assumption that would have hidden this.
   * ──────────────────────────────────────────────────────────────────────── */
  if (!lane.kind) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode: lane.mode === 'controlled_random' ? 'controlled_random' : (lane.mode || 'ordered'),
      kind: null,
      role: null,
      reason: 'lane_kind_unstated',
    };
  }
  if (!LANE_KINDS.includes(lane.kind)) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode: lane.mode || 'ordered',
      kind: lane.kind,
      role: null,
      reason: `unknown_lane_kind:${lane.kind}`,
    };
  }

  let candidates;
  let mode;
  let resolvedRole = null;

  if (lane.mode === 'roles') {
    /* ── ROLE MODE: two jobs, not two choices for one job ────────────────
     *
     * The image lane's providers are a DRAFT provider and a POLISH provider
     * (owner decision, 2026-08-10). `primary`/`backup` cannot express that —
     * that pair means "the same job, second choice" — so a role resolves to
     * exactly ONE candidate and there is no degradation between roles. See the
     * lane's `_why_a_role_never_degrades_to_the_other_role` note.
     */
    mode = 'roles';
    resolvedRole = role || lane.default_role || null;
    if (!resolvedRole) {
      return { routable: false, lane: taskType, candidates: [], mode, kind: lane.kind, role: null, reason: 'role_not_specified_and_no_default' };
    }
    const provider = lane.roles?.[resolvedRole];
    if (!provider) {
      return {
        routable: false,
        lane: taskType,
        candidates: [],
        mode,
        kind: lane.kind,
        role: resolvedRole,
        reason: `unknown_lane_role:${resolvedRole}`,
      };
    }
    candidates = [provider];
  } else if (lane.mode === 'controlled_random') {
    mode = 'controlled_random';
    candidates = shufflePool(lane.pool || [], rng, knownCapFirst);
  } else {
    mode = 'ordered';
    // Table order is the owner's intent and is NOT reordered by this router.
    candidates = [lane.primary, lane.backup].filter(Boolean);
  }

  const unknown = candidates.filter((id) => !PROVIDER_REGISTRY[id]);
  if (unknown.length > 0) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode,
      kind: lane.kind,
      role: resolvedRole,
      reason: `unknown_provider:${unknown.join(',')}`,
    };
  }

  /*
   * THE KIND GUARD. Cohere's `kind: 'embeddings'` is the precedent and the image
   * providers extend it: an image provider cannot serve a chat lane and a chat
   * provider cannot serve the image lane, in either direction, including as a
   * backup and including inside the controlled-random pool.
   *
   * The `lane.kind &&` short-circuit this condition used to carry is GONE — it
   * is now unreachable anyway, because a lane with no kind was refused above.
   * Removing it is the point: a guard whose condition can be switched off by
   * omitting a field is a guard with an opt-out nobody documented.
   */
  const wrongKind = candidates.filter((id) => PROVIDER_REGISTRY[id].kind !== lane.kind);
  if (wrongKind.length > 0) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode,
      kind: lane.kind,
      role: resolvedRole,
      reason: `provider_kind_mismatch:${wrongKind.map((id) => `${id}(${PROVIDER_REGISTRY[id].kind})`).join(',')}`,
    };
  }

  if (candidates.length === 0) {
    return { routable: false, lane: taskType, candidates: [], mode, kind: lane.kind, role: resolvedRole, reason: 'lane_has_no_providers' };
  }

  return { routable: true, lane: taskType, candidates, mode, kind: lane.kind, role: resolvedRole, reason: null };
}

/**
 * Shuffles the controlled-random pool.
 *
 * `knownCapFirst`, when supplied, is a predicate `(providerId) => boolean`
 * used ONLY as a DEGRADE-ORDER tie-break: the pool is shuffled, then split so
 * providers with a known daily cap sit ahead of providers whose cap is
 * unknown — WITHOUT changing which provider is picked first for the event.
 *
 * That distinction is the whole point, and it is easy to get backwards.
 * Preferring known-cap providers for the PRIMARY pick would quietly collapse
 * the embodiment pool to groq/cloudflare/gemini (the only three with
 * published caps today) and destroy the cross-embodiment comparison this
 * lane exists to feed. The owner's instruction — unknown is not unlimited,
 * prefer known limits where a cap actually matters to the decision — bites on
 * the FALLBACK choice, where the candidates are genuinely interchangeable and
 * a verifiable remaining quota is the only thing to choose on.
 *
 * Unknown-cap providers are still constrained: they get a wall-clock pacing
 * gate instead of a count check. See checkProviderAllowance().
 */
function shufflePool(pool, rng, knownCapFirst) {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  if (typeof knownCapFirst !== 'function' || shuffled.length < 3) return shuffled;

  const [first, ...rest] = shuffled;
  return [first, ...rest.filter(knownCapFirst), ...rest.filter((id) => !knownCapFirst(id))];
}

/* ────────────────────────────────────────────────────────────────────────
 * CONTROLLED-RANDOM EMBODIMENT
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Assigns a provider to each persona for one conversation/office event.
 *
 * THIS IS A MEASUREMENT INSTRUMENT, NOT A FALLBACK MECHANISM. Read that
 * twice before changing it. The Lead QA (agent 8) compares report quality
 * across agents AND across embodiment models — "this persona is more
 * consistent under that provider", "that provider invents facts in
 * meetings". The shuffle is what generates the comparison data and the
 * logged map is what makes it readable. Replace the shuffle with a fixed
 * assignment and the cross-embodiment half of the improvement loop silently
 * stops producing evidence — it will not error, it will just quietly measure
 * nothing.
 *
 * The Architect is never included. Callers must not pass agent 10; this
 * function also drops him defensively, by id and by name.
 *
 * ── THE KIND GUARD, APPLIED HERE INDEPENDENTLY OF resolveLane() ─────────
 *
 * A non-chat provider is never embodied. That was already true — the filter
 * below has always tested `kind === 'chat'` — and it is an INDEPENDENT barrier
 * rather than a duplicate: resolveLane() refuses a wrong-kind candidate before
 * the pool ever reaches here, and this refuses one that arrives by any other
 * route. Two mechanisms, deliberately, because a caller may hand this function a
 * pool it assembled itself.
 *
 * **What changed on 2026-08-10 is that the drop is now RECORDED.** The filter
 * used to discard silently, and a silent filter on a measurement instrument is
 * the worst place in this repo for one: a pool of five with two image providers
 * quietly became a pool of three, the embodiment map still rendered perfectly,
 * and the Lead QA's cross-embodiment comparison would have been drawing
 * conclusions from a narrower sample than the config said it had. Worse, an
 * all-image pool produced `provider: null` for every persona and a map that
 * looked structurally fine. `poolExcluded` makes the drop visible, and
 * `poolEmpty` makes the total collapse an explicit fact rather than a column of
 * nulls a reader has to notice.
 *
 * `excluded` still carries PERSONA exclusions only (the Architect). Provider
 * exclusions go in `poolExcluded`, because "who was not shuffled" and "what they
 * could not be shuffled onto" are different facts and a caller that wants one
 * should not have to filter the other out of it.
 *
 * @param {object} opts
 * @param {Array<{id: number|string, name: string}>} opts.personas
 * @param {string[]} opts.pool - provider ids (non-Anthropic by construction)
 * @param {function} [opts.rng] - injectable for deterministic verification
 * @param {string} [opts.kind] - the kind the pool must be. Defaults to
 *   EMBODIMENT_KIND ('chat'); passing anything else yields an empty pool, since
 *   embodiment compares how a persona READS and an image model has no voice.
 * @returns {{eventId: string|null, assignments: Array<{agentId, agentName, provider}>,
 *            pool: string[], excluded: Array<{agentName, reason}>,
 *            poolExcluded: Array<{provider, kind, reason}>, poolEmpty: boolean}}
 */
export function assignEmbodiment({
  personas = [],
  pool = [],
  rng = Math.random,
  eventId = null,
  kind = EMBODIMENT_KIND,
} = {}) {
  const excluded = [];
  const eligible = personas.filter((p) => {
    const isArchitect = String(p.id) === '10' || /architect/i.test(p.name || '');
    if (isArchitect) excluded.push({ agentName: p.name, reason: 'architect_never_shuffled' });
    return !isArchitect;
  });

  const poolExcluded = [];
  const usable = [];
  for (const id of pool) {
    const provider = PROVIDER_REGISTRY[id];
    if (!provider) {
      poolExcluded.push({ provider: id, kind: null, reason: 'not_in_provider_registry' });
      continue;
    }
    if (provider.kind !== kind) {
      poolExcluded.push({ provider: id, kind: provider.kind, reason: `kind_is_not_${kind}` });
      continue;
    }
    usable.push(id);
  }

  if (poolExcluded.length) {
    console.warn(`[routing][embodiment] ${poolExcluded.length} pool entr${poolExcluded.length === 1 ? 'y was' : 'ies were'} dropped from the shuffle: ${poolExcluded.map((p) => `${p.provider}(${p.kind || 'unregistered'}: ${p.reason})`).join(', ')}`);
  }
  if (usable.length === 0 && pool.length > 0) {
    // Loud, because the alternative is a well-formed map full of nulls. An
    // embodiment map with no providers measures nothing and must not be able to
    // pass for one that does.
    console.warn(`[routing][embodiment] NO USABLE PROVIDER of kind "${kind}" in a pool of ${pool.length} — every persona would be assigned null. This measures nothing; the caller is reporting poolEmpty.`);
  }

  const assignments = eligible.map((p) => ({
    agentId: p.id,
    agentName: p.name,
    provider: usable.length > 0 ? usable[Math.floor(rng() * usable.length)] : null,
  }));

  return { eventId, assignments, pool: usable, excluded, poolExcluded, poolEmpty: usable.length === 0 };
}

/**
 * Renders an embodiment map for a meeting record
 * (back-office-AI-agents/campus/shared/meetings/<date>-<type>.md, plan item
 * 2.4) and for the console log of a routed event.
 */
export function renderEmbodimentMap({ eventId, assignments = [], excluded = [], poolExcluded = [], poolEmpty = false } = {}) {
  const lines = [`**Embodiment map**${eventId ? ` — event \`${eventId}\`` : ''}`, ''];
  lines.push('| Agent | Played by |');
  lines.push('|---|---|');
  for (const a of assignments) lines.push(`| ${a.agentName} (${a.agentId}) | \`${a.provider || 'none'}\` |`);
  for (const e of excluded) lines.push(`| ${e.agentName} | _not shuffled — ${e.reason}_ |`);

  // The dropped pool entries are rendered INTO the record, not just logged.
  // A meeting record is where the Lead QA reads the sample she is comparing
  // across, and a sample that was narrowed has to say so on the same page as
  // the comparison — otherwise the narrowing lives only in a Worker log nobody
  // reads next to the conclusion.
  if (poolExcluded.length) {
    lines.push('');
    lines.push(`_Pool narrowed: ${poolExcluded.length} provider(s) excluded from the shuffle — `
      + `${poolExcluded.map((p) => `\`${p.provider}\` (${p.kind || 'unregistered'}: ${p.reason})`).join(', ')}. `
      + 'Embodiment is a chat-only instrument; an image or embeddings provider has no voice to compare._');
  }
  if (poolEmpty) {
    lines.push('');
    lines.push('_**No usable provider in the pool** — every persona above shows `none`. '
      + 'This map measures NOTHING and must not be read as evidence of cross-embodiment behaviour._');
  }
  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────
 * TOKEN ECONOMY — per-provider counters
 *
 * Follows the shape already proven by model-router.js's Claude budget rather
 * than inventing a new one: a lazily-created D1 table, a COMPOSITE period
 * key so several sub-counters share one table without being able to drain
 * each other ('YYYY-MM#guides' there, '<provider>#YYYY-MM-DD' here), an
 * allow-check before the call, and a record after it.
 *
 * The period is USUALLY a day, because these are free-tier request allowances
 * that reset daily — unlike a dollar budget. It is not always: Cohere's free
 * tier is a MONTHLY call allowance, so the period is per-provider and comes
 * from which field the config actually sets. See capFor().
 *
 * NOTE ON THE TABLE: it is created lazily here and is NOT declared in
 * database/schema.sql. That is a deliberate deviation from the
 * claude_budget_usage precedent (which is in both places) because this
 * session was instructed not to touch the D1 schema. While routing is off
 * the table is never created at all. Flagged for the owner: if he wants it
 * declared in schema.sql for a fresh-database rebuild, that is a one-line
 * addition in a session allowed to touch the schema.
 * ──────────────────────────────────────────────────────────────────────── */

const PROVIDER_USAGE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS provider_usage (
  period_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  call_count INTEGER DEFAULT 0,
  confirmed_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * The bucket string a provider's counter is keyed on.
 *
 * 'day'   -> 'YYYY-MM-DD'
 * 'month' -> 'YYYY-MM'
 *
 * Both go in the SAME `day` column of provider_usage. That column holds a
 * bucket label, not necessarily a calendar date, and the composite
 * `period_key` keeps the two families from colliding. Keeping one column
 * avoids a schema migration on a table that is created lazily and cannot be
 * altered by `CREATE TABLE IF NOT EXISTS`.
 */
export function periodBucket(period, asOf = new Date()) {
  const iso = asOf.toISOString();
  return period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** '<provider>#<bucket>' — the composite-key pattern from the Claude budget. */
export function providerPeriodKey(providerId, asOf = new Date(), period = 'day') {
  return `${providerId}#${periodBucket(period, asOf)}`;
}

/**
 * The cap this repo actually knows for a provider, and the period it resets on.
 *
 * A free tier is not always expressed per day. Cohere's is a MONTHLY call
 * allowance (1,000/month on the trial key), and forcing that into a daily
 * field was the one thing guaranteed to be wrong: divide it by 30 and the
 * soft stop refuses legitimate work three weeks early; leave it as a daily
 * number and a single busy day can spend the month. So the config carries
 * `requests_per_day` AND `requests_per_month`, and this reads whichever is
 * present.
 *
 * DAILY WINS when both are set. That is the conservative direction — a daily
 * cap is the tighter window, and a provider that publishes both is telling
 * you the daily one binds first.
 *
 * @returns {{cap: number|null, period: 'day'|'month'|null}}
 */
export function capFor(tokenEconomy, providerId) {
  const key = PROVIDER_REGISTRY[providerId]?.tokenEconomyKey;
  if (!key) return { cap: null, period: null };

  const cfg = tokenEconomy?.providers?.[key];
  const perDay = cfg?.requests_per_day ?? null;
  if (perDay !== null) return { cap: perDay, period: 'day' };

  const perMonth = cfg?.requests_per_month ?? null;
  if (perMonth !== null) return { cap: perMonth, period: 'month' };

  return { cap: null, period: null };
}

/** Known DAILY cap, or null. Kept as its own accessor because the pre-existing
 * providers (groq/cloudflare/gemini) are daily by definition and several
 * callers and verifier assertions ask that narrower question. */
export function dailyCapFor(tokenEconomy, providerId) {
  const { cap, period } = capFor(tokenEconomy, providerId);
  return period === 'day' ? cap : null;
}

/** True when this repo knows the provider's cap on ANY period. Used as the
 * degrade-order tie-break in the controlled-random lane — a verifiable
 * remaining quota is what makes candidates comparable there, and a monthly
 * allowance is just as verifiable as a daily one. */
export function hasKnownCap(tokenEconomy, providerId) {
  return capFor(tokenEconomy, providerId).cap !== null;
}

/**
 * The wall-clock spacing this provider is actually paced at, and WHY.
 *
 * ── OB-100, 2026-08-16. THE MEASUREMENT WAS TAKEN AND NOTHING READ IT. ─────
 *
 * `config/model-routing.json`'s `_unknown_cap_meta` promised: *"Once a real
 * cap is established by the supervised test, fill it into token-economy.json
 * and the count check takes over automatically; nothing here needs editing."*
 * The real cap WAS established on 2026-08-06 — Cerebras **1,000 requests per
 * minute**, Mistral **50** — read off live rate-limit headers and written into
 * `config/token-economy.json`. The count check did not take over, because the
 * numbers landed in `requests_per_minute` and `capFor()` reads only
 * `requests_per_day` / `requests_per_month`. **No code path has ever read
 * `requests_per_minute`.**
 *
 * So both providers kept falling through to the blanket 20-second floor, which
 * permits **3 calls per minute**. Measured against Cerebras' measured 1,000,
 * the office was scheduling at 0.3% of a limit it had already established —
 * and paying for it in the one place it is most visible: **every report that
 * went through a revision round was finally reviewed by the BACKUP provider,
 * never the primary — 0 of 7 in the live `report_pipeline` table**, because a
 * REVISE issues a second `runReview()` seconds after the first
 * (`agent-runner.js`) and the floor denies it.
 *
 * KFM-26's shape applied to a measurement rather than to a gate: the right
 * thing was built, and wired nowhere.
 *
 * ── WHAT THIS RETURNS, AND WHAT IT HONESTLY CANNOT DO ─────────────────────
 *
 * A KNOWN per-minute rate is paced from that rate at the same 60% soft stop
 * the counted path uses — `60000 / (rpm × soft_stop_fraction)`. Cerebras 100ms,
 * Mistral 2000ms. An UNKNOWN rate keeps the 20-second floor, unchanged.
 *
 * **This is not enforcement below ~60 seconds and must not be read as such.**
 * KFM-16 established that Workers KV caches reads at the edge for up to 60
 * seconds, so a spacing shorter than that cannot be held by a KV timestamp
 * however the code is arranged. The honest statement is that a measured-rate
 * spacing is ADVISORY, permissive-direction, and the constraint that actually
 * bounds this provider is the **50-subrequest invocation ceiling**
 * (`subrequest-budget.js`), which caps calls per tick regardless. That is why
 * moving Cerebras from 3/min to a nominal 600/min is safe: the tick ceiling,
 * not the pacer, is what stands between the office and the free tier.
 *
 * Deriving the number rather than choosing one also means a corrected
 * `requests_per_minute` in the config changes the pacing with no code edit —
 * which is what the config already promised and could not deliver.
 *
 * @returns {{spacingMs: number, basis: 'measured_rate'|'unknown', ratePerMinute: number|null}}
 */
export function paceSpacingFor(tokenEconomy, providerId, routingConfig) {
  const fallbackMs = routingConfig?.unknown_cap_min_spacing_ms ?? 20_000;
  const key = PROVIDER_REGISTRY[providerId]?.tokenEconomyKey;
  const rpm = key ? (tokenEconomy?.providers?.[key]?.requests_per_minute ?? null) : null;

  // A null rate means UNKNOWN, never unlimited — the same rule the null daily
  // cap carries, and the reason the 20s floor exists at all.
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return { spacingMs: fallbackMs, basis: 'unknown', ratePerMinute: null };
  }

  const fraction = routingConfig?.soft_stop_fraction ?? 0.6;
  const permitted = rpm * fraction;
  // Never below 1ms and never ABOVE the unknown-rate floor: a provider that
  // published a rate slower than 3/min should be paced at least as hard as one
  // that published nothing.
  const spacingMs = Math.min(fallbackMs, Math.max(1, Math.ceil(60_000 / permitted)));
  return { spacingMs, basis: 'measured_rate', ratePerMinute: rpm };
}

/**
 * Wall-clock pacing for a provider whose daily cap is UNKNOWN.
 *
 * An unknown cap cannot be enforced by counting, and treating it as
 * unlimited is exactly what the owner ruled out. So it is enforced by time
 * instead: at most one routed call per `minSpacingMs` per provider, tracked
 * by a KV timestamp. Mechanism and 20s floor both lifted from
 * workers/gemini-pacer.js, which solves the same problem for the same
 * reason — a quota this repo cannot observe.
 *
 * `minSpacingMs` is chosen by `paceSpacingFor()` since 2026-08-16 (OB-100):
 * a measured per-minute rate sizes it, an unmeasured one keeps the 20s floor.
 * This function is unchanged and takes the number it is given.
 *
 * Check-and-set, like the pacer: an allowed check consumes the slot. If a
 * later gate then denies the call, the slot is spent without a call being
 * made. That is conservative in the safe direction and is left as-is.
 *
 * Degrades OPEN without SIM_KV, matching the pacer and the rest of this repo.
 */
// EXPORTED 2026-08-16 so a verifier can exercise it DIRECTLY. It was on the
// gate-call audit's UNPROVEN list — wired to a real call site, never once fed
// the thing it is supposed to refuse. Exercising it only through
// checkProviderAllowance() would prove the behaviour and still leave the audit
// reporting UNPROVEN, because that tool counts call sites by name; an indirect
// test is invisible to it and to the next reader. See
// scripts/verify-unproven-gates.js §2.
export async function checkUnknownCapPacing(env, providerId, minSpacingMs, now) {
  // ONE IMPLEMENTATION, 2026-08-16 (audit #13). This function used to carry
  // its own copy of the get→compare→put dance that gemini-pacer.js also
  // carried — same algorithm, two keys, and the honest account of what it does
  // NOT guarantee written on only one of them. Delegating means the "this is
  // not atomic, and here is the failure mode" block cannot be accurate in one
  // file and stale in the other.
  //
  // gemini-pacer.js imports nothing, so this does not break the rule that
  // task-router.js stays loadable by its verifier.
  const r = await checkKvPacingSlot(env, `routing-pace:${providerId}`, minSpacingMs, now);
  return { allowed: r.allowed, elapsedMs: r.waitedMs, degradedOpen: r.degradedOpen };
}

/**
 * The allow-check that runs BEFORE every routed call.
 *
 * @returns {{allowed: boolean, reason: string|null, providerId: string,
 *            callsToday: number, cap: number|null, softStop: number|null,
 *            capUnknown: boolean}}
 *   `reason: 'overtime_required'` means the provider would exceed its free
 *   tier. There is no automatic escalation to a paid tier — the call is
 *   refused and logged, and the lane degrades to its backup.
 */
export async function checkProviderAllowance(env, providerId, {
  tokenEconomy,
  routingConfig,
  asOf = new Date(),
  now = null,
} = {}) {
  const provider = PROVIDER_REGISTRY[providerId];
  const base = { providerId, callsToday: 0, cap: null, softStop: null, capUnknown: true, period: null };

  if (!provider) return { ...base, allowed: false, reason: 'unknown_provider' };
  if (!provider.hasCredential(env)) {
    return { ...base, allowed: false, reason: `missing_credential:${provider.secretName || 'AI binding'}` };
  }

  const { cap, period } = capFor(tokenEconomy, providerId);

  if (cap === null) {
    // OB-100: the spacing is DERIVED from a measured per-minute rate where one
    // exists, and only falls back to the blanket 20s floor where it does not.
    // See paceSpacingFor().
    const spacing = paceSpacingFor(tokenEconomy, providerId, routingConfig);
    const pacing = await checkUnknownCapPacing(env, providerId, spacing.spacingMs, now ?? asOf.getTime());
    // TWO DENIAL REASONS, DELIBERATELY. `unknown_cap_paced` said something
    // false about Cerebras and Mistral for ten days — their rate is known and
    // measured; it was their DAILY cap that was unknown, and the label named
    // the wrong one. A reader of an `attempts` array could not tell a provider
    // nobody had measured from one measured and then ignored. KFM-27: a number
    // (or a reason) must be named after what actually produced it.
    return {
      ...base,
      allowed: pacing.allowed,
      capUnknown: true,
      reason: pacing.allowed ? null : (spacing.basis === 'measured_rate' ? 'rate_paced' : 'unknown_cap_paced'),
      pacing: { ...pacing, spacingMs: spacing.spacingMs, basis: spacing.basis, ratePerMinute: spacing.ratePerMinute },
    };
  }

  const fraction = routingConfig?.soft_stop_fraction ?? 0.6;
  const softStop = Math.floor(cap * fraction);
  const callsToday = await getProviderCallsToday(env, providerId, asOf, period);

  if (callsToday >= softStop) {
    return {
      ...base,
      allowed: false,
      reason: 'overtime_required',
      callsToday,
      cap,
      softStop,
      capUnknown: false,
      period,
    };
  }

  return { ...base, allowed: true, reason: null, callsToday, cap, softStop, capUnknown: false, period };
}

/** Counted calls for one provider in its CURRENT period — the day bucket for a
 * daily cap, the month bucket for a monthly one. Degrades to 0 without D1,
 * same posture as getClaudeCallsToday(). */
export async function getProviderCallsToday(env, providerId, asOf = new Date(), period = 'day') {
  if (!env?.DB) return 0;
  const row = await env.DB.prepare('SELECT call_count FROM provider_usage WHERE period_key = ?')
    .bind(providerPeriodKey(providerId, asOf, period))
    .first()
    .catch(() => null);
  return row?.call_count ?? 0;
}

/**
 * Records a call AFTER it happened, on evidence — never because one was
 * requested.
 *
 * "Evidence" is deliberately defined at two strengths, because the two
 * families of client can prove different things:
 *
 *   CONFIRMED — the provider responded and said what it spent. The four
 *     Phase-A clients report this through their `onResponse` hook and their
 *     `usage` block, so the count and the token numbers are the provider's
 *     own.
 *   UNCONFIRMED — the credential was present and the call was attempted, but
 *     the client returned null and cannot say whether the request reached
 *     the provider. Counted anyway. A failed request still consumes a
 *     free-tier request allowance, and the Claude budget already reasons
 *     this way (getClaudeCallsToday() counts failures for exactly this
 *     reason). Over-counting a network error is the safe direction; the
 *     alternative is quietly exceeding a free tier.
 *
 * Both increment `call_count`, which is what the allow-check reads.
 * `confirmed_count` is kept separately so the supervised test can see how
 * much of the day's count is provider-attested rather than inferred.
 *
 * No-ops without env.DB, same posture as recordClaudeSpend().
 */
export async function recordProviderCall(env, providerId, {
  confirmed = false,
  inputTokens = 0,
  outputTokens = 0,
  asOf = new Date(),
  period = 'day',
} = {}) {
  if (!env?.DB) return { recorded: false, reason: 'no DB binding' };

  const periodKey = providerPeriodKey(providerId, asOf, period);
  // The `day` column holds this provider's BUCKET label — a date for a daily
  // cap, 'YYYY-MM' for a monthly one. See periodBucket().
  const day = periodBucket(period, asOf);

  await env.DB.prepare(PROVIDER_USAGE_TABLE_SQL).run();
  await env.DB.prepare(
    `INSERT INTO provider_usage (period_key, provider, day, call_count, confirmed_count, input_tokens, output_tokens, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(period_key) DO UPDATE SET
       call_count = call_count + 1,
       confirmed_count = confirmed_count + excluded.confirmed_count,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(periodKey, providerId, day, confirmed ? 1 : 0, inputTokens || 0, outputTokens || 0).run();

  return { recorded: true, periodKey, confirmed };
}

/**
 * Per-provider usage for the CURRENT period — feeds the admin status
 * endpoint's quota view. Returns [] without D1.
 *
 * Matches both bucket families, because a monthly-capped provider (cohere)
 * never writes a date-shaped bucket and would otherwise be invisible in the
 * status view exactly when someone is checking whether it is near its limit.
 */
export async function getProviderUsageToday(env, asOf = new Date()) {
  if (!env?.DB) return [];
  const rows = await env.DB.prepare(
    'SELECT provider, day, call_count, confirmed_count, input_tokens, output_tokens FROM provider_usage WHERE day IN (?, ?) ORDER BY provider'
  ).bind(periodBucket('day', asOf), periodBucket('month', asOf)).all().catch(() => null);
  return rows?.results ?? [];
}

/* ────────────────────────────────────────────────────────────────────────
 * THE ROUTED CALL
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Routes one task and calls a provider.
 *
 * NEVER THROWS and never propagates a provider failure to a caller. Every
 * exit is a structured result, because these lanes sit on user-facing paths
 * where a hard failure would take down a cron tick rather than lose one
 * answer.
 *
 * Degradation ladder, in order:
 *   1. Kill switch off              → `routing_disabled`, nothing contacted.
 *   2. Lane not routable            → `lane_never_routed` / `unknown_task_type`
 *                                     / `unknown_provider`.
 *   3. Candidate denied by quota    → logged `overtime_required`, try the next.
 *   4. Candidate denied by pacing   → logged `unknown_cap_paced`, try the next.
 *   5. Candidate call returns null  → recorded as an unconfirmed attempt,
 *                                     try the next.
 *   6. Nothing left                 → skip and log. Never a throw, never a
 *                                     silent over-spend, never a paid tier.
 *
 * A lane with `on_unavailable: 'fail'` (embeddings) has no backup by design —
 * see config/model-routing.json for why substituting another provider's
 * vectors would corrupt an index rather than slow it down.
 *
 * @param {object} opts
 * @param {object} opts.env - Worker env
 * @param {string} opts.taskType - a key in routingConfig.lanes
 * @param {object} opts.routingConfig - config/model-routing.json
 * @param {object} opts.tokenEconomy - config/token-economy.json
 * @param {boolean} [opts.bypassGate] - supervised testing ONLY, via the
 *   routing_test trigger. The scheduled path never passes this.
 * @returns {Promise<{ok: boolean, routed: boolean, lane: string, provider: string|null,
 *   result: object|null, reason: string|null, attempts: Array}>}
 */
export async function routeTask({
  env,
  taskType,
  routingConfig,
  tokenEconomy,
  bypassGate = false,
  rng = Math.random,
  asOf = new Date(),
  personas = null,
  role = null,
  ...callOpts
}) {
  const attempts = [];

  if (!bypassGate && !(await routingEnabled(env))) {
    console.log(`[routing] routing_enabled is off — task "${taskType}" not routed (gated no-op)`);
    return { ok: false, routed: false, lane: taskType, provider: null, result: null, reason: 'routing_disabled', attempts };
  }

  const resolved = resolveLane(routingConfig, taskType, {
    rng,
    role,
    knownCapFirst: (id) => hasKnownCap(tokenEconomy, id),
  });

  if (!resolved.routable) {
    console.warn(`[routing] task "${taskType}" is not routable: ${resolved.reason}`);
    return { ok: false, routed: false, lane: taskType, provider: null, result: null, reason: resolved.reason, attempts, role: resolved.role };
  }

  // Controlled-random lanes log their embodiment map before calling, so the
  // measurement exists even if every provider then fails.
  let embodiment = null;
  if (resolved.mode === 'controlled_random' && Array.isArray(personas) && personas.length > 0) {
    embodiment = assignEmbodiment({ personas, pool: resolved.candidates, rng, eventId: callOpts.eventId || null });
    console.log(`[routing][embodiment] ${JSON.stringify(embodiment.assignments)}`);
  }

  for (const providerId of resolved.candidates) {
    const provider = PROVIDER_REGISTRY[providerId];

    const allowance = await checkProviderAllowance(env, providerId, { tokenEconomy, routingConfig, asOf });
    if (!allowance.allowed) {
      attempts.push({ provider: providerId, outcome: 'denied', reason: allowance.reason });
      console.warn(`[routing] ${taskType}: ${providerId} denied (${allowance.reason})`);
      continue;
    }

    const caps = provider.checkInputWithinCaps(callOpts);
    if (caps.ok === false) {
      attempts.push({ provider: providerId, outcome: 'refused_caps', reason: caps.reason });
      console.warn(`[routing] ${taskType}: ${providerId} refused input (${caps.reason})`);
      continue;
    }

    let responded = false;
    let responseUsage = null;
    /*
     * `responseError` added 2026-08-10, and it is not a convenience.
     *
     * Until this line existed, a failed provider call came back as
     * `{ outcome: 'failed', reason: 'provider_error' }` and the provider's own
     * message — the status, the code, the sentence naming a retired model —
     * existed only in a console.warn nobody reads at the moment they need it.
     * That is AD-030's central lesson turned on this router:
     *
     *   A silent fallback converts every upstream failure into the same
     *   symptom. The response body is the only thing that discriminates a dead
     *   key from a dead model, and a fallback that discards it has destroyed
     *   the evidence needed to diagnose it.
     *
     * It was found the first time this router was asked to make a real image:
     * the lane reported `provider_error`, which is true of a bad model ID, a
     * quota refusal, a missing binding and a transport failure alike — four
     * different fixes behind one word. The attempt trail now carries the
     * message, truncated, so a supervised test can read it from the trigger's
     * own response instead of racing a log tail.
     */
    let responseError = null;
    let responseStatus = null;
    const onResponse = (info) => {
      responded = true;
      responseUsage = info?.usage ?? null;
      if (info?.error) responseError = String(info.error).slice(0, 300);
      if (info?.status != null) responseStatus = info.status;
    };

    const result = await provider.invoke(env, { ...callOpts, onResponse });

    // Count against the same period the allow-check just read, so a provider
    // can never be checked monthly and recorded daily.
    const countPeriod = capFor(tokenEconomy, providerId).period ?? 'day';

    /* ── AN EMPTY ANSWER IS NOT A SUCCESS (wired 2026-08-10) ──────────────
     *
     * provider-common.js added `finishReason` to the envelope with an
     * explicit purpose, written in its own header: "so a max_tokens-truncated
     * answer can be REJECTED rather than parsed as if it were complete."
     * NOTHING EVER READ IT. The field was defined and never wired into the
     * call site — the same shape as checkCodeWriteAllowedForModel(), which
     * existed for `frontend_code_change` and was never attached to it.
     *
     * The supervised test found it on 2026-08-10, on the lane it hurts most.
     * Cerebras' `gpt-oss-120b` is a REASONING model: it spends output tokens
     * thinking before it emits any content. Measured, same 87-token prompt:
     *
     *     maxTokens  64 -> text ""     finishReason "length"   ok: true
     *     maxTokens 600 -> text "0.8"  finishReason "stop"     154 output tokens
     *
     * So a judgment-lane call — "score this 0-1", the natural place to ask for
     * a small budget — returned an empty string wrapped in a perfectly
     * well-formed success envelope, with `ok: true` and one clean attempt. The
     * lane did not degrade, because a truthy `result` was the only test.
     *
     * An empty answer must fail like any other failure: record what it spent,
     * then move to the backup. `kind === 'chat'` guards the embeddings lane,
     * whose result carries `embeddings` and no `text` at all and must not be
     * caught by this.
     */
    const emptyChat = !!result && resolved.kind === 'chat' && !String(result.text || '').trim();

    /* ── AN EMPTY IMAGE IS NOT A SUCCESS EITHER  (added 2026-08-10) ────────
     *
     * The same guard, one kind over, added IN THE SAME COMMIT as the image lane
     * rather than after an incident. That timing is the whole point: the chat
     * version of this check was written five days after `finishReason` was added
     * for exactly that purpose and never read, and it took a supervised test on
     * the live judgment lane to find it. An image provider returning a
     * well-formed envelope with zero bytes in it is the identical shape, and the
     * consequence is worse — an empty asset committed to a repo with a
     * provenance note attached looks, to every later reader, like a real asset
     * the Designer made.
     *
     * Zero bytes is the signal, not `finishReason`: neither provider reliably
     * reports a finish reason for images (the Workers AI binding is not an HTTP
     * response this code sees), so a guard that waited for one would never fire.
     * `finishReason` is still reported in the reason string when a provider does
     * supply it, because it is the only thing that distinguishes a refusal from
     * a truncation.
     */
    const emptyImage = !!result && resolved.kind === 'image' && !(result.bytes > 0 && String(result.base64 || '').length > 0);

    if (emptyImage) {
      await recordProviderCall(env, providerId, {
        confirmed: true,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        asOf,
        period: capFor(tokenEconomy, providerId).period ?? 'day',
      });
      attempts.push({ provider: providerId, outcome: 'failed', reason: 'empty_image' });
      console.warn(
        `[routing] ${taskType}: ${providerId} returned an empty image `
        + `(bytes=${result.bytes ?? 0}, finishReason=${result.finishReason ?? 'null'}) — refusing. `
        + 'An empty asset with a provenance note reads, later, as a real asset.'
      );
      // No `continue` past a second candidate here in practice: a `roles` lane
      // resolves to exactly one provider, so this exits the loop into the
      // all_candidates_exhausted return. A ROLE DOES NOT DEGRADE TO THE OTHER
      // ROLE — see config/model-routing.json's image lane.
      continue;
    }

    if (emptyChat) {
      // The provider answered and spent real tokens — record them on ITS
      // numbers, not zeroes, because the free tier was consumed either way.
      await recordProviderCall(env, providerId, {
        confirmed: true,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        asOf,
        period: countPeriod,
      });
      const why = result.finishReason === 'length' ? 'empty_text_truncated' : 'empty_text';
      attempts.push({ provider: providerId, outcome: 'failed', reason: why });
      console.warn(
        `[routing] ${taskType}: ${providerId} returned an empty answer `
        + `(finishReason=${result.finishReason ?? 'null'}, outputTokens=${result.usage?.outputTokens ?? '?'}) — degrading`
      );
      continue;
    }

    if (result) {
      await recordProviderCall(env, providerId, {
        confirmed: true,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        asOf,
        period: countPeriod,
      });
      attempts.push({ provider: providerId, outcome: 'ok' });

      /* ── SUBSTITUTION, MADE LOUD AT THE SOURCE (2026-08-11) ────────────────
       *
       * Until this line, an answering backup was visible only to a caller
       * willing to re-derive it from `attempts[0]` — which report-pipeline.js
       * does (its own providerLabel()/noteProviderSubstitution()), and no
       * other routed caller does, because nothing forced it to. A primary
       * that never answers and a backup that quietly covers for it is
       * CORRECT behaviour — that is what the backup is for — but it must not
       * be indistinguishable from the primary having answered, on a
       * measurement instrument whose whole job is recording which provider
       * actually spoke (config/model-routing.json `_why_random`).
       *
       * `resolved.candidates[0]` is the lane's PLANNED primary — table order,
       * never reordered by this router (see resolveLane()'s own comment).
       * Every ROUTABLE lane reaches this point with at least one candidate,
       * so the comparison is always meaningful here, unlike report-pipeline's
       * copy of this logic which has to allow for a null plan.
       */
      const plannedProvider = resolved.candidates[0];
      const substituted = providerId !== plannedProvider;
      if (substituted) {
        console.warn(
          `[routing] ${taskType}: SUBSTITUTED — planned "${plannedProvider}", answered "${providerId}". `
          + `${plannedProvider} did not respond (${attempts.filter((a) => a.provider === plannedProvider).map((a) => a.reason).join(', ') || 'see attempts'}). `
          + 'The call succeeded and the caller is unaffected, but any embodiment or quality figure attributed to the planned provider is wrong for this call.'
        );
      }

      return {
        ok: true,
        routed: true,
        lane: taskType,
        provider: providerId,
        plannedProvider,
        substituted,
        result,
        reason: null,
        attempts,
        embodiment,
        kind: resolved.kind,
        role: resolved.role,
      };
    }

    // Null result: the call was attempted with a credential present. Count it
    // — see recordProviderCall()'s note on confirmed vs unconfirmed evidence.
    await recordProviderCall(env, providerId, {
      confirmed: responded,
      inputTokens: responseUsage?.inputTokens ?? 0,
      outputTokens: responseUsage?.outputTokens ?? 0,
      asOf,
      period: countPeriod,
    });
    attempts.push({
      provider: providerId,
      outcome: 'failed',
      reason: responded ? 'provider_error' : 'no_response',
      // The evidence, carried rather than logged and lost. See onResponse above.
      status: responseStatus,
      providerMessage: responseError,
    });
    console.warn(`[routing] ${taskType}: ${providerId} returned no result — degrading${responseError ? ` (${responseError})` : ''}`);
  }

  console.warn(
    `[routing] ${taskType}: every candidate denied or failed — skipping, not failing`
    + (resolved.mode === 'roles' ? `. This is a ROLES lane: role "${resolved.role}" has exactly one provider and does NOT degrade to another role.` : '')
  );
  return {
    ok: false,
    routed: true,
    lane: taskType,
    provider: null,
    result: null,
    reason: 'all_candidates_exhausted',
    attempts,
    embodiment,
    kind: resolved.kind,
    role: resolved.role,
  };
}

/* ────────────────── The configured model identifiers (2026-08-23) ─────────── */

/**
 * Every model identifier the ROUTER's providers are configured to send, as
 * catalogue-check targets for `workers/model-catalog.js`.
 *
 * ── WHY IT IS HERE AND NOT IN THE CHECKER ────────────────────────────────
 *
 * `scripts/verify-providers.js` enforces that `cerebras-client.js`,
 * `mistral-client.js` and `cohere-client.js` are imported by NOTHING but this
 * file, by any symbol — the containment rule that keeps a provider call from
 * bypassing the kill switch and the quota check. So the checker cannot read
 * their `DEFAULT_MODEL`s itself, and this module, which already holds all five
 * clients, hands them over.
 *
 * That constraint produced the right design anyway: the identifiers travel from
 * the ONE place each is defined. A retirement checker holding its own copy of a
 * model ID verifies its copy, not the config, and would have stayed green
 * through every one of the five retirements this estate has already had.
 *
 * NOT a routing path and not a call — a plain read of five descriptor objects.
 * Anthropic is absent from `PROVIDER_REGISTRY` and therefore absent here, which
 * is the containment rule holding; the Guides pipeline's `claude-sonnet-5` is
 * added by `agent-runner.js` from `claude-client.js`, its own definition site.
 */
export function routerModelTargets() {
  return [
    { provider: 'cerebras', model: CEREBRAS_PROVIDER.defaultModel, configuredIn: ['workers/cerebras-client.js DEFAULT_MODEL', 'config/token-economy.json providers.cerebras._model_note'] },
    { provider: 'mistral', model: MISTRAL_PROVIDER.defaultModel, configuredIn: ['workers/mistral-client.js DEFAULT_MODEL'] },
    { provider: 'cohere', model: COHERE_PROVIDER.defaultModel, configuredIn: ['workers/cohere-client.js DEFAULT_MODEL'] },
    { provider: 'cloudflare-images', model: CF_IMAGE_PROVIDER.defaultModel, configuredIn: ['workers/cf-image-client.js DEFAULT_MODEL', 'config/token-economy.json providers.cloudflare_images.default_model'] },
    { provider: 'gemini-images', model: GEMINI_IMAGE_PROVIDER.defaultModel, configuredIn: ['workers/gemini-image-client.js DEFAULT_MODEL', 'config/token-economy.json providers.gemini_images.default_model'] },
  ].filter((t) => !!t.model);
}
