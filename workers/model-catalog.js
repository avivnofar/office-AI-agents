/**
 * Data Center — AI Agent Simulation — THE MODEL CATALOGUE CHECK.
 *
 * Added 2026-08-23 (Session 14, ITEM C). Answers ONE question, for every model
 * identifier this estate has configured: **does it still exist at its
 * provider?**
 *
 * ── WHY THIS EXISTS: FIVE RETIREMENTS AND NO CHECK ───────────────────────
 *
 * Five model identifiers have now been retired out from under this project:
 *
 *   gemini-3.5-flash           retired, swept 2026-07-09
 *   gemini-2.5-flash           found 404 live, 2026-07-09
 *   cerebras llama-3.3-70b     never existed on the key at all, found 2026-08-06
 *   groq llama3-8b-8192        shut down 2025-08-30, found 2026-08-09 as a 400
 *   groq llama-3.1-8b-instant  shut down 2026-08-16, found 2026-08-23 as a 404
 *
 * The last one is why this file is not just another verifier. It was chosen ON
 * 2026-08-09 as the fix for the one before it — and it was ALREADY on Groq's
 * published deprecation list at that moment, with a shutdown date already set.
 * The 2026-08-09 session checked that the model was PRESENT in the live
 * catalogue, which it was, and a present-today model with a published end date
 * reads exactly like a healthy one. So that migration was correct, verified,
 * and had seven days of life left in it.
 *
 * Nothing anywhere ran that check a second time.
 *
 * ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *
 * It checks PRESENCE IN THE LIVE CATALOGUE. That is a WEAKER question than
 * "will this model still be alive next month", and the paragraph above is the
 * proof that it is weaker: presence was true of `llama-3.1-8b-instant` on the
 * day it was adopted. Most providers do not expose a retirement date in their
 * listing endpoint, so a deprecation date cannot be read here and is NOT
 * claimed. What this closes is the found-seven-days-late case, not the
 * found-seven-days-early one — run weekly, an absent model surfaces within a
 * week of vanishing instead of whenever something finally breaks loudly enough
 * to be looked at.
 *
 * ── WHY IT RUNS INSIDE THE WORKER ────────────────────────────────────────
 *
 * AD-030, in its own words: a secret you cannot read is a secret you cannot
 * verify, so the only meaningful catalogue check is the one made by the thing
 * that will make the call. A local script with a key out of a `.env` tests THAT
 * key and says nothing about the one the Worker holds. So this module is called
 * from `workers/agent-runner.js`'s `{"type":"model_catalog"}` admin trigger,
 * with the Worker's own secrets — exactly as `{"type":"image_catalog"}` already
 * does for the two image models.
 *
 * ── PURE BY CONSTRUCTION ─────────────────────────────────────────────────
 *
 * It imports NOTHING — no JSON, no client module — for two independent reasons.
 * (1) `scripts/verify-model-catalog.js` must be able to load and CALL it under
 * plain `node`, the same constraint `task-router.js` and `guide-engine.js`
 * satisfy for their own verifiers. (2) `verify-providers.js` enforces that
 * `cerebras-client.js`, `mistral-client.js` and `cohere-client.js` are imported
 * by NOTHING but the router, by any symbol — so the configured identifiers
 * cannot be imported here. They are passed IN by the caller, which reads each
 * from the one place it is defined. That keeps this file from becoming a sixth
 * copy of the model IDs, which is the exact drift the mechanism exists to catch.
 *
 * ── `not_checkable` IS A RESULT, NOT A GAP ───────────────────────────────
 *
 * Cloudflare Workers AI publishes no catalogue the `AI` binding can read from
 * inside a Worker. It is reported as `not_checkable` WITH THE REASON and with
 * the command that does answer it. Silence there would read as a pass — this
 * project's dominant defect shape (a green light wired to nothing), committed
 * by the instrument built to catch it.
 */

