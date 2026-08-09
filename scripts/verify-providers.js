#!/usr/bin/env node
// Dry-run verification for the provider client modules added 2026-08-05
// (task-type routing, plan Phase 3 item 3.2).
//
// NO NETWORK. NO D1/KV. NO MODEL CALLS. Every path exercised here returns
// before its fetch() — a missing key, a refused cap, or a bad argument. The
// script asserts that fact directly by replacing globalThis.fetch with a
// tripwire that throws if anything reaches it.
//
// This loads the client modules with a real `import`, which is possible only
// because none of them import JSON — the same constraint
// workers/guide-engine.js satisfies for scripts/verify-guide-engine.js.
// workers/model-router.js cannot be imported this way (it imports
// config/token-economy.json), so anything about it is checked as text.
//
// Run: node scripts/verify-providers.js

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

import * as cerebras from '../workers/cerebras-client.js';
import * as mistral from '../workers/mistral-client.js';
import * as cohere from '../workers/cohere-client.js';
import { estimateTokens, estimatePromptTokens, parseRateLimitHeaders, normalizeOpenAiChat } from '../workers/provider-common.js';

const require = createRequire(import.meta.url);
const tokenEconomy = require('../config/token-economy.json');

/**
 * True if source references Anthropic THE PROVIDER.
 *
 * Deliberately blind to the string "CLAUDE.md" — that is this repo's own
 * documentation filename, cited in several module headers, and matching it
 * would make this check fire on a comment while a real `api.anthropic.com`
 * call could still hide behind a variable. Strip the filename first, then
 * look for the provider.
 */
function mentionsAnthropicProvider(src) {
  const withoutDocFilename = src.replace(/CLAUDE\.md/g, '<repo-doc>');
  return /anthropic|claude/i.test(withoutDocFilename);
}

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`[PASS] ${label}`);
    pass += 1;
  } else {
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

/* ── Tripwire: prove nothing in this verifier touches the network ───────── */
const NETWORK_TRIPWIRE = [];
globalThis.fetch = (...args) => {
  NETWORK_TRIPWIRE.push(String(args[0]));
  throw new Error(`verify-providers.js made a network call to ${args[0]} — this verifier must stay dry-run`);
};

/** Runs fn with console.warn captured, returning [result, warnings]. */
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await fn();
    return [result, warnings];
  } finally {
    console.warn = original;
  }
}

console.log('=== Provider client verification — dry-run only, no network/model/D1/KV calls ===\n');

/* ── The uniform export surface the router will consume ─────────────────── */
console.log('--- Uniform export surface (what the router expects from every provider) ---');

const MODULES = [
  { name: 'cerebras-client.js', mod: cerebras, id: 'cerebras', kind: 'chat', secret: 'CEREBRAS_API_KEY', limitsExport: 'CEREBRAS_LIMITS' },
  { name: 'mistral-client.js', mod: mistral, id: 'mistral', kind: 'chat', secret: 'MISTRAL_API_KEY', limitsExport: 'MISTRAL_LIMITS' },
  { name: 'cohere-client.js', mod: cohere, id: 'cohere', kind: 'embeddings', secret: 'COHERE_API_KEY', limitsExport: 'COHERE_LIMITS' },
];

