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
import * as cfImage from '../workers/cf-image-client.js';
import * as geminiImage from '../workers/gemini-image-client.js';
import {
  estimateTokens, estimatePromptTokens, parseRateLimitHeaders, normalizeOpenAiChat,
  imageEnvelope, renderAssetProvenance, sniffImageMime, extensionForMime,
} from '../workers/provider-common.js';

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

/* ════════════════════════════════════════════════════════════════════════
 * THE IMAGE PROVIDERS (added 2026-08-10, plan 5.1)
 *
 * The office's first. The Designer's role has asserted this capability since
 * 2026-08-05 and no code path supplied it — see workers/cf-image-client.js's
 * header for why that is a distinct defect shape from an unwired gate.
 *
 * They are checked in their own section rather than added to MODULES above,
 * because two of that loop's assertions are false of them for GOOD reasons and
 * papering over that would hide a real difference: `cloudflare-images` has NO
 * SECRET (it is the account-scoped AI binding, like the pre-existing
 * `cloudflare-ai` chat entry) and therefore no https endpoint of its own, and
 * `gemini-images` deliberately SHARES its secret with the `gemini` chat provider.
 * The shared-secret fact in particular is load-bearing and is asserted here
 * rather than allowed to fail a uniqueness check it should not be subject to.
 * ════════════════════════════════════════════════════════════════════════ */
console.log('\n--- The image providers: the Designer\'s first means of working ---');

const IMAGE_MODULES = [
  { name: 'cf-image-client.js', mod: cfImage, id: 'cloudflare-images', role: 'draft', secret: null, limitsExport: 'CF_IMAGE_LIMITS', configKey: 'cloudflare_images' },
  { name: 'gemini-image-client.js', mod: geminiImage, id: 'gemini-images', role: 'polish', secret: 'GEMINI_API_KEY', limitsExport: 'GEMINI_IMAGE_LIMITS', configKey: 'gemini_images' },
];

for (const { name, mod, id, role, secret, limitsExport, configKey } of IMAGE_MODULES) {
  const p = mod.PROVIDER;
  const cfg = tokenEconomy.providers[configKey];
  check(`${name} exports a PROVIDER descriptor`, !!p && typeof p === 'object');
  check(`${name} PROVIDER.id is "${id}"`, p?.id === id, `got ${p?.id}`);
  check(`${name} PROVIDER.kind is "image" — the guard that keeps it off every chat lane`, p?.kind === 'image', `got ${p?.kind}`);
  check(`${name} PROVIDER.role is "${role}" (a role, not a fallback position)`, p?.role === role, `got ${p?.role}`);
  check(`${name} PROVIDER.secretName is ${secret === null ? 'null (account-scoped binding, not a secret)' : secret}`,
    p?.secretName === secret, `got ${p?.secretName}`);
  check(`${name} PROVIDER.call is a function`, typeof p?.call === 'function');
  check(`${name} PROVIDER.checkInputWithinCaps is a function`, typeof p?.checkInputWithinCaps === 'function');
  check(`${name} PROVIDER.limits IS the exported ${limitsExport} (one source, not a copy)`, p?.limits === mod[limitsExport]);
  check(`${name} declares paid:false — free tier only, no escalation ever`, p?.limits?.paid === false);
  check(`${name} declares a defaultModel`, typeof p?.defaultModel === 'string' && p.defaultModel.length > 0);

  // Code and config are two copies of one fact here on purpose (the clients
  // import no JSON so a plain-node verifier can load them). This is the
  // assertion that makes changing one alone FAIL rather than drift.
  check(`${configKey} exists in config/token-economy.json`, !!cfg);
  check(`${configKey}.default_model agrees with the client's DEFAULT_MODEL`,
    cfg?.default_model === p?.defaultModel, `${cfg?.default_model} vs ${p?.defaultModel}`);
  check(`${configKey}.paid is false in the config too`, cfg?.paid === false);
  check(`${configKey}.requests_per_day is null — an honest unknown, never "unlimited"`,
    cfg?.requests_per_day === null, String(cfg?.requests_per_day));
  check(`${name} agrees: requestsPerDay is null, so the router paces by wall clock`,
    mod[limitsExport].requestsPerDay === null, String(mod[limitsExport].requestsPerDay));
  check(`${configKey} names the allowance it SHARES with another provider`,
    typeof cfg?.shared_allowance_with === 'string' && cfg.shared_allowance_with.length > 0,
    String(cfg?.shared_allowance_with));
  check(`${name} names the same shared allowance as the config`,
    mod[limitsExport].sharedAllowanceWith === cfg?.shared_allowance_with,
    `${mod[limitsExport].sharedAllowanceWith} vs ${cfg?.shared_allowance_with}`);
}