/** A model that was looked for and was NOT in the provider's live catalogue. */
export const ABSENT = 'ABSENT';
/** Present in the live catalogue on this run. Says nothing about next month. */
export const PRESENT = 'present';
/** The provider publishes no listing endpoint this Worker can read. A FACT. */
export const NOT_CHECKABLE = 'not_checkable';
/**
 * The listing call itself failed — network, auth, or an unparseable body.
 * Deliberately NOT the same verdict as ABSENT: a catalogue nobody could read is
 * not evidence that a model is gone, and collapsing the two would manufacture
 * exactly the false credential accusation AD-030 forbids.
 */
export const CHECK_FAILED = 'check_failed';

/**
 * How each provider's catalogue is read.
 *
 * `secretName` names the secret rather than carrying its value — nothing in
 * this module ever returns, logs or renders a key. `endpointLabel` is what
 * appears in output, so a provider that carries its key in the QUERY STRING
 * (Gemini does) can be reported without the URL that contains it.
 */
export const CATALOG_SOURCES = Object.freeze({
  groq: {
    endpointLabel: 'GET https://api.groq.com/openai/v1/models',
    secretName: 'GROQ_API_KEY',
    request: (key) => ({
      url: 'https://api.groq.com/openai/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    }),
    extract: (data) => (data?.data || []).map((m) => m?.id).filter(Boolean),
  },
  cerebras: {
    endpointLabel: 'GET https://api.cerebras.ai/v1/models',
    secretName: 'CEREBRAS_API_KEY',
    request: (key) => ({
      url: 'https://api.cerebras.ai/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    }),
    extract: (data) => (data?.data || []).map((m) => m?.id).filter(Boolean),
  },
  mistral: {
    endpointLabel: 'GET https://api.mistral.ai/v1/models',
    secretName: 'MISTRAL_API_KEY',
    request: (key) => ({
      url: 'https://api.mistral.ai/v1/models',
      headers: { Authorization: `Bearer ${key}` },
    }),
    extract: (data) => (data?.data || []).map((m) => m?.id).filter(Boolean),
  },
  cohere: {
    endpointLabel: 'GET https://api.cohere.com/v1/models?page_size=1000',
    secretName: 'COHERE_API_KEY',
    request: (key) => ({
      url: 'https://api.cohere.com/v1/models?page_size=1000',
      headers: { Authorization: `Bearer ${key}` },
    }),
    extract: (data) => (data?.models || []).map((m) => m?.name).filter(Boolean),
  },
  gemini: {
    // The key rides in the `x-goog-api-key` header, not the URL or query
    // string, so it never reaches Cloudflare Workers Logs' subrequest URL
    // record. `endpointLabel` is what output shows.
    endpointLabel: 'GET https://generativelanguage.googleapis.com/v1beta/models',
    secretName: 'GEMINI_API_KEY',
    request: (key) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      headers: { 'x-goog-api-key': key },
    }),
    // Gemini returns fully-qualified names (`models/gemini-3.1-flash-lite`).
    // BOTH forms are emitted so a configured id matches whichever way it is
    // written, rather than this module deciding which spelling is canonical and
    // reporting a live model as absent over a prefix.
    extract: (data) => (data?.models || []).flatMap((m) => {
      const name = m?.name;
      if (!name) return [];
      return String(name).startsWith('models/')
        ? [name, String(name).slice('models/'.length)]
        : [name];
    }),
  },
  /*
   * The image lane's polish role. SAME endpoint and SAME key as `gemini` above
   * — `config/token-economy.json` says so in `gemini_images`'
   * `_this_is_the_same_key_as_the_gemini_block_below` — so this is one listing
   * call's worth of catalogue reused, not a second provider. It is a separate
   * ENTRY rather than a rename because `routerModelTargets()` reports the image
   * providers under their lane-facing ids, and flattening the two here would
   * make a `gemini-images` result unattributable to the role that configured it.
   */
  'gemini-images': {
    endpointLabel: 'GET https://generativelanguage.googleapis.com/v1beta/models  (same key and endpoint as `gemini`)',
    secretName: 'GEMINI_API_KEY',
    request: (key) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      headers: { 'x-goog-api-key': key },
    }),
    extract: (data) => (data?.models || []).flatMap((m) => {
      const name = m?.name;
      if (!name) return [];
      return String(name).startsWith('models/')
        ? [name, String(name).slice('models/'.length)]
        : [name];
    }),
  },
  anthropic: {
    /*
     * ── ANTHROPIC IS HERE, AND IT IS NOT A ROUTING PATH ──────────────────
     *
     * `config/model-routing.json` and `workers/task-router.js` keep Anthropic
     * unreachable from the ROUTER, twice over, and nothing about that changes:
     * this module is not the router, holds no lane, is imported by no lane, and
     * generates nothing. It reads a LISTING endpoint.
     *
     * It is included because `workers/claude-client.js` pins `claude-sonnet-5`
     * for the Guides pipeline, and an unchecked model identifier is the whole
     * thing this file exists to stop. Leaving the one paid provider out of the
     * retirement check on the strength of a rule about routing would be reading
     * that rule's words instead of its purpose.
     */
    endpointLabel: 'GET https://api.anthropic.com/v1/models?limit=1000  (catalogue listing ONLY — not a routing path, not a generation call, costs nothing against either Claude budget)',
    secretName: 'ANTHROPIC_API_KEY',
    request: (key) => ({
      url: 'https://api.anthropic.com/v1/models?limit=1000',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }),
    extract: (data) => (data?.data || []).map((m) => m?.id).filter(Boolean),
  },
});