for (const { name, mod, id, kind, secret, limitsExport } of MODULES) {
  const p = mod.PROVIDER;
  check(`${name} exports a PROVIDER descriptor`, !!p && typeof p === 'object');
  check(`${name} PROVIDER.id is "${id}"`, p?.id === id, `got ${p?.id}`);
  check(`${name} PROVIDER.kind is "${kind}"`, p?.kind === kind, `got ${p?.kind}`);
  check(`${name} PROVIDER.secretName names the exact Worker secret (${secret})`, p?.secretName === secret, `got ${p?.secretName}`);
  check(`${name} PROVIDER.call is a function`, typeof p?.call === 'function');
  check(`${name} PROVIDER.checkInputWithinCaps is a function`, typeof p?.checkInputWithinCaps === 'function');
  check(`${name} PROVIDER.limits is present and declares paid:false (the overtime rule)`, p?.limits?.paid === false);
  check(`${name} exports its limits constant ${limitsExport} as well`, !!mod[limitsExport]);
  check(`${name} PROVIDER.limits IS the exported ${limitsExport} object (one source, not a copy)`, p?.limits === mod[limitsExport]);
  check(`${name} declares a defaultModel`, typeof p?.defaultModel === 'string' && p.defaultModel.length > 0);
  check(`${name} declares an https endpoint`, typeof p?.endpoint === 'string' && p.endpoint.startsWith('https://'));
}

check('exactly one of the four is an embeddings provider (cohere)',
  MODULES.filter((m) => m.mod.PROVIDER.kind === 'embeddings').map((m) => m.id).join(',') === 'cohere');
check('every provider id is unique',
  new Set(MODULES.map((m) => m.mod.PROVIDER.id)).size === MODULES.length);
check('every secret name is unique (no two providers share a key)',
  new Set(MODULES.map((m) => m.mod.PROVIDER.secretName)).size === MODULES.length);

/* ── Missing-key handling ───────────────────────────────────────────────── */
console.log('\n--- Missing key: returns null, names the missing secret, sends nothing ---');

for (const { name, mod, secret } of MODULES) {
  const args = mod.PROVIDER.kind === 'embeddings'
    ? { apiKey: undefined, texts: ['hello'], agentId: 'verify' }
    : { apiKey: undefined, prompt: 'hello', agentId: 'verify' };

  // eslint-disable-next-line no-await-in-loop
  const [result, warnings] = await captureWarnings(() => mod.PROVIDER.call(args));

  check(`${name} returns null when its key is missing (same semantics as groq-client.js)`, result === null, `got ${JSON.stringify(result)}`);
  check(`${name} warns with a message naming ${secret}`, warnings.some((w) => w.includes(secret)),
    JSON.stringify(warnings));
  check(`${name} tells the operator how to set it (wrangler secret put)`, warnings.some((w) => w.includes('wrangler secret put')),
    JSON.stringify(warnings));
}

check('no missing-key path reached the network', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(', '));

/* ── GitHub Models is GONE, and stays gone ──────────────────────────────── */
//
// Removed 2026-08-06: the service was permanently retired on 2026-07-30. This
// section exists because a dead provider is easy to half-remove — the client
// file goes but a registry entry, a pool member or a config block survives and
// resolves to `unknown_provider` at runtime instead of at verify time.
console.log('\n--- GitHub Models is fully removed (retired 2026-07-30) ---');

const routingConfigForRemoval = require('../config/model-routing.json');
const workerSources = readdirSync(new URL('../workers/', import.meta.url))
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ f, src: readFileSync(new URL(`../workers/${f}`, import.meta.url), 'utf8') }));

check('workers/github-models-client.js no longer exists',
  !readdirSync(new URL('../workers/', import.meta.url)).includes('github-models-client.js'));
// Matches an IMPORT specifically, not a mention. The removal notes in
// task-router.js and elsewhere name the dead file on purpose — that is
// decision history, and a check that forbids writing the name would force
// those notes to be deleted to stay green.
const GH_IMPORT = /from\s+['"][^'"]*github-models-client\.js['"]/;
check('no worker module imports a github-models client',
  workerSources.every(({ src }) => !GH_IMPORT.test(src)),
  workerSources.filter(({ src }) => GH_IMPORT.test(src)).map((m) => m.f).join(','));
check('no lane names github-models as primary or backup',
  !Object.values(routingConfigForRemoval.lanes).some((l) => l.primary === 'github-models' || l.backup === 'github-models'));
check('the conversation pool no longer contains github-models',
  !routingConfigForRemoval.lanes.conversation.pool.includes('github-models'),
  routingConfigForRemoval.lanes.conversation.pool.join(','));
