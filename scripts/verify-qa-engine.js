#!/usr/bin/env node
// Dry-run verification for the 2026-07-18 Q&A-engine rebuild. No network
// calls, no D1/KV, no model calls — pure logic checks against real config
// files and the actual production modules where they can be plain-Node
// imported directly (workers/qa-topics.js, workers/gap-reports.js,
// workers/gemini-pacer.js have no JSON imports of their own, so they load
// fine under plain `node`). workers/qa-engine.js and workers/model-router.js
// DO import config JSON directly with no import assertion (same
// ERR_IMPORT_ASSERTION_TYPE_MISSING issue already documented in
// .github/scripts/notebook-x-daily.mjs's header comment, and already worked
// around the same way by scripts/verify-chore-rotation.js) — so their pure
// selection logic is mirrored here against the REAL config/agents-config.json
// and config/token-economy.json (loaded via createRequire, not guessed),
// not against invented test data.
//
// Run: node scripts/verify-qa-engine.js

import { createRequire } from 'node:module';
import { TOPIC_POOL, DATA_CENTER_CORE, NOTEBOOK_X_CORE, NOTEBOOK_X_VOIP_PBX } from '../workers/qa-topics.js';
import { detectCapabilityGap, renderGapDigest } from '../workers/gap-reports.js';
import { checkGeminiPacingSlot, MIN_SPACING_MS } from '../workers/gemini-pacer.js';

const require = createRequire(import.meta.url);
const agentsConfig = require('../config/agents-config.json');
const tokenEconomy = require('../config/token-economy.json');
const aiToolsConfig = require('../config/ai-tools.json');

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

console.log('=== Q&A-engine rebuild verification — dry-run only, no network/model/D1/KV calls ===\n');

/* ── Step 1: topic pool (de-Netvill'd) ─────────────────────────────────── */
console.log('--- Step 1: topic pool ---');

const NETVILL_CLIENT_MARKERS = ['Northgate Logistics', 'Aurora Medical', 'Heritage Bank', 'client_name', 'is_unique_client'];
const poolText = JSON.stringify(TOPIC_POOL);
check('no Netvill-CRM client/ticket markers in the topic pool', !NETVILL_CLIENT_MARKERS.some((m) => poolText.includes(m)));

const CORE_PLATFORMS = ['linux', 'windows', 'network', 'cloud', 'ai', 'firewall', 'networking', 'vpn', 'cloud-devops', 'cybersecurity'];
const coreCount = TOPIC_POOL.filter((t) => CORE_PLATFORMS.includes(t.platform)).length;
const voipCount = TOPIC_POOL.filter((t) => ['1com', 'mirtapbx', 'voip-sip'].includes(t.platform)).length;
check(`core topics present (${coreCount}) and outweigh voip/pbx topics (${voipCount})`, coreCount > voipCount && voipCount > 0,
  `core=${coreCount} voip=${voipCount} — need both present (no deletions) with core weighted higher`);

const dcCount = TOPIC_POOL.filter((t) => t.project === 'data-center').length;
const nbxCount = TOPIC_POOL.filter((t) => t.project === 'notebook-x').length;
check('both target projects represented in the pool', dcCount > 0 && nbxCount > 0, `data-center=${dcCount} notebook-x=${nbxCount}`);

check('every topic entry targets exactly ONE project (never both)', TOPIC_POOL.every((t) => t.project === 'data-center' || t.project === 'notebook-x'));
check('every notebook-x-targeted topic has a kbSlug', TOPIC_POOL.filter((t) => t.project === 'notebook-x').every((t) => !!t.kbSlug));

const expectedKbSlugs = ['kb-linux', 'kb-1com', 'kb-voip-sip', 'kb-mirtapbx', 'kb-cloud-devops', 'kb-cybersecurity', 'kb-firewall', 'kb-networking', 'kb-vpn'];
const actualKbSlugs = new Set(TOPIC_POOL.filter((t) => t.kbSlug).map((t) => t.kbSlug));
check('all 6 owner-named kb slugs + 4 discovered core skeletons are covered',
  expectedKbSlugs.every((s) => actualKbSlugs.has(s)),
  `missing: ${expectedKbSlugs.filter((s) => !actualKbSlugs.has(s)).join(', ') || 'none'}`);

check('config/ai-tools.json case_platform_map covers the same kb slugs',
  expectedKbSlugs.every((s) => Object.values(aiToolsConfig.notebook_x.case_platform_map).includes(s)));

/* ── Step 3: persona config (topic_affinity / escalation_threshold / followup_depth) ── */
console.log('\n--- Step 3: persona differentiation config ---');

const architect = agentsConfig.agents.find((a) => a.id === 10);
check('Architect (10) is still defined (character preserved) but excluded from the active roster', !!architect);

