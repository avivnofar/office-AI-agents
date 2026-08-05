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

import * as githubModels from '../workers/github-models-client.js';
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
  { name: 'github-models-client.js', mod: githubModels, id: 'github-models', kind: 'chat', secret: 'GITHUB_MODELS_TOKEN', limitsExport: 'GITHUB_MODELS_LIMITS' },
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

/* ── GitHub Models: the input caps are REAL and enforced ────────────────── */
console.log('\n--- GitHub Models free-tier caps (8K in / 4K out) enforced, never truncated ---');

check('GITHUB_MODELS_LIMITS.maxInputTokensPerRequest is 8000', githubModels.GITHUB_MODELS_LIMITS.maxInputTokensPerRequest === 8000);
check('GITHUB_MODELS_LIMITS.maxOutputTokensPerRequest is 4000', githubModels.GITHUB_MODELS_LIMITS.maxOutputTokensPerRequest === 4000);

const shortPrompt = 'Score this answer 0-1.';
const okVerdict = githubModels.checkInputWithinCaps({ prompt: shortPrompt, maxTokens: 512 });
check('a short judgment call passes the cap check', okVerdict.ok === true);
check('a passing verdict carries no reason', okVerdict.reason === null);

// chars/3 estimator => 8000 tokens ≈ 24000 chars. 40000 chars is comfortably over.
const longReportBatch = 'x'.repeat(40_000);
const overVerdict = githubModels.checkInputWithinCaps({ prompt: longReportBatch, maxTokens: 512 });
check('a long report batch FAILS the cap check', overVerdict.ok === false);
check('the refusal reason names the measured size and the cap',
  /~\d+ tokens/.test(overVerdict.reason || '') && (overVerdict.reason || '').includes('8000'), overVerdict.reason);
check('the refusal reason says it is NOT truncating', /[Nn]ot truncating/.test(overVerdict.reason || ''), overVerdict.reason);
check('the refusal points at the long-context lane (cerebras) as the correct destination',
  /cerebras/i.test(overVerdict.reason || ''), overVerdict.reason);

const overOutput = githubModels.checkInputWithinCaps({ prompt: shortPrompt, maxTokens: 8192 });
check('an over-cap OUTPUT request also fails the check', overOutput.ok === false);
check('the output refusal says it is NOT clamping', /[Nn]ot clamping/.test(overOutput.reason || ''), overOutput.reason);

const [oversizeCall, oversizeWarnings] = await captureWarnings(() =>
  githubModels.callGithubModels({ apiKey: 'fake-key-never-sent', prompt: longReportBatch, agentId: 'verify' }));
check('callGithubModels() with a VALID key still refuses oversized input', oversizeCall === null);
check('the refusal is logged, naming the cap', oversizeWarnings.some((w) => w.includes('8000')), JSON.stringify(oversizeWarnings));
check('the refusal happened BEFORE any network call (cap is pre-flight, not a provider 400)',
  NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(', '));

/* ── The other clients: caps are null, and null means "unknown" ─────────── */
console.log('\n--- Unknown caps are null and permissive, never invented ---');

for (const { name, mod } of MODULES.filter((m) => m.id !== 'github-models')) {
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
  source: 'github-models',
});
check('envelope carries text, trimmed', envelope.text === 'scored 0.8');
check('envelope carries source', envelope.source === 'github-models');
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

const CONFIG_KEYS = { 'github-models': 'github_models', cerebras: 'cerebras', mistral: 'mistral', cohere: 'cohere' };
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

check('providers.github_models records the 8000-token input cap',
  providers.github_models?.max_input_tokens_per_request === 8000);
check('providers.github_models records the 4000-token output cap',
  providers.github_models?.max_output_tokens_per_request === 4000);
check('providers.github_models keeps its request-rate fields null (rate varies by model tier — no honest single number)',
  providers.github_models?.requests_per_day === null && providers.github_models?.requests_per_minute === null);
check('providers.github_models documents why its own secret is not the repo-write GITHUB_TOKEN',
  /GITHUB_TOKEN/.test(providers.github_models?._secret_scope_note || ''));

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
check('primary_case_model is untouched (groq stays the routine-volume primary)',
  tokenEconomy.primary_case_model === 'groq/llama3-8b-8192');
check('routing_model is untouched (Cloudflare stays the classification primary)',
  tokenEconomy.routing_model === 'cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8');
check('report_model is untouched (Gemini 3.1 Flash-Lite)', tokenEconomy.report_model === 'google/gemini-3.1-flash-lite');

/* ── PHASE A INERTNESS: nothing imports these modules yet ───────────────── */
console.log('\n--- Phase A inertness: the new modules have no callers ---');

const NEW_MODULES = ['github-models-client.js', 'cerebras-client.js', 'mistral-client.js', 'cohere-client.js', 'provider-common.js'];
const workerFiles = readdirSync(new URL('../workers/', import.meta.url)).filter((f) => f.endsWith('.js'));
const agentFiles = readdirSync(new URL('../agents/', import.meta.url)).filter((f) => f.endsWith('.js'));

const importers = [];
for (const [dir, files] of [['workers', workerFiles], ['agents', agentFiles]]) {
  for (const file of files) {
    if (dir === 'workers' && NEW_MODULES.includes(file)) continue; // the new modules may import each other
    const src = readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8');
    for (const newMod of NEW_MODULES) {
      if (new RegExp(`from\\s+['"][^'"]*${newMod.replace('.', '\\.')}['"]`).test(src)) {
        importers.push(`${dir}/${file} -> ${newMod}`);
      }
    }
  }
}
check('no pre-existing worker/agent file imports any new provider module (Phase A is additive-only)',
  importers.length === 0, importers.join(', '));

const newModuleImports = NEW_MODULES.filter((f) => f !== 'provider-common.js').map((f) => {
  const src = readFileSync(new URL(`../workers/${f}`, import.meta.url), 'utf8');
  return { f, importsCommon: /from '\.\/provider-common\.js'/.test(src) };
});
check('every new client imports the shared helpers rather than copying them',
  newModuleImports.every((m) => m.importsCommon), JSON.stringify(newModuleImports));

check('model-router.js does not reference the new providers yet (routing lands in Phase B)',
  !/github-models|cerebras|mistral|cohere/i.test(readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8')));

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