// The Cloudflare side's real unit. This is the check that stops someone
// "filling in" requests_per_day from a plausible conversion.
check('cloudflare_images records the free tier in its REAL unit (neurons_per_day)',
  tokenEconomy.providers.cloudflare_images.neurons_per_day === 10000,
  String(tokenEconomy.providers.cloudflare_images.neurons_per_day));
check('...and records that the balance CANNOT be read from inside the Worker',
  tokenEconomy.providers.cloudflare_images.neuron_balance_readable === false);
check('...and says WHY requests_per_day is the wrong unit rather than an unknown number',
  /wrong unit/i.test(tokenEconomy.providers.cloudflare_images._why_requests_per_day_is_null_and_it_is_not_the_usual_reason || ''));
check('cf-image-client.js agrees on the neuron figure (one fact, two copies, asserted equal)',
  cfImage.CF_IMAGE_LIMITS.neuronsPerDay === tokenEconomy.providers.cloudflare_images.neurons_per_day);

// The shared-secret fact, asserted rather than assumed.
check('gemini-images shares GEMINI_API_KEY with the gemini chat provider (a THIRD consumer on a paced key)',
  geminiImage.PROVIDER.secretName === 'GEMINI_API_KEY'
  && tokenEconomy.providers.gemini.secret === 'GEMINI_API_KEY');
check('...and the config says so, so "why did gap digests start getting paced out" has an answer on file',
  /THIRD unobservable consumer|third unobservable consumer/i.test(
    tokenEconomy.providers.gemini_images._this_is_the_same_key_as_the_gemini_block_below || ''));

/* ── The polish role refuses rather than degrading ──────────────────────── */
console.log('\n--- The polish role refuses a call with nothing to polish ---');

const [noImagePolish, noImageWarnings] = await captureWarnings(() =>
  geminiImage.polishImage({ apiKey: 'stub', instruction: 'make the type larger', inputImages: [], agentId: 'verify' }));
check('polishImage() with no input image returns null — it does NOT fall through to generation',
  noImagePolish === null, JSON.stringify(noImagePolish));
check('...and says why, naming the substitution it is refusing to make',
  noImageWarnings.some((w) => /fresh draft|nothing to polish/i.test(w)), JSON.stringify(noImageWarnings));

const [noKeyPolish, noKeyWarnings] = await captureWarnings(() =>
  geminiImage.polishImage({ apiKey: undefined, instruction: 'x', inputImages: [{ base64: 'aGk=' }], agentId: 'verify' }));
check('polishImage() with no key returns null and names GEMINI_API_KEY',
  noKeyPolish === null && noKeyWarnings.some((w) => w.includes('GEMINI_API_KEY')), JSON.stringify(noKeyWarnings));

const [noBinding, noBindingWarnings] = await captureWarnings(() =>
  cfImage.callCloudflareImage({ ai: null, prompt: 'a logo', agentId: 'verify' }));
check('callCloudflareImage() with no AI binding returns null',
  noBinding === null);
check('...and says it is a BINDING rather than a secret (so nobody rotates a key over it — AD-030)',
  noBindingWarnings.some((w) => /binding, not a secret/i.test(w)), JSON.stringify(noBindingWarnings));

/* ── Prompt caps refuse; they never truncate ────────────────────────────── */
console.log('\n--- Image prompt caps refuse rather than truncate ---');

const longPrompt = 'x'.repeat(5000);
check('cf-image-client refuses an over-long prompt',
  cfImage.checkInputWithinCaps({ prompt: longPrompt }).ok === false);
check('...and says it is NOT truncating, and why that matters for an image',
  /Not truncating/.test(cfImage.checkInputWithinCaps({ prompt: longPrompt }).reason || ''));
check('cf-image-client refuses an empty prompt',
  cfImage.checkInputWithinCaps({ prompt: '' }).ok === false);
check('cf-image-client refuses steps over flux-schnell\'s maximum of 8',
  cfImage.checkInputWithinCaps({ prompt: 'a logo', steps: 20 }).ok === false);
check('cf-image-client accepts a normal prompt but reports capUnknown — the ok is about the PROMPT, not the free tier',
  cfImage.checkInputWithinCaps({ prompt: 'a logo', steps: 4 }).ok === true
  && cfImage.checkInputWithinCaps({ prompt: 'a logo', steps: 4 }).capUnknown === true);

// The defect scripts/verify-routing.js §8d caught: the router calls this
// uniformly against the caller's whole options object, and a polish call's text
// is in `instruction`, not `prompt`.
check('gemini-image-client\'s cap check reads `instruction`, not only `prompt` (a polish call carries its text there)',
  geminiImage.checkInputWithinCaps({ instruction: 'make the type larger' }).ok === true,
  JSON.stringify(geminiImage.checkInputWithinCaps({ instruction: 'make the type larger' })));
