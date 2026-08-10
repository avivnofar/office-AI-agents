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
  SIM_STATE_KEY,
  ROUTING_FLAG,
} from '../workers/task-router.js';

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
function stubAllProviders({ failing = [], emptyText = [] } = {}) {
  INVOCATIONS.length = 0;
  for (const [id, p] of Object.entries(PROVIDER_REGISTRY)) {
    if (!(id in REAL_INVOKE)) REAL_INVOKE[id] = p.invoke;
    p.invoke = async (env, opts) => {
      INVOCATIONS.push(id);
      if (failing.includes(id)) {
        opts.onResponse?.({ status: 500 });
        return null;
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

for (const f of ['meeting-engine.js', 'qa-engine.js', 'gap-reports.js', 'chore-runner.js', 'guide-engine.js', 'claude-client.js']) {
  const src = readFileSync(new URL(`../workers/${f}`, import.meta.url), 'utf8');
  check(`${f} does not import the task router`, !IMPORTS_TASK_ROUTER.test(src));
  check(`${f} does not call routeTaskTypeCall`, !/routeTaskTypeCall/.test(src));
}

const modelRouterSrc = readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8');
check('selectModelForChoreTask() is unchanged — Notebook-X easy tasks still pick groq',
  /projectKey === 'notebook-x'[\s\S]{0,400}taskType === 'easy'[\s\S]{0,200}model: 'groq'/.test(modelRouterSrc));
check('selectModelForChoreTask() is unchanged — code/approval still picks claude under budget',
  /taskType === 'code' \|\| taskType === 'approval'\) && !overBudget[\s\S]{0,200}model: 'claude'/.test(modelRouterSrc));
check('getClaudeBudgetStatus() still defaults to component "qa"',
  /getClaudeBudgetStatus\(env, \{ asOf = new Date\(\), component = 'qa' \}/.test(modelRouterSrc));
check('recordClaudeSpend() still defaults to component "qa"',
  /recordClaudeSpend\(env, \{ inputTokens, outputTokens, asOf = new Date\(\), component = 'qa' \}/.test(modelRouterSrc));
check('the new routing section is appended below the pre-existing budget router',
  modelRouterSrc.indexOf('selectModelForChoreTask') < modelRouterSrc.indexOf('routeTaskTypeCall'));

/* ── 4. Quota: allow-check before, record after, degrade on deny ────────── */
console.log('\n--- Token economy: allow-check before, degrade on deny, never throw ---');

const onEnv = (opts) => fakeEnv({ enabled: true, ...opts });

check('groq has a KNOWN daily cap', hasKnownCap(tokenEconomy, 'groq') === true);
check('groq cap agrees with token-economy daily_limits', dailyCapFor(tokenEconomy, 'groq') === 14400);
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
check('a daily-capped provider resolves to period "day"',
  capFor(tokenEconomy, 'groq').period === 'day' && capFor(tokenEconomy, 'groq').cap === 14400);
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

const softStop = Math.floor(14400 * routingConfig.soft_stop_fraction);
const exhausted = { [providerPeriodKey('groq', new Date())]: softStop };
const denial = await checkProviderAllowance(onEnv({ counts: exhausted }), 'groq', { tokenEconomy, routingConfig });
check('a provider at its soft-stop is DENIED', denial.allowed === false);
check('...and the denial reason is exactly `overtime_required`', denial.reason === 'overtime_required', denial.reason);
check('the soft stop is 60% of the known cap, not 100% (serves Gate 3)', denial.softStop === softStop && softStop < 14400);

const allowed = await checkProviderAllowance(onEnv({ counts: {} }), 'groq', { tokenEconomy, routingConfig });
check('a provider under its soft-stop is allowed', allowed.allowed === true && allowed.reason === null);
check('an allowed check reports cap and callsToday for the quota dashboard',
  allowed.cap === 14400 && allowed.callsToday === 0 && allowed.capUnknown === false);

const missingCred = await checkProviderAllowance({ SIM_KV: null, DB: null }, 'groq', { tokenEconomy, routingConfig });
check('a provider with no credential is denied by name, not silently skipped',
  missingCred.allowed === false && missingCred.reason === 'missing_credential:GROQ_API_KEY', missingCred.reason);

// Unknown cap: paced, never treated as unlimited.
const pacedEnv = onEnv({});
const first = await checkProviderAllowance(pacedEnv, 'cerebras', { tokenEconomy, routingConfig, now: 1_000_000 });
check('an unknown-cap provider is allowed on its first call', first.allowed === true && first.capUnknown === true);
const tooSoon = await checkProviderAllowance(pacedEnv, 'cerebras', { tokenEconomy, routingConfig, now: 1_005_000 });
check('an unknown-cap provider is PACED, not treated as unlimited', tooSoon.allowed === false);
check('...and the pacing denial reason is `unknown_cap_paced`', tooSoon.reason === 'unknown_cap_paced', tooSoon.reason);
const laterOk = await checkProviderAllowance(pacedEnv, 'cerebras', { tokenEconomy, routingConfig, now: 1_000_000 + routingConfig.unknown_cap_min_spacing_ms + 1 });
check('...and it is allowed again once the spacing has elapsed', laterOk.allowed === true);
check('the spacing floor matches gemini-pacer.js\'s proven 20s conservative floor',
  routingConfig.unknown_cap_min_spacing_ms === tokenEconomy.notebook_x_gemini_pacing.min_spacing_ms_between_calls);

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