check('token-economy has no live providers.github_models block',
  !tokenEconomy.providers.github_models);
check('...but the removal IS recorded rather than silently vanishing (decision history)',
  !!tokenEconomy.providers._github_models_removed?.why);
check('the removal note warns against re-adding it on the stale "brownout" wording',
  /stale/i.test(tokenEconomy.providers._github_models_removed?.do_not_re_add || ''));
check('the outstanding owner action (delete the dead secret) is recorded',
  /GITHUB_MODELS_TOKEN/.test(tokenEconomy.providers._github_models_removed?.owner_action_outstanding || ''));
check('GITHUB_TOKEN (repo write scope) is explicitly NOT the secret being retired',
  /GITHUB_TOKEN/.test(tokenEconomy.providers._github_models_removed?.owner_action_outstanding || ''));

/* ── Cerebras: the context ceiling is REAL, measured, and enforced ──────── */
console.log('\n--- Cerebras 131K context ceiling enforced, never truncated ---');

check('CEREBRAS_LIMITS.maxInputTokensPerRequest is the measured 131000',
  cerebras.CEREBRAS_LIMITS.maxInputTokensPerRequest === 131000,
  String(cerebras.CEREBRAS_LIMITS.maxInputTokensPerRequest));
check('CEREBRAS_LIMITS.requestsPerMinute is the measured 1000', cerebras.CEREBRAS_LIMITS.requestsPerMinute === 1000);
check('CEREBRAS_LIMITS.requestsPerDay stays null — the 1440000 daily header is rpm x 1440, not a real ceiling',
  cerebras.CEREBRAS_LIMITS.requestsPerDay === null, String(cerebras.CEREBRAS_LIMITS.requestsPerDay));
check('cerebras default model is the catalog-verified gpt-oss-120b (llama-3.3-70b did not exist)',
  cerebras.PROVIDER.defaultModel === 'gpt-oss-120b', cerebras.PROVIDER.defaultModel);

const shortPrompt = 'Score this answer 0-1.';
const okVerdict = cerebras.checkInputWithinCaps({ prompt: shortPrompt, maxTokens: 512 });
check('a short judgment call passes the cap check', okVerdict.ok === true);
check('a passing verdict carries no reason', okVerdict.reason === null);

// chars/3 estimator => 131000 tokens ≈ 393000 chars. 500000 chars is over.
const hugeReportBatch = 'x'.repeat(500_000);
const overVerdict = cerebras.checkInputWithinCaps({ prompt: hugeReportBatch, maxTokens: 512 });
check('an over-131K report batch FAILS the cap check', overVerdict.ok === false);
check('the refusal reason names the measured size and the cap',
  /~\d+ tokens/.test(overVerdict.reason || '') && (overVerdict.reason || '').includes('131000'), overVerdict.reason);
check('the refusal reason says it is NOT truncating', /[Nn]ot truncating/.test(overVerdict.reason || ''), overVerdict.reason);
check('the refusal says there is no larger provider behind this lane',
  /no larger provider/i.test(overVerdict.reason || ''), overVerdict.reason);

// A 130K-token batch must still PASS — the cap has to admit the work the lane
// exists for, not just reject the extreme. The estimator over-counts (chars/3),
// so size the input by the estimate rather than by raw length.
const nearLimit = 'x'.repeat(130_000 * 3 - 3000);
check('a just-under-limit batch is still ACCEPTED (the cap admits the lane\'s real work)',
  cerebras.checkInputWithinCaps({ prompt: nearLimit, maxTokens: 512 }).ok === true);

const [oversizeCall, oversizeWarnings] = await captureWarnings(() =>
  cerebras.callCerebras({ apiKey: 'fake-key-never-sent', prompt: hugeReportBatch, agentId: 'verify' }));
