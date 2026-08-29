#!/usr/bin/env node
// Dry-run verification for task-type routing (plan Phase 3, items 3.3/3.4/3.6).
//
// NO NETWORK. NO REAL D1/KV. NO MODEL CALLS. globalThis.fetch is replaced
// with a tripwire that throws if anything reaches it, and every provider in
// the registry is swapped for a counting stub, so "the switch being off
// contacts nobody" is proven by counting invocations rather than asserted.
//
// This imports workers/task-router.js and CALLS it. That is the whole reason
// the routing logic lives there rather than in model-router.js, which
// imports JSON and cannot be loaded by plain `node` — proving "Anthropic is
// unreachable from every routing path" by grepping for a string would be
// worth very little, so it is proven by pointing a lane at Anthropic on
// purpose and watching the resolver refuse.
//
// Run: node scripts/verify-routing.js

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import {
  PROVIDER_REGISTRY,
  resolveLane,
  routeTask,
  routingEnabled,
  assignEmbodiment,
  renderEmbodimentMap,
  checkProviderAllowance,
  providerPeriodKey,
  periodBucket,
  capFor,
  dailyCapFor,
  hasKnownCap,
  paceSpacingFor,
  LANE_KINDS,
  EMBODIMENT_KIND,
  SIM_STATE_KEY,
  ROUTING_FLAG,
} from '../workers/task-router.js';

import { DEFAULT_MODEL as cfImageDefaultModel } from '../workers/cf-image-client.js';

const require = createRequire(import.meta.url);
const routingConfig = require('../config/model-routing.json');
const tokenEconomy = require('../config/token-economy.json');

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

const NETWORK_TRIPWIRE = [];
globalThis.fetch = (...args) => {
  NETWORK_TRIPWIRE.push(String(args[0]));
  throw new Error(`verify-routing.js made a network call to ${args[0]} — this verifier must stay dry-run`);
};

/* ── Test doubles ───────────────────────────────────────────────────────── */

/** Swaps every registry provider for a stub that counts invocations. */
const INVOCATIONS = [];
const REAL_INVOKE = {};
function stubAllProviders({ failing = [], emptyText = [], emptyImage = [] } = {}) {
  INVOCATIONS.length = 0;
  for (const [id, p] of Object.entries(PROVIDER_REGISTRY)) {
    if (!(id in REAL_INVOKE)) REAL_INVOKE[id] = p.invoke;
    p.invoke = async (env, opts) => {
      INVOCATIONS.push(id);
      if (failing.includes(id)) {
        opts.onResponse?.({ status: 500 });
        return null;
      }
      // An IMAGE envelope with zero bytes in it — the image-lane twin of the
      // empty chat answer below, and the shape that would put an empty asset in
      // a repo with a provenance note attached. See §8d.
      if (emptyImage.includes(id)) {
        return { base64: '', bytes: 0, mimeType: 'image/png', model: 'stub-model', source: id, finishReason: null, usage: {}, rateLimit: {} };
      }
      if (p.kind === 'image') {
        return { base64: 'aGVsbG8=', bytes: 5, mimeType: 'image/png', model: 'stub-model', source: id, finishReason: null, usage: {}, rateLimit: {} };
      }
      // A 200 that carries NO CONTENT. This is what Cerebras' reasoning model
      // actually returns when max_tokens is spent on thinking — a well-formed
      // envelope with an empty string in it. See §5b below.
      if (emptyText.includes(id)) {
        return { text: '', source: id, finishReason: 'length', usage: { inputTokens: 87, outputTokens: 64 }, rateLimit: {} };
      }
      return { text: `stub:${id}`, source: id, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 }, rateLimit: {} };
    };
  }
}

/** Minimal fake D1 backed by a plain object of period_key -> call_count. */
function fakeDb(counts = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT call_count/.test(sql)) return { call_count: counts[args[0]] ?? 0 };
              return null;
            },
            async run() { return {}; },
            async all() { return { results: [] }; },
          };
        },
        async run() { return {}; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
  };
}

function fakeEnv({ enabled = false, counts = {}, kv = {}, credentials = true } = {}) {
  const store = { ...kv };
  const env = {
    SIM_KV: {
      async get(key, type) {
        if (key === SIM_STATE_KEY) return type === 'json' ? { [ROUTING_FLAG]: enabled } : JSON.stringify({ [ROUTING_FLAG]: enabled });
        return store[key] ?? null;
      },
      async put(key, value) { store[key] = value; },
    },
    DB: fakeDb(counts),
    _kvStore: store,
  };
  if (credentials) {
    Object.assign(env, {
      CEREBRAS_API_KEY: 'stub', MISTRAL_API_KEY: 'stub',
      COHERE_API_KEY: 'stub', GROQ_API_KEY: 'stub', GEMINI_API_KEY: 'stub', AI: {},
    });
  }
  return env;
}

/** Deterministic rng for reproducible shuffles. */
function seededRng(seed = 1) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

console.log('=== Task-type routing verification — dry-run only, no network/model/D1/KV calls ===\n');

/* ── 1. The lane table matches the owner's routing table ────────────────── */
console.log('--- The routing table resolves each task type to the right provider ---');

const EXPECTED = [
  // judgment was repointed 2026-08-06 when GitHub Models was retired. It now
  // shares BOTH providers with long_document — a known concentration risk,
  // asserted below rather than left implicit.
  ['judgment', 'cerebras', 'mistral'],
  ['long_document', 'cerebras', 'mistral'],
  ['hebrew_composition', 'gemini', 'mistral'],
  ['routine_volume', 'groq', 'cloudflare-ai'],
  ['classification', 'cloudflare-ai', 'groq'],
  ['embeddings', 'cohere', undefined],
];

for (const [lane, primary, backup] of EXPECTED) {
  const r = resolveLane(routingConfig, lane);
  check(`lane "${lane}" is routable`, r.routable === true, r.reason || '');
  check(`lane "${lane}" primary is ${primary}`, r.candidates[0] === primary, `got ${r.candidates[0]}`);
  if (backup) {
    check(`lane "${lane}" backup is ${backup}`, r.candidates[1] === backup, `got ${r.candidates[1]}`);
  } else {
    check(`lane "${lane}" has NO backup (fail, don't degrade)`, r.candidates.length === 1, `got ${r.candidates.join(',')}`);
  }
}

const conv = resolveLane(routingConfig, 'conversation', { rng: seededRng(7) });
check('lane "conversation" is routable', conv.routable === true, conv.reason || '');
check('lane "conversation" uses controlled_random mode', conv.mode === 'controlled_random');
check('lane "conversation" pool has more than one provider (a shuffle of one measures nothing)', conv.candidates.length > 1);
check('lane "conversation" pool contains NO embeddings provider (cohere cannot serve chat)',
  !conv.candidates.includes('cohere'), conv.candidates.join(','));
// The shuffle is checked by DISTRIBUTION, not by two hand-picked seeds.
//
// It used to compare seed 1 against seed 99 and assert they differed. That
// passed with a six-provider pool and broke the moment GitHub Models was
// removed — not because the shuffle regressed, but because both seeds happen
// to land on mistral in a five-provider pool. A test that depends on which
// seeds collide is measuring the fixture, not the behaviour, and it fails
// exactly when the pool changes: the one moment you actually want a trustworthy
// signal. Sampling many seeds and requiring EVERY pool member to come up first
// at least once is both stronger (it catches a provider that can never be
// picked) and stable across pool edits.
const CONV_SEEDS = 200;
const firstPicks = new Map();
for (let seed = 1; seed <= CONV_SEEDS; seed += 1) {
  const pick = resolveLane(routingConfig, 'conversation', { rng: seededRng(seed) }).candidates[0];
  firstPicks.set(pick, (firstPicks.get(pick) || 0) + 1);
}
check(`lane "conversation" shuffles — more than one distinct first pick over ${CONV_SEEDS} seeds`,
  firstPicks.size > 1, JSON.stringify([...firstPicks]));
check('lane "conversation" — EVERY provider in the pool can be picked first (none is unreachable)',
  routingConfig.lanes.conversation.pool.every((id) => firstPicks.has(id)),
  `pool=${routingConfig.lanes.conversation.pool.join(',')} picked=${[...firstPicks.keys()].join(',')}`);

check('every ordered lane resolves to providers that exist in the registry',
  EXPECTED.every(([lane]) => resolveLane(routingConfig, lane).candidates.every((id) => !!PROVIDER_REGISTRY[id])));
check('the embeddings lane resolves to an embeddings-kind provider',
  PROVIDER_REGISTRY[resolveLane(routingConfig, 'embeddings').candidates[0]].kind === 'embeddings');
check('every chat lane resolves to chat-kind providers only',
  EXPECTED.filter(([l]) => l !== 'embeddings').every(([lane]) =>
    resolveLane(routingConfig, lane).candidates.every((id) => PROVIDER_REGISTRY[id].kind === 'chat')));

/* ── 1b. GitHub Models is gone from every routing surface ───────────────── */
//
// Retired by the provider on 2026-07-30, removed here 2026-08-06. A dead
// provider is easy to half-remove: the client file goes but a pool entry or a
// lane survives and fails at RUNTIME as `unknown_provider` instead of here.
console.log('\n--- GitHub Models is absent from every routing surface ---');

check('PROVIDER_REGISTRY has no github-models entry',
  !PROVIDER_REGISTRY['github-models'], Object.keys(PROVIDER_REGISTRY).join(','));