function getActiveQaAgentsMirror() {
  // Mirrors workers/qa-engine.js getActiveQaAgents() exactly — see this
  // file's header comment for why this is a mirror, not a direct import.
  return agentsConfig.agents.filter((a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10);
}
const activeAgents = getActiveQaAgentsMirror();
check('exactly 10 active Q&A agents (11 total minus dormant Architect)', activeAgents.length === 10, `got ${activeAgents.length}`);
check('Architect (10) is NOT in the active list', !activeAgents.some((a) => a.id === 10));

for (const agent of activeAgents) {
  check(`agent ${agent.id} (${agent.name}) has topic_affinity (array)`, Array.isArray(agent.topic_affinity));
  check(`agent ${agent.id} (${agent.name}) has a numeric escalation_threshold in [0,1]`,
    typeof agent.escalation_threshold === 'number' && agent.escalation_threshold >= 0 && agent.escalation_threshold <= 1);
  check(`agent ${agent.id} (${agent.name}) has a numeric followup_depth >= 0`,
    typeof agent.followup_depth === 'number' && agent.followup_depth >= 0);
}

const qaThreshold = agentsConfig.agents.find((a) => a.id === 6).escalation_threshold;
const leadQaThreshold = agentsConfig.agents.find((a) => a.id === 8).escalation_threshold;
const standardThreshold = agentsConfig.agents.find((a) => a.id === 3).escalation_threshold;
const traineeThreshold = agentsConfig.agents.find((a) => a.id === 4).escalation_threshold;
check('QA/Lead QA are more sensitive (higher escalation_threshold) than Standard/Trainee',
  qaThreshold > standardThreshold && leadQaThreshold > traineeThreshold,
  `QA=${qaThreshold} LeadQA=${leadQaThreshold} Standard=${standardThreshold} Trainee=${traineeThreshold}`);

/* ── Step 4: gap detection + Hebrew digest rendering ───────────────────── */
console.log('\n--- Step 4: capability-gap detection + digest rendering ---');

check('HARD gap: notebook-x returns no answer at all -> always flagged',
  detectCapabilityGap({ project: 'notebook-x', quality: undefined, notebookAnswerFound: false }).kind === 'hard');
check('HARD gap: data-center request failed -> always flagged',
  detectCapabilityGap({ project: 'data-center', ok: false, quality: 0 }).kind === 'hard');
check('SOFT candidate: weak-but-present answer (quality 0.3) -> soft, not auto-flagged here',
  detectCapabilityGap({ project: 'data-center', ok: true, quality: 0.3 }).kind === 'soft');
check('NOT a gap: good answer (quality 0.8) -> no candidate at all',
  detectCapabilityGap({ project: 'data-center', ok: true, quality: 0.8 }).kind === null);

const sampleEntries = [
  { agent_name: 'The QA', title: 'qa-2026-w29-d1-001', content: 'לדוגמה: ל-Notebook-X אין תשובה על נושא זה.', created_at: '2026-07-18' },
];
const digestMd = renderGapDigest('notebook-x', '2026-07-18', sampleEntries);
check('gap digest renders project + date + Hebrew entry content',
  digestMd.includes('notebook-x') && digestMd.includes('2026-07-18') && digestMd.includes('לדוגמה'));
check('gap digest contains no GitHub Issue URL/reference (no-GitHub-Issue requirement)',
  !/github\.com\/.*\/issues|issue\s*#\d+/i.test(digestMd));

/* ── Step 5a: shared Claude budget (same tracked pool, not a new one) ──── */
console.log('\n--- Step 5: token economy ---');

check('shared_claude_budget.cap_usd_per_month is $4.50 (soft-stop under the $5 account ceiling)', tokenEconomy.shared_claude_budget?.cap_usd_per_month === 4.5);
check('chore_automation.claude_budget_usd_per_month matches (SAME pool, not a second one)',
  tokenEconomy.chore_automation?.claude_budget_usd_per_month === tokenEconomy.shared_claude_budget?.cap_usd_per_month);
check('old per-day call-count claude_daily_cap is gone (superseded)', tokenEconomy.claude_daily_cap === undefined);
check('deprecated gemini-3.5-flash is not the configured report_model', tokenEconomy.report_model !== 'google/gemini-3.5-flash');

function estimateClaudeCostUsdMirror(inputTokens, outputTokens) {
  // Mirrors workers/model-router.js estimateClaudeCostUsd() at current
  // (pre-2026-08-31) pricing — see that file for the real, date-aware version.
  return (inputTokens / 1_000_000) * 2 + (outputTokens / 1_000_000) * 10;
}
const sampleCost = estimateClaudeCostUsdMirror(500, 300);
check('a typical ask (~500in/300out tokens) costs a small fraction of the monthly cap',
  sampleCost > 0 && sampleCost < tokenEconomy.shared_claude_budget.cap_usd_per_month / 10,
  `estimated $${sampleCost.toFixed(4)} vs $${tokenEconomy.shared_claude_budget.cap_usd_per_month}/mo cap`);

/* ── Step 5b: Gemini pacing (skip-if-too-soon, no blocking sleep) ──────── */
console.log('\n--- Step 5: Gemini pacing ---');

function makeMockKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

const kv = makeMockKv();
const first = await checkGeminiPacingSlot({ SIM_KV: kv });
check('first Gemini pacing check is allowed (no prior call)', first.allowed === true);

const second = await checkGeminiPacingSlot({ SIM_KV: kv });
check('immediate second call is paced out (skip-if-too-soon)', second.allowed === false);

// Simulate MIN_SPACING_MS having elapsed by manipulating the stored timestamp directly.
await kv.put('gemini-notebook-x-last-call', String(Date.now() - MIN_SPACING_MS - 1000));
const third = await checkGeminiPacingSlot({ SIM_KV: kv });
check(`call allowed again after MIN_SPACING_MS (${MIN_SPACING_MS}ms) elapses`, third.allowed === true);

const noKv = await checkGeminiPacingSlot({});
check('pacing degrades open (allowed) when SIM_KV is not bound (dev/test)', noKv.allowed === true);

/* ── 2026-07-19 incident fixes (stale-DO-state day) ────────────────────── */
// workers/agent-runner.js can't be imported under plain node (JSON imports,
// same ERR_IMPORT_ASSERTION_TYPE_MISSING as qa-engine.js — see this file's
// header), so these are source-level regression tripwires, not behavioral
// tests. They pin the three fixes so a revert/regression fails loudly here.
console.log('\n--- 2026-07-19 fixes: anger deadlock / cross-tick reports / client_crisis ---');

const { readFileSync } = await import('node:fs');
const runnerSrc = readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8');
const sidePlotsJson = require('../config/side-plots.json');

check('Fix A: processCaseBatch has NO "if (agent.isAngry) continue/break" skip left',
  !/if \(agent\.isAngry\) (continue|break);/.test(runnerSrc));
check('Fix A part 2: a good answer de-escalates irritation/ANGRY in _applyQualityMood (same-day recovery)',
  /_applyQualityMood[\s\S]{0,900}resolveIrritation\(\)/.test(readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8')));
check('Fix B: runDailyAiExperienceReports takes agentStats (cross-tick), not only instances',
  /runDailyAiExperienceReports\(env, agentInstances, agentStats\)/.test(runnerSrc));
check('Fix B: the always-empty in-memory session gate is gone',
  !/!agent\.session \|\| !agent\.session\.cases_handled/.test(runnerSrc));
check('client_crisis: removed from config/side-plots.json side_plot_types',
  !('client_crisis' in (sidePlotsJson.side_plot_types || {})));
check('client_crisis: no startSidePlot call for it left in agent-runner.js',
  !runnerSrc.includes("startSidePlot(env, 'client_crisis'"));
check('retired-type safety: advanceSidePlots auto-closes rows whose type is no longer configured',
  runnerSrc.includes('retired — auto-closed'));

/* ── 2026-07-19 owner-approved Claude/Gemini rebalance (10 calls/day cap) ── */
console.log('\n--- 2026-07-19 rebalance: per-day Claude call cap ---');

const qaEngineSrc = readFileSync(new URL('../workers/qa-engine.js', import.meta.url), 'utf8');
const agentBaseSrc = readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8');

check('config: shared_claude_budget.max_calls_per_day is 10',
  tokenEconomy.shared_claude_budget?.max_calls_per_day === 10);
check('layer (a): generateAssignedDailyBatch caps data-center questions and re-picks notebook-x',
  qaEngineSrc.includes('MAX_DATA_CENTER_QUESTIONS_PER_DAY') &&
  qaEngineSrc.includes("projectFilter: 'notebook-x'"));
check('layer (b): _askDataCenter has the ask-time daily-cap skip (follow-ups count)',
  agentBaseSrc.includes('CLAUDE_MAX_CALLS_PER_DAY') &&
  agentBaseSrc.includes("tool_used: 'claude-daily-cap-skip'"));
check('cap worst case stays under the monthly soft-stop (10 x ~$0.01 x 31d < $4.50)',
  10 * 0.0101 * 31 < tokenEconomy.shared_claude_budget.cap_usd_per_month);

/* ── Summary ─────────────────────────────────────────────────────────── */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('MISMATCH — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('All scenarios matched expectations.');
  process.exit(0);
}