check('...and still refuses when NEITHER is present',
  geminiImage.checkInputWithinCaps({}).ok === false);
check('gemini-image-client refuses more input images than its per-request cap',
  geminiImage.checkInputWithinCaps({ instruction: 'x', inputImages: [1, 2, 3, 4, 5] }).ok === false);
check('...and says "send fewer" rather than dropping any silently',
  /Not dropping any/.test(geminiImage.checkInputWithinCaps({ instruction: 'x', inputImages: [1, 2, 3, 4, 5] }).reason || ''));

/* ── The provenance note the bible requires ─────────────────────────────── */
console.log('\n--- The provenance note (AGENTS-CHARACTER-CORE-v2.md AGENT 9) ---');

const prov = renderAssetProvenance({
  assetPath: 'campus/agents/09-the-designer/assets/2026-08-10-office-mark.png',
  prompt: 'a minimal monochrome office mark',
  model: '@cf/black-forest-labs/flux-1-schnell',
  provider: 'cloudflare-images',
  role: 'draft',
  date: '2026-08-10',
  bytes: 51234,
});
check('the provenance note names the MODEL — the bible\'s first required field',
  prov.includes('@cf/black-forest-labs/flux-1-schnell'));
check('the provenance note names the DATE — the bible\'s second required field', prov.includes('2026-08-10'));
check('the provenance note names the PROMPT (more than the bible asks; without it the asset cannot be judged against its brief)',
  prov.includes('a minimal monochrome office mark'));
check('the provenance note names WHICH ROLE produced it', /role `draft`/.test(prov));
check('the provenance note names the Designer', /Agent 9 — The Designer/.test(prov));
check('the provenance note cites the requirement it satisfies, so it is not mistaken for decoration',
  /AGENTS-CHARACTER-CORE-v2\.md/.test(prov));

const env1 = imageEnvelope({ base64: 'aGVsbG8=', source: 'cloudflare-images', model: 'm' });
check('imageEnvelope() computes byte length from the base64, so an empty image is detectable as 0 bytes',
  env1.bytes === 5 && imageEnvelope({ base64: '', source: 'x', model: 'm' }).bytes === 0);
check('imageEnvelope() carries NO `text` field — routeTask()\'s empty-answer guard must not reach for one',
  !('text' in env1), Object.keys(env1).join(','));
check('imageEnvelope() carries finishReason, and its consumer shipped in the same commit (unlike the chat one)',
  'finishReason' in env1
  && /empty_image/.test(readFileSync(new URL('../workers/task-router.js', import.meta.url), 'utf8')));

/* ── The image type is READ, not asserted ───────────────────────────────── */
//
// The first asset the office ever committed landed in back-office as
// `2026-08-10-office-mark.png` and was a JPEG. `cf-image-client.js` hardcoded
// `mimeType: 'image/png'` because every Workers AI image model is documented as
// returning PNG. The bytes were perfect; the NAME was wrong — the worse of the
// two failures, because nothing breaks (viewers sniff) and it surfaces later, in
// whichever tool does not.
console.log('\n--- The image type is read from the bytes, never asserted ---');

// Real signatures, hand-built so the test does not depend on a fixture file.
const PNG_B64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13));
const JPEG_B64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1));
const GIF_B64 = btoa('GIF89a______');
const WEBP_B64 = btoa('RIFF____WEBPVP8 ');

check('sniffImageMime() reads a PNG signature', sniffImageMime(PNG_B64) === 'image/png', String(sniffImageMime(PNG_B64)));
check('sniffImageMime() reads a JPEG signature — the case that actually bit',
  sniffImageMime(JPEG_B64) === 'image/jpeg', String(sniffImageMime(JPEG_B64)));
check('sniffImageMime() reads GIF and WEBP too',
  sniffImageMime(GIF_B64) === 'image/gif' && sniffImageMime(WEBP_B64) === 'image/webp');
check('sniffImageMime() returns null for unrecognised bytes — null means UNKNOWN, not "probably png"',
  sniffImageMime(btoa('not an image at all')) === null && sniffImageMime('') === null);
check('extensionForMime() maps an UNKNOWN type to .bin, not to a plausible .png',
  extensionForMime(null) === 'bin' && extensionForMime('image/png') === 'png' && extensionForMime('image/jpeg') === 'jpg');

check('cf-image-client.js no longer hardcodes a mime type',
  !/mimeType: 'image\/png'/.test(readFileSync(new URL('../workers/cf-image-client.js', import.meta.url), 'utf8')));
check('cf-image-client.js sniffs the bytes instead',
  /mimeType: sniffImageMime\(base64\)/.test(readFileSync(new URL('../workers/cf-image-client.js', import.meta.url), 'utf8')));