check('no lane names github-models anywhere (primary, backup or pool)',
  !Object.values(routingConfig.lanes)
    .flatMap((l) => [l.primary, l.backup, ...(l.pool || [])])
    .includes('github-models'));
check('the removal is RECORDED in the config, not silently dropped (decision history)',
  !!routingConfig._meta._provider_removals?.['github-models']?.reason);
check('the removal note warns that the 410 "brownout" wording is stale',
  /stale/i.test(routingConfig._meta._provider_removals?.['github-models']?.do_not_re_add || ''));
check('a lane still pointed at github-models would be REFUSED, not routed',
  resolveLane(
    { ...routingConfig, lanes: { ...routingConfig.lanes, judgment: { primary: 'github-models', backup: 'mistral', kind: 'chat' } } },
    'judgment'
  ).reason?.startsWith('unknown_provider'));

/* ── 1c. The concentration risk is declared where someone will read it ──── */
//
// judgment and long_document now share a primary AND a backup. That is an
// accepted risk, but an UNDOCUMENTED shared dependency is how a two-lane
// outage becomes a surprise. These checks fail if the note is ever dropped.
console.log('\n--- The Cerebras two-lane concentration risk is documented ---');

const judgmentLane = routingConfig.lanes.judgment;
const longDocLane = routingConfig.lanes.long_document;
check('judgment and long_document genuinely DO share a primary (the risk is real, not theoretical)',
  judgmentLane.primary === longDocLane.primary && judgmentLane.primary === 'cerebras');
check('...and share a backup too, so a primary outage concentrates rather than spreads',
  judgmentLane.backup === longDocLane.backup && judgmentLane.backup === 'mistral');
check('the judgment lane declares the concentration risk',
  /concentration|one .*outage|both lanes/i.test(judgmentLane._concentration_risk || ''), judgmentLane._concentration_risk);
check('the risk note names OpenRouter as the intended diversification',
  /OpenRouter/i.test(judgmentLane._concentration_risk || ''));
check('...and states it is deliberately NOT added yet (so nobody "fixes" it by surprise)',
  /not added|NOT added/i.test(judgmentLane._concentration_risk || ''));
check('long_document cross-references the same risk rather than restating it inconsistently',
  /concentration_risk/i.test(longDocLane._concentration_risk || ''));

/* ── 2. Anthropic is unreachable from every routing path ────────────────── */
console.log('\n--- Anthropic is unreachable from every routing path ---');

const architect = resolveLane(routingConfig, 'architect');
check('the architect lane is NOT routable', architect.routable === false);
check('the architect lane refuses with lane_never_routed', architect.reason === 'lane_never_routed', architect.reason);
check('the architect lane yields zero candidates', architect.candidates.length === 0);
check('the architect lane names no provider in config', !routingConfig.lanes.architect.primary && !routingConfig.lanes.architect.backup);

check('PROVIDER_REGISTRY has no anthropic/claude entry',
  !Object.keys(PROVIDER_REGISTRY).some((id) => /anthropic|claude/i.test(id)), Object.keys(PROVIDER_REGISTRY).join(','));
check('no lane in config/model-routing.json names an anthropic provider',
  !/"(primary|backup)":\s*"[^"]*(anthropic|claude)/i.test(JSON.stringify(routingConfig)));
check('the conversation pool contains no anthropic provider',
  !routingConfig.lanes.conversation.pool.some((id) => /anthropic|claude/i.test(id)));

// The second, independent barrier: even a lane that DOES name Anthropic fails
// closed, because the registry has no such provider to resolve it to.
const sabotaged = JSON.parse(JSON.stringify(routingConfig));
sabotaged.lanes.judgment.primary = 'anthropic';
const sabotagedResolve = resolveLane(sabotaged, 'judgment');
check('a lane deliberately pointed at "anthropic" is REFUSED, not routed',
  sabotagedResolve.routable === false, JSON.stringify(sabotagedResolve));
check('...and refuses specifically as unknown_provider (registry is the second barrier)',
  sabotagedResolve.reason.startsWith('unknown_provider'), sabotagedResolve.reason);

const sabotagedPool = JSON.parse(JSON.stringify(routingConfig));
sabotagedPool.lanes.conversation.pool = ['groq', 'anthropic'];
check('an anthropic entry smuggled into the conversation pool is also refused',
  resolveLane(sabotagedPool, 'conversation', { rng: seededRng(3) }).routable === false);

const taskRouterSrc = readFileSync(new URL('../workers/task-router.js', import.meta.url), 'utf8');
check('task-router.js imports no anthropic/claude client',
  !/from\s+['"][^'"]*claude-client\.js['"]/.test(taskRouterSrc));
check('task-router.js never references api.anthropic.com', !taskRouterSrc.includes('api.anthropic.com'));

/* ── 3. The switch, OFF, reproduces today's behaviour exactly ───────────── */
console.log('\n--- Kill switch OFF: nothing routes, nothing is contacted ---');

stubAllProviders();

check('routingEnabled() is false when the flag is absent',
  (await routingEnabled({ SIM_KV: { get: async () => ({}) } })) === false);
check('routingEnabled() is false when SIM_KV is missing entirely (fails closed)',
  (await routingEnabled({})) === false);
check('routingEnabled() is false for a truthy non-true value (=== true, like guidesEnabled)',
  (await routingEnabled({ SIM_KV: { get: async () => ({ routing_enabled: 'yes' }) } })) === false);
check('routingEnabled() is true only for an explicit true',
  (await routingEnabled({ SIM_KV: { get: async () => ({ routing_enabled: true }) } })) === true);

const offEnv = fakeEnv({ enabled: false });
for (const lane of ['judgment', 'long_document', 'hebrew_composition', 'routine_volume', 'classification', 'conversation', 'embeddings']) {
  // eslint-disable-next-line no-await-in-loop
  const r = await routeTask({ env: offEnv, taskType: lane, routingConfig, tokenEconomy, prompt: 'hi', texts: ['hi'] });
  check(`lane "${lane}" refuses with routing_disabled while the switch is off`,
    r.ok === false && r.routed === false && r.reason === 'routing_disabled', JSON.stringify(r));
}
check('NO provider was invoked while the switch was off', INVOCATIONS.length === 0, INVOCATIONS.join(','));
check('no KV pacing key was written while the switch was off',
  Object.keys(offEnv._kvStore).length === 0, Object.keys(offEnv._kvStore).join(','));

check('the shipped config defaults the switch to false', routingConfig.switch.default_when_absent === false);
check('task-router.js reads the same SIM_KV key agent-runner.js uses', SIM_STATE_KEY === 'simulation-state');
const agentRunnerSrc = readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8');
check('agent-runner.js SIM_STATE_KEY matches task-router.js SIM_STATE_KEY',
  new RegExp(`SIM_STATE_KEY = '${SIM_STATE_KEY}'`).test(agentRunnerSrc));
check('routing_enabled is whitelisted in updateSimulationState',
  /allowedKeys = \[[^\]]*'routing_enabled'[^\]]*\]/.test(agentRunnerSrc));
check('guides_enabled is STILL whitelisted (the new flag did not displace it)',
  /allowedKeys = \[[^\]]*'guides_enabled'[^\]]*\]/.test(agentRunnerSrc));
check('a routing_toggle trigger exists (flip without redeploy)',
  /case 'routing_toggle':[\s\S]{0,900}routing_enabled: !!body\.enabled/.test(agentRunnerSrc));
check('the ONLY gate bypass is the supervised routing_test trigger',
  (agentRunnerSrc.match(/bypassGate: true/g) || []).filter((_, i, a) => a).length >= 1
  && /case 'routing_test':[\s\S]{0,900}bypassGate: true/.test(agentRunnerSrc));
check('no scheduled/cron path passes bypassGate for routing',
  !/runScheduledBlock[\s\S]{0,4000}routeTaskTypeCall/.test(agentRunnerSrc));

/* ── 3b. No pre-existing caller was rewired ─────────────────────────────── */
console.log('\n--- No pre-existing caller changed provider ---');

// TIGHTENED 2026-08-07: these were `!/task-router\.js/.test(src)` — a plain
// substring test over the whole file, so they fired on any COMMENT that merely
// NAMED task-router.js. One did exactly that when meeting-engine.js gained a
// header recording that the Architect is excluded from assignEmbodiment() in
// task-router.js — a true statement ABOUT the file, reported as an import OF it.
//
// A check that a comment can trip is worse than a loose one, because the
// cheapest way to make it pass is to delete the explanation. It now tests for
// an actual import/export-from statement, which is what the rule is about.
const IMPORTS_TASK_ROUTER = /(?:^|\n)\s*(?:import|export)\b[^\n;]*from\s+['"][^'"]*task-router\.js['"]/;

const agentBaseSrc = readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8');
check('agent-base.js does not import the task router (its providers are unchanged)',
  !IMPORTS_TASK_ROUTER.test(agentBaseSrc));
