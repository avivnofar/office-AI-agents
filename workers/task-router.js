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
      return r ? envelope({ text: r.text, source: r.source }) : null;
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
        return r ? envelope({ text: r.text, source: r.source }) : null;
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
        return r ? envelope({ text: r.text, source: r.source }) : null;
      } catch (err) {
        console.warn(`[routing] gemini call failed: ${err.message}`);
        return null;
      }
    },
  },
};

/* ────────────────────────────────────────────────────────────────────────
 * LANE RESOLUTION
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Resolves a task type to an ORDERED candidate list.
 *
 * @returns {{routable: boolean, lane: string, candidates: string[], mode: string,
 *            kind: string, reason: string|null}}
 *   `routable: false` with a reason for: an unknown task type, a lane marked
 *   non-routable (the Architect), or a lane naming a provider that is not in
 *   the registry. Never throws.
 */
export function resolveLane(routingConfig, taskType, { rng = Math.random, knownCapFirst = null } = {}) {
  const lane = routingConfig?.lanes?.[taskType];

  if (!lane) {
    return { routable: false, lane: taskType, candidates: [], mode: null, kind: null, reason: 'unknown_task_type' };
  }

  if (lane.routable === false) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode: null,
      kind: lane.kind || null,
      reason: 'lane_never_routed',
    };
  }

  let candidates;
  let mode;

  if (lane.mode === 'controlled_random') {
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
      kind: lane.kind || null,
      reason: `unknown_provider:${unknown.join(',')}`,
    };
  }

  const wrongKind = candidates.filter((id) => lane.kind && PROVIDER_REGISTRY[id].kind !== lane.kind);
  if (wrongKind.length > 0) {
    return {
      routable: false,
      lane: taskType,
      candidates: [],
      mode,
      kind: lane.kind,
      reason: `provider_kind_mismatch:${wrongKind.join(',')}`,
    };
  }

  if (candidates.length === 0) {
    return { routable: false, lane: taskType, candidates: [], mode, kind: lane.kind || null, reason: 'lane_has_no_providers' };
  }

  return { routable: true, lane: taskType, candidates, mode, kind: lane.kind || 'chat', reason: null };
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
 * @param {object} opts
 * @param {Array<{id: number|string, name: string}>} opts.personas
 * @param {string[]} opts.pool - provider ids (non-Anthropic by construction)
 * @param {function} [opts.rng] - injectable for deterministic verification
 * @returns {{eventId: string|null, assignments: Array<{agentId, agentName, provider}>,
 *            pool: string[], excluded: Array<{agentName, reason}>}}
 */
export function assignEmbodiment({ personas = [], pool = [], rng = Math.random, eventId = null } = {}) {
  const excluded = [];
  const eligible = personas.filter((p) => {
    const isArchitect = String(p.id) === '10' || /architect/i.test(p.name || '');
    if (isArchitect) excluded.push({ agentName: p.name, reason: 'architect_never_shuffled' });
    return !isArchitect;
  });

  const usable = pool.filter((id) => PROVIDER_REGISTRY[id] && PROVIDER_REGISTRY[id].kind === 'chat');

  const assignments = eligible.map((p) => ({
    agentId: p.id,
    agentName: p.name,
    provider: usable.length > 0 ? usable[Math.floor(rng() * usable.length)] : null,
  }));

  return { eventId, assignments, pool: usable, excluded };
}

/**
 * Renders an embodiment map for a meeting record
 * (back-office-AI-agents/campus/shared/meetings/<date>-<type>.md, plan item
 * 2.4) and for the console log of a routed event.
 */
export function renderEmbodimentMap({ eventId, assignments = [], excluded = [] } = {}) {
  const lines = [`**Embodiment map**${eventId ? ` — event \`${eventId}\`` : ''}`, ''];
  lines.push('| Agent | Played by |');
  lines.push('|---|---|');
  for (const a of assignments) lines.push(`| ${a.agentName} (${a.agentId}) | \`${a.provider || 'none'}\` |`);
  for (const e of excluded) lines.push(`| ${e.agentName} | _not shuffled — ${e.reason}_ |`);
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
 * Wall-clock pacing for a provider whose daily cap is UNKNOWN.
 *
 * An unknown cap cannot be enforced by counting, and treating it as
 * unlimited is exactly what the owner ruled out. So it is enforced by time
 * instead: at most one routed call per `minSpacingMs` per provider, tracked
 * by a KV timestamp. Mechanism and 20s floor both lifted from
 * workers/gemini-pacer.js, which solves the same problem for the same
 * reason — a quota this repo cannot observe.
 *
 * Check-and-set, like the pacer: an allowed check consumes the slot. If a
 * later gate then denies the call, the slot is spent without a call being
 * made. That is conservative in the safe direction and is left as-is.
 *
 * Degrades OPEN without SIM_KV, matching the pacer and the rest of this repo.
 */
async function checkUnknownCapPacing(env, providerId, minSpacingMs, now) {
  if (!env?.SIM_KV) return { allowed: true, elapsedMs: null, degradedOpen: true };

  const key = `routing-pace:${providerId}`;
  const lastRaw = await env.SIM_KV.get(key).catch(() => null);
  const last = lastRaw ? Number(lastRaw) : 0;
  const elapsed = now - last;

  if (elapsed < minSpacingMs) return { allowed: false, elapsedMs: elapsed, degradedOpen: false };

  await env.SIM_KV.put(key, String(now)).catch(() => {});
  return { allowed: true, elapsedMs: elapsed, degradedOpen: false };
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
    const spacing = routingConfig?.unknown_cap_min_spacing_ms ?? 20_000;
    const pacing = await checkUnknownCapPacing(env, providerId, spacing, now ?? asOf.getTime());
    return {
      ...base,
      allowed: pacing.allowed,
      capUnknown: true,
      reason: pacing.allowed ? null : 'unknown_cap_paced',
      pacing,
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
  ...callOpts
}) {
  const attempts = [];

  if (!bypassGate && !(await routingEnabled(env))) {
    console.log(`[routing] routing_enabled is off — task "${taskType}" not routed (gated no-op)`);
    return { ok: false, routed: false, lane: taskType, provider: null, result: null, reason: 'routing_disabled', attempts };
  }

  const resolved = resolveLane(routingConfig, taskType, {
    rng,
    knownCapFirst: (id) => hasKnownCap(tokenEconomy, id),
  });

  if (!resolved.routable) {
    console.warn(`[routing] task "${taskType}" is not routable: ${resolved.reason}`);
    return { ok: false, routed: false, lane: taskType, provider: null, result: null, reason: resolved.reason, attempts };
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
    const onResponse = (info) => {
      responded = true;
      responseUsage = info?.usage ?? null;
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
      return {
        ok: true,
        routed: true,
        lane: taskType,
        provider: providerId,
        result,
        reason: null,
        attempts,
        embodiment,
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
    attempts.push({ provider: providerId, outcome: 'failed', reason: responded ? 'provider_error' : 'no_response' });
    console.warn(`[routing] ${taskType}: ${providerId} returned no result — degrading`);
  }

  console.warn(`[routing] ${taskType}: every candidate denied or failed — skipping, not failing`);
  return {
    ok: false,
    routed: true,
    lane: taskType,
    provider: null,
    result: null,
    reason: 'all_candidates_exhausted',
    attempts,
    embodiment,
  };
}