/**
 * Providers whose catalogue CANNOT be read from inside the Worker, each with
 * the reason and with what does answer the question.
 *
 * Reported, never omitted. A checker that silently skips what it cannot see
 * reports "0 problems" for the same reason it would report 0 if everything were
 * fine, and the two are indistinguishable to whoever reads the summary.
 */
export const NOT_CHECKABLE_PROVIDERS = Object.freeze({
  'cloudflare-ai': 'Workers AI publishes no catalogue the account-scoped `AI` binding can list from inside a Worker. The REST catalogue (`/accounts/{id}/ai/models/search`) needs a Cloudflare API token, which this Worker does not hold and must not be granted for a read-only check. Answer it out of band: `npx wrangler ai models`.',
  // The draft model is deliberately NOT named in this string. It is named in
  // `workers/cf-image-client.js`, which is the one place it is defined, and
  // scripts/verify-model-catalog.js §9 asserts that no live identifier appears
  // as a value in this module — a checker holding its own copy of an ID checks
  // its copy.
  'cloudflare-images': 'Same binding, same absence, same command — `npx wrangler ai models` against this account. That is how the image lane\'s draft model was verified on 2026-08-10.',
});

/**
 * Whether `status` is a verdict that should fail the run. ONLY `ABSENT` does.
 * A failed listing and an unreadable provider are reported loudly and do NOT go
 * red — see CHECK_FAILED on why a missing catalogue is not evidence a model is
 * gone.
 */
export function isRed(status) {
  return status === ABSENT;
}

/**
 * Checks every target against its provider's live catalogue.
 *
 * ONE listing call per provider, however many identifiers that provider holds:
 * the catalogue is fetched once and every target for it is matched against the
 * same list. That is a correctness property as well as a courtesy — two targets
 * on one provider can never disagree about what the catalogue said.
 *
 * @param {object} opts
 * @param {Array<{provider: string, model: string, configuredIn: string[], probe?: boolean}>} opts.targets
 * @param {object} opts.env             the Worker env, read ONLY for `secretName` lookups
 * @param {Function} [opts.fetchImpl]   injected by the verifier; defaults to global fetch
 * @returns {Promise<{ok: boolean, checked: number, red: number, results: Array, providers: object}>}
 */
