/**
 * Data Center — AI Agent Simulation — agent runner Worker.
 *
 * Three responsibilities:
 *   1. `instantiateAgent()` / `runAgentSession()` — instantiate an agent
 *      (merging durable `configOverrides` from its Durable Object over the
 *      static agents-config.json entry via agent-base.js's loadState()) and
 *      run it against a single question.
 *   2. `runWorkDayCycle()` / `runWeeklyResetCycle()` — the simulation's
 *      cron-driven cycles: Q&A question generation/assignment (qa-engine.js,
 *      qa-topics.js — replaces the retired Netvill-CRM crm-engine.js),
 *      per-agent ask-and-evaluate loop, meeting-engine.js checks (daily standup,
 *      milestone reviews, audits, PIP sessions), side-plot lifecycle
 *      (side-plots.json), and year-tracker bookkeeping (year-tracker.json).
 *      Exposed via `scheduled()` for Cron Triggers and `/api/agents/trigger`
 *      for manual/admin runs.
 *   3. HTTP API for the Admin tab (dashboard/) — read-only status,
 *      live session feed, reports, suggestions, year/side-plot state, and
 *      simulation controls, all backed by D1.
 *
 * Bindings expected (see README.md):
 *   DB             - D1 database (schema.sql)
 *   AGENT_STATE    - Durable Object namespace (state-manager.js AgentStateDO)
 *   SIM_KV         - KV namespace for live simulation overrides
 *   GEMINI_API_KEY - secret
 *   GITHUB_TOKEN   - secret (optional; gates report/guide commits)
 *   ADMIN_TOKEN    - secret (validates X-Admin-Token on /api/agents/*)
 *
 * Status: DRAFT (Phase 1 foundation, Phase 2 office simulation).
 */

export { AgentStateDO } from './state-manager.js';
import { probeSubrequestCeiling } from './state-manager.js';
// OB-074 Phase 3, SHIPPED OFF. The runner is REGISTERED here rather than
// imported by state-manager.js, which would be a cycle — see
// case-batch-do.js's header for why the dependency is inverted.
import {
  setCaseBatchRunner, caseDoEnabled, CASE_DO_INSTANCE, CASE_DO_PATH,
} from './case-batch-do.js';

import agentsConfig from '../config/agents-config.json';
import simulationConfig from '../config/simulation-config.json';
import sidePlotsConfig from '../config/side-plots.json';
import yearTrackerSeed from '../config/year-tracker.json';
import dailyScheduleConfig from '../config/daily-schedule.json';
import aiToolsConfig from '../config/ai-tools.json';
import projectPermissions from '../config/project-permissions.json';
import tokenEconomy from '../config/token-economy.json';
import officeProjects from '../config/office-projects.json';

import { PerfectionistAgent } from '../agents/agent-1-perfectionist.js';
import { ProductiveAgent } from '../agents/agent-2-productive.js';
import { StandardAgent } from '../agents/agent-3-standard.js';
import { TraineeAgent } from '../agents/agent-4-trainee.js';
import { StubAgent } from '../agents/agent-stub.js';

import { runMeeting, MEETING_TYPES, writeActionItemsToBoard, actionItemsToBoardEnabled } from './meeting-engine.js';
import { normalizeActionItems } from './meeting-decisions.js';
import { callCFRouter, callGemini, CF_WORKERS_AI_MODEL } from './gemini-client.js';
import { generateAssignedDailyBatch, persistQuestions } from './qa-engine.js';
import { getClaudeBudgetStatus, recordClaudeSpend, routeTaskTypeCall, resolveTaskLane, getRoutingQuotaStatus, resolveImageRoles, routerModelTargets, MODEL_ROUTING } from './model-router.js';
// The image lane (2026-08-10, plan 5.1) — the Designer's first means of doing
// the work the bible has described her doing since 2026-08-05. listImageCapableModels()
// is a LIVE CATALOG read-back and is imported for the `image_catalog` trigger:
// AD-030 check 1 says a model ID is verified against the provider's live catalog
// before anything is attributed to a key, and the only meaningful place to run
// that check is inside the Worker, with the secret the Worker actually holds.
import { listImageCapableModels } from './gemini-image-client.js';
import { renderAssetProvenance, extensionForMime } from './provider-common.js';
import { collectTodayGapReports, renderGapDigest } from './gap-reports.js';
import { METRIC_DISCLOSURE } from './quality-metric.js';
// OB-081 — the sampled real judge. The Worker owns the toggle, the calibration
// read-back and the supervised single call; the sampling itself happens on the
// Q&A path in agents/agent-base.js, which is the only place holding the full
// answer text (see that file's `_maybeJudgeSample()`).
import {
  runCalibration, renderCalibrationReport, buildJudgePrompt, parseJudgeVerdict,
  JUDGE_LANE, JUDGE_MAX_TOKENS,
} from './judge-sampler.js';
import { resolveIssueTarget } from './permission-guard.js';
// buildOfficeContext + BUDGETS are imported for the office_context_status
// read-back ONLY (2026-08-10): the meeting and per-agent shapes are the two that
// actually bind, and a probe that reports only the generous `report` shape cannot
// tell you that the meeting shape is at 98% and trimming the board out of view.
import { getOfficeContext, getOfficeSnapshot, fetchOfficeSnapshot, officeContextEnabled, buildOfficeContext, fetchBackOfficeFile, fetchBackOfficeDir, BUDGETS as OFFICE_BUDGETS, CACHE_KEY as OFFICE_SNAPSHOT_CACHE_KEY } from './office-context.js';
// The admin tier's scheduled draw from real queues (2026-08-17). Pure — every
// fetch, model call and write for it is in processAdminDeskBlock() below.
import {
  carriedDeliverables, reviewAssignments, approvalQueue,
  probationDecisionDraw, recentIncidents, deskSummary, producedAnything,
  PROBATION_TEAM_LEAD, PROBATION_QA, PROBATION_DECIDER, IT_CHIEF_ID,
  CEO_ID as DESK_CEO_ID, INCIDENT_WINDOW_HOURS, MAX_INCIDENTS_PER_NOTE,
} from './admin-desk.js';
// The lifecycle's own live index of what is in flight and who owes what on it.
// `LOCATIONS` gives the back-office directory a readable deliverable sits in.
import { LOCATIONS } from './deliverable-lifecycle.js';
// Same read-back-only rule as the line above (2026-08-10). These two constants
// are the office's TRANSCRIPTION of two facts that live in the owner's policy
// file; `office_context_status` compares them against the live parse so a drift
// is visible in production, not only in scripts/verify-office-policy.js.
import { POLICY_RECHECK_DATE, PROVISIONAL_RULES } from './office-policy.js';
// A7's visibility half — open branches and their age in the daily report.
// See workers/branch-watch.js for why the PROHIBITION half is not here.
import { fetchOpenBranches, renderBranchSection } from './branch-watch.js';
import {
  REPO_OWNER, REPO_NAME, BACKOFFICE_REPO_NAME, WAREHOUSE_REPO_NAME,
  REPO_TO_PROJECT_KEY, REPO_TO_TOKEN_SECRET, secretsPresentIn, commitFileToRepo,
} from './repo-write.js';
// The owner channel (2026-08-10, REQ-001). The BASE only — the interface and
// the visual page over it are the office's work and are on the board.
import {
  READ_LOG_PATH, readKey, parseReadLog, renderReadLog, recordOwnerRead, ageQuestions,
  parseOwnerMessage, classifyOwnerIssueReadback,
} from './owner-channel.js';
// The owner's PAGE (2026-08-10, REQ-003) — the presentation layer over the
// channel, which is the office's work. The FOLDER CONTRACT is not: an office that
// builds its own instruction channel builds the pipe that feeds it. This page
// adds no `kind`, changes no field, and relaxes no rule — `parseOwnerMessage()`
// above stands between it and the folder.
import { renderOwnerPage, buildOwnerMessage, buildOwnerState } from './owner-page.js';
import {
  ownerChannelEnabled, notifyOwner, selectNotificationItems, recentFailures, OWNER_ISSUE_LABEL,
  // SESSION 11 (2026-08-23): the three-part gate and the email notice. See
  // owner-notify.js's "three-part notice" and "email notice" headers — the
  // gate is a filter, and this Worker COMPOSES the email but never sends it.
  gateNotificationItems, buildEmailNotice, buildHebrewNoticePrompt,
} from './owner-notify.js';
import { improvementLoopEnabled } from './improvement-loop.js';
// The publishing gate (2026-08-16, OB-014, audit finding #17). Deliberately has
// NO kill switch — see front-gate.js's header. The gate itself is pure and
// publishes nothing; `runFrontPublish()` below is the only thing that writes,
// and it writes through commitFileToRepo() like everything else.
import {
  evaluateBatch, renderPublicationRecord, FRONT_PREFIX, FRONT_SECTIONS,
} from './front-gate.js';
import {
  learningLoopEnabled, writeActiveContextAmendment, writeJournalEntry, appendAdaptation,
} from './context-editor.js';
import {
  proposeChange, recordProbationAction, probationsDueForDecision, openProbationsForAgent,
  applyDecision, applyMissedMeetingFall, PROBATION_ACTIONS_TARGET, MAX_CONCURRENT_PER_AGENT,
} from './probation.js';
import { recordDecision, meetingMissedFalls, reviewTheReviewers, canBlameProvider } from './probation-review.js';
import { runCrossEmbodimentComparison, renderComparisonFinding } from './embodiment-comparison.js';
import { architectLiaisonEnabled, processArchitectLiaisonBlock } from './architect-liaison.js';
import { runChoreRotationSlot } from './chore-runner.js';
import { localizeForFront } from './localization-engine.js';
// THE INVOCATION BUDGET (OB-074, 2026-08-16). See subrequest-budget.js's header
// for the measurement this is built on and why the case share is a floor.
import {
  createTickBudget, collectOutstanding, summarizeBatchState, summarizeDayDeferrals,
  isSameBlock, LANE_CASES, SUBREQUEST_CEILING, admitBlock, blockCost,
  meterEnv, meterGlobalFetch, CASE_LOOKAHEAD, EXTERNAL_FETCH_ALLOWANCE_PER_CASE,
  TICK_TAIL_RESERVE, TICK_TAIL_RESERVE_NO_CASES, FINALIZE_RESERVE, recordAdmissions,
} from './subrequest-budget.js';
import { checkGeminiPacingSlot } from './gemini-pacer.js';
import { callClaudeMessages, CLAUDE_MODEL } from './claude-client.js';
// ── THE WEEKLY MODEL-RETIREMENT CHECK (2026-08-23, Session 14 ITEM C) ──────
// Five model identifiers have been retired out from under this project and
// nothing has ever checked for the sixth. `GROQ_MODEL` and `CLAUDE_MODEL` are
// imported FROM THEIR DEFINITION SITES, and the router's five come through
// routerModelTargets() for the same reason — a checker that holds its own copy
// of a model ID checks its copy, not the config.
import { checkModelCatalogs, renderCatalogSummary, NOT_CHECKABLE_PROVIDERS } from './model-catalog.js';
import { GROQ_MODEL } from './groq-client.js';
import {
  selectGuideTopic, buildDraftPrompt, isSplitRecommendation, pickWriterAgentId,
  insertGuidePipelineRow, updateGuidePipelineRow, getTodayDraftRow,
  buildReviewPrompt, parseReviewDecision, extractUnverifiedSections,
  renderGuideFile, renderRejectedDraftFile, guidePath, draftPath,
  fetchVerificationQueueChecked, parseVerificationQueue, renderVerificationQueue,
  pickVerificationQueueItems, buildVerifyPrompt, parseVerifyResult, replaceGuideSection,
  fetchRawRepoFile, ARCHITECT_REVIEW_SYSTEM, VERIFY_SYSTEM,
  guidesEnabled,
} from './guide-engine.js';
import {
  reportPipelineEnabled, planReportProviders, assertDistinctReviewer,
  buildFactPack, buildDraftPrompt as buildReportDraftPrompt, DRAFT_SYSTEM as REPORT_DRAFT_SYSTEM,
  buildReviewPrompt as buildReportReviewPrompt, REVIEW_SYSTEM as REPORT_REVIEW_SYSTEM,
  parseReportReviewDecision, validateReportBody, renderReportFile, renderRejectedReportFile,
  reportPath, rejectedReportPath, periodLabelFor, daysUntil,
  getPendingReportRow, getLatestReportRow, getApprovedReportRow, insertReportRow, updateReportRow,
  periodLabelCandidates,
  DRAFTER_AGENT_ID, REVIEWER_AGENT_ID, REPORT_TYPES, estimateReviewFit, pickDraftLane,
  LATEST_INDEX_PATH, parseLatestIndex, renderLatestIndex, addToLatestIndex, wordCount,
} from './report-pipeline.js';
// OFFICE-POLICY.md A9, wired 2026-08-11 (Audit-and-Fix session, Phase 4) —
// see that file's header for what "wired" does and does not mean here.
import {
  HEBREW_SYSTEM_PROMPT, buildDailyHeadlinePrompt, withDailyHeadline,
  buildWeeklySummaryPrompt, withWeeklySummary,
} from './hebrew-summary.js';

const ALLOWED_ORIGINS = ['https://avivnofar.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500'];

// MOVED 2026-08-07 to workers/repo-write.js, unchanged — including
// commitFileToRepo() itself, whose 17 call sites below are untouched because
// the imported name is the same. They were only ever here because this file
// was the only module that wrote to a repo; that stopped being true when
// meeting-engine.js needed a governed write for the action_items consumer,
// and it could not import them from here (circular: this file imports
// meeting-engine.js). Nothing about the maps or the write path changed — see
// repo-write.js's header for what DID change, which is that
// meeting-engine.js's commitMeetingReport() stopped bypassing the guard.

/** Maps year-tracker.json milestone keys to the meeting they trigger (in
 * addition to the daily standup, which always runs). */
const MILESTONE_MEETINGS = {
  day_30: 'monthly',
  day_90: 'quarterly',
  day_180: 'semi_yearly',
  day_270: 'quarterly',
  day_365: 'yearly',
};

/** Phase 1 agents get full implementations; 5-11 use StubAgent (now driven
 * by their full agents-config.json specs — see agents/config _meta notes). */
export const AGENT_CLASSES = {
  1: PerfectionistAgent,
  2: ProductiveAgent,
  3: StandardAgent,
  4: TraineeAgent,
};

export function getAgentConfig(id) {
  return agentsConfig.agents.find((a) => a.id === id);
}

/**
 * Instantiates an agent. StubAgent-driven agents (5-11) whose
 * `model_usage_rate` in agents-config.json is a descriptive placeholder
 * (e.g. "optimized_dynamic", "uniquely_tailored_to_CEO_timeline") rather than
 * a number get a numeric runtime default of 0.5 so StubAgent's
 * `Math.random() < model_usage_rate` check works; the displayed config value
 * (and configOverrides, applied later via loadState()) are unaffected.
 */
export function instantiateAgent(id, env) {
  const config = getAgentConfig(id);
  if (!config) throw new Error(`Unknown agent id ${id}`);

  const AgentClass = AGENT_CLASSES[id] || StubAgent;
  const agentEnv = { ...env, SIM_CONFIG: simulationConfig };

  let runtimeConfig = config;
  if (AgentClass === StubAgent && typeof config.model_usage_rate !== 'number') {
    runtimeConfig = { ...config, model_usage_rate: 0.5 };
  }

  let doStub;
  if (env.AGENT_STATE) {
    const doId = env.AGENT_STATE.idFromName(config.durable_object_id);
    doStub = env.AGENT_STATE.get(doId);
  }

  return new AgentClass(runtimeConfig, agentEnv, doStub);
}

/**
 * Loads an agent's persisted state (including configOverrides — see
 * agent-base.js loadState()), runs one case through it, and returns a
 * summary suitable for logging.
 */
export async function runAgentSession(agentId, caseData, env, opts = {}) {
  const agent = instantiateAgent(agentId, env);
  await agent.loadState();
  const result = await agent.handleCase(caseData, opts);
  return {
    agentId,
    result,
    mood: agent.mood,
    irritation: agent.irritation,
    isHappy: agent.isHappy,
    isAngry: agent.isAngry,
    isPanic: agent.isPanic,
    panicLevel: agent.panicLevel,
    configOverrides: agent.configOverrides || {},
  };
}

/**
 * Direct queryGroqRouted() smoke test for an agent — bypasses handleCase()'s
 * probabilistic app-usage logic so the Groq-first routing / the Cloudflare
 * fallback can be exercised deterministically. See POST
 * /api/agents/test-gemini (endpoint name kept for dashboard compatibility —
 * it has never tested actual Gemini; it tests the routed persona path).
 */
export async function runGeminiTest(agentId, prompt, env, opts = {}) {
  const agent = instantiateAgent(agentId, env);
  await agent.loadState();
  const text = await agent.queryGroqRouted(prompt, undefined, { forceFallback: !!opts.forceFallback });
  return { agentId, prompt, text, source: agent.lastModelSource };
}

function corsHeaders(origin) {
  const headers = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

/**
 * The version of THIS Worker bundle, from the `version_metadata` binding.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * On 2026-08-09 a report was generated 34 seconds after a deploy, was served
 * by the PREVIOUS bundle, and produced a defective report. Every signal said
 * success — 200 from the trigger, `ok` from the pipeline, a committed file.
 * The stale bundle was worked out afterwards by comparing timestamps, which
 * only worked because someone thought to be suspicious.
 *
 * Returns null rather than throwing when the binding is absent, so a deploy
 * that predates the binding degrades to "UNRECORDED" instead of failing. That
 * is the honest state: **absent means unknown, not current** — the same rule
 * this project applies to a null free-tier cap.
 */
function workerVersion(env) {
  const id = env?.CF_VERSION_METADATA?.id;
  if (!id) return null;
  const tag = env.CF_VERSION_METADATA.tag;
  return tag ? `${id} (${tag})` : id;
}

/* ──────────────────────────── Status / read APIs ───────────────────────── */

/**
 * Upserts the 11 agents' identity rows (id/key/name/tier/clearance) from
 * agents-config.json into the D1 `agents` table. Added 2026-07-19: the
 * table still held a pre-rebuild roster ("The Senior Sysadmin", "The CTO",
 * ...) that every `JOIN agents` consumer (gap digests, meeting-engine
 * report feeds, the interactions feed) surfaced instead of the configured
 * persona names — same "reading a stale source" class as the Hebrew
 * gap-note routing bug fixed the same day. Config is the source of truth;
 * this runs on each day-cycle start (one batch, 11 rows) so the table can
 * never drift again, plus on demand via the `sync_agents` admin trigger.
 */
async function syncAgentsTable(env) {
  if (!env.DB) return { synced: 0 };
  const stmt = env.DB.prepare(
    `INSERT INTO agents (id, key, name, tier, clearance) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET key = excluded.key, name = excluded.name,
       tier = excluded.tier, clearance = excluded.clearance`
  );
  await env.DB.batch(
    agentsConfig.agents.map((a) => stmt.bind(a.id, a.key, a.name, a.tier || 'standard', a.clearance || 'standard'))
  );
  return { synced: agentsConfig.agents.length };
}

async function getAllAgentStatuses(env) {
  const statuses = [];
  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();
    statuses.push({
      id: agent.id,
      key: agent.key,
      name: agent.name,
      role: config.role,
      tier: config.tier,
      clearance: config.clearance,
      status: config.status || 'active',
      mood: agent.mood,
      irritation: agent.irritation,
      isHappy: agent.isHappy,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
      panicLevel: agent.panicLevel,
      permanentIrritationFlags: agent.permanentIrritationFlags,
      session: agent.session,
      quotas: config.quotas || null,
      configOverrides: agent.configOverrides || {},
      last_active: agent.session?.started_at || null,
    });
  }
  return statuses;
}

async function getRecentInteractions(env, limit = 50) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT i.*, a.name AS agent_name FROM interactions i
     JOIN agents a ON a.id = i.agent_id
     ORDER BY i.timestamp DESC LIMIT ?`
  ).bind(limit).all();
  return results;
}

async function getReports(env, type) {
  if (!env.DB) return [];
  const stmt = type
    ? env.DB.prepare(`SELECT * FROM reports WHERE type = ? ORDER BY created_at DESC LIMIT 100`).bind(type)
    : env.DB.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT 100`);
  const { results } = await stmt.all();
  return results;
}

async function getSuggestions(env) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM suggestions
     ORDER BY CASE permission_level WHEN 'root' THEN 0 WHEN 'sudo' THEN 1 ELSE 2 END, created_at DESC
     LIMIT 100`
  ).all();
  return results;
}

/* ─────────────────────────── Simulation state ─────────────────────────── */

/**
 * Simulation control state lives in KV (binding: SIM_KV) as a small JSON
 * override merged over simulation-config.json's SIMULATION block. Falls
 * back to the static config defaults if SIM_KV isn't bound yet.
 */
const SIM_STATE_KEY = 'simulation-state';

/**
 * ── ONE SWITCH READ PER INVOCATION (OB-074, 2026-08-16) ────────────────────
 *
 * Measured on a real 30-case tick: `simulation-state` was fetched from KV
 * **63 times in one invocation** — roughly twice per case. Nine modules each
 * keep their own `SIM_STATE_KEY` and each re-reads the switches on every call
 * (`improvement-loop.js`, `judge-sampler.js`, `office-context.js`,
 * `report-pipeline.js`, `guide-engine.js`, `context-editor.js`,
 * `meeting-engine.js`, `owner-notify.js`, and this file). At one subrequest
 * each that is 62 wasted out of a 50-subrequest budget.
 *
 * Rather than edit nine modules — nine chances to miss one, and nine future
 * modules that would not know the rule — the cache is installed on the ENV
 * those modules already read through. `tickEnv()` returns a shallow copy of
 * `env` whose `SIM_KV` memoizes exactly one key, `simulation-state`, for the
 * lifetime of that copy. The copy is created once per invocation inside
 * `runScheduledBlock()` and never escapes it, so the cache cannot outlive the
 * tick — which matters, because an isolate is reused across invocations and a
 * module-level cache here would serve yesterday's switch states.
 *
 * ONLY `simulation-state` is cached, and ANY put/delete clears the memo. A
 * switch cannot change mid-tick except by this Worker changing it, and if it
 * does, the memo is already gone. Every other key passes straight through.
 *
 * This does NOT make the switches stale for the toggle endpoint: the HTTP
 * handler runs on the unwrapped `env`, so a read-back after a toggle is a
 * real KV read. `verify-subrequest-budget.js` §3 proves both halves.
 */
function tickEnv(env) {
  if (!env) return env;
  const out = { ...env };

  // ── ONE LAZY TABLE CREATE PER INVOCATION (OB-074) ────────────────────────
  //
  // Several tables are created lazily rather than living in schema.sql —
  // `claude_budget_usage` (model-router.js), `provider_usage`
  // (task-router.js), `quality_judgements` (judge-sampler.js), `repo_writes`
  // (repo-write.js). Each guard runs `CREATE TABLE IF NOT EXISTS` before its
  // real statement, and those guards sit on per-case paths: measured at TWO
  // `claude_budget_usage` creates per data-center case, one from
  // getClaudeBudgetStatus() and one from recordClaudeSpend().
  //
  // The second one in an invocation cannot do anything the first did not.
  // Suppressing it is not a behaviour change, it is removing a repeat — and
  // at ~2 subrequests per case it was close to a fifth of a case's cost.
  // Keyed on the exact SQL text, per invocation, so a table this tick has not
  // touched is still created normally.
  if (env.DB) {
    const db = env.DB;
    const created = new Set();
    out.DB = {
      ...db,
      prepare: (sql) => {
        if (/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(sql)) {
          if (created.has(sql)) {
            const noop = { bind: () => noop, run: async () => ({ success: true, meta: {} }), first: async () => null, all: async () => ({ results: [] }) };
            return noop;
          }
          created.add(sql);
        }
        return db.prepare(sql);
      },
      batch: (...a) => db.batch(...a),
      exec: (...a) => db.exec(...a),
    };
  }

  if (!env.SIM_KV) return out;
  const kv = env.SIM_KV;
  let memo = null;          // { value } once populated — null means "not yet read"
  const wrapped = {
    async get(key, type) {
      if (key !== SIM_STATE_KEY) return kv.get(key, type);
      // The memo holds the RAW stored value. Callers pass type 'json' here
      // without exception, but a text read of the same key stays correct
      // because we re-serialize rather than hand back the object.
      if (!memo) memo = { raw: await kv.get(key, 'text') };
      if (memo.raw == null) return null;
      if (type === 'json') { try { return JSON.parse(memo.raw); } catch { return null; } }
      return memo.raw;
    },
    async put(key, value, options) { memo = null; return kv.put(key, value, options); },
    async delete(key) { memo = null; return kv.delete(key); },
    list: (...a) => kv.list(...a),
  };
  if (typeof kv.getWithMetadata === 'function') {
    wrapped.getWithMetadata = (...a) => kv.getWithMetadata(...a);
  }
  out.SIM_KV = wrapped;
  return out;
}

async function getSimulationState(env) {
  const base = { ...simulationConfig.SIMULATION, paused: false };
  if (!env.SIM_KV) return base;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json');
  return { ...base, ...(stored || {}) };
}

/**
 * ── AN UNKNOWN KEY IS NOW REPORTED, NOT SILENTLY DROPPED (2026-08-10) ────
 *
 * Found live, the expensive way. `owner_channel_toggle` was added, deployed and
 * called; the endpoint answered **HTTP 200 with a full state object** and the
 * switch stayed off, because the new key was not on the list below and the loop
 * simply never saw it. Nothing in the response, the logs or the read-back said a
 * key had been ignored — the caller got back a state that looked authoritative
 * and was missing the only field it had asked to change.
 *
 * That is `ARCHITECTURAL-DECISIONS.md` §7.6 exactly — *a value nothing produces,
 * read by something that treats absence as fact* — landed on the switchboard,
 * and it is a trap for every future switch: **adding a toggle case is not enough,
 * and the failure to add the key is invisible.** So the function now returns
 * `rejected`, and the callers surface it.
 *
 * The allow-list itself stays. It is the reason an unauthenticated body could
 * never write arbitrary keys, and widening it to "anything" to avoid this class
 * of bug would sell a real guard for a convenience.
 */
async function updateSimulationState(env, patch) {
  const current = await getSimulationState(env);
  const allowedKeys = ['inspection_mode', 'paused', 'phase', 'guides_enabled', 'routing_enabled', 'improvement_loop_enabled', 'architect_liaison_enabled', 'office_context_enabled', 'action_items_to_board_enabled', 'report_pipeline_enabled', 'owner_channel_enabled', 'learning_loop_enabled', 'judge_sampler_enabled', 'cases_enabled'];
  const next = { ...current };
  const rejected = [];
  for (const key of Object.keys(patch)) {
    if (allowedKeys.includes(key)) next[key] = patch[key];
    else rejected.push(key);
  }
  if (rejected.length) {
    console.warn(`[simulation-state] REFUSED ${rejected.length} unknown key(s) and changed nothing for them: ${rejected.join(', ')}. `
      + 'A toggle case whose key is not on the allow-list returns 200 and does nothing — this line is the only signal that happened.');
  }
  if (env.SIM_KV) await env.SIM_KV.put(SIM_STATE_KEY, JSON.stringify(next));
  return rejected.length ? { ...next, _rejected_keys: rejected } : next;
}

/**
 * Case work — the Q&A engine, both target products.
 *
 * RETIRED by owner decision 2026-08-23; the record is
 * `back-office-AI-agents/docs/decisions/RETIRED-CAPABILITIES.md` R-001.
 * Retirement, not deletion: every topic, persona, prompt, table and historical
 * report stays exactly where it is and simply stops being invoked.
 *
 * DEFAULTS ON, unlike every other switch in this file. `guides_enabled` ships
 * off because deploying a brand-new feature must not start it; this one guards
 * a capability that has been running since 2026-07-19, and a default-off switch
 * would retire it at deploy time rather than at the owner's word. Off has to be
 * a decision someone made out loud, and it has to be readable back from KV —
 * so this reads `!== false`, not the `=== true` the other switches use.
 */
async function casesEnabled(env) {
  const sim = await getSimulationState(env);
  return sim.cases_enabled !== false;
}

/* ───────────────────────────── Year tracker ────────────────────────────── */

function emptyYearStats() {
  return { ...JSON.parse(JSON.stringify(yearTrackerSeed.stats)), year_number: 1 };
}

/** Reads the latest `year_stats` row, seeding from year-tracker.json if none exists yet. */
async function getYearState(env) {
  if (!env.DB) {
    return {
      simulation_start: null,
      current_day: 0,
      current_week: 0,
      current_month: 0,
      current_quarter: 0,
      total_days: yearTrackerSeed.total_days,
      stats: emptyYearStats(),
    };
  }

  const row = await env.DB.prepare(`SELECT * FROM year_stats ORDER BY recorded_at DESC LIMIT 1`).first().catch(() => null);
  if (!row) {
    return {
      simulation_start: new Date().toISOString(),
      current_day: 0,
      current_week: 0,
      current_month: 0,
      current_quarter: 0,
      total_days: yearTrackerSeed.total_days,
      stats: emptyYearStats(),
    };
  }

  return {
    simulation_start: row.simulation_start,
    current_day: row.current_day,
    current_week: row.current_week,
    current_month: row.current_month,
    current_quarter: row.current_quarter,
    total_days: yearTrackerSeed.total_days,
    stats: { ...emptyYearStats(), ...JSON.parse(row.stats || '{}') },
  };
}

async function persistYearState(env, state) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO year_stats (id, simulation_start, current_day, current_week, current_month, current_quarter, stats, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(
    crypto.randomUUID(),
    state.simulation_start,
    state.current_day,
    state.current_week,
    state.current_month,
    state.current_quarter,
    JSON.stringify(state.stats || {})
  ).run().catch(() => {});
}

function updateYearStats(prevStats, { summary, standup, sidePlotStarted, sidePlotUpdates }) {
  const stats = { ...emptyYearStats(), ...(prevStats || {}) };

  for (const a of summary.agents) {
    stats.total_cases_handled += a.handled || 0;
    stats.total_cases_by_agent[a.agentId] = (stats.total_cases_by_agent[a.agentId] || 0) + (a.handled || 0);
    stats.total_trainee_panic_escalations += a.escalations || 0;
    stats.avg_mood_by_agent[a.agentId] = a.mood;
  }

  if (standup && !standup.error) {
    stats.total_meetings += 1;
    stats.total_meetings_by_type.daily_standup = (stats.total_meetings_by_type.daily_standup || 0) + 1;
  }

  for (const plot of sidePlotStarted || []) {
    stats.total_side_plots += 1;
    stats.total_side_plots_by_type[plot.type] = (stats.total_side_plots_by_type[plot.type] || 0) + 1;
    if (plot.type === 'rivalry_escalation') stats.rivalry_escalation_count += 1;
  }

  for (const u of sidePlotUpdates || []) {
    if (u.status === 'resolved' && u.type === 'pip_drama') {
      stats.total_pip_placements += 1;
    }
  }

  return stats;
}

/* ─────────────────────────────── GitHub ────────────────────────────────── */

/**
 * commitFileToRepo() now lives in workers/repo-write.js and is imported at
 * the top of this file. Moved 2026-08-07, byte-identical — see that module's
 * header. Its 17 call sites below are unchanged.
 */

/**
 * Generic GitHub Issue creation. No-ops without env.GITHUB_TOKEN.
 *
 * Enforces the same "no external push when push:false" General rule as
 * commitFileToRepo() (see workers/permission-guard.js) — a filed-Issue is a
 * write to that project's repo just as much as a file commit is, so an
 * attempt to open an Issue in a push:false project gets redirected into
 * REPO_NAME instead of landing in the external repo.
 */
async function fileGitHubIssue(env, repoName, { title, body, labels }) {
  // Same fail-open fix as commitFileToRepo() (2026-08-06): an unmapped repo
  // name used to skip resolveIssueTarget() entirely and open the Issue
  // anyway. An Issue is a write to that repo just as much as a file commit
  // is, so it gets the same fail-closed treatment and the same
  // token-follows-the-repo rule.
  const projectKey = REPO_TO_PROJECT_KEY[repoName];
  if (!projectKey) {
    const reason = `no config/project-permissions.json key mapped for repo "${repoName}" — Issue creation DENIED (fail closed).`;
    console.warn(`[permission-guard] ${reason}`);
    return { created: false, reason, blocked: 'unmapped_repo' };
  }

  const target = resolveIssueTarget(projectPermissions, { projectKey, ownRepoName: REPO_NAME, targetRepoName: repoName, title, body });
  repoName = target.repoName;
  title = target.title;
  body = target.body;

  const tokenSecret = REPO_TO_TOKEN_SECRET[repoName];
  if (!tokenSecret) {
    return { created: false, reason: `no token secret mapped for repo "${repoName}" — DENIED`, blocked: 'no_token_mapped' };
  }
  if (!env?.[tokenSecret]) {
    return { created: false, reason: `${tokenSecret} not configured — DENIED for repo "${repoName}"`, blocked: 'token_not_configured' };
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env[tokenSecret]}`,
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  return { created: res.ok, status: res.status };
}

/**
 * Reads back owner-channel Issues (label `owner-channel` — #36, #37, ...)
 * for `classifyOwnerIssueReadback()`. The read-back half of Phase 1.2
 * (2026-08-11 audit-and-fix session): a notification Issue with no comment
 * and not closed had nothing checking it, ever. Read-only — no-ops to `[]`
 * without env.GITHUB_TOKEN or on any request failure, same fail-quiet-but-
 * logged shape `fetchAssetBoard()` below uses for a public read.
 */
async function fetchOwnerChannelIssues(env, repoName) {
  const tokenSecret = REPO_TO_TOKEN_SECRET[repoName];
  if (!tokenSecret || !env?.[tokenSecret]) return [];
  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/issues?labels=${encodeURIComponent(OWNER_ISSUE_LABEL)}&state=all&per_page=50`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env[tokenSecret]}`,
        'User-Agent': 'data-center-agent-sim',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      console.warn(`[owner-channel] could not read back owner-channel Issues — HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((it) => ({
      number: it.number, title: it.title, createdAt: it.created_at, state: it.state, comments: it.comments,
    }));
  } catch (err) {
    console.warn(`[owner-channel] could not read back owner-channel Issues — ${err?.message || err}`);
    return [];
  }
}

/**
 * Reads the COMMENT TEXT on owner-channel Issues (SESSION 11, ITEM D).
 *
 * ── WHAT WAS ACTUALLY MISSING ────────────────────────────────────────────
 *
 * `fetchOwnerChannelIssues()` above already knew the comment COUNT, and
 * `classifyOwnerIssueReadback()` already used it to decide `hasReply`. So the
 * office could tell that the owner had said something and could not tell WHAT.
 * A reply reached it as a boolean.
 *
 * That is why the Issue body told him not to reply there: the office genuinely
 * could not read it, so it sent him to a file it could. This function is the
 * half that was missing, and it is one more call on a capability the office
 * already has — the same API, the same token, the same fail-quiet shape.
 *
 * Read-only. `[]` on any failure, exactly like the listing it extends: a reply
 * the office could not fetch must look like "not fetched", never like "not
 * sent".
 */
async function fetchOwnerIssueComments(env, repoName, issueNumber) {
  const tokenSecret = REPO_TO_TOKEN_SECRET[repoName];
  if (!tokenSecret || !env?.[tokenSecret]) return [];
  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/issues/${issueNumber}/comments?per_page=50`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env[tokenSecret]}`,
        'User-Agent': 'data-center-agent-sim',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      console.warn(`[owner-channel] could not read comments on Issue #${issueNumber} — HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      // THE OFFICE'S OWN COMMENTS ARE NOT ANSWERS. Nothing writes them today,
      // but a future session that adds an acknowledgement comment would
      // otherwise have the office reading itself as the client.
      .filter((c) => String(c?.user?.login || '').toLowerCase() === String(REPO_OWNER).toLowerCase())
      .map((c) => ({
        id: c.id,
        author: c.user?.login || null,
        createdAt: c.created_at,
        body: String(c.body || '').trim(),
      }))
      .filter((c) => c.body);
  } catch (err) {
    console.warn(`[owner-channel] could not read comments on Issue #${issueNumber} — ${err?.message || err}`);
    return [];
  }
}

/**
 * Commits an Issue reply into the channel record (ITEM D3).
 *
 * ── WHY THE REPLY IS STILL FILED IN GIT ──────────────────────────────────
 *
 * The instruction the office used to give — *"in the repo, not in this issue"* —
 * was protecting something real: git is an ordered, permanent, attributable
 * record, and an issue tracker is not. That was never worth what it cost. The
 * office can do the filing itself, and asking the client to do a system's
 * bookkeeping for it is the reason eleven notifications went unanswered.
 *
 * So both properties hold: he replies where he is reading, and the reply lands
 * in `channel/from-owner-issues/` as a dated file with the Issue it came from,
 * the comment id and the author. One file per comment, append-only, never
 * edited — the same single-writer discipline every other channel file keeps.
 *
 * This writes into back-office, NOT into `channel/from-owner/`. That folder is
 * the owner's own and the office never writes there (owner-channel.js's rule,
 * unchanged). A reply the office transcribed is the OFFICE's record of what he
 * said, and it must not be mistakable for a file he wrote himself.
 */
/**
 * Every model identifier this estate has configured, as catalogue-check targets.
 *
 * ── THE ONE PLACE THE LIST IS ASSEMBLED, AND NOWHERE THE IDs ARE WRITTEN ──
 *
 * Not one identifier is spelled in this function. Each is imported from the
 * module that defines it — `GROQ_MODEL`, `CLAUDE_MODEL`, `CF_WORKERS_AI_MODEL`,
 * the Gemini chat model out of `config/simulation-config.json`, and the router's
 * five through `routerModelTargets()`. That is the whole point: a retirement
 * checker holding its own copy of a model ID verifies its copy, and would have
 * stayed green through all five retirements this project has already had.
 *
 * `configuredIn` names every OTHER place the same identifier is written, so a
 * red result tells whoever reads it which files have to move together. That
 * list IS hand-maintained and will drift; it is documentation attached to the
 * finding, never the thing being checked.
 */
function configuredModelTargets(env) {
  const geminiChatModel = (env?.SIM_CONFIG?.GEMINI?.model) || simulationConfig?.GEMINI?.model || null;
  return [
    {
      provider: 'groq',
      model: GROQ_MODEL,
      configuredIn: ['workers/groq-client.js GROQ_MODEL', 'config/token-economy.json primary_case_model'],
    },
    {
      provider: 'gemini',
      model: geminiChatModel,
      configuredIn: ['config/simulation-config.json GEMINI.model', 'config/token-economy.json report_model', 'config/agents-config.json (per-agent ai_tools.model)', 'agents/agent-base.js _askNotebookX() literal fallback'],
    },
    {
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      configuredIn: ['workers/claude-client.js CLAUDE_MODEL', 'config/token-economy.json app_search_model (documentation only)'],
    },
    {
      // Reported as `not_checkable`, deliberately, rather than left out. See
      // model-catalog.js NOT_CHECKABLE_PROVIDERS.
      provider: 'cloudflare-ai',
      model: CF_WORKERS_AI_MODEL,
      configuredIn: ['workers/gemini-client.js CF_WORKERS_AI_MODEL', 'config/token-economy.json routing_model'],
    },
    ...routerModelTargets(),
  ].filter((t) => !!t.model);
}

async function recordIssueReplies(env, recordRepo, issueReadback) {
  const recorded = [];
  for (const ir of issueReadback || []) {
    if (!ir.hasReply || !ir.comments) continue;
    // PER-ITEM, never one global target — see readBackOwnerIssues() below for
    // why the office reads two repositories and files into one.
    const issueRepo = ir.repo || OWNER_NOTIFY_REPO;
    const comments = await fetchOwnerIssueComments(env, issueRepo, ir.number);
    for (const c of comments) {
      const date = String(c.createdAt || '').slice(0, 10) || todayDateStr();
      const path = `channel/from-owner-issues/${date}-issue-${ir.number}-comment-${c.id}.md`;
      const content = [
        `# Reply from the client — Issue #${ir.number}`,
        '',
        `- **Issue:** [#${ir.number}](https://github.com/${REPO_OWNER}/${issueRepo}/issues/${ir.number}) — ${ir.title}`,
        `- **Author:** ${c.author}`,
        `- **Written:** ${c.createdAt}`,
        `- **Comment id:** ${c.id}`,
        '',
        '_Transcribed by the office from the Issue thread. His words, unedited._',
        '_This is the office\'s record of what he said; it is NOT a file he wrote,_',
        '_which is why it is not in `channel/from-owner/`._',
        '',
        '---',
        '',
        c.body,
        '',
      ].join('\n');

      // IDEMPOTENT BY AN EXPLICIT READ, not by trusting the write to be a
      // no-op. The same comment is seen on every daily cycle for as long as the
      // Issue stays open; `commitFileToRepo()` has no skip-if-exists option and
      // would re-PUT the same bytes every day, so the check is made here. A
      // failed read is treated as ALREADY RECORDED — the record is append-only
      // and a duplicate entry is a worse outcome than a delayed one.
      const existing = await fetchBackOfficeFile(env, path);
      if (existing?.text !== null && existing?.text !== undefined) {
        recorded.push({ issue: ir.number, repo: issueRepo, commentId: c.id, path, committed: false, already: true });
        continue;
      }
      const res = await commitFileToRepo(env, recordRepo, path, content,
        `channel: record client reply on issue #${ir.number}`)
        .catch((err) => ({ committed: false, reason: `threw: ${err?.message || err}` }));
      recorded.push({ issue: ir.number, repo: issueRepo, commentId: c.id, path, committed: !!res?.committed, reason: res?.reason || null });
    }
  }
  return recorded;
}

/*
 * ─── WHICH REPOSITORIES A REPLY IS READ FROM (SESSION 12, 2026-08-23) ────
 *
 * The office FILES into one repository and READS BACK from two, and the two
 * lists are deliberately different lengths.
 *
 * `OWNER_NOTIFY_REPO` moved to back-office today (see its own block below).
 * Twelve `[Office #N]` Issues stand open in the PUBLIC repo, unmigrated on
 * purpose, and **one of them carries the owner's first reply in this channel's
 * history** — his comment on Issue #47, written 2026-08-23T12:39:44Z, roughly
 * two hours before this retarget was deployed.
 *
 * Reading back only from the new target would have made that reply
 * unreachable: back-office holds zero owner-channel Issues, so the read-back
 * would be empty, `recordIssueReplies()` would iterate nothing, and the one
 * message the client has ever sent through this channel would be dropped
 * silently and permanently. Nothing else in this codebase reads Issue comments.
 *
 * That is the SAME failure the constant's own header warns about — "filing
 * into one repo and reading replies from another would make every notification
 * look unanswered forever" — arriving from the other direction, and it is why
 * the move needed this second line rather than the single identifier the
 * previous session's note predicted. That note was written before the client
 * had ever replied to anything.
 *
 * `owner_email_notice`'s TRANSITION FALLBACK already carries the same decision
 * for the same reason; this is that decision applied to the path that reads
 * replies rather than the one that links to them.
 *
 * The public entry is a TRANSITION, not a permanent second channel. When the
 * owner closes the twelve public Issues, this list drops back to one and
 * nothing else changes.
 */
const OWNER_ISSUE_READ_REPOS = [BACKOFFICE_REPO_NAME, REPO_NAME];

/**
 * Classifies every owner-channel Issue across `OWNER_ISSUE_READ_REPOS`, each
 * entry tagged with the repository it came from.
 *
 * The `repo` tag is what makes the union safe: Issue numbers are per-repository
 * and will collide across the two, so no downstream reader may look one up by
 * number alone. `recordIssueReplies()` reads it; `selectNotificationItems()`
 * ignores it, which is correct — an unanswered Issue escalates on its age, not
 * on its address.
 */
async function readBackOwnerIssues(env, today) {
  const out = [];
  for (const repo of OWNER_ISSUE_READ_REPOS) {
    const classified = classifyOwnerIssueReadback(await fetchOwnerChannelIssues(env, repo), today);
    for (const entry of classified) out.push({ ...entry, repo });
  }
  return out;
}

/**
 * Reads reports/asset-pipeline/board.json.
 *
 * ── REWRITTEN 2026-08-16 (audit #9 / KFM-15, and #14 / KFM-13) ────────────
 *
 * This function used to return `{ items: [] }` on any failure, from a
 * `raw.githubusercontent.com` URL. Both halves were defects, and they
 * compounded:
 *
 *   1. **"could not read" was indistinguishable from "the board is empty."**
 *      Its two callers each do read-modify-WRITE-WHOLE-FILE. Neither writes
 *      when the item list is empty today, so no live harm has occurred — but
 *      that is a property of the current callers, not of this function, and
 *      the next caller that writes unconditionally would replace the real
 *      board with an empty one. `ok` now says which of the two happened.
 *
 *   2. **`raw.githubusercontent.com` is a CDN with its own cache** (minutes),
 *      and it returns no blob sha. So a read could be minutes stale, and the
 *      write that followed carried no way to notice. Concretely, in
 *      `runWorkDayCycle()` `maybeOpenAssetTask()` writes the board and then
 *      `checkProductVersionBumps()` re-reads it — through that cache — and
 *      writes the whole file back, discarding the `asset_task_issue_filed`
 *      flag the first one had just set. Two writers, one silently erased, no
 *      error anywhere.
 *
 * The API read returns the content AND the sha in one call, so the sha now
 * describes THE VERSION THIS CALLER READ and can be handed to
 * commitFileToRepo() as `expectedSha`. The raw URL is kept only as a
 * last-resort fallback, and a read that came from it is marked `sha: null` —
 * which every writer below treats as "not safe to write the whole file."
 *
 * @returns {Promise<{items: array, sha: string|null, ok: boolean, reason: string|null, source: string}>}
 */
async function fetchAssetBoard(env) {
  const path = 'reports/asset-pipeline/board.json';

  if (env.GITHUB_TOKEN) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          'User-Agent': 'data-center-agent-sim',
          Accept: 'application/vnd.github+json',
        },
      });
      if (res.ok) {
        const data = await res.json();
        const decoded = JSON.parse(decodeURIComponent(escape(atob(String(data.content || '').replace(/\n/g, '')))));
        return { items: decoded.items || [], ...decoded, sha: data.sha ?? null, ok: true, reason: null, source: 'api' };
      }
    } catch (err) {
      console.warn(`[asset-board] API read failed (${err?.message}) — falling back to the raw CDN, which cannot supply a sha.`);
    }
  }

  try {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/${path}`);
    if (!res.ok) return { items: [], sha: null, ok: false, reason: `raw_read_http_${res.status}`, source: 'raw' };
    const body = await res.json();
    // ok:true — the read succeeded — but sha:null, so no whole-file write may
    // ride on it. Readable and writable are different permissions here.
    return { ...body, items: body.items || [], sha: null, ok: true, reason: null, source: 'raw' };
  } catch (err) {
    return { items: [], sha: null, ok: false, reason: `raw_read_threw:${err?.message}`, source: 'raw' };
  }
}

/**
 * The one place that decides whether a read of the asset board may be written
 * back whole. Both writers call it, so the rule cannot hold in one and drift
 * in the other — the same reasoning as unifying the two pacers (audit #13).
 */
function assetBoardWritable(board) {
  if (!board?.ok) return { writable: false, reason: `board_unreadable:${board?.reason || 'unknown'}` };
  if (!board.sha) return { writable: false, reason: `board_read_without_sha:${board.source} — a whole-file write with no read-time sha cannot detect a concurrent write (KFM-15)` };
  return { writable: true, reason: null };
}

/**
 * Batches today's Hebrew capability-gap findings (filed in real time by
 * agent.flagCapabilityGap() during ask-and-evaluate — see
 * agents/agent-base.js and workers/gap-reports.js) into ONE file PER
 * PROJECT: reports/gaps/<project>/<date>.md. Replaces the old
 * fileModelEducationDigest() (English write-ups, GitHub Issue) entirely —
 * 2026-07-18 Q&A-engine rebuild, explicit requirement: NO GitHub Issue, for
 * either project. No-ops (returns []) if there were no gap findings today.
 */
async function fileGapDigests(env) {
  const grouped = await collectTodayGapReports(env);
  if (!grouped.length) return [];

  const dateStr = new Date().toISOString().slice(0, 10);
  const digests = [];

  for (const { project, entries } of grouped) {
    if (!entries.length) continue;
    const markdown = renderGapDigest(project, dateStr, entries);
    const reportPath = `reports/gaps/${project}/${dateStr}.md`;
    const plural = entries.length === 1 ? '' : 's';
    const commit = await commitFileToRepo(
      env, REPO_NAME, reportPath, markdown,
      `chore(agents): ${project} capability-gap digest — ${dateStr} (${entries.length} finding${plural}) [skip ci]`
    );
    digests.push({ project, count: entries.length, reportPath, committed: commit.committed });
  }

  return digests;
}

/**
 * Opens an asset-task for a queued asset-pipeline board item: files a
 * GitHub Issue (labels: asset-task, AGENT-N) describing the spec, and marks
 * the board item so it isn't re-filed. No-ops without env.GITHUB_TOKEN.
 */
async function fileAssetTaskIssue(env, item, ownerAgentIds) {
  const labels = ['asset-task', ...ownerAgentIds.map((id) => `AGENT-${id}`)];
  return fileGitHubIssue(env, REPO_NAME, {
    title: `[Asset Task] ${item.title}`,
    body: `Board item: \`${item.id}\`\nSpec: ${item.spec_file}\n\nSee the spec file for the full goal, schema, and acceptance criteria. Update reports/asset-pipeline/board.json's \`${item.id}\` entry as the work progresses.`,
    labels,
  });
}

/* ─────────────────────────────── Owner channel ──────────────────────────── */

/**
 * THE OWNER CHANNEL BLOCK — REQ-001's base, run once a day.
 *
 * Two acts, in this order, and the order is the contract:
 *
 *   1. **RECORD WHAT WAS READ.** Every owner message whose CONTENT the office
 *      has no receipt for gets one — in `channel/from-office/READ-LOG.md` (the
 *      file the owner can open) and in D1 `owner_channel_reads` (the table the
 *      report queries). The record is the deliverable; see owner-channel.js.
 *   2. **NOTIFY.** Submissions awaiting a decision, plus any question that has
 *      climbed the age ladder, go out as one GitHub Issue — and on the weekly
 *      heartbeat day one goes out even when there is nothing to say.
 *
 * ── WHY RECORDING RUNS FIRST, AND WHY A FAILED RECORD DOES NOT STOP IT ──
 *
 * If the receipt commit fails, the office has still read the message and must
 * still act on it. Blocking the notification on the receipt would let a GitHub
 * hiccup silence the client's channel — which is the failure mode this whole
 * feature exists to remove, reproduced inside the feature. So a failed receipt
 * is REPORTED in the block's return value and the notification proceeds.
 *
 * ── WHAT THIS BLOCK IS NOT ALLOWED TO DO ────────────────────────────────
 *
 * It never writes into `channel/from-owner/`. Not to mark a message read, not
 * to flip a `status:` line. `channel/README.md`'s one-directory-per-direction
 * rule holds, and the receipt lives in the office's own directory precisely so
 * that reading the client's mail never requires writing in his folder.
 */
/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE WEEKLY QA INSTRUMENTS — audit 2026-08-15 finding #8, wired 2026-08-15.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Two "signature" cross-agent QA instruments were fully built, marked
 * capability-SUPPLIED in `config/capability-manifest.json`, and reachable ONLY
 * by a human typing a trigger:
 *
 *   cross-embodiment comparison   `/api/agents/trigger`
 *                                 {"type":"learning_loop_embodiment_comparison"}
 *   review-the-reviewers          {"type":"learning_loop_review_the_reviewers"}
 *
 * No scheduled block referenced either, so as far as the audit could tell
 * NEITHER HAS EVER RUN IN PRODUCTION. The office's whole quality argument
 * rests on cross-agent review, and the two instruments that perform it had no
 * autonomous caller. That is KFM-10, on the machinery that matters most.
 *
 * ── WHY THIS BLOCK HAS NO KILL SWITCH OF ITS OWN ─────────────────────────
 *
 * Deliberate, and it is the whole lesson of the finding. Every recent feature
 * shipped with a switch defaulting OFF, and this project's own memory records
 * the Guides pipeline sitting gated-off awaiting an enable. A switch whose
 * purpose is to be left off is how a built capability becomes an unrun one —
 * which is the defect being closed here, not a pattern to repeat.
 *
 * So it rides on `improvement_loop_enabled` (live ON), and that is an honest
 * dependency rather than a borrowed one: the comparison reads exactly the rows
 * `workers/improvement-loop.js` writes, and with the loop off there is nothing
 * to compare. Same reasoning `deliverable-lifecycle.js` used for riding on
 * `office_context_enabled`.
 *
 * Cost is not a reason for a switch here: one D1 SELECT, one markdown commit,
 * and ZERO model calls.
 *
 * ── WHAT "REVIEW THE REVIEWERS" CAN AND CANNOT DO UNATTENDED ─────────────
 *
 * `reviewTheReviewers()` VALIDATES a record; it does not make one. A3 gives no
 * trigger for flagging a reviewer, and inventing one would be this session
 * writing office policy. So the autonomous half is the half that is structural:
 *
 *   - WHOSE TURN — a fixed rotation over the three reviewers by ISO week, so
 *     each is reviewed in turn rather than only when someone complains. A3
 *     reads as a standing practice, and a rotation is the only reading that
 *     runs without a trigger nobody has defined.
 *   - WHO REVIEWS — structurally determined: the other two. Never chosen.
 *   - WHO DECIDES — the CEO. Never chosen.
 *
 * The VERDICT is left open, because the CEO has not given one. The block opens
 * the round and records that it is open; it never fills in an outcome. A record
 * that manufactured the CEO's decision would be the very fabrication OB-075
 * spent this morning gating.
 */
async function processQaInstrumentsBlock(env, opts = {}) {
  if (!opts.bypassGate && !(await improvementLoopEnabled(env))) {
    console.log('[qa-instruments] improvement_loop_enabled is not true — block is a no-op');
    return { skipped: true, reason: 'improvement_loop_disabled' };
  }

  const today = todayDateStr();
  const out = { today, comparison: null, reviewRound: null, committed: null, errors: [] };

  /* ── 1. the Lead QA's cross-embodiment comparison, against live D1 ── */
  let rendered = 'Cross-embodiment comparison did not run.';
  try {
    const comparison = await runCrossEmbodimentComparison(env);
    if (comparison.ok) comparison.generatedAt = new Date().toISOString();
    out.comparison = comparison;
    rendered = renderComparisonFinding(comparison, { date: today });
  } catch (err) {
    out.errors.push(`embodiment_comparison: ${err?.message}`);
    rendered = `Cross-embodiment comparison THREW: ${err?.message}. Recorded rather than omitted — a missing section and a failed one are different facts (KFM-13).`;
  }

  /* ── 2. review-the-reviewers, opened on rotation ── */
  const THREE = [6, 7, 8];
  // ISO-week rotation. `weekNumber` comes from the caller's year state so the
  // rotation is derived from the office's own clock, not from a fresh Date()
  // this function would have to trust.
  const week = Number.isInteger(opts.weekNumber) ? opts.weekNumber : 0;
  const flaggedReviewer = THREE[week % THREE.length];
  const reviewingPair = THREE.filter((id) => id !== flaggedReviewer);
  const validation = reviewTheReviewers({
    flaggedReviewer,
    reviewingPair,
    decidedBy: 11,
    architectOpinion: null,
  });
  out.reviewRound = {
    week,
    flaggedReviewer,
    reviewingPair,
    valid: validation.valid,
    reason: validation.reason || null,
    // OPEN, never decided here. See this function's header.
    outcome: 'OPEN — awaiting the CEO, who has not decided; this block opens the round and does not close it',
  };

  /* ── 3. one file, in back-office ── */
  // FULL ISO DATE in the filename, not `week-NN` — audit finding #2 / KFM-17:
  // a week index with no year silently overwrites last year's published file
  // at rollover, and this is a NEW generated path, so it starts correct rather
  // than joining the ~319-day-out problem.
  const path = `campus/shared/qa-instruments/${today}-qa-instruments.md`;
  const body = [
    `# Weekly QA instruments — ${today}`,
    '',
    '_Produced autonomously by the Friday `qa_instruments` block. Before 2026-08-15 both',
    'instruments below existed and were reachable only by a manual admin trigger; as far as',
    'the 2026-08-15 audit could tell, neither had ever run in production (finding #8)._',
    '',
    rendered,
    '',
    `## Review-the-reviewers — round opened, week ${week}`,
    '',
    `- **Under review:** Agent ${flaggedReviewer}`,
    `- **Reviewed by:** Agent ${reviewingPair.join(', Agent ')} — the other two, structurally, never chosen`,
    '- **Decided by:** the CEO (Agent 11)',
    '- **Architect:** present for technical opinion only — opinion, not verdict (A3)',
    `- **Structural validation:** ${validation.valid ? 'PASSED' : `REFUSED — ${validation.reason}`}`,
    '- **Outcome:** OPEN. The CEO has not decided. This block opens the round on the',
    '  rotation and records that it is open; it does not invent a verdict.',
    '',
    '> A3: any change to one of the three reviewers is reported to the owner in the',
    '> weekly report — for visibility, not approval.',
    '',
    out.errors.length ? `## Errors\n\n${out.errors.map((e) => `- ${e}`).join('\n')}` : '',
  ].filter((l) => l !== '').join('\n');

  try {
    await commitFileToRepo(env, BACKOFFICE_REPO_NAME, path, body,
      `chore(office): weekly QA instruments ${today} [skip ci]`);
    out.committed = path;
  } catch (err) {
    out.errors.push(`commit: ${err?.message}`);
  }
  out.rendered = body;
  return out;
}

/* ═══════════════════════ The admin desk (2026-08-17) ══════════════════════ */

/** Where a lifecycle proposal is written. The office decides here; the warehouse-side run applies. */
const LIFECYCLE_INBOX_DIR = 'campus/shared/lifecycle-inbox';

/**
 * The `reports.type` every desk files under.
 *
 * A DISTINCT type, not `status`. The drought this block exists to end is
 * measured as *"no `reports` row since 2026-08-11"*, and filing under `status`
 * would end it in a way nobody could tell apart from the 16:00 AI-experience
 * reports the case workers file. A separate value keeps "the admin tier
 * produced" answerable by a query rather than by inference.
 */
const ADMIN_DESK_REPORT_TYPE = 'admin_desk';

/** Cap on how much of a deliverable's own text a reviewer is shown, in characters. */
const ADMIN_DESK_ARTIFACT_CHARS = 6000;

/**
 * The files an admin-desk reviewer will try to read, in order, before deciding
 * it cannot see the artifact. SPEC first — a review against the specification
 * is the review the lifecycle asks for; README is the fallback.
 */
const ADMIN_DESK_ARTIFACT_FILES = Object.freeze(['SPEC.md', 'README.md']);

/**
 * A judgment-lane call for one desk. Returns `{ text, provider, reason }` and
 * never throws — a desk that cannot reach a model must produce nothing, not
 * half a review.
 *
 * `maxTokens` is deliberately above Cerebras' `MIN_OUTPUT_TOKENS` (512): that
 * model's reasoning is charged against `max_tokens` and a small budget comes
 * back empty with `finishReason: 'length'`, which is the defect the routing
 * supervised test found on 2026-08-10 and which an HTTP 200 hid.
 */
async function adminDeskJudgment(env, { agentId, systemPrompt, prompt, maxTokens = 1200, eventId }) {
  try {
    const routed = await routeTaskTypeCall(env, 'judgment', {
      prompt, systemPrompt, maxTokens, agentId: eventId || `admin-desk-${agentId}`,
    });
    if (!routed.ok) return { text: null, provider: routed.provider || null, reason: routed.reason || 'routed_call_failed' };
    const text = routed.result?.text ?? null;
    // An empty string from a 200 is NOT a success. Same check `routeTask()`
    // learned to make: `finishReason` existed for exactly this and was not read.
    if (!text || !String(text).trim()) return { text: null, provider: routed.provider, reason: 'empty_text_from_provider' };
    return { text: String(text).trim(), provider: routed.provider, reason: null };
  } catch (err) {
    return { text: null, provider: null, reason: `threw: ${err?.message}` };
  }
}

/**
 * Pulls a labelled decision word out of a model's answer.
 *
 * ── WHY THIS IS NOT AN INLINE REGEX (2026-08-17) ──────────────────────────
 *
 * It was three of them, and one lost a real verdict on the first live run.
 * Agent 5 was asked to end with `VERDICT: approve|revise|abstain`, wrote
 * **`**Verdict:** revise`** — markdown emphasis, which is what a model that has
 * been writing bold headings for four hundred words does — and
 * `/VERDICT:\s*(...)/i` did not match the `**` between the colon and the word.
 * The review was filed with `verdict: null`, indistinguishable from a reviewer
 * who never reached a verdict at all.
 *
 * A parser strict enough to drop a decision that was plainly made is not
 * refusing, it is losing. So emphasis and stray colons are stripped before
 * matching, and a genuine no-match still returns null for the caller to refuse
 * on — the distinction that matters is kept, the formatting noise is not.
 */
function parseDecisionWord(text, label, allowed) {
  const flat = String(text || '').replace(/[*_`]/g, ' ').replace(/\s+/g, ' ');
  const m = new RegExp(`${label}\\s*:?\\s*:?\\s*(${allowed.join('|')})\\b`, 'i').exec(flat);
  return m ? m[1].toLowerCase() : null;
}

/** Files one admin-desk `reports` row. Best-effort — a lost row never costs the work. */
async function fileAdminDeskReport(env, agentId, title, content) {
  try {
    if (!env.DB) return null;
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO reports (id, agent_id, type, title, content, severity) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, agentId, ADMIN_DESK_REPORT_TYPE, title, content, 'info').run();
    return id;
  } catch (err) {
    console.warn(`[admin-desk] report row for agent ${agentId} failed: ${err?.message}`);
    return null;
  }
}

/**
 * ── THE ADMIN DESK ─────────────────────────────────────────────────────────
 *
 * Four desks, four real queues, and NOTHING WRITTEN when a queue is empty. See
 * `workers/admin-desk.js` for which queue each desk reads and who fills it.
 *
 * ── NO KILL SWITCH OF ITS OWN ──────────────────────────────────────────────
 *
 * Deliberate, and the same decision `deliverable-lifecycle.js` and the office
 * policy took: it rides on `office_context_enabled`, which is live ON. Three of
 * the four desks read the office snapshot and genuinely cannot work without it,
 * so a second flag would guard nothing new — and an eleventh switch whose
 * documented state goes stale the moment someone toggles it is `OB-040`'s
 * problem made worse. There is also a specific trap here: a block built to end
 * a six-day output drought, deployed defaulting OFF, ends nothing.
 *
 * ── AN UNREADABLE QUEUE IS NOT AN EMPTY ONE ────────────────────────────────
 *
 * If the office snapshot or its lifecycle index cannot be read, that is
 * reported as an error and the desks that need it produce nothing *for a stated
 * reason*. It is never collapsed into "queue empty". This project's dominant
 * defect is absence read as fact.
 */
async function processAdminDeskBlock(env, opts = {}) {
  if (!opts.bypassGate && !(await officeContextEnabled(env))) {
    console.log('[admin-desk] office_context_enabled is not true — block is a no-op');
    return { skipped: true, reason: 'office_context_disabled' };
  }

  const today = todayDateStr();
  const out = { today, desks: [], produced: 0, filed: [], errors: [] };

  /* ── the office snapshot: the board and the lifecycle's in-flight index ── */
  let snapshot = null;
  try {
    snapshot = await getOfficeSnapshot(env, { allowFetch: true });
  } catch (err) {
    out.errors.push(`office snapshot threw: ${err?.message}`);
  }
  const records = snapshot?.lifecycle?.records || null;
  const boardTasks = snapshot?.board?.tasks || null;
  const lifecycleReadable = Array.isArray(records) && Array.isArray(boardTasks);
  if (!lifecycleReadable) {
    out.errors.push(
      'the lifecycle in-flight index or the board could not be read from the office snapshot — '
      + 'the review and approval desks produced nothing because their queue was UNREADABLE, which is not the same fact as empty'
    );
  }

  const { carried, frozen } = lifecycleReadable
    ? carriedDeliverables(records, boardTasks)
    : { carried: [], frozen: [] };
  out.frozen = frozen;

  /* ══════════════ Desk 1 — deliverable review (agents 5-9, 11-13) ═════════ */
  const reviewDesk = { desk: 'deliverable_review', agentIds: [], queued: 0, produced: 0, reason: null };
  if (lifecycleReadable) {
    // What is already sitting in the inbox, per slug. Without this the desk
    // re-files the same reviews every weekday: `owed_by` does not move until
    // the next `scripts/lifecycle.mjs ingest`, which may be days away.
    const alreadyFiled = {};
    const inReview = carried.filter((r) => r?.stage === 'IN-REVIEW');
    for (const record of inReview) {
      const dir = await fetchBackOfficeDir(env, `${LIFECYCLE_INBOX_DIR}/${record.slug}`);
      if (dir.reason) {
        // A 404 means no inbox folder yet, which is a real empty. Anything else
        // is unreadable, and an unreadable inbox must NOT be read as "nothing
        // filed" — that would re-file reviews already waiting to be ingested.
        if (!/HTTP 404/.test(dir.reason)) {
          out.errors.push(`${record.slug}: inbox unreadable (${dir.reason}) — no review drawn for it this tick`);
          alreadyFiled[record.slug] = (record.owed_by || []).map(Number);
        } else {
          alreadyFiled[record.slug] = [];
        }
        continue;
      }
      alreadyFiled[record.slug] = (dir.entries || [])
        .map((e) => /-review-agent(\d+)\.json$/.exec(e?.name || ''))
        .filter(Boolean)
        .map((m) => Number(m[1]));
    }

    const assigned = reviewAssignments(carried, { alreadyFiled });
    reviewDesk.queued = assigned.draw.length + assigned.deferred.length;
    reviewDesk.deferred = assigned.deferred.map((d) => `Agent ${d.agentId} on ${d.slug} (${d.kind})`);
    reviewDesk.skipped = assigned.skipped;

    const artifactCache = new Map();
    for (const item of assigned.draw) {
      // The artifact itself, so the reviewer reviews the thing and not a
      // summary of it. A deliverable in the warehouse is not readable from the
      // Worker at all — nothing here fetches from that repo — and in that case
      // this desk REFUSES to file a review rather than reviewing a description.
      if (!artifactCache.has(item.slug)) {
        let found = null;
        for (const file of ADMIN_DESK_ARTIFACT_FILES) {
          const got = await fetchBackOfficeFile(env, `${LOCATIONS['back-office-tools'].dir}/${item.slug}/${file}`);
          if (got.text) { found = { file, text: got.text }; break; }
        }
        artifactCache.set(item.slug, found);
      }
      const artifact = artifactCache.get(item.slug);
      if (!artifact) {
        out.errors.push(
          `${item.slug}: no readable artifact under back-office \`${LOCATIONS['back-office-tools'].dir}/${item.slug}/\` `
          + `(${ADMIN_DESK_ARTIFACT_FILES.join(' or ')}). It is most likely warehouse-located, which nothing in the Worker reads. `
          + 'NO REVIEW WAS FILED — a review of a deliverable the reviewer could not see is fabricated participation.'
        );
        continue;
      }

      const config = getAgentConfig(item.agentId);
      const gapLines = (item.gaps || []).length
        ? (item.gaps || []).map((g) => `- ${g}`).join('\n')
        : '_No gaps have been raised on this deliverable yet._';
      const owed = item.kind === 'review'
        ? 'You are a REQUIRED reviewer. A full reasoned review is owed: what you checked, what you found, and a verdict of approve or revise.'
        : 'You are not a required reviewer here. A brief comment or an EXPLICIT abstention is owed. Silence is never approval — if you have nothing to add, say so and abstain in words.';

      const judged = await adminDeskJudgment(env, {
        agentId: item.agentId,
        eventId: `admin-desk:review:${item.slug}:${item.agentId}`,
        // 2200, not 1400. Measured on the first live run (2026-08-17): both
        // reviews ran out of budget mid-sentence and neither reached its
        // VERDICT line, so both were filed with `verdict: null`. A review whose
        // verdict was cut off is not an abstention — it is an unreadable review.
        maxTokens: 2200,
        systemPrompt:
          `You are ${config?.name || `Agent ${item.agentId}`}, ${config?.role || 'an admin'} in an AI office. `
          + `${config?.personality?.core || ''} Review in character, in English, and be specific.`,
        prompt: [
          `Round ${item.round} review of the deliverable \`${item.slug}\`${item.boardTask ? ` (board task ${item.boardTask})` : ''}.`,
          '',
          owed,
          '',
          /*
           * ── WHAT YOU WERE AND WERE NOT GIVEN (2026-08-17) ────────────────
           *
           * Added after reading the FIRST live run back. Agent 6's review said
           * it had *"Ran the script against three local test repositories"* and
           * *"Executed each of the supported CLI flags"*. It had been handed
           * one markdown file and had run nothing.
           *
           * That is fabricated evidence in a record the lifecycle applies, and
           * it is the worst failure this desk could have: a review claiming
           * execution is exactly the artifact a later reader would trust most.
           * The office's own rule — distinguish verified-by-running from
           * inferred-by-reading — has to be stated IN the prompt, because a
           * persona asked to "review" a spec will narrate the review it would
           * have done if nobody tells it what it actually has.
           */
          'WHAT YOU HAVE, EXACTLY: the one document reproduced below, and the gap list above. Nothing else.',
          'You have NOT run this code. You have NOT executed any command, opened any file other than the one below,',
          'inspected any source file, or observed any output. Do not write as though you had — no "I ran", no "I executed",',
          'no "I tested", no invented results. Review what you can actually see, and where a judgement needs something you',
          'were not given, SAY SO AND NAME WHAT YOU WOULD NEED. An honest "I cannot tell from this" is a real review finding',
          'here; a fabricated test run is the one thing that would make this review worthless.',
          '',
          `Gaps already raised on it by others (${item.openGaps} open):`,
          gapLines,
          '',
          `The deliverable's own \`${artifact.file}\`, in full as given to you:`,
          '',
          artifact.text.slice(0, ADMIN_DESK_ARTIFACT_CHARS),
          artifact.text.length > ADMIN_DESK_ARTIFACT_CHARS
            ? `\n[TRUNCATED at ${ADMIN_DESK_ARTIFACT_CHARS} characters of ${artifact.text.length} — say so if what you needed was past the cut.]`
            : '',
          '',
          'Be concise — under 400 words. Do not repeat a gap already listed above.',
          'End with a single line, and leave room for it: VERDICT: approve|revise|abstain',
        ].filter((l) => l !== '').join('\n'),
      });

      if (!judged.text) {
        out.errors.push(`${item.slug}/agent ${item.agentId}: judgment lane produced nothing (${judged.reason}) — no review filed`);
        continue;
      }

      const verdict = parseDecisionWord(judged.text, 'VERDICT', ['approve', 'revise', 'abstain']);
      const proposal = {
        kind: 'review',
        agent_id: item.agentId,
        review_kind: item.kind === 'review' ? 'review' : (verdict === 'abstain' ? 'abstain' : 'comment'),
        round: item.round,
        verdict,
        text: judged.text,
        at: new Date().toISOString(),
        // Provenance, because a record that cannot say what produced it cannot
        // be audited later. Named for what it is: an autonomous block, not a
        // supervised session.
        source: `office-AI-agents admin_desk block, ${today}, provider ${judged.provider || 'unrecorded'}`,
      };
      const inboxPath = `${LIFECYCLE_INBOX_DIR}/${item.slug}/${today}-review-agent${String(item.agentId).padStart(2, '0')}.json`;
      try {
        const commit = await commitFileToRepo(
          env, BACKOFFICE_REPO_NAME, inboxPath, `${JSON.stringify(proposal, null, 2)}\n`,
          `office: Agent ${item.agentId} ${proposal.review_kind} on ${item.slug} round ${item.round} [skip ci]`
        );
        if (!commit.committed) {
          out.errors.push(`${inboxPath}: not committed (${commit.reason || 'no reason given'})`);
          continue;
        }
      } catch (err) {
        out.errors.push(`${inboxPath}: commit threw — ${err?.message}`);
        continue;
      }

      await fileAdminDeskReport(
        env, item.agentId,
        `Deliverable review — ${item.slug} round ${item.round} (${proposal.review_kind})`,
        `${judged.text}\n\n---\nFiled to ${inboxPath}. Applies to the lifecycle record on the next \`scripts/lifecycle.mjs ingest\`.`
      );
      reviewDesk.agentIds.push(item.agentId);
      reviewDesk.produced += 1;
      out.filed.push(inboxPath);
    }
    if (!reviewDesk.produced && reviewDesk.queued) reviewDesk.reason = 'every drawn review failed its artifact read, its model call or its commit — see errors';
  } else {
    reviewDesk.reason = 'queue unreadable, not empty';
  }
  out.desks.push(reviewDesk);

  /* ══════════════════════ Desk 2 — CEO approval (11) ═════════════════════ */
  const ceoDesk = { desk: 'ceo_approval', agentIds: [], queued: 0, produced: 0, reason: null };
  if (lifecycleReadable) {
    const awaiting = approvalQueue(carried);
    ceoDesk.queued = awaiting.length;
    for (const record of awaiting.slice(0, 1)) {
      const config = getAgentConfig(DESK_CEO_ID);
      const judged = await adminDeskJudgment(env, {
        agentId: DESK_CEO_ID,
        eventId: `admin-desk:approval:${record.slug}`,
        maxTokens: 1000,
        systemPrompt: `You are ${config?.name || 'The CEO'}, ${config?.role || 'Founder & Chief Executive'}. You are the ONE forward exit of this office's deliverable lifecycle. Nothing reaches the client without you.`,
        prompt: [
          `\`${record.slug}\` has reached AWAITING-APPROVAL at round ${record.round}.`,
          `Open gaps: ${record.open_gaps}. ${record.convergence_note || ''}`,
          record.recommendation ? `The office's recommendation: ${record.recommendation}` : '',
          '',
          'Approve it, or return it to the loop. Returning is not a failure — there is no cap on rounds and a deliverable going round without converging is a finding, not a reason to ship.',
          'End with a single line: DECISION: approve|return',
        ].filter((l) => l !== '').join('\n'),
      });
      if (!judged.text) {
        out.errors.push(`${record.slug}: CEO approval call produced nothing (${judged.reason}) — nothing filed`);
        continue;
      }
      const decision = parseDecisionWord(judged.text, 'DECISION', ['approve', 'return']);
      if (!decision) {
        out.errors.push(`${record.slug}: the CEO's answer carried no parseable DECISION line — REFUSED rather than guessed, nothing filed`);
        continue;
      }
      const inboxPath = `${LIFECYCLE_INBOX_DIR}/${record.slug}/${today}-approval-agent11.json`;
      try {
        const commit = await commitFileToRepo(
          env, BACKOFFICE_REPO_NAME, inboxPath,
          `${JSON.stringify({ kind: 'approval', by: DESK_CEO_ID, decision, reason: judged.text, at: new Date().toISOString(), source: `office-AI-agents admin_desk block, ${today}` }, null, 2)}\n`,
          `office: CEO ${decision} on ${record.slug} [skip ci]`
        );
        if (!commit.committed) { out.errors.push(`${inboxPath}: not committed (${commit.reason || 'no reason'})`); continue; }
      } catch (err) { out.errors.push(`${inboxPath}: commit threw — ${err?.message}`); continue; }
      await fileAdminDeskReport(env, DESK_CEO_ID, `CEO decision — ${record.slug} (${decision})`, judged.text);
      ceoDesk.agentIds.push(DESK_CEO_ID);
      ceoDesk.produced += 1;
      out.filed.push(inboxPath);
    }
  } else {
    ceoDesk.reason = 'queue unreadable, not empty';
  }
  out.desks.push(ceoDesk);

  /* ═════════════ Desk 3 — the probation decision meeting (7, 6, 8) ═══════ */
  const probationDesk = { desk: 'probation_decision', agentIds: [], queued: 0, produced: 0, reason: null };
  try {
    const due = await probationsDueForDecision(env);
    const { draw, deferred } = probationDecisionDraw(due);
    probationDesk.queued = due.length;
    probationDesk.deferred = deferred.map((r) => r.id);

    for (const row of draw) {
      const target = getAgentConfig(row.agent_id);
      const shared = [
        `Probation on ${target?.name || `Agent ${row.agent_id}`} — aspect "${row.aspect}", round ${row.rounds}.`,
        `The provisional change under review:\n${row.entry_text}`,
        `It has been live for ${row.action_count} recorded actions (the measurement window is ${PROBATION_ACTIONS_TARGET}).`,
      ].join('\n\n');

      const behaviour = await adminDeskJudgment(env, {
        agentId: PROBATION_TEAM_LEAD, maxTokens: 700, eventId: `admin-desk:probation:${row.id}:behaviour`,
        systemPrompt: `You are ${getAgentConfig(PROBATION_TEAM_LEAD)?.name || 'The Team Lead'}, Agent Coach & Team Manager. In this meeting you present BEHAVIOUR only — not quality, and not a verdict.`,
        prompt: `${shared}\n\nPresent what this change did to the agent's behaviour over the window. Evidence, not persuasion.`,
      });
      const quality = await adminDeskJudgment(env, {
        agentId: PROBATION_QA, maxTokens: 700, eventId: `admin-desk:probation:${row.id}:quality`,
        systemPrompt: `You are ${getAgentConfig(PROBATION_QA)?.name || 'The QA'}, Quality Assurance. In this meeting you present QUALITY metrics only — not behaviour, and not a verdict.`,
        prompt: `${shared}\n\nPresent what this change did to the agent's work quality over the window. Evidence, not persuasion.`,
      });

      if (!behaviour.text || !quality.text) {
        out.errors.push(
          `probation ${row.id}: both axes must be presented before the Lead QA may decide (A3). `
          + `behaviour=${behaviour.text ? 'ok' : behaviour.reason}, quality=${quality.text ? 'ok' : quality.reason}. NO DECISION RECORDED.`
        );
        continue;
      }

      const verdictCall = await adminDeskJudgment(env, {
        agentId: PROBATION_DECIDER, maxTokens: 800, eventId: `admin-desk:probation:${row.id}:verdict`,
        systemPrompt: `You are ${getAgentConfig(PROBATION_DECIDER)?.name || 'The Lead QA'}, Chief Quality Officer. You, and only you, decide this. Both axes have been presented.`,
        prompt: [
          shared, '',
          `The Team Lead on behaviour:\n${behaviour.text}`, '',
          `The QA on quality:\n${quality.text}`, '',
          'Decide on both axes. `kept` makes the change permanent, `dropped` reverts the live file, `extended` gives it one more round.',
          'End with a single line: OUTCOME: kept|dropped|extended',
        ].join('\n'),
      });
      const outcome = parseDecisionWord(verdictCall.text, 'OUTCOME', ['kept', 'dropped', 'extended']);
      if (!outcome) {
        out.errors.push(`probation ${row.id}: the Lead QA's answer carried no parseable OUTCOME line — REFUSED rather than guessed, nothing applied`);
        continue;
      }

      // Validation and application stay where they already are: recordDecision()
      // decides whether a decision is VALID, applyDecision() makes a valid one
      // take effect. This block supplies the meeting, not a second gate.
      const validated = recordDecision({
        probationId: row.id, outcome, decidedBy: PROBATION_DECIDER,
        teamLeadBehavior: behaviour.text, qaQualityMetrics: quality.text,
        evidence: { actionCount: row.action_count, rounds: row.rounds, source: `admin_desk block ${today}` },
      });
      if (!validated.valid) {
        out.errors.push(`probation ${row.id}: recordDecision() refused — ${validated.reason}`);
        continue;
      }
      const applied = await applyDecision(env, {
        probationId: validated.decision.probationId, outcome: validated.decision.outcome,
        decidedBy: PROBATION_DECIDER, decidingActorId: PROBATION_DECIDER,
        evidence: { teamLeadBehavior: behaviour.text, qaQualityMetrics: quality.text, ...validated.decision.evidence },
      });

      for (const [agentId, text, label] of [
        [PROBATION_TEAM_LEAD, behaviour.text, 'behaviour presented'],
        [PROBATION_QA, quality.text, 'quality presented'],
        [PROBATION_DECIDER, verdictCall.text, `decided: ${outcome}`],
      ]) {
        await fileAdminDeskReport(env, agentId, `Probation decision — ${target?.name || `Agent ${row.agent_id}`}, "${row.aspect}" (${label})`, text);
        probationDesk.agentIds.push(agentId);
      }
      probationDesk.produced += 1;
      probationDesk.applied = applied;
    }
  } catch (err) {
    out.errors.push(`probation desk threw: ${err?.message}`);
    probationDesk.reason = `threw: ${err?.message}`;
  }
  out.desks.push(probationDesk);

  /* ══════════════ Desk 4 — the IT Chief's incident triage (5) ════════════ */
  const incidentDesk = { desk: 'incident_triage', agentIds: [], queued: 0, produced: 0, reason: null };
  try {
    // The cutoff is built in D1's own `'YYYY-MM-DD HH:MM:SS'` shape and compared
    // as a string — see recentIncidents(). `new Date()` on that format is
    // implementation-defined and this is not a place to find that out.
    const cutoff = new Date(Date.now() - INCIDENT_WINDOW_HOURS * 3600 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const q = env.DB
      ? await env.DB.prepare(
        `SELECT created_at, title, content FROM reports WHERE type = 'incident' AND created_at >= ? ORDER BY created_at DESC LIMIT 60`
      ).bind(cutoff).all()
      : { results: [] };
    const { triaged, total, overflow } = recentIncidents(q.results || [], cutoff);
    incidentDesk.queued = total;

    if (triaged.length) {
      const config = getAgentConfig(IT_CHIEF_ID);
      const judged = await adminDeskJudgment(env, {
        agentId: IT_CHIEF_ID, maxTokens: 1000, eventId: 'admin-desk:incidents',
        systemPrompt: `You are ${config?.name || 'The IT Chief'}, ${config?.role || 'Senior IT Admin'}. ${config?.personality?.core || ''} You triage; you do not narrate.`,
        prompt: [
          `${total} incident(s) were recorded in this office in the last ${INCIDENT_WINDOW_HOURS} hours.`,
          overflow ? `You are shown the newest ${MAX_INCIDENTS_PER_NOTE}; ${overflow} more exist and are NOT below. Say so in your triage.` : '',
          '',
          triaged.map((r) => `- [${r.created_at}] ${r.title} — ${String(r.content || '').slice(0, 300)}`).join('\n'),
          '',
          'For each distinct failure: is it the same thing recurring, or something new? Which needs action from a person, and which is noise this office should stop recording as an incident? Be short and be specific. If none of it needs action, say that plainly.',
        ].filter((l) => l !== '').join('\n'),
      });
      if (!judged.text) {
        out.errors.push(`incident triage: judgment lane produced nothing (${judged.reason}) — nothing filed`);
        incidentDesk.reason = judged.reason;
      } else {
        await fileAdminDeskReport(
          env, IT_CHIEF_ID,
          `Incident triage — ${total} in ${INCIDENT_WINDOW_HOURS}h`,
          `${judged.text}\n\n---\nTriaged ${triaged.length} of ${total} incident rows since ${cutoff}.`
        );
        incidentDesk.agentIds.push(IT_CHIEF_ID);
        incidentDesk.produced = 1;
        incidentDesk.overflow = overflow;
      }
    }
  } catch (err) {
    out.errors.push(`incident desk threw: ${err?.message}`);
    incidentDesk.reason = `threw: ${err?.message}`;
  }
  out.desks.push(incidentDesk);

  out.produced = out.desks.reduce((n, d) => n + (d.produced || 0), 0);
  out.summary = deskSummary(out.desks);
  out.anythingProduced = producedAnything(out.desks);

  // NO BLOCK ARTIFACT ON AN EMPTY DAY. Every desk that produced something has
  // already written its own real artifact — an inbox proposal, a `reports` row,
  // an applied probation decision. A summary file committed on a day when all
  // four queues were empty would be exactly the thing this block was built to
  // stop being: output produced because a block is scheduled.
  console.log(`[admin-desk] ${today}: ${out.produced} produced across ${out.desks.length} desks; ${out.errors.length} error(s)`);
  return out;
}

async function processOwnerChannelBlock(env, opts = {}) {
  const sim = await getSimulationState(env);
  if (!opts.bypassGate && !(await ownerChannelEnabled(env))) {
    console.log('[owner-channel] owner_channel_enabled is not true — block is a no-op');
    return { skipped: true, reason: 'owner_channel_disabled' };
  }

  const today = todayDateStr();

  // allowFetch: this runs once a day, which is exactly the caller class
  // getOfficeSnapshot()'s `allowFetch` was written for.
  const snapshot = await getOfficeSnapshot(env, { allowFetch: true });
  if (!snapshot) {
    return { skipped: true, reason: 'office_context_disabled — the owner channel rides on it and does not carry a second switch for the same fact' };
  }

  const out = { today, recorded: [], receiptCommitted: null, notified: null, errors: [...(snapshot.errors || [])] };

  /* ── 1. the read record ── */
  const messages = snapshot.owner?.messages || [];
  const known = new Set((snapshot.owner?.readLog?.records || []).map((r) => r.key));
  const fresh = messages.filter((m) => !known.has(readKey(m)));

  if (fresh.length) {
    const rows = [...(snapshot.owner.readLog?.records || [])];
    for (const m of fresh) {
      const row = {
        readAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
        key: readKey(m),
        cycle: `owner_channel ${today}`,
        note: `${m.kind} · ${m.title}`,
      };
      rows.push(row);
      out.recorded.push(row.key);
      await recordOwnerRead(env, { message: m, cycle: row.cycle, note: row.note });
    }

    const commit = await commitFileToRepo(
      env, BACKOFFICE_REPO_NAME, READ_LOG_PATH, renderReadLog(rows),
      `chore(office): read ${fresh.length} owner message(s) — ${today} [skip ci]`
    );
    out.receiptCommitted = commit.committed;
    if (!commit.committed) {
      // LOUD, and it does not stop the notification. A lost receipt is a lost
      // measurement; a silenced client channel is lost work.
      const reason = `READ RECEIPT NOT WRITTEN — ${commit.reason || 'unknown'}. The office read ${fresh.length} owner message(s) and cannot prove it; they will report as UNREAD until this clears.`;
      console.error(`[owner-channel] ${reason}`);
      out.errors.push(reason);
    }
  }

  /* ── 2. the notification ── */
  //
  // HEARTBEAT DAY = Sunday, the office's first working day. Chosen so a missing
  // heartbeat is noticed at the START of a week rather than discovered at the
  // end of one, and so it never lands on Saturday, which A13 makes a rest day.
  //
  // `opts.forceHeartbeat` exists for ONE reason: the supervised pre-enable run.
  // With no owner messages and no submissions, a weekday `owner_channel_block`
  // correctly skips — which proves the gating and proves nothing about the send.
  // A channel that has never delivered anything is an unproven channel, and this
  // project's standing rule before flipping a switch is to run one real cycle and
  // read the result. So the supervised trigger may force the heartbeat.
  //
  // It is NOT reachable from the cron path — `runScheduledBlock()` calls this
  // with no opts — so it cannot make the office send a heartbeat every day by
  // accident.
  const isHeartbeatDay = opts.forceHeartbeat || new Date(`${today}T00:00:00Z`).getUTCDay() === 0;

  // Phase 1.2 (2026-08-11): the escalation ladder now covers owner-channel
  // Issues too, not only questions and submissions. Read back every
  // `[Office #N]` Issue's reply state before composing this cycle's
  // notification, so an unanswered one rises instead of going quiet.
  // SESSION 12 (2026-08-23): BOTH repositories — the new private target and
  // the twelve unmigrated public Issues, one of which carries the client's
  // first reply. See readBackOwnerIssues() for why reading only the new one
  // would have dropped it.
  const issueReadback = await readBackOwnerIssues(env, today);
  out.issueReadback = issueReadback;

  const items = selectNotificationItems({
    submissions: snapshot.submissions?.submissions || [],
    questions: ageQuestions(snapshot.questions?.questions || [], today),
    issueReadback,
    // 2026-08-23. A refused owner message used to reach only agent prompts,
    // where nobody could act on it (the folder is his, not theirs) and nobody
    // did — for six days, on the first real deliverable he ever assigned. It
    // now rides in the notification that actually reaches him, and because it
    // is an ITEM, a weekday with a refusal in it sends an Issue instead of
    // skipping as "nothing to report".
    refusedMessages: snapshot.owner?.malformed || [],
  });

  out.notified = await notifyOwner(env, {
    // ITEM C (2026-08-23): the private repo. `fileGitHubIssue()` derives the
    // permission key from the repo name itself (REPO_TO_PROJECT_KEY), so this
    // is gated against `back-office` (push:true) with no extra argument — and
    // a repo with push:false would be REDIRECTED here, not silently filed.
    postIssue: (e, issue) => fileGitHubIssue(e, OWNER_NOTIFY_REPO, issue),
  }, { items, today, isHeartbeatDay, force: !!opts.bypassGate });

  if (out.notified && out.notified.sent === false && !out.notified.skipped) {
    out.errors.push(`OWNER NOTIFICATION #${out.notified.seq ?? '?'} FAILED — ${out.notified.reason}. The office has NOT reached the client.`);
  }

  // Closing the loop (Phase 1.2): a replied-to Issue is recorded as evidence
  // the office read and acted on it, not left to infer from silence. An
  // unanswered one that just climbed a rung is named specifically, so this
  // line is itself the read-back record the daily report/console history
  // can point to — the same "recorded, not merely logged and forgotten"
  // requirement this project already applies to read receipts and failures.
  // ITEM D (2026-08-23): the reply is now READ, not merely counted, and it is
  // committed into the channel record so git stays the permanent history —
  // which is the property the old "reply in the repo, not here" instruction was
  // protecting, kept without making the client do the filing.
  out.issueReplies = await recordIssueReplies(env, OWNER_REPLY_RECORD_REPO, issueReadback)
    .catch((err) => {
      out.errors.push(`Could not record client replies from Issue comments — ${err?.message || err}. A reply may have been read and not filed.`);
      return [];
    });
  const newlyFiled = (out.issueReplies || []).filter((r) => r.committed);
  if (newlyFiled.length) {
    console.log(`[owner-channel] filed ${newlyFiled.length} client reply(ies) into the channel record: ${newlyFiled.map((r) => r.path).join(', ')}`);
  }

  const repliedTo = issueReadback.filter((ir) => ir.hasReply);
  const nowEscalated = issueReadback.filter((ir) => !ir.hasReply && ir.escalation?.inNotification);
  if (repliedTo.length) {
    console.log(`[owner-channel] read-back: Issue(s) ${repliedTo.map((ir) => `#${ir.number}`).join(', ')} have a reply (comment or closed) — acted on, not re-notified.`);
  }
  if (nowEscalated.length) {
    console.log(`[owner-channel] read-back: Issue(s) ${nowEscalated.map((ir) => `#${ir.number} (${ir.escalation.rung}, ${ir.escalation.days}d)`).join(', ')} unanswered — rising in this cycle's notification instead of going quiet.`);
  }

  console.log(`[owner-channel] ${today}: ${fresh.length} newly-read message(s), ${items.length} item(s) for the client, notification=${out.notified?.sent ? `sent #${out.notified.seq}` : (out.notified?.reason || 'not sent')}`);
  return { skipped: false, ...out, paused: !!sim.paused };
}

/* ──────────────────────── The Designer's assets (plan 5.1/5.2) ──────────── */

/**
 * Where an asset and its provenance note land.
 *
 * ── THE PATH IS NOT THE ONE THE PLAN NAMES, AND THAT IS DELIBERATE ───────
 *
 * Plan item 5.2 says `campus/agents/the-designer/assets/`. That path does not
 * exist and never did: the campus was laid out with a `<NN-slug>` convention
 * (`campus/agents/09-the-designer/`), and 5.2 predates it. Writing to the plan's
 * literal path would create a second, orphaned Designer folder beside the real
 * one — so the real one is used and the divergence is FLAGGED rather than
 * silently reconciled, per the standing rule that the owner decides which side
 * changes. Recorded in the plan's session log for 2026-08-10.
 *
 * ── BACK-OFFICE, NOT THE PUBLIC REPO ─────────────────────────────────────
 *
 * Assets are private until the publishing gate says otherwise. `commitFileToRepo()`
 * refuses a base64 write to the public repo outright, because A10's
 * pre-publication scan is a text scan that cannot read bytes — see its header.
 * ~~Putting an image on the Front is `OB-014`'s decision, which is not built.~~
 * **Updated 2026-08-16: the gate IS built** (`workers/front-gate.js`, the
 * `front_publish` trigger). It does not change this rule — `evaluateItem()`
 * criterion 4 refuses a base64 item at curation time as well, so an image is
 * now refused twice rather than once. Whether an image reaches the Front at all
 * needs a deliberate mechanism that does not exist yet, and proposing or
 * rejecting one is `OB-095`.
 */
const DESIGNER_ASSET_DIR = 'campus/agents/09-the-designer/assets';

/** Filename-safe slug. Refuses to invent one: an empty slug is the caller's
 *  error and a generated fallback would produce assets nobody can find by name. */
function assetSlug(raw) {
  const slug = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return slug || null;
}

/**
 * ONE asset, end to end: route → generate → commit the bytes → commit the
 * provenance note.
 *
 * ── WHY THIS EXISTS AS A FUNCTION AND NOT AS A TEST SCRIPT ───────────────
 *
 * *A lane that resolves is not a lane that works.* The Designer's whole problem
 * was a capability asserted in a document with no code path behind it, and a
 * verifier that proves `resolveLane('image')` returns a provider would reproduce
 * exactly that error one level up — it would prove the TABLE is right and say
 * nothing about whether an asset can be made. So the proof is a real generation
 * whose output is a file in a repo, and this is the code path that does it, on
 * the scheduled runtime, with the credentials production uses.
 *
 * ── THE PROVENANCE NOTE IS NOT OPTIONAL AND NOT BEST-EFFORT ──────────────
 *
 * The bible requires it: *"always leaving a provenance note (model, date)"*. An
 * asset committed without one is an asset nobody can regenerate, attribute or
 * judge against its brief, and it is indistinguishable from a file someone
 * dropped in the folder. So the note is written from the SAME result object that
 * produced the bytes — never from the request — and if the note fails to commit
 * that is reported in the return value rather than swallowed. It is not, however,
 * allowed to un-commit the asset: a lost note is a lost measurement, a lost asset
 * is lost work, and the two are not comparable (repo-write.js's own rule).
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.slug   - the asset's filename stem
 * @param {'draft'|'polish'} [opts.role]
 * @param {Array} [opts.inputImages] - for a polish pass
 * @param {boolean} [opts.commit] - false runs the generation and skips both
 *   writes, for a supervised look before anything lands in a repo.
 */
async function runDesignerAsset(env, {
  prompt,
  slug,
  role = null,
  instruction = null,
  inputImages = null,
  imageModel = null,
  steps = null,
  commit = true,
  note = null,
  polishInstruction = null,
}) {
  const safeSlug = assetSlug(slug || prompt);
  if (!safeSlug) return { ok: false, reason: 'asset_slug_unusable' };
  if (!prompt && !instruction) return { ok: false, reason: 'no_prompt_or_instruction' };

  const date = todayDateStr();

  const routed = await routeTaskTypeCall(env, 'image', {
    // Supervised only, exactly like `routing_test` and `guide_block`. The
    // scheduled path does not reach this function yet — the Designer's daily
    // block is Phase 6 work and is not built, which is stated rather than
    // implied by an absent caller.
    bypassGate: true,
    role,
    prompt,
    instruction,
    inputImages,
    imageModel,
    steps,
    agentId: 9,
    eventId: `designer_asset:${safeSlug}`,
  });

  if (!routed.ok || !routed.result?.base64) {
    return {
      ok: false,
      reason: routed.reason || 'no_image_returned',
      lane: 'image',
      role: routed.role ?? role,
      attempts: routed.attempts,
    };
  }

  const result = routed.result;
  // The extension comes from the SNIFFED type, never from an assumption. The
  // first asset the office committed was named `.png` and was a JPEG — see
  // provider-common.js sniffImageMime(). An unknown signature yields `.bin`,
  // which is obviously wrong and gets looked at, rather than a plausible `.png`
  // that gets trusted.
  const ext = extensionForMime(result.mimeType);
  const assetPath = `${DESIGNER_ASSET_DIR}/${date}-${safeSlug}.${ext}`;
  const provenancePath = `${DESIGNER_ASSET_DIR}/${date}-${safeSlug}.provenance.md`;

  const provenance = renderAssetProvenance({
    assetPath,
    // The prompt that was actually sent, and for a polish pass the instruction —
    // recorded separately because "make the type larger" and "a logo for the
    // office" are different facts and a note that merges them cannot be used to
    // reproduce either.
    prompt: instruction ? `[${routed.role} instruction] ${instruction}` : prompt,
    model: result.model,
    provider: routed.provider,
    role: routed.role,
    date,
    bytes: result.bytes,
    note: [
      note,
      result.revisedPrompt ? `Model's own account of what it produced: ${result.revisedPrompt.replace(/\s+/g, ' ').slice(0, 400)}` : null,
    ].filter(Boolean).join(' · ') || null,
  });

  if (!commit) {
    return { ok: true, committed: false, dryRun: true, assetPath, provenancePath, provenance, bytes: result.bytes, provider: routed.provider, role: routed.role, model: result.model };
  }

  const assetWrite = await commitFileToRepo(
    env, BACKOFFICE_REPO_NAME, assetPath, result.base64,
    `designer: asset ${safeSlug} (${routed.provider}, role ${routed.role})`,
    { contentIsBase64: true }
  );

  /*
   * ── THE POLISH PASS, ON THE DRAFT'S OWN BYTES ──────────────────────────
   *
   * Optional, and it is the only thing that proves the role split is real
   * rather than a naming convention. `polishImage()` is handed THIS draft's
   * base64 — so if the polish provider were ever silently swapped for the draft
   * one, the output would be a second unrelated image and the chain would say
   * so, instead of returning something plausible.
   *
   * Both files are kept. The draft is not overwritten by its polish, because
   * "what the office produced" and "what the office shipped" are different
   * facts and the Designer's review needs both in front of her. Two assets, two
   * provenance notes, each naming the role that made it.
   *
   * A failed polish does NOT invalidate the draft: the draft is already
   * committed and is a real asset. The failure is reported in `polish.reason`.
   */
  let polish = null;
  if (polishInstruction) {
    const polished = await routeTaskTypeCall(env, 'image', {
      bypassGate: true,
      role: 'polish',
      instruction: polishInstruction,
      inputImages: [{ base64: result.base64, mimeType: result.mimeType }],
      agentId: 9,
      eventId: `designer_asset:${safeSlug}:polish`,
    });

    if (!polished.ok || !polished.result?.base64) {
      polish = { ok: false, reason: polished.reason || 'no_image_returned', attempts: polished.attempts };
    } else {
      const pr = polished.result;
      const pExt = extensionForMime(pr.mimeType);
      const pAssetPath = `${DESIGNER_ASSET_DIR}/${date}-${safeSlug}-polished.${pExt}`;
      const pProvenancePath = `${DESIGNER_ASSET_DIR}/${date}-${safeSlug}-polished.provenance.md`;
      const pWrite = await commitFileToRepo(
        env, BACKOFFICE_REPO_NAME, pAssetPath, pr.base64,
        `designer: polished asset ${safeSlug} (${polished.provider}, role polish)`,
        { contentIsBase64: true }
      );
      const pProvWrite = await commitFileToRepo(
        env, BACKOFFICE_REPO_NAME, pProvenancePath,
        renderAssetProvenance({
          assetPath: pAssetPath,
          prompt: `[polish instruction] ${polishInstruction}`,
          model: pr.model,
          provider: polished.provider,
          role: polished.role,
          date,
          bytes: pr.bytes,
          note: `Polished FROM \`${assetPath}\` (${result.bytes} bytes, ${result.model}). The draft's own bytes were sent as the input image — this is not a re-generation from the prompt.`
            + (pr.revisedPrompt ? ` Model's own account: ${pr.revisedPrompt.replace(/\s+/g, ' ').slice(0, 300)}` : ''),
        }),
        `designer: provenance for ${safeSlug}-polished`
      );
      polish = {
        ok: !!pWrite.committed,
        assetPath: pAssetPath,
        provenancePath: pProvenancePath,
        provenanceCommitted: !!pProvWrite.committed,
        bytes: pr.bytes,
        mimeType: pr.mimeType,
        provider: polished.provider,
        model: pr.model,
        polishedFrom: assetPath,
      };
    }
  }

  const provenanceWrite = await commitFileToRepo(
    env, BACKOFFICE_REPO_NAME, provenancePath, provenance,
    `designer: provenance for ${safeSlug}`
  );

  return {
    ok: !!assetWrite.committed,
    committed: !!assetWrite.committed,
    // Reported, never swallowed: an asset in the repo with no note beside it is
    // the state the bible forbids, and the caller has to be able to see it.
    provenanceCommitted: !!provenanceWrite.committed,
    provenanceReason: provenanceWrite.committed ? null : (provenanceWrite.reason || null),
    assetPath,
    provenancePath,
    bytes: result.bytes,
    mimeType: result.mimeType,
    provider: routed.provider,
    role: routed.role,
    model: result.model,
    assetWrite,
    polish,
  };
}

/* ─────────────────────── The publishing gate (OB-014) ───────────────────── */

/**
 * Where a curated batch is declared. One JSON file per batch, in back-office,
 * written by the Designer (or by a supervised session acting as her runtime —
 * AUTOMATION-MANIFEST §3's two axes; the persona stays answerable either way).
 */
const FRONT_BATCH_DIR = 'campus/shared/front-drafts/batches';
/** Where the gate's own record of what it did lands. Back-office: the record
 *  names refusals, and a refusal is internal by construction. */
const FRONT_RECORD_DIR = 'campus/shared/front-drafts/records';

/** One back-office file, decoded. Local to this path deliberately: three other
 *  modules have their own copy of this six-line fetch and unifying them is a
 *  refactor with its own risk, not a side effect of building a gate. */
async function fetchBackOfficeText(env, filePath) {
  if (!env.BACKOFFICE_REPO_TOKEN) return { text: null, reason: 'BACKOFFICE_REPO_TOKEN not configured' };
  const url = `https://api.github.com/repos/${REPO_OWNER}/${BACKOFFICE_REPO_NAME}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.BACKOFFICE_REPO_TOKEN}`,
    },
  }).catch((err) => ({ ok: false, status: 0, _err: err?.message }));
  if (!res?.ok) return { text: null, reason: `GET ${filePath} failed: HTTP ${res?.status ?? 'network error'}` };
  const body = await res.json().catch(() => null);
  if (!body?.content) return { text: null, reason: `${filePath}: no content field` };
  try {
    return { text: decodeURIComponent(escape(atob(body.content.replace(/\n/g, '')))), reason: null };
  } catch (err) {
    return { text: null, reason: `${filePath}: decode failed — ${err.message}` };
  }
}

/**
 * ONE curated batch, end to end: read the manifest → read each draft → run the
 * gate → publish or refuse → record either way.
 *
 * ── WHY THE WORKER AND NOT A LOCAL SCRIPT ────────────────────────────────
 *
 * Because `commitFileToRepo()` is here, and it is the only write path that runs
 * A10's mandatory scan. A local script committing with `git push` would be a
 * second door beside the governed one — precisely the thing `PUBLISHING-GATE.md`
 * refused to build when it declined to write "enforcement" against a world where
 * the Worker still pushed raw reports unguarded.
 *
 * ── THE ORDER OF OPERATIONS IS THE CONTROL ───────────────────────────────
 *
 * Gate first, over the WHOLE batch, then write. Never item-by-item-then-check:
 * a batch is the unit the Designer curates and a partial publish is a Front the
 * visitor stumbles into mid-change. If any item is refused, NOTHING publishes —
 * including the items that were clean.
 *
 * `dryRun: true` runs the gate and writes nothing, the same shape
 * `design_asset`'s `commit: false` uses. The record is still returned, so a
 * refusal can be read before anything is attempted.
 */
async function runFrontPublish(env, { batchId, dryRun = false } = {}) {
  const id = String(batchId || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!id) return { ok: false, reason: 'front_publish_requires_batchId' };

  const manifestPath = `${FRONT_BATCH_DIR}/${id}.json`;
  const manifestRead = await fetchBackOfficeText(env, manifestPath);
  if (!manifestRead.text) return { ok: false, reason: 'batch_manifest_unreadable', detail: manifestRead.reason, manifestPath };

  let batch;
  try {
    batch = JSON.parse(manifestRead.text);
  } catch (err) {
    // A manifest that does not parse is REFUSED, never treated as absent. The
    // "treat every failure as absent" collapse is KFM-14's whole subject and it
    // has ~58 instances in this codebase already; this is not the 59th.
    return { ok: false, reason: 'batch_manifest_unparseable', detail: err.message, manifestPath };
  }

  // The drafts themselves live as real files, not as strings inside the JSON —
  // so that what the QA reviewed and what publishes are the same bytes, and so
  // a draft is reviewable in the repo as markdown rather than as an escaped
  // blob nobody reads.
  const items = [];
  const unreadable = [];
  for (const decl of Array.isArray(batch.items) ? batch.items : []) {
    if (!decl?.draft) { unreadable.push({ path: decl?.path ?? null, reason: 'item declares no draft path' }); continue; }
    const draft = await fetchBackOfficeText(env, decl.draft);
    if (draft.text === null) { unreadable.push({ path: decl.path ?? null, draft: decl.draft, reason: draft.reason }); continue; }
    items.push({ ...decl, content: draft.text });
  }
  if (unreadable.length) {
    return { ok: false, reason: 'batch_drafts_unreadable', unreadable, manifestPath };
  }

  const result = evaluateBatch({ ...batch, items });
  const date = new Date().toISOString().slice(0, 10);
  const record = renderPublicationRecord({ ...batch, items }, result, { date });

  const writes = [];
  if (result.publishable && !dryRun) {
    for (const item of items) {
      const commit = await commitFileToRepo(
        env, REPO_NAME, item.path, item.content,
        `front: publish ${item.path} (batch ${id}, QA sign-off agent ${batch?.qaSignOff?.agentId}) [skip ci]`,
      );
      writes.push({ path: item.path, committed: !!commit.committed, reason: commit.reason || null });
      // A security refusal here is the scan doing its job on content the gate
      // let through — the gate checks COVERAGE, the scanner checks CONTENT, and
      // they are different questions. It stops the batch: the remaining items
      // are not written, because a half-published batch is the state this whole
      // mechanism exists to prevent.
      if (!commit.committed) break;
    }
  }

  const published = result.publishable && !dryRun && writes.length === items.length && writes.every((w) => w.committed);

  // The record is written for a REFUSED batch too. A gate whose refusals leave
  // no trace is a gate nobody can audit.
  let recordWrite = null;
  if (!dryRun) {
    recordWrite = await commitFileToRepo(
      env, BACKOFFICE_REPO_NAME, `${FRONT_RECORD_DIR}/${date}-${id}.md`, record,
      `front-gate: ${published ? 'published' : 'refused'} batch ${id} [skip ci]`,
    );
  }

  return {
    ok: true,
    batchId: id,
    dryRun,
    publishable: result.publishable,
    published,
    counts: result.counts,
    refusals: result.refusals,
    writes,
    recordPath: recordWrite ? `${FRONT_RECORD_DIR}/${date}-${id}.md` : null,
    recordCommitted: recordWrite ? !!recordWrite.committed : null,
    // Returned so a caller can read the gate's reasoning without a second fetch.
    record,
  };
}

/* ────────────────────────────── Guides pipeline ─────────────────────────── */

/** UTC calendar day, matching this repo's existing DATE('now') convention
 * (see gap-reports.js) — used as the guide_pipeline.date key so guide_draft
 * and guide_review agree on "today" within the same simulated day. */
/* ────────────── Where an owner notification goes (2026-08-23) ───────────
 *
 * SESSION 11, ITEM C. Until today every `[Office #N]` Issue was filed into
 * `office-AI-agents`, which is PUBLIC. Eleven of them stand open there right
 * now, the oldest thirteen days, none answered — and each carries the office's
 * working state, its open decisions and its client's name, in the open.
 *
 * They move to `back-office-AI-agents` (private) because that is where the
 * channel they are notifications ABOUT already lives: `channel/to-owner/` and
 * `channel/from-owner/` are both there, so the Issue and the record it points
 * at stop being in two different repositories.
 *
 * THE ELEVEN PUBLIC ISSUES ARE NOT TOUCHED. Nothing here closes, edits or
 * migrates them — they are the record of what was sent and when, and the office
 * does not rewrite its own history to tidy a change of address. They stay open
 * until the owner closes them himself.
 *
 * Named as a constant rather than inlined at the two call sites because the
 * FILING target and the READ-BACK target must never disagree: filing into one
 * repo and reading replies from another would make every notification look
 * unanswered forever, which is the exact failure this channel already had.
 */
// ── REVERTED, THEN LANDED. Both on 2026-08-23. ──────────────────
//
// SESSION 11 deployed this retarget, tested it against the live API, and put
// it back:
//
//   {"type":"owner_channel_block"} -> notification #12 -> HTTP 403
//   "OWNER NOTIFICATION #12 FAILED — HTTP 403. The office has NOT reached
//    the client."
//
// `BACKOFFICE_REPO_TOKEN` carried Contents:write on back-office — every
// channel file, every daily summary and every campus write goes through it
// and works — but it did NOT carry **Issues:write**. A fine-grained PAT
// grants those separately, and nothing before that had ever asked it to open
// an Issue there, so the gap had never been reachable.
//
// SESSION 12 (2026-08-23): the owner added **Issues: Read and write** to that
// PAT. Verified live BEFORE this line was touched, with two calls carrying the
// same secret the Worker carries — not by reading the code and not by trusting
// the grant:
//
//   GET  /repos/avivnofar/back-office-AI-agents/issues        -> HTTP 200 []
//   POST /repos/avivnofar/back-office-AI-agents/issues  {}    -> HTTP 422
//        "Invalid request. \"title\" wasn't supplied."
//
// The 422 is the proof, not the 200: a fine-grained PAT without Issues:write
// is refused with 403 at the permission check, BEFORE the body is validated.
// A validation error means the write was permitted and only the payload was
// wrong. That is why the probe posts an empty body — it establishes the
// permission without opening an Issue.
//
// THE ELEVEN PUBLIC ISSUES STILL STAND, open and unmigrated, per the block
// above. Closing them is the owner's.
const OWNER_NOTIFY_REPO = BACKOFFICE_REPO_NAME;

// WHERE A CLIENT REPLY IS FILED. Deliberately NOT the same constant: this is
// a Contents write, which the token CAN do, and his words belong in the
// private repo beside the rest of the channel — not in the public one just
// because that is where the Issue happens to live today. When the Issues move
// (above), this line does not change.
const OWNER_REPLY_RECORD_REPO = BACKOFFICE_REPO_NAME;

/** The address the one successful send in this project's history used. */
const OWNER_EMAIL = 'avivnofar@gmail.com';

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/*
 * `guidesEnabled()` MOVED to workers/guide-engine.js on 2026-08-16 (OB-078)
 * and is imported at the top of this file. It was UNPROVEN for one reason —
 * it lived here, and nothing can load this module outside a Worker — so the
 * fix was to move the gate, not to write a test that could never run. See
 * that function's header for why the behaviour is identical.
 */

/**
 * 'guide_draft' block: picks today's topic (workers/guide-engine.js
 * selectGuideTopic() — capability gaps first, guides/TOPICS.md fallback),
 * has the domain-appropriate writer persona draft it via Gemini, and stores
 * the draft in D1 (guide_pipeline, status='drafted'). Commits nothing —
 * that only happens on the Architect's APPROVE/REJECT in
 * processGuideReviewBlock(). No-ops if a draft already exists for today
 * (idempotent against a re-fired tick) or if nothing was eligible.
 */
async function processGuideDraftBlock(env, dateStr, opts = {}) {
  if (!opts.bypassGate && !(await guidesEnabled(env))) {
    console.log('[guides] guides_enabled is off — guide_draft block skipped (gated no-op)');
    return { drafted: false, skipped: true, reason: 'guides_disabled' };
  }

  const existing = await getTodayDraftRow(env, dateStr);
  if (existing) return { drafted: false, reason: 'already_drafted_today' };

  const topic = await selectGuideTopic(env, dateStr);
  if (!topic) return { drafted: false, reason: 'no_eligible_topic' };

  const pacing = await checkGeminiPacingSlot(env);
  if (!pacing.allowed) return { drafted: false, reason: 'gemini_pacing', topic: topic.slug };

  const writerAgentId = pickWriterAgentId(topic.platform || topic.domain);
  const writer = instantiateAgent(writerAgentId, env);
  await writer.loadState();

  let draftText;
  try {
    draftText = await writer.queryGeminiDirect(buildDraftPrompt(topic, topic.priorDraft));
  } catch (err) {
    return { drafted: false, reason: `writer_error: ${err.message}`, topic: topic.slug };
  }

  if (isSplitRecommendation(draftText)) {
    return { drafted: false, reason: 'split_recommended', topic: topic.slug, detail: draftText.slice(0, 300) };
  }

  const id = await insertGuidePipelineRow(env, {
    date: dateStr, topic: topic.title, domain: topic.domain, slug: topic.slug,
    source: topic.source, writerAgentId, status: 'drafted', draftContent: draftText,
  });

  return { drafted: true, id, topic: topic.slug, domain: topic.domain, writerAgentId };
}

/**
 * 'guide_review' block: self-heals a missing draft (a missed tick or a
 * paced-out Gemini call), then has the Architect (agent 10) review it via a
 * DIRECT Anthropic API call (workers/claude-client.js, model claude-sonnet-5,
 * tracked against the SEPARATE guides Claude sub-budget — component:'guides',
 * config/token-economy.json guides_claude_budget). APPROVE commits the guide
 * and queues any UNVERIFIED sections; REVISE sends fixes back to the writer
 * for ONE round then re-reviews; REJECT (or a failed second review) commits
 * the draft + rejection note to guides/_drafts/ instead. Never escalates to
 * the owner — this is fire-and-forget, per CLAUDE.md "Review outcomes".
 */
async function processGuideReviewBlock(env, dateStr, opts = {}) {
  if (!opts.bypassGate && !(await guidesEnabled(env))) {
    console.log('[guides] guides_enabled is off — guide_review block skipped (gated no-op)');
    return { reviewed: false, skipped: true, reason: 'guides_disabled' };
  }

  let row = await getTodayDraftRow(env, dateStr);
  if (!row) {
    // Self-heal inherits this call's gate decision (we're already past it).
    const draftResult = await processGuideDraftBlock(env, dateStr, { bypassGate: true });
    if (!draftResult.drafted) return { reviewed: false, reason: draftResult.reason || 'no_draft_available' };
    row = await getTodayDraftRow(env, dateStr);
    if (!row) return { reviewed: false, reason: 'draft_missing_after_self_heal' };
  }

  if (!env.ANTHROPIC_API_KEY) return { reviewed: false, reason: 'anthropic_api_key_not_configured' };

  const budget = await getClaudeBudgetStatus(env, { component: 'guides' });
  if (budget.overBudget) {
    return { reviewed: false, reason: `guides_budget_exhausted ($${budget.spentUsd.toFixed(2)}/$${budget.capUsd}/mo)` };
  }

  const topic = { title: row.topic, domain: row.domain, slug: row.slug, source: row.source };
  const writerConfig = getAgentConfig(row.writer_agent_id);
  const writerAgentName = writerConfig ? writerConfig.name : `Agent ${row.writer_agent_id}`;

  const runReview = async (draftContent, isSecondPass) => {
    // 8192, not 4096: an APPROVE response carries the FULL rewritten guide
    // after ---GUIDE---, and a ceiling hit truncates exactly that section
    // (found live 2026-08-01 — first supervised run committed an empty
    // guide). The ceiling only bounds worst-case spend; typical responses
    // stay far below it.
    const result = await callClaudeMessages({
      apiKey: env.ANTHROPIC_API_KEY,
      system: ARCHITECT_REVIEW_SYSTEM,
      messages: [{ role: 'user', content: buildReviewPrompt(topic, draftContent, { isSecondPass }) }],
      maxTokens: 8192,
      effort: 'medium',
      disableThinking: true,
    });
    await recordClaudeSpend(env, { inputTokens: result.inputTokens, outputTokens: result.outputTokens, component: 'guides' });
    if (result.stopReason === 'max_tokens') {
      // A truncated response is not an authoritative decision — its tail
      // (the guide body, or part of it) is missing. Spend is recorded above;
      // fail the review rather than parse a fragment.
      throw new Error('review response truncated at max_tokens — not treated as a decision');
    }
    return parseReviewDecision(result.text);
  };

  let decision;
  try {
    decision = await runReview(row.draft_content, false);
  } catch (err) {
    return { reviewed: false, reason: `architect_error: ${err.message}` };
  }

  if (decision.decision === 'REVISE' && (row.revision_count || 0) < 1) {
    let revisedDraft = row.draft_content;
    const pacing = await checkGeminiPacingSlot(env);
    if (pacing.allowed) {
      const writer = instantiateAgent(row.writer_agent_id, env);
      await writer.loadState();
      try {
        revisedDraft = await writer.queryGeminiDirect(
          buildDraftPrompt(topic, { draftContent: row.draft_content, reviewNotes: decision.notes })
        );
      } catch {
        // Revision call failed — fall through and re-review the original
        // draft rather than losing the round entirely.
      }
    }
    await updateGuidePipelineRow(env, row.id, { draftContent: revisedDraft, revisionCount: 1 });
    row = { ...row, draft_content: revisedDraft, revision_count: 1 };
    try {
      decision = await runReview(revisedDraft, true);
    } catch (err) {
      return { reviewed: false, reason: `architect_revision_error: ${err.message}` };
    }
  }

  if (decision.decision === 'APPROVE' && decision.finalGuide.trim().length < 500) {
    // Fail closed (same lesson as the 2026-07-11 Notebook-X incident:
    // plausibility-check BEFORE the push, not after). An APPROVE whose
    // ---GUIDE--- body is missing or implausibly short must never publish —
    // the first supervised run (2026-08-01) hit exactly this and committed a
    // byline-only file. The row stays 'drafted', so a re-trigger (or the
    // next day's self-heal) retries cleanly.
    return { reviewed: false, reason: 'approve_without_guide_body', notes: (decision.notes || '').slice(0, 300) };
  }

  if (decision.decision === 'APPROVE') {
    const finalMarkdown = renderGuideFile({ topic, writerAgentName, finalGuide: decision.finalGuide, dateStr });
    const path = guidePath(topic.domain, topic.slug);
    const commit = await commitFileToRepo(
      env, REPO_NAME, path, finalMarkdown, `chore(agents): guide — ${topic.slug} (${topic.domain}) [skip ci]`
    );

    const unverifiedSections = extractUnverifiedSections(decision.finalGuide);
    let queueUpdated = false;
    let queueSkipped = null;
    if (unverifiedSections.length) {
      // AUDIT #14: this write REPLACES the whole queue file with
      // existing + new. If the read failed, `existing` is empty and every
      // previously queued UNVERIFIED section is erased by a network blip.
      // Refuse instead. Losing today's entries is recoverable — the guide is
      // committed and its UNVERIFIED markers are still in the text, so the
      // next pass re-derives them. Losing the accumulated queue is not.
      const queueRead = await fetchVerificationQueueChecked();
      if (!queueRead.ok) {
        queueSkipped = `queue_read_failed:${queueRead.reason} — refused to rewrite the whole queue from an unread copy (audit #14)`;
        console.warn(`[guides] ${queueSkipped}`);
      } else {
        const existingQueue = parseVerificationQueue(queueRead.text);
        const newEntries = unverifiedSections
          .filter((section) => !existingQueue.some((e) => e.guidePath === path && e.section === section))
          .map((section) => ({ guidePath: path, section }));
        if (newEntries.length) {
          await commitFileToRepo(
            env, REPO_NAME, 'guides/_verification-queue.md', renderVerificationQueue([...existingQueue, ...newEntries]),
            `chore(agents): queue ${newEntries.length} UNVERIFIED section(s) — ${topic.slug} [skip ci]`
          );
          queueUpdated = true;
        }
      }
    }

    await updateGuidePipelineRow(env, row.id, { status: 'approved', reviewNotes: decision.notes });
    return { reviewed: true, decision: 'APPROVE', path, committed: commit.committed, unverifiedCount: unverifiedSections.length, queueUpdated };
  }

  const draftMarkdown = renderRejectedDraftFile({
    topic, writerAgentName, draftContent: row.draft_content, reviewNotes: decision.notes, dateStr,
  });
  const path = draftPath(topic.slug);
  const commit = await commitFileToRepo(env, REPO_NAME, path, draftMarkdown, `chore(agents): guide draft rejected — ${topic.slug} [skip ci]`);
  await updateGuidePipelineRow(env, row.id, { status: 'rejected', reviewNotes: decision.notes });
  return { reviewed: true, decision: decision.decision, path, committed: commit.committed };
}

/**
 * 'guide_verify' block: Saturday-only weekly verification pass. Pulls 1-2
 * items from guides/_verification-queue.md, runs one Claude call per item
 * WITH the web_search server tool for fresh grounding (own the guides
 * sub-budget, same as guide_review). On success, updates the guide in place
 * and removes the queue entry; on failure the entry stays for next week.
 */
async function processGuideVerifyBlock(env, opts = {}) {
  if (!opts.bypassGate && !(await guidesEnabled(env))) {
    console.log('[guides] guides_enabled is off — guide_verify block skipped (gated no-op)');
    return { verified: 0, skipped: true, reason: 'guides_disabled' };
  }

  // AUDIT #14: this block ends by rewriting the WHOLE queue from `remaining`.
  // A failed read used to be indistinguishable from an empty queue — and while
  // an empty queue exits early here, the distinction is what guarantees that;
  // it is asserted rather than relied on. A read that did not happen exits with
  // its own reason, so "the queue is empty" and "GitHub was unreachable" never
  // appear in the logs as the same sentence.
  const queueRead = await fetchVerificationQueueChecked();
  if (!queueRead.ok) {
    console.warn(`[guides] verification queue unreadable (${queueRead.reason}) — block skipped rather than rewriting it (audit #14)`);
    return { verified: 0, reason: `queue_unreadable:${queueRead.reason}` };
  }
  const entries = parseVerificationQueue(queueRead.text);
  if (!entries.length) return { verified: 0, reason: 'queue_empty' };
  if (!env.ANTHROPIC_API_KEY) return { verified: 0, reason: 'anthropic_api_key_not_configured' };

  const items = pickVerificationQueueItems(entries, 2);
  const outcomes = [];
  let remaining = [...entries];

  for (const item of items) {
    const budget = await getClaudeBudgetStatus(env, { component: 'guides' });
    if (budget.overBudget) {
      outcomes.push({ ...item, outcome: 'skipped_budget' });
      continue;
    }

    const guideMarkdown = await fetchRawRepoFile(item.guidePath);
    if (!guideMarkdown) {
      outcomes.push({ ...item, outcome: 'guide_not_found' });
      continue;
    }

    let verifyResult;
    try {
      const claudeResult = await callClaudeMessages({
        apiKey: env.ANTHROPIC_API_KEY,
        system: VERIFY_SYSTEM,
        messages: [{ role: 'user', content: buildVerifyPrompt(guideMarkdown, item.section) }],
        maxTokens: 2048,
        webSearch: true,
      });
      await recordClaudeSpend(env, { inputTokens: claudeResult.inputTokens, outputTokens: claudeResult.outputTokens, component: 'guides' });
      if (claudeResult.stopReason === 'max_tokens') {
        // Truncated verification = possibly half a rewritten section — never
        // splice that into a published guide. Entry stays queued for next week.
        outcomes.push({ ...item, outcome: 'error: truncated_max_tokens' });
        continue;
      }
      verifyResult = parseVerifyResult(claudeResult.text);
    } catch (err) {
      outcomes.push({ ...item, outcome: `error: ${err.message}` });
      continue;
    }

    if (verifyResult.verified && verifyResult.updatedSection) {
      const updatedGuide = replaceGuideSection(guideMarkdown, item.section, verifyResult.updatedSection);
      await commitFileToRepo(env, REPO_NAME, item.guidePath, updatedGuide, `chore(agents): guide verification — ${item.section} [skip ci]`);
      remaining = remaining.filter((e) => !(e.guidePath === item.guidePath && e.section === item.section));
      outcomes.push({ ...item, outcome: 'verified' });
    } else {
      outcomes.push({ ...item, outcome: 'still_unverified' });
    }
  }

  if (remaining.length !== entries.length) {
    await commitFileToRepo(
      env, REPO_NAME, 'guides/_verification-queue.md', renderVerificationQueue(remaining),
      'chore(agents): verification queue updated after weekly pass [skip ci]'
    );
  }

  return { verified: outcomes.filter((o) => o.outcome === 'verified').length, outcomes };
}

/* ═══════════════════ The report pipeline (2026-08-08) ════════════════════
 *
 * Drafted by a model, reviewed by a second persona on a second provider,
 * published only if it passes. See workers/report-pipeline.js for the rules
 * and where each of them was paid for.
 *
 * SHIPPED OFF. With `report_pipeline_enabled` absent or false —  the shipped
 * default — runReportPipeline() is a logged no-op, no model is called, and
 * generateWeeklySummary() emits the SAME template markdown it emits today,
 * byte for byte. Deploying this does not start it.
 * ════════════════════════════════════════════════════════════════════════ */

async function reportPipelineOn(env) {
  return reportPipelineEnabled(env);
}

/**
 * Output ceilings, sized against the REPORT and not against a case answer.
 *
 * STALE AS OF 2026-08-10, kept only as the historical reason
 * REPORT_DRAFT_MAX_TOKENS is bounded rather than generous: this used to say
 * the review's total must leave room inside the routing-off reviewer's
 * 8,192-token TOTAL context. That model (Groq `llama3-8b-8192`) was found
 * decommissioned 2026-08-09; the routing-off reviewer is now
 * `llama-3.1-8b-instant` at 131,072 tokens, and DIRECT_REVIEW_CONTEXT_TOKENS
 * (report-pipeline.js) was raised to 131,000 to match on 2026-08-10 (OB-037).
 * Neither draft nor review is squeezed by context size any more on either
 * path — see REPORT_REVIEW_MAX_TOKENS below for what actually still
 * constrains the review call today, which is a different thing entirely.
 */
const REPORT_DRAFT_MAX_TOKENS = 1800;
// RAISED 500 -> 3500 (2026-08-11). Read this before lowering it again — the
// 500 figure was sized for a different reviewer than the one now holding the
// lane, and the mismatch is exactly what made the judgment lane look dead.
//
// ── WHAT 500 WAS ACTUALLY MEASURING, AND WHY IT STOPPED APPLYING ─────────
//
// 500 (down from 1,600 on 2026-08-09) was sized against the VISIBLE reply:
// "the reviewer now returns a DECISION, a NOTE and an optional EDITS list,
// which is ~200-350 tokens, and 500 is headroom on that." True for the
// routing-off reviewer, Groq's `llama-3.1-8b-instant` — a non-reasoning
// model whose `max_tokens` counts only the text it emits.
//
// It stopped being true the moment routing went live and the judgment
// lane's primary became Cerebras' `gpt-oss-120b` — a REASONING model whose
// invisible deliberation is charged against the SAME `max_tokens` budget as
// the visible reply (cerebras-client.js's header). 500 was never headroom
// for that model; it was frequently not even enough to finish thinking
// before the budget ran out, which returns EMPTY content with
// `finishReason: "length"` — not a short answer, no answer — and
// routeTask()'s empty-answer guard (2026-08-10) correctly treats that as a
// failure and falls to Mistral. Every review looked like a dead lane
// because the number chosen for a different model was still in place.
//
// ── MEASURED, NOT GUESSED, AGAINST THE REAL PAYLOAD (2026-08-11) ─────────
//
// Live `routing_test` calls against the judgment lane, review system prompt,
// and a review-shaped fact pack matching production's real size
// (BOARD_TASKS_IN_PACK=60, ~4,600-5,000 input tokens):
//
//   maxTokens  512  -> content ""     finishReason "length"  (empty — degrades to Mistral, confirming the live symptom)
//   maxTokens 3000  -> content real   finishReason "stop"    1,000 output tokens spent
//
// A SMALLER prompt (~1,000 input tokens) showed the same shape spends a
// WIDELY VARIABLE amount of hidden reasoning run to run — 494 tokens on one
// call, 980 on a near-identical repeat — so a floor with only ~2x margin
// over one measurement is not safe; the next call can double.
//
// 3,500 is ~3.5x the largest measured spend (1,000) on the real-sized
// payload, which is the same margin ratio cerebras-client.js's own
// MIN_OUTPUT_TOKENS applied for the same reason (~3.3x its largest
// measurement). Cerebras has no per-request output cap
// (`maxOutputTokensPerRequest: null` — see CEREBRAS_LIMITS) and free-tier
// headroom is 1,000,000 tokens/minute, so there is no cost reason to keep
// this tight. estimateReviewFit() still checks the TOTAL against
// DIRECT_REVIEW_CONTEXT_TOKENS (131,000) before any call is sent, so this
// number cannot silently blow that ceiling — raising it here only widens
// the room the reasoning has to work in, exactly as the diagnosis requires.
//
// This is NOT a substitute for the router's own empty-answer guard or its
// substitution logging (task-router.js routeTask(), 2026-08-10/11) — those
// stay in place to catch whatever this floor does not, and to make any
// future substitution loud rather than quietly measuring the wrong model.
const REPORT_REVIEW_MAX_TOKENS = 3500;

/**
 * Assembles the fact pack: everything the drafter is allowed to state.
 *
 * Reads only what already exists — the office snapshot (board + client
 * requirements), the projects list, the per-agent rows the caller already
 * computed, this period's meeting decisions and gap counts from D1, and the
 * improvement loop's capture counts. NOTHING here calls a model.
 */
async function buildReportFacts(env, { reportType, periodLabel, dateStr, agentRows, pipelineSummary, sinceIso }) {
  const snapshot = await getOfficeSnapshot(env, { allowFetch: true });
  const board = snapshot?.board || null;
  const requirements = snapshot?.requirements || null;
  // The deliverable-lifecycle digest (2026-08-10). Passed straight through:
  // buildFactPack() distinguishes `null` (unreadable) from an empty record list
  // (nothing in review), and collapsing the two here would defeat that.
  const lifecycle = snapshot?.lifecycle || null;

  // Meeting decisions and conflicts this period.
  //
  // ── A ZERO HERE DOES NOT MEAN "NOTHING WAS DECIDED" ───────────────────
  //
  // Found 2026-08-08 while assembling the first fact pack: the office does
  // NOT persist meeting decisions to D1 at all. `reports` has only carried
  // incident / status / gap_hebrew / model_education / office_event —
  // meeting output goes straight to GitHub as markdown
  // (meeting-engine.js commitMeetingReport()), and applyMeetingEffects()
  // consumes the decision arrays in memory without writing a row.
  //
  // So the naive query returns zero, and zero rendered as "no product
  // decisions were taken this period" is a CONFIDENT FALSEHOOD — the office
  // held a weekly meeting the day before this was written. It is the same
  // shape as the four defects in ARCHITECTURAL-DECISIONS.md §7: a value that
  // no path produces, read by something that treats its absence as a fact.
  //
  // The discriminator is the one the Workflow's metrics already use for
  // idle agents — "no activity EVER recorded" is a different fact from
  // "0 this period", and only one of them is about this period. If no
  // meeting row has ever existed, the section is UNVERIFIED with its cause
  // named; if rows exist historically and none fall in this window, then
  // "none this period" is genuine and is said plainly.
  // Seeded with the no-database case rather than with [], so that "we could
  // not look" never renders as "we looked and found nothing".
  let decisions = ['UNVERIFIED — no database binding was available, so this period\'s decisions could not be read at all.'];
  let gapSummary = null;
  let captureSummary = null;
  if (env.DB) {
    // ── OB-028, CORRECTED 2026-08-09: THIS QUERIED THE WRONG TABLE ─────
    //
    // What was written here on 2026-08-08, and published in week-07 as fact:
    // "the office does not persist meeting decisions or votes to a queryable
    // store ... the decision arrays are applied in memory without a row."
    //
    // That is FALSE. meeting-engine.js persistMeeting() has always inserted
    // into a `meetings` table (id, type, attendees, transcript, decisions) —
    // 43 rows on 2026-08-09, 6 of them weekly, the most recent two days
    // before the report that said they did not exist. The query looked in
    // `reports`, which has never carried a meeting row, got zero, and the
    // zero was read as a fact about the office instead of a fact about the
    // query. Same family as the defects it was written to avoid, one level
    // up: not "a value nothing produces", but "a value produced somewhere
    // else, read from the wrong place".
    //
    // THREE STATES, NOT TWO. The 2026-08-08 version distinguished "never
    // recorded" from "none this period". There is a third, and it is the one
    // the office is actually in: meetings ran, rows exist, and the decisions
    // block came back EMPTY for 27 of the 43 — the model's JSON block fails
    // to parse or is omitted, and meeting-engine.js falls back to
    // emptyDecisions() (its line 591). "The extractor produced nothing" is
    // not "nobody decided anything", and collapsing them is how the first
    // version of this got published.
    const meetingsEver = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM meetings'
    ).first().catch(() => null);

    const meetingRows = meetingsEver === null ? null : await env.DB.prepare(
      `SELECT type, decisions, created_at FROM meetings
        WHERE created_at >= ? ORDER BY created_at ASC LIMIT 25`
    ).bind(sinceIso).all().catch(() => null);

    if (meetingsEver === null || meetingRows === null) {
      decisions = [
        'UNVERIFIED — the meetings table could not be read this cycle, so this period\'s decisions are unknown. '
        + 'Say so using the literal word UNVERIFIED; this is not evidence that nothing was decided.',
      ];
    } else {
      const rows = meetingRows.results || [];
      const lines = [];
      let emptyBlocks = 0;
      for (const r of rows) {
        let d = null;
        try { d = JSON.parse(r.decisions || '{}'); } catch { d = null; }
        const items = [
          d?.summary ? `summary: ${d.summary}` : '',
          (d?.action_items || []).length ? `${d.action_items.length} action item(s)` : '',
          (d?.suggestion_decisions || []).length ? `${d.suggestion_decisions.length} suggestion decision(s)` : '',
          (d?.config_overrides || []).length ? `${d.config_overrides.length} config override(s)` : '',
        ].filter(Boolean);
        if (!items.length) { emptyBlocks += 1; continue; }
        lines.push(`${r.created_at} ${r.type}: ${items.join('; ')}`);
      }

      if (lines.length) {
        decisions = lines;
        if (emptyBlocks) {
          decisions.push(
            `NOTE: ${emptyBlocks} further meeting(s) this period recorded an EMPTY decision block. `
            + 'That is a failure of the office\'s own decision extraction, not a quiet meeting.'
          );
        }
      } else if (rows.length) {
        decisions = [
          `UNVERIFIED — ${rows.length} meeting(s) were held this period and EVERY one recorded an empty decision block. `
          + 'The meetings table holds their transcripts, so the meetings happened; the structured decisions block that '
          + 'meeting-engine.js parses out of the model\'s reply came back empty and it fell back to an empty record. '
          + 'This is a defect in the office\'s decision extraction, and it is NOT evidence that nothing was decided. '
          + 'Report it using the literal word UNVERIFIED.',
        ];
      } else if ((meetingsEver.n ?? 0) > 0) {
        decisions = [];   // genuinely quiet period; buildFactPack says so plainly
      } else {
        decisions = [
          'UNVERIFIED — no meeting has ever been recorded, so there is no baseline against which "none this period" '
          + 'could mean anything. Say so using the literal word UNVERIFIED.',
        ];
      }
    }

    const gapRows = await env.DB.prepare(
      `SELECT project, COUNT(*) AS n FROM reports
        WHERE type = 'gap_hebrew' AND created_at >= ? GROUP BY project`
    ).bind(sinceIso).all().catch(() => null);
    gapSummary = (gapRows?.results || []).length
      ? (gapRows.results).map((r) => `- ${r.project || 'unattributed'}: ${r.n} capability gap(s) flagged against that system this period`).join('\n')
      : 'No capability gaps were flagged this period.';

    // ── COUNT AND AVERAGE ARE TWO POPULATIONS, AND THE PACK MUST SAY SO ────
    //
    // week-07 published *"81 case_answer entries with an average quality of
    // 0.80"* as one sentence about one population. It was two: the count
    // included paced-out asks that were never made, and the average could only
    // be taken over the rows that had a score. Reading it as one overstated the
    // evidence base by about 3x.
    //
    // So `scored` is now counted separately from `n`, in SQL, and the fact pack
    // carries both. Since 2026-08-10 a paced-out ask is written as
    // `case_not_asked` (see improvement-loop.js), so the two diverge only for the
    // 86 rows written before that — and where they diverge the line says which
    // number the average belongs to rather than leaving a reader to assume.
    const capRows = await env.DB.prepare(
      `SELECT event_type, COUNT(*) AS n,
              SUM(CASE WHEN quality IS NOT NULL THEN 1 ELSE 0 END) AS scored,
              AVG(quality) AS avg_quality
         FROM reports
        WHERE event_type IS NOT NULL AND created_at >= ? GROUP BY event_type`
    ).bind(sinceIso).all().catch(() => null);
    if (capRows === null) {
      captureSummary = 'Improvement-loop capture: UNVERIFIED — the capture columns are missing from the database, so no office events were recorded this period.';
    } else if (!capRows.results.length) {
      captureSummary = 'Improvement-loop capture: zero office events recorded this period. That is a fact about the capture, not necessarily about the work.';
    } else {
      const parts = capRows.results.map((r) => {
        const n = Number(r.n);
        const scored = Number(r.scored || 0);
        const avg = r.avg_quality != null ? ` (avg quality ${Number(r.avg_quality).toFixed(2)}` : '';
        // The average's own population, stated on the same line as the average.
        const over = avg ? `${scored === n ? ' over all of them' : ` over ONLY the ${scored} of these ${n} rows that carry a score — the other ${n - scored} recorded no measurement and the average does NOT describe them`})` : '';
        return `${n} ${r.event_type}${avg}${over}`;
      });
      const notAsked = capRows.results.find((r) => r.event_type === 'case_not_asked');
      const anyQuality = capRows.results.some((r) => r.avg_quality != null);
      captureSummary = `Improvement-loop capture: ${parts.join(', ')}.`
        + (notAsked
          ? ` NOTE: the ${notAsked.n} case_not_asked row(s) are asks that never reached a provider — the Gemini pacer denied the slot or a budget cap refused it. They are recorded so the refusal rate is visible, and they are NOT units of completed work. Do not add them to the case_answer count.`
          : '')
        // The fact pack feeds a CLIENT-FACING report. An average printed there
        // without this sentence is a placeholder presented as a quality
        // judgment — the same defect class as a count that drops rows
        // silently. Printed only when an average is actually present, so the
        // caveat never appears without the number it qualifies.
        + (anyQuality ? ` QUALITY CAVEAT — carry this into any sentence that uses the averages above: ${METRIC_DISCLOSURE}` : '');
    }
  }

  // WHAT THE OFFICE PRODUCED, not just how it is doing. Added after judging
  // the first sample fact pack: it described state exhaustively and named not
  // one artifact, so a report built from it could answer "where do we stand"
  // and not "what did you do" — and the client asked the second question.
  const artifacts = [];
  if (env.DB) {
    const guides = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM guide_pipeline WHERE created_at >= ? GROUP BY status`
    ).bind(sinceIso).all().catch(() => null);
    if (guides === null) {
      artifacts.push('UNVERIFIED — the guides pipeline table could not be read, so guide output is unknown for this period.');
    } else if (guides.results.length) {
      artifacts.push(`Guides: ${guides.results.map((r) => `${r.n} ${r.status}`).join(', ')}.`);
    } else {
      artifacts.push('Guides: none drafted this period.');
    }

    const gapDigests = await env.DB.prepare(
      `SELECT project, COUNT(*) AS n FROM reports WHERE type = 'gap_hebrew' AND created_at >= ? GROUP BY project`
    ).bind(sinceIso).all().catch(() => null);
    for (const r of gapDigests?.results || []) {
      artifacts.push(`Capability-gap findings filed against ${r.project || 'an unattributed system'}: ${r.n}, digested to reports/gaps/${r.project || 'unknown'}/.`);
    }

    const statusNotes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reports WHERE type = 'status' AND created_at >= ?`
    ).bind(sinceIso).first().catch(() => null);
    if (statusNotes?.n) artifacts.push(`Daily AI-experience notes filed by agents: ${statusNotes.n}.`);
  }

  // ── OB-038: OUTPUT INDEXED ON THE REPOSITORY WRITTEN TO ────────────────
  //
  // The axis the consistency check was missing. See recordRepoWrite() in
  // workers/repo-write.js for the full defect; the short form is that week-07
  // published "office-AI-agents: Nothing moved" against 61 commits because every
  // fact in the pack was indexed on the system ASKED, never on the repo WRITTEN
  // TO, and validateReportBody() was given nothing that could contradict it.
  //
  // THREE OUTCOMES, NOT TWO, and the middle one is the whole point:
  //   null  → the table could not be read → the pack renders UNVERIFIED
  //   []    → readable and empty → "no write recorded", with the start date named
  //   rows  → real attribution, one line per repository
  // A table that does not exist yet reads as the FIRST case, not the second,
  // because "we could not look" must never render as "we looked and found
  // nothing" — which is the error this section exists to correct.
  let repoWrites = null;
  if (env.DB) {
    const rows = await env.DB.prepare(
      `SELECT repo, COUNT(*) AS n, SUM(committed) AS ok, SUM(redirected) AS redirected
         FROM repo_writes WHERE created_at >= ? GROUP BY repo ORDER BY n DESC`
    ).bind(sinceIso).all().catch(() => null);
    repoWrites = rows === null ? null : (rows.results || []).map((r) => {
      const failed = Number(r.n) - Number(r.ok || 0);
      return `${r.repo}: ${r.ok || 0} file(s) committed`
        + `${failed > 0 ? `, ${failed} write(s) FAILED` : ''}`
        + `${Number(r.redirected || 0) > 0 ? `, ${r.redirected} redirected by the permission guard` : ''}`
        + '.';
    });
  }

  // Unattended Architect sessions this period (architect-liaison.js files these
  // from the run's own session record). Absent → the section is omitted, never
  // rendered as "no runs occurred": the runs are occasional and unannounced, so
  // a period without one is the normal case and not a fact about the office.
  let architectRuns = [];
  if (env.DB) {
    const rows = await env.DB.prepare(
      `SELECT title, created_at FROM reports
        WHERE type = 'architect_session' AND created_at >= ? ORDER BY created_at ASC LIMIT 10`
    ).bind(sinceIso).all().catch(() => null);
    architectRuns = rows?.results || [];
  }

  // ── PERIOD-CORRECT CASE COUNTS ────────────────────────────────────────
  //
  // getWeeklyCasesHandled() looks back TWENTY-FOUR HOURS, not a week, despite
  // its name (`Date.now() - 24 * 60 * 60 * 1000`). Its caller is the weekly
  // CSV, which has been publishing a one-day number under a `weekly_cases`
  // column header for as long as it has existed.
  //
  // That function is NOT changed here: it feeds committed output, and fixing
  // it would move bytes this session promised not to move. But a weekly
  // report cannot inherit the error — measured 2026-08-08, the 24-hour figure
  // was 0 while the real 7-day figure was 167, which would have published
  // "the office handled no cases this week" in a week it handled 167.
  //
  // So the pipeline computes its own, over its OWN period window, and the
  // divergence is recorded rather than silently reconciled.
  const casesByAgent = new Map();
  if (env.DB) {
    const rows = await env.DB.prepare(
      `SELECT agent_id, COALESCE(SUM(cases_handled), 0) AS total
         FROM agent_sessions WHERE started_at >= ? GROUP BY agent_id`
    ).bind(sinceIso).all().catch(() => null);
    for (const r of rows?.results || []) casesByAgent.set(Number(r.agent_id), Number(r.total) || 0);
  }
  const periodAgentRows = (agentRows || []).map((a) => ({
    ...a,
    weeklyCases: casesByAgent.has(a.agentId) ? casesByAgent.get(a.agentId) : a.weeklyCases,
  }));

  const blocked = (board?.tasks || [])
    .filter((t) => t.state === 'BLOCKED' || t.state === 'NOT-READY')
    .map((t) => `${t.id} [${t.state}] ${t.title} — waiting on: ${t.blockedBy || 'UNVERIFIED — nothing recorded'}`);

  // ── DISPATCH IS NOW COUNTED, 2026-08-10 (OB-036) ───────────────────────
  //
  // This was `dispatchedCount: null` — a literal, at the pipeline's only call
  // site — so buildFactPack()'s number branch was unreachable and every report
  // ever published said DISPATCHED: UNVERIFIED. It kept saying it after the board
  // grew a real `Dispatched:` line on 2026-08-09, because nothing here read one.
  //
  // Counted from the board's OWN `Dispatched:` field rather than from a separate
  // store, so the office's record of who holds what is the file a human reads.
  // An unreadable board leaves all three null and the pack renders UNVERIFIED —
  // which is then true for the right reason.
  const dispatchedCount = board ? board.tasks.filter((t) => t.dispatched).length : null;
  const inProgressCount = board ? board.counts['IN-PROGRESS'] ?? 0 : null;
  const offeredCount = board ? board.tasks.filter((t) => t.offered).length : null;

  const due = requirements?.due || null;
  const factPack = buildFactPack({
    reportType,
    periodLabel,
    dateStr,
    requirements,
    questions: snapshot?.questions || null,
    daysRemaining: daysUntil(due),
    decisions,
    board,
    lifecycle,
    projects: officeProjects.projects,
    workflowMetrics: null,
    agentRows: periodAgentRows,
    captureSummary,
    gapSummary,
    artifacts,
    repoWrites,
    architectRuns,
    blocked,
    pipelineSummary,
    dispatchedCount,
    inProgressCount,
    offeredCount,
  });

  return { factPack, due, snapshotErrors: snapshot?.errors || [] };
}

/**
 * One model call for the pipeline, in whichever flag state routing is in.
 *
 * Routing OFF is a CLEAN DEGRADATION: the router is not called at all (it
 * would refuse with `routing_disabled` and contact nothing), and the two
 * direct paths that already exist are used instead. Routing ON goes through
 * routeTaskTypeCall() and reports which provider actually answered, because
 * assertDistinctReviewer() needs the provider that ANSWERED, not the one
 * that was planned — a lane degrading to its backup can land both calls on
 * the same model.
 *
 * @returns {{text: string|null, provider: string|null, reason: string|null}}
 */
async function callReportModel(env, plan, { prompt, systemPrompt, maxTokens, agent: preloadedAgent = null, assembledSystemPrompt = null }) {
  if (plan.mode === 'routed') {
    const routed = await routeTaskTypeCall(env, plan.lane, {
      prompt, systemPrompt, maxTokens,
      geminiModel: simulationConfig.GEMINI?.model,
      geminiEndpoint: simulationConfig.GEMINI?.api_endpoint,
      agentId: `report-${plan.lane}`,
    });
    if (!routed.ok) return { text: null, provider: routed.provider || null, planned: null, reason: routed.reason || 'routed_call_failed' };
    // task-router.js routeTask() now computes and logs the substitution
    // itself (2026-08-11) — `plannedProvider` is the lane's table-order
    // primary, not re-derived from `attempts[0]` here any more. Kept as a
    // fallback only for a routed result somehow missing the field (it never
    // should on the current router, but a caller-side null default is
    // cheaper than a caller that throws on it).
    const plannedProvider = routed.plannedProvider ?? routed.attempts?.[0]?.provider ?? null;
    return { text: routed.result?.text ?? null, provider: routed.provider, planned: plannedProvider, reason: null };
  }

  // The caller may hand in an agent it already instantiated and loaded — the
  // review path does, because it has to build that agent's assembled system
  // prompt to size the request before deciding whether to send it at all.
  // Re-instantiating here would re-read the Durable Object to reach the same
  // state and re-assemble the same prompt.
  const agent = preloadedAgent || instantiateAgent(plan.agentId, env);
  if (!preloadedAgent) await agent.loadState();

  if (plan.path === 'queryGeminiDirect') {
    // The pacer governs THIS automation's Gemini calls. If it refuses, the
    // report WAITS — it is not routed around, and it does not silently fall
    // to another provider. Report generation is new load on a quota the
    // office can only partially observe (workers/gemini-pacer.js header).
    const pacing = await checkGeminiPacingSlot(env);
    if (!pacing.allowed) return { text: null, provider: null, planned: plan.provider, reason: 'gemini_pacing' };
    const text = await agent.queryGeminiDirect(prompt, systemPrompt, { maxTokens, reportType: 'report-pipeline' });
    return { text, provider: agent.lastModelSource || 'gemini', planned: plan.provider, reason: null };
  }

  const text = await agent.queryGroqRouted(prompt, systemPrompt, { maxTokens, assembledSystemPrompt });
  // `planned` is what planReportProviders() said would answer. On the direct
  // review path that is 'groq', and queryGroqRouted() degrades to Cloudflare
  // Workers AI without telling anyone — see report-pipeline.js providerLabel().
  return { text, provider: agent.lastModelSource || 'groq', planned: plan.provider, reason: null };
}

/**
 * Records, once, that a lane answered from somewhere other than its plan.
 *
 * Loud by construction: a console warning naming both providers, a line in the
 * published byline, and a field on the pipeline's return value that the
 * supervised trigger echoes back. A silent substitution is how an office
 * measures the wrong model for a month.
 */
function noteProviderSubstitution(role, planned, actual, sink) {
  if (!planned || !actual || planned === actual) return false;
  console.warn(
    `[report-pipeline] PROVIDER SUBSTITUTED on the ${role} call: planned "${planned}", answered "${actual}". `
    + 'The call succeeded and the pipeline is unaffected, but the planned provider did not respond — '
    + 'check its credentials and quota before trusting any embodiment figure that names it.'
  );
  sink.push({ role, planned, actual });
  return true;
}

/**
 * The pipeline. Draft -> review -> (one revision) -> publish or file the
 * rejection. Returns a result object and NEVER throws — a report that cannot
 * be produced is a logged skip, never a broken cron tick, and never an
 * escalation to the owner.
 *
 * Cross-invocation safe: a draft that was written but not reviewed lives in
 * D1 (report_pipeline) and is picked up rather than rewritten, the same
 * self-healing shape the guides pipeline uses.
 */
async function runReportPipeline(env, { reportType, periodLabel, legacyLabels = [], dateStr, agentRows = [], pipelineSummary = null, sinceIso, bypassGate = false }) {
  if (!bypassGate && !(await reportPipelineOn(env))) {
    console.log(`[report-pipeline] report_pipeline_enabled is off — ${reportType} ${periodLabel} not drafted (gated no-op)`);
    return { ran: false, skipped: true, reason: 'report_pipeline_disabled' };
  }
  if (!REPORT_TYPES.includes(reportType)) {
    return { ran: false, reason: `unknown_report_type: ${reportType}` };
  }

  // ── Duplicate-publish guard (fixed 2026-08-14) ─────────────────────────
  // getPendingReportRow() below only ever sees status='drafted' rows -- an
  // approved row is invisible to it, so this pipeline could re-draft and
  // re-review a period that already published, then overwrite whatever
  // commitFileToRepo() finds at reportPath() -- including manual owner
  // corrections appended after publish (reports/weekly/week-07-report.md,
  // commit 4337350).
  //
  // getApprovedReportRow() -- NOT getLatestReportRow() -- is what actually
  // protects a published period. Checked live against D1 before this went in:
  // week-07 carries 3 approved rows from 2026-08-09 followed by 7 REJECTED
  // retries through 2026-08-14 (the self-locking gate, audit א.2/Phase 2),
  // so its MOST RECENT row is 'rejected' -- getLatestReportRow() alone would
  // have missed the exact case this guard exists for. getApprovedReportRow()
  // finds it regardless of what landed after it.
  //
  // Checked here, before the fact pack is built and before any model is
  // called, so an already-approved period never reaches a drafter. NOT
  // skippable by bypassGate -- that flag overrides the report_pipeline_enabled
  // switch for a supervised manual fire, not this safety check; a manual
  // re-trigger against a published period must refuse exactly like a cron tick.
  // OB-086 (2026-08-16): the guard checks EVERY label this period may have
  // published under, not just today's. `periodLabel` now carries the
  // simulation year (`year-1-week-08`); the office published year 1 under the
  // yearless `week-08` before that change, and those files are deliberately
  // not renamed. Checking only the new label would read a published period as
  // unpublished and emit a SECOND report for it at the new path -- the same
  // harm this guard exists to prevent. `legacyLabels` is empty from year 2 on.
  const guardLabels = Array.isArray(legacyLabels) && legacyLabels.length
    ? [periodLabel, ...legacyLabels.filter((l) => l && l !== periodLabel)]
    : [periodLabel];
  for (const label of guardLabels) {
    const approvedForGuard = await getApprovedReportRow(env, reportType, label);
    if (!approvedForGuard) continue;
    const latestForGuard = await getLatestReportRow(env, reportType, label);
    const viaLegacy = label !== periodLabel
      ? ` (matched the PRE-2026-08-16 yearless label '${label}' for '${periodLabel}' -- that period published before report paths carried a year, and its file is deliberately not renamed)`
      : '';
    const reason = `${reportType} ${periodLabel} was already approved${viaLegacy} (row ${approvedForGuard.id}, published ${approvedForGuard.updated_at || approvedForGuard.created_at})`
      + (latestForGuard && latestForGuard.id !== approvedForGuard.id
        ? ` -- most recent attempt since then was '${latestForGuard.status}' (row ${latestForGuard.id}, ${latestForGuard.updated_at || latestForGuard.created_at}), which does not undo the earlier publish`
        : '')
      + ' -- refusing to re-draft over a published report';
    console.warn(`[report-pipeline] duplicate-publish guard refused: ${reason}`);
    return {
      ran: false, reason: `already_approved: ${reason}`,
      existingRowId: approvedForGuard.id, matchedLabel: label,
    };
  }

  const routingOn = await routingEnabledForReports(env);
  // AD-028 is checked against the LANE TABLE, not against the lane's name:
  // resolveTaskLane() returns the ordered candidates from the live
  // config/model-routing.json, and candidates[0] is the primary that would
  // actually answer. Reading it here is the only reason the pin can fail
  // loudly if someone repoints the lane. Only meaningful with routing on —
  // the routing-off path calls Gemini directly and consults no lane at all.
  const draftLanePrimary = routingOn
    ? (resolveTaskLane(pickDraftLane('english')).candidates?.[0] ?? null)
    : null;
  const plan = planReportProviders({ routingOn, language: 'english', draftLanePrimary });
  for (const note of plan.notes) console.warn(`[report-pipeline] ${note}`);

  // Every lane substitution this run made. Surfaced in the byline, the D1 row
  // and the trigger's response — see noteProviderSubstitution().
  const substitutions = [];

  // ── Draft (or recover an unreviewed one) ──────────────────────────────
  let row = await getPendingReportRow(env, reportType, periodLabel);
  let factPack;
  let due = null;

  if (row) {
    // ── Recompute BOTH together, never one alone (fixed 2026-08-14) ────────
    // Previously: `due` was rebuilt fresh on every recovery/retry, but
    // `factPack` was reused unchanged from the stored row -- so the fresh due
    // DATE could validate fine while the frozen factPack still carried the
    // "days remaining" figure computed at the ORIGINAL draft time, which any
    // redraft prompt (structural-retry below, or a reviewer REVISE) would
    // keep re-feeding to the drafter verbatim. Live evidence, audit א.3:
    // reports/_drafts/weekly-week-07.md says "27 days remaining", correct on
    // 2026-08-11 and stale (should read 24) by 2026-08-14 -- because
    // validateReportBody() only checks that the DUE DATE STRING appears in
    // the body, never the day-count prose, so the drift was structurally
    // invisible. Both values now come from the SAME buildReportFacts() call,
    // and the refreshed pack is persisted back onto the row so a LATER retry
    // sees the same fresh numbers too, not another stale copy.
    const facts = await buildReportFacts(env, { reportType, periodLabel, dateStr, agentRows, pipelineSummary, sinceIso });
    factPack = facts.factPack;
    due = facts.due;
    if (factPack !== row.fact_pack) {
      await updateReportRow(env, row.id, { factPack });
      row = { ...row, fact_pack: factPack };
    }
  } else {
    const facts = await buildReportFacts(env, { reportType, periodLabel, dateStr, agentRows, pipelineSummary, sinceIso });
    factPack = facts.factPack;
    due = facts.due;

    const draft = await callReportModel(env, plan.draft, {
      prompt: buildReportDraftPrompt(factPack, { reportType, periodLabel }),
      systemPrompt: REPORT_DRAFT_SYSTEM,
      maxTokens: REPORT_DRAFT_MAX_TOKENS,
    });
    if (!draft.text) return { ran: false, reason: `draft_failed: ${draft.reason || 'no text returned'}` };
    noteProviderSubstitution('draft', draft.planned, draft.provider, substitutions);

    const id = await insertReportRow(env, {
      date: dateStr, reportType, periodLabel, status: 'drafted', factPack,
      draftContent: draft.text, drafterAgentId: plan.draft.agentId, drafterProvider: draft.provider,
      reviewerAgentId: plan.review.agentId,
    });
    row = await getPendingReportRow(env, reportType, periodLabel);
    if (!row) return { ran: false, reason: 'draft_missing_after_insert', id };
  }

  // ── Review ────────────────────────────────────────────────────────────
  //
  // The routing-off reviewer (Groq llama3-8b-8192) has an 8,192-token TOTAL
  // context, and the review prompt carries the whole fact pack AND the whole
  // draft. Check the fit BEFORE sending: an overrun on this provider comes
  // back as a truncated response that parses like a real one, because
  // groq-client.js reports no finish reason. Refuse loudly instead.
  // With routing ON the judgment lane is Cerebras at 131K input and this
  // never binds — hence the mode check.
  const runReview = async (draftContent, isSecondPass) => {
    const reviewPrompt = buildReportReviewPrompt(factPack, draftContent, { reportType, periodLabel, isSecondPass });
    if (plan.review.mode !== 'direct') {
      return callReportModel(env, plan.review, {
        prompt: reviewPrompt,
        systemPrompt: REPORT_REVIEW_SYSTEM,
        maxTokens: REPORT_REVIEW_MAX_TOKENS,
      });
    }

    // ── MEASURE WHAT IS ACTUALLY SENT (fixed 2026-08-09) ────────────────
    //
    // This guard used to size the request against REPORT_REVIEW_SYSTEM. That
    // string never reaches a provider: queryGroqRouted() sends
    // _buildPersonaSystemPrompt(), which appends the agent's state line, its
    // behavioral rules, its DB context and the office-context block
    // (agent-base.js:266-274). Measured on the first live run, the real total
    // was 8,347 tokens against an 8,192 ceiling — the call overran, and the
    // only reason the guard stayed quiet was its own over-estimating bias
    // pointing the wrong way. A guard that is wrong and happens not to bite
    // is a guard this project has now written down three times.
    //
    // So the reviewer is instantiated HERE, its assembled prompt is built
    // once, that prompt is what gets measured, and the same object and the
    // same string are handed to the call so nothing is assembled twice.
    const reviewer = instantiateAgent(plan.review.agentId, env);
    await reviewer.loadState();
    const assembledSystemPrompt = await reviewer.buildAssembledSystemPrompt(reviewPrompt, REPORT_REVIEW_SYSTEM);

    const fit = estimateReviewFit({
      factPack, draftContent,
      systemPrompt: assembledSystemPrompt,
      maxOutputTokens: REPORT_REVIEW_MAX_TOKENS,
    });
    if (!fit.fits) {
      console.warn(`[report-pipeline] ${fit.reason}`);
      return { text: null, provider: null, reason: `review_input_exceeds_direct_context (~${fit.estimated}/${fit.ceiling})` };
    }
    console.log(`[report-pipeline] review fits: ~${fit.estimated}/${fit.ceiling} tokens (assembled system prompt measured, not REPORT_REVIEW_SYSTEM)`);

    return callReportModel(env, plan.review, {
      prompt: reviewPrompt,
      systemPrompt: REPORT_REVIEW_SYSTEM,
      maxTokens: REPORT_REVIEW_MAX_TOKENS,
      agent: reviewer,
      assembledSystemPrompt,
    });
  };

  let review = await runReview(row.draft_content, false);
  if (!review.text) return { ran: false, reason: `review_failed: ${review.reason || 'no text returned'}` };
  noteProviderSubstitution('review', review.planned, review.provider, substitutions);

  // RULE 1, checked against the providers that ANSWERED. A review by the same
  // model that drafted is not a review; the row stays 'drafted' for a retry
  // in a configuration where the two differ.
  const distinct = assertDistinctReviewer({
    draftProvider: row.drafter_provider, reviewProvider: review.provider,
    draftAgentId: row.drafter_agent_id, reviewAgentId: plan.review.agentId,
  });
  if (!distinct.ok) {
    console.warn(`[report-pipeline] refusing to publish: ${distinct.reason}`);
    return { ran: false, reason: `self_qa_refused: ${distinct.reason}` };
  }

  let decision = parseReportReviewDecision(review.text);
  let revisionCount = row.revision_count || 0;
  // Set below only when a REJECT is the result of the structural gate
  // exhausting its one revision round, never a persona's own judgement — so
  // the final rejected artifact can still say so, distinctly, even though
  // status now resolves to 'rejected' rather than lingering in 'drafted'.
  let structuralReasonsForReject = null;
  // Visible, not silent: a reviewer emitting a report body means something is
  // still asking it to, and the only way that becomes known is a log line.
  if (decision.reEmitted) {
    console.warn('[report-pipeline] the reviewer emitted a ---REPORT--- section; it was DISCARDED. What publishes is the stored draft.');
  }

  // The reviewer's EDITS go back to the WRITER on a REVISE. They are never
  // applied to the draft by the pipeline itself — see report-pipeline.js's
  // header on why nothing edits the report between the decision and the commit.
  const noteWithEdits = (d) => [d.notes, d.edits ? `Requested edits:\n${d.edits}` : ''].filter(Boolean).join('\n\n');
  // What goes on the D1 row. Deliberately NOT what goes back to the writer on a
  // revision — a substitution is an operations fact, not a note about the prose,
  // and threading it into the revision prompt would put provider noise in front
  // of the drafter.
  const notesForRow = (d) => [
    noteWithEdits(d),
    substitutions.length
      ? `PROVIDER SUBSTITUTIONS: ${substitutions.map((s) => `${s.role} planned ${s.planned}, answered ${s.actual}`).join('; ')}`
      : '',
  ].filter(Boolean).join('\n\n');

  // ── One revision round. Exactly one. ──────────────────────────────────
  if (decision.decision === 'REVISE' && revisionCount < 1) {
    const revised = await callReportModel(env, plan.draft, {
      prompt: buildReportDraftPrompt(factPack, {
        reportType, periodLabel,
        priorDraft: { draftContent: row.draft_content, reviewNotes: noteWithEdits(decision) },
      }),
      systemPrompt: REPORT_DRAFT_SYSTEM,
      maxTokens: REPORT_DRAFT_MAX_TOKENS,
    });
    const nextDraft = revised.text || row.draft_content;
    revisionCount = 1;
    await updateReportRow(env, row.id, { draftContent: nextDraft, revisionCount });
    row = { ...row, draft_content: nextDraft, revision_count: 1 };

    noteProviderSubstitution('revision-draft', revised.planned, revised.provider, substitutions);
    review = await runReview(nextDraft, true);
    if (!review.text) return { ran: false, reason: `revision_review_failed: ${review.reason || 'no text returned'}` };
    noteProviderSubstitution('revision-review', review.planned, review.provider, substitutions);
    decision = parseReportReviewDecision(review.text);
    // A second REVISE is a REJECT. There is no third round.
    if (decision.decision === 'REVISE') decision = { ...decision, decision: 'REJECT' };
  } else if (decision.decision === 'REVISE') {
    decision = { ...decision, decision: 'REJECT' };
  }

  // ── An APPROVE over a missing or truncated body is not a decision ─────
  if (decision.decision === 'APPROVE') {
    // ── WHAT PUBLISHES IS THE STORED DRAFT (fixed 2026-08-09) ──────────
    //
    // Not `decision.finalReport` — that field no longer exists, and its
    // removal is the fix. The published artifact used to be sourced from the
    // reviewer's re-emission of a body it had just been handed; the
    // routing-off reviewer emitted DECISION and NOTES, never emitted the
    // marker, and an empty string reached this gate. The gate refused it
    // correctly, which is why the failure was safe and also why it produced
    // nothing.
    //
    // The gate below is UNCHANGED and every check in it still runs — it is
    // now simply pointed at the text the drafter actually wrote.
    let finalReport = row.draft_content || '';
    let structural = validateReportBody(finalReport, {
      // Full project objects, not just names: the consistency check matches the
      // fact pack's attribution (by key, `notebook-x`) against the report's
      // prose (by name, `Notebook-X`), and names alone cannot do that.
      factPack, due, projects: officeProjects.projects,
    });

    // ── THE STRUCTURAL REJECTION REASON NOW REACHES THE DRAFTER (fixed 2026-08-14) ──
    //
    // Previously: on a structural refusal the row stayed 'drafted' untouched
    // and the reasons were only ever written into review_notes -- nothing
    // read them back. The NEXT invocation's recovery path
    // (`if (row) {...}` above) re-reviewed the IDENTICAL stored
    // draft_content, unchanged, against the SAME facts -- so a reviewer that
    // approved once would tend to approve the same text again, and the
    // structural gate would refuse it again for the identical reason,
    // forever. Confirmed byte-identical stuck drafts on 2026-08-11 and
    // 2026-08-14 (audit א.1/א.2) — only the review notes reached anyone; the
    // structural gate's OWN reason never reached the one party who could act
    // on it, the drafter.
    //
    // This reuses the SAME "one revision round, exactly one" discipline the
    // reviewer-driven REVISE path above already enforces via `revisionCount`
    // — a structural refusal gets exactly one chance to be corrected, with
    // the real reason routed into the redraft prompt, before it is recorded
    // as a final REJECT rather than left stuck in 'drafted' for an identical
    // retry to loop on.
    if (!structural.ok && revisionCount < 1) {
      console.warn(`[report-pipeline] APPROVE refused structurally: ${structural.reasons.join(' | ')} — attempting the one revision round with the reason routed to the drafter`);
      const structuralRevised = await callReportModel(env, plan.draft, {
        prompt: buildReportDraftPrompt(factPack, {
          reportType, periodLabel,
          priorDraft: {
            draftContent: finalReport,
            reviewNotes: `STRUCTURAL REFUSAL (an automated check, not the reviewer's judgement — the reviewer had APPROVED this draft): ${structural.reasons.join(' | ')}`,
          },
        }),
        systemPrompt: REPORT_DRAFT_SYSTEM,
        maxTokens: REPORT_DRAFT_MAX_TOKENS,
      });
      const structuralNextDraft = structuralRevised.text || finalReport;
      revisionCount = 1;
      await updateReportRow(env, row.id, { draftContent: structuralNextDraft, revisionCount });
      row = { ...row, draft_content: structuralNextDraft, revision_count: 1 };
      noteProviderSubstitution('structural-revision-draft', structuralRevised.planned, structuralRevised.provider, substitutions);

      review = await runReview(structuralNextDraft, true);
      if (!review.text) return { ran: false, reason: `structural_revision_review_failed: ${review.reason || 'no text returned'}` };
      noteProviderSubstitution('structural-revision-review', review.planned, review.provider, substitutions);
      decision = parseReportReviewDecision(review.text);
      // A REVISE here would ask for a SECOND round — there is no third round
      // anywhere else in this pipeline, so this does not get one either.
      if (decision.decision === 'REVISE') decision = { ...decision, decision: 'REJECT' };

      if (decision.decision === 'APPROVE') {
        finalReport = row.draft_content || '';
        structural = validateReportBody(finalReport, { factPack, due, projects: officeProjects.projects });
      }
    }

    if (decision.decision === 'APPROVE' && !structural.ok) {
      // FINAL: either the one revision round just ran and still failed
      // structurally, or it was already spent earlier (a reviewer-driven
      // REVISE) before this draft ever reached this gate. Either way there
      // is no round left — recorded as a REJECT via `decision.decision` so
      // the unconditional REJECT branch below persists status='rejected'
      // (never left 'drafted' for an identical retry to loop on).
      console.warn(`[report-pipeline] APPROVE refused structurally (final — revision round ${revisionCount >= 1 ? 'used' : 'unavailable'}): ${structural.reasons.join(' | ')}`);
      structuralReasonsForReject = structural.reasons;
      decision = {
        ...decision,
        decision: 'REJECT',
        notes: [decision.notes, `STRUCTURAL REFUSAL (automated check, not the reviewer's judgement): ${structural.reasons.join(' | ')}`].filter(Boolean).join('\n\n'),
      };
    }

    // Everything from here on publishes -- and only runs if the decision is
    // STILL 'APPROVE'. It may have just been flipped to 'REJECT' above (the
    // one revision round ran and still failed structurally, or had already
    // been spent). When flipped, this nested block is skipped entirely and
    // execution falls through to the unconditional REJECT branch at the
    // bottom of the function, which persists status='rejected' using
    // `row.draft_content` (the revised text, if a structural revision ran)
    // and `decision.notes` (now carrying the structural reason).
    if (decision.decision === 'APPROVE') {
    // ── OFFICE-POLICY A9: the weekly Hebrew executive summary ─────────────
    // Runs against the STRUCTURALLY-APPROVED English body — validateReportBody()
    // above already checked exactly this text, and prepending Hebrew after
    // that check (never before) means the gate keeps checking precisely what
    // it always checked. "Only Gemini writes Hebrew": always the DIRECT
    // queryGeminiDirect() path below, never routed, regardless of
    // routing_enabled — same rule agent-base.js's flagCapabilityGap() keeps.
    // A failed composition degrades to publishing the English body alone,
    // loudly logged — same "a report that cannot be produced is a logged
    // skip, never a broken cron tick" posture the rest of this pipeline uses.
    let reportWithHebrew = finalReport;
    if (reportType === 'weekly') {
      const hebrewCall = await callReportModel(
        env,
        { mode: 'direct', path: 'queryGeminiDirect', provider: 'gemini', agentId: row.drafter_agent_id },
        { prompt: buildWeeklySummaryPrompt(finalReport, { periodLabel }), systemPrompt: HEBREW_SYSTEM_PROMPT, maxTokens: 500 }
      );
      if (hebrewCall.text) {
        reportWithHebrew = withWeeklySummary(finalReport, hebrewCall.text);
      } else {
        console.warn(`[report-pipeline] A9 Hebrew executive summary NOT composed — ${hebrewCall.reason || 'no text returned'}. Publishing the English body alone.`);
      }
    }

    const drafterConfig = getAgentConfig(row.drafter_agent_id);
    const reviewerConfig = getAgentConfig(plan.review.agentId);
    const finalMarkdown = renderReportFile({
      reportType, periodLabel, dateStr,
      finalReport: reportWithHebrew,
      drafterName: drafterConfig?.name || `Agent ${row.drafter_agent_id}`,
      drafterProvider: row.drafter_provider,
      reviewerName: reviewerConfig?.name || `Agent ${plan.review.agentId}`,
      reviewerProvider: review.provider,
      revisionCount,
      reviewerEdits: decision.edits,
      drafterPlanned: plan.draft.provider,
      reviewerPlanned: plan.review.provider,
      workerVersion: workerVersion(env),
    });
    const path = reportPath(reportType, periodLabel);
    const commit = await commitFileToRepo(
      env, REPO_NAME, path, finalMarkdown,
      `chore(agents): ${reportType} report — ${periodLabel} (reviewed) [skip ci]`
    );
    await updateReportRow(env, row.id, {
      status: 'approved', finalContent: finalMarkdown, reviewNotes: notesForRow(decision),
      reviewerProvider: review.provider, revisionCount,
    });

    // NEWEST FIRST. A flat directory of dated filenames is a filing cabinet,
    // not a shopfront — a visitor cannot tell which of 19 files is current.
    // The index is maintained HERE rather than hand-written, because a
    // hand-written "latest" list is stale the next time the cron runs.
    // It indexes; it never deletes. The archive is permanent.
    let indexed = false;
    if (commit.committed) {
      try {
        const existing = parseLatestIndex(await fetchRawRepoFile(LATEST_INDEX_PATH));
        const next = addToLatestIndex(existing, {
          title: `${reportType === 'monthly' ? 'Monthly' : 'Weekly'} report — ${periodLabel}`,
          path: `/${path}`,
          reportType,
          dateStr,
          words: wordCount(finalReport),
        });
        const idx = await commitFileToRepo(
          env, REPO_NAME, LATEST_INDEX_PATH, renderLatestIndex(next),
          `chore(agents): index ${reportType} report ${periodLabel} [skip ci]`
        );
        indexed = idx.committed;
      } catch (err) {
        // The index is a convenience. A report that published successfully is
        // not un-published because its index entry failed.
        console.warn(`[report-pipeline] index update failed: ${err.message}`);
      }
    }

    return { ran: true, decision: 'APPROVE', path, committed: commit.committed, indexed, revisionCount, drafterProvider: row.drafter_provider, reviewerProvider: review.provider, providerSubstitutions: substitutions };
    } // end: if (decision.decision === 'APPROVE') -- the nested, post-structural-retry check
  }

  // ── REJECT: saved with its note, and the pipeline moves on. ───────────
  // A REJECT that originated from an exhausted structural revision round
  // (structuralReasonsForReject set above) still gets its own headline and
  // its reasons carried structurally, not just folded into prose — the
  // reviewer approved this draft; only the automated gate refused it, and
  // the artifact should not read as if a persona rejected its own approval.
  const drafterConfig = getAgentConfig(row.drafter_agent_id);
  const reviewerConfig = getAgentConfig(plan.review.agentId);
  const rejectedMarkdown = renderRejectedReportFile({
    reportType, periodLabel, dateStr,
    draftContent: row.draft_content, reviewNotes: noteWithEdits(decision),
    drafterName: drafterConfig?.name || `Agent ${row.drafter_agent_id}`,
    reviewerName: reviewerConfig?.name || `Agent ${plan.review.agentId}`,
    ...(structuralReasonsForReject
      ? { headline: `STRUCTURALLY REFUSED ${reportType.toUpperCase()} REPORT (revision round exhausted)`, structuralReasons: structuralReasonsForReject }
      : {}),
  });
  const path = rejectedReportPath(reportType, periodLabel);
  const commit = await commitFileToRepo(
    env, REPO_NAME, path, rejectedMarkdown,
    `chore(agents): ${reportType} report rejected — ${periodLabel} [skip ci]`
  );
  await updateReportRow(env, row.id, {
    status: 'rejected', reviewNotes: notesForRow(decision), reviewerProvider: review.provider, revisionCount,
  });
  return { ran: true, decision: 'REJECT', path, committed: commit.committed, revisionCount, providerSubstitutions: substitutions };
}

/** Thin wrapper so the pipeline reads the routing flag through one name that
 *  the verifier can find, and so a future change of switch cannot diverge
 *  between the two callers. */
async function routingEnabledForReports(env) {
  const sim = await getSimulationState(env);
  return sim.routing_enabled === true;
}

/* ─────────────────────────── Config overrides ──────────────────────────── */

/**
 * Merges `overrides` into an agent's durable `configOverrides` (DO state).
 * agent-base.js's loadState() merges configOverrides over the static
 * agents-config.json entry the next time the agent is instantiated.
 */
async function applyConfigOverride(env, agentId, overrides) {
  const config = getAgentConfig(agentId);
  if (!env.AGENT_STATE || !config) return;

  const doId = env.AGENT_STATE.idFromName(config.durable_object_id);
  const stub = env.AGENT_STATE.get(doId);

  const res = await stub.fetch('https://agent-state/state');
  const data = await res.json().catch(() => ({}));
  const merged = { ...(data.configOverrides || {}), ...overrides };

  await stub.fetch('https://agent-state/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, configOverrides: merged, updated_at: new Date().toISOString() }),
  });
}

/* ──────────────────────────────── Side plots ───────────────────────────── */

async function getSidePlots(env, status) {
  if (!env.DB) return [];
  const stmt = status
    ? env.DB.prepare(`SELECT * FROM side_plots WHERE status = ? ORDER BY created_at DESC LIMIT 50`).bind(status)
    : env.DB.prepare(`SELECT * FROM side_plots ORDER BY created_at DESC LIMIT 50`);
  const { results } = await stmt.all();
  return results.map((r) => ({ ...r, agents: JSON.parse(r.agents || '[]') }));
}

async function countActiveSidePlots(env) {
  if (!env.DB) return 0;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM side_plots WHERE status = 'active'`).first().catch(() => null);
  return row?.n || 0;
}

async function hasActiveSidePlot(env, type) {
  if (!env.DB) return false;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM side_plots WHERE status = 'active' AND type = ?`).bind(type).first().catch(() => null);
  return (row?.n || 0) > 0;
}

/** Starts a new side plot (side-plots.json side_plot_types[type]) if under max_concurrent and not already active. */
async function startSidePlot(env, type, agentIds, startDay) {
  const typeConfig = sidePlotsConfig.side_plot_types[type];
  if (!typeConfig || !env.DB) return null;
  if (await countActiveSidePlots(env) >= sidePlotsConfig.lifecycle.max_concurrent) return null;
  if (await hasActiveSidePlot(env, type)) return null;

  const duration = Array.isArray(typeConfig.duration_days)
    ? typeConfig.duration_days[typeConfig.duration_days.length - 1]
    : typeConfig.duration_days;

  const id = crypto.randomUUID();
  const reportPath = typeConfig.output_path
    .replace('{{type}}', type)
    .replace('{{start_date}}', new Date().toISOString().slice(0, 10));

  await env.DB.prepare(
    `INSERT INTO side_plots (id, type, agents, start_day, duration_days, current_stage, status, log, report_path, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'active', '', ?, CURRENT_TIMESTAMP)`
  ).bind(id, type, JSON.stringify(agentIds), startDay, duration, reportPath).run().catch(() => {});

  return { id, type, agents: agentIds, start_day: startDay, duration_days: duration, report_path: reportPath };
}

function renderSidePlotReport(plot, typeConfig, log) {
  const agents = JSON.parse(plot.agents || '[]');
  return `# ${typeConfig.label} — started day ${plot.start_day}

## Agents involved

${agents.map((a) => `- Agent ${a}`).join('\n')}

## Timeline

${log}

## Resolution

${typeConfig.resolution}
`;
}

/** Advances `current_stage` for every active side plot whose stage list has an entry for `currentDay`. */
async function advanceSidePlots(env, currentDay) {
  if (!env.DB) return [];
  const { results: active } = await env.DB.prepare(`SELECT * FROM side_plots WHERE status = 'active'`).all();
  const updates = [];

  for (const plot of active) {
    const typeConfig = sidePlotsConfig.side_plot_types[plot.type];
    if (!typeConfig) {
      // Plot type no longer defined (e.g. client_crisis, retired 2026-07-19
      // with the Netvill-CRM vocabulary) — close the row out instead of
      // leaving it wedged 'active' forever in summaries/max_concurrent.
      const closedLog = `${plot.log ? `${plot.log}\n` : ''}(plot type '${plot.type}' retired — auto-closed)`;
      await env.DB.prepare(
        `UPDATE side_plots SET log = ?, status = 'resolved', resolved_at = ? WHERE id = ?`
      ).bind(closedLog, new Date().toISOString(), plot.id).run().catch(() => {});
      updates.push({ id: plot.id, type: plot.type, status: 'resolved', retired: true });
      continue;
    }

    const dayOffset = currentDay - plot.start_day + 1;
    const stage = typeConfig.stages.find((s) => s.day === dayOffset);
    if (!stage || dayOffset <= plot.current_stage) continue;

    const logLine = `Day ${dayOffset}: ${stage.event}`;
    const newLog = plot.log ? `${plot.log}\n${logLine}` : logLine;
    const lastStageDay = typeConfig.stages[typeConfig.stages.length - 1].day;
    const isFinal = dayOffset >= lastStageDay;
    const status = isFinal ? 'resolved' : 'active';

    await env.DB.prepare(
      `UPDATE side_plots SET current_stage = ?, log = ?, status = ?, resolved_at = ? WHERE id = ?`
    ).bind(dayOffset, newLog, status, isFinal ? new Date().toISOString() : null, plot.id).run().catch(() => {});

    if (isFinal) {
      const markdown = renderSidePlotReport(plot, typeConfig, newLog);
      // Moved to back-office 2026-08-11 (plan 0.4, stage 4 of 5). Plots
      // already active before this change carry a report_path stamped at
      // startSidePlot() time under the pre-migration `reports/side-plots/`
      // prefix (D1 rows are not rewritten, per A15) — normalized here so an
      // in-flight plot still lands on the current campus/shared/ convention
      // instead of that stale prefix inside the new repo.
      const reportPath = plot.report_path.startsWith('reports/side-plots/')
        ? plot.report_path.replace('reports/side-plots/', 'campus/shared/side-plots/')
        : plot.report_path;
      await commitFileToRepo(env, BACKOFFICE_REPO_NAME, reportPath, markdown, `chore(office): ${plot.type} side plot resolved [skip ci]`);
    }

    updates.push({ id: plot.id, type: plot.type, dayOffset, stage: stage.event, status });
  }

  return updates;
}

/**
 * Heuristic checks run once per work-day cycle to seed new side plots
 * (side-plots.json side_plot_types triggers).
 */
async function maybeStartSidePlots(env, { day, summary, cases, standup }) {
  const started = [];

  // rivalry_escalation: Architect (10) repeatedly irritated by audits.
  const architect = summary.agents.find((a) => a.agentId === 10);
  if (architect && architect.irritation >= 2) {
    const plot = await startSidePlot(env, 'rivalry_escalation', [10, 8], day);
    if (plot) started.push(plot);
  }

  // client_crisis: RETIRED 2026-07-19 — Netvill-CRM vocabulary ("clients"
  // in crisis) with a trigger keyed off retired CRM case fields
  // (is_unique_client/requires_it_chief) that Q&A-engine questions never
  // set. Removed with owner approval; advanceSidePlots() auto-closes any
  // lingering active row of a retired type.

  // breakthrough: an agent ended HAPPY after handling an advanced case.
  const breakthroughAgent = summary.agents.find((a) => a.isHappy && a.advancedCases > 0);
  if (breakthroughAgent && Math.random() < 0.5) {
    const senior = breakthroughAgent.agentId === 5 || breakthroughAgent.agentId === 10
      ? null
      : (Math.random() < 0.5 ? 5 : 10);
    const agents = senior ? [breakthroughAgent.agentId, senior] : [breakthroughAgent.agentId];
    const plot = await startSidePlot(env, 'breakthrough', agents, day);
    if (plot) started.push(plot);
  }

  // comparison_event: repurposed 2026-07-18 (Q&A-engine rebuild) — the old
  // "compare alternatives" external-source-check signal it used to key off
  // is retired along with the Netvill-CRM case model. Now fires when an
  // agent filed a genuine capability-gap report today (agent.flagCapabilityGap()
  // -> reports type='gap_hebrew') — a comparable "found something the tool
  // should have handled better" moment, just from the new signal.
  if (env.DB) {
    const gapRow = await env.DB.prepare(
      `SELECT agent_id FROM reports WHERE type = 'gap_hebrew' AND DATE(created_at) = DATE('now') LIMIT 1`
    ).first().catch(() => null);
    if (gapRow?.agent_id) {
      const agents = Math.random() < 0.5 ? [gapRow.agent_id, 6] : [gapRow.agent_id];
      const plot = await startSidePlot(env, 'comparison_event', agents, day);
      if (plot) started.push(plot);
    }
  }

  // inspiration_event: Designer (9) crosses inspired_threshold.
  const designer = instantiateAgent(9, env);
  await designer.loadState();
  const inspiredThreshold = designer.config.inspired_threshold ?? 51;
  if (designer.mood >= inspiredThreshold) {
    const source = Math.random() < 0.5 ? 11 : 10;
    const plot = await startSidePlot(env, 'inspiration_event', [9, source], day);
    if (plot) started.push(plot);
  }

  // meeting_tension: today's standup left 2+ agents irritated.
  if (standup && !standup.error && (standup.decisions?.irritation_effects?.length || 0) >= 2) {
    const plot = await startSidePlot(env, 'meeting_tension', standup.attendees, day);
    if (plot) started.push(plot);
  }

  return started;
}

/* ─────────────────────────────── Reporting ─────────────────────────────── */

/**
 * Renders the office-context block for a REPORT (sites 3 and 4 of the
 * 2026-08-07 context survey).
 *
 * These two renderers are string templates that make NO MODEL CALL — their
 * output is committed markdown a human reads. So context here is FREE, which
 * is why the report shape carries the fuller version (BUDGETS.report) while
 * the per-call agent shape is held to 400 tokens.
 *
 * A degraded snapshot is rendered VISIBLY here rather than omitted. The
 * prompts omit-and-log because an error string in a prompt is noise the model
 * will try to act on; a report is read by a person, and a person needs to
 * know the section is incomplete. "The office had a quiet week" and "the
 * board could not be read" must never look the same.
 */
function renderOfficeSection(office) {
  if (!office) return '';
  if (office.reason === 'office_context_disabled') return '';
  if (!office.text) {
    return `\n## The Office's Own Work\n\n⚠️ **Could not be read this cycle** — ${office.reason || 'reason not reported'}.\nThis section is missing, not empty. Do not read its absence as "no office work".\n`;
  }
  return `\n## The Office's Own Work\n\n${office.text}\n`;
}

/**
 * OFFICE-POLICY A9's daily half. Composes the short Hebrew headline and
 * prepends it — see workers/hebrew-summary.js's header for exactly what
 * "Hebrew, entirely" does and does not mean here.
 *
 * Called ONLY when `!isOffDay` — a Saturday render still happens (free,
 * template-only, per the A13 comment at this function's call sites) but
 * MUST NOT spend a model call, since nothing is committed on a rest day and
 * a call whose result is thrown away is exactly the kind of spend A13
 * exists to prevent. Agent 12 (The Workflow) composes it — his declared
 * role is running the delegation board and naming what is stuck, the same
 * question this headline answers, and he is not a persona-flavored voice
 * the way a gap note's flagging agent is.
 */
async function composeDailyHeadline(env, markdown, isOffDay) {
  if (isOffDay) return markdown;
  const hebrewCall = await callReportModel(
    env,
    { mode: 'direct', path: 'queryGeminiDirect', provider: 'gemini', agentId: 12 },
    { prompt: buildDailyHeadlinePrompt(markdown), systemPrompt: HEBREW_SYSTEM_PROMPT, maxTokens: 300 }
  );
  if (!hebrewCall.text) {
    console.warn(`[daily-summary] A9 Hebrew headline NOT composed — ${hebrewCall.reason || 'no text returned'}. Publishing the English body alone.`);
    return markdown;
  }
  return withDailyHeadline(markdown, hebrewCall.text);
}

function renderDailySummary(yearState, summary, standup, sidePlotStarted, sidePlotUpdates, milestone, scheduleInfo, office, branches, deferrals = null) {
  const agentLines = summary.agents
    .map((a) => `- Agent ${a.agentId}: ${a.handled}/${a.caseCount} cases, mood ${a.mood}, irritation ${a.irritation}${a.isAngry ? ' (ANGRY)' : ''}${a.isPanic ? ' (PANIC)' : ''}`)
    .join('\n') || '_No agents processed cases today._';

  // OB-074 remedy (c): the day's throughput cost, stated at the top rather
  // than left to be inferred from a batch table further down. A day that
  // deferred most of its cases must not read like a day that did the work.
  const deferralLine = deferrals && deferrals.totalCases
    ? (deferrals.deferred > 0
      ? `\n> **Case throughput: ${deferrals.processed}/${deferrals.totalCases} asked — ${deferrals.deferred} DEFERRED to the invocation budget (OB-074).**\n` +
        `> Deferred is not dropped: the cases stay in the day cycle and are drained oldest-first at the next case batch.\n` +
        (deferrals.cutShort.length
          ? `> Cut short: ${deferrals.cutShort.map((c) => `${c.block} (${c.processed}/${c.totalCases})`).join(', ')}.\n`
          : '')
      : `\n> **Case throughput: ${deferrals.processed}/${deferrals.totalCases} asked — none deferred.**\n`)
    : '';

  const startedLines = sidePlotStarted.map((p) => `- Started: ${p.type} (agents ${p.agents.join(', ')})`).join('\n');
  const updateLines = sidePlotUpdates.map((u) => `- ${u.type}: ${u.stage} (${u.status})`).join('\n');
  const sidePlotLines = [startedLines, updateLines].filter(Boolean).join('\n') || '_None._';

  const scheduleSection = scheduleInfo ? renderScheduleSection(scheduleInfo) : '';

  return `# Day ${yearState.current_day} Summary — ${new Date().toISOString()}

Week ${yearState.current_week}, Month ${yearState.current_month}, Quarter ${yearState.current_quarter} (Year ${yearState.stats.year_number || 1}).
${milestone ? `\n**Milestone: ${milestone.label}** — ${milestone.description}\n` : ''}${deferralLine}
## Case Handling

${agentLines}

## Daily Standup

${standup?.transcript ? standup.transcript : standup?.error ? `_Standup error: ${standup.error}_` : '_No standup recorded._'}

## Side Plot Activity

${sidePlotLines}
${renderOfficeSection(office)}
${/* A7: "Open branches and their age appear in the daily report." Rendered even
     when the fetch partly failed — renderBranchSection() prints an unreadable
     repo AS unreadable rather than omitting it, because an omitted repo reads
     as a repo with no branches. `branches` is null only when the caller did
     not ask, or when the fetch threw. */
  branches ? renderBranchSection(branches) : ''}${scheduleSection}`;
}

/** Renders the tactical-schedule section (case batches, tool-task window, AI-experience reports, spare time, weekly summary). */
function renderScheduleSection(scheduleInfo) {
  const { schedule, batches, toolTask, aiExperience, spareTime, weeklySummary, versionBumps, choreRotation, guideDraft, guideReview, guideVerify } = scheduleInfo;

  // ── DEFERRED IS NOT DONE, AND THE REPORT SAYS WHICH (OB-074, 2026-08-16) ──
  // This line used to read "N case(s)", which is the number ASSIGNED to the
  // batch and says nothing about whether any of them ran. Every batch printed
  // the same way whether it completed, was cut short by the invocation budget,
  // or never started — so a day on which 6 of 200 cases were asked read
  // exactly like a day on which all 200 were. That is remedy (c) of OB-074:
  // make the cost visible rather than silent.
  const batchLines = batches
    .map((b) => {
      const s = summarizeBatchState(b);
      const mark = s.state === 'completed' ? 'completed'
        : s.state === 'cut_short' ? `**CUT SHORT** — ${s.deferred} deferred`
        : '**not started**';
      return `- ${b.block.time || '—'} ${b.block.label}: ${s.processed}/${s.totalCases} case(s) — ${mark}`;
    })
    .join('\n') || '_No case batches (off day)._';

  const toolTaskLine = toolTask
    ? toolTask.opened
      ? `Opened asset-task for \`${toolTask.item}\` (tool: ${toolTask.tool}, agents ${toolTask.agents?.join(', ')}).`
      : `No new asset-task opened (${toolTask.reason || 'n/a'}).`
    : '_Not a tool-task day (Fri/Sat)._';

  const choreRotationLine = choreRotation
    ? `**${choreRotation.projectKey}**: ${choreRotation.reason}${choreRotation.routedModel ? ` (would route to ${choreRotation.routedModel})` : ''}`
    : '_No chore-rotation block today._';

  const guideLines = [
    guideDraft ? `- Draft: ${guideDraft.drafted ? `\`${guideDraft.topic}\` (${guideDraft.domain}, agent ${guideDraft.writerAgentId})` : `skipped — ${guideDraft.reason}`}` : null,
    guideReview ? `- Review: ${guideReview.reviewed ? `${guideReview.decision} -> [\`${guideReview.path}\`](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/master/${guideReview.path})${guideReview.committed === false ? ' _(commit pending)_' : ''}` : `skipped — ${guideReview.reason}`}` : null,
    guideVerify ? `- Weekly verify: ${guideVerify.verified}/${(guideVerify.outcomes || []).length || 0} section(s) verified${guideVerify.reason ? ` (${guideVerify.reason})` : ''}` : null,
  ].filter(Boolean).join('\n') || '_No guides-pipeline blocks today._';

  const statusReportLines = (aiExperience?.statusReports || [])
    .map((r) => `- Agent ${r.agentId}: "${r.note}"`).join('\n') || '_None filed today._';
  const gapDigestLines = (aiExperience?.gapDigests || [])
    .map((d) => `- **${d.project}**: ${d.count} finding${d.count === 1 ? '' : 's'} -> [\`${d.reportPath}\`](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/master/${d.reportPath})${d.committed ? '' : ' _(commit pending — no GITHUB_TOKEN?)_'}`)
    .join('\n') || '_None — no genuine capability gaps flagged today._';

  const spareTimeLines = spareTime
    .map((s) => s.mode === 'idle' ? `- Agent ${s.agentId}: idle (token-saving)` : `- Agent ${s.agentId}: chatted with agent ${s.partner}`)
    .join('\n') || '_No agents reached spare time today._';

  let weeklySection = '';
  if (weeklySummary) {
    const bumpLines = versionBumps.length
      ? versionBumps.map((b) => `- \`${b.id}\` -> v${b.version.toFixed(2)}`).join('\n')
      : '_No products reached "implemented" this week._';
    weeklySection = `

## Weekly Executive Summary (Friday)

Generated \`campus/shared/weekly/week-${pad(weeklySummary.weekNumber, 2)}-{summary.md,data.csv,public-summary.md}\` (back-office — plan 0.4 stage 3).

**Product version bumps:**
${bumpLines}`;
  }

  return `
## Daily Schedule

**Day type:** ${schedule === dailyScheduleConfig.saturday_schedule ? 'Saturday (off)' : schedule === dailyScheduleConfig.friday_schedule ? 'Friday (short)' : 'Sun-Thu (full)'}

### Case Batches

${batchLines}

### AI-Tool Task Window

${toolTaskLine}

### Cross-Project Chore Rotation

${choreRotationLine}

### Guides Pipeline

${guideLines}

### Daily AI-Experience Reports

${statusReportLines}

### Capability-Gap Reports (Hebrew, internal — reports/gaps/<project>/<date>.md)

${gapDigestLines}

### Spare Time

${spareTimeLines}${weeklySection}
`;
}

function renderPromotionResults(yearNumber, meeting) {
  const decisions = meeting.decisions || {};
  const overrides = (decisions.config_overrides || [])
    .map((o) => `- Agent ${o.agent_id}: ${JSON.stringify(o.overrides)} — ${o.reason}`)
    .join('\n') || '_None recorded._';

  return `# Year ${yearNumber} Promotion Results

## Summary

${decisions.summary || '_No summary provided._'}

## Approved Promotions / Config Overrides

${overrides}

## Action Items for Year ${yearNumber + 1}

${(decisions.action_items || []).map((a) => `- [ ] ${a}`).join('\n') || '_None._'}

## Full Yearly Meeting Transcript

${meeting.transcript || '_Not available._'}
`;
}

/* ─────────────────────────────── Work day cycle ────────────────────────── */

/** Normalizes the differing handleCase() return shapes across agent classes. */
function extractOutcome(raw) {
  if (!raw) return { result: null, escalation: null, quality: undefined };
  if (Object.prototype.hasOwnProperty.call(raw, 'escalation')) {
    return { result: raw.result || null, escalation: raw.escalation || null, quality: raw.result?.quality };
  }
  return { result: raw, escalation: null, quality: raw.quality };
}

/**
 * Joint session: the escalated agent (selected by TraineeAgent's
 * escalation protocol) also works the trainee's case.
 */
async function handleTraineePanic(env, event) {
  const helper = instantiateAgent(event.selectedAgent, env);
  await helper.loadState();
  await helper.handleCase(event.caseData);

  return { helperAgentId: event.selectedAgent };
}

/* ─────────────────────────── Daily schedule (Phase 2) ──────────────────── */

/** Returns the day-type schedule block for a 1-7 dayOfWeek (1=Sun..7=Sat), per daily-schedule.json week_mapping. */
function getDaySchedule(dayOfWeek) {
  if (dailyScheduleConfig.friday_schedule.applies_to_day_of_week.includes(dayOfWeek)) return dailyScheduleConfig.friday_schedule;
  if (dailyScheduleConfig.saturday_schedule.applies_to_day_of_week.includes(dayOfWeek)) return dailyScheduleConfig.saturday_schedule;
  return dailyScheduleConfig.full_day_schedule;
}

/** Splits `cases` (in original order) across the schedule's `case_batch` blocks per their case_share; the last batch absorbs any rounding remainder. */
function partitionCasesByShare(cases, blocks) {
  const batchBlocks = blocks.filter((b) => b.type === 'case_batch');
  if (!batchBlocks.length) return [{ block: { label: 'All cases', time: null }, cases }];

  const total = cases.length;
  const counts = batchBlocks.map((b) => Math.round(total * (b.case_share || 0)));
  const sum = counts.reduce((a, b) => a + b, 0);
  counts[counts.length - 1] += total - sum;

  const out = [];
  let idx = 0;
  for (let i = 0; i < batchBlocks.length; i++) {
    const n = Math.max(0, counts[i]);
    out.push({ block: batchBlocks[i], cases: cases.slice(idx, idx + n) });
    idx += n;
  }
  return out;
}

/**
 * Processes one scheduled question batch: groups by assigned agent,
 * instantiates (and caches across batches) each agent, and runs
 * handleCase() — really "ask this question and evaluate the answer" now —
 * per question, accumulating per-agent stats.
 *
 * Agent 10 (The Architect) never appears here — workers/qa-engine.js's
 * getActiveQaAgents() excludes it from question generation entirely (dormant,
 * reserved for owner-directed special tasks only, per the 2026-07-18
 * Q&A-engine rebuild). The old per-batch Architect special case
 * (processArchitectCaseBatch(), a root-level-escalation GitHub Issue filer)
 * was dead code even before this rebuild — no case was ever assigned to
 * agent 10 — and has been removed rather than kept unreachable.
 *
 * The old "compare alternatives" external-source-check sampling and the
 * batched end-of-day "model education" low-quality log are both retired —
 * gap-flagging now happens in real time inside agent.askAssignedProject()
 * (see agents/agent-base.js flagCapabilityGap()), not from a batch-level
 * quality scan here.
 */
// OB-074 Phase 3: hand the real case runner to the Durable Object side. This
// runs once, at bundle load, and is the inversion that keeps state-manager.js
// from importing this file. See case-batch-do.js's header.
setCaseBatchRunner((env, cases, agentInstances, agentStats, budget) =>
  processCaseBatch(env, cases, agentInstances, agentStats, budget));

async function processCaseBatch(env, batchCases, agentInstances, agentStats, budget = null) {
  // ── THE ROUTER PRE-PASS IS GONE (OB-074, 2026-08-16) ─────────────────────
  //
  // This loop used to run one Cloudflare Workers AI call PER CASE IN THE
  // BATCH, before a single question was asked — 30 subrequests on a Sun-Thu
  // 0.15 share, 80 on Friday's opening batch, against a 50-subrequest
  // invocation budget. It was the single largest line item in the tick and
  // the reason the cap was already blown before any work happened.
  //
  // What it bought: `c.cf_category`. Grepped across all three repos on
  // 2026-08-16 — **that field is written here and read by nothing.** One
  // occurrence in the codebase, this one. It is not persisted (the cases were
  // already written to D1 by persistQuestions() before this runs), not read by
  // qa-engine, not read by the router, not read by any report. KFM-12, at
  // 30-80 subrequests a tick.
  //
  // Deleted rather than gated: there is no switch position that makes an
  // unread field worth a Workers AI call. `callCFRouter` itself is untouched
  // and still imported for its other callers.

  const byAgent = new Map();
  for (const c of batchCases) {
    if (!byAgent.has(c.assigned_to)) byAgent.set(c.assigned_to, []);
    byAgent.get(c.assigned_to).push(c);
  }

  // What actually got done, so the caller can tell CUT SHORT from FINISHED.
  // `processedIds` is the discriminator: the caller advances its cursor by
  // what is in here, never by what it handed in.
  const outcome = { processed: 0, deferred: 0, processedIds: new Set(), stoppedForBudget: false };

  for (const [agentId, agentCases] of byAgent) {
    if (outcome.stoppedForBudget) {
      outcome.deferred += agentCases.length;
      continue;
    }

    let agent = agentInstances.get(agentId);
    if (!agent) {
      // Instantiating an agent costs a Durable Object read, which the meter
      // counts on its own. Only the affordability check belongs here.
      if (budget && !budget.canAfford(CASE_LOOKAHEAD, LANE_CASES)) {
        outcome.stoppedForBudget = true;
        outcome.deferred += agentCases.length;
        continue;
      }
      agent = instantiateAgent(agentId, env);
      await agent.loadState();
      agentInstances.set(agentId, agent);
    }

    if (!agentStats.has(agentId)) {
      agentStats.set(agentId, { agentId, caseCount: 0, handled: 0, escalations: 0, advancedCases: 0 });
    }
    const stats = agentStats.get(agentId);
    stats.caseCount += agentCases.length;

    // 2026-07-19 fix: no ANGRY skip here. Under the quality-primary mood
    // design an agent's only path back to CALM/HAPPY is a good answer to a
    // question it actually asked — skipping angry agents made ANGRY a
    // dead-end until the weekly reset (and silently dropped their assigned
    // questions, as on the 2026-07-19 first live day). Anger still colors
    // the persona (state line in the persona system prompt, agent-2's own
    // cooldown logic in agent-2-productive.js handleCase()); it no longer
    // suppresses the core ask-and-evaluate task.
    // ── COALESCED STATE WRITES (OB-074) ──────────────────────────────────
    // Measured: 87 Durable Object fetches on a 30-case tick — ~2.9 per case,
    // almost all of them saveState() PUTs from startSession/mood/endSession.
    // Inside one batch those are three round trips to write a mood that only
    // the last value of matters. beginCoalescedState() marks the state dirty
    // instead of writing it; flushAgentState() writes once, next to the
    // journal flush that already works this way. Outside a batch (HTTP
    // triggers, meetings) saveState() is unchanged and still writes through.
    if (typeof agent.beginCoalescedState === 'function') agent.beginCoalescedState();

    for (const c of agentCases) {
      // Phase 2: the loop asks the ledger before EVERY case, against what the
      // tick has REALLY spent so far (meterEnv counts it) rather than against
      // a running estimate. `CASE_LOOKAHEAD` is the p90, so a case that turns
      // out to be the expensive kind can overshoot by at most
      // CASE_COST_MAX - CASE_LOOKAHEAD, which is exactly what
      // TICK_TAIL_RESERVE is sized to absorb.
      if (budget && !budget.canAfford(CASE_LOOKAHEAD, LANE_CASES)) {
        outcome.stoppedForBudget = true;
        outcome.deferred += 1;
        continue;
      }

      // The external `fetch()` calls this case is about to make are the one
      // thing the meter cannot see. Charged up front so they cannot be
      // discovered too late. See EXTERNAL_FETCH_ALLOWANCE_PER_CASE.
      if (budget) budget.charge(EXTERNAL_FETCH_ALLOWANCE_PER_CASE, LANE_CASES);

      const raw = await agent.handleCase(c);
      const caseOutcome = extractOutcome(raw);
      stats.handled += 1;
      outcome.processed += 1;
      if (c.id) outcome.processedIds.add(c.id);
      if (c.difficulty === 'advanced') stats.advancedCases += 1;

      if (caseOutcome.escalation?.type === 'TRAINEE_PANIC') {
        await handleTraineePanic(env, caseOutcome.escalation);
        stats.escalations += 1;
      }
      // No charge here: every binding call this case made was metered as it
      // happened. Charging again would double-count.
    }

    // journal.md — one commit per agent per batch tick, covering every case
    // that agent just handled (see agent-base.js's _journalBuffer comment
    // for why this is batched here rather than committed per-case inside
    // askAssignedProject itself). Never allowed to affect case handling —
    // flushJournal() already swallows its own errors, this is belt-and-braces.
    try {
      await agent.flushJournal();
    } catch {
      // journal bookkeeping must never fail a case batch
    }

    // The one real state write for this agent this batch. Must run even when
    // the budget stopped us mid-batch, or the moods of the cases that DID run
    // are lost — which would make a cut-short batch corrupt as well as short.
    try {
      if (typeof agent.flushAgentState === 'function') await agent.flushAgentState();
    } catch {
      // state bookkeeping must never fail a case batch
    }
  }

  return outcome;
}

/**
 * Friday/full-day 'report' block: every agent who asked >=1 question today
 * files a casual AI-experience status report, and today's Hebrew
 * capability-gap findings (filed in real time throughout the day by
 * agent.flagCapabilityGap() — see agents/agent-base.js and
 * workers/gap-reports.js) get batched into per-project digest files.
 *
 * SUPERSEDED 2026-07-18 (Q&A-engine rebuild): this used to also select the
 * day's worst-quality interactions here and generate English "model
 * education case study" write-ups for a GitHub-Issue digest
 * (fileModelEducationDigest()). That whole batched-at-day-end mechanism is
 * gone — gap detection and Hebrew write-up now happen immediately per
 * interaction, not from a low-quality log accumulated across the day.
 */
async function runDailyAiExperienceReports(env, agentInstances, agentStats) {
  const statusReports = [];

  for (const [agentId, agent] of agentInstances) {
    // 2026-07-19 fix: gate on the day's accumulated per-agent stats (carried
    // across cron ticks in the SIM_KV cycle, same as the rest of the
    // scheduled path), NOT on in-memory agent.session — sessions never
    // survive from a case_batch tick's isolate to the 16:00 report tick's
    // fresh instances, so the old check made this section always empty in
    // scheduled mode.
    const handled = agentStats?.get(agentId)?.handled || 0;
    if (!handled) continue;
    let note;
    try {
      note = await agent.queryGroqRouted(
        "In 1-2 short, casual sentences (in character), describe today's experience asking Claude/Gemini your questions — what worked, what didn't."
      );
    } catch (err) {
      note = `(AI-experience report unavailable: ${err.message})`;
    }
    await agent.fileStatusReport(note);
    statusReports.push({ agentId, note });
  }

  const gapDigests = await fileGapDigests(env);

  return { statusReports, gapDigests };
}

/**
 * Spare-time block for one agent: 20% chance of a short logged coworker-chat
 * (1 Gemini call), 80% chance (always on force_idle days) of going idle with
 * ZERO Gemini/Claude calls — the primary token-discipline lever.
 */
async function runSpareTimeForAgent(env, agent, { forceIdle }) {
  const program = dailyScheduleConfig.spare_time_program;
  const doInteract = !forceIdle && Math.random() < program.coworker_interaction_chance;

  /*
   * ── OB-131, CLOSED 2026-08-17 ────────────────────────────────────────────
   *
   * This block reaches all thirteen agents and `logInteraction()` was
   * discarding the row for every agent with no session — which, in the
   * scheduled path, is ALL of them: `ensureAgentInstances()` builds fresh
   * instances per invocation and a session never survives from a case_batch
   * tick's isolate to this one. Measured against live D1 on 2026-08-17: the
   * last `idle` or `coworker_chat` row is dated 2026-08-10, and agents 5-13
   * have never had one.
   *
   * `openLoggingSession()` is the smallest thing that makes the row legal —
   * one `agent_sessions` INSERT, mode `spare_time`, no Durable Object write, no
   * pretence that standing in the corridor was case work. If it fails, the
   * refusal from `logInteraction()` is now LOUD rather than silent, and this
   * function reports `logged: false` to its caller either way.
   */
  await agent.openLoggingSession('spare_time');

  if (!doInteract) {
    const wrote = await agent.logInteraction({
      type: 'idle',
      query: '',
      response_summary: 'Spare time: agent went idle to preserve tokens (no API calls made).',
      mood_before: agent.mood,
      mood_after: agent.mood,
      irritation_change: 0,
      state_change: null,
    });
    return { agentId: agent.id, mode: 'idle', logged: wrote.logged, logReason: wrote.reason };
  }

  const others = agentsConfig.agents.filter((a) => a.id !== agent.id);
  const partner = others[Math.floor(Math.random() * others.length)];
  let text;
  try {
    text = await agent.queryGroqRouted(
      `Write one short, in-character line of casual chat you'd say to your coworker ${partner.name} during a quiet moment at the office. Keep it to 1-2 sentences.`
    );
  } catch (err) {
    text = `(coworker chat unavailable: ${err.message})`;
  }

  const wrote = await agent.logInteraction({
    type: 'coworker_chat',
    query: `chat with ${partner.name}`,
    response_summary: String(text).slice(0, 500),
    mood_before: agent.mood,
    mood_after: agent.mood,
    irritation_change: 0,
    state_change: null,
  });
  return { agentId: agent.id, mode: 'coworker_chat', partner: partner.id, text, logged: wrote.logged, logReason: wrote.reason };
}

/**
 * Per ai-tools.json's weekly_rotation, checks whether today's assigned
 * standing-project board item is queued and not yet filed, and if so opens its
 * asset-task GitHub Issue (human picks it up in the real tool — no programmatic
 * tool calls).
 *
 * ── NO LONGER SCHEDULED (OB-132, 2026-08-17) ─────────────────────────────
 *
 * This WAS the Sun-Thu 11:30 `tool_task_window` block. It is now reachable only
 * through `POST /api/agents/trigger {"type":"asset_task_window"}`.
 *
 * ── WHAT IT DOES WHEN EVERY ITEM IS INELIGIBLE, STATED HERE SO THE NEXT ──
 * ── READER DOES NOT HAVE TO DISCOVER IT ─────────────────────────────────
 *
 * It returns `{ opened: false, reason: 'not_eligible' }` and writes nothing.
 * That is a correct refusal, and between simulation day 6 and 2026-08-17 it was
 * the ONLY thing this function ever returned — because the refusal condition
 * below (`stage !== 'queued' || asset_task_issue_filed`) had become permanently
 * true for all four standing projects, each of which had had its Issue filed
 * once, on days 5 through 8. Only a human executing work in an external tool
 * can clear it, and none has.
 *
 * **A correct refusal on a schedule is still a dead path**, and while this ran
 * daily it was admitted into `block_admissions` as `decision: run` — so every
 * measurement the office takes of itself read it as working. That is why the
 * schedule entry was removed rather than the refusal made quieter: the refusal
 * was never the problem, the timer was.
 */
async function maybeOpenAssetTask(env, dayOfWeek, nextDay) {
  const rotation = aiToolsConfig.weekly_rotation[String(dayOfWeek)];
  if (!rotation) return { opened: false, reason: 'no_rotation_for_day' };

  const board = await fetchAssetBoard(env);
  const item = (board.items || []).find((i) => i.id === rotation.standing_project_ref);
  if (!item) return { opened: false, reason: 'board_item_not_found', ref: rotation.standing_project_ref };

  if (item.stage !== 'queued' || item.asset_task_issue_filed) {
    return { opened: false, reason: 'not_eligible', item: item.id, stage: item.stage, tool: rotation.tool };
  }

  const issue = await fileAssetTaskIssue(env, item, rotation.agents);
  let boardWrite = null;
  if (issue.created) {
    item.asset_task_issue_filed = true;
    item.history = [...(item.history || []), { day: nextDay, stage: item.stage, note: 'asset-task issue filed (auto, tool_task_window)' }];

    // Audit #9: the write carries the sha THIS FUNCTION READ, so a board that
    // moved underneath it is refused rather than overwritten. The Issue is
    // already filed at this point and is not rolled back — a filed Issue whose
    // board flag did not stick is recoverable (the next run sees the flag
    // unset and the `not_eligible` branch will not fire), whereas an erased
    // board is not. Reported in the return value either way.
    const gate = assetBoardWritable(board);
    boardWrite = gate.writable
      ? await commitFileToRepo(
        env, REPO_NAME, 'reports/asset-pipeline/board.json', JSON.stringify(board, null, 2) + '\n',
        `chore(agents): file asset-task issue for ${item.id} [skip ci]`,
        { expectedSha: board.sha }
      )
      : { committed: false, reason: gate.reason };
  }

  return { opened: issue.created, tool: rotation.tool, agents: rotation.agents, item: item.id, issue, boardWrite };
}

/**
 * Friday 'weekly_summary' block: generates the 10-section executive markdown
 * ("PDF" — print-ready, see CLAUDE.md PDF Export convention), a per-agent CSV
 * ("Excel"), and a short public excerpt, all under reports/weekly/.
 * Also runs the existing 'weekly' meeting type.
 */
async function generateWeeklySummary(env, yearState, weekNumber) {
  const board = await fetchAssetBoard(env);

  const agentRows = [];
  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();
    const weeklyCases = await getWeeklyCasesHandled(env, config.id);
    const cases7d = await getCasesHandledOverDays(env, config.id, 7);
    agentRows.push({ agentId: config.id, name: agent.name, weeklyCases, cases7d, mood: agent.mood, irritation: agent.irritation });
  }

  // OB-031. `weekly_cases` keeps its exact meaning — a 24-hour figure, as it
  // has always been — so no archived row changes and no false trend appears.
  // `cases_7d` is the number the header always implied. See
  // getWeeklyCasesHandled()'s comment for why the fix is a second column
  // rather than a widened window. An unreadable count is UNVERIFIED, not 0.
  const csv = ['agent_id,name,weekly_cases,cases_7d,mood,irritation']
    .concat(agentRows.map((r) => `${r.agentId},${r.name},${r.weeklyCases},${r.cases7d ?? 'UNVERIFIED'},${r.mood},${r.irritation}`))
    .join('\n') + '\n';

  const pipelineLines = (board.items || [])
    .map((i) => `- **${i.title}** (\`${i.id}\`): stage=${i.stage}${typeof i.version === 'number' ? `, v${i.version.toFixed(2)}` : ''}`)
    .join('\n') || '_No pipeline items._';

  // Site 4 of the 2026-08-07 context survey. FREE — this is a string
  // template, not a prompt. The weekly summary was the report the owner
  // called thin, and this is the half that was missing from it.
  //
  // `projects` ADDED 2026-08-08. It was passed by ONE of the five callers
  // (meeting-engine.js) and by none of the three report sites or the
  // per-agent site — so the office's own projects appeared in no report, the
  // exact state office-context.js was built to end. The irony is on the
  // record: that module exists because projects reached zero prompt-assembly
  // sites, and its first implementation reinstated the condition for four of
  // five callers. One line per site.
  const office = await getOfficeContext(env, { shape: 'report', allowFetch: true, projects: officeProjects.projects });

  const md = `# Weekly Executive Summary — Week ${weekNumber}

*Permission: private/special (AI staff + owner). See campus/shared/weekly/year-${yearState?.stats?.year_number || 1}-week-${pad(weekNumber, 2)}-public-summary.md (back-office) for the public excerpt.*

## Executive Summary

Week ${weekNumber} of the data-center office simulation, ${agentRows.length} agents on roster.

## Case Volume & Categories

${agentRows.map((r) => `- Agent ${r.agentId} (${r.name}): ${r.cases7d ?? 'UNVERIFIED'} cases over the last 7 days (24h figure: ${r.weeklyCases})`).join('\n')}

> **Two case columns, and why (OB-031, from week ${weekNumber}).** The
> \`weekly_cases\` column in this week's CSV holds a **24-hour** figure and always
> has — the function behind it looks back one day despite its name, so every
> archived week under that header is a one-day number. It is left exactly as it
> is: widening it in place would change what the column means without changing
> its name, and week ${weekNumber} would show a jump against week ${weekNumber - 1} that never
> happened. \`cases_7d\` is the real seven-day figure and starts here. Earlier
> weeks have no \`cases_7d\` value because it was not measured, which is a
> different thing from it being zero.

## Agent Performance & Mood

${agentRows.map((r) => `- Agent ${r.agentId} (${r.name}): mood ${r.mood}, irritation ${r.irritation}/5`).join('\n')}

## Model (Claude) Performance & Education Findings

See \`reports\` rows of type \`model_education\` filed this week (and any resulting \`claude-action\`/\`model-education\` GitHub Issues).

## Incidents & Escalations

See \`reports\` rows of type \`incident\` filed this week.

## Side Plots & Narrative Highlights

See \`side_plots\` rows active or resolved during week ${weekNumber}.

## Asset Pipeline Status

${pipelineLines}

## Suggestions Queue (by permission tier)

See \`suggestions\` rows, grouped by \`permission_level\`.

## Cost & Token Usage Estimate

See \`config/token-economy.json\` for the live per-provider caps and the
Anthropic budget's \`claude_budget_usage\` D1 counter for actual spend.
*(2026-08-07: the previous paragraph here named gemini-2.5-flash and
claude-sonnet-4-6 and quoted a "$2-3/quarter" target. All three were stale —
the model IDs are retired and the budget is the $4.50 soft-stop / $5 ceiling
in CLAUDE.md. Replaced with a pointer rather than a fresh set of numbers to
go stale: this template is committed weekly and nothing was re-checking it.)*
${renderOfficeSection(office)}
## Action Items for Next Week

- [ ] Review this week's model-education case studies.
- [ ] Advance any 'returned' asset-pipeline items toward 'tested'/'optimized'/'implemented'.
- [ ] Re-check any agent at irritation >= 4/5 or mood <= 20.
`;

  const publicMd = `# Weekly Summary — Week ${weekNumber} (Public)

This week, the simulated IT support office continued operating across
${agentRows.length} staff roles, handling support cases with AI-assisted
diagnostics. No customer-facing issues to report.
`;

  // Moved to back-office 2026-08-11 (plan 0.4, stage 3 of 5): this is the RAW
  // weekly trio — string-template output, no review — per
  // docs/handoffs/0.4-STAGED-PLAN.md's table. It is NOT the reviewed
  // `week-NN-report.md` from runReportPipeline(), which stays public. Even
  // `-public-summary.md` moves: DOC-POLICY.md's stance is that only REVIEWED
  // content publishes until the gate (OB-014) exists, and this file is
  // unreviewed regardless of its name. Same guarded path stages 1-2 use.
  const base = 'campus/shared/weekly';
  // OB-086 / KFM-17: `current_week` resets to 0 at year end, so all three of
  // these were on a one-year overwrite clock. `stem` carries the simulation
  // year; files written before 2026-08-16 keep their yearless names (A15).
  const stem = `year-${yearState?.stats?.year_number || 1}-week-${pad(weekNumber, 2)}`;
  const files = {
    summary: await commitFileToRepo(env, BACKOFFICE_REPO_NAME, `${base}/${stem}-summary.md`, md, `chore(office): week ${weekNumber} executive summary [skip ci]`),
    csv: await commitFileToRepo(env, BACKOFFICE_REPO_NAME, `${base}/${stem}-data.csv`, csv, `chore(office): week ${weekNumber} data export [skip ci]`),
    public: await commitFileToRepo(env, BACKOFFICE_REPO_NAME, `${base}/${stem}-public-summary.md`, publicMd, `chore(office): week ${weekNumber} public summary [skip ci]`),
  };

  let weeklyMeeting = null;
  try {
    weeklyMeeting = await runMeeting('weekly', env);
  } catch (err) {
    weeklyMeeting = { error: err.message };
  }

  // ── The written report (2026-08-08, behind report_pipeline_enabled) ────
  //
  // ADDITIVE, deliberately. The three template files above are committed
  // exactly as before and are byte-unchanged whether the pipeline runs or
  // not; the written report is a FOURTH file at a new path. Two reasons:
  //
  //   1. It makes the switch honest. "Off" has to mean the current output,
  //      unchanged — not "the current output, mostly".
  //   2. It is the shape plan item 0.4 needs. The template output IS the raw
  //      agent output the publishing split moves to back-office; the reviewed
  //      report is what keeps publishing here. Phase 3 changes a destination,
  //      not a pipeline.
  //
  // Never throws: a report that cannot be produced is a logged skip. The
  // weekly summary block must not fail because a provider was slow.
  let writtenReport = { ran: false, reason: 'not_attempted' };
  try {
    const weeklyYear = yearState?.stats?.year_number || 1;
    writtenReport = await runReportPipeline(env, {
      reportType: 'weekly',
      periodLabel: periodLabelFor('weekly', weekNumber, weeklyYear),
      // OB-086: year 1 also published under the yearless `week-NN`.
      legacyLabels: periodLabelCandidates('weekly', weekNumber, weeklyYear).slice(1),
      dateStr: todayDateStr(),
      agentRows,
      pipelineSummary: pipelineLines,
      sinceIso: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.warn(`[report-pipeline] weekly report failed: ${err.message}`);
    writtenReport = { ran: false, reason: `error: ${err.message}` };
  }

  return { weekNumber, files, agentRows, weeklyMeeting, writtenReport };
}

/**
 * The monthly written report. There has never been a monthly REPORT — only a
 * monthly MEETING (MILESTONE_MEETINGS day_30), whose minutes were the closest
 * thing to one. This is the report, and it runs on the same milestone, after
 * the meeting, so the meeting's decisions are already filed and reach the
 * fact pack.
 *
 * Same switch, same rules, same never-throws posture as the weekly.
 */
async function generateMonthlyReport(env, monthNumber, yearNumber = 1) {
  const agentRows = [];
  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();
    agentRows.push({
      agentId: config.id, name: agent.name,
      weeklyCases: await getWeeklyCasesHandled(env, config.id),
      mood: agent.mood, irritation: agent.irritation,
    });
  }

  try {
    return await runReportPipeline(env, {
      reportType: 'monthly',
      periodLabel: periodLabelFor('monthly', monthNumber, yearNumber),
      legacyLabels: periodLabelCandidates('monthly', monthNumber, yearNumber).slice(1),
      dateStr: todayDateStr(),
      agentRows,
      pipelineSummary: null,
      sinceIso: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.warn(`[report-pipeline] monthly report failed: ${err.message}`);
    return { ran: false, reason: `error: ${err.message}` };
  }
}

/**
 * On the weekly_summary block, bumps +0.01 the version of any asset-pipeline
 * board item that reached 'implemented' THIS day (per product_versioning in
 * daily-schedule.json), recording the new version in both board.json and
 * year_stats.stats.product_versions.
 */
async function checkProductVersionBumps(env, yearState, nextDay) {
  const versioning = dailyScheduleConfig.product_versioning;
  const board = await fetchAssetBoard(env);
  const bumps = [];

  for (const item of board.items || []) {
    if (item.stage !== 'implemented') continue;
    const last = item.history?.[item.history.length - 1];
    if (last?.day !== nextDay || last?.stage !== 'implemented' || last?.version_bumped) continue;

    const current = yearState.stats.product_versions?.[item.id] ?? (versioning.starting_version - versioning.increment);
    const next = Math.round((current + versioning.increment) * 100) / 100;

    yearState.stats.product_versions = { ...(yearState.stats.product_versions || {}), [item.id]: next };
    item.version = next;
    last.version_bumped = true;
    bumps.push({ id: item.id, version: next });
  }

  if (bumps.length) {
    // Audit #9. This is the SECOND writer of this file, and in
    // runWorkDayCycle() it runs after maybeOpenAssetTask() has already written
    // it — the pair that could silently erase one another. `expectedSha` makes
    // that collision a refused write with a conflict status instead of a lost
    // one. If it is refused, the version bumps recorded in `yearState` still
    // stand; the board's copy of them is what did not land, and it is named.
    const gate = assetBoardWritable(board);
    const write = gate.writable
      ? await commitFileToRepo(
        env, REPO_NAME, 'reports/asset-pipeline/board.json', JSON.stringify(board, null, 2) + '\n',
        `chore(agents): version bump for ${bumps.map((b) => b.id).join(', ')} [skip ci]`,
        { expectedSha: board.sha }
      )
      : { committed: false, reason: gate.reason };
    if (!write.committed) {
      console.warn(`[asset-board] version bumps NOT written to board.json: ${write.reason || `status ${write.status}`}`);
      return bumps.map((b) => ({ ...b, boardWriteFailed: true, reason: write.reason || `status_${write.status}` }));
    }
  }

  return bumps;
}

/**
 * Computes how many questions to generate for the WHOLE day (2026-07-18
 * Q&A-engine rebuild — see config/daily-schedule.json's case_volume_design_note
 * and config/token-economy.json's shared_claude_budget). Deliberately NOT a
 * precise "remaining budget / cost-per-call" calculation — that would be
 * false precision, since the real spend cap is enforced per-call at ask
 * time (agents/agent-base.js _askDataCenter()'s getClaudeBudgetStatus()
 * check), regardless of how many questions got generated here. This only
 * decides whether it's worth generating a NORMAL day's volume, a reduced
 * one, or none — the runtime check is always the actual backstop.
 *
 * Once computed, this total is spread across the day exactly as before, via
 * the existing case_share-based partitionCasesByShare() — the per-call
 * Gemini pacing check (workers/gemini-pacer.js) is what actually prevents
 * Notebook-X bursts, not this number.
 */
async function computeDailyQuestionVolume(env, sim) {
  // `|| 200` until 2026-08-23, which made an explicitly-configured 0 mean 200 —
  // a config value that failed in the dangerous direction, silently, at exactly
  // the place someone reaching for a volume control would reach. `??` leaves an
  // absent key meaning 200 (unchanged) and lets a configured 0 mean zero.
  const BASE_DAILY_QUESTIONS = simulationConfig.cases_per_day_total ?? 200;
  const multiplier = sim.inspection_mode ? (simulationConfig.WORK_DAY?.inspection_mode_multiplier || 1) : 1;

  const budget = await getClaudeBudgetStatus(env);
  if (budget.overBudget) {
    // Shared Claude budget exhausted this month: still generate a reduced
    // volume rather than zero — notebook-x-targeted questions (paced
    // separately, near-zero marginal $ cost) still return real signal, and
    // even data-center-targeted questions generated now will simply be
    // skipped at ask time (logged, not silently dropped) rather than
    // wasting the whole day's Notebook-X coverage too.
    return applyGraduatedRolloutCap(Math.round(BASE_DAILY_QUESTIONS * 0.3 * multiplier));
  }
  return applyGraduatedRolloutCap(Math.round(BASE_DAILY_QUESTIONS * multiplier));
}

/**
 * TEMPORARY graduated-rollout throttle for the first live activation of the
 * Q&A engine (config/token-economy.json `graduated_rollout_throttle`) — NOT
 * a permanent volume limit. For the first few calendar days after
 * `activation_date_israel` (Israel time, day 0 = the activation date), the
 * day's total is capped at `ramp_daily_caps[daysSinceActivation]`; once the
 * ramp array is exhausted this returns `volume` untouched, i.e. the step-up
 * back to normal budget-driven volume is automatic, no manual change needed.
 * Delete the config block (and, optionally, this function) once the ramp
 * window has passed — a missing/malformed config block means no throttle.
 */
function applyGraduatedRolloutCap(volume, now = new Date()) {
  const rollout = tokenEconomy.graduated_rollout_throttle;
  if (!rollout?.activation_date_israel || !Array.isArray(rollout.ramp_daily_caps) || !rollout.ramp_daily_caps.length) {
    return volume;
  }
  const israelToday = new Date(now.getTime() + ISRAEL_UTC_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
  const daysSince = Math.floor((Date.parse(israelToday) - Date.parse(rollout.activation_date_israel)) / 86_400_000);
  if (daysSince >= rollout.ramp_daily_caps.length) return volume; // ramp complete — throttle inert
  // A tick somehow firing BEFORE the activation date (daysSince < 0) gets the
  // most conservative cap rather than an uncapped day.
  const cap = rollout.ramp_daily_caps[Math.max(0, daysSince)];
  return Math.min(volume, cap);
}

/**
 * One simulated work day:
 *  1. Q&A question generation + assignment + persistence (qa-engine.js)
 *  2. per-agent ask-and-evaluate loop — mood/escalation handling
 *  3. daily standup (meeting-engine.js)
 *  4. side plot lifecycle — start new / advance / resolve
 *  5. year-tracker update + milestone-triggered meeting (+ promotion
 *     results report on day 365)
 *  6. GitHub-committed daily summary
 *
 * As of the Phase-2 daily-automation build, steps 1-2 are driven by
 * config/daily-schedule.json (question batches spread across the day,
 * Sun-Thu/Fri/Sat day types), and the schedule's tool_task_window, report,
 * spare_time, and weekly_summary blocks are processed alongside it (see
 * config/ai-tools.json for the tool-access matrix). No cron is wired
 * to per-block times yet — see daily-schedule.json _meta.cron_status.
 */
export async function runWorkDayCycle(env) {
  const sim = await getSimulationState(env);
  if (sim.paused) return { skipped: true, reason: 'paused' };

  const yearState = await getYearState(env);
  const nextDay = (yearState.current_day || 0) + 1;
  const dayOfWeek = ((nextDay - 1) % 7) + 1;
  const schedule = getDaySchedule(dayOfWeek);
  const isOffDay = schedule === dailyScheduleConfig.saturday_schedule;

  // R-001 (2026-08-23): cases retired. Same gate as runScheduledBlockInner()'s;
  // this path must never disagree with the live one about whether cases run.
  const maxTotalQuestions = (isOffDay || !(await casesEnabled(env)))
    ? 0
    : await computeDailyQuestionVolume(env, sim);

  const cases = isOffDay
    ? []
    : generateAssignedDailyBatch(dayOfWeek, { maxTotalQuestions, weekNumber: yearState.current_week || 1 });
  if (cases.length) await persistQuestions(env, cases);

  // ── Question batches, spread across the day per daily-schedule.json ──
  const batches = partitionCasesByShare(cases, schedule.blocks);
  const agentInstances = new Map();
  const agentStats = new Map();

  for (const batch of batches) {
    await processCaseBatch(env, batch.cases, agentInstances, agentStats);
  }

  const summary = { day: nextDay, dayOfWeek, inspection: sim.inspection_mode, agents: [] };

  for (const [agentId, agent] of agentInstances) {
    const stats = agentStats.get(agentId) || { agentId, caseCount: 0, handled: 0, escalations: 0, advancedCases: 0 };

    // NOTE: the old rolling model_usage_rate adjustment (driven by
    // getModelUsageAdjustment()'s "compare alternatives" win-rate, from the
    // retired crm-engine.js) is removed along with that mechanic — every
    // agent now always asks its assigned question (Step 3, 2026-07-18
    // Q&A-engine rebuild), so there's no usage-rate signal left to adjust.

    summary.agents.push({
      agentId,
      caseCount: stats.caseCount,
      handled: stats.handled,
      escalations: stats.escalations,
      advancedCases: stats.advancedCases,
      mood: agent.mood,
      irritation: agent.irritation,
      isHappy: agent.isHappy,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
    });
  }

  // ── Remaining tactical blocks: tool-task window, AI-experience reports,
  // spare time, and (Friday) the weekly summary ──
  let toolTask = null;
  let aiExperience = null;
  const spareTime = [];
  let weeklySummary = null;
  let versionBumps = [];

  for (const block of schedule.blocks) {
    if (block.type === 'tool_task_window') {
      toolTask = await maybeOpenAssetTask(env, dayOfWeek, nextDay);
    } else if (block.type === 'report') {
      aiExperience = await runDailyAiExperienceReports(env, agentInstances, agentStats);
    } else if (block.type === 'spare_time') {
      for (const [, agent] of agentInstances) {
        spareTime.push(await runSpareTimeForAgent(env, agent, { forceIdle: !!block.force_idle }));
      }
    } else if (block.type === 'weekly_summary') {
      weeklySummary = await generateWeeklySummary(env, yearState, yearState.current_week || 1);
      versionBumps = await checkProductVersionBumps(env, yearState, nextDay);
    }
  }

  // Daily standup only runs on days the schedule defines it (not the Saturday off day).
  let standup = null;
  if (schedule.blocks.some((b) => b.type === 'meeting' && b.meeting_type === 'daily_standup')) {
    try {
      standup = await runMeeting('daily_standup', env);
    } catch (err) {
      standup = { error: err.message };
    }
  }

  // Closing QA review — same schedule-presence guard as the standup above.
  // This whole function is the NON-FUNCTIONAL full-day path (see CLAUDE.md
  // "How to run a simulation day manually" — production runs the per-block
  // runScheduledBlock() path, which carries the real 2026-08-11 wiring).
  // Mirrored here anyway so the two paths do not silently diverge on which
  // meeting types a "day" actually runs.
  let closingQaReview = null;
  if (schedule.blocks.some((b) => b.type === 'meeting' && b.meeting_type === 'closing_qa_review')) {
    try {
      closingQaReview = await runMeeting('closing_qa_review', env);
    } catch (err) {
      closingQaReview = { error: err.message };
    }
  }

  const sidePlotStarted = await maybeStartSidePlots(env, { day: nextDay, summary, cases, standup });
  const sidePlotUpdates = await advanceSidePlots(env, nextDay);

  const milestoneKey = `day_${nextDay}`;
  const milestone = yearTrackerSeed.milestones[milestoneKey] || null;
  let milestoneMeeting = null;
  let monthlyReport = null;
  if (milestone && MILESTONE_MEETINGS[milestoneKey] && !isOffDay) {
    try {
      milestoneMeeting = await runMeeting(MILESTONE_MEETINGS[milestoneKey], env);
    } catch (err) {
      milestoneMeeting = { error: err.message };
    }
    // The monthly WRITTEN report (2026-08-08, behind report_pipeline_enabled).
    // AFTER the meeting, deliberately: the meeting's decisions are filed as
    // `reports` rows and the fact pack reads them, so a report generated
    // first would be a report of the month that omits the month's meeting.
    if (MILESTONE_MEETINGS[milestoneKey] === 'monthly') {
      monthlyReport = await generateMonthlyReport(env, Math.ceil(nextDay / 30), yearState.stats?.year_number || 1);
    }
  }

  const newStats = updateYearStats(yearState.stats, { summary, standup, sidePlotStarted, sidePlotUpdates });
  const isYearEnd = nextDay >= yearTrackerSeed.total_days;

  const newState = {
    simulation_start: yearState.simulation_start || new Date().toISOString(),
    current_day: isYearEnd ? 0 : nextDay,
    current_week: isYearEnd ? 0 : Math.ceil(nextDay / 7),
    current_month: isYearEnd ? 0 : Math.ceil(nextDay / 30),
    current_quarter: isYearEnd ? 0 : Math.ceil(nextDay / 91),
    stats: isYearEnd ? { ...newStats, year_number: (newStats.year_number || 1) + 1 } : newStats,
  };
  await persistYearState(env, newState);

  if (milestoneKey === 'day_365' && milestoneMeeting && !milestoneMeeting.error) {
    const yearNumber = newStats.year_number || 1;
    const promoMarkdown = renderPromotionResults(yearNumber, milestoneMeeting);
    // Moved to back-office 2026-08-11 (plan 0.4, stage 5 of 5).
    await commitFileToRepo(
      env, BACKOFFICE_REPO_NAME, `campus/shared/promotions/promotion-results-year-${yearNumber}.md`, promoMarkdown,
      `chore(office): year ${yearNumber} promotion results [skip ci]`
    );
  }

  const displayYearState = {
    ...yearState,
    current_day: nextDay,
    current_week: Math.ceil(nextDay / 7),
    current_month: Math.ceil(nextDay / 30),
    current_quarter: Math.ceil(nextDay / 91),
    stats: newStats,
  };
  const scheduleInfo = { schedule, dayOfWeek, batches, toolTask, aiExperience, spareTime, weeklySummary, versionBumps };
  // A13 rest-day guard — see the fuller comment on the same guard in
  // finalizeScheduledDay(). Applied HERE TOO even though this whole function is
  // the documented-non-functional {"type":"day"} path: a rule enforced on one of
  // two code paths is a rule that comes back the day someone repairs the other.
  // allowFetch: true — the daily summary runs once per cycle, so it is one
  // of the callers permitted to refresh the office-context cache.
  // `projects` added 2026-08-08 — see generateWeeklySummary() for why.
  const office = await getOfficeContext(env, { shape: 'report', allowFetch: true, projects: officeProjects.projects });
  // A7's visibility half (2026-08-10). Runs once per day cycle, never on a
  // model-call path. `.catch()` and not a bare await: a monitoring feature that
  // can take down the report it monitors is worse than the gap it closes.
  const branches = await fetchOpenBranches(env).catch((err) => {
    console.warn(`[branch-watch] could not list branches, continuing: ${err?.message || err}`);
    return null;
  });
  const markdown = renderDailySummary(displayYearState, summary, standup, sidePlotStarted, sidePlotUpdates, milestone, scheduleInfo, office, branches);
  // OFFICE-POLICY A9 (2026-08-11) — see composeDailyHeadline()'s comment for
  // why this runs AFTER the free render and is guarded on isOffDay: no model
  // call whose result would be thrown away on a rest day.
  const markdownWithHeadline = await composeDailyHeadline(env, markdown, isOffDay);
  // Moved to back-office 2026-08-11 (plan 0.4, stage 2 of 5): the daily
  // summary publishes the internal delegation board and the office's open
  // owner-questions WITH their full escalation reasoning — operational
  // material per DOC-POLICY.md's private list, not visitor content. Same
  // guarded path meeting reports use (stage 1), same campus/shared/ layout.
  const report = isOffDay
    ? { committed: false, skipped: true, reason: 'rest_day_zero_write', policy: 'OFFICE-POLICY.md A13' }
    : await commitFileToRepo(
      // OB-086 / KFM-17: `nextDay` resets to 0 at year end, so a yearless
      // `day-001-summary.md` would overwrite year 1's. The year comes from
      // `newStats`, NOT `newState.stats` -- the latter is already incremented
      // when this is the rollover day, and this file summarises the day that
      // just ENDED. Files written before 2026-08-16 keep their yearless names
      // and are not renamed (A15).
      env, BACKOFFICE_REPO_NAME, `campus/shared/daily/year-${newStats.year_number || 1}-day-${pad(nextDay, 3)}-summary.md`, markdownWithHeadline,
      `chore(office): year ${newStats.year_number || 1} day ${nextDay} summary [skip ci]`
    );

  return {
    ...summary, year: newState, standup, sidePlotsStarted: sidePlotStarted, sidePlotUpdates, milestone, milestoneMeeting, monthlyReport, report,
    schedule: { dayOfWeek, toolTask, aiExperience, spareTime, weeklySummary, versionBumps },
  };
}

/* ───────────────────── Per-block scheduled dispatcher ───────────────────── */

// Cloudflare Cron Triggers fire in UTC; daily-schedule.json's block times are
// Israel local time. IDT (UTC+3) applies roughly Mar-Oct, IST (UTC+2) the
// rest of the year. Update this constant (and wrangler.toml's cron window)
// when Israel's clocks change — see CLAUDE.md "Daily Automation" DST note.
const ISRAEL_UTC_OFFSET_HOURS = 3;

/** Converts a UTC Date to { time: "HH:MM", dayOfWeek } in Israel local time. dayOfWeek matches daily-schedule.json's week_mapping (1=Sun..7=Sat). */
function israelTimeParts(date) {
  const israel = new Date(date.getTime() + ISRAEL_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const hh = String(israel.getUTCHours()).padStart(2, '0');
  const mm = String(israel.getUTCMinutes()).padStart(2, '0');
  return { time: `${hh}:${mm}`, dayOfWeek: israel.getUTCDay() + 1 };
}

const CYCLE_STATE_KEY = 'daily-cycle-state';

async function getCycleState(env) {
  if (!env.SIM_KV) return null;
  return env.SIM_KV.get(CYCLE_STATE_KEY, 'json');
}

async function setCycleState(env, state) {
  if (!env.SIM_KV) return;
  await env.SIM_KV.put(CYCLE_STATE_KEY, JSON.stringify(state));
}

async function clearCycleState(env) {
  if (!env.SIM_KV) return;
  await env.SIM_KV.delete(CYCLE_STATE_KEY);
}

/**
 * Logs a scheduled-block failure (e.g. a Gemini 429) as a `reports` row
 * without throwing, so one bad tick can't cascade or trigger Cloudflare cron
 * retries. Filed under agent 10 (The Architect) as the simulation's
 * system/ops agent — `reports.agent_id` is NOT NULL with a FK to `agents`.
 */
async function logScheduledError(env, { israelTime, dayOfWeek, blockType, error }) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO reports (id, agent_id, type, title, content, severity) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      10,
      'incident',
      `Scheduled block error — ${blockType} @ ${israelTime} (day-of-week ${dayOfWeek})`,
      String(error?.message || error),
      'warning'
    ).run();
  } catch {
    // best-effort only — never let logging itself break the cron tick
  }
}

/**
 * One `case_batch` block, under the invocation budget (OB-074, 2026-08-16).
 *
 * ── DEFERRED IS DRAINED BEFORE NEW WORK ──────────────────────────────────
 *
 * The queue is the cycle. `daily-cycle-state` in SIM_KV already holds every
 * batch, its cases and its cursor; it is already persisted between ticks and
 * already cleared at day end. A second store beside it would give the office
 * two answers to "what is still owed", so this reuses it — no new queue, as
 * instructed.
 *
 * Carry-over runs FIRST, oldest batch first, and only then this block's own
 * cases. Without that ordering the day's tail starves behind heads that keep
 * being refilled — which is exactly what production was doing before this
 * change, re-asking the same first cases at every tick while the tail of the
 * 200-case day was never reached.
 *
 * ── WHY IT DOES NOT SET done ON A SHORT RUN ──────────────────────────────
 *
 * `done` moves only when the cursor reaches the end. The old code set
 * `batch.done = true` on the line after `processCaseBatch()` returned,
 * unconditionally — so a batch that threw at case 2 of 30 was recorded
 * identically to one that finished all 30. That single assignment is what
 * made deferred work indistinguishable from completed work.
 */
async function runCaseBatchBlock(env, cycle, block, agentInstances, agentStats, budget, sim = null) {
  // Everything this function spends is case work and is charged to the case
  // lane, so the floor is measured against real spend. Restored to 'other'
  // before returning — see the finally.
  budget.setLane(LANE_CASES);
  try {
    return await runCaseBatchBlockInner(env, cycle, block, agentInstances, agentStats, budget, sim);
  } finally {
    budget.setLane('other');
  }
}

/**
 * OB-074 Phase 3 — SHIPPED OFF, and this is the only gate.
 *
 * When `case_do_enabled` is absent (the shipped default) this returns null and
 * the caller runs the batch exactly as it did before: no Durable Object is
 * contacted, no payload is serialized, the branch is not entered. When it is
 * true, the same cases go to the Durable Object instead, which has a measured
 * outbound ceiling well above the Worker's 50.
 *
 * The cursor is NOT moved here. It is moved by the caller from `processedIds`,
 * whichever path produced them, so "deferred is not done" has one
 * implementation rather than two that can drift.
 */
async function maybeRunCasesInDO(env, cases, sim) {
  if (!caseDoEnabled(sim)) return null;
  if (!env.AGENT_STATE || !cases.length) return null;
  const stub = env.AGENT_STATE.get(env.AGENT_STATE.idFromName(CASE_DO_INSTANCE));
  const res = await stub.fetch(`https://agent-state${CASE_DO_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cases }),
  });
  const out = await res.json();
  return { ...out, processedIds: new Set(out.processedIds || []) };
}

async function runCaseBatchBlockInner(env, cycle, block, agentInstances, agentStats, budget, sim) {
  const own = cycle.batches.find((b) => isSameBlock(b.block, block));
  const carry = collectOutstanding(cycle, block);

  const planned = budget.caseSlots(CASE_LOOKAHEAD);
  const record = {
    block: block.label || block.time,
    // OB-074 Phase 3 read-back: which path actually served this batch, and
    // whether the Durable Object switch is on. A claim that the new path is
    // inert is worth nothing; this is the tick saying so itself.
    path: caseDoEnabled(sim) ? 'durable_object' : 'worker',
    caseDoEnabled: caseDoEnabled(sim),
    plannedSlots: planned,
    carriedOver: carry.length,
    ownCases: own ? (own.cases?.length || 0) - (own.cursor || 0) : 0,
    processed: 0,
    deferred: 0,
    stoppedForBudget: false,
  };

  // 1) Drain carry-over, oldest first. Each item knows which batch it came
  //    from, so a partial drain advances that batch's cursor and no other.
  for (const item of carry) {
    if (!budget.canAfford(CASE_LOOKAHEAD, LANE_CASES)) {
      record.stoppedForBudget = true;
      break;
    }
    const res = (await maybeRunCasesInDO(env, [item.case], sim))
      || await processCaseBatch(env, [item.case], agentInstances, agentStats, budget);
    record.processed += res.processed;
    if (res.processed > 0) {
      // The cursor is advanced by what was PROCESSED, never by what was
      // handed in. Carry-over is drained in order, so cursor = index + 1.
      item.batch.cursor = Math.max(num0(item.batch.cursor), item.index + 1);
      if (item.batch.cursor >= (item.batch.cases?.length || 0)) item.batch.done = true;
    }
    if (res.stoppedForBudget) { record.stoppedForBudget = true; break; }
  }

  // 2) This block's own cases, from wherever it left off.
  if (own && !own.done && !record.stoppedForBudget) {
    const start = clamp0(num0(own.cursor), own.cases?.length || 0);
    const pending = (own.cases || []).slice(start);
    if (pending.length) {
      const res = (await maybeRunCasesInDO(env, pending, sim))
        || await processCaseBatch(env, pending, agentInstances, agentStats, budget);
      record.processed += res.processed;
      own.cursor = start + res.processed;
      if (own.cursor >= own.cases.length) own.done = true;
      else own.deferrals = num0(own.deferrals) + 1;
      if (res.stoppedForBudget) record.stoppedForBudget = true;
    } else if ((own.cases?.length || 0) === 0) {
      own.done = true;   // an empty share is genuinely complete
    }
  }

  // What is still owed across the whole day, after this tick.
  const day = summarizeDayDeferrals(cycle);
  record.deferred = day.deferred;
  record.budget = budget.snapshot();
  return record;
}

function num0(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function clamp0(v, hi) { return Math.min(hi, Math.max(0, v)); }

/**
 * Cron entry point for one Israel-time tick (called from `scheduled()` with
 * the tick's { time, dayOfWeek }). Looks up which daily-schedule.json
 * block(s), if any, are due right now; on the day's first due block it
 * starts a fresh day-in-progress "cycle" (generates + persists the day's
 * CRM cases and partitions them per daily-schedule.json), processes the due
 * block(s) with per-block error containment (`logScheduledError`, never
 * throws), persists the cycle to SIM_KV between ticks, and on the day's
 * last due block finalizes the day (`finalizeScheduledDay`) and clears the
 * cycle. Ticks with no due block (most of them, given the 30-minute cron)
 * are a cheap no-op.
 */
export async function runScheduledBlock(env, israelTime, dayOfWeek) {
  const schedule = getDaySchedule(dayOfWeek);
  const dueBlocks = schedule.blocks.filter((b) => b.time === israelTime);
  if (!dueBlocks.length) return { skipped: true, reason: 'no_block_at_time', israelTime, dayOfWeek };

  // ── OB-074: the invocation budget ────────────────────────────────────────
  // A floor for cases, not a priority. `casesDue` decides whether the floor
  // exists at all: on the 15 of 21 daily ticks that carry no case_batch,
  // reserving 60% of the budget for cases would throttle the meeting, report
  // and guide blocks to protect a floor nobody is going to use.
  const casesDue = dueBlocks.some((b) => b.type === 'case_batch');
  // The day's last tick also runs finalizeScheduledDay() after the block
  // loop, and that is the tick's most important output — the daily summary.
  // Reserve for it explicitly; see FINALIZE_RESERVE.
  const lastTick = israelTime === schedule.blocks[schedule.blocks.length - 1].time;
  const budget = createTickBudget({
    casesDue,
    tailReserve: (casesDue ? TICK_TAIL_RESERVE : TICK_TAIL_RESERVE_NO_CASES)
      + (lastTick ? FINALIZE_RESERVE : 0),
  });

  // ── OB-074: everything below runs on the per-tick env ────────────────────
  //
  // ORDER MATTERS AND IS NOT INTERCHANGEABLE. `meterEnv()` goes on FIRST so it
  // wraps the real bindings; `tickEnv()`'s `simulation-state` memo goes on TOP
  // of it, so a memo hit never reaches the metered `get` and is never charged.
  // Wrapped the other way round the memo would save the KV round trip and
  // still bill for it, and the ledger would report ~63 switch reads that did
  // not happen.
  //
  // Both wrappers live and die with this function call, so neither can leak
  // into the next tick through a reused isolate — which is the whole reason
  // the cache is not a module-level Map.
  env = tickEnv(meterEnv(env, (n) => budget.spendMetered(n)));

  // External fetch() is the operation the 50-cap actually counts, and it is
  // not a binding — the provider clients, notebookx-client and every GitHub
  // commit call the global directly. Swapped for the tick and restored in the
  // finally at the very bottom of this function. See meterGlobalFetch().
  const restoreFetch = meterGlobalFetch((n) => budget.spendMetered(n));
  try {
    return await runScheduledBlockInner(env, israelTime, dayOfWeek, {
      schedule, dueBlocks, casesDue, budget,
    });
  } finally {
    restoreFetch();
  }
}

async function runScheduledBlockInner(env, israelTime, dayOfWeek, ctx) {
  const { schedule, dueBlocks, casesDue, budget } = ctx;

  const sim = await getSimulationState(env);
  if (sim.paused) return { skipped: true, reason: 'paused' };

  const isOffDay = schedule === dailyScheduleConfig.saturday_schedule;
  const isFirstBlock = israelTime === schedule.blocks[0].time;
  const isLastBlock = israelTime === schedule.blocks[schedule.blocks.length - 1].time;

  let cycle = await getCycleState(env);
  if (isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek) {
    const yearState = await getYearState(env);
    const nextDay = (yearState.current_day || 0) + 1;

    // R-001 (2026-08-23): cases retired. Zero here is the whole gate —
    // generateAssignedDailyBatch() returns [] on a zero total (qa-engine.js
    // :171, verified by reading), so no downstream consumer needs a second.
    const maxTotalQuestions = (isOffDay || !(await casesEnabled(env)))
      ? 0
      : await computeDailyQuestionVolume(env, sim);

    // Keep the D1 agents identity rows in lockstep with agents-config.json
    // (one 11-row batch per day — see syncAgentsTable()).
    await syncAgentsTable(env);

    const cases = isOffDay
      ? []
      : generateAssignedDailyBatch(dayOfWeek, { maxTotalQuestions, weekNumber: yearState.current_week || 1 });
    if (cases.length) await persistQuestions(env, cases);

    cycle = {
      day: nextDay,
      dayOfWeek,
      inspection: sim.inspection_mode,
      cases,
      // `cursor` (OB-074) is how many of this batch's cases have actually been
      // processed. `done` is set ONLY when cursor reaches cases.length, so a
      // batch that was cut short by the budget is distinguishable from one
      // that finished — see subrequest-budget.js summarizeBatchState().
      batches: partitionCasesByShare(cases, schedule.blocks).map((b) => ({ ...b, done: false, cursor: 0, deferrals: 0 })),
      agentStats: {},
      results: {
        toolTask: null, aiExperience: null, standup: null, spareTime: [], weeklySummary: null, versionBumps: [], choreRotation: null,
        guideDraft: null, guideReview: null, guideVerify: null, architectLiaison: null,
        ownerChannel: null, qaInstruments: null, adminDesk: null,
      },
    };
  }

  const agentStats = new Map(Object.entries(cycle.agentStats).map(([k, v]) => [Number(k), v]));
  const agentInstances = new Map();

  // Pass includeAll=true for report/spare-time blocks so admin agents
  // (6-9) that handled zero cases still participate in daily standup
  // and file their presence in D1.
  const ensureAgentInstances = async (includeAll = false) => {
    const ids = includeAll
      ? agentsConfig.agents.map((a) => a.id)
      : Array.from(agentStats.keys());
    for (const id of ids) {
      if (!agentInstances.has(id)) {
        const agent = instantiateAgent(id, env);
        await agent.loadState();
        agentInstances.set(id, agent);
      }
    }
  };

  // ── OB-074: CASES FIRST AT A SHARED TICK ─────────────────────────────────
  // The reserved floor guarantees cases CAN run; running them first means
  // they do not have to rely on the guarantee. The only ticks this reorders
  // are the ones where a case_batch shares an invocation with something else
  // — Sun-Thu 08:00 (where `architect_liaison` is listed first in
  // daily-schedule.json and therefore spent the budget first) and Friday
  // 08:00/09:00/10:00. Every other tick is a single block or has no cases,
  // and its order is untouched. This is the opposite of deprioritising cases,
  // which is the failure the owner named: with ~40 open board tasks, "cases
  // last" is "cases never".
  const orderedBlocks = casesDue
    ? [...dueBlocks].sort((a, b) => (a.type === 'case_batch' ? 0 : 1) - (b.type === 'case_batch' ? 0 : 1))
    : dueBlocks;

  const admissions = [];

  for (const block of orderedBlocks) {
    // Real spend for THIS block, from the meter. Recorded so `BLOCK_COST`'s
    // estimates can be checked against what blocks actually cost instead of
    // being trusted — the estimate is what decides admission, and an estimate
    // nobody re-measures is how this whole defect started.
    const spentBefore = budget.spent();
    let decision = 'ran';
    let estimate = null;
    try {
      // Non-case blocks must fit in what cases have not reserved. A block
      // that does not fit is DEFERRED and said so — never run half-way and
      // never silently skipped. `oversize` runs anyway; see admitBlock().
      if (block.type !== 'case_batch') {
        const admit = admitBlock(budget, block.type);
        decision = admit.decision;
        estimate = admit.cost;
        if (admit.decision === 'defer') {
          await logScheduledError(env, {
            israelTime, dayOfWeek, blockType: block.type,
            error: new Error(
              `deferred by invocation budget (OB-074): needs ~${admit.cost} subrequests, ` +
              `${budget.remainingFor(block.type)} left of ${budget.usable} usable ` +
              `(cases floor ${budget.caseFloor}, spent ${budget.spent()})`
            ),
          });
          continue;
        }
        // NOT charged here — `admit.cost` is an admission estimate, and the
        // meter is about to count what this block really spends. Charging
        // both would bill every block twice.
        budget.setLane(block.type);
      }

      if (block.type === 'case_batch') {
        cycle.results.caseBudget = await runCaseBatchBlock(
          env, cycle, block, agentInstances, agentStats, budget, sim
        );
      } else if (block.type === 'tool_task_window') {
        cycle.results.toolTask = await maybeOpenAssetTask(env, dayOfWeek, cycle.day);
      } else if (block.type === 'report') {
        await ensureAgentInstances(true);
        cycle.results.aiExperience = await runDailyAiExperienceReports(env, agentInstances, agentStats);
      } else if (block.type === 'meeting' && block.meeting_type === 'daily_standup') {
        cycle.results.standup = await runMeeting('daily_standup', env);
      } else if (block.type === 'meeting' && block.meeting_type === 'closing_qa_review') {
        // OFFICE-POLICY A12/A3, wired to the schedule 2026-08-11. The meeting
        // type, its data gatherer (gatherClosingQaReview()) and its
        // context_amendments consumer (applyMeetingEffects()) all existed
        // already; nothing in config/daily-schedule.json ever called it, so
        // "conclusions reach the character files before the next day opens"
        // had never once happened on a real cron tick. See OB-062 for the
        // adjacent, still-open gap this does NOT close: the separate
        // three-person PROBATION DECISION meeting (kept/dropped/extended
        // after 20 actions) still has no dialogue generation of its own.
        cycle.results.closingQaReview = await runMeeting('closing_qa_review', env);
      } else if (block.type === 'spare_time') {
        await ensureAgentInstances(true);
        for (const [, agent] of agentInstances) {
          cycle.results.spareTime.push(await runSpareTimeForAgent(env, agent, { forceIdle: !!block.force_idle }));
        }
      } else if (block.type === 'weekly_summary') {
        const yearState = await getYearState(env);
        cycle.results.weeklySummary = await generateWeeklySummary(env, yearState, yearState.current_week || 1);
        cycle.results.versionBumps = await checkProductVersionBumps(env, yearState, cycle.day);
      } else if (block.type === 'chore_rotation') {
        // Cross-project chore rotation (Notebook-X/data-center/archive-alpha),
        // see config/chore-schedule.json + workers/chore-runner.js. Reuses
        // this existing cron tick — no wrangler.toml change. Wiring-only:
        // resolves/logs model routing, never calls a model, per the
        // 2026-07-08 session scope (TOKEN-BUDGET.md).
        cycle.results.choreRotation = await runChoreRotationSlot(env, { label: `${israelTime} chore_rotation` });
      } else if (block.type === 'guide_draft') {
        cycle.results.guideDraft = await processGuideDraftBlock(env, todayDateStr());
      } else if (block.type === 'guide_review') {
        cycle.results.guideReview = await processGuideReviewBlock(env, todayDateStr());
      } else if (block.type === 'guide_verify') {
        cycle.results.guideVerify = await processGuideVerifyBlock(env);
      } else if (block.type === 'qa_instruments') {
        // Audit finding #8 — the two cross-agent QA instruments had NO
        // autonomous caller until 2026-08-15. Self-gating inside the handler,
        // riding improvement_loop_enabled; see processQaInstrumentsBlock().
        cycle.results.qaInstruments = await processQaInstrumentsBlock(env, {
          weekNumber: (await getYearState(env)).current_week || 0,
        });
      } else if (block.type === 'admin_desk') {
        // The admin tier's draw from real queues (2026-08-17). Self-gating
        // inside the handler on `office_context_enabled`, like the guide_*
        // blocks — it has no switch of its own, see processAdminDeskBlock().
        cycle.results.adminDesk = await processAdminDeskBlock(env);
      } else if (block.type === 'owner_channel') {
        // Self-gating inside the handler, like the guide_* blocks and unlike
        // architect_liaison's call-site gate. Deliberate: this block's FIRST act
        // is to establish what the office has read, and a gate that refuses to
        // enter cannot report that it refused. The handler logs its no-op.
        cycle.results.ownerChannel = await processOwnerChannelBlock(env);
      } else if (block.type === 'architect_liaison') {
        // INERT BY DEFAULT — the gate is HERE, at the call site, not inside
        // the module. When architectLiaisonEnabled(sim) is false (the
        // shipped default: SIM_KV simulation-state carries no
        // `architect_liaison_enabled` key at all until someone calls the
        // architect_liaison_toggle trigger, which this build session does
        // not do), processArchitectLiaisonBlock() is never invoked — no
        // GitHub Contents API call, no D1 write, not even entered. This is
        // deliberately stricter than the guide_* blocks above, which enter
        // their function every tick and self-gate inside it. See
        // workers/architect-liaison.js's header for why the stronger shape
        // was chosen here.
        cycle.results.architectLiaison = architectLiaisonEnabled(sim)
          ? await processArchitectLiaisonBlock(env)
          : { filed: false, skipped: true, reason: 'architect_liaison_disabled' };
      }
    } catch (err) {
      await logScheduledError(env, { israelTime, dayOfWeek, blockType: block.type, error: err });
    } finally {
      budget.setLane('other');
      admissions.push({
        block: block.type, at: block.time, decision, estimate,
        actual: budget.spent() - spentBefore,
      });
    }
  }

  cycle.agentStats = Object.fromEntries(agentStats);
  cycle.budget = budget.snapshot();
  cycle.admissions = admissions;

  // OB-098, 2026-08-16. This line is the whole of that task's blocker. The
  // assignment above REPLACES the previous tick's admissions and
  // `clearCycleState()` deletes the cycle at day end, so until now every
  // estimate-vs-actual pair the office computed was discarded within thirty
  // minutes. D1 is where it can accumulate across days, which is the only
  // shape in which BLOCK_COST's twelve guesses can ever be replaced by
  // measurements. It cannot throw (KFM-14) and is deliberately NOT awaited
  // for its result — a lost row costs trend resolution, never the tick.
  await recordAdmissions(env, cycle.day, admissions);

  if (!isLastBlock) {
    // ── THE WRITE THAT WAS BEING LOST (OB-074, 2026-08-16) ─────────────────
    //
    // This is the single most consequential line in the fix, and it needed no
    // new logic — only to be reached. `setCycleState()` sits AFTER the block
    // loop, so on any tick that ran out of subrequests inside a block, the
    // runtime threw here instead and the cycle was never written. The next
    // tick then found no cycle, regenerated the whole day, and restarted the
    // batch from the head of the list.
    //
    // That is what produced the live evidence in `interactions` on
    // 2026-08-16: "Hardening SSH access on an internet-facing Linux host"
    // asked four times between 06:31 and 09:02, while the tail of the 200-case
    // day was never reached once. The office was not dropping the remainder,
    // it was re-asking the head all day.
    //
    // Two things now protect it. `TICK_TAIL_RESERVE` holds back 8 subrequests
    // that no block may spend, so this write has budget left to succeed; and
    // the try/catch means that if it fails anyway, the tick still returns and
    // says so, rather than throwing out of the cron handler.
    try {
      await setCycleState(env, cycle);
    } catch (err) {
      await logScheduledError(env, { israelTime, dayOfWeek, blockType: 'cycle_persist', error: err });
      return {
        ok: false, cyclePersisted: false, day: cycle.day, dayOfWeek, israelTime,
        blocks: dueBlocks.map((b) => b.type), budget: cycle.budget,
      };
    }
    return {
      ok: true, cyclePersisted: true, day: cycle.day, dayOfWeek, israelTime,
      blocks: dueBlocks.map((b) => b.type), budget: cycle.budget, admissions,
      caseBudget: cycle.results.caseBudget || null,
      deferred: summarizeDayDeferrals(cycle).deferred,
    };
  }

  let finalize;
  try {
    finalize = await finalizeScheduledDay(env, cycle, schedule, isOffDay);
  } catch (err) {
    await logScheduledError(env, { israelTime, dayOfWeek, blockType: 'finalize', error: err });
    finalize = { error: err.message };
  }
  await clearCycleState(env);
  return {
    ok: true, day: cycle.day, dayOfWeek, israelTime, blocks: dueBlocks.map((b) => b.type),
    finalize, budget: cycle.budget, admissions, deferred: summarizeDayDeferrals(cycle).deferred,
  };
}

/**
 * Day-end tail for the scheduled (per-block) path: builds the agents
 * summary from the day-in-progress `cycle`, advances side plots/year stats,
 * runs the day-365 promotion meeting if due, and writes the daily summary
 * report. Mirrors the tail of `runWorkDayCycle()`, but reads cases/batches/
 * agentStats/block results from `cycle` (accumulated tick by tick by
 * `runScheduledBlock`) instead of computing everything in one pass.
 */
async function finalizeScheduledDay(env, cycle, schedule, isOffDay) {
  const yearState = await getYearState(env);
  const nextDay = cycle.day;
  const dayOfWeek = cycle.dayOfWeek;

  const agentInstances = new Map();
  const summary = { day: nextDay, dayOfWeek, inspection: cycle.inspection, agents: [] };

  for (const [agentIdStr, stats] of Object.entries(cycle.agentStats)) {
    const agentId = Number(agentIdStr);
    const agent = instantiateAgent(agentId, env);
    await agent.loadState();
    agentInstances.set(agentId, agent);

    // NOTE: the old rolling model_usage_rate adjustment (driven by
    // getModelUsageAdjustment()'s "compare alternatives" win-rate, from the
    // retired crm-engine.js) is removed along with that mechanic — every
    // agent now always asks its assigned question (Step 3, 2026-07-18
    // Q&A-engine rebuild), so there's no usage-rate signal left to adjust.

    summary.agents.push({
      agentId,
      caseCount: stats.caseCount,
      handled: stats.handled,
      escalations: stats.escalations,
      advancedCases: stats.advancedCases,
      mood: agent.mood,
      irritation: agent.irritation,
      isHappy: agent.isHappy,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
    });
  }

  const { standup, toolTask, aiExperience, spareTime, weeklySummary, versionBumps, choreRotation, guideDraft, guideReview, guideVerify } = cycle.results;

  const sidePlotStarted = await maybeStartSidePlots(env, { day: nextDay, summary, cases: cycle.cases, standup });
  const sidePlotUpdates = await advanceSidePlots(env, nextDay);

  const milestoneKey = `day_${nextDay}`;
  const milestone = yearTrackerSeed.milestones[milestoneKey] || null;
  let milestoneMeeting = null;
  let monthlyReport = null;
  if (milestone && MILESTONE_MEETINGS[milestoneKey] && !isOffDay) {
    try {
      milestoneMeeting = await runMeeting(MILESTONE_MEETINGS[milestoneKey], env);
    } catch (err) {
      milestoneMeeting = { error: err.message };
    }
    // The monthly WRITTEN report (2026-08-08, behind report_pipeline_enabled).
    // AFTER the meeting, deliberately: the meeting's decisions are filed as
    // `reports` rows and the fact pack reads them, so a report generated
    // first would be a report of the month that omits the month's meeting.
    if (MILESTONE_MEETINGS[milestoneKey] === 'monthly') {
      monthlyReport = await generateMonthlyReport(env, Math.ceil(nextDay / 30), yearState.stats?.year_number || 1);
    }
  }

  const newStats = updateYearStats(yearState.stats, { summary, standup, sidePlotStarted, sidePlotUpdates });
  const isYearEnd = nextDay >= yearTrackerSeed.total_days;

  const newState = {
    simulation_start: yearState.simulation_start || new Date().toISOString(),
    current_day: isYearEnd ? 0 : nextDay,
    current_week: isYearEnd ? 0 : Math.ceil(nextDay / 7),
    current_month: isYearEnd ? 0 : Math.ceil(nextDay / 30),
    current_quarter: isYearEnd ? 0 : Math.ceil(nextDay / 91),
    stats: isYearEnd ? { ...newStats, year_number: (newStats.year_number || 1) + 1 } : newStats,
  };
  await persistYearState(env, newState);

  if (milestoneKey === 'day_365' && milestoneMeeting && !milestoneMeeting.error) {
    const yearNumber = newStats.year_number || 1;
    const promoMarkdown = renderPromotionResults(yearNumber, milestoneMeeting);
    // Moved to back-office 2026-08-11 (plan 0.4, stage 5 of 5).
    await commitFileToRepo(
      env, BACKOFFICE_REPO_NAME, `campus/shared/promotions/promotion-results-year-${yearNumber}.md`, promoMarkdown,
      `chore(office): year ${yearNumber} promotion results [skip ci]`
    );
  }

  const displayYearState = {
    ...yearState,
    current_day: nextDay,
    current_week: Math.ceil(nextDay / 7),
    current_month: Math.ceil(nextDay / 30),
    current_quarter: Math.ceil(nextDay / 91),
    stats: newStats,
  };
  const scheduleInfo = { schedule, dayOfWeek, batches: cycle.batches, toolTask, aiExperience, spareTime, weeklySummary, versionBumps, choreRotation, guideDraft, guideReview, guideVerify };
  /*
   * ── A13: SATURDAY IS A REST DAY, AND A REST DAY WRITES NOTHING ──────────
   *
   * Added 2026-08-10, and the guard is on the daily-summary commit below.
   *
   * `isOffDay` has been a parameter of this function since it was written and
   * was used for exactly ONE thing — whether to run a milestone meeting. The
   * summary commit ran unconditionally, so **the office has been committing a
   * report to the public repo every Saturday**, on a day its own schedule file
   * described as off. Nobody had looked, because the file said "day off" and the
   * argument that would have contradicted it was sitting unused in the signature.
   *
   * OFFICE-POLICY A13, owner-approved 2026-08-10: *"Saturday is a rest day. Not
   * for token saving — that is solved elsewhere — but as a safety floor: a day
   * with no automated writing is a day accumulating error stops."* A summary
   * saying nothing happened is still automated writing, and it is exactly the
   * kind that accumulates without anyone reading it.
   *
   * ── WHAT STILL RUNS ON SATURDAY, AND WHY IT IS NOT A WRITE ──────────────
   *
   * persistYearState() above, which advances the day counter. That is not
   * authorship and must not be skipped: a Saturday that does not advance the day
   * opens Sunday on a stale day number, which is a worse failure than the one
   * A13 guards against. The line is "does this produce a document nobody
   * reviewed", not "does this touch storage".
   *
   * The markdown is still RENDERED. It costs nothing — renderDailySummary() is a
   * string template with no model call — and it keeps the off-day path
   * exercising the same code every other day runs, so a renderer that breaks on
   * an idle day fails on Saturday rather than waiting for Sunday to reveal it.
   */
  // allowFetch: true — the daily summary runs once per cycle, so it is one
  // of the callers permitted to refresh the office-context cache.
  // `projects` added 2026-08-08 — see generateWeeklySummary() for why.
  const office = await getOfficeContext(env, { shape: 'report', allowFetch: true, projects: officeProjects.projects });
  // A7's visibility half (2026-08-10). Runs once per day cycle, never on a
  // model-call path. `.catch()` and not a bare await: a monitoring feature that
  // can take down the report it monitors is worse than the gap it closes.
  const branches = await fetchOpenBranches(env).catch((err) => {
    console.warn(`[branch-watch] could not list branches, continuing: ${err?.message || err}`);
    return null;
  });
  // OB-074: the day's real case throughput, read off the cursors the batches
  // carry. Only the scheduled path can report this — runWorkDayCycle() (the
  // non-functional whole-day path) has no per-tick budget and passes null.
  const markdown = renderDailySummary(
    displayYearState, summary, standup, sidePlotStarted, sidePlotUpdates, milestone,
    scheduleInfo, office, branches, summarizeDayDeferrals(cycle)
  );
  // OFFICE-POLICY A9 (2026-08-11) — see composeDailyHeadline()'s comment for
  // why this runs AFTER the free render and is guarded on isOffDay: no model
  // call whose result would be thrown away on a rest day.
  const markdownWithHeadline = await composeDailyHeadline(env, markdown, isOffDay);
  // Moved to back-office 2026-08-11 (plan 0.4, stage 2 of 5): the daily
  // summary publishes the internal delegation board and the office's open
  // owner-questions WITH their full escalation reasoning — operational
  // material per DOC-POLICY.md's private list, not visitor content. Same
  // guarded path meeting reports use (stage 1), same campus/shared/ layout.
  const report = isOffDay
    ? { committed: false, skipped: true, reason: 'rest_day_zero_write', policy: 'OFFICE-POLICY.md A13' }
    : await commitFileToRepo(
      // OB-086 / KFM-17: `nextDay` resets to 0 at year end, so a yearless
      // `day-001-summary.md` would overwrite year 1's. The year comes from
      // `newStats`, NOT `newState.stats` -- the latter is already incremented
      // when this is the rollover day, and this file summarises the day that
      // just ENDED. Files written before 2026-08-16 keep their yearless names
      // and are not renamed (A15).
      env, BACKOFFICE_REPO_NAME, `campus/shared/daily/year-${newStats.year_number || 1}-day-${pad(nextDay, 3)}-summary.md`, markdownWithHeadline,
      `chore(office): year ${newStats.year_number || 1} day ${nextDay} summary [skip ci]`
    );

  return {
    ...summary, year: newState, standup, sidePlotsStarted: sidePlotStarted, sidePlotUpdates, milestone, milestoneMeeting, monthlyReport, report,
    schedule: { dayOfWeek, toolTask, aiExperience, spareTime, weeklySummary, versionBumps },
  };
}

/* ─────────────────────────── Weekly reset cycle ─────────────────────────── */

/**
 * ⚠ MISNAMED, AND DELIBERATELY LEFT THAT WAY. Reads TWENTY-FOUR HOURS.
 *
 * OB-031. Every value this has ever returned is a one-day figure, and the
 * weekly CSV has published it under a `weekly_cases` header since the CSV
 * existed. Measured 2026-08-08: this returned 0 for a week in which the office
 * handled 167 cases.
 *
 * It is NOT widened in place, and that is the whole judgement. Changing what
 * this returns would change what the `weekly_cases` column MEANS without
 * changing its name, so week 7 would read 167 against week 6's 0 — a step
 * change that never happened, in a series a reader is entitled to compare
 * across weeks. Fixing a wrong number by manufacturing a false trend is worse
 * than the wrong number, because the wrong number is at least stable.
 *
 * Nor are the archives rewritten: what was published stays published.
 *
 * Instead the CSV gains a SECOND column, `cases_7d`, carrying the real
 * seven-day figure from getCasesHandledOverDays() below, and the weekly
 * summary says in words why two columns exist and where the new one starts.
 * A column that appears at week N reads as "this is when we began measuring
 * it", which is true. Renaming `weekly_cases` to what it actually holds is
 * the right end state and is an owner decision, not a session's to take: it
 * breaks any consumer reading the header. Boarded, not done here.
 */
async function getWeeklyCasesHandled(env, agentId) {
  if (!env.DB) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cases_handled), 0) AS total FROM agent_sessions WHERE agent_id = ? AND started_at >= ?`
  ).bind(agentId, since).first();
  return row?.total || 0;
}

/** The figure `weekly_cases` was always supposed to hold. Window is explicit
 *  in the parameter rather than baked into the name, which is how the one
 *  above came to say "weekly" and mean "daily". */
async function getCasesHandledOverDays(env, agentId, days = 7) {
  if (!env.DB) return null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cases_handled), 0) AS total FROM agent_sessions WHERE agent_id = ? AND started_at >= ?`
  ).bind(agentId, since).first().catch(() => null);
  // null, not 0 — "could not read" and "read zero" are different facts, which
  // is the same rule the rest of this pipeline runs on.
  return row ? (row.total || 0) : null;
}

async function writeWeeklyAnalytics(env, summary) {
  if (!env.DB) return;
  const stmt = env.DB.prepare(
    `INSERT INTO weekly_analytics (id, week_start, agent_id, total_cases, cases_solved, avg_mood)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(
    summary.agents.map((a) => stmt.bind(crypto.randomUUID(), summary.week_start, a.agentId, a.weeklyCases, a.weeklyCases, a.moodAfter))
  );
}

/**
 * One simulated work week:
 *  1-2. weekly report + partial mood reset for every agent
 *  3. Agent 2 bonus-day check -> bonus_day_drama side plot
 *  4. weekly meeting + a rotating per-agent (1-4) audit_session
 *  5. a low-mood agent (1-4) triggers a pip_session + pip_drama side plot
 *  6. weekly_analytics aggregate
 */
export async function runWeeklyResetCycle(env) {
  const yearState = await getYearState(env);
  const summary = { week_start: new Date().toISOString(), agents: [] };

  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();

    const moodBefore = agent.mood;
    const weeklyCases = await getWeeklyCasesHandled(env, config.id);

    await agent.fileWeeklyReport(
      `Weekly report for ${agent.name}: ${weeklyCases} cases handled, mood ${moodBefore} -> regressing to mean, irritation ${agent.irritation}/5.`
    );

    if (typeof agent.checkWeeklyBonus === 'function') {
      const target = simulationConfig.WORK_DAY.cases_per_day_min * 5;
      const bonus = await agent.checkWeeklyBonus(weeklyCases, target);
      if (bonus && config.id === 2) {
        await startSidePlot(env, 'bonus_day_drama', [2, 1, 3, 4], yearState.current_day || 1);
      }
    }

    await agent.resetWeeklyState();
    summary.agents.push({ agentId: config.id, weeklyCases, moodBefore, moodAfter: agent.mood });
  }

  await writeWeeklyAnalytics(env, summary);

  let weekly = null;
  try {
    weekly = await runMeeting('weekly', env);
  } catch (err) {
    weekly = { error: err.message };
  }

  const auditTarget = ((yearState.current_week || 1) - 1) % 4 + 1;
  let audit = null;
  try {
    audit = await runMeeting('audit_session', env, { auditedAgentId: auditTarget });
  } catch (err) {
    audit = { error: err.message };
  }

  let pip = null;
  const lowMoodAgent = summary.agents.find((a) => a.agentId >= 1 && a.agentId <= 4 && a.moodAfter <= 20);
  if (lowMoodAgent) {
    try {
      pip = await runMeeting('pip_session', env, { targetAgentId: lowMoodAgent.agentId });
      await startSidePlot(env, 'pip_drama', [7, lowMoodAgent.agentId], yearState.current_day || 1);
    } catch (err) {
      pip = { error: err.message };
    }
  }

  return { ...summary, weekly, audit, pip };
}

/**
 * Owner-triggered clean state reset (2026-07-19, stale-DO-state incident):
 * zeroes every agent's mood-machine state — INCLUDING
 * permanentIrritationFlags, which resetWeeklyState() deliberately preserves
 * — with none of runWeeklyResetCycle()'s side effects (no weekly reports,
 * no weekly/audit meetings, no model calls, no analytics rows).
 * configOverrides are preserved (durable config tweaks, not mood state).
 * Pass agentId to target one agent; omit for all 11. Returns before/after
 * per agent so the caller can verify, not just trust the call succeeded.
 */
export async function runAgentStateReset(env, agentId = null) {
  const results = [];
  for (const config of agentsConfig.agents) {
    if (agentId != null && config.id !== agentId) continue;
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();
    const before = {
      mood: agent.mood,
      irritation: agent.irritation,
      isAngry: agent.isAngry,
      isHappy: agent.isHappy,
      isPanic: agent.isPanic,
      panicLevel: agent.panicLevel,
      permanentIrritationFlags: [...agent.permanentIrritationFlags],
    };
    agent.mood = 50;
    agent.irritation = 0;
    agent.isAngry = false;
    agent.isHappy = false;
    agent.isPanic = false;
    agent.panicLevel = 0;
    agent.permanentIrritationFlags = [];
    agent.session = null;
    await agent.saveState();
    results.push({ agentId: config.id, name: config.name, before });
  }
  return { reset: results.length, agents: results };
}

/* ────────────────────────────────── HTTP API ───────────────────────────── */

export default {
  /**
   * Cron Trigger (configured in this Worker's wrangler.toml):
   *   "*\/30 5-13 * * *" -> every 30 min, 05:00-13:30 UTC = 08:00-16:30 IDT.
   * Each tick converts event.scheduledTime to Israel local time and calls
   * runScheduledBlock(), which is a no-op unless daily-schedule.json has a
   * block at that exact time for that day-of-week. See "Daily Automation"
   * in CLAUDE.md.
   */
  async scheduled(event, env, ctx) {
    const { time, dayOfWeek } = israelTimeParts(new Date(event.scheduledTime));
    ctx.waitUntil(runScheduledBlock(env, time, dayOfWeek));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // All /api/agents/* endpoints require the admin token configured as a
    // Worker secret (env.ADMIN_TOKEN). The browser never embeds this value
    // — the admin types it into the dashboard once and it's sent back as
    // X-Admin-Token, so the real check always happens server-side here.
    if (url.pathname.startsWith('/api/agents/')) {
      const token = request.headers.get('X-Admin-Token') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401, origin);
      }
    }

    /*
     * ── THE OWNER'S PAGE (2026-08-10, REQ-003) ─────────────────────────────
     *
     * Served UNAUTHENTICATED and deliberately so: it holds no secret. It is an
     * empty form until he pastes his token in, and the token lives in that tab's
     * sessionStorage and travels in `X-Admin-Token` — never in a URL, a referrer
     * or a server log. A page with the token baked in would put that token into
     * the public repo's history the first time anybody saved a copy.
     *
     * Every WRITE path is under `/api/agents/`, which the block above
     * authenticates before any handler is reached. There is no second write path.
     */
    if (request.method === 'GET' && (url.pathname === '/owner' || url.pathname === '/owner/')) {
      return new Response(renderOwnerPage({ endpointBase: url.origin }), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // No caching: the page's whole job is to show live read state.
          'Cache-Control': 'no-store',
          // It loads nothing from anywhere. Said in a header as well as being
          // true, so a future edit that adds a CDN script fails in the browser
          // rather than shipping quietly.
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/agents/status') {
        return json(await getAllAgentStatuses(env), 200, origin);
      }

      /*
       * ── THE OWNER CHANNEL'S READ AND WRITE HALVES ───────────────────────
       *
       * `owner-state` is a READ of the same snapshot the agent prompts use — not
       * a second reading of the same files. Two readers of one folder is the
       * drift this project keeps finding; the page sees exactly what the office
       * sees, including the office's own errors reading it.
       */
      if (request.method === 'GET' && url.pathname === '/api/agents/owner-state') {
        /*
         * FETCHES FRESH, and does NOT read the 30-minute snapshot cache.
         *
         * getOfficeSnapshot() would have been the cheaper call and it is the wrong
         * one here. This page's entire purpose is to answer "has the office read
         * what I wrote", and a cached answer can say NOT YET READ about a message
         * the office read twenty minutes ago. That is wrong in the worst possible
         * direction on this particular surface: it would show him the exact
         * failure — *a message the office has not read looks like one it read and
         * ignored* — as an artefact of our own caching.
         *
         * The cost is one directory listing plus a handful of GETs, on a page a
         * human opens by hand. The result is written BACK into the cache, so the
         * office gets the benefit of the refresh rather than paying for it twice.
         */
        const fresh = await fetchOfficeSnapshot(env);
        if (env.SIM_KV) await env.SIM_KV.put(OFFICE_SNAPSHOT_CACHE_KEY, JSON.stringify(fresh)).catch(() => {});
        return json({ ok: true, state: buildOwnerState(fresh), _fresh: true }, 200, origin);
      }

      /*
       * THE WRITE. The candidate file is built, then run through THE REAL
       * `parseOwnerMessage()` — the same function that reads the folder — and a
       * candidate that does not parse is REFUSED and never written.
       *
       * That ordering is the whole design. The requirement was that the page must
       * produce a message the existing parser accepts, and that the parser must
       * NOT be relaxed to make the page easier. Putting the parser between the
       * page and the folder makes the first true by construction rather than by
       * the builder being careful, and it makes the second impossible to give up
       * accidentally: relaxing the parser to admit a bad page message would
       * simultaneously relax what the office accepts from him by hand.
       */
      if (request.method === 'POST' && url.pathname === '/api/agents/owner-message') {
        const body = await request.json().catch(() => ({}));
        const built = buildOwnerMessage({
          subject: body.subject,
          body: body.body,
          kind: body.kind,
          re: body.re || 'new',
          date: todayDateStr(),
        });
        if (!built.ok) return json({ ok: false, reason: built.reason }, 400, origin);

        // THE GATE. The real parser, unmodified, on the exact bytes about to be
        // written. Not a schema check that resembles it.
        const parsed = parseOwnerMessage(built.text, built.filename, null);
        if (!parsed.ok) {
          return json({
            ok: false,
            reason: `refused by the office's own parser before anything was written: ${parsed.reason}`,
            _note: 'The parser is the authority and is not relaxed to accept this page. If this ever fires, the PAGE is wrong.',
          }, 400, origin);
        }

        const write = await commitFileToRepo(
          env, BACKOFFICE_REPO_NAME, built.path, built.text,
          `owner: ${parsed.message.kind} — ${parsed.message.title} (via the owner page)`
        );
        if (!write.committed) {
          return json({ ok: false, reason: `the message parsed but could not be written: ${write.reason || `HTTP ${write.status}`}` }, 502, origin);
        }

        console.log(`[owner-page] wrote ${built.path} (kind=${parsed.message.kind})`);
        return json({
          ok: true,
          path: built.path,
          id: parsed.message.id,
          kind: parsed.message.kind,
          // Said back to him plainly: the write is the delivery, and the office
          // reads the folder on its own schedule. No claim that anybody has read
          // it yet — that is what the read state on the page is for.
          note: 'Written to back-office. The office reads this folder on every office-context refresh (30-minute cache) and records the read against this message\'s content SHA.',
        }, 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/sessions') {
        const limit = Number(url.searchParams.get('limit')) || 50;
        return json(await getRecentInteractions(env, limit), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/reports') {
        return json(await getReports(env, url.searchParams.get('type')), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/suggestions') {
        return json(await getSuggestions(env), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/year') {
        return json(await getYearState(env), 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/agents/side-plots') {
        return json(await getSidePlots(env, url.searchParams.get('status')), 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/run') {
        // Manual single-case trigger for local testing: { agentId, caseData, opts }
        const body = await request.json();
        const result = await runAgentSession(body.agentId, body.caseData, env, body.opts || {});
        return json(result, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/test-gemini') {
        // Direct queryGroqRouted() smoke test (endpoint name is historical): { agentId, prompt, opts: { forceFallback } }
        const body = await request.json();
        const result = await runGeminiTest(body.agentId, body.prompt, env, body.opts || {});
        return json(result, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/agents/trigger') {
        // Unified admin trigger: { type: 'day'|'meeting'|'inspection'|'week_reset'|'state_reset'|'state_set'|'block', ...opts }
        const body = await request.json();
        let result;
        switch (body.type) {
          case 'day':
            result = await runWorkDayCycle(env);
            break;
          case 'meeting': {
            if (!body.meetingType || !MEETING_TYPES[body.meetingType]) {
              return json({ error: 'invalid_meeting_type' }, 400, origin);
            }
            try {
              result = await runMeeting(body.meetingType, env, body.opts || {});
            } catch (err) {
              return json({ error: 'meeting_error', message: err.message }, 400, origin);
            }
            break;
          }
          case 'inspection':
            result = await updateSimulationState(env, { inspection_mode: !!body.active });
            break;

          /*
           * ══════════════════════════════════════════════════════════════
           * THE FOUR CASES ADDED 2026-08-10, BEFORE `POST /api/simulation`
           * WAS CLOSED — AND THE ORDER IS THE POINT
           * ══════════════════════════════════════════════════════════════
           *
           * `updateSimulationState()`'s allow-list carries TEN keys. Seven had
           * an authenticated route on this endpoint. Three did not:
           * `paused`, `phase`, and `action_items_to_board_enabled` — reachable
           * ONLY through the unauthenticated POST /api/simulation.
           *
           * So closing that endpoint first would have left three production
           * switches — including `paused`, the office's stop button — with NO
           * ROUTE AT ALL. A switch with no route is worse than one with an open
           * route: the open route is a known risk with a known fix, and the
           * absent route is discovered at the moment someone needs to stop the
           * office. These land first, deliberately, and the endpoint closes
           * after them in the same commit.
           *
           * `action_items_to_board_toggle` REVERSES a prior decision recorded in
           * scripts/verify-office-bureaucracy.js §3, which asserted this case
           * must NOT exist so the flag "stays owner-only". That reasoning was
           * sound while the alternative was an unauthenticated endpoint and is
           * inverted by closing it: with the endpoint authenticated, the trigger
           * case IS the owner-only path, and refusing to add it would leave the
           * flag settable by nobody. The check is rewritten, not deleted, so the
           * reversal is legible in the diff rather than looking like a rule
           * quietly dropped.
           */
          case 'pause':
            // The office's stop button. Body: { paused: true|false }.
            // `!!body.paused` and not `body.paused ?? true` — an absent field
            // means UNPAUSE here, which is only a safe direction to fail in
            // because pausing is always available as an explicit call.
            result = await updateSimulationState(env, { paused: !!body.paused });
            break;
          case 'phase_set':
            // The simulation phase (`phase` in simulation-config.json's
            // SIMULATION block). Refused rather than coerced: `phase` drives
            // which agent set and which schedule are live, and a phase set to
            // the string "undefined" by a typo'd body is a whole day of the
            // wrong office.
            if (body.phase === undefined || body.phase === null || body.phase === '') {
              return json({ error: 'phase_set_requires_phase' }, 400, origin);
            }
            result = await updateSimulationState(env, { phase: body.phase });
            break;
          case 'action_items_to_board_toggle':
            // Meeting action items -> the board's inbox (workers/
            // meeting-decisions.js, gate in meeting-engine.js
            // actionItemsToBoardEnabled()). Body: { enabled: true|false }.
            // See the block above for why this case now exists.
            result = await updateSimulationState(env, { action_items_to_board_enabled: !!body.enabled });
            break;
          case 'simulation_state':
            // Authenticated READ-BACK of the whole simulation state, and the
            // reason it exists is the one the closure created: `GET
            // /api/simulation` stays open (read-only, and data-center's admin
            // tab depends on it), but an operator who has just flipped a switch
            // through this endpoint should not have to change endpoints and
            // drop authentication to confirm it took. Makes no model call and
            // writes nothing.
            result = await getSimulationState(env);
            break;
          case 'week_reset':
            result = await runWeeklyResetCycle(env);
            break;
          case 'state_reset':
            // Clean mood/state zero for all agents (or body.agentId only) —
            // incl. permanentIrritationFlags; no meetings/model calls.
            result = await runAgentStateReset(env, body.agentId ?? null);
            break;
          case 'state_set': {
            // Explicit per-agent state override (2026-07-19): supervised
            // testing/ops only — e.g. forcing an agent ANGRY to verify the
            // no-skip fix, or clearing a specific flag. Whitelisted fields
            // only. Body: { agentId, state: { mood?, irritation?, isAngry?,
            // isHappy?, isPanic?, panicLevel?, permanentIrritationFlags? } }
            if (!body.agentId || !body.state || typeof body.state !== 'object') {
              return json({ error: 'state_set_requires_agentId_and_state' }, 400, origin);
            }
            const agent = instantiateAgent(body.agentId, env);
            await agent.loadState();
            const before = {
              mood: agent.mood, irritation: agent.irritation, isAngry: agent.isAngry,
              isHappy: agent.isHappy, isPanic: agent.isPanic, panicLevel: agent.panicLevel,
              permanentIrritationFlags: [...agent.permanentIrritationFlags],
            };
            for (const field of ['mood', 'irritation', 'isAngry', 'isHappy', 'isPanic', 'panicLevel', 'permanentIrritationFlags']) {
              if (field in body.state) agent[field] = body.state[field];
            }
            await agent.saveState();
            result = { agentId: body.agentId, before, after: body.state };
            break;
          }
          case 'sync_agents':
            // Re-sync D1 agents identity rows from agents-config.json
            // (also runs automatically at each day-cycle start).
            result = await syncAgentsTable(env);
            break;
          case 'guides_toggle':
            // Guides-pipeline kill switch (see guidesEnabled()): flips the
            // SIM_KV simulation-state `guides_enabled` flag without a
            // redeploy. Body: { enabled: true|false }. While off (or absent),
            // scheduled guide_draft/guide_review/guide_verify blocks are
            // logged no-ops.
            result = await updateSimulationState(env, { guides_enabled: !!body.enabled });
            break;
          case 'cases_toggle':
            // Case work (the Q&A engine) kill switch — see casesEnabled().
            // Body: { enabled: true|false }. While off, no questions are
            // generated for either product; every case_batch block admits an
            // empty batch, and the judge sampler, improvement loop and gap
            // digests idle behind it. UNLIKE every other toggle here, absent
            // means ON — retiring the capability takes an explicit false.
            // A '_rejected_keys' field in the response means 'cases_enabled'
            // fell off the allow-list in updateSimulationState().
            result = await updateSimulationState(env, { cases_enabled: !!body.enabled });
            break;
          case 'owner_channel_toggle':
            // The owner channel's kill switch (workers/owner-notify.js
            // ownerChannelEnabled()). Body: { enabled: true|false }. While off
            // or absent — the code default — the daily owner_channel block is a
            // logged no-op: no receipt is written and no Issue is filed.
            result = await updateSimulationState(env, { owner_channel_enabled: !!body.enabled });
            break;
          case 'owner_channel_status': {
            // Read-back, NO model calls and NO Issue. Answers the three
            // questions a documented switch state cannot (OB-040): is it on,
            // what has the office failed to send, and what is waiting on the
            // client right now.
            const snapshot = await getOfficeSnapshot(env, { allowFetch: true });
            const today = todayDateStr();
            const aged = ageQuestions(snapshot?.questions?.questions || [], today);
            result = {
              owner_channel_enabled: await ownerChannelEnabled(env),
              office_context_enabled: await officeContextEnabled(env),
              issue_label: OWNER_ISSUE_LABEL,
              today,
              heartbeat_day: new Date(`${today}T00:00:00Z`).getUTCDay() === 0,
              owner_messages: snapshot?.owner?.classified?.counts || null,
              owner_messages_malformed: snapshot?.owner?.malformed || [],
              read_records: (snapshot?.owner?.readLog?.records || []).length,
              submissions: snapshot?.submissions?.counts || null,
              questions_risen: aged.filter((q) => q.open && q.escalation?.headline)
                .map((q) => `${q.id} [${q.escalation.rung}, ${q.escalation.days}d]`),
              would_notify: selectNotificationItems({
                submissions: snapshot?.submissions?.submissions || [],
                questions: aged,
                // Same input the block itself passes, so this read-back cannot
                // report a quieter notification than the one that would be sent.
                refusedMessages: snapshot?.owner?.malformed || [],
              }).map((i) => `${i.id} — ${i.title}`),
              // THE LOUD HALF. A failed notification stays visible here until it
              // clears, because a channel that only reports its successes is the
              // incumbent this one replaced.
              recent_failures: await recentFailures(env),
              errors: snapshot?.errors || [],
            };
            break;
          }
          case 'owner_email_notice': {
            // SESSION 11, ITEM A (2026-08-23). COMPOSES THE EMAIL. SENDS NOTHING.
            //
            // The office's one channel that ever reached the owner is email
            // (agents/architect_agent.py send_approval_email(), 2026-07-05,
            // Resend 2xx). Its caller — .github/workflows/archive-architect.yml
            // — was disabled 2026-07-07 and never re-enabled. RESEND_API_KEY is
            // a GitHub Actions repository secret and is NOT a Worker secret, so
            // the Worker composes (it has the snapshot, the context and Gemini)
            // and .github/workflows/owner-email.yml delivers (it has the key).
            //
            // Read-only against the office: no Issue, no D1 write, no KV write.
            // ONE Gemini call, and a failure there degrades to the English
            // skeleton rather than to silence.
            const snapshot = await getOfficeSnapshot(env, { allowFetch: true });
            const today = todayDateStr();
            const aged = ageQuestions(snapshot?.questions?.questions || [], today);
            const selected = selectNotificationItems({
              submissions: snapshot?.submissions?.submissions || [],
              questions: aged,
              issueReadback: snapshot?.issueReadback || [],
              refusedMessages: snapshot?.owner?.malformed || [],
            });
            // THE GATE (item E). An item that cannot state all three parts is a
            // log entry, not a notification. `gated` is returned, never dropped
            // silently — a channel that quietly discards items is the failure
            // this whole file was built to not repeat.
            const { notifiable, gated } = gateNotificationItems(selected);
            const isHeartbeatDay = new Date(`${today}T00:00:00Z`).getUTCDay() === 0;

            if (!notifiable.length && !isHeartbeatDay) {
              result = {
                send: false,
                reason: 'nothing_notifiable_and_not_heartbeat_day',
                selected: selected.length, gated,
              };
              break;
            }

            // The Issue this notice points AT — the most recent owner-channel
            // Issue, which is the record the email is a notice about. The email
            // never carries the Issue's contents (A5): it is a notice.
            const newest = (list) => (list || []).filter((i) => i.state === 'open')
              .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
            let issueRepo = OWNER_NOTIFY_REPO;
            let latest = newest(await fetchOwnerChannelIssues(env, issueRepo));
            if (!latest) {
              // TRANSITION FALLBACK, and it is not only for the day item C
              // landed. The notification repo moved to back-office on
              // 2026-08-23 and the eleven Issues already sent stand in the
              // PUBLIC repo, deliberately unmigrated. Until back-office has one
              // of its own, the record this notice is about is still over
              // there, and a notice with a dead link is worse than one that
              // points at the older record honestly.
              issueRepo = REPO_NAME;
              latest = newest(await fetchOwnerChannelIssues(env, issueRepo));
            }
            const issueUrl = latest
              ? `https://github.com/${REPO_OWNER}/${issueRepo}/issues/${latest.number}`
              : null;

            const skeletonItems = notifiable;
            // The sequence is READ off the Issue this notice points at, never
            // allocated here — the email is a notice about a notification that
            // already went, and allocating a number would make the email and
            // the Issue disagree about which one it is.
            const seqMatch = /\[Office #(\d+)\]/.exec(latest?.title || '');
            const seq = seqMatch ? Number(seqMatch[1]) : null;
            const draft = buildEmailNotice({ seq, items: skeletonItems, today, issueUrl, hebrew: null });

            // A4: Hebrew is Gemini's job in this estate. Never Anthropic — that
            // budget is the Architect's and is not spent on notification text.
            let hebrew = null;
            let hebrewError = null;
            try {
              const simConfig = env.SIM_CONFIG?.GEMINI || {};
              const g = await callGemini({
                apiKey: env.GEMINI_API_KEY,
                model: simConfig.model || 'gemini-3.1-flash-lite',
                endpoint: simConfig.api_endpoint || 'https://generativelanguage.googleapis.com/v1beta/models',
                temperature: 0.4,
                maxTokens: 1400,
                prompt: buildHebrewNoticePrompt(draft.skeleton),
                ai: env.AI,
              });
              hebrew = g?.text || null;
              if (g?.source === 'cloudflare-fallback') hebrewError = 'gemini quota — cloudflare fallback composed it';
            } catch (err) {
              hebrewError = `gemini threw: ${err?.message || err}`;
            }

            const notice = buildEmailNotice({ seq, items: skeletonItems, today, issueUrl, hebrew });
            result = {
              send: true,
              to: OWNER_EMAIL,
              seq, today,
              subject: notice.subject,
              html: notice.html,
              used_hebrew: notice.usedHebrew,
              hebrew_error: hebrewError,
              issue_url: issueUrl,
              notifiable: notifiable.map((i) => i.id),
              // The finding, carried in the read-back rather than only in a log.
              gated_out: gated,
            };
            break;
          }
          case 'owner_channel_block':
            // Supervised single run with the gate bypassed — the same pattern
            // `guide_block` uses, and for the same reason: {"type":"block"} at
            // the scheduled time would also fire that tick's other blocks.
            // THIS FILES A REAL ISSUE AND WRITES A REAL RECEIPT.
            // `{"heartbeat": true}` forces the weekly heartbeat on a non-Sunday,
            // which is the only way a supervised run can prove the SEND rather
            // than the gating when the office has nothing pending.
            result = await processOwnerChannelBlock(env, { bypassGate: true, forceHeartbeat: !!body.heartbeat });
            break;
          case 'architect_liaison_toggle':
            // Architect-liaison kill switch (see workers/architect-liaison.js
            // architectLiaisonEnabled()): flips SIM_KV simulation-state
            // `architect_liaison_enabled` without a redeploy. Body:
            // { enabled: true|false }. SHIPPED OFF, per this feature's own
            // build session (2026-08-07, phase-2) — that session built this
            // code and deliberately did not call this endpoint. Turning it
            // on is a separate, explicit owner decision; this case existing
            // is not that decision having been made. While off (or absent,
            // the shipped default), the `architect_liaison` block's call
            // site in the tick dispatch below never invokes
            // processArchitectLiaisonBlock() at all — not a logged no-op,
            // genuinely uncalled.
            result = await updateSimulationState(env, { architect_liaison_enabled: !!body.enabled });
            break;
          case 'architect_liaison_status': {
            // Read-back for the inertness proof this build session hands the
            // owner: the flag as read from KV (via getSimulationState(), the
            // same function the block dispatch itself calls — no separate
            // code path that could disagree with production), and nothing
            // else. Makes no GitHub API call and touches no report row —
            // this endpoint's whole point is to be checkable without
            // triggering the very call path it is reporting on.
            const sim = await getSimulationState(env);
            result = {
              architectLiaisonEnabled: architectLiaisonEnabled(sim),
              rawFlagValue: sim.architect_liaison_enabled,
              note: 'This reads simulation-state only. It does not call processArchitectLiaisonBlock() and proves nothing about the GitHub Contents API fetch path by itself — see the written test procedure for how to check that the call site is not entered.',
            };
            break;
          }
          case 'improvement_loop_toggle':
            // Improvement-loop CAPTURE kill switch (workers/improvement-loop.js
            // improvementLoopEnabled()): flips SIM_KV simulation-state
            // `improvement_loop_enabled` without a redeploy. Body:
            // { enabled: true|false }. While off — or absent, which is the
            // shipped default — recordOfficeEvent() writes nothing and the
            // live Q&A path behaves exactly as it did before this existed.
            // Turning it ON starts CAPTURE ONLY: no review job exists yet
            // (plan 1.2-1.5 are not built), by design — the reviews need a
            // day or two of accumulated rows to review.
            result = await updateSimulationState(env, { improvement_loop_enabled: !!body.enabled });
            break;
          case 'improvement_loop_status': {
            // Read-back for the supervised test. Makes no model calls and
            // writes nothing: the flag, and today's captured rows grouped by
            // event_type and track. Returns capture_table_missing when the
            // ALTER TABLE migration has not been run yet, which is a
            // different and much more useful answer than "0 rows".
            const flagOn = await improvementLoopEnabled(env);
            let rows = null;
            let tableReady = false;
            if (env.DB) {
              const probe = await env.DB.prepare(
                `SELECT event_type, track, COUNT(*) AS n, AVG(quality) AS avg_quality
                   FROM reports
                  WHERE event_type IS NOT NULL AND date(created_at) = date('now')
                  GROUP BY event_type, track ORDER BY event_type`
              ).all().catch(() => null);
              tableReady = probe !== null;
              rows = probe?.results ?? null;
            }
            result = {
              improvementLoopEnabled: flagOn,
              captureColumnsPresent: tableReady,
              ...(tableReady ? { today: rows } : { note: 'reports.event_type is missing — run the four ALTER TABLE statements in database/schema.sql' }),
            };
            break;
          }
          case 'learning_loop_toggle':
            // The write half of the loop's kill switch (workers/context-editor.js
            // learningLoopEnabled(), also read by probation.js). Body:
            // { enabled: true|false }. SHIPPED OFF. While off (or absent), every
            // exported write function in context-editor.js/probation.js returns
            // {written:false|proposed:false, reason:'learning_loop_disabled'}
            // without touching the network or D1 — no active-context.md,
            // journal.md or adaptations file is ever fetched or written.
            result = await updateSimulationState(env, { learning_loop_enabled: !!body.enabled });
            break;
          case 'learning_loop_status': {
            // Read-back: the flag, plus open probations (never their content —
            // A3: "the agent is not told" — this is an admin/owner endpoint, not
            // agent-facing, but the same discipline is kept so no code path ever
            // prints a probationary entry as ordinary text an agent's prompt
            // could pick up secondhand).
            const flagOn = await learningLoopEnabled(env);
            let openByAgent = null;
            let dueForDecision = null;
            if (env.DB && flagOn) {
              const probe = await env.DB.prepare(
                `SELECT agent_id, aspect, entered_at, action_count, rounds FROM probation WHERE status='open' ORDER BY agent_id`
              ).all().catch(() => null);
              openByAgent = probe?.results ?? null;
              dueForDecision = (await probationsDueForDecision(env).catch(() => [])).map((r) => ({ id: r.id, agentId: r.agent_id, aspect: r.aspect, actionCount: r.action_count }));
            }
            result = {
              learningLoopEnabled: flagOn,
              probationActionsTarget: PROBATION_ACTIONS_TARGET,
              maxConcurrentPerAgent: MAX_CONCURRENT_PER_AGENT,
              openProbations: openByAgent,
              dueForDecision,
            };
            break;
          }
          case 'learning_loop_active_context_write':
            // Supervised single write — the gate is NOT bypassed here
            // (unlike guide_block/owner_channel_block): this writes to
            // back-office, a real repo, and the flag itself is the only
            // gate that should ever need bypassing for a real conclusion.
            // Body: { actorId, targetAgentId, content, aspect? }. If `aspect`
            // is present this ALSO opens a probation (A3) via proposeChange();
            // without it, this writes directly via writeActiveContextAmendment()
            // for a one-off supervised proof (Phase 1.4 of the 2026-08-10
            // learning-loop session — see that session's report for the real
            // conclusion this proved against a live agent file).
            result = body.aspect
              ? await proposeChange(env, { actorId: body.actorId, targetAgentId: body.targetAgentId, aspect: body.aspect, content: body.content })
              : await writeActiveContextAmendment(env, { actorId: body.actorId, targetAgentId: body.targetAgentId, content: body.content });
            break;
          case 'learning_loop_journal_write':
            // Body: { actorId, agentId, content }. Self-write only — see
            // context-editor.js writeJournalEntry()'s header for the one
            // exception (the roll-off mechanism), which this endpoint cannot
            // reach (it always passes the real actorId through).
            result = await writeJournalEntry(env, { actorId: body.actorId, agentId: body.agentId, content: body.content });
            break;
          case 'learning_loop_adaptation_write':
            // Body: { actorId, agentId, topic, content }.
            result = await appendAdaptation(env, { actorId: body.actorId, agentId: body.agentId, topic: body.topic, content: body.content });
            break;
          case 'learning_loop_probation_decide': {
            // Body: { probationId, outcome, decidedBy, teamLeadBehavior,
            // qaQualityMetrics, evidence } for a real decision, OR
            // { probationId, checkMissed: true } to only check (never apply)
            // whether a due-and-unmet probation would fall.
            if (body.checkMissed) {
              const row = env.DB ? await env.DB.prepare('SELECT * FROM probation WHERE id = ?').bind(body.probationId).first() : null;
              result = row
                ? meetingMissedFalls({ actionCount: row.action_count, target: PROBATION_ACTIONS_TARGET, meetingHeld: false })
                : { falls: false, reason: 'no such probation row' };
              break;
            }
            const validated = recordDecision({
              probationId: body.probationId, outcome: body.outcome, decidedBy: body.decidedBy,
              teamLeadBehavior: body.teamLeadBehavior, qaQualityMetrics: body.qaQualityMetrics, evidence: body.evidence,
            });
            if (!validated.valid) { result = { applied: false, reason: validated.reason }; break; }
            result = await applyDecision(env, {
              probationId: validated.decision.probationId, outcome: validated.decision.outcome,
              decidedBy: validated.decision.decidedBy, decidingActorId: validated.decision.decidedBy,
              evidence: { teamLeadBehavior: validated.decision.teamLeadBehavior, qaQualityMetrics: validated.decision.qaQualityMetrics, ...validated.decision.evidence },
            });
            break;
          }
          case 'learning_loop_probation_fall':
            // Applies a missed-meeting fall for real (see meetingMissedFalls()
            // above for the check-only counterpart). Body: { probationId }.
            result = await applyMissedMeetingFall(env, { probationId: body.probationId, decidingActorId: body.decidingActorId });
            break;
          case 'learning_loop_review_the_reviewers':
            // Pure validation, no D1 write of its own — a caller records the
            // resulting record wherever office meetings are already recorded.
            // Body: { flaggedReviewer, reviewingPair, decidedBy, architectOpinion }.
            result = reviewTheReviewers(body);
            break;
          case 'learning_loop_provider_blame_check':
            // Pure threshold check, A3's "blaming the provider" rule. Body:
            // { failingAgentIds, failingDates, embodimentComparisonDone }.
            result = canBlameProvider(body);
            break;
          case 'spare_time_block': {
            // Runs the spare_time block for every agent, directly. ADDED
            // 2026-08-17 with the OB-131 fix, because that task's metric is
            // "checked by reading D1 `interactions` for a real tick" and there
            // was no way to produce one on demand: {"type":"block",
            // "israelTime":"14:30"} goes through runScheduledBlock(), which
            // OPENS A DAY CYCLE when none matches — generating and persisting a
            // whole day of questions as a side effect of testing a block that
            // asks no questions.
            //
            // Body: { forceIdle: true } to exercise the zero-model-call path
            // (which is what Saturday does), omitted for the real 20% roll.
            const spare = [];
            for (const config of agentsConfig.agents) {
              const agent = instantiateAgent(config.id, env);
              await agent.loadState();
              spare.push(await runSpareTimeForAgent(env, agent, { forceIdle: !!body.forceIdle }));
            }
            result = {
              agents: spare.length,
              logged: spare.filter((s) => s.logged).length,
              dropped: spare.filter((s) => !s.logged).map((s) => ({ agentId: s.agentId, reason: s.logReason })),
              modes: spare.reduce((m, s) => ({ ...m, [s.mode]: (m[s.mode] || 0) + 1 }), {}),
            };
            break;
          }
          case 'asset_task_window':
            // OB-132, 2026-08-17. This WAS the Sun-Thu 11:30 `tool_task_window`
            // block. It was retired from the schedule — it fired every weekday,
            // was admitted with `decision: run`, and returned `not_eligible`
            // every time since simulation day 6, because all four standing
            // board items had already had their asset-task Issue filed by day 8
            // and only a human executing work in an external tool can refill
            // that queue. See config/daily-schedule.json's
            // `_tool_task_window_retired_2026_08_17` block for the full reason
            // and for why it was retired rather than quietly silenced.
            //
            // THE CAPABILITY IS NOT GONE, only the timer. Body:
            // { dayOfWeek: 1..5 } picks the rotation row, { day } stamps the
            // board history. Run it the day a real asset task is queued.
            result = await maybeOpenAssetTask(
              env,
              Number.isInteger(body.dayOfWeek) ? body.dayOfWeek : 1,
              Number.isInteger(body.day) ? body.day : (await getYearState(env)).current_day || 0,
            );
            break;
          case 'admin_desk_block':
            // Runs the Sun-Thu 10:00 admin-desk block directly, gate bypassed
            // — the same supervised shape `guide_block` and `qa_instruments_block`
            // use. Body: { bypassGate?: false to honour office_context_enabled }.
            // Safe to run repeatedly: the review desk skips any agent whose
            // review is already sitting in the lifecycle inbox, so a second run
            // in the same day draws the NEXT two reviews rather than re-filing
            // the first two.
            result = await processAdminDeskBlock(env, { bypassGate: body.bypassGate !== false });
            break;
          case 'qa_instruments_block':
            // Runs the Friday qa_instruments block directly, gate bypassed —
            // the same supervised shape `guide_block` uses, and for the same
            // reason: {"type":"block","israelTime":"09:30"} would also fire
            // Friday's 09:30 case batch. Body: { weekNumber?, bypassGate? }.
            // ADDED 2026-08-15 alongside the scheduled block; the trigger is
            // the SUPERVISED path, not the only path — that was finding #8.
            result = await processQaInstrumentsBlock(env, {
              bypassGate: body.bypassGate !== false,
              weekNumber: Number.isInteger(body.weekNumber) ? body.weekNumber : ((await getYearState(env)).current_week || 0),
            });
            break;
          case 'learning_loop_embodiment_comparison':
            // Runs the Lead QA's cross-embodiment comparison against LIVE D1
            // data. Read-only — no write, no model call. Body: {} (optional
            // { render: true } for the Markdown finding instead of raw JSON).
            result = await runCrossEmbodimentComparison(env);
            if (result.ok) {
              result.generatedAt = new Date().toISOString();
              if (body.render) result = { ...result, rendered: renderComparisonFinding(result) };
            }
            break;
          case 'growth_counts': {
            // Row counts for the insert-only D1 tables, for
            // `scripts/growth-watch.mjs` (audit #19 / KFM-20). Read-only,
            // no model call, no write.
            //
            // It is a TRIGGER rather than a query in the script because the
            // script runs where D1 is not reachable — a GitHub Actions job and
            // the owner's laptop both have the repo and neither has a D1
            // binding. The Worker is the only thing that can count these rows.
            //
            // A table that cannot be counted comes back NULL, not 0: "the
            // office wrote nothing" and "the count failed" are different facts,
            // and a growth ledger that recorded a failed count as zero would
            // show every insert-only table collapsing to empty (KFM-13).
            const counts = {};
            for (const table of ['reports', 'interactions', 'cases', 'suggestions']) {
              try {
                const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
                counts[table] = typeof row?.n === 'number' ? row.n : null;
              } catch (e) {
                counts[table] = null;
                counts[`${table}_error`] = String(e?.message || e).slice(0, 160);
              }
            }
            result = { ok: true, counts, note: 'A null count means the table could not be read, never that it is empty.' };
            break;
          }
          case 'judge_sampler_toggle':
            // OB-081's kill switch (workers/judge-sampler.js
            // judgeSamplerEnabled()). Body: { enabled: true|false }. While off
            // — the shipped default — no answer is ever sent to the judgment
            // lane and no quality_judgements row is written; the cheap score is
            // computed exactly as before either way.
            result = await updateSimulationState(env, { judge_sampler_enabled: !!body.enabled });
            break;
          case 'judge_calibration': {
            // **The output of OB-081.** Reads every quality_judgements row and
            // reports whether the cheap length proxy correlates with a real
            // evaluation at all. Read-only — no model call, no write.
            // Body: {} (optional { render: true } for the Markdown finding).
            const calib = await runCalibration(env);
            result = body.render && calib.ok
              ? { ...calib, rendered: renderCalibrationReport(calib, { date: new Date().toISOString().slice(0, 10) }) }
              : calib;
            break;
          }
          case 'judge_test': {
            // ONE supervised judgment-lane call with the routing gate bypassed,
            // the same shape `routing_test` and `guide_block` use. Body:
            // { question, answer }. Writes NOTHING — this is for reading the
            // judge's actual output before trusting a correlation built on it.
            if (!body.question || !body.answer) {
              result = { ok: false, reason: 'judge_test needs { question, answer }' };
              break;
            }
            const built = buildJudgePrompt({ question: body.question, answer: body.answer });
            const routed = await routeTaskTypeCall(env, JUDGE_LANE, {
              bypassGate: true,
              prompt: built.prompt,
              systemPrompt: built.systemPrompt,
              maxTokens: JUDGE_MAX_TOKENS,
              agentId: 8,
            });
            result = {
              ok: !!routed?.ok,
              truncatedInput: built.truncated,
              provider: routed?.provider || null,
              attempts: routed?.attempts || [],
              raw: routed?.result?.text ?? null,
              parsed: parseJudgeVerdict(String(routed?.result?.text ?? '')),
            };
            break;
          }
          case 'office_context_toggle':
            // Office-context kill switch (workers/office-context.js
            // officeContextEnabled()): flips SIM_KV simulation-state
            // `office_context_enabled` without a redeploy. Body:
            // { enabled: true|false }. While off — or absent, the shipped
            // default — getOfficeContext() returns
            // { text: null, reason: 'office_context_disabled' } at all four
            // injection sites and no GitHub call is made.
            //
            // ADDED 2026-08-08, and the reason it was added is worth keeping.
            // The flag shipped 2026-08-07 on the updateSimulationState()
            // allow-list but WITHOUT this case, so the only way to set it was
            // `POST /api/simulation` — which sits outside the
            // `/api/agents/*` admin-token check. The three sibling flags
            // (guides/routing/architect_liaison) all have a toggle case, and
            // that is not decoration: the toggle cases are the AUTHENTICATED
            // path. A production flag whose only operational route is an
            // unauthenticated endpoint is the gap, not the missing symmetry.
            result = await updateSimulationState(env, { office_context_enabled: !!body.enabled });
            break;
          case 'office_context_status': {
            // Read-back for the supervised test, and the answer to the
            // question the owner actually has: not "is the flag on" but
            // "is the flag on AND is there content behind it". Those differ —
            // a missing BACKOFFICE_REPO_TOKEN, a renamed board file or a
            // changed heading format all yield flag-ON-input-EMPTY, which
            // renders as a report built on nothing rather than as an error.
            //
            // Makes no model calls and writes no report row. It is NOT
            // side-effect-free: with the flag on it calls getOfficeSnapshot()
            // with allowFetch, which costs two GitHub Contents API reads and
            // REFRESHES the cached snapshot in SIM_KV. That is deliberate —
            // a status probe that reads a stale cache cannot tell you whether
            // the fetch path still works.
            const flagOn = await officeContextEnabled(env);
            if (!flagOn) {
              result = { officeContextEnabled: false, note: 'flag is off — no fetch attempted, all four injection sites return text:null' };
              break;
            }
            const snapshot = await getOfficeSnapshot(env, { allowFetch: true });
            const built = await getOfficeContext(env, { shape: 'report', snapshot });
            result = {
              officeContextEnabled: true,
              backofficeTokenPresent: !!env.BACKOFFICE_REPO_TOKEN,
              fetched_at: snapshot?.fetched_at ?? null,
              errors: snapshot?.errors ?? ['no snapshot returned at all'],
              board: snapshot?.board
                ? { counts: snapshot.board.counts, malformed: snapshot.board.malformed ?? [] }
                : null,
              // The deliverable-lifecycle digest (2026-08-10). Reported here
              // for the same reason every other source is: a status probe that
              // cannot show a source cannot tell you whether that source is
              // reaching the office, and a new source invisible to the one
              // endpoint that exists to see sources is §7.2 arriving with the
              // feature meant to be watched. ABSENT and EMPTY are kept apart —
              // `null` means the digest could not be read; `records: 0` means
              // nothing is in the review loop, which is a real measurement.
              lifecycle: snapshot?.lifecycle
                ? {
                    records: snapshot.lifecycle.records.length,
                    inFlight: snapshot.lifecycle.records.map((r) => `${r.slug} [${r.stage} r${r.round}] owed by ${(r.owed_by || []).join(',') || 'nobody'} · ${r.open_gaps} gaps, ${r.awaiting_vote} awaiting a vote`),
                    malformed: snapshot.lifecycle.malformed ?? [],
                  }
                : null,
              requirements: snapshot?.requirements
                ? {
                    due: snapshot.requirements.due,
                    rows: snapshot.requirements.requirements.length,
                    malformed: snapshot.requirements.malformed ?? [],
                  }
                : null,
              // The office→owner questions channel (2026-08-10). Reported for
              // the same reason the other two are: the owner's question is not
              // "is it wired" but "is it wired AND is there content behind it",
              // and flag-on-input-empty is the state that reads as healthy.
              questions: snapshot?.questions
                ? {
                    counts: snapshot.questions.counts,
                    open: snapshot.questions.questions.filter((q) => q.open).map((q) => q.id),
                    malformed: snapshot.questions.malformed ?? [],
                  }
                : null,
              // The two board fields added 2026-08-10. `dispatched` is what
              // OB-036 was about: the transition existed on the board and no
              // consumer could see it.
              dispatched: snapshot?.board ? snapshot.board.tasks.filter((t) => t.dispatched).map((t) => t.id) : null,
              offered: snapshot?.board ? snapshot.board.tasks.filter((t) => t.offered).map((t) => t.id) : null,
              reportShape: { degraded: built.degraded, reason: built.reason, tokens: built.tokens, dropped: built.dropped },
              meetingShape: (() => {
                const m = buildOfficeContext(snapshot, 'meeting', { projects: officeProjects.projects });
                return { tokens: m.tokens, budget: OFFICE_BUDGETS.meeting, dropped: m.dropped, trimmed: m.trimmed };
              })(),
              // ── THE POLICY (2026-08-10) ───────────────────────────────
              // Reported for the same reason every other source is: a status
              // probe that cannot show a source cannot say whether that source
              // is reaching the office. ABSENT and PRESENT are kept apart —
              // `null` here means the live file could not be read, and the
              // digest is rendering from workers/office-policy.js POLICY_DIGEST
              // without corroboration, which is a real if survivable state.
              policy: snapshot?.policy
                ? {
                    rules: snapshot.policy.rules.length,
                    recheck: snapshot.policy.recheck,
                    provisional: snapshot.policy.provisional,
                    // The drift check, live rather than only in the verifier.
                    codeAgreesWithFile:
                      snapshot.policy.recheck === POLICY_RECHECK_DATE
                      && [...snapshot.policy.provisional].sort().join(',') === [...PROVISIONAL_RULES].sort().join(','),
                    malformed: snapshot.policy.malformed ?? [],
                  }
                : { live: null, note: 'the live policy file was not read this cycle — the digest still renders and still binds, uncorroborated' },
              // ── A11 RANK FILTERING (2026-08-10) ───────────────────────
              // BOTH agent shapes, because the whole point of A11 is that they
              // differ, and a probe that reports one of them cannot show that.
              // Agent 12 is sudo (admin); agent 3 is standard.
              agentShape: (() => {
                const a = buildOfficeContext(snapshot, 'agent', { agentId: 12, clearance: 'sudo', projects: officeProjects.projects });
                return { rank: 'admin', tokens: a.tokens, policyTokens: a.policyTokens, total: a.totalTokens, budget: OFFICE_BUDGETS.agent, dropped: a.dropped, trimmed: a.trimmed };
              })(),
              agentShapeStandard: (() => {
                const a = buildOfficeContext(snapshot, 'agent', { agentId: 3, clearance: 'standard', projects: officeProjects.projects });
                return { rank: 'standard', tokens: a.tokens, policyTokens: a.policyTokens, total: a.totalTokens, budget: OFFICE_BUDGETS.agent_standard, dropped: a.dropped, trimmed: a.trimmed, withheld: a.withheld };
              })(),
            };
            break;
          }
          case 'report_pipeline_toggle':
            // Report-pipeline kill switch (workers/report-pipeline.js
            // reportPipelineEnabled()). Body: { enabled: true|false }.
            //
            // THE TOGGLE CASE SHIPS WITH THE FLAG, and that is the whole
            // lesson of 2026-08-08: `office_context_enabled` shipped on the
            // updateSimulationState() allow-list with NO toggle case, so its
            // only operational route was the UNAUTHENTICATED
            // POST /api/simulation, and the owner spent twenty minutes
            // guessing trigger names to set a boolean. A switch is not
            // shipped until the authenticated way to flip it exists AND is
            // written down — see back-office docs/procedures/
            // SIMULATION-SWITCHES.md.
            result = await updateSimulationState(env, { report_pipeline_enabled: !!body.enabled });
            break;
          case 'report_pipeline_status': {
            // Read-back. Answers the question that matters — not "is the flag
            // on" but "is the flag on and would a report have something to
            // say". Makes NO model call and writes no report row; it does
            // refresh the office-context cache, same as office_context_status.
            const flagOn = await reportPipelineEnabled(env);
            const routingOn = await routingEnabledForReports(env);
            // AD-028 is checked against the LANE TABLE, not against the lane's name:
  // resolveTaskLane() returns the ordered candidates from the live
  // config/model-routing.json, and candidates[0] is the primary that would
  // actually answer. Reading it here is the only reason the pin can fail
  // loudly if someone repoints the lane. Only meaningful with routing on —
  // the routing-off path calls Gemini directly and consults no lane at all.
  const draftLanePrimary = routingOn
    ? (resolveTaskLane(pickDraftLane('english')).candidates?.[0] ?? null)
    : null;
  const plan = planReportProviders({ routingOn, language: 'english', draftLanePrimary });
            let rows = null;
            if (env.DB) {
              const probe = await env.DB.prepare(
                `SELECT report_type, period_label, status, revision_count, drafter_provider, reviewer_provider, updated_at
                   FROM report_pipeline ORDER BY created_at DESC LIMIT 10`
              ).all().catch(() => null);
              rows = probe?.results ?? null;
            }
            result = {
              reportPipelineEnabled: flagOn,
              routingEnabled: routingOn,
              plan: { draft: plan.draft, review: plan.review, geminiRequirementHolds: plan.geminiRequirementHolds, notes: plan.notes },
              recent: rows ?? 'report_pipeline table not present yet (created lazily on first draft)',
            };
            break;
          }
          case 'report_block': {
            // Supervised report-pipeline test: runs ONE report end to end with
            // the gate bypassed — the same function the scheduled path calls.
            // Same shape and same reasoning as `guide_block`: the owner tests
            // the pipeline before enabling the switch, not after, and this is
            // deliberately NOT sent through the per-block scheduled dispatcher,
            // which would also fire the day's other blocks.
            //
            // (That sentence names the dispatcher by description rather than by
            // its function name on purpose. verify-routing.js's "no scheduled
            // path passes bypassGate for routing" check is a TEXT-PROXIMITY
            // proxy — it asserts the two identifiers do not appear within 4,000
            // characters of each other — so a comment mentioning the dispatcher
            // near an unrelated routed call fails it. The check's intent is
            // sound and this code does not violate it; the check's mechanism
            // cannot tell a comment from a call. Recorded rather than worked
            // around silently: a proximity check that a comment can break can
            // also PASS by coincidence of layout, which is this project's own
            // "two mechanisms agreeing by accident" in a verifier.)
            // Body: { report: 'weekly'|'monthly', period?: number }
            if (!REPORT_TYPES.includes(body.report)) {
              return json({ error: 'report_block_requires_report_weekly_or_monthly' }, 400, origin);
            }
            const yearState = await getYearState(env);
            const n = body.period != null
              ? Number(body.period)
              : (body.report === 'monthly' ? (yearState.current_month || 1) : (yearState.current_week || 1));
            const agentRows = [];
            for (const config of agentsConfig.agents) {
              const agent = instantiateAgent(config.id, env);
              await agent.loadState();
              agentRows.push({
                agentId: config.id, name: agent.name,
                weeklyCases: await getWeeklyCasesHandled(env, config.id),
                mood: agent.mood, irritation: agent.irritation,
              });
            }
            const windowDays = body.report === 'monthly' ? 30 : 7;
            // OB-086: the supervised trigger carries the year exactly as the
            // cron path does. bypassGate skips the SWITCH, never the
            // duplicate-publish guard, so a manual re-fire against a published
            // period must still refuse -- including via a legacy label.
            const triggerYear = yearState.stats?.year_number || 1;
            result = await runReportPipeline(env, {
              reportType: body.report,
              periodLabel: periodLabelFor(body.report, n, triggerYear),
              legacyLabels: periodLabelCandidates(body.report, n, triggerYear).slice(1),
              dateStr: todayDateStr(),
              agentRows,
              sinceIso: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString(),
              bypassGate: true,
            });
            break;
          }
          case 'routing_toggle':
            // Task-type routing kill switch (see workers/task-router.js
            // routingEnabled()): flips the SIM_KV simulation-state
            // `routing_enabled` flag without a redeploy. Body:
            // { enabled: true|false }. While off (or absent — the shipped
            // default) every routed call is refused with `routing_disabled`,
            // no provider is contacted, and every pre-existing caller keeps
            // the provider it uses today.
            result = await updateSimulationState(env, { routing_enabled: !!body.enabled });
            break;
          case 'subrequest_probe': {
            // OB-074: MEASURE the invocation ceiling instead of quoting it —
            // in the Worker and inside a Durable Object, with the same loop
            // against the same D1 binding, so the difference is the headroom.
            //
            // The 50-vs-"roughly 150" figures the task was framed with came
            // from documentation. Cloudflare's limits page states no
            // Durable-Object subrequest number at all (checked 2026-08-16),
            // and this project has been burned three times by a documented
            // platform fact that had stopped being true. Read-only
            // (`SELECT 1`), bounded, admin-gated.
            const max = Number.isFinite(body.max) ? body.max : 400;
            const kinds = Array.isArray(body.kinds) ? body.kinds : ['d1', 'kv', 'do'];
            const workerSide = {};
            for (const k of kinds) workerSide[k] = await probeSubrequestCeiling(env, max, k);
            const doSide = {};
            for (const k of kinds) {
              try {
                const stub = env.AGENT_STATE.get(env.AGENT_STATE.idFromName(`subrequest-probe-${k}`));
                doSide[k] = await (await stub.fetch('https://agent-state/subrequest-probe', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ max, kind: k }),
                })).json();
              } catch (err) {
                doSide[k] = { where: 'durable_object', kind: k, error: String(err?.message || err) };
              }
            }
            result = {
              worker: workerSide,
              durableObject: doSide,
              note: 'completed = cheap D1 subrequests that landed before the runtime refused. '
                + 'The Worker figure includes the few subrequests this request already spent.',
            };
            break;
          }
          case 'routing_status':
            // Read-back for the supervised test: the flag, the lane table as
            // RESOLVED (not as written), and today's per-provider counters.
            // Makes no model calls.
            result = {
              ...(await getRoutingQuotaStatus(env)),
              lanes: Object.fromEntries(
                Object.keys(MODEL_ROUTING.lanes).map((lane) => [lane, resolveTaskLane(lane)])
              ),
            };
            break;
          case 'routing_test': {
            // ONE narrow supervised call down ONE lane, with the gate
            // bypassed — the same shape as the `guide_block` trigger, and
            // for the same reason: the owner tests a lane before enabling
            // the switch, not after. This is the ONLY path that bypasses
            // routingEnabled(), it runs one lane at a time, and the
            // scheduled path never reaches it.
            // Body: { lane: 'judgment'|..., prompt?, texts?, personas? }
            if (!body.lane) {
              return json({ error: 'routing_test_requires_lane' }, 400, origin);
            }
            result = await routeTaskTypeCall(env, body.lane, {
              bypassGate: true,
              prompt: body.prompt || 'Reply with the single word: ok',
              systemPrompt: body.systemPrompt,
              maxTokens: body.maxTokens || 64,
              texts: body.texts,
              personas: body.personas,
              // The image lane is a ROLES lane: `role` selects draft or polish
              // and each resolves to exactly one provider. Absent uses the
              // lane's default_role. Passed through for every lane rather than
              // special-cased, because resolveLane() ignores it on the others.
              role: body.role || null,
              inputImages: body.inputImages,
              instruction: body.instruction,
              imageModel: body.imageModel,
              steps: body.steps,
              eventId: body.eventId || `routing_test:${body.lane}`,
              geminiModel: simulationConfig.GEMINI?.model,
              geminiEndpoint: simulationConfig.GEMINI?.api_endpoint,
              agentId: 'routing-test',
            });
            // An image result carries megabytes of base64. Returning it through
            // this endpoint would make a supervised test's own response the
            // largest thing the Worker ever sends, and a truncated JSON body is
            // an unreadable test result. Summarised, with the bytes counted so
            // "did it actually draw something" is still answerable.
            if (result?.result?.base64) {
              result = {
                ...result,
                result: { ...result.result, base64: `[${result.result.bytes} bytes elided — use {"type":"design_asset"} to write it to a repo]` },
              };
            }
            break;
          }
          /*
           * ── THE MODEL-RETIREMENT CHECK (2026-08-23, Session 14 ITEM C) ────
           *
           * `image_catalog` above asks AD-030 check 1 of the two IMAGE models.
           * This asks it of EVERY configured model identifier in the estate, on
           * a weekly schedule, because the five retirements this project has
           * survived were each found by something breaking rather than by
           * anything looking.
           *
           * NOT gated behind a kill switch and not admin-tier-restricted beyond
           * the admin token every trigger already needs: it makes no generation
           * call, spends no budget, and reads one listing endpoint per provider.
           * A check that can be switched off is a check that will be found off.
           *
           * `probeModels` is the RED PROOF, and it is a first-class part of the
           * endpoint rather than a test hook bolted on. Pass
           * `[{"provider":"groq","model":"not-a-real-model"}]` and the run goes
           * red on a value that was deliberately injected — which is how anyone
           * confirms the check still works without waiting for a real
           * retirement. Probe entries are marked `probe:true` everywhere they
           * are rendered so a probe can never be mistaken for a config finding.
           * The estate has a documented case of a health check that was green
           * partly because failure was being recorded as activity; a checker
           * nobody has watched fail is not known to work.
           */
          case 'model_catalog': {
            const probes = Array.isArray(body.probeModels) ? body.probeModels : [];
            const targets = [
              ...configuredModelTargets(env),
              ...probes
                .filter((p) => p && p.provider && p.model)
                .map((p) => ({ provider: String(p.provider), model: String(p.model), probe: true, configuredIn: ['NOT CONFIGURED ANYWHERE — injected by this call to prove the check can go red'] })),
            ];
            const report = await checkModelCatalogs({ targets, env });
            result = {
              ...report,
              // The catalogues themselves are large and are the least useful
              // part of the answer; the SIZE is what tells you the listing was
              // real. Full lists stay available per provider for a manual read.
              providers: Object.fromEntries(Object.entries(report.providers).map(([k, v]) => [k, { ...v, catalog: v.catalog ? `[${v.catalog.length} ids elided — pass {"verbose":true} to see them]` : null }])),
              summary: renderCatalogSummary(report),
              notCheckable: NOT_CHECKABLE_PROVIDERS,
              probesInjected: probes.length,
            };
            if (body.verbose) result.providers = report.providers;
            break;
          }
          case 'image_catalog': {
            // AD-030 CHECK 1, AS AN ENDPOINT. "Does the model ID still exist in
            // the provider's live catalog?" is the first of four checks that must
            // be run and REPORTED before an auth failure may even be attributed
            // to a key — and this project has been burned four times by a model
            // retired out from under it. Run from inside the Worker, with the
            // GEMINI_API_KEY the Worker actually holds, because a local test with
            // a key from a .env tests that key and says nothing about this one.
            //
            // Makes NO generation call and costs no image quota. The Cloudflare
            // side has no equivalent endpoint here: its catalog is read with
            // `npx wrangler ai models` against the same account, which is a real
            // read-back and is where the draft model's ID came from.
            result = {
              gemini: await listImageCapableModels({ apiKey: env.GEMINI_API_KEY, agentId: 'image-catalog' }),
              cloudflareDraftModel: MODEL_ROUTING.lanes.image?.roles?.draft
                ? tokenEconomy.providers?.cloudflare_images?.default_model || null
                : null,
              _how_to_read_this: 'defaultModelPresent:false means the configured polish model is NOT in the live catalog — a config fix, NOT a key problem. Read the full body before attributing anything to a credential (AD-030).',
            };
            break;
          }
          case 'image_status':
            // Read-back for the image lane: both roles as RESOLVED, the two
            // providers' quota state, and the fact that neither has an allowance
            // of its own. No model calls.
            result = {
              image: resolveImageRoles(),
              quota: await getRoutingQuotaStatus(env),
              sharedAllowances: {
                'cloudflare-images': tokenEconomy.providers?.cloudflare_images?.shared_allowance_with || null,
                'gemini-images': tokenEconomy.providers?.gemini_images?.shared_allowance_with || null,
                _why: 'Neither image provider has an allowance of its own. Cloudflare images spend the same account Neurons as the classification lane; Gemini images spend the same key as Hebrew composition, report drafting and the Notebook-X asks. Heavy Designer output can degrade four chat lanes.',
              },
            };
            break;
          case 'design_asset': {
            // THE END-TO-END PROOF, and the Designer's only working path today.
            // Generates one asset and commits it to back-office WITH the
            // provenance note the bible requires, through the governed write
            // path. Body: { prompt, slug, role?, instruction?, inputImages?,
            //               imageModel?, steps?, commit?, note? }
            //
            // `commit: false` runs the generation and writes nothing, for a look
            // before anything lands in a repo.
            if (!body.prompt && !body.instruction) {
              return json({ error: 'design_asset_requires_prompt_or_instruction' }, 400, origin);
            }
            result = await runDesignerAsset(env, {
              prompt: body.prompt,
              slug: body.slug,
              role: body.role || null,
              instruction: body.instruction || null,
              inputImages: body.inputImages || null,
              imageModel: body.imageModel || null,
              steps: body.steps ?? null,
              commit: body.commit !== false,
              note: body.note || null,
              // Optional second pass on the DRAFT'S OWN BYTES — the only thing
              // that proves the role split is real rather than a naming
              // convention. Both files are kept; a failed polish leaves the
              // draft standing.
              polishInstruction: body.polishInstruction || null,
            });
            if (result?.provenance) result.provenance = `[${result.provenance.length} chars — written to ${result.provenancePath}]`;
            break;
          }
          case 'front_publish': {
            // THE PUBLISHING GATE (OB-014, 2026-08-16). Reads a curated batch
            // manifest from back-office, runs every criterion, and publishes to
            // the public repo through commitFileToRepo() — which runs A10's
            // mandatory scan — or refuses and records why.
            //
            // Body: { batchId, dryRun? }
            //
            // NO KILL SWITCH, deliberately — see front-gate.js's header. There
            // is nothing to disable: this endpoint is the only caller, and not
            // calling it is the off state.
            if (!body.batchId) return json({ error: 'front_publish_requires_batchId' }, 400, origin);
            result = await runFrontPublish(env, { batchId: body.batchId, dryRun: body.dryRun === true });
            // The rendered record is long and is already committed (or returned
            // in a dry run for reading); truncate it in the response so a
            // refusal's REASONS stay the readable part.
            if (result?.record && body.fullRecord !== true) {
              result.record = `[${result.record.length} chars — ${result.recordPath ? `written to ${result.recordPath}` : 'dry run, pass fullRecord:true to read it'}]`;
            }
            break;
          }
          case 'warehouse_write': {
            // THE MISSING CALL SITE, closed 2026-08-11. WAREHOUSE_REPO_NAME has
            // been imported into this file since repo-write.js was split out
            // (2026-08-07) but no call site ever passed it to commitFileToRepo()
            // — every one of the ~30 existing call sites targets REPO_NAME or
            // BACKOFFICE_REPO_NAME. So `code-write-warehouse` in
            // CAPABILITY-TOOLBOX.md stayed the "deliberately locked twice"
            // capability (code rule + absent token) right up to the day
            // WAREHOUSE_REPO_TOKEN was set — and past it, silently, because a
            // resolved permission with no caller is not a working permission.
            // This is that caller: narrow, supervised, mirroring design_asset's
            // shape. Agent 10 (the Architect) is the only agent
            // capability-manifest.json lists against this capability, and the
            // Architect is dormant except for owner-directed sessions — this
            // endpoint is for exactly that, not for autonomous cron dispatch.
            // Body: { path, content, message, explicitCodeTask? }
            if (!body.path || typeof body.content !== 'string' || !body.message) {
              return json({ error: 'warehouse_write_requires_path_content_message' }, 400, origin);
            }
            result = await commitFileToRepo(env, WAREHOUSE_REPO_NAME, body.path, body.content, body.message, {
              explicitCodeTask: body.explicitCodeTask !== false,
            });
            break;
          }
          case 'localization_test': {
            // Supervised end-to-end proof for the front-localization lane
            // (OB-013's UNSUPPLIED capability, closed 2026-08-11). Same
            // shape as `routing_test`/`guide_block`: one real call, gate
            // bypassed at the routeTask() level only insofar as the caller
            // supplies real content — routing_enabled itself still gates it,
            // matching every other production-shaped lane (front_localization
            // has no bypass of its own, deliberately, since it is meant to
            // become a real production caller later, not stay a supervised-only
            // path like routing_test's raw lane probe).
            // Body: { hebrewText, agentName?, sourceKind? }
            if (!body.hebrewText) {
              return json({ error: 'localization_test_requires_hebrewText' }, 400, origin);
            }
            result = await localizeForFront(env, body.hebrewText, {
              agentName: body.agentName || null,
              sourceKind: body.sourceKind || null,
              eventId: `localization_test:${Date.now()}`,
            });
            break;
          }
          case 'guide_block': {
            // Supervised Guides test: runs ONE guide handler directly — the
            // SAME functions the cron path dispatches — with the
            // guides_enabled gate bypassed. Deliberately NOT routed through
            // runScheduledBlock(): a {"type":"block"} trigger at 16:00/16:30
            // would also fire the report/standup/spare_time blocks and (at
            // the day's last block) finalize + clear the LIVE day cycle.
            // Guide state crosses invocations via D1 (guide_pipeline), so a
            // draft trigger followed by a review trigger still exercises the
            // real cross-tick handoff. Body: { block: 'draft'|'review'|'verify' }.
            const guideHandlers = {
              draft: () => processGuideDraftBlock(env, todayDateStr(), { bypassGate: true }),
              review: () => processGuideReviewBlock(env, todayDateStr(), { bypassGate: true }),
              verify: () => processGuideVerifyBlock(env, { bypassGate: true }),
            };
            if (!guideHandlers[body.block]) {
              return json({ error: 'guide_block_requires_block_draft_review_or_verify' }, 400, origin);
            }
            result = await guideHandlers[body.block]();
            break;
          }
          case 'capability_audit_findings': {
            // Phase 5 (2026-08-11): the capability audit becomes RECURRING
            // WEEKLY work the Cyber Expert (agent 13) owns, not a one-off run.
            // The audit itself needs the filesystem to answer "does this code
            // path exist" (scripts/capability-audit.mjs's own header — a
            // Worker has none), so it cannot run inside this Worker. What CAN
            // run here is the write: a new GitHub Actions workflow
            // (.github/workflows/weekly-capability-audit.yml) runs the real
            // audit weekly, shapes non-SUPPLIED capabilities into board-task
            // items via capability-audit.js's auditFindingsToBoardItems()
            // (plain-node loadable, same file the CI script imports), and
            // POSTs them here. This endpoint does exactly what a meeting's
            // SIXTH BRANCH already does with action_items — normalize, then
            // write to the board inbox — reusing that mechanism rather than
            // building a second one. Gated on the SAME switch meeting action
            // items use: a capability-audit board write is the identical
            // write path, so it pauses with it.
            // Body: { items: [...] } — already shaped by
            // auditFindingsToBoardItems(), NOT raw capability-audit output.
            if (!(await actionItemsToBoardEnabled(env))) {
              result = { skipped: true, reason: 'action_items_to_board_disabled' };
              break;
            }
            if (!Array.isArray(body.items)) {
              return json({ error: 'capability_audit_findings_requires_items_array' }, 400, origin);
            }
            const rosterIds = agentsConfig.agents.map((a) => a.id);
            const { items, dropped } = normalizeActionItems(body.items, { rosterIds });
            for (const d of dropped) console.warn(`[capability-audit] finding DROPPED: ${d.reason}`);
            result = (items.length || dropped.length)
              ? await writeActionItemsToBoard(env, {
                meetingType: 'capability_audit', items, dropped,
                sourceLabel: 'the weekly capability audit (Agent 13)',
              })
              : { committed: false, skipped: true, reason: 'no_findings' };
            break;
          }
          case 'block':
            // Run ONE daily-schedule block through the REAL scheduled path
            // (runScheduledBlock: KV cycle persistence, per-block dispatch)
            // without waiting for cron — supervised fix verification. Body:
            // { israelTime: "HH:MM", dayOfWeek: 1-7 }. Same no-op semantics
            // as a cron tick if no block exists at that time/day.
            if (!body.israelTime || !body.dayOfWeek) {
              return json({ error: 'block_requires_israelTime_and_dayOfWeek' }, 400, origin);
            }
            result = await runScheduledBlock(env, body.israelTime, Number(body.dayOfWeek));
            break;
          default:
            return json({ error: 'invalid_trigger_type' }, 400, origin);
        }
        // `worker_version` on EVERY trigger response, not just the report ones.
        // A supervised test that cannot say which bundle answered it is a test
        // of an unknown thing — and the 2026-08-09 stale-bundle run looked
        // exactly like a successful one from here. Costs nothing: the value is
        // already in the environment.
        return json({ ok: true, type: body.type, worker_version: workerVersion(env), result }, 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/api/simulation') {
        /*
         * ══════════════════════════════════════════════════════════════════
         * CLOSED 2026-08-16 (OB-047). The WRITE half was closed 2026-08-10;
         * this is the read half, and it was the last unauthenticated route
         * into this Worker.
         * ══════════════════════════════════════════════════════════════════
         *
         * WHAT IT LEAKED. `getSimulationState()` returns every kill switch the
         * office has. OFFICE-POLICY Part C carried this as "eight switches
         * reachable without a token"; measured against the live endpoint on
         * 2026-08-16 it is **NINE** — `learning_loop_enabled` is the ninth,
         * and it is the switch that gates writes to agents' active context
         * (A2's red line) and the one the newly-wired QA instruments ride on.
         * The count in the policy is stale and is reported for the owner to
         * correct; this handler is not the place to argue with it.
         *
         * WHY THE PREVIOUS REASONING NO LONGER HOLDS. The 2026-08-10 note
         * below kept GET open on the grounds that it is "a READ used by
         * data-center's admin tab and by every deploy-verification step in
         * DEPLOY.md and TOKEN-BUDGET.md". The first half is FALSE and was
         * checked rather than assumed: `data-center/index.html` calls exactly
         * one endpoint, `/api/chat`, which is its own API and not this Worker;
         * `dashboard/dashboard.js` calls only `/api/agents/{status,reports,
         * sessions,suggestions}`, all four already behind this same token.
         * Nothing in any of the three repos reads `GET /api/simulation`.
         *
         * That is the load-bearing lesson: the justification for leaving a
         * hole open was a claim about a consumer, the consumer was never
         * re-checked, and the claim outlived it by an unknown number of weeks.
         * A documented dependency is a claim about another repo and goes stale
         * exactly like a documented switch state does (KFM-21).
         *
         * THE SECOND HALF IS TRUE and is handled rather than dismissed: the
         * deploy-verification steps do use this route. They now need a token,
         * and the authenticated equivalent already exists and predates this
         * change — `POST /api/agents/trigger {"type":"simulation_state"}`,
         * which returns the same object plus `worker_version`. DEPLOY.md and
         * TOKEN-BUDGET.md are updated to point at it.
         *
         * Same idiom as the POST below and as the /api/agents/* gate, so this
         * file still has ONE authentication shape rather than three.
         */
        const readToken = request.headers.get('X-Admin-Token') || '';
        if (!env.ADMIN_TOKEN || readToken !== env.ADMIN_TOKEN) {
          return json({ error: 'unauthorized' }, 401, origin);
        }
        return json(await getSimulationState(env), 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/simulation') {
        /*
         * ══════════════════════════════════════════════════════════════════
         * CLOSED 2026-08-10. Flagged 2026-07-18, open for 23 days.
         * ══════════════════════════════════════════════════════════════════
         *
         * This handler took a JSON body straight into updateSimulationState()
         * with NO TOKEN CHECK. Its allow-list is ten keys and includes
         * `paused` (stop the office), `guides_enabled`,
         * `improvement_loop_enabled`, `office_context_enabled`,
         * `report_pipeline_enabled`, `routing_enabled`,
         * `architect_liaison_enabled` and `action_items_to_board_enabled` —
         * every write-enabling switch the office has. The path is
         * `/api/simulation`, not `/api/agents/*`, so the token gate at the top
         * of fetch() never saw it. OFFICE-POLICY.md Part C: *"must be closed
         * before the public front opens."*
         *
         * The check is written out here rather than by widening the prefix test
         * above to `/api/`. Widening would silently close `GET /api/simulation`
         * too, which is a READ used by data-center's admin tab and by every
         * deploy-verification step in DEPLOY.md and TOKEN-BUDGET.md — a
         * behaviour change nobody asked for, arriving as a side effect of a
         * security fix. GET stays open, deliberately and narrowly: it exposes
         * switch STATES, which is a real if minor disclosure, and it is boarded
         * as OB-047 rather than closed in the same breath as the write path.
         *
         * Identical shape to the /api/agents/* gate — same header, same
         * comparison, same 401 body — so there is one authentication idiom in
         * this file and not two that must be kept in agreement.
         */
        const simToken = request.headers.get('X-Admin-Token') || '';
        if (!env.ADMIN_TOKEN || simToken !== env.ADMIN_TOKEN) {
          return json({ error: 'unauthorized' }, 401, origin);
        }
        const body = await request.json();
        return json(await updateSimulationState(env, body), 200, origin);
      }
    } catch (err) {
      return json({ error: 'general', message: err.message }, 500, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  },
};
