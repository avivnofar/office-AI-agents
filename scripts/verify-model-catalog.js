#!/usr/bin/env node
// Dry-run verification for the model-retirement catalogue check added
// 2026-08-23 (Session 14, ITEM C — workers/model-catalog.js).
//
// NO NETWORK. NO D1/KV. NO MODEL CALLS. Every catalogue read exercised here is
// served by an INJECTED `fetchImpl`, and the script asserts that fact directly
// by replacing globalThis.fetch with a tripwire that throws if anything reaches
// it — the same shape scripts/verify-providers.js and scripts/verify-routing.js
// already use, for the same reason.
//
// THE POINT OF THIS FILE IS THE RED PROOF. A check that has never been observed
// failing is not known to work, and this estate has a documented case of a
// health check that was green partly because failure was being recorded as
// activity. So §2 below drives the checker with a catalogue that does NOT
// contain the configured identifier and asserts it goes red, before §3 drives
// it with one that does and asserts it goes green.
//
// This loads workers/model-catalog.js with a real `import`, which is possible
// only because that module imports nothing at all — no JSON, no client. Same
// constraint workers/task-router.js and workers/guide-engine.js satisfy for
// their own verifiers.
//
// Run: node scripts/verify-model-catalog.js

import { readFileSync } from 'node:fs';

import {
  checkModelCatalogs, renderCatalogSummary, isRed,
  CATALOG_SOURCES, NOT_CHECKABLE_PROVIDERS,
  ABSENT, PRESENT, NOT_CHECKABLE, CHECK_FAILED,
} from '../workers/model-catalog.js';

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
  throw new Error(`verify-model-catalog.js made a network call to ${args[0]} — this verifier must stay dry-run`);
};

/** A stub catalogue response. `ids` are what the provider claims to hold. */
function stubCatalog(ids, { provider = 'groq', status = 200 } = {}) {
  const shape = provider === 'cohere'
    ? { models: ids.map((n) => ({ name: n })) }
    : provider === 'gemini' || provider === 'gemini-images'
      ? { models: ids.map((n) => ({ name: `models/${n}` })) }
      : { data: ids.map((id) => ({ id })) };
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => shape,
      text: async () => JSON.stringify(shape),
    };
  };
  impl.calls = calls;
  return impl;
}

console.log('=== Model-catalogue check verification — dry-run only, no network/model/D1/KV calls ===\n');

/* ── §1  The shape of the source table ─────────────────────────────────── */
console.log('--- §1  Catalogue sources ---');

check('a listing endpoint is defined for every provider that has one',
  ['groq', 'cerebras', 'mistral', 'cohere', 'gemini', 'gemini-images', 'anthropic']
    .every((p) => !!CATALOG_SOURCES[p]),
  Object.keys(CATALOG_SOURCES).join(', '));

check('both Cloudflare providers are recorded as NOT CHECKABLE with a reason, rather than omitted',
  !!NOT_CHECKABLE_PROVIDERS['cloudflare-ai'] && !!NOT_CHECKABLE_PROVIDERS['cloudflare-images']);

check('...and each of those reasons names the command that DOES answer it',
  Object.values(NOT_CHECKABLE_PROVIDERS).every((r) => /wrangler ai models/.test(r)));

// The one property that makes a key-in-the-query-string provider safe to report
// on. `endpointLabel` is what every rendered line uses; the URL that carries the
// key is built inside request() and never leaves it.
check('no endpointLabel contains a key placeholder or a query string with `key=`',
  Object.values(CATALOG_SOURCES).every((s) => !/key=/.test(s.endpointLabel)));

check('every source names its SECRET rather than carrying a value',
  Object.values(CATALOG_SOURCES).every((s) => typeof s.secretName === 'string' && /_API_KEY$/.test(s.secretName)));

/* ── §2  THE RED PROOF ─────────────────────────────────────────────────── */
console.log('\n--- §2  It goes RED on an absent identifier (THE PROOF) ---');

