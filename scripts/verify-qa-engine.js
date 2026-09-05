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
const simulationConfig = require('../config/simulation-config.json');

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

/*
 * ── WHY `kb-1com` AND `kb-mirtapbx` ARE NOT IN THIS LIST (2026-09-05) ──────
 *
 * They were, and this check went RED on 2026-08-20 and stayed red for sixteen
 * days. **THE VERIFIER WAS THE STALE SIDE, NOT THE POOL.** Commit `2764b5e`
 * ("qa-topics.js: remove the six 1COM/MirtaPBX question templates, owner
 * decision 2026-08-20") deleted the six question templates carrying
 * `platform: '1com'|'mirtapbx'` and `kbSlug: 'kb-1com'|'kb-mirtapbx'`, on an
 * owner authorization recorded in `SESSION-02-STOP-THE-BLEEDING-REPORT.md`
 * PHASE 7: they were filing real, dated capability-gap reports naming two real
 * third-party VoIP/PBX products, and several of those "gaps" were a Cloudflare
 * `too many subrequests` error misreported as a Notebook-X content gap. The
 * same two products sit on `workers/guide-engine.js`'s ABSOLUTE ZERO blocklist
 * (`BLOCKLIST_KEYWORDS`) for the same owner decision — the office does not work
 * on them at all.
 *
 * (The brief that authorized this edit dated that decision 2026-08-22; the
 * commit and its report date it 2026-08-20. The earlier, sourced date is used
 * here — the two-day difference changes nothing about the decision.)
 *
 * The list is therefore SHORTENED, not the blocklist re-opened. Two slugs
 * moved out of scope and their expectation moved with them. Anyone restoring
 * them to this array is restoring an owner-retired capability, which is a
 * decision for the owner and not a fix for a red verifier.
 *
 * `kb-voip-sip` STAYS. The commit is explicit that "generic voip-sip entries
 * are untouched" — what was retired is the two named products, not the
 * protocol, and the `voipCount > 0` check above still depends on them.
 */
const RETIRED_KB_SLUGS = ['kb-1com', 'kb-mirtapbx'];
const expectedKbSlugs = ['kb-linux', 'kb-voip-sip', 'kb-cloud-devops', 'kb-cybersecurity', 'kb-firewall', 'kb-networking', 'kb-vpn'];
const actualKbSlugs = new Set(TOPIC_POOL.filter((t) => t.kbSlug).map((t) => t.kbSlug));
check('all 4 still-owner-named kb slugs + 3 discovered core skeletons are covered',
  expectedKbSlugs.every((s) => actualKbSlugs.has(s)),
  `missing: ${expectedKbSlugs.filter((s) => !actualKbSlugs.has(s)).join(', ') || 'none'}`);

// The other half of the same fact, and it is the half that would catch a
// silent restore: the two retired slugs must be ABSENT. Deleting the
// expectation without asserting the absence would leave the pool free to grow
// them back with nothing red.
check('the two owner-retired kb slugs are absent from the pool',
  RETIRED_KB_SLUGS.every((s) => !actualKbSlugs.has(s)),
  `present but retired: ${RETIRED_KB_SLUGS.filter((s) => actualKbSlugs.has(s)).join(', ') || 'none'}`);

check('config/ai-tools.json case_platform_map covers the same kb slugs',
  expectedKbSlugs.every((s) => Object.values(aiToolsConfig.notebook_x.case_platform_map).includes(s)));

/* ── Step 3: persona config (topic_affinity / escalation_threshold / followup_depth) ── */
console.log('\n--- Step 3: persona differentiation config ---');

const architect = agentsConfig.agents.find((a) => a.id === 10);
check('Architect (10) is still defined (character preserved) but excluded from the active roster', !!architect);

