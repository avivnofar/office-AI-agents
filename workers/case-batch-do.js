/**
 * THE CASE ENGINE INSIDE A DURABLE OBJECT — SHIPPED OFF (OB-074, 2026-08-16).
 *
 * ── WHY A DURABLE OBJECT AT ALL, AND WHAT IT ACTUALLY BUYS ─────────────────
 *
 * ⚠️ **OB-074's premise did not survive measurement, and this file exists to
 * say so.** Measured on the live Worker, 2026-08-16, via the
 * `subrequest_probe` trigger (`state-manager.js probeSubrequestCeiling()`):
 *
 *   external fetch()   Worker: 50, then "Too many subrequests"
 *                      Durable Object: **50, then the same error**
 *   DO stub calls      Worker: 200, then "Too many API requests"
 *   D1 / KV            >=400 either side, no refusal — not the constraint
 *
 * **A Durable Object does NOT get more subrequests.** The "roughly 150" the
 * task was framed with is wrong. Moving one batch inside one DO call moves
 * the same 50-call ceiling somewhere else and buys nothing at all.
 *
 * What a Durable Object does give is a FRESH 50 PER INVOCATION. So capacity,
 * if it is ever needed, comes from calling the DO many times — the Worker
 * allows 200 such calls, which is 200 x 50 outbound in principle — and that
 * is a fan-out design, not this one. THIS module is the single-call shape,
 * and on the measurement it should not be switched on, because it would cost
 * a round trip to buy zero headroom. That recommendation is the honest output
 * of Phase 3, and the switch is left off for the owner to decide.
 *
 * ── BUT THE PREMISE CHANGED, AND THAT IS RECORDED RATHER THAN GLOSSED ──────
 *
 * OB-074 assumed the office needed more capacity. It did not. The measured
 * cause of every `case_batch` failure was accounting, not capacity: the
 * budget nobody kept, the day cycle that was never persisted after an
 * overflow, and 30-80 Workers-AI calls per tick spent on a field nothing
 * reads. With those fixed the Worker path completes a full 200-case day at a
 * measured peak of 38 outbound calls against its own 50 — verified on a live
 * tick, not in a harness.
 *
 * This path therefore exists for headroom the office does not currently need.
 * That is exactly why it ships OFF and why the owner, not this session,
 * decides whether to turn it on.
 *
 * ── HOW THE CIRCULAR IMPORT IS AVOIDED ─────────────────────────────────────
 *
 * The obvious shape — `state-manager.js` imports the case runner from
 * `agent-runner.js` — is a cycle, because `agent-runner.js` already imports
 * `AgentStateDO` from `state-manager.js`. ESM tolerates that only by accident
 * of evaluation order, and this project has enough load-bearing accidents.
 *
 * Instead the dependency is INVERTED: this module owns a slot, and
 * `agent-runner.js` fills it at module load with the real `processCaseBatch`.
 * Both live in the same bundle and the same isolate, so by the time any
 * request reaches the Durable Object the slot is filled. This module imports
 * nothing, so `scripts/verify-subrequest-budget.js` can load and call it.
 */

/** Filled by agent-runner.js at module load. See the header for why. */
let caseBatchRunner = null;

/** Called once, at bundle load, by agent-runner.js. */
export function setCaseBatchRunner(fn) {
  if (typeof fn === 'function') caseBatchRunner = fn;
}

export function caseBatchRunnerRegistered() {
  return typeof caseBatchRunner === 'function';
}

/** The SIM_KV switch. Absent or false — the shipped default — means OFF. */
export const CASE_DO_FLAG = 'case_do_enabled';

/**
 * Is the Durable Object case path enabled?
 *
 * Takes the already-loaded simulation state rather than reading KV again —
 * `runScheduledBlock()` has it, and a second read would be one more
 * subrequest for a value it is holding. Absent key => false, always.
 */
export function caseDoEnabled(sim) {
  return sim?.[CASE_DO_FLAG] === true;
}

/** The Durable Object instance every case batch would share. One runner. */
export const CASE_DO_INSTANCE = 'case-batch-runner';
export const CASE_DO_PATH = '/run-case-batch';

/**
 * Runs one batch of cases INSIDE the Durable Object.
 *
 * Deliberately narrow: it takes the cases the Worker already selected and
 * returns the same `{processed, deferred, processedIds, stoppedForBudget}`
 * shape `processCaseBatch()` returns, so the Worker's cursor bookkeeping —
 * which is what makes deferred distinguishable from done — is unchanged and
 * stays in one place. Moving the cursor in here too would give the office two
 * writers for the same fact.
 *
 * `processedIds` is a Set on the Worker side and cannot cross a fetch
 * boundary, so it is serialized as an array and rebuilt by the caller.
 */
export async function runCaseBatchInDO(env, payload) {
  if (!caseBatchRunner) {
    return { processed: 0, deferred: (payload?.cases || []).length, processedIds: [], stoppedForBudget: false, error: 'case_batch_runner_not_registered' };
  }
  const cases = Array.isArray(payload?.cases) ? payload.cases : [];
  if (!cases.length) return { processed: 0, deferred: 0, processedIds: [], stoppedForBudget: false };

  const { createTickBudget, meterEnv, meterGlobalFetch, LANE_CASES, DO_FETCH_CEILING } =
    await import('./subrequest-budget.js');

  // The SAME ceiling as the Worker — measured, not assumed. A budget here that
  // believed in extra headroom would overflow inside the Durable Object and
  // reproduce the original defect one layer down.
  const budget = createTickBudget({
    ceiling: DO_FETCH_CEILING,
    casesDue: true,
  });
  budget.setLane(LANE_CASES);

  const metered = meterEnv(env, (n) => budget.spendMetered(n));
  const restoreFetch = meterGlobalFetch((n) => budget.spendMetered(n));
  try {
    const agentInstances = new Map();
    const agentStats = new Map();
    const out = await caseBatchRunner(metered, cases, agentInstances, agentStats, budget);
    return {
      processed: out.processed,
      deferred: out.deferred,
      processedIds: [...(out.processedIds || [])],
      stoppedForBudget: out.stoppedForBudget,
      budget: budget.snapshot(),
      agentStats: Object.fromEntries(agentStats),
    };
  } finally {
    restoreFetch();
  }
}