check('callCerebras() with a VALID key still refuses oversized input', oversizeCall === null);
check('the refusal is logged, naming the cap', oversizeWarnings.some((w) => w.includes('131000')), JSON.stringify(oversizeWarnings));
check('the refusal happened BEFORE any network call (cap is pre-flight, not a provider 400)',
  NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(', '));

/* ── The other clients: caps are null, and null means "unknown" ─────────── */
console.log('\n--- Unknown caps are null and permissive, never invented ---');

for (const { name, mod } of MODULES.filter((m) => m.id !== 'cerebras')) {
  const limits = mod.PROVIDER.limits;
  check(`${name} declares maxInputTokensPerRequest explicitly (null = unknown)`,
    'maxInputTokensPerRequest' in limits);
  check(`${name} does not invent a per-request token cap`, limits.maxInputTokensPerRequest === null,
    `got ${limits.maxInputTokensPerRequest}`);

  const verdict = mod.PROVIDER.kind === 'embeddings'
    ? mod.checkInputWithinCaps({ texts: ['x'.repeat(40_000)] })
    : mod.checkInputWithinCaps({ prompt: 'x'.repeat(40_000) });
  check(`${name} does NOT refuse large input against a cap it does not know`, verdict.ok === true);
  check(`${name} flags capUnknown so the router can pace conservatively instead`, verdict.capUnknown === true);
  check(`${name} still reports the measured input size`, verdict.estimatedInputTokens > 0);
}

/* ── Cohere: embeddings only, no chat, no silent partial batches ────────── */
console.log('\n--- Cohere: embeddings only, fail-don\'t-degrade ---');

check('cohere exports callCohereEmbed', typeof cohere.callCohereEmbed === 'function');
check('cohere exports NO chat function (the lane is embeddings-only by design)',
  !Object.keys(cohere).some((k) => /^callCohere(Chat|Generate)$/.test(k)));
check('cohere PROVIDER.kind is embeddings, so the router can never use it for a chat lane',
  cohere.PROVIDER.kind === 'embeddings');
check('cohere default model is MULTILINGUAL (the corpus is Hebrew + English)',
  /multilingual/i.test(cohere.PROVIDER.defaultModel), cohere.PROVIDER.defaultModel);
check('cohere declares the four valid v2 input types',
  ['search_document', 'search_query', 'classification', 'clustering'].every((t) => cohere.INPUT_TYPES.includes(t)));

const [badInputType, badInputWarnings] = await captureWarnings(() =>
  cohere.callCohereEmbed({ apiKey: 'fake-key-never-sent', texts: ['a'], inputType: 'not-a-real-type', agentId: 'verify' }));
check('cohere refuses an invalid input_type before sending', badInputType === null);
check('the input_type refusal is logged', badInputWarnings.some((w) => w.includes('input_type')), JSON.stringify(badInputWarnings));

const [emptyBatch] = await captureWarnings(() =>
  cohere.callCohereEmbed({ apiKey: 'fake-key-never-sent', texts: [], agentId: 'verify' }));
check('cohere refuses an empty batch before sending', emptyBatch === null);

const cohereSrc = readFileSync(new URL('../workers/cohere-client.js', import.meta.url), 'utf8');
check('cohere-client.js refuses a partial batch rather than misaligning vectors with their sources',
  /embeddings\.length !== texts\.length[\s\S]{0,400}return null/.test(cohereSrc));
check('cohere-client.js documents WHY the lane has no backup (vectors from two models share no space)',
  /do not share a space/i.test(cohereSrc));

/* ── Error semantics match the pre-existing groq client ─────────────────── */
console.log('\n--- Error semantics mirror workers/groq-client.js ---');

const groqSrc = readFileSync(new URL('../workers/groq-client.js', import.meta.url), 'utf8');
check('groq-client.js (the shape being mirrored) returns null on 429', /res\.status === 429[\s\S]{0,200}return null/.test(groqSrc));