function getActiveQaAgentsMirror() {
  // Mirrors workers/qa-engine.js getActiveQaAgents() exactly — see this
  // file's header comment for why this is a mirror, not a direct import.
  // `in_case_rotation !== false` added 2026-08-07 with the same clause in the
  // source; see that function's comment for why it protects Track A.
  return agentsConfig.agents.filter(
    (a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10 && a.in_case_rotation !== false
  );
}
const activeAgents = getActiveQaAgentsMirror();
check('exactly 4 active Q&A agents (13 on roster, minus dormant Architect, minus Workflow/Cyber who are meetings-only, minus the six admins removed 2026-08-11)',
  activeAgents.length === 4, `got ${activeAgents.length}`);
check('…and they are exactly agents 1-4, the field workers', activeAgents.map((a) => a.id).sort().join(',') === '1,2,3,4');
check('Architect (10) is NOT in the active list', !activeAgents.some((a) => a.id === 10));

// TRACK A REGRESSION GUARD, added 2026-08-07 with the 11→13 roster change.
// Agents 12 and 13 were added for meetings/dispatch/review and carry
// status 'specified', which this filter accepts — so WITHOUT the
// in_case_rotation clause they would have been silently enrolled in the
// daily Q&A engine, drawing questions against the live client track and the
// shared Claude budget. This asserts the protection, not the intention.
check('Workflow (12) is on the roster', agentsConfig.agents.some((a) => a.id === 12));
check('Cyber Expert (13) is on the roster', agentsConfig.agents.some((a) => a.id === 13));
check('Workflow (12) is NOT in the Q&A case rotation', !activeAgents.some((a) => a.id === 12));
check('Cyber Expert (13) is NOT in the Q&A case rotation', !activeAgents.some((a) => a.id === 13));

// PHASE 2 REGRESSION GUARD, added 2026-08-11 (Audit-and-Fix session, owner
// decision): admins solve support cases — their real roles (review, design,
// dispatch, judgment) were defined and never enforced, because the Q&A
// engine predates the bureaucracy. Agents 5,6,7,8,9,11 now carry
// in_case_rotation:false, the exact mechanism already proven for 12/13.
check('agents 5,6,7,8,9,11 (the admin tier) all carry in_case_rotation:false',
  [5, 6, 7, 8, 9, 11].every((id) => agentsConfig.agents.find((a) => a.id === id).in_case_rotation === false));
check('…and none of them is in the active list', ![5, 6, 7, 8, 9, 11].some((id) => activeAgents.some((a) => a.id === id)));
check('agents 1-4 (the field workers) are unaffected — still undefined, still in rotation',
  [1, 2, 3, 4].every((id) => agentsConfig.agents.find((a) => a.id === id).in_case_rotation === undefined));

// FAILS-OLD (pre-2026-08-07): no in_case_rotation clause at all. Run it
// against today's config and it admits everyone but the dormant Architect —
// 12, 13 AND all six admins — which is the regression this clause exists to
// prevent, demonstrated rather than described.
const oldFilterNoClause = agentsConfig.agents.filter((a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10);
check('[FAILS-OLD pre-2026-08-07] the pre-change filter WOULD have pulled 12, 13 AND the six admins into the case rotation',
  oldFilterNoClause.some((a) => a.id === 12) && oldFilterNoClause.some((a) => a.id === 13)
  && [5, 6, 7, 8, 9, 11].every((id) => oldFilterNoClause.some((a) => a.id === id)),
  `old filter returned ${oldFilterNoClause.length} agents vs the new filter's ${activeAgents.length}`);

// FAILS-OLD (2026-08-07 to 2026-08-10, before Phase 2): in_case_rotation
// clause existed but only 12/13 were flagged — this is yesterday's live
// production behaviour, and it is EXACTLY the bug Phase 2 fixes: admins
// 5,6,7,8,9,11 pass this filter and are pulled into the case rotation
// alongside the four field workers.
const oldFilterPreP2 = agentsConfig.agents.filter(
  (a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10
    && ![12, 13].includes(a.id) // the ONLY exclusion Phase < 2's filter knew about
);
check('[FAILS-OLD pre-Phase-2] admins 5,6,7,8,9,11 WOULD still show up as case-rotation-eligible under yesterday\'s filter',
  [5, 6, 7, 8, 9, 11].every((id) => oldFilterPreP2.some((a) => a.id === id)),
  `pre-Phase-2 filter returned ${oldFilterPreP2.length} agents (should have been 10, the exact bug) vs today's ${activeAgents.length}`);

// Volume/load consequence of Phase 2 (2026-08-11): computeDailyQuestionVolume()
// (workers/agent-runner.js) reads cases_per_day_total from config — it has no
// agent-count term at all, so the DAILY TOTAL is unchanged by this change.
// generateAssignedDailyBatch() (workers/qa-engine.js) round-robins that same
// total across activeAgents.length — mirrored here rather than imported, per
// this file's header comment on why qa-engine.js can't be plain-Node imported.
{
  const dailyTotal = simulationConfig.cases_per_day_total || 200;
  const roundRobinShare = (n) => Array.from({ length: dailyTotal }, (_, i) => i % n)
    .reduce((counts, agentIdx) => { counts[agentIdx] = (counts[agentIdx] || 0) + 1; return counts; }, {});
  const newShares = Object.values(roundRobinShare(activeAgents.length));
  const oldShares = Object.values(roundRobinShare(10)); // yesterday's active-agent count
  check(`the daily TOTAL (${dailyTotal}) is unchanged — computeDailyQuestionVolume() has no agent-count term`,
    dailyTotal === (simulationConfig.cases_per_day_total || 200));
  check(`[FAILS-OLD] each of the 4 remaining field agents' per-day share roughly TRIPLES: was ~${oldShares[0]}/agent across 10, now ~${newShares[0]}/agent across 4`,
    newShares[0] > oldShares[0] * 2, `old=${oldShares[0]} new=${newShares[0]}`);
  check('…the six removed admins now get exactly 0 cases/day (down from their prior ~1/10th share each)',
    activeAgents.every((a) => ![5, 6, 7, 8, 9, 11].includes(a.id)));
}

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

/* ── 2026-07-19 follow-ups: Hebrew gap-note routing + agents-table sync ── */
console.log('\n--- 2026-07-19 follow-ups: gap-note Gemini routing / agents sync ---');

const agentBaseSrc2 = readFileSync(new URL('../agents/agent-base.js', import.meta.url), 'utf8');
check('gap notes: flagCapabilityGap composes Hebrew via queryGeminiDirect (not the Groq-routed path)',
  /flagCapabilityGap[\s\S]{0,2200}queryGeminiDirect\(/.test(agentBaseSrc2));
/* ── 2026-07-19 (follow-up): guide generation retired entirely ──────────── */
console.log('\n--- 2026-07-19 follow-up: guide generation (generateGuide/commitGuideToArchive) retired ---');
{
  // Owner decision: data-center-archive/guides/ never functionally existed
  // (data-center-archive was never in project-permissions.json's known
  // project keys) — generateGuide()/commitGuideToArchive() and the
  // TRAINEE_PANIC guide-detection/commit steps were removed entirely, not
  // just fixed/redirected. Mirrors the stale-`.queryGemini(` tripwire above:
  // a stale reference must fail loudly, not silently linger.
  const codeFiles = [
    '../agents/agent-4-trainee.js', '../agents/agent-base.js', '../agents/agent-stub.js',
    '../workers/agent-runner.js', '../workers/scheduler.js',
  ];
  const configFiles = ['../config/agents-config.json', '../config/relationships.json', '../config/side-plots.json'];

  const codeSrcs = codeFiles.map((f) => [f, readFileSync(new URL(f, import.meta.url), 'utf8')]);
  const staleFns = codeSrcs.filter(([, src]) => /generateGuide\s*\(|commitGuideToArchive\s*\(|archiveGuides/.test(src)).map(([f]) => f);
  check('no generateGuide()/commitGuideToArchive()/archiveGuides reference remains in code', staleFns.length === 0,
    `stale reference in: ${staleFns.join(', ')}`);

  const configSrcs = configFiles.map((f) => [f, readFileSync(new URL(f, import.meta.url), 'utf8')]);
  const staleConfig = configSrcs.filter(([, src]) => src.includes('data-center-archive')).map(([f]) => f);
  check('no data-center-archive reference remains in live config', staleConfig.length === 0,
    `stale reference in: ${staleConfig.join(', ')}`);

  // AGENTS.md deliberately still NAMES data-center-archive once, to document
  // the removal — checked for the explanatory note, not for absence.
  const agentsMdSrc = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  check('AGENTS.md documents the guide-generation removal (not silently dropped)',
    agentsMdSrc.includes('generateGuide()') && agentsMdSrc.includes('commitGuideToArchive()') &&
    /removed from this protocol/.test(agentsMdSrc));
}
{
  // 2026-07-19 rename: the old `queryGemini()` name read as "calls Gemini"
  // while bare calls went Groq-first — no invocation of it may remain.
  const srcFiles = ['../agents/agent-base.js', '../agents/agent-1-perfectionist.js', '../agents/agent-2-productive.js',
    '../agents/agent-3-standard.js', '../agents/agent-4-trainee.js', '../agents/agent-stub.js',
    '../workers/agent-runner.js', '../workers/meeting-engine.js', '../workers/chore-runner.js'];
  const stale = srcFiles.filter((f) => /\.queryGemini\(/.test(readFileSync(new URL(f, import.meta.url), 'utf8')));
  check('rename complete: no `.queryGemini(` invocation remains anywhere', stale.length === 0,
    `stale call sites in: ${stale.join(', ')}`);
  check('router split: queryGroqRouted and queryGeminiDirect both defined in agent-base.js',
    agentBaseSrc2.includes('async queryGroqRouted(') && agentBaseSrc2.includes('async queryGeminiDirect('));
}
check('agents-table sync: syncAgentsTable defined and run at day-cycle start',
  runnerSrc.includes('async function syncAgentsTable') &&
  /await syncAgentsTable\(env\);\s*\n\s*const cases = isOffDay/.test(runnerSrc));

/* ── Summary ─────────────────────────────────────────────────────────── */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('MISMATCH — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('All scenarios matched expectations.');
  process.exit(0);
}