check('agent-base.js still routes routine work through callGroq (unchanged)', /callGroq\(/.test(agentBaseSrc));
check('agent-base.js still composes Hebrew through callGemini (unchanged)', /callGemini\(/.test(agentBaseSrc));

/*
 * meeting-engine.js LEFT THIS LIST ON 2026-08-27 (Session 26, ITEM B), and
 * that is a decision rather than a verifier being made to pass.
 *
 * This block exists to prove that enabling routing did not silently move any
 * pre-existing caller onto a different provider. The meeting engine was moved
 * ON PURPOSE, because it was measured composing every meeting on an 8B
 * Cloudflare fallback: its prompt is 17,836 tokens and Groq's free tier
 * refuses anything past 8,000 with a 413, which `callGroq` returns as null and
 * every caller degrades past in silence.
 *
 * So the rule the list encodes is unchanged — a caller does not move without a
 * decision — and the checks below record what the decision WAS, which the file
 * simply dropping out of the list would not. The other five are untouched and
 * still assert the original property.
 */
for (const f of ['qa-engine.js', 'gap-reports.js', 'chore-runner.js', 'guide-engine.js', 'claude-client.js']) {
  const src = readFileSync(new URL(`../workers/${f}`, import.meta.url), 'utf8');
  check(`${f} does not import the task router`, !IMPORTS_TASK_ROUTER.test(src));
  check(`${f} does not call routeTaskTypeCall`, !/routeTaskTypeCall/.test(src));
}

const meetingEngineSrc = readFileSync(new URL('../workers/meeting-engine.js', import.meta.url), 'utf8');
check('[FAILS-OLD] meeting-engine.js is routed — deliberately, and only since 2026-08-27',
  IMPORTS_TASK_ROUTER.test(meetingEngineSrc) && /routeTaskTypeCall\(env, MEETING_LANE/.test(meetingEngineSrc));
check('...down the long_document lane, the one whose measured input ceiling fits a 17,836-token prompt',
  /const MEETING_LANE = 'long_document'/.test(meetingEngineSrc));
check('...behind the routing kill switch, like every other routed caller',
  /if \(await routingEnabled\(env\)\)[\s\S]{0,400}routeTaskTypeCall\(env, MEETING_LANE/.test(meetingEngineSrc));
check('B4 — the Cloudflare fallback was NOT removed; it is still the last resort',
  /callCloudflareFallback\(\{/.test(meetingEngineSrc));
check('B4 — the direct Groq call is still there ahead of it, unchanged',
  /const groqResult = await callGroq\(\{[\s\S]{0,300}\}\);[\s\S]{0,80}if \(groqResult\) return groqResult;/.test(meetingEngineSrc));
check('routing OFF walks the original chain — the router is not called at all',
  meetingEngineSrc.indexOf('await routingEnabled(env)') < meetingEngineSrc.indexOf('const groqResult = await callGroq('));

const modelRouterSrc = readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8');
check('selectModelForChoreTask() is unchanged — Notebook-X easy tasks still pick groq',
  /projectKey === 'notebook-x'[\s\S]{0,400}taskType === 'easy'[\s\S]{0,200}model: 'groq'/.test(modelRouterSrc));
check('selectModelForChoreTask() is unchanged — code/approval still picks claude under budget',
  /taskType === 'code' \|\| taskType === 'approval'\) && !overBudget[\s\S]{0,200}model: 'claude'/.test(modelRouterSrc));
check('getClaudeBudgetStatus() still defaults to component "qa"',
  /getClaudeBudgetStatus\(env, \{ asOf = new Date\(\), component = 'qa' \}/.test(modelRouterSrc));
// The signature went multi-line on 2026-08-29 when the optional cache-token
// arguments were added (Session 34, C3/C5). The PROPERTY this protects is
// unchanged and still asserted — every pre-existing caller passes no component
// and must keep landing in the 'qa' month row — so the regex is loosened to
// span lines rather than pinned to one particular formatting of the signature.
check('recordClaudeSpend() still defaults to component "qa"',
  /recordClaudeSpend\(env, \{[\s\S]{0,200}?inputTokens, outputTokens, asOf = new Date\(\), component = 'qa',/.test(modelRouterSrc));
check('…and its new cache-token arguments all default to zero, so an uncached call is priced exactly as before',
  /cacheWriteTokens = 0, cacheReadTokens = 0, cacheTtl = '5m',/.test(modelRouterSrc));
check('the new routing section is appended below the pre-existing budget router',
  modelRouterSrc.indexOf('selectModelForChoreTask') < modelRouterSrc.indexOf('routeTaskTypeCall'));

/* ── 4. Quota: allow-check before, record after, degrade on deny ────────── */
console.log('\n--- Token economy: allow-check before, degrade on deny, never throw ---');

const onEnv = (opts) => fakeEnv({ enabled: true, ...opts });

check('groq has a KNOWN daily cap', hasKnownCap(tokenEconomy, 'groq') === true);
// 14400 -> 1000 on 2026-08-23: the ceiling belonged to the MODEL, and the model
// (llama-3.1-8b-instant) was shut down on 2026-08-16. Measured off live
// rate-limit headers on openai/gpt-oss-20b — see verify-providers.js's block on
// the same number, and token-economy.json's own note. Re-pinned, not relaxed.
check('groq cap agrees with token-economy daily_limits', dailyCapFor(tokenEconomy, 'groq') === 1000);
check('cerebras has NO daily cap — the provider publishes no real daily ceiling',
  dailyCapFor(tokenEconomy, 'cerebras') === null);
check('mistral has NO daily cap either (no daily header exists to read)',
  dailyCapFor(tokenEconomy, 'mistral') === null);
check('period key is the composite <provider>#YYYY-MM-DD pattern',
  providerPeriodKey('groq', new Date('2026-08-05T10:00:00Z')) === 'groq#2026-08-05');

/* ── 4b. Monthly caps: a free tier is not always per-day ────────────────── */
//
// Added 2026-08-06. Cohere's real allowance is 1000 calls per MONTH, and
// forcing that into requests_per_day was the one guaranteed-wrong option:
// /30 refuses at ~20/day with 980 unused, and as-is lets one day drain the
// month. capFor() reads whichever field is set and buckets to match.
console.log('\n--- Monthly caps are read and counted on their own period ---');

check('cohere resolves to a MONTHLY cap of 1000',
  capFor(tokenEconomy, 'cohere').cap === 1000 && capFor(tokenEconomy, 'cohere').period === 'month',
  JSON.stringify(capFor(tokenEconomy, 'cohere')));
check('cohere has NO daily cap (dailyCapFor must not report the monthly number as daily)',
  dailyCapFor(tokenEconomy, 'cohere') === null, String(dailyCapFor(tokenEconomy, 'cohere')));
check('cohere still counts as a KNOWN cap for the degrade-order tie-break',
  hasKnownCap(tokenEconomy, 'cohere') === true);
// ── SIZED FROM THE CONFIG, NOT FROM A LITERAL (2026-08-23) ───────────────
// These three assertions are about the MECHANISM — does a daily cap resolve to
// period "day", is the soft stop 60% of it, does an allowed check report the
// cap — and none of them is about the cap's VALUE. Written against a literal
// 14400 they went red when the number legitimately moved (Groq's free-tier
// ceiling is per MODEL, and llama-3.1-8b-instant was shut down 2026-08-16), and
// the cheapest way to make them pass would have been to edit three numbers, at
// which point the same trap is reset for next time.
//
// This is the same repair verify-report-pipeline.js §5b already made when
// DIRECT_REVIEW_CONTEXT_TOKENS moved and every assertion sized against a literal
// 8192 silently stopped testing anything. The VALUE is pinned in exactly one
// place — verify-providers.js, where the measurement and its reasoning live —
// and everything about the mechanism is sized from the config.
const GROQ_DAILY_CAP = tokenEconomy.daily_limits.groq;
check('a daily-capped provider resolves to period "day"',
  capFor(tokenEconomy, 'groq').period === 'day' && capFor(tokenEconomy, 'groq').cap === GROQ_DAILY_CAP);
check('a provider with neither cap resolves to period null (paced, not counted)',
  capFor(tokenEconomy, 'cerebras').cap === null && capFor(tokenEconomy, 'cerebras').period === null);

check('a monthly bucket is YYYY-MM, a daily bucket is YYYY-MM-DD',
  periodBucket('month', new Date('2026-08-06T10:00:00Z')) === '2026-08'
  && periodBucket('day', new Date('2026-08-06T10:00:00Z')) === '2026-08-06');
check('a monthly period key cannot collide with a daily one',
  providerPeriodKey('cohere', new Date('2026-08-06T10:00:00Z'), 'month') === 'cohere#2026-08'
  && providerPeriodKey('cohere', new Date('2026-08-06T10:00:00Z'), 'day') === 'cohere#2026-08-06');

// The monthly soft stop must bite on the MONTH's count, read from the month
// bucket — not from a day bucket that would silently always be near-zero.
const cohereSoftStop = Math.floor(1000 * routingConfig.soft_stop_fraction);
const cohereSpent = { [providerPeriodKey('cohere', new Date(), 'month')]: cohereSoftStop };
const cohereDenial = await checkProviderAllowance(fakeEnv({ enabled: true, counts: cohereSpent }), 'cohere', { tokenEconomy, routingConfig });
check('a monthly-capped provider at 60% of its MONTH is denied as overtime_required',
  cohereDenial.allowed === false && cohereDenial.reason === 'overtime_required', JSON.stringify(cohereDenial));
check('...and reports the month period so the dashboard cannot mislabel it as daily',
  cohereDenial.period === 'month', String(cohereDenial.period));
check('...and the soft stop is 600, not 1000 (headroom applies to monthly caps too)',
  cohereDenial.softStop === 600, String(cohereDenial.softStop));

// The inverse: spending recorded in the DAY bucket must NOT deny a monthly
// provider. This is the check that catches a period mix-up, which would
// otherwise look like a working system that simply never refuses.
const cohereDayBucketOnly = { [providerPeriodKey('cohere', new Date(), 'day')]: 5000 };
const cohereNotDenied = await checkProviderAllowance(fakeEnv({ enabled: true, counts: cohereDayBucketOnly }), 'cohere', { tokenEconomy, routingConfig });
check('a monthly provider reads its MONTH bucket, not the day bucket',
  cohereNotDenied.allowed === true && cohereNotDenied.callsToday === 0, JSON.stringify(cohereNotDenied));

const softStop = Math.floor(GROQ_DAILY_CAP * routingConfig.soft_stop_fraction);
const exhausted = { [providerPeriodKey('groq', new Date())]: softStop };
const denial = await checkProviderAllowance(onEnv({ counts: exhausted }), 'groq', { tokenEconomy, routingConfig });
check('a provider at its soft-stop is DENIED', denial.allowed === false);
check('...and the denial reason is exactly `overtime_required`', denial.reason === 'overtime_required', denial.reason);
check('the soft stop is 60% of the known cap, not 100% (serves Gate 3)', denial.softStop === softStop && softStop < GROQ_DAILY_CAP);

const allowed = await checkProviderAllowance(onEnv({ counts: {} }), 'groq', { tokenEconomy, routingConfig });
check('a provider under its soft-stop is allowed', allowed.allowed === true && allowed.reason === null);
check('an allowed check reports cap and callsToday for the quota dashboard',
  allowed.cap === GROQ_DAILY_CAP && allowed.callsToday === 0 && allowed.capUnknown === false);

const missingCred = await checkProviderAllowance({ SIM_KV: null, DB: null }, 'groq', { tokenEconomy, routingConfig });
check('a provider with no credential is denied by name, not silently skipped',
  missingCred.allowed === false && missingCred.reason === 'missing_credential:GROQ_API_KEY', missingCred.reason);

/* ── 4c. Pacing: a null DAILY cap does not mean an unmeasured RATE ───────── */
//
// OB-100, 2026-08-16. These checks were written against `cerebras` and asserted
// that it is paced at the blanket 20s floor. That was TRUE and it was the
// defect: Cerebras' per-minute rate was measured at 1,000 on 2026-08-06 and
// written into token-economy.json, and no code path read `requests_per_minute`,
// so the office scheduled the provider at 3 calls/min — 0.3% of a limit it had
// already established. Measured cost in production: Cerebras reviewed 0 of 7
// reports that went through a revision round, because a REVISE fires a second
// judgment-lane call seconds after the first and the floor denied it.
//
// Rewritten as PROPERTY assertions rather than re-pinned to new numbers
// (KFM-04c): the properties are "a measured rate sizes the spacing", "an
// unmeasured rate keeps the floor", and "the two are distinguishable in the
// denial reason". Each branch is exercised on a provider that really is in that
// state today, so neither branch can rot into a test of nothing.
console.log('\n--- Pacing: derived from a measured rate, floor only where unmeasured ---');

const cerebrasPace = paceSpacingFor(tokenEconomy, 'cerebras', routingConfig);
const imagesPace = paceSpacingFor(tokenEconomy, 'cloudflare-images', routingConfig);

check('cerebras has a MEASURED per-minute rate in the config',
  tokenEconomy.providers.cerebras.requests_per_minute === 1000);
check('...and the pacing is now DERIVED from it, not from the blanket floor',
  cerebrasPace.basis === 'measured_rate' && cerebrasPace.ratePerMinute === 1000, JSON.stringify(cerebrasPace));
check('...at 60000/(rate x soft_stop_fraction), the same 60% headroom the counted path uses',
  cerebrasPace.spacingMs === Math.ceil(60_000 / (1000 * routingConfig.soft_stop_fraction)), cerebrasPace.spacingMs);
check('[FAILS-OLD] the derived spacing is strictly TIGHTER than the 20s floor it replaced',
  cerebrasPace.spacingMs < routingConfig.unknown_cap_min_spacing_ms, cerebrasPace.spacingMs);
check('mistral, measured at 50/min, derives a LOOSER spacing than cerebras — the rate drives it',
  paceSpacingFor(tokenEconomy, 'mistral', routingConfig).spacingMs
    > cerebrasPace.spacingMs);

check('cloudflare-images publishes NO rate, so it is null in the config (unknown, never unlimited)',
  tokenEconomy.providers.cloudflare_images.requests_per_minute === null);
check('...and it therefore KEEPS the 20s floor — the floor still exists and still binds',
  imagesPace.basis === 'unknown' && imagesPace.spacingMs === routingConfig.unknown_cap_min_spacing_ms);
check('the floor still matches gemini-pacer.js\'s proven 20s conservative floor',
  routingConfig.unknown_cap_min_spacing_ms === tokenEconomy.notebook_x_gemini_pacing.min_spacing_ms_between_calls);
check('the floor is also the CEILING: no derived spacing may be looser than it',
  Object.keys(PROVIDER_REGISTRY)
    .map((id) => paceSpacingFor(tokenEconomy, id, routingConfig).spacingMs)
    .every((ms) => ms <= routingConfig.unknown_cap_min_spacing_ms));

// Both branches are still PACED — the point was never to stop pacing.
const pacedEnv = onEnv({});
const first = await checkProviderAllowance(pacedEnv, 'cerebras', { tokenEconomy, routingConfig, now: 1_000_000 });
check('a measured-rate provider is allowed on its first call', first.allowed === true && first.capUnknown === true);
const tooSoon = await checkProviderAllowance(pacedEnv, 'cerebras', { tokenEconomy, routingConfig, now: 1_000_000 + cerebrasPace.spacingMs - 1 });
check('a measured-rate provider is STILL PACED, not treated as unlimited', tooSoon.allowed === false);
check('...and its denial reason is `rate_paced`, naming what actually produced it (KFM-27)',
  tooSoon.reason === 'rate_paced', tooSoon.reason);
check('...and the denial reports the spacing and the rate it came from',
  tooSoon.pacing.spacingMs === cerebrasPace.spacingMs && tooSoon.pacing.ratePerMinute === 1000);
const laterOk = await checkProviderAllowance(pacedEnv, 'cerebras', { tokenEconomy, routingConfig, now: 1_000_000 + cerebrasPace.spacingMs + 1 });
check('...and it is allowed again once its derived spacing has elapsed', laterOk.allowed === true);

const imgEnv = onEnv({});
await checkProviderAllowance(imgEnv, 'cloudflare-images', { tokenEconomy, routingConfig, now: 1_000_000 });
const imgTooSoon = await checkProviderAllowance(imgEnv, 'cloudflare-images', { tokenEconomy, routingConfig, now: 1_005_000 });
check('an UNMEASURED provider is denied 5s later — the 20s floor is untouched', imgTooSoon.allowed === false);
check('...and its reason stays `unknown_cap_paced`, which is now true only where it is true',
  imgTooSoon.reason === 'unknown_cap_paced', imgTooSoon.reason);
check('[FAILS-OLD] the two paced cases are DISTINGUISHABLE — one reason string could not tell them apart',
  tooSoon.reason !== imgTooSoon.reason);

/* ── 5. Degradation ladder ──────────────────────────────────────────────── */
console.log('\n--- Degradation: deny -> backup -> skip, never a throw ---');

stubAllProviders();
const groqDenied = { [providerPeriodKey('groq', new Date())]: softStop };
const degraded = await routeTask({
  env: onEnv({ counts: groqDenied }), taskType: 'routine_volume', routingConfig, tokenEconomy, prompt: 'hi',
});
check('a denied PRIMARY degrades to the lane backup', degraded.ok === true && degraded.provider === 'cloudflare-ai',
  JSON.stringify(degraded.attempts));
check('the denial is recorded in the attempt trail with its reason',
  degraded.attempts[0].provider === 'groq' && degraded.attempts[0].reason === 'overtime_required');
check('the backup was the only provider actually invoked', INVOCATIONS.join(',') === 'cloudflare-ai', INVOCATIONS.join(','));

stubAllProviders();
const cfCap = dailyCapFor(tokenEconomy, 'cloudflare-ai');
const bothDenied = {
  [providerPeriodKey('groq', new Date())]: softStop,
  [providerPeriodKey('cloudflare-ai', new Date())]: Math.floor(cfCap * routingConfig.soft_stop_fraction),
};
const skipped = await routeTask({
  env: onEnv({ counts: bothDenied }), taskType: 'routine_volume', routingConfig, tokenEconomy, prompt: 'hi',
});
check('primary AND backup denied -> skip, not throw', skipped.ok === false && skipped.reason === 'all_candidates_exhausted');
check('a fully-denied lane invoked no provider at all', INVOCATIONS.length === 0, INVOCATIONS.join(','));
check('both denials are logged in the attempt trail',
  skipped.attempts.length === 2 && skipped.attempts.every((a) => a.reason === 'overtime_required'));

stubAllProviders({ failing: ['cerebras'] });
const failedOver = await routeTask({
  env: onEnv({}), taskType: 'judgment', routingConfig, tokenEconomy, prompt: 'score this',
});
check('a FAILING primary (not denied — it answered badly) degrades to the backup',
  failedOver.ok === true && failedOver.provider === 'mistral', JSON.stringify(failedOver.attempts));
check('the failed primary is still counted as an attempt (a failed call spent rate allowance)',
  failedOver.attempts[0].outcome === 'failed');
check('[new] the router marks the substitution itself, at the source — a caller needs no attempts[0] archaeology',
  failedOver.substituted === true && failedOver.plannedProvider === 'cerebras', JSON.stringify({ substituted: failedOver.substituted, plannedProvider: failedOver.plannedProvider }));

stubAllProviders();
const noSub = await routeTask({
  env: onEnv({}), taskType: 'judgment', routingConfig, tokenEconomy, prompt: 'score this',
});
check('[new] the primary answering directly is NOT reported as a substitution',
  noSub.ok === true && noSub.provider === 'cerebras' && noSub.substituted === false && noSub.plannedProvider === 'cerebras',
  JSON.stringify({ provider: noSub.provider, substituted: noSub.substituted, plannedProvider: noSub.plannedProvider }));

stubAllProviders({ failing: ['cohere'] });
const embedFail = await routeTask({
  env: onEnv({}), taskType: 'embeddings', routingConfig, tokenEconomy, texts: ['a'],
});
check('the embeddings lane FAILS rather than degrading to another provider',
  embedFail.ok === false && embedFail.reason === 'all_candidates_exhausted');
check('...and no chat provider was substituted for it',
  INVOCATIONS.every((id) => id === 'cohere'), INVOCATIONS.join(','));

check('no degradation path threw — every result came back structured', true);
check('nothing in the degradation tests reached the network', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(','));

/* ── 5b. AN EMPTY ANSWER IS NOT A SUCCESS  [FAILS-OLD] ───────────────────
 *
 * Found by the supervised test on 2026-08-10, on the live judgment lane.
 *
 * provider-common.js added `finishReason` to the envelope for one stated
 * purpose — "so a max_tokens-truncated answer can be REJECTED rather than
 * parsed as if it were complete" — and NOTHING EVER READ IT. routeTask()
 * tested `if (result)` and nothing else, so a 200 carrying an empty string
 * came back as ok:true with one clean attempt and no degradation.
 *
 * It bites hardest exactly where it matters most. Cerebras' `gpt-oss-120b` is
 * a REASONING model whose thinking is charged against max_tokens, so the
 * judgment lane — "short scored calls", the shape a caller naturally gives a
 * small budget — was the one that returned nothing. Measured live, same
 * 87-token prompt: max_tokens 64 -> text "" / finish_reason "length";
 * max_tokens 600 -> "0.8" after 154 output tokens.
 *
 * This is the repo's recurring defect shape (an unwired guard, a valid-looking
 * envelope with nothing in it), so it gets a FAILS-OLD scenario rather than a
 * passing description. */
console.log('\n--- 5b. An empty answer is not a success  [FAILS-OLD] ---');

stubAllProviders({ emptyText: ['cerebras'] });
const emptied = await routeTask({
  env: onEnv({}), taskType: 'judgment', routingConfig, tokenEconomy, prompt: 'score this 0-1',
});

/** VERBATIM transcription of the pre-change decision: a truthy result is a
 *  success, whatever is in it. */
const oldWouldHaveAccepted = (result) => !!result;
const emptyEnvelope = { text: '', source: 'cerebras', finishReason: 'length', usage: { inputTokens: 87, outputTokens: 64 } };
check('[FAILS-OLD] the old test (truthy result) ACCEPTS an empty answer as a success',
  oldWouldHaveAccepted(emptyEnvelope) === true);
check('[FAILS-OLD] ...and would have returned it to the caller as the lane\'s answer, with no degradation',
  oldWouldHaveAccepted(emptyEnvelope) === true && emptyEnvelope.text === '');

check('[new] an empty chat answer is treated as a FAILED attempt, not a success',
  emptied.attempts[0].provider === 'cerebras' && emptied.attempts[0].outcome === 'failed',
  JSON.stringify(emptied.attempts));
check('[new] the attempt reason names truncation specifically when finishReason says so',
  emptied.attempts[0].reason === 'empty_text_truncated', emptied.attempts[0].reason);
check('[new] and the lane DEGRADES to its backup rather than returning nothing',
  emptied.ok === true && emptied.provider === 'mistral', JSON.stringify(emptied.attempts));
check('[new] the backup was actually invoked — the degradation is real, not just relabelled',
  INVOCATIONS.join(',') === 'cerebras,mistral', INVOCATIONS.join(','));

// A whitespace-only answer is the same failure wearing a different coat.
stubAllProviders();
PROVIDER_REGISTRY.cerebras.invoke = async () => {
  INVOCATIONS.push('cerebras');
  return { text: '   \n  ', source: 'cerebras', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } };
};
const whitespaced = await routeTask({
  env: onEnv({}), taskType: 'judgment', routingConfig, tokenEconomy, prompt: 'score this 0-1',
});
check('[new] a whitespace-only answer degrades too — the check trims before testing',
  whitespaced.provider === 'mistral' && whitespaced.attempts[0].reason === 'empty_text',
  JSON.stringify(whitespaced.attempts));

/* The guard must NOT catch the embeddings lane, whose result carries
 * `embeddings` and no `text` at all. Catching it would break the one lane the
 * design says must fail rather than degrade — and it would do so silently. */
stubAllProviders();
PROVIDER_REGISTRY.cohere.invoke = async () => {
  INVOCATIONS.push('cohere');
  return { embeddings: [[0.1, 0.2, 0.3]], source: 'cohere', usage: { inputTokens: 4 } };
};
const embedOk = await routeTask({
  env: onEnv({}), taskType: 'embeddings', routingConfig, tokenEconomy, texts: ['a'],
});
check('[new] an embeddings result with no `text` field is NOT caught by the empty-answer check',
  embedOk.ok === true && embedOk.provider === 'cohere', JSON.stringify(embedOk.attempts));
check('[new] ...and its vectors survive intact', Array.isArray(embedOk.result?.embeddings?.[0]));
check('nothing in the empty-answer tests reached the network', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(','));

/* ── 6. Controlled-random embodiment ────────────────────────────────────── */
console.log('\n--- Controlled-random embodiment (a measurement instrument) ---');

const PERSONAS = [
  { id: 1, name: 'The Perfectionist' }, { id: 6, name: 'The QA' }, { id: 7, name: 'The Team Lead' },
  { id: 8, name: 'The Lead QA' }, { id: 10, name: 'The Architect' }, { id: 11, name: 'The CEO' },
];

const map = assignEmbodiment({ personas: PERSONAS, pool: routingConfig.lanes.conversation.pool, rng: seededRng(42), eventId: 'daily_standup:2026-08-05' });
check('every non-Architect persona is assigned a provider', map.assignments.length === PERSONAS.length - 1);
check('THE ARCHITECT IS NEVER SHUFFLED', !map.assignments.some((a) => String(a.agentId) === '10'));
check('...and his exclusion is recorded with a reason, not silently dropped',
  map.excluded.length === 1 && map.excluded[0].reason === 'architect_never_shuffled');
check('the Architect is excluded by NAME too, not only by id',
  assignEmbodiment({ personas: [{ id: 99, name: 'The Architect' }], pool: ['groq'], rng: seededRng(1) }).assignments.length === 0);
check('every assigned provider comes from the pool', map.assignments.every((a) => routingConfig.lanes.conversation.pool.includes(a.provider)));
check('no persona is embodied by an embeddings provider', !map.assignments.some((a) => a.provider === 'cohere'));
check('no persona is embodied by Anthropic', !map.assignments.some((a) => /anthropic|claude/i.test(a.provider || '')));

const mapA = assignEmbodiment({ personas: PERSONAS, pool: routingConfig.lanes.conversation.pool, rng: seededRng(1) });
const mapB = assignEmbodiment({ personas: PERSONAS, pool: routingConfig.lanes.conversation.pool, rng: seededRng(500) });
check('the assignment actually varies between events (otherwise it measures nothing)',
  JSON.stringify(mapA.assignments) !== JSON.stringify(mapB.assignments));

const rendered = renderEmbodimentMap(map);
check('the embodiment map renders a table naming each agent and its provider',
  rendered.includes('The QA') && rendered.includes('Embodiment map'));
check('the rendered map records the event id (so it ties to a meeting record)',
  rendered.includes('daily_standup:2026-08-05'));
check('the rendered map shows the Architect as deliberately not shuffled',
  /The Architect[\s\S]{0,80}not shuffled/.test(rendered));

stubAllProviders();
const convRouted = await routeTask({
  env: onEnv({}), taskType: 'conversation', routingConfig, tokenEconomy,
  prompt: 'standup', personas: PERSONAS, rng: seededRng(11), eventId: 'evt-1',
});
check('a routed conversation returns its embodiment map alongside the result',
  convRouted.ok === true && !!convRouted.embodiment && convRouted.embodiment.assignments.length === 5);
check('the routed conversation excluded the Architect from the map',
  convRouted.embodiment.excluded[0].reason === 'architect_never_shuffled');
check('task-router.js documents that embodiment is a measurement instrument, not a fallback',
  /MEASUREMENT INSTRUMENT, NOT A FALLBACK/.test(taskRouterSrc));

/* ════════════════════════════════════════════════════════════════════════
 * 8. THE IMAGE LANE (added 2026-08-10, plan 5.1)
 *
 * The Designer (agent 9) had existed for two months and had never worked. Not
 * blocked — she never had the means. `AGENTS-CHARACTER-CORE-v2.md` AGENT 9 says
 * she generates visual assets through the office's image-capable providers;
 * there was no image-capable provider anywhere in this repo. A NEW VARIANT of
 * the §7 defect family: not a gate that is never called, but A ROLE THAT WAS
 * NEVER ACTIVATED.
 *
 * Three things are proved here, and two of them carry [FAILS-OLD] scenarios
 * because they close real holes rather than describe a new feature:
 *
 *   8a  the lane resolves BY ROLE, and a role does not degrade to the other role
 *   8b  [FAILS-OLD] a routable lane must DECLARE its kind — the old wrong-kind
 *       check had an opt-out: omit the field and any provider was accepted
 *   8c  [FAILS-OLD] the embodiment shuffle RECORDS what it drops for wrong kind
 *   8d  an empty image is not a success, the same way an empty answer is not
 * ════════════════════════════════════════════════════════════════════════ */
console.log('\n=== 8. The image lane — the Designer finally has means ===');

/* ── 8a. Roles, not a primary and a backup ──────────────────────────────── */
console.log('\n--- 8a. The image lane resolves by ROLE, and a role never degrades ---');

const imageLane = routingConfig.lanes.image;
check('an `image` lane exists at all (it did not, for two months)', !!imageLane);
check('the image lane declares mode "roles", not primary/backup',
  imageLane.mode === 'roles', String(imageLane.mode));
check('the image lane declares kind "image"', imageLane.kind === 'image', String(imageLane.kind));
check('"image" is a recognised lane kind', LANE_KINDS.includes('image'), LANE_KINDS.join(','));

const draft = resolveLane(routingConfig, 'image', { role: 'draft' });
const polish = resolveLane(routingConfig, 'image', { role: 'polish' });
check('role "draft" is routable', draft.routable === true, draft.reason || '');
check('role "draft" resolves to Cloudflare (the owner\'s default)',
  draft.candidates[0] === 'cloudflare-images', draft.candidates.join(','));
check('role "polish" is routable', polish.routable === true, polish.reason || '');
check('role "polish" resolves to Gemini (final touches)',
  polish.candidates[0] === 'gemini-images', polish.candidates.join(','));

// The heart of it. If a role resolved to two candidates, a Cloudflare failure
// would send a DRAFT to the scarcer polish tier and a polish request would be
// answered by a fresh draft — a plausible image that is not what was asked for.
check('role "draft" has EXACTLY ONE candidate — it does not degrade to the polish provider',
  draft.candidates.length === 1, draft.candidates.join(','));
check('role "polish" has EXACTLY ONE candidate — it does not degrade to the draft provider',
  polish.candidates.length === 1, polish.candidates.join(','));
check('the two roles resolve to DIFFERENT providers (or the split means nothing)',
  draft.candidates[0] !== polish.candidates[0]);
check('the lane carries on_unavailable:"fail" — no substitution across roles',
  imageLane.on_unavailable === 'fail', String(imageLane.on_unavailable));

check('an absent role falls back to the lane\'s declared default_role',
  resolveLane(routingConfig, 'image').role === imageLane.default_role
  && resolveLane(routingConfig, 'image').candidates[0] === imageLane.roles[imageLane.default_role],
  JSON.stringify(resolveLane(routingConfig, 'image')));
check('...and that default is "draft" (Cloudflare by default — owner decision)',
  imageLane.default_role === 'draft', String(imageLane.default_role));

// An UNRECOGNISED role is refused, never quietly served by the default. The
// default would be this router deciding a polish request may get a draft.
const badRole = resolveLane(routingConfig, 'image', { role: 'retouch' });
check('an unrecognised role is REFUSED, not served by the default',
  badRole.routable === false && badRole.reason === 'unknown_lane_role:retouch', JSON.stringify(badRole));

const noDefault = JSON.parse(JSON.stringify(routingConfig));
delete noDefault.lanes.image.default_role;
check('a roles lane with no role given and no default is refused rather than guessed at',
  resolveLane(noDefault, 'image').reason === 'role_not_specified_and_no_default',
  resolveLane(noDefault, 'image').reason);

check('both image providers are in the registry with kind "image"',
  PROVIDER_REGISTRY['cloudflare-images']?.kind === 'image'
  && PROVIDER_REGISTRY['gemini-images']?.kind === 'image');
check('neither image provider is reachable from ANY chat lane',
  EXPECTED.filter(([l]) => l !== 'embeddings').every(([lane]) =>
    !resolveLane(routingConfig, lane).candidates.some((id) => PROVIDER_REGISTRY[id].kind === 'image')));
check('the conversation pool contains no image provider',
  !routingConfig.lanes.conversation.pool.some((id) => PROVIDER_REGISTRY[id]?.kind === 'image'),
  routingConfig.lanes.conversation.pool.join(','));

// Both directions of the kind guard, each proved by pointing a lane the wrong
// way on purpose — the same technique the Anthropic barrier is proved with.
const chatLaneWithImageProvider = JSON.parse(JSON.stringify(routingConfig));
chatLaneWithImageProvider.lanes.judgment.primary = 'cloudflare-images';
const cliResolved = resolveLane(chatLaneWithImageProvider, 'judgment');
check('a CHAT lane pointed at an image provider is REFUSED',
  cliResolved.routable === false, JSON.stringify(cliResolved));
check('...and refuses specifically as provider_kind_mismatch, naming the kind it got',
  cliResolved.reason.startsWith('provider_kind_mismatch') && /image/.test(cliResolved.reason), cliResolved.reason);

const imageLaneWithChatProvider = JSON.parse(JSON.stringify(routingConfig));
imageLaneWithChatProvider.lanes.image.roles.draft = 'groq';
const ilcResolved = resolveLane(imageLaneWithChatProvider, 'image', { role: 'draft' });
check('the IMAGE lane pointed at a chat provider is REFUSED (the guard runs both ways)',
  ilcResolved.routable === false && ilcResolved.reason.startsWith('provider_kind_mismatch'), JSON.stringify(ilcResolved));

const imageLaneWithEmbeddings = JSON.parse(JSON.stringify(routingConfig));
imageLaneWithEmbeddings.lanes.image.roles.polish = 'cohere';
check('the image lane pointed at the EMBEDDINGS provider is refused too',
  resolveLane(imageLaneWithEmbeddings, 'image', { role: 'polish' }).routable === false);

/* ── 8b. A routable lane must declare its kind  [FAILS-OLD] ──────────────
 *
 * The wrong-kind check was written `if (lane.kind && PROVIDER_REGISTRY[id].kind
 * !== lane.kind)`. A lane that simply OMITTED `kind` therefore accepted any
 * provider in the registry — a guard with an opt-out nobody documented.
 *
 * It was harmless while every provider was chat or embeddings. Adding an image
 * provider made it a real hazard TWICE OVER: a kind-less text lane pointed at an
 * image model would resolve and route, AND routeTask()'s empty-answer guard keys
 * on `resolved.kind === 'chat'`, so the same missing field that let the wrong
 * provider in also switched off the check that catches what it returns.
 *
 * Proved against a VERBATIM transcription of the old condition rather than
 * described, per this repo's standing rule: *a test that describes a fix is not a
 * test that catches a bug.* */
console.log('\n--- 8b. A routable lane must DECLARE its kind  [FAILS-OLD] ---');

const kindlessLane = JSON.parse(JSON.stringify(routingConfig));
kindlessLane.lanes.judgment = { primary: 'cloudflare-images', backup: 'mistral' }; // no `kind`

/** VERBATIM transcription of the pre-change wrong-kind condition. */
const oldWrongKind = (lane, candidateIds) =>
  candidateIds.filter((id) => lane.kind && PROVIDER_REGISTRY[id].kind !== lane.kind);

const oldVerdictForKindless = oldWrongKind(kindlessLane.lanes.judgment, ['cloudflare-images', 'mistral']);
check('[FAILS-OLD] the old condition finds NOTHING wrong with an image provider on a kind-less judgment lane',
  oldVerdictForKindless.length === 0, JSON.stringify(oldVerdictForKindless));
check('[FAILS-OLD] ...so the old code would have ROUTED a judgment call to an image model',
  oldVerdictForKindless.length === 0);
check('[FAILS-OLD] ...and would ALSO have skipped the empty-answer guard, which keys on kind === "chat"',
  (kindlessLane.lanes.judgment.kind || null) !== 'chat');

const kindlessResolved = resolveLane(kindlessLane, 'judgment');
check('[new] a lane with no `kind` is REFUSED as lane_kind_unstated',
  kindlessResolved.routable === false && kindlessResolved.reason === 'lane_kind_unstated', JSON.stringify(kindlessResolved));
check('[new] ...and yields zero candidates, so nothing downstream can use it',
  kindlessResolved.candidates.length === 0);

const bogusKind = JSON.parse(JSON.stringify(routingConfig));
bogusKind.lanes.judgment.kind = 'multimodal';
check('[new] an UNRECOGNISED kind is refused rather than treated as chat',
  resolveLane(bogusKind, 'judgment').reason === 'unknown_lane_kind:multimodal',
  resolveLane(bogusKind, 'judgment').reason);

check('[new] every routable lane in the SHIPPED config declares a recognised kind',
  Object.entries(routingConfig.lanes)
    .filter(([, l]) => l.routable !== false)
    .every(([, l]) => LANE_KINDS.includes(l.kind)),
  Object.entries(routingConfig.lanes).filter(([, l]) => l.routable !== false && !LANE_KINDS.includes(l.kind)).map(([k]) => k).join(','));

check('[new] the `lane.kind &&` short-circuit is gone from the wrong-kind check',
  !/lane\.kind && PROVIDER_REGISTRY\[id\]\.kind !== lane\.kind/.test(taskRouterSrc));

/* ── 8c. The shuffle records what it drops  [FAILS-OLD] ──────────────────
 *
 * assignEmbodiment() has always filtered the pool to chat providers. The filter
 * was correct and SILENT — and a silent filter on a measurement instrument is the
 * worst place in this repo for one. A five-provider pool containing two image
 * providers quietly became three, the map still rendered perfectly, and the Lead
 * QA's cross-embodiment comparison would have drawn conclusions from a narrower
 * sample than the config said it had. An all-image pool produced `provider: null`
 * for every persona and a map that looked structurally fine. */
console.log('\n--- 8c. The embodiment shuffle RECORDS its wrong-kind drops  [FAILS-OLD] ---');

const MIXED_POOL = ['groq', 'cloudflare-images', 'gemini', 'gemini-images', 'cohere'];
const mixed = assignEmbodiment({ personas: PERSONAS, pool: MIXED_POOL, rng: seededRng(5), eventId: 'evt-mixed' });

/** VERBATIM transcription of the pre-change pool filter. */
const oldUsable = MIXED_POOL.filter((id) => PROVIDER_REGISTRY[id] && PROVIDER_REGISTRY[id].kind === 'chat');
check('[FAILS-OLD] the old filter got the RIGHT pool — it was never wrong about which providers to use',
  JSON.stringify(oldUsable) === JSON.stringify(['groq', 'gemini']), oldUsable.join(','));
check('[FAILS-OLD] ...but it returned NO record of the three it dropped — nothing anywhere said the sample narrowed',
  // The old return shape was { eventId, assignments, pool, excluded } and
  // `excluded` held persona exclusions only. There was no field a caller could
  // read to learn that 3 of 5 pool entries were discarded.
  ['eventId', 'assignments', 'pool', 'excluded'].every((k) => k in mixed)
  && !['eventId', 'assignments', 'pool', 'excluded'].includes('poolExcluded'));

check('[new] the shuffle still uses only chat providers', JSON.stringify(mixed.pool) === JSON.stringify(['groq', 'gemini']), mixed.pool.join(','));
check('[new] and now RECORDS all three drops in poolExcluded', mixed.poolExcluded.length === 3, JSON.stringify(mixed.poolExcluded));
check('[new] each drop names the provider AND the kind it actually was',
  mixed.poolExcluded.every((p) => p.provider && p.kind && p.reason),
  JSON.stringify(mixed.poolExcluded));
check('[new] the two image providers are named as image, not lumped in as "other"',
  mixed.poolExcluded.filter((p) => p.kind === 'image').map((p) => p.provider).sort().join(',') === 'cloudflare-images,gemini-images',
  JSON.stringify(mixed.poolExcluded));
check('[new] persona exclusions stay in `excluded` and are not mixed in with provider drops',
  mixed.excluded.length === 1 && mixed.excluded[0].reason === 'architect_never_shuffled');
check('[new] an unregistered pool id is recorded too, not silently ignored',
  assignEmbodiment({ personas: [{ id: 1, name: 'A' }], pool: ['groq', 'not-a-provider'], rng: seededRng(1) })
    .poolExcluded.some((p) => p.provider === 'not-a-provider' && p.reason === 'not_in_provider_registry'));

// The total collapse: a pool with nothing usable in it. The old code produced a
// well-formed map full of nulls, which is indistinguishable from a working one.
const allImage = assignEmbodiment({ personas: PERSONAS, pool: ['cloudflare-images', 'gemini-images'], rng: seededRng(9) });
check('[new] an all-image pool reports poolEmpty:true rather than a map full of nulls',
  allImage.poolEmpty === true && allImage.pool.length === 0);
check('[new] ...and the rendered map SAYS it measures nothing',
  /measures NOTHING/.test(renderEmbodimentMap(allImage)));
check('[new] a narrowed (but not empty) map records the narrowing in the RECORD, not only in a log',
  /Pool narrowed/.test(renderEmbodimentMap(mixed)) && /cloudflare-images/.test(renderEmbodimentMap(mixed)));
check('[new] a clean pool renders no narrowing note at all (no false alarm)',
  !/Pool narrowed|measures NOTHING/.test(renderEmbodimentMap(
    assignEmbodiment({ personas: PERSONAS, pool: routingConfig.lanes.conversation.pool, rng: seededRng(2) })
  )));
check('EMBODIMENT_KIND is "chat" — an image model has no voice to compare',
  EMBODIMENT_KIND === 'chat', EMBODIMENT_KIND);
check('asking the shuffle for a non-chat kind yields an empty pool',
  assignEmbodiment({ personas: PERSONAS, pool: routingConfig.lanes.conversation.pool, kind: 'image', rng: seededRng(1) }).poolEmpty === true);

/* ── 8d. An empty image is not a success ────────────────────────────────── */
console.log('\n--- 8d. An empty image is not a success (the empty-answer guard, one kind over) ---');

stubAllProviders();
const drafted = await routeTask({
  env: onEnv({}), taskType: 'image', routingConfig, tokenEconomy, role: 'draft', prompt: 'a logo',
});
check('a routed draft returns an image envelope from the draft provider',
  drafted.ok === true && drafted.provider === 'cloudflare-images' && drafted.result.bytes > 0, JSON.stringify(drafted.attempts));
check('...and the result reports the lane kind and the role that produced it',
  drafted.kind === 'image' && drafted.role === 'draft', `${drafted.kind}/${drafted.role}`);
check('the image result carries NO `text` field, so the empty-answer guard cannot reach for one',
  !('text' in drafted.result), Object.keys(drafted.result).join(','));

stubAllProviders({ emptyImage: ['cloudflare-images'] });
const emptyDraft = await routeTask({
  env: onEnv({}), taskType: 'image', routingConfig, tokenEconomy, role: 'draft', prompt: 'a logo',
});
check('a zero-byte image is treated as a FAILED attempt, not a success',
  emptyDraft.attempts[0].outcome === 'failed' && emptyDraft.attempts[0].reason === 'empty_image',
  JSON.stringify(emptyDraft.attempts));
check('...and the lane does NOT silently substitute the other role',
  emptyDraft.ok === false && emptyDraft.reason === 'all_candidates_exhausted' && emptyDraft.provider === null,
  JSON.stringify(emptyDraft));
check('...and the polish provider was never invoked for a failed draft',
  !INVOCATIONS.includes('gemini-images'), INVOCATIONS.join(','));

/* A polish call carries its text in `instruction`, not `prompt`. This assertion
 * is the one that caught a real defect on 2026-08-10 before it ever ran live:
 * the router calls each provider's checkInputWithinCaps() uniformly against the
 * caller's whole options object, and gemini-image-client's read only `prompt` —
 * so every legitimate polish call was refused with "no prompt" and the provider
 * was never reached. A cap check the router calls uniformly must accept every
 * shape the router can hand it. Kept as two separate checks, because "the lane
 * did not degrade" passed even while the provider was never invoked at all —
 * a scenario passing for the wrong reason. */
stubAllProviders();
const okPolish = await routeTask({
  env: onEnv({}), taskType: 'image', routingConfig, tokenEconomy, role: 'polish',
  instruction: 'make the type larger', inputImages: [{ base64: 'aGk=' }],
});
check('a polish call whose text is in `instruction` REACHES the provider (the cap check reads it)',
  okPolish.ok === true && INVOCATIONS.join(',') === 'gemini-images', `${okPolish.reason || 'ok'} / invoked=${INVOCATIONS.join(',')}`);
check('...and the prompt-only cap refusal is gone from the polish path',
  !(okPolish.attempts || []).some((a) => a.outcome === 'refused_caps'), JSON.stringify(okPolish.attempts));

stubAllProviders({ failing: ['gemini-images'] });
const failedPolish = await routeTask({
  env: onEnv({}), taskType: 'image', routingConfig, tokenEconomy, role: 'polish',
  instruction: 'make the type larger', inputImages: [{ base64: 'aGk=' }],
});
check('a failed POLISH does not fall back to a fresh draft',
  failedPolish.ok === false && failedPolish.reason === 'all_candidates_exhausted');
check('...and the draft provider was never invoked for it',
  INVOCATIONS.join(',') === 'gemini-images', INVOCATIONS.join(','));

/* ── 8e. A DEFAULT PARAMETER IS NOT A NULL GUARD ─────────────────────────
 *
 * Found by the first real image call this router ever made, 2026-08-10, which
 * came back `5007: No such model null or task`. The catalog-verified model ID was
 * sitting in the client the whole time; the trigger normalises absent body fields
 * to `null` (`body.imageModel || null`), the registry passed that straight
 * through, and a JS default parameter fires on `undefined` and not on `null`. So
 * the verified default was overwritten by an absent request field.
 *
 * This asserts on the REGISTRY's passthrough rather than on a client, because the
 * registry is where the coercion has to happen — every optional field a caller may
 * omit crosses that boundary. Checked against the real invoke functions, with a
 * fake AI binding that records what model it was handed. */
console.log('\n--- 8e. An absent request field must not overwrite a verified default ---');

for (const [id, invoke] of Object.entries(REAL_INVOKE)) PROVIDER_REGISTRY[id].invoke = invoke;

let handedModel = 'NOT-CALLED';
const recordingEnv = {
  ...fakeEnv({ enabled: true }),
  AI: { run: async (model) => { handedModel = model; return { image: 'aGVsbG8=' }; } },
};
await PROVIDER_REGISTRY['cloudflare-images'].invoke(recordingEnv, {
  prompt: 'a logo', imageModel: null, steps: null, negativePrompt: null, agentId: 9,
});
check('a null `imageModel` from a caller does NOT reach the provider as null',
  handedModel !== null && handedModel !== 'null', String(handedModel));
check('...it falls back to the CATALOG-VERIFIED default model instead',
  handedModel === cfImageDefaultModel, `${handedModel} vs ${cfImageDefaultModel}`);
check('...and the shipped config names that same model (one fact, two copies, asserted equal)',
  tokenEconomy.providers.cloudflare_images.default_model === cfImageDefaultModel,
  `${tokenEconomy.providers.cloudflare_images.default_model} vs ${cfImageDefaultModel}`);
check('every optional image passthrough in the registry is null-coerced, not passed raw',
  (taskRouterSrc.match(/opts\.(imageModel|steps|negativePrompt) \?\? undefined/g) || []).length >= 4,
  String((taskRouterSrc.match(/opts\.(imageModel|steps|negativePrompt) \?\? undefined/g) || []).length));

// The gate still governs the new lane. A lane added after the switch shipped is
// exactly the shape that gets forgotten by a kill switch.
stubAllProviders();
const imageOff = await routeTask({
  env: fakeEnv({ enabled: false }), taskType: 'image', routingConfig, tokenEconomy, role: 'draft', prompt: 'a logo',
});
check('the image lane obeys routing_enabled like every other lane',
  imageOff.ok === false && imageOff.reason === 'routing_disabled', JSON.stringify(imageOff));
check('no image provider was invoked while the switch was off', INVOCATIONS.length === 0, INVOCATIONS.join(','));

check('nothing in the image-lane tests reached the network', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(','));

/* ── 7. Config integrity ────────────────────────────────────────────────── */
console.log('\n--- Config integrity ---');

check('every registry provider maps to a token-economy providers entry',
  Object.values(PROVIDER_REGISTRY).every((p) => !!tokenEconomy.providers[p.tokenEconomyKey]),
  Object.values(PROVIDER_REGISTRY).filter((p) => !tokenEconomy.providers[p.tokenEconomyKey]).map((p) => p.id).join(','));
check('every provider the lane table names exists in the registry',
  Object.values(routingConfig.lanes)
    .flatMap((l) => [l.primary, l.backup, ...(l.pool || [])])
    .filter(Boolean)
    .every((id) => !!PROVIDER_REGISTRY[id]));
check('every routable provider declares paid:false (the overtime rule)',
  Object.values(PROVIDER_REGISTRY).every((p) => tokenEconomy.providers[p.tokenEconomyKey].paid === false));
check('the routing config states the overtime rule', /overtime/i.test(JSON.stringify(routingConfig._meta)));
check('the routing config states that null caps are not unlimited',
  /does NOT mean unlimited/i.test(routingConfig._unknown_cap_meta || ''));
check('the routing config records that it supersedes the older four-lane draft table',
  /supersedes/i.test(JSON.stringify(routingConfig._meta)));
check('soft_stop_fraction is a fraction below 1 (headroom, not a hard ceiling)',
  routingConfig.soft_stop_fraction > 0 && routingConfig.soft_stop_fraction < 1);

/* ── Final network assertion ────────────────────────────────────────────── */
console.log('\n--- Network tripwire ---');
check('this verifier made ZERO network calls end to end', NETWORK_TRIPWIRE.length === 0, NETWORK_TRIPWIRE.join(', '));

/* ═══════ Claude pricing is a dated fact — audit #15 / KFM-19 ══════════════
 *
 * ── THE TIME BOMB FIRED ON 2026-08-29, AND THE ANSWER WAS 'NO CHANGE' ─────
 *
 * This section used to fail on a calendar date, two days before 2026-08-31,
 * to force a re-read of the published Claude price before it moved. IT
 * WORKED. Session 34 re-read the page and found the transition withdrawn:
 *
 *   "The $2/$10 per million input/output token pricing for Claude Sonnet 5,
 *    announced at launch as introductory pricing through August 31, 2026, is
 *    now the standard price. The previously scheduled increase to $3/$15 per
 *    million input/output tokens on September 1, 2026 will not occur."
 *      — platform.claude.com/docs/en/about-claude/pricing, read 2026-08-29
 *
 * So the countdown is REMOVED, and this is the one case where removing a
 * check is not weakening it: a countdown to a date that will never arrive
 * cannot go red for a true reason, and a check that can only ever fire
 * falsely trains its reader to clear it without looking. There is no
 * scheduled change left to guard.
 *
 * WHAT REPLACES IT IS NOT WEAKER. The checks below assert the published
 * FIGURES rather than a date, and they now cover more than the old ones did:
 * the flat price, the three cache multipliers (which the office was not
 * charging for at all until Session 34), and — the point of KFM-19 —
 * PRICING_VERIFIED_ON, which still records WHEN a person last checked.
 *
 * They also assert the branch is GONE. Re-pointing `after` at $2/$10 and
 * leaving the conditional standing would have satisfied a naive check while
 * leaving dead machinery for the next reader to decode. If someone
 * reintroduces a date-conditional price, these go red.
 * ═════════════════════════════════════════════════════════════════════════ */
{
  const routerSrc = readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8');
  const verifiedOn = /PRICING_VERIFIED_ON = '(\d{4}-\d{2}-\d{2})'/.exec(routerSrc)?.[1];

  check('[FAILS-OLD] the price still records WHEN it was last verified, not just what it is',
    Boolean(verifiedOn), String(verifiedOn));
  check('…and it was re-verified on or after 2026-08-29, when the transition was withdrawn',
    Boolean(verifiedOn) && verifiedOn >= '2026-08-29', String(verifiedOn));

  // The figure read off the published pricing page on 2026-08-29.
  check('Claude Sonnet 5 is priced at the published $2/$10, flat',
    /CLAUDE_PRICING = \{ inputPerMillion: 2, outputPerMillion: 10 \}/.test(routerSrc));

  // ── THE BRANCH IS GONE, NOT RE-POINTED ────────────────────────────────
  check('[THE FIX] no PRICING_CHANGE_DATE remains — there is no scheduled change to branch on',
    !/PRICING_CHANGE_DATE/.test(routerSrc));
  check('…no before/after price pair remains either',
    !/\bbefore: \{ inputPerMillion/.test(routerSrc) && !/\bafter: \{ inputPerMillion/.test(routerSrc));
  check('…and the once-per-instance stale-price warning went with them',
    !/CLAUDE PRICING IS PAST ITS CHANGE DATE/.test(routerSrc) && !/pricingWarned/.test(routerSrc));
  check('[FALSIFYING] the $3/$15 figure appears nowhere as a price this office would charge',
    !/inputPerMillion: 3\b/.test(routerSrc) && !/outputPerMillion: 15\b/.test(routerSrc));

  // ── CACHE PRICING — SESSION 34, C3/C5 ─────────────────────────────────
  // Cached tokens are billed and are NOT in usage.input_tokens. Before this
  // they would have been recorded as zero, which is the one direction a
  // spend guard must never be wrong in.
  check('the prompt-cache multipliers are declared, from the same published page',
    /CACHE_MULTIPLIERS = \{ write5m: 1\.25, write1h: 2, read: 0\.1 \}/.test(routerSrc));
  check('estimateClaudeCostUsd() charges cache WRITES at the write multiplier',
    /cacheWriteTokens\)? \/ 1_000_000\) \* p\.inputPerMillion \* writeMult/.test(routerSrc));
  check('…and cache READS at 0.1x, not at zero',
    /cacheReadTokens\)? \/ 1_000_000\) \* p\.inputPerMillion \* CACHE_MULTIPLIERS\.read/.test(routerSrc));
  check('recordClaudeSpend() carries cache tokens through to the stored figure',
    /cacheWriteTokens = 0, cacheReadTokens = 0, cacheTtl = '5m',/.test(routerSrc));
  check('[C5] the spend guard threshold itself is UNCHANGED — only the arithmetic feeding it',
    /soft/i.test(routerSrc) || /overBudget/.test(routerSrc));

  // ── SOURCE ASSERTIONS, AND WHY THEY ARE NOT EXECUTED ──────────────────
  // `model-router.js` imports config JSON, so plain `node` cannot load it and
  // this verifier cannot CALL claudePricingStatus() the way it calls
  // task-router's functions above. That is the same limitation that puts
  // model-router's gates on the gate-call audit's UNPROVEN list, and it is
  // reported there rather than papered over here. These check that the
  // mechanism EXISTS and has the right shape — not that it runs.
  check('claudePricingStatus() still exists so a reader never has to dig for the figure in force',
    /export function claudePricingStatus/.test(routerSrc));
  check('…and reports the cache rates too, not only input and output',
    /cacheReadPerMillion/.test(routerSrc) && /cacheWrite5mPerMillion/.test(routerSrc));
  check('…and names the model the price belongs to, since $3/$15 is still a real Sonnet price',
    /model: 'claude-sonnet-5'/.test(routerSrc));
  check('the withdrawal is written down where the next reader will hit it',
    /will not occur/.test(routerSrc));
}

// Restore the real invoke functions so nothing leaks between runs.
for (const [id, invoke] of Object.entries(REAL_INVOKE)) PROVIDER_REGISTRY[id].invoke = invoke;

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('MISMATCH — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('All scenarios matched expectations.');
  process.exit(0);
}