for (const { name } of MODULES) {
  const src = readFileSync(new URL(`../workers/${name}`, import.meta.url), 'utf8');
  check(`${name} returns null on 429 rather than throwing`, /res\.status === 429[\s\S]{0,200}return null/.test(src));
  check(`${name} returns null on a non-ok response rather than throwing`, /if \(!res\.ok\)[\s\S]{0,300}return null/.test(src));
  check(`${name} catches network errors rather than throwing`, /catch \(err\)[\s\S]{0,200}return null/.test(src));
  check(`${name} contains no throw statement on a call path`, !/^\s*throw new Error/m.test(src));
  check(`${name} never references Anthropic the provider`, !mentionsAnthropicProvider(src));
  check(`${name} never calls api.anthropic.com`, !src.includes('api.anthropic.com'));
  check(`${name} never imports claude-client.js`, !/from\s+['"][^'"]*claude-client\.js['"]/.test(src));
}

/* ── Chat clients return the router's expected envelope ─────────────────── */
console.log('\n--- Response envelope is a superset of groq\'s { text, source } ---');

const fakeRes = { headers: new Map([['x-ratelimit-remaining-requests', '42'], ['x-ratelimit-limit-requests', '150']]) };
fakeRes.headers.get = Map.prototype.get.bind(fakeRes.headers);