check('gemini-image-client.js prefers the sniffed type over the declared one, and logs a disagreement',
  /trusting the bytes/.test(readFileSync(new URL('../workers/gemini-image-client.js', import.meta.url), 'utf8')));
check('the asset writer takes its extension from the sniffed type, not from a ternary on jpeg',
  /extensionForMime\(result\.mimeType\)/.test(readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8'))
  && !/mimeType === 'image\/jpeg' \? 'jpg' : 'png'/.test(readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8')));

check('no image-provider path reached the network', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(', '));

/* ── SESSION 41, ITEM B — the Gemini key travels in a header, never a URL ─── */
//
// `?key=${apiKey}` in a fetch URL puts the key in
// `$workers.event.request.url` on every call, which is exactly what
// Cloudflare Workers Logs captures for every outbound subrequest —
// confirmed blocking a real day's log pull (2026-08-31, entropy backstop,
// 10 events on that field alone; SESSION-41-REPORT.md Item B). Google's
// Generative Language API accepts the same key via the `x-goog-api-key`
// header instead, which never reaches the URL.
for (const [file, label] of [
  ['gemini-client.js', 'the text lane'],
  ['gemini-image-client.js', 'the image lane'],
]) {
  const src = readFileSync(new URL(`../workers/${file}`, import.meta.url), 'utf8');
  check(`${file} (${label}) never puts the API key in the request URL`,
    !/[?&]key=\$\{apiKey\}/.test(src));
  check(`${file} (${label}) sends the key via the x-goog-api-key header instead`,
    /'x-goog-api-key':\s*apiKey/.test(src));
}

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

// A near-limit batch must still PASS — the cap has to admit the work the lane
// exists for, not just reject the extreme.
//
// SIZED THROUGH THE ESTIMATOR, not through a copy of its divisor (2026-08-27).
// This read `130_000 * 3 - 3000`, which quietly became an OVER-limit input the
// moment the divisor moved 3 -> 2.75 — the check would then have failed for a
// reason that had nothing to do with the cap it exists to test. Deriving the
// ratio from estimateTokens() itself means the next revision cannot stale it.
const charsPerEstToken = 1000 / estimateTokens('x'.repeat(1000));
const nearLimit = 'x'.repeat(Math.floor(128_000 * charsPerEstToken));
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
/*
 * WINDOW WIDENED 200 -> 400 ON 2026-08-27 (Session 27 ITEM B). The PROPERTY is
 * unchanged and still asserted: Groq returns null on a 429 rather than throwing.
 * What changed is the number of characters between the status test and that
 * `return null` — callGroq() now reads the 429 body and fires `onResponse` with
 * it, so the router's attempt trail carries the provider's own message instead of
 * `msg=""`. The old window fitted the old block by coincidence, not by design;
 * narrowing a regex until it happens to fit is how a check stops testing the
 * thing it names. See workers/groq-client.js's call-site block.
 */
check('groq-client.js (the shape being mirrored) returns null on 429', /res\.status === 429[\s\S]{0,400}return null/.test(groqSrc));
check('groq-client.js carries the 429 AND the non-ok body into the router attempt trail (Session 27)',
  /res\.status === 429[\s\S]{0,400}onResponse\?\.\(\{ status: res\.status, error:/.test(groqSrc)
  && /if \(!res\.ok\)[\s\S]{0,400}onResponse\?\.\(\{ status: res\.status, error:/.test(groqSrc));

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
/*
 * Tests the SUM, not an equality with the concatenation (2026-08-27). It used to
 * assert `=== estimateTokens('x'.repeat(600))`, which held only because 300/3 is
 * a whole number: each part is rounded up independently, so with a non-integer
 * divisor two ceilings do not equal one. That made a TRUE property read as false
 * the moment the divisor became 2.75. The property was always "both are counted".
 */
check('estimatePromptTokens sums prompt AND systemPrompt (a persona prompt is not free)',
  estimatePromptTokens({ prompt: 'x'.repeat(300), systemPrompt: 'y'.repeat(300) })
    === estimateTokens('x'.repeat(300)) + estimateTokens('y'.repeat(300)));
check('...and a system prompt strictly increases the estimate — it is never free',
  estimatePromptTokens({ prompt: 'x'.repeat(300), systemPrompt: 'y'.repeat(300) })
    > estimateTokens('x'.repeat(300)));

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

// ── 14400 -> 1000, 2026-08-23 ────────────────────────────────────────────
// This assertion did its job: it went red the moment the number moved, which is
// what a pinned pre-existing limit is for. It is re-pinned to the new value
// rather than relaxed, because the property being protected is "nobody changes
// this without saying why", not "this equals 14400".
//
// WHY THE NUMBER MOVED. Groq's free-tier request ceiling is PER MODEL, and this
// one belonged to `llama-3.1-8b-instant`, which was shut down on 2026-08-16.
// `openai/gpt-oss-20b` carries 1,000/day, MEASURED off the first live routed
// call's `x-ratelimit-limit-requests: 1000` / `x-ratelimit-reset-requests:
// 1m26.4s` — 86.4s is exactly 86400/1000, the refill interval of a per-DAY
// bucket with one request spent, which is what proves the reading is daily.
// See config/token-economy.json's `_daily_limits_groq_remeasured_2026_08_23`.
check('daily_limits.groq is 1000 — the openai/gpt-oss-20b free-tier ceiling, MEASURED 2026-08-23 (was 14400, which belonged to the retired llama-3.1-8b-instant)',
  tokenEconomy.daily_limits?.groq === 1000);
check('...and the change is EXPLAINED in the config, not just made',
  /_daily_limits_groq_remeasured_2026_08_23/.test(JSON.stringify(tokenEconomy))
  && /_remeasured_2026_08_23/.test(JSON.stringify(tokenEconomy.providers?.groq || {})));
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
  // `export const` since 2026-08-23 (Session 14, ITEM C — the weekly catalogue
  // check reads the identifier from its definition site rather than carrying a
  // copy). The `export ` is OPTIONAL in this pattern rather than required: this
  // check is about the VALUE agreeing with the config, and an anchor that also
  // pinned the declaration keyword turned a legitimate export into a red line
  // that read as a model drift.
  const codeModel = (groqSrc.match(/^(?:export )?const GROQ_MODEL = '([^']+)'/m) || [])[1];
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

/* ── TIGHTENED 2026-08-10, when the image lane made the old shape wrong ────
 *
 * This check tested MODULE-level imports: any file but the router importing any
 * of these modules failed it. The image lane broke that in a way that is not a
 * violation of the rule the check exists to enforce:
 *
 *   · `agent-runner.js` imports `renderAssetProvenance` from provider-common.js
 *     — a pure string renderer that calls no provider;
 *   · `agent-runner.js` imports `listImageCapableModels` from
 *     gemini-image-client.js for the `image_catalog` trigger — a live CATALOG
 *     read, which is AD-030 check 1 and consumes no generation quota.
 *
 * The tempting move was to add agent-runner.js to ALLOWED_IMPORTERS. That would
 * have been the wrong fix and the expensive kind of wrong: it would have exempted
 * the single largest file in the repo — the one that actually contains the
 * scheduled callers — from the containment rule entirely, and the exemption would
 * have been invisible at the site of any future violation.
 *
 * So the check now asserts on IMPORTED SYMBOLS. The property that matters is not
 * "which files may name these modules" but **nothing outside the router may
 * import a function that CALLS a provider**, because that is what bypasses the
 * kill switch and the quota allow-check. Every generating function in these
 * modules is named `call<Provider>` or is `polishImage`, and both patterns are
 * enforced below by name rather than by a hand-maintained list, so a NEW
 * generating function is caught the day it is added.
 *
 * The three pre-existing chat/embeddings clients keep the stricter MODULE-level
 * rule, with no symbol exemption at all: they have live callers on the daily Q&A
 * path and there is no reason for anything but the router to name them.
 */
const CALLING_MODULES = [
  'cerebras-client.js', 'mistral-client.js', 'cohere-client.js',
  'cf-image-client.js', 'gemini-image-client.js', 'provider-common.js',
];
/** Modules NOTHING outside the router may import, at all, by any symbol. */
const ROUTER_ONLY_MODULES = ['cerebras-client.js', 'mistral-client.js', 'cohere-client.js'];
const ALLOWED_IMPORTERS = ['task-router.js'];
const workerFiles = readdirSync(new URL('../workers/', import.meta.url)).filter((f) => f.endsWith('.js'));
const agentFiles = readdirSync(new URL('../agents/', import.meta.url)).filter((f) => f.endsWith('.js'));

/** A symbol that performs a provider call. Pattern-based on purpose: a list of
 *  known names goes stale the moment somebody adds a function to a client. */
const CALLS_A_PROVIDER = (symbol) => /^call[A-Z]/.test(symbol) || symbol === 'polishImage';

/**
 * Every import statement in a file, as `{ clause, module }`.
 *
 * Anchored at `^import` with the `m` flag, and that anchor is load-bearing: an
 * unanchored lazy `import\s+([\s\S]*?)\s+from\s+'<module>'` starts at the FIRST
 * import in the file and extends across every statement between it and the
 * target, so a file's whole import block reads as one clause. That is exactly
 * what happened when this was first written — `agent-runner.js` was reported as
 * importing `{ *, PerfectionistAgent }` from `gemini-image-client.js`, which is a
 * containment violation the checker invented out of its own regex. A checker that
 * reports a false violation is worse than a loose one: the cheapest way to make it
 * pass is to add an exemption for a problem that does not exist.
 */
function importStatements(src) {
  const out = [];
  const re = /^import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ clause: m[1].trim(), module: m[3] });
  return out;
}

/** The named import specifiers a file pulls from one module, e.g.
 *  `import { a, b as c } from './x.js'` -> ['a', 'b']. Default and namespace
 *  imports are reported as '*', which always counts as calling: a namespace
 *  import hands the importer every function in the module. */
function importedSymbolsFrom(src, moduleFile) {
  const symbols = [];
  for (const { clause, module } of importStatements(src)) {
    if (!module.endsWith(`/${moduleFile}`) && module !== `./${moduleFile}` && !module.endsWith(moduleFile)) continue;
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (!braces) { symbols.push('*'); continue; }
    if (!/^\{/.test(clause)) symbols.push('*'); // a default import alongside a named list
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) symbols.push(name);
    }
  }
  return symbols;
}

const importers = [];
const moduleLevelViolations = [];
const benignImports = [];
for (const [dir, files] of [['workers', workerFiles], ['agents', agentFiles]]) {
  for (const file of files) {
    if (dir === 'workers' && CALLING_MODULES.includes(file)) continue; // these may import each other
    if (dir === 'workers' && ALLOWED_IMPORTERS.includes(file)) continue; // the router is the one legitimate importer
    const src = readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8');
    for (const mod of CALLING_MODULES) {
      const symbols = importedSymbolsFrom(src, mod);
      if (!symbols.length) continue;
      if (ROUTER_ONLY_MODULES.includes(mod)) {
        moduleLevelViolations.push(`${dir}/${file} -> ${mod}`);
        continue;
      }
      const calling = symbols.filter(CALLS_A_PROVIDER);
      if (calling.length) importers.push(`${dir}/${file} -> ${mod} { ${calling.join(', ')} }`);
      else benignImports.push(`${dir}/${file} -> ${mod} { ${symbols.join(', ')} }`);
    }
  }
}

check('nothing outside the router imports a function that CALLS a provider (so nothing bypasses the switch or the quota check)',
  importers.length === 0, importers.join(', '));
check('the three chat/embeddings clients are imported by NOTHING but the router, by any symbol',
  moduleLevelViolations.length === 0, moduleLevelViolations.join(', '));
// Reported rather than merely permitted. A benign import is still a coupling, and
// a silent allow-list is how the next one goes unnoticed.
// COUNT RAISED 2 -> 4, 2026-08-23 (Session 13, ITEM B). The two new entries are
// groq-client.js and gemini-client.js importing provider-common.js, for the
// shared response envelope and the NOT_REPORTED sentinel. Both are non-calling
// by construction — provider-common.js makes no network call and holds no
// provider state, which is the property that lets every verifier import the
// clients under plain `node`. The count is deliberately kept EXACT rather than
// relaxed to `>= 2`: a silent allow-list is how the next coupling goes
// unnoticed, which is what the comment above already says.
check('every non-calling import of a provider module is accounted for (5 expected: the provenance renderer, the catalog read-back, the two chat clients sharing the envelope, and agent-base taking the sentinel)',
  benignImports.length === 5, benignImports.join(' | '));
check('...and agent-base.js is one of them, for the not-reported sentinel on the two ask paths',
  benignImports.some((s) => /agent-base\.js -> provider-common\.js \{[^}]*NOT_REPORTED/.test(s)), benignImports.join(' | '));
check('...and one of them is the AD-030 catalog read-back, which makes no generation call',
  benignImports.some((s) => /gemini-image-client\.js \{ listImageCapableModels \}/.test(s)), benignImports.join(' | '));
check('...and one is provider-common.js, for the provenance renderer the bible requires and the mime sniffer',
  benignImports.some((s) => /provider-common\.js \{[^}]*renderAssetProvenance/.test(s)), benignImports.join(' | '));
// THE TWO FIELDS, asserted as an import rather than only as behaviour: the
// whole defect was that groq-client.js and gemini-client.js each read a
// provider body their own way and dropped what they did not use. Sharing the
// normaliser and the sentinel is what stops the two envelopes drifting apart
// again, and an edit that quietly went back to a local shape would pass every
// behavioural check in this file and fail here.
check('...and groq-client.js takes the SHARED OpenAI normaliser rather than re-reading the body itself',
  benignImports.some((s) => /groq-client\.js -> provider-common\.js \{[^}]*normalizeOpenAiChat/.test(s)), benignImports.join(' | '));
check('...and gemini-client.js takes the SHARED not-reported sentinel rather than inventing its own string',
  benignImports.some((s) => /gemini-client\.js -> provider-common\.js \{[^}]*NOT_REPORTED/.test(s)), benignImports.join(' | '));

check('the router itself DOES import all five clients (it is the single entry point)',
  ['cerebras-client.js', 'mistral-client.js', 'cohere-client.js', 'cf-image-client.js', 'gemini-image-client.js'].every((m) =>
    new RegExp(`from\\s+'\\./${m.replace('.', '\\.')}'`).test(
      readFileSync(new URL('../workers/task-router.js', import.meta.url), 'utf8'))));

// All five clients, image ones included: the shared helpers exist so that the
// two things which rot when duplicated — the input estimate and the response
// envelope — have one definition. A client that copied them would pass every
// behavioural check here and drift on the next edit.
const newModuleImports = CALLING_MODULES.filter((f) => f !== 'provider-common.js').map((f) => {
  const src = readFileSync(new URL(`../workers/${f}`, import.meta.url), 'utf8');
  return { f, importsCommon: /from '\.\/provider-common\.js'/.test(src) };
});
check('every client imports the shared helpers rather than copying them',
  newModuleImports.every((m) => m.importsCommon), JSON.stringify(newModuleImports));

check('model-router.js reaches the providers only via task-router.js, never by importing a client directly',
  /from '\.\/task-router\.js'/.test(readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8'))
  && !/from '\.\/(cerebras|mistral|cohere|cf-image|gemini-image)-client\.js'/.test(
    readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8')));

/* ══════════════════════════════════════════════════════════════════════════
 * THE TWO FIELDS — BEHAVIOURAL, NOT ONLY STRUCTURAL (SESSION 13, 2026-08-23)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The import checks above prove the clients SHARE the envelope. They cannot
 * prove the fields arrive populated, and "the field exists" was never the
 * problem — Groq has always sent `finish_reason`, and Cerebras' was read for
 * exactly one check and ignored everywhere else for five days.
 *
 * So these run the real client functions against a stubbed transport and
 * assert the values. The tripwire is swapped out and RESTORED around each
 * call, and nothing here appends to NETWORK_TRIPWIRE, so the end-to-end
 * "zero network calls" assertion below stays honest.
 */
console.log('\n--- The two fields: finish reason and output tokens ---');

const { callGroq } = await import('../workers/groq-client.js');
const { callGemini, callCloudflareFallback, NOT_REPORTED } = await import('../workers/gemini-client.js');

/** Runs fn with globalThis.fetch replaced by `stub`, restoring the tripwire. */
async function withFetch(stub, fn) {
  const tripwire = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = tripwire;
  }
}

const okRes = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const groqTruncated = await withFetch(
  async () => okRes({
    choices: [{ message: { content: 'half an ans' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 40, completion_tokens: 512, total_tokens: 552 },
  }),
  () => callGroq({ apiKey: 'stub', prompt: 'p', maxTokens: 512, agentId: 'verify' }),
);
check('GROQ — a max_tokens-truncated answer now reports finish_reason "length" instead of looking short',
  groqTruncated?.finishReason === 'length', JSON.stringify(groqTruncated));
check('GROQ — the output-token count is carried out as a named field',
  groqTruncated?.outputTokens === 512, JSON.stringify(groqTruncated?.usage));
check('GROQ — text and source are UNCHANGED, so every pre-existing caller is byte-identical',
  groqTruncated?.text === 'half an ans' && groqTruncated?.source === 'groq');

const geminiCut = await withFetch(
  async () => okRes({
    candidates: [{ content: { parts: [{ text: 'cut off here' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2048, totalTokenCount: 2078 },
  }),
  () => callGemini({ apiKey: 'stub', model: 'm', endpoint: 'https://example.invalid', prompt: 'p' }),
);
check('GEMINI — MAX_TOKENS is now visible at the call site rather than inferred from a short string',
  geminiCut?.finishReason === 'MAX_TOKENS', JSON.stringify(geminiCut));
check('GEMINI — candidatesTokenCount is carried out as outputTokens',
  geminiCut?.outputTokens === 2048, JSON.stringify(geminiCut?.usage));

// PRESENT-BUT-MISSING is a real, distinct state and must not be flattened into
// the sentinel: it says THIS response lost a field the provider does have,
// which is an anomaly worth seeing. NOT_REPORTED says the provider never had
// one, which is not.
const geminiNoField = await withFetch(
  async () => okRes({ candidates: [{ content: { parts: [{ text: 'fine' }] } }] }),
  () => callGemini({ apiKey: 'stub', model: 'm', endpoint: 'https://example.invalid', prompt: 'p' }),
);
check('GEMINI — a response that omits finishReason yields null, NOT the not_reported sentinel',
  geminiNoField?.finishReason === null && geminiNoField?.outputTokens === null,
  JSON.stringify(geminiNoField));
check('...and it still declares that the provider REPORTS the field, so null reads as an anomaly',
  geminiNoField?.outputTokensReported === true);

const cfWithUsage = await callCloudflareFallback({
  ai: { run: async () => ({ response: 'answered', usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } }) },
  prompt: 'p',
  maxTokens: 64,
});
check('CLOUDFLARE WORKERS AI — has NO finish reason of any kind, so it reports the explicit not_reported sentinel',
  cfWithUsage?.finishReason === NOT_REPORTED, JSON.stringify(cfWithUsage));
check('...and the sentinel is a shared constant, not a per-client string literal',
  NOT_REPORTED === 'not_reported');
check('CLOUDFLARE WORKERS AI — output tokens are carried when the model returns a usage block',
  cfWithUsage?.outputTokens === 7 && cfWithUsage?.outputTokensReported === true);

// The Workers AI usage block is model-dependent and frequently absent. An
// absent count must SAY it was absent — a bare null is indistinguishable from
// "the model emitted nothing", which is a completely different fact.
const cfNoUsage = await callCloudflareFallback({
  ai: { run: async () => ({ response: 'answered' }) },
  prompt: 'p',
  maxTokens: 64,
});
check('CLOUDFLARE WORKERS AI — no usage block yields outputTokens null AND outputTokensReported false',
  cfNoUsage?.outputTokens === null && cfNoUsage?.outputTokensReported === false,
  JSON.stringify(cfNoUsage));

// The router was the SECOND place the fields were lost: even after a client
// carried them, the groq/cloudflare/gemini wrappers rebuilt the envelope from
// `text` and `source` alone. Asserted as source, because calling routeTask()
// here would need the flag, the quota tables and a live env.
const routerSrcTwoFields = readFileSync(new URL('../workers/task-router.js', import.meta.url), 'utf8');
check('ROUTER — the groq wrapper carries finishReason through instead of rebuilding a two-field envelope',
  /callGroq\([\s\S]{0,700}?finishReason: r\.finishReason/.test(routerSrcTwoFields));
check('ROUTER — the cloudflare-ai wrapper carries it too',
  /callCloudflareFallback\([\s\S]{0,600}?finishReason: r\.finishReason/.test(routerSrcTwoFields));
check('ROUTER — and the gemini wrapper',
  /callGemini\([\s\S]{0,800}?finishReason: r\.finishReason/.test(routerSrcTwoFields));

// PERSISTENCE. Carrying a field to a caller that drops it is the same defect
// one layer out, which is exactly what happened to the meeting row: the only
// provider it ever recorded was written inside a gate for something else.
const loopSrcTwoFields = readFileSync(new URL('../workers/improvement-loop.js', import.meta.url), 'utf8');
check('D1 — the office-event INSERT names finish_reason and output_tokens',
  /INSERT INTO reports[\s\S]{0,300}finish_reason, output_tokens/.test(loopSrcTwoFields));
const meetingSrcTwoFields = readFileSync(new URL('../workers/meeting-engine.js', import.meta.url), 'utf8');
check('D1 — the meeting row names composed_by, and it is written OUTSIDE the fabricated-participation gate',
  /INSERT INTO meetings[\s\S]{0,300}composed_by, finish_reason, output_tokens/.test(meetingSrcTwoFields)
  && /persistMeeting\(env, \{[\s\S]{0,400}composedBy: modelResult\?\.source/.test(meetingSrcTwoFields));
const agentBaseSrcTwoFields = readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8');
// THE ASK PATH is the one place a provider response never arrives at all:
// _askDataCenter() goes through data-center-api's /api/chat and
// _askNotebookX() through Notebook-X's own backend, so no finish reason exists
// to carry. B1's rule applies exactly there — an explicit "not reported" is a
// fact, a missing field is an absence that reads as normal.
check('ASK PATH — both asks state NOT_REPORTED rather than returning nothing',
  (readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8')
    .match(/finishReason: NOT_REPORTED, outputTokens: null, outputTokensReported: false/g) || []).length === 2);
check('...and the sentinel is imported from provider-common.js, not spelled locally',
  /import \{ NOT_REPORTED \} from '\.\.\/workers\/provider-common\.js'/.test(
    readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8')));
// The estimate must not leak into the measured column: recordClaudeSpend()
// estimates ~4 chars/token on the data-center path for the BUDGET, and that
// number must never reach `outputTokens`, where a reader expects provider
// evidence. Asserted as `outputTokens: null` on the returned object above
// rather than as the absence of `Math.ceil` in the file — the estimate itself
// is legitimate and still there, it just does not travel into the row.

check('AGENT — every model call records the two fields through ONE helper, not five copied assignments',
  /_recordLastModelCall\(result\)/.test(agentBaseSrcTwoFields)
  && !/this\.lastModelSource = (result|groqResult|cfResult)\.source/.test(agentBaseSrcTwoFields));

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