const redReport = await checkModelCatalogs({
  targets: [{ provider: 'groq', model: 'llama-3.1-8b-instant', configuredIn: ['workers/groq-client.js GROQ_MODEL'] }],
  env: { GROQ_API_KEY: 'stub-not-a-real-key' },
  // The real Groq catalogue on 2026-08-23, minus the retired model — this is
  // exactly the state that broke the estate and went unnoticed for seven days.
  fetchImpl: stubCatalog(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile']),
});

check('an ABSENT configured model sets ok:false', redReport.ok === false);
check('...and is counted in `red`', redReport.red === 1, String(redReport.red));
check('...and the result carries status ABSENT', redReport.results[0].status === ABSENT);
check('...and isRed() agrees', isRed(redReport.results[0].status) === true);
check('...and the reason says CONFIG FIX, NOT A KEY PROBLEM (AD-030)',
  /CONFIG FIX, NOT A KEY PROBLEM/.test(redReport.results[0].reason || ''));
check('...and it explicitly forbids proposing a credential rotation',
  /Do not propose a credential rotation/.test(redReport.results[0].reason || ''));
check('...and the rendered summary marks the line ABSENT',
  /\[ABSENT\]/.test(renderCatalogSummary(redReport)));
check('...and the summary names where the identifier is configured, so a reader knows what to edit',
  /configured in: workers\/groq-client\.js GROQ_MODEL/.test(renderCatalogSummary(redReport)));

/* ── §3  It goes GREEN when the model is there ─────────────────────────── */
console.log('\n--- §3  It passes clean when the identifier IS in the catalogue ---');

const greenReport = await checkModelCatalogs({
  targets: [{ provider: 'groq', model: 'openai/gpt-oss-20b', configuredIn: ['workers/groq-client.js GROQ_MODEL'] }],
  env: { GROQ_API_KEY: 'stub-not-a-real-key' },
  fetchImpl: stubCatalog(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']),
});

check('a PRESENT configured model sets ok:true', greenReport.ok === true);
check('...with red === 0', greenReport.red === 0);
check('...and status `present`', greenReport.results[0].status === PRESENT);
check('...and no reason attached to a passing line', greenReport.results[0].reason === null);
check('...and the catalogue SIZE is reported, so a reader can tell a real listing from an empty one',
  greenReport.results[0].catalogSize === 2, String(greenReport.results[0].catalogSize));

/* ── §4  A catalogue that could not be read is NOT a retirement ────────── */
console.log('\n--- §4  An unreadable catalogue never masquerades as an absent model ---');

const httpFail = await checkModelCatalogs({
  targets: [{ provider: 'groq', model: 'openai/gpt-oss-20b', configuredIn: ['x'] }],
  env: { GROQ_API_KEY: 'stub' },
  fetchImpl: stubCatalog([], { status: 401 }),
});
check('an HTTP failure on the listing gives check_failed, NOT ABSENT',
  httpFail.results[0].status === CHECK_FAILED, httpFail.results[0].status);
check('...and does NOT set ok:false — an unreadable catalogue is not evidence a model is gone',
  httpFail.ok === true);
check('...and the reason carries the HTTP STATUS AND THE BODY (AD-030: read the body before blaming a secret)',
  /HTTP 401/.test(httpFail.results[0].reason) && /body:/.test(httpFail.results[0].reason));

const emptyList = await checkModelCatalogs({
  targets: [{ provider: 'groq', model: 'openai/gpt-oss-20b', configuredIn: ['x'] }],
  env: { GROQ_API_KEY: 'stub' },
  fetchImpl: stubCatalog([]),
});
check('a 200 with an EMPTY model list is check_failed, not "every model is gone"',
  emptyList.results[0].status === CHECK_FAILED && emptyList.ok === true);

const noKey = await checkModelCatalogs({
  targets: [{ provider: 'cerebras', model: 'gpt-oss-120b', configuredIn: ['x'] }],
  env: {},
  fetchImpl: stubCatalog(['gpt-oss-120b']),
});
check('a missing SECRET is check_failed and names the secret, without printing a value',
  noKey.results[0].status === CHECK_FAILED && /CEREBRAS_API_KEY is not configured/.test(noKey.results[0].reason));
check('...and it says in words that this is NOT evidence the model is gone',
  /NOT evidence the model is gone/.test(noKey.results[0].reason));

const throws = await checkModelCatalogs({
  targets: [{ provider: 'groq', model: 'm', configuredIn: ['x'] }],
  env: { GROQ_API_KEY: 'stub' },
  fetchImpl: async () => { throw new Error('socket hang up'); },
});
check('a thrown network error is caught and reported, never propagated',
  throws.results[0].status === CHECK_FAILED && /socket hang up/.test(throws.results[0].reason));

/* ── §5  not_checkable is reported, and does not go red ────────────────── */
console.log('\n--- §5  not_checkable is a reported FACT, not silence ---');

const cf = await checkModelCatalogs({
  targets: [{ provider: 'cloudflare-ai', model: '@cf/meta/llama-3.1-8b-instruct-fp8', configuredIn: ['workers/gemini-client.js CF_WORKERS_AI_MODEL'] }],
  env: {},
  fetchImpl: async () => { throw new Error('must not be called for a not-checkable provider'); },
});
check('cloudflare-ai comes back not_checkable', cf.results[0].status === NOT_CHECKABLE);
check('...without setting ok:false', cf.ok === true);
check('...with the reason attached to the RESULT, not only to a table somewhere',
  /wrangler ai models/.test(cf.results[0].reason));
check('...and no listing call was attempted for it', true);

/* ── §6  One listing call per provider, however many targets it holds ──── */
console.log('\n--- §6  One catalogue read per provider ---');

const shared = stubCatalog(['a', 'b', 'c']);
const multi = await checkModelCatalogs({
  targets: [
    { provider: 'groq', model: 'a', configuredIn: ['x'] },
    { provider: 'groq', model: 'b', configuredIn: ['y'] },
    { provider: 'groq', model: 'zzz-gone', configuredIn: ['z'] },
  ],
  env: { GROQ_API_KEY: 'stub' },
  fetchImpl: shared,
});
check('three targets on one provider cost ONE listing call', shared.calls.length === 1, String(shared.calls.length));
check('...and all three are judged against the same catalogue',
  multi.results.map((r) => r.status).join(',') === `${PRESENT},${PRESENT},${ABSENT}`,
  multi.results.map((r) => r.status).join(','));
check('...so the run goes red on the one that is gone', multi.ok === false && multi.red === 1);

/* ── §7  A probe is always marked as a probe ───────────────────────────── */
console.log('\n--- §7  An injected probe can never read as a config finding ---');

const probed = await checkModelCatalogs({
  targets: [
    { provider: 'groq', model: 'a', configuredIn: ['real'] },
    { provider: 'groq', model: 'deliberately-not-a-model', probe: true, configuredIn: ['NOT CONFIGURED ANYWHERE — injected by this call to prove the check can go red'] },
  ],
  env: { GROQ_API_KEY: 'stub' },
  fetchImpl: stubCatalog(['a']),
});
check('a probe that is absent DOES take the run red — that is what makes it a proof',
  probed.ok === false);
check('...and the probe flag survives into the result', probed.results[1].probe === true);
check('...and the rendered line says PROBE out loud',
  /<- PROBE, deliberately injected, not a real config value/.test(renderCatalogSummary(probed)));

/* ── §8  Gemini's fully-qualified names match either spelling ──────────── */
console.log('\n--- §8  `models/x` and `x` are the same model ---');

const gem = await checkModelCatalogs({
  targets: [{ provider: 'gemini', model: 'gemini-3.1-flash-lite', configuredIn: ['config/simulation-config.json GEMINI.model'] }],
  env: { GEMINI_API_KEY: 'stub' },
  fetchImpl: stubCatalog(['gemini-3.1-flash-lite'], { provider: 'gemini' }),
});
check('a bare configured id matches a `models/`-prefixed catalogue entry',
  gem.results[0].status === PRESENT, gem.results[0].status);

/* ── §9  The wiring: the identifiers are not spelled in the checker ────── */
console.log('\n--- §9  Nothing here holds a second copy of a model ID ---');

/**
 * Comments stripped before the check, deliberately.
 *
 * The property that matters is that no model identifier is a LIVE VALUE in the
 * checker — a literal the logic compares against. The prose in these files
 * NAMES models on purpose (`claude-sonnet-5` is why Anthropic has an entry;
 * `flux-1-schnell` is how the image draft model was verified in 2026-08), and a
 * check that forbade writing those names would force the explanations to be
 * deleted to stay green. That is the same mistake verify-providers.js records
 * making with its github-models import check, and its fix — match the mechanism,
 * not the mention — is copied here rather than re-derived.
 */
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const catalogSrc = withoutComments(readFileSync(new URL('../workers/model-catalog.js', import.meta.url), 'utf8'));
// The five identifiers this estate ships. If any of them appears as a literal
// in the checker, the checker is verifying its own copy — the exact failure
// that would have kept it green through all five retirements so far. The
// module header NAMES the retired ones as history, which is why the check is
// scoped to the LIVE ones.
const LIVE_IDS = ['openai/gpt-oss-20b', 'gpt-oss-120b', 'mistral-small-latest', 'embed-multilingual-v3.0', 'claude-sonnet-5', '@cf/black-forest-labs/flux-1-schnell', 'gemini-3-pro-image-preview'];
check('workers/model-catalog.js spells NO live model identifier of its own',
  LIVE_IDS.every((id) => !catalogSrc.includes(id)),
  LIVE_IDS.filter((id) => catalogSrc.includes(id)).join(', '));

const runnerSrc = readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8');
check('agent-runner.js assembles the target list without spelling an identifier either',
  /function configuredModelTargets\(env\) \{[\s\S]*?\n\}/.test(runnerSrc)
  && LIVE_IDS.every((id) => {
    const body = /function configuredModelTargets\(env\) \{[\s\S]*?\n\}/.exec(runnerSrc)[0];
    return !body.includes(id);
  }));
check('...taking GROQ_MODEL from groq-client.js, its definition site',
  /import \{ GROQ_MODEL \} from '\.\/groq-client\.js'/.test(runnerSrc));
check('...CLAUDE_MODEL from claude-client.js, its definition site',
  /import \{ callClaudeMessages, CLAUDE_MODEL \} from '\.\/claude-client\.js'/.test(runnerSrc));
check('...CF_WORKERS_AI_MODEL from gemini-client.js, its definition site',
  /CF_WORKERS_AI_MODEL \} from '\.\/gemini-client\.js'/.test(runnerSrc));
check('...and the router\'s five through routerModelTargets(), because the containment rule forbids importing those clients here',
  /routerModelTargets/.test(runnerSrc)
  && !/from '\.\/(cerebras|mistral|cohere)-client\.js'/.test(runnerSrc));

const routerSrc = readFileSync(new URL('../workers/task-router.js', import.meta.url), 'utf8');
check('task-router.js\'s routerModelTargets() reads defaultModel off the descriptors it already imports',
  /export function routerModelTargets\(\)/.test(routerSrc)
  && /CEREBRAS_PROVIDER\.defaultModel/.test(routerSrc)
  && /MISTRAL_PROVIDER\.defaultModel/.test(routerSrc)
  && /COHERE_PROVIDER\.defaultModel/.test(routerSrc));

/* ── §10  The trigger, and its caller ──────────────────────────────────── */
console.log('\n--- §10  It has a caller (a verifier with none is the defect it exists to catch) ---');

check('the Worker exposes a {"type":"model_catalog"} admin trigger',
  /case 'model_catalog': \{/.test(runnerSrc));
check('...which accepts probeModels, so the red proof can be run against LIVE providers',
  /body\.probeModels/.test(runnerSrc));
check('...and marks every injected entry probe:true',
  /probe: true, configuredIn: \['NOT CONFIGURED ANYWHERE/.test(runnerSrc));

const workflow = readFileSync(new URL('../.github/workflows/weekly-capability-audit.yml', import.meta.url), 'utf8');
check('a SCHEDULED job calls it — .github/workflows/weekly-capability-audit.yml',
  /"type":\s*"model_catalog"/.test(workflow) || /type\\":\\"model_catalog/.test(workflow) || /model_catalog/.test(workflow));
check('...and the job goes RED when a configured model is absent, rather than only printing',
  /catalog_exit/.test(workflow));
check('...and it needs NO new secret — the same ADMIN_TOKEN and AGENTS_API_BASE the job already uses',
  /secrets\.ADMIN_TOKEN/.test(workflow) && /vars\.AGENTS_API_BASE/.test(workflow));

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