export async function checkModelCatalogs({ targets = [], env = {}, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const byProvider = new Map();
  for (const t of targets) {
    if (!t?.provider || !t?.model) continue;
    if (!byProvider.has(t.provider)) byProvider.set(t.provider, []);
    byProvider.get(t.provider).push(t);
  }

  const providers = {};
  const results = [];

  for (const [provider, group] of byProvider) {
    const source = CATALOG_SOURCES[provider];

    if (!source) {
      const reason = NOT_CHECKABLE_PROVIDERS[provider]
        || `no catalogue listing endpoint is defined for provider '${provider}' in CATALOG_SOURCES`;
      providers[provider] = { checkable: false, reason, catalogSize: null, endpoint: null };
      for (const t of group) results.push({ ...t, status: NOT_CHECKABLE, reason, catalogSize: null });
      continue;
    }

    const key = env?.[source.secretName];
    if (!key) {
      const reason = `${source.secretName} is not configured on this Worker, so the catalogue could not be read. This is NOT evidence the model is gone.`;
      providers[provider] = { checkable: false, reason, catalogSize: null, endpoint: source.endpointLabel };
      for (const t of group) results.push({ ...t, status: CHECK_FAILED, reason, catalogSize: null });
      continue;
    }

    let ids = null;
    let reason = null;
    try {
      const { url, headers } = source.request(key);
      const res = await doFetch(url, { headers });
      if (!res?.ok) {
        // The BODY, not just the status. AD-030's whole lesson: a 400 about a
        // model and a 401 about a key look identical from the status line, and
        // this project has misread one as the other and done real damage.
        const body = res?.text ? await res.text().catch(() => '') : '';
        reason = `catalogue listing returned HTTP ${res?.status} — body: ${String(body).slice(0, 400)}`;
      } else {
        const data = await res.json();
        ids = source.extract(data);
        if (!Array.isArray(ids) || ids.length === 0) {
          reason = 'catalogue listing returned HTTP 200 with an EMPTY model list — treated as unreadable, not as "every model at this provider is gone"';
          ids = null;
        }
      }
    } catch (err) {
      reason = `catalogue listing threw: ${err?.message || err}`;
    }

    if (!ids) {
      providers[provider] = { checkable: true, reason, catalogSize: null, endpoint: source.endpointLabel };
      for (const t of group) results.push({ ...t, status: CHECK_FAILED, reason, catalogSize: null });
      continue;
    }

    const set = new Set(ids);
    providers[provider] = {
      checkable: true,
      reason: null,
      catalogSize: ids.length,
      endpoint: source.endpointLabel,
      catalog: ids.slice().sort(),
    };
    for (const t of group) {
      const present = set.has(t.model);
      results.push({
        ...t,
        status: present ? PRESENT : ABSENT,
        catalogSize: ids.length,
        reason: present
          ? null
          : `'${t.model}' is NOT in ${provider}'s live catalogue (${ids.length} models listed). THIS IS A CONFIG FIX, NOT A KEY PROBLEM — the same key just read that catalogue successfully. Do not propose a credential rotation (AD-030).`,
      });
    }
  }

  const red = results.filter((r) => isRed(r.status)).length;
  return {
    ok: red === 0,
    checked: results.length,
    red,
    results,
    providers,
    _how_to_read_this: 'ok:false means at least one CONFIGURED model identifier is absent from its provider\'s live catalogue — a config fix, never a credential one. `not_checkable` and `check_failed` are reported and do NOT set ok:false: an unreadable catalogue is not evidence that a model is gone. Presence today is not a promise about next month — see this module\'s header on why llama-3.1-8b-instant passed this exact check on the day it was adopted and died seven days later.',
  };
}

/**
 * The short human summary the weekly job puts in its run log. Rendered here
 * rather than in the workflow so the wording is the same wherever it is read.
 */
export function renderCatalogSummary(report) {
  const lines = [];
  lines.push(report.ok
    ? `MODEL CATALOGUE: ${report.checked} configured identifier(s) checked, none absent.`
    : `MODEL CATALOGUE: ${report.red} of ${report.checked} configured identifier(s) are ABSENT from their provider's live catalogue.`);
  for (const r of report.results) {
    const where = (r.configuredIn || []).join(', ') || 'unrecorded';
    const mark = r.status === ABSENT ? '  [ABSENT]' : r.status === PRESENT ? '  [ok]    ' : '  [?]     ';
    lines.push(`${mark} ${r.provider} / ${r.model}${r.probe ? '  <- PROBE, deliberately injected, not a real config value' : ''} — ${r.status}${r.reason ? ` — ${r.reason}` : ''} (configured in: ${where})`);
  }
  return lines.join('\n');
}