const envelope = normalizeOpenAiChat({
  data: {
    choices: [{ message: { content: '  scored 0.8  ' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  },
  res: fakeRes,
  source: 'cerebras',
});
check('envelope carries text, trimmed', envelope.text === 'scored 0.8');
check('envelope carries source', envelope.source === 'cerebras');
check('envelope carries finishReason (so a max_tokens truncation can be REJECTED, not parsed)', envelope.finishReason === 'stop');
check('envelope carries provider-reported usage (evidence a call happened, for the token economy)',
  envelope.usage?.inputTokens === 100 && envelope.usage?.outputTokens === 20);
check('envelope carries parsed rate-limit headers', envelope.rateLimit?.remainingRequests === 42);

const truncated = normalizeOpenAiChat({
  data: { choices: [{ message: { content: 'half an ans' }, finish_reason: 'length' }] },
  res: fakeRes,
  source: 'cerebras',
});
check('a max_tokens-truncated response is visibly marked (finishReason "length")', truncated.finishReason === 'length');
check('a response with no usage block reports usage:null rather than zeros', truncated.usage === null);

const noHeaders = { headers: { get: () => null } };
const emptyLimits = parseRateLimitHeaders(noHeaders);
check('absent rate-limit headers parse to null, not 0 ("did not tell us" ≠ "none remaining")',
  emptyLimits.remainingRequests === null && emptyLimits.limitRequests === null && emptyLimits.resetSeconds === null);

/* ── The token estimator is conservative on purpose ─────────────────────── */
console.log('\n--- Token estimator is deliberately pessimistic ---');

check('estimateTokens("") is 0', estimateTokens('') === 0);
check('estimateTokens(null) is 0 (no crash on an absent system prompt)', estimateTokens(null) === 0);
check('estimator over-counts vs the ~chars/4 English rule of thumb (Hebrew tokenizes worse)',
  estimateTokens('x'.repeat(4000)) > 1000, String(estimateTokens('x'.repeat(4000))));
check('estimatePromptTokens sums prompt AND systemPrompt (a persona prompt is not free)',
  estimatePromptTokens({ prompt: 'x'.repeat(300), systemPrompt: 'y'.repeat(300) }) === estimateTokens('x'.repeat(600)));

/* ── Config and code agree ──────────────────────────────────────────────── */
console.log('\n--- config/token-economy.json `providers` block agrees with the modules ---');

const providers = tokenEconomy.providers;
check('a providers block exists', !!providers);
check('providers._meta states the overtime rule', /overtime/i.test(JSON.stringify(providers._meta)));
check('providers._meta states there is no automatic escalation to paid, for any provider',
  /no automatic escalation/i.test(providers._meta?.the_overtime_rule || ''));
check('providers._meta explains that null means unknown, NOT unlimited',
  /does not mean unlimited|not.*unlimited/i.test(providers._meta?.nulls_are_honest || ''));

const CONFIG_KEYS = { cerebras: 'cerebras', mistral: 'mistral', cohere: 'cohere' };
for (const { name, mod, secret } of MODULES) {
  const cfg = providers[CONFIG_KEYS[mod.PROVIDER.id]];
  check(`providers.${CONFIG_KEYS[mod.PROVIDER.id]} exists in config`, !!cfg);
  check(`providers.${CONFIG_KEYS[mod.PROVIDER.id]}.paid is false (overtime rule)`, cfg?.paid === false);
  check(`providers.${CONFIG_KEYS[mod.PROVIDER.id]}.secret matches ${name}'s secretName`, cfg?.secret === secret,
    `config ${cfg?.secret} vs module ${secret}`);
  check(`providers.${CONFIG_KEYS[mod.PROVIDER.id]}.endpoint matches the module's endpoint`,
    cfg?.endpoint === mod.PROVIDER.endpoint, `config ${cfg?.endpoint} vs module ${mod.PROVIDER.endpoint}`);
  check(`providers.${CONFIG_KEYS[mod.PROVIDER.id]}.max_input_tokens_per_request matches the module's limit`,
    (cfg?.max_input_tokens_per_request ?? null) === (mod.PROVIDER.limits.maxInputTokensPerRequest ?? null),
    `config ${cfg?.max_input_tokens_per_request} vs module ${mod.PROVIDER.limits.maxInputTokensPerRequest}`);
}

/* ── The measured rate limits agree between config and modules ──────────── */
console.log('\n--- Measured free-tier numbers (2026-08-06) are recorded, and recorded consistently ---');

check('providers.cerebras records the measured 131000-token input cap',
  providers.cerebras?.max_input_tokens_per_request === 131000);
check('providers.cerebras records the measured 1000 req/min',
  providers.cerebras?.requests_per_minute === 1000);
check('providers.cerebras.requests_per_minute matches CEREBRAS_LIMITS',
  providers.cerebras?.requests_per_minute === cerebras.CEREBRAS_LIMITS.requestsPerMinute);
check('providers.cerebras.requests_per_day is null (the daily header is derived, not a real ceiling)',
  providers.cerebras?.requests_per_day === null);
check('...and the config EXPLAINS why, naming the 1440000 figure it is refusing to copy',
  /1440000/.test(providers.cerebras?._why_requests_per_day_is_still_null || ''));
check('providers.cerebras records the concentration risk of serving two lanes',
  /two lanes|both lanes/i.test(providers.cerebras?._concentration_risk || ''));
check('...and names OpenRouter as the intended diversification',
  /OpenRouter/i.test(providers.cerebras?._concentration_risk || ''));

check('providers.mistral records the measured 50 req/min', providers.mistral?.requests_per_minute === 50);
check('providers.mistral.requests_per_minute matches MISTRAL_LIMITS',
  providers.mistral?.requests_per_minute === mistral.MISTRAL_LIMITS.requestsPerMinute);
check('providers.mistral.requests_per_day is null (Mistral publishes no daily header at all)',
  providers.mistral?.requests_per_day === null);

check('providers.cohere carries a MONTHLY cap, not a daily one',
  providers.cohere?.requests_per_month === 1000 && providers.cohere?.requests_per_day === null);
check('providers.cohere.requests_per_month matches COHERE_LIMITS',
  providers.cohere?.requests_per_month === cohere.COHERE_LIMITS.requestsPerMonth);
check('providers.cohere records that this is a TRIAL key, not a free production tier',
  /trial/i.test(providers.cohere?._THIS_IS_A_TRIAL_KEY_NOT_A_FREE_TIER || ''));
check('...and explains why a monthly cap was NOT divided into a daily one',
  /monthly/i.test(providers.cohere?._why_the_cap_is_MONTHLY_and_the_daily_field_is_null || ''));

check('providers._meta documents the requests_per_month field and its bucketing',
  /requests_per_month/.test(providers._meta?.cap_periods_added_2026_08_06 || ''));
check('providers._meta states that per-minute is the binding constraint where no true daily cap exists',
  /per.minute/i.test(providers._meta?.per_minute_is_the_binding_constraint_where_no_true_daily_cap_exists || ''));
check('...and warns against copying a derived daily number out of a response header',
  /DO NOT copy/i.test(providers._meta?.per_minute_is_the_binding_constraint_where_no_true_daily_cap_exists || ''));

/* ── Anthropic is absent from the routable set ──────────────────────────── */
console.log('\n--- Anthropic is unreachable from the routable provider set ---');

check('no anthropic/claude key exists in the providers block',
  !Object.keys(providers).some((k) => /anthropic|claude/i.test(k)), Object.keys(providers).join(', '));
check('providers._meta states Anthropic\'s absence is deliberate, not an omission',
  /deliberately absent|never routed/i.test(JSON.stringify(providers._meta)));
check('no provider client module added this session references Anthropic the provider',
  MODULES.every(({ name }) => !mentionsAnthropicProvider(readFileSync(new URL(`../workers/${name}`, import.meta.url), 'utf8'))));
check('provider-common.js does not reference Anthropic either',
  !mentionsAnthropicProvider(readFileSync(new URL('../workers/provider-common.js', import.meta.url), 'utf8')));

/* ── Pre-existing provider numbers were not changed ─────────────────────── */
console.log('\n--- Pre-existing limits unchanged (daily_limits stays the source of truth) ---');

check('daily_limits.groq is still 14400', tokenEconomy.daily_limits?.groq === 14400);
check('daily_limits.cloudflare_ai is still 10000', tokenEconomy.daily_limits?.cloudflare_ai === 10000);
check('daily_limits.gemini is still 1500', tokenEconomy.daily_limits?.gemini === 1500);
check('providers.groq agrees with daily_limits.groq', providers.groq?.requests_per_day === tokenEconomy.daily_limits.groq);
check('providers.cloudflare_ai agrees with daily_limits.cloudflare_ai', providers.cloudflare_ai?.requests_per_day === tokenEconomy.daily_limits.cloudflare_ai);
check('providers.gemini agrees with daily_limits.gemini', providers.gemini?.requests_per_day === tokenEconomy.daily_limits.gemini);
check('providers.gemini agrees with notebook_x_gemini_pacing spacing (pacing stays in force under routing)',
  providers.gemini?.min_spacing_ms_between_notebook_x_calls === tokenEconomy.notebook_x_gemini_pacing?.min_spacing_ms_between_calls);
check('shared_claude_budget is untouched at $4.50', tokenEconomy.shared_claude_budget?.cap_usd_per_month === 4.5);
check('guides_claude_budget is untouched at $4.50', tokenEconomy.guides_claude_budget?.cap_usd_per_month === 4.5);
// The PROVIDER half is what this check has always been about — "groq stays the
// routine-volume primary". The MODEL half moved on 2026-08-09 when llama3-8b-8192
// was found decommissioned, so pinning the whole string would make a correct
// model rotation look like a regression. Provider pinned, model checked for
// agreement with the code below rather than frozen.
check('primary_case_model still names groq as the routine-volume primary',
  String(tokenEconomy.primary_case_model || '').startsWith('groq/'));
check('primary_case_model no longer names the decommissioned llama3-8b-8192',
  !String(tokenEconomy.primary_case_model || '').includes('llama3-8b-8192'));
// CONFIG-VS-CODE DRIFT. token-economy.json documents the model; groq-client.js
// is what actually gets sent. They disagreed for no one's benefit before, and a
// verifier that reads only the config would have stayed green through it.
{
  const codeModel = (groqSrc.match(/^const GROQ_MODEL = '([^']+)'/m) || [])[1];
  const configModel = String(tokenEconomy.primary_case_model || '').replace(/^groq\//, '');
  check(`groq-client.js GROQ_MODEL ("${codeModel}") matches token-economy primary_case_model ("${configModel}")`,
    Boolean(codeModel) && codeModel === configModel);
}
check('routing_model is untouched (Cloudflare stays the classification primary)',
  tokenEconomy.routing_model === 'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8');
check('report_model is untouched (Gemini 3.1 Flash-Lite)', tokenEconomy.report_model === 'google/gemini-3.1-flash-lite');

/* ── CONTAINMENT: the clients are reachable ONLY through the router ─────── */
//
// This started life as a Phase A inertness check ("nothing imports these at
// all"). Phase B made that false on purpose: workers/task-router.js imports
// all four, which is the entire point of a router. The check was rewritten
// rather than deleted, because the property that actually matters survives
// the change and is worth keeping enforced — NO PRE-EXISTING CALLER reaches
// a new provider directly. Every path to one of these goes through the
// router, which means every path passes the kill switch and the quota
// allow-check. A future session that wires a client straight into
// agent-base.js would bypass both, and this is what catches that.
console.log('\n--- Containment: new providers are reachable only through the router ---');

const NEW_MODULES = ['cerebras-client.js', 'mistral-client.js', 'cohere-client.js', 'provider-common.js'];
const ALLOWED_IMPORTERS = ['task-router.js'];
const workerFiles = readdirSync(new URL('../workers/', import.meta.url)).filter((f) => f.endsWith('.js'));
const agentFiles = readdirSync(new URL('../agents/', import.meta.url)).filter((f) => f.endsWith('.js'));

const importers = [];
for (const [dir, files] of [['workers', workerFiles], ['agents', agentFiles]]) {
  for (const file of files) {
    if (dir === 'workers' && NEW_MODULES.includes(file)) continue; // the new modules may import each other
    if (dir === 'workers' && ALLOWED_IMPORTERS.includes(file)) continue; // the router is the one legitimate importer
    const src = readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8');
    for (const newMod of NEW_MODULES) {
      if (new RegExp(`from\\s+['"][^'"]*${newMod.replace('.', '\\.')}['"]`).test(src)) {
        importers.push(`${dir}/${file} -> ${newMod}`);
      }
    }
  }
}
check('no file except the router imports a provider client directly (so nothing bypasses the switch or the quota check)',
  importers.length === 0, importers.join(', '));
check('the router itself DOES import all three clients (it is the single entry point)',
  ['cerebras-client.js', 'mistral-client.js', 'cohere-client.js'].every((m) =>
    new RegExp(`from\\s+'\\./${m.replace('.', '\\.')}'`).test(
      readFileSync(new URL('../workers/task-router.js', import.meta.url), 'utf8'))));

const newModuleImports = NEW_MODULES.filter((f) => f !== 'provider-common.js').map((f) => {
  const src = readFileSync(new URL(`../workers/${f}`, import.meta.url), 'utf8');
  return { f, importsCommon: /from '\.\/provider-common\.js'/.test(src) };
});
check('every new client imports the shared helpers rather than copying them',
  newModuleImports.every((m) => m.importsCommon), JSON.stringify(newModuleImports));

check('model-router.js reaches the providers only via task-router.js, never by importing a client directly',
  /from '\.\/task-router\.js'/.test(readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8'))
  && !/from '\.\/(cerebras|mistral|cohere)-client\.js'/.test(
    readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8')));

/* ── Final network assertion ────────────────────────────────────────────── */
console.log('\n--- Network tripwire ---');
check('this verifier made ZERO network calls end to end', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(', '));

/* ── Summary ───────────────────────────────────────────────────────────── */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('MISMATCH — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('All scenarios matched expectations.');
  process.exit(0);
}
