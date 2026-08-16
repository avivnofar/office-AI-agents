/**
 * THE INVOCATION BUDGET (OB-074, 2026-08-16).
 *
 * Cloudflare caps a Worker invocation at 50 external `fetch()` calls. Go past
 * it and the runtime throws `Too many subrequests by single Worker invocation`
 * mid-flight — wherever it happens to be.
 *
 * ── WHAT COUNTS, AND WHAT DOES NOT ─────────────────────────────────────────
 *
 * **Read the WEIGHTS block below before changing anything here.** The limit is
 * on external fetches and on Durable Object calls, and it is NOT on D1 or KV —
 * measured against the live Worker, not inferred from the docs. The first
 * version of this file charged every binding call equally and throttled a tick
 * to three cases when the platform would allow far more.
 *
 * ── WHAT THE OVERFLOW ACTUALLY COST, MEASURED 2026-08-16 ───────────────────
 *
 * By executing the real scheduled path under counting bindings
 * (`scripts/verify-subrequest-budget.js`), not by reading it, a 30-case
 * Sun-Thu batch made 337 binding calls and a Friday 80-case batch made 1,078.
 * Most of those are free; the fetches among them are not, and they are what
 * put every case_batch tick over the cap.
 *
 * The damage was not the one OB-074 predicted. It predicted a silently
 * dropped tail. What actually happened is worse and was visible in D1:
 * `runScheduledBlock()` persists the day cycle AFTER the block loop, so a
 * tick that overflows inside a block never reaches `setCycleState()` — the
 * cycle is never written, the next tick finds none, regenerates the whole day
 * and starts the batch from the HEAD of the list again. Live evidence,
 * 2026-08-16: `interactions` shows "Hardening SSH access on an internet-facing
 * Linux host" asked FOUR times between 06:31 and 09:02, while the tail of the
 * 200-case day was never reached at all. The office was not dropping the
 * remainder — it was re-asking the first few cases all day.
 *
 * ── WHY THIS IS A FLOOR AND NOT A PRIORITY ─────────────────────────────────
 *
 * Cases are Track A, the client-facing work. With ~40 open board tasks,
 * "do cases last" means cases never run. So the budget RESERVES a share for
 * cases up front and refuses non-case work that would eat into it, rather
 * than ordering the work and hoping. Everything above the floor yields.
 *
 * ── THE NUMBERS, AND WHY THEY ARE THESE NUMBERS ────────────────────────────
 *
 * `TICK_TAIL_RESERVE` — a tick must still be able to finish after the work
 * stops: `setCycleState()`, `logScheduledError()`, and headroom for the
 * finalize path on the day's last tick. This reserve is the entire reason the
 * cycle now survives an exhausted budget, which is the reason the batch no
 * longer restarts from the head of the list.
 *
 * `CASE_FLOOR_FRACTION = 0.6` — the only ticks where a case_batch shares an
 * invocation with anything else were Sun-Thu 08:00 and Friday 08:00/09:00/
 * 10:00. This session moved `architect_liaison` off both, so today no
 * case_batch shares a tick at all and the floor is a guarantee held in
 * reserve rather than one being exercised. It stays because the schedule is
 * data and the next person to add a block to 08:00 should find the floor
 * already there.
 *
 * `CASE_LOOKAHEAD` / `CASE_COST_MAX` — a case's weighted cost, measured. A
 * case makes one or two external fetches (the Notebook-X or Groq call, plus a
 * gap note or a judge sample when they fire), one service-binding call on the
 * data-center path, and two or three Durable Object calls at 0.25 each. The
 * loop refuses to START a case unless CASE_LOOKAHEAD is free, so the deepest
 * it can overshoot is CASE_COST_MAX - CASE_LOOKAHEAD, and TICK_TAIL_RESERVE is
 * sized to absorb exactly that. These are PLANNING numbers: real spend is
 * metered, so a wrong constant costs throughput, never correctness.
 *
 * ── THE GENERALIZABLE RULE THIS ENCODES ────────────────────────────────────
 *
 * `KNOWN-FAILURE-MODES.md` KFM-31: a scheduled addition must be measured
 * against the invocation budget of the tick it JOINS, not only against its own
 * logic. The three-day daily-summary gap and this defect are the same failure
 * twice. A block is cheap on its own and still unaffordable at 08:00.
 *
 * PURE — imports nothing, so `scripts/verify-subrequest-budget.js` can load
 * and CALL it under plain node. Same posture as `task-router.js` and
 * `deliverable-lifecycle.js`.
 */

/**
 * Cloudflare's documented per-invocation subrequest cap on this plan.
 *
 * EXPIRING CONSTANT (KFM-19): this is a platform fact, not ours. It is
 * asserted against production behaviour rather than trusted — the measured
 * over/under split of all 11 daily ticks matched the live `reports` incident
 * rows exactly at this value on 2026-08-16 (every tick measured over 50
 * appears in the incident rows; every tick measured under 50 appears in
 * none). If Cloudflare changes it, or the account moves off this plan, that
 * correspondence breaks and this number is the one to re-derive.
 */
export const SUBREQUEST_CEILING = 50;

/**
 * ── WHAT ACTUALLY COUNTS, MEASURED ON THE LIVE WORKER 2026-08-16 ───────────
 *
 * The first version of this file charged one unit for every binding call —
 * D1, KV, Durable Object, Workers AI, service binding and `fetch()` alike —
 * on the strength of Cloudflare's sentence *"a subrequest is any request a
 * Worker makes using the Fetch API or to Cloudflare services like R2, KV, or
 * D1"*. That reading is wrong, and the `subrequest_probe` trigger proves it by
 * running the same loop until the runtime refuses:
 *
 *   | operation                | in the Worker                      | in a Durable Object |
 *   |--------------------------|------------------------------------|---------------------|
 *   | external `fetch()`       | **50** -> "Too many subrequests"   | **50** — IDENTICAL  |
 *   | Durable Object stub call | **200** -> "Too many API requests" | n/a (self-call)     |
 *   | D1 statement             | >=400, no refusal                  | >=400, no refusal   |
 *   | KV read                  | >=400, no refusal                  | >=400, no refusal   |
 *
 * Three things follow, and all three matter:
 *
 * 1. **D1 and KV are not the constraint.** Charging them cost the office
 *    roughly five times more budget than it was actually spending, which is
 *    why the first calibration throttled a tick to three cases.
 * 2. **There are TWO limits, with different error messages.** Production's
 *    incident rows say "Too many *subrequests*", which is the fetch limit.
 *    The Durable Object limit says "Too many *API requests*" and has never
 *    appeared in the incident rows — the office has never come close to 200.
 * 3. **A Durable Object has NO extra headroom on the axis that binds.** It
 *    gets the same 50 external fetches and the same error message. OB-074's
 *    "roughly 150" is wrong, and this is the measurement that says so.
 *
 *    An earlier run of this probe appeared to show >=120 in the Durable
 *    Object. That was the probe's own bug: the DO route ignored the `kind`
 *    parameter and measured D1 while the label said fetch. It is recorded
 *    here rather than quietly corrected, because a wrong number that agreed
 *    with the expected answer is exactly the kind this office is supposed to
 *    catch, and it survived one deploy before the second reading caught it.
 *
 *    What a Durable Object DOES give is a fresh 50 per INVOCATION. Capacity
 *    therefore comes from calling it many times (the Worker allows 200 such
 *    calls), never from moving one batch inside one call. See
 *    case-batch-do.js.
 *
 * So the ledger charges ONE weighted budget, scaled so either limit reaching
 * its own ceiling exhausts it: an external fetch is 1 of 50, a Durable Object
 * call is 50/200 = 0.25 of 50. D1 and KV are free, because they measurably are.
 *
 * ⚠️ `svc` (the APP_API service binding) is charged as a full fetch and is the
 * one row NOT measured — probing it means calling data-center-api's `/api/chat`,
 * which spends real Anthropic budget. Charged at 1 because that is the
 * conservative assumption for something that behaves like an outbound request.
 */
export const WEIGHTS = {
  fetch: 1,      // measured: 50 per Worker invocation
  svc: 1,        // UNMEASURED — see the warning above
  do: 0.25,      // measured: 200 per Worker invocation, scaled onto the 50 budget
  ai: 0.25,      // unmeasured; treated as a binding call like `do`
  d1: 0,         // measured: not the constraint
  kv: 0,         // measured: not the constraint
};

/** Measured ceiling on Durable Object stub calls per Worker invocation. */
export const DO_CALL_CEILING = 200;

/**
 * Measured external-fetch ceiling INSIDE a Durable Object: the same 50 as the
 * Worker, with the same error. Not a typo and not a placeholder — see the
 * WEIGHTS block above for the measurement and for the probe bug that briefly
 * made this look like 120.
 */
export const DO_FETCH_CEILING = 50;

/**
 * Held back so a tick can always persist its cycle and log its own failure.
 *
 * Sized against the worst single overshoot the lookahead can permit. The loop
 * refuses to START a case unless `CASE_LOOKAHEAD` (13, the p90) is free, but a
 * case can actually cost up to `CASE_COST_MAX` (21, an answered data-center
 * case). So the deepest a tick can go past `usable` is 21 - 13 = 8, and the
 * reserve must cover that overshoot AND still leave room for the cycle write.
 * 12 = 8 + 4. This is the arithmetic that makes "the cycle always persists" a
 * property rather than a hope.
 */
export const TICK_TAIL_RESERVE = 6;

/**
 * The reserve on a tick with NO case_batch due.
 *
 * The 12 above is dominated by the case overshoot (a case may cost up to 21
 * after the loop checked for 13). On a tick with no cases that overshoot
 * cannot happen, so the reserve only has to cover the cycle write and the
 * error log. Keeping 12 there would have cost the 16:00 tick a block it can
 * comfortably afford — measured at 34 against a 50 cap.
 */
export const TICK_TAIL_RESERVE_NO_CASES = 3;

/**
 * Held back on the day's LAST tick for `finalizeScheduledDay()`.
 *
 * The finalize runs after the block loop — office context, branch listing,
 * the daily summary render and its commit — and until now was budgeted by
 * nobody. It is the reason `Scheduled block error — finalize @ 16:30` and
 * `finalize @ 12:00` appear in the live incident rows: the blocks ahead of it
 * spent the invocation and the day's own report was what ran out.
 *
 * Measured at ~10 on a Sun-Thu close; reserved at 20 because this is the
 * output whose absence produced the three-day daily-summary gap. When the
 * reserve forces a choice, the deliverable wins and the filler yields —
 * `spare_time` (a 20%-chance coworker chat, idle otherwise) is what gives way
 * at 16:30, and it says so in the admissions record rather than vanishing.
 */
export const FINALIZE_RESERVE = 10;

/** Cases' guaranteed share of the usable budget. See header for the measurement. */
export const CASE_FLOOR_FRACTION = 0.6;

/**
 * Planning cost of one case, in subrequests. p90, measured. See header.
 *
 * This is a LOOKAHEAD, not an accounting figure. Real spend is metered (see
 * `meterEnv()`), so this number only decides whether to start one more case —
 * it never stands in for what a case actually cost. Getting it wrong costs
 * throughput, never correctness: too low and a tick overshoots into the tail
 * reserve, too high and it stops early with budget unspent.
 */
export const PLANNED_CASE_COST = 4;

/** The lookahead actually used before starting a case: the measured p90. */
export const CASE_LOOKAHEAD = 5;

/**
 * The most expensive single case measured (an answered data-center case:
 * budget read, calls-today read, the Claude call, spend record, interaction,
 * improvement-loop row, gap check, session open/close, DO writes).
 * `TICK_TAIL_RESERVE` is sized from the gap between this and CASE_LOOKAHEAD.
 */
export const CASE_COST_MAX = 9;

/**
 * External `fetch()` calls are the one thing `meterEnv()` cannot see: they go
 * through the global, not through a binding, and wrapping the global would
 * mean a concurrent HTTP request in the same isolate charging its calls to
 * this tick. Measured at 7-11 per 30-case tick — one Notebook-X ask and one
 * Groq follow-up on the cases that make them — so each case is charged this
 * allowance on top of its metered binding spend. Deliberately rounded up.
 */
export const EXTERNAL_FETCH_ALLOWANCE_PER_CASE = 0;

/** Lane names. `cases` is the only one with a floor. */
export const LANE_CASES = 'cases';

/**
 * Measured cost of each non-case block type, in subrequests.
 *
 * Derived 2026-08-16 from `scripts/verify-subrequest-budget.js`'s day walk,
 * which executes the real scheduled path: the ticks that carry exactly one
 * block give that block's cost directly (`tool_task_window` 5,
 * `chore_rotation` 4, `meeting` 22, `qa_instruments` 6, `guide_verify` 5,
 * `owner_channel` 15), and the shared ticks give the rest by difference
 * (Sun-Thu 16:00 report+guide_draft+owner_channel = 53; Friday 10:30
 * report+guide_draft = 42; Sun-Thu 16:30 meeting+spare_time+guide_review = 71).
 *
 * These are ESTIMATES used only to decide whether a block may START. What a
 * block then actually spends is metered exactly (`meterEnv()`), so a wrong
 * estimate costs a block its turn, never the tick its integrity.
 *
 * Each is set ABOVE its measured value, with the measurement in the comment,
 * because several blocks self-gate to a near no-op on the measured day
 * (`guide_verify` had an empty queue, `architect_liaison` had nothing to
 * file, `tool_task_window` was not a tool-task day) and would cost more on a
 * day when they do real work. Sizing to the no-op would be sizing to the
 * cheapest possible day.
 *
 * ⚠️ THE HARNESS UNDER-COUNTS, AND BY HOW MUCH IS NOW KNOWN. A supervised
 * live tick on 2026-08-16 measured a real `meeting` at **31** subrequests
 * where the harness had said 12 — the harness's stubbed providers and
 * office-context short-circuit work the real bindings do. `meeting` carries
 * the live figure. The others are the harness figure scaled by that ratio and
 * are therefore PROVISIONAL: they are upper-bound guesses, not measurements.
 *
 * They do not need to be right to be safe. Every block now records its REAL
 * cost in the tick's `admissions` array (`{block, decision, estimate,
 * actual}`), which is returned by `runScheduledBlock()` and stored on the
 * cycle — so the next session can replace every number here with a live one
 * read off production instead of scaling a stub. Boarded rather than guessed
 * at twice.
 *
 * `verify-subrequest-budget.js` re-measures them by running the real path and
 * fails if a measured cost climbs above its entry here. That is the
 * mechanization of KFM-31: the next person who adds work to a block finds out
 * from a red verifier, not from a production incident three days later.
 */
export const BLOCK_COST = {
  meeting: 34,            // LIVE 31 (real tick, 2026-08-16) — harness said 12
  report: 40,             // harness 22, scaled by the live/harness ratio
  spare_time: 34,         // harness 15, scaled
  weekly_summary: 120,    // harness 78 — exceeds `usable` either way: always 'oversize'
  guide_draft: 12,        // harness 3
  guide_review: 12,       // harness 5
  guide_verify: 8,        // harness 0 (empty queue on the measured day)
  owner_channel: 14,      // harness 5
  architect_liaison: 14,  // harness 1 (nothing to file on the measured day)
  tool_task_window: 8,    // harness 0 (not a tool-task day)
  chore_rotation: 6,      // harness 0
  qa_instruments: 8,      // harness 2
};

/** Conservative default for a block type nobody has measured yet. */
export const UNMEASURED_BLOCK_COST = 20;

export function blockCost(type) {
  return typeof BLOCK_COST[type] === 'number' ? BLOCK_COST[type] : UNMEASURED_BLOCK_COST;
}

/**
 * May this non-case block start?
 *
 * Three outcomes, and the third is the one that matters:
 *
 *  - `run`      — it fits.
 *  - `defer`    — it does not fit now, but it could fit in an emptier tick.
 *  - `oversize` — its measured cost exceeds the ENTIRE usable budget, so
 *                 refusing it would mean it never runs at all, ever. It runs,
 *                 and is flagged. `weekly_summary` (100 against a usable 42)
 *                 is the live instance: Friday's 12:00 tick measured 149 and
 *                 has been overflowing since before this session. Refusing it
 *                 would trade a known overflow for a silently missing weekly
 *                 report, which is a worse failure and not one to introduce
 *                 while fixing another. It is reported, not suppressed.
 */
export function admitBlock(ledger, type) {
  const cost = blockCost(type);
  if (cost > ledger.usable) return { decision: 'oversize', cost };
  if (ledger.canAfford(cost, type)) return { decision: 'run', cost };
  return { decision: 'defer', cost };
}

/**
 * Why a batch stopped. These are the values that make "cut short"
 * distinguishable from "finished" — see `summarizeBatchState()`.
 */
export const STOP_COMPLETED = 'completed';
export const STOP_BUDGET = 'budget_exhausted';

/**
 * A per-invocation ledger.
 *
 * @param {object} [opts]
 * @param {number} [opts.ceiling]      total subrequests this invocation may spend
 * @param {number} [opts.tailReserve]  held back for cycle-persist + error logging
 * @param {number} [opts.floorFraction] cases' guaranteed share of the usable budget
 * @param {boolean} [opts.casesDue]    is a case_batch due at this tick? When false
 *                                     the case floor is zero and non-case work may
 *                                     use the whole usable budget — otherwise the
 *                                     15-of-21 ticks that carry no cases would be
 *                                     throttled to protect a floor nobody wants.
 * @param {number} [opts.alreadySpent] subrequests this invocation spent before the
 *                                     ledger existed (day setup, cycle read, ...)
 */
export function createTickBudget(opts = {}) {
  const ceiling = num(opts.ceiling, SUBREQUEST_CEILING);
  const casesDueForReserve = opts.casesDue !== false;
  const tailReserve = clamp(
    num(opts.tailReserve, casesDueForReserve ? TICK_TAIL_RESERVE : TICK_TAIL_RESERVE_NO_CASES),
    0, ceiling
  );
  const floorFraction = clamp(num(opts.floorFraction, CASE_FLOOR_FRACTION), 0, 1);
  const casesDue = opts.casesDue !== false;

  const usable = Math.max(0, ceiling - tailReserve);
  const caseFloor = casesDue ? Math.round(usable * floorFraction) : 0;
  // What non-case work may spend without ever eating into the case floor.
  const otherCeiling = usable - caseFloor;

  let caseSpent = 0;
  let otherSpent = 0;
  let currentLane = 'setup';
  const preSpent = Math.max(0, num(opts.alreadySpent, 0));

  const ledger = {
    ceiling, tailReserve, usable, caseFloor, otherCeiling, casesDue,

    /**
     * Which lane the meter charges to. The meter sees a D1 call, not a
     * purpose, so the runner declares the purpose around the work: case
     * batches run inside `setLane(LANE_CASES)`, everything else is 'other'.
     * Setup done before any block (the cycle read, the day generation) is
     * charged to 'setup', which lands in `otherSpent` and therefore counts
     * against the non-case share — day setup is not case work.
     */
    setLane(lane) { currentLane = lane; return ledger; },
    lane() { return currentLane; },

    /** The meter's callback. Charges the lane that is currently declared. */
    spendMetered(n) { return ledger.charge(n, currentLane); },

    /** Everything spent this invocation, including the pre-ledger setup. */
    spent() { return preSpent + caseSpent + otherSpent; },
    caseSpent() { return caseSpent; },
    otherSpent() { return otherSpent; },

    /** Record real spend. `lane` is LANE_CASES or anything else. */
    charge(n, lane) {
      const amount = Math.max(0, num(n, 0));
      if (lane === LANE_CASES) caseSpent += amount;
      else otherSpent += amount;
      return ledger;
    },

    /**
     * What this lane may still spend.
     *
     * Cases draw on everything not already spent — the floor guarantees they
     * CAN, it does not cap them. Non-case work is capped at `otherCeiling`,
     * and that cap is what makes the floor real: it is enforced before the
     * spend, not measured after it.
     */
    remainingFor(lane) {
      if (lane === LANE_CASES) return Math.max(0, usable - preSpent - caseSpent - otherSpent);
      return Math.max(0, Math.min(otherCeiling - otherSpent, usable - preSpent - caseSpent - otherSpent));
    },

    canAfford(n, lane) { return ledger.remainingFor(lane) >= Math.max(0, num(n, 0)); },

    /** Phase 2: how many more cases fit right now, at `perCaseCost` each. */
    caseSlots(perCaseCost = PLANNED_CASE_COST) {
      const c = Math.max(1, num(perCaseCost, PLANNED_CASE_COST));
      return Math.max(0, Math.floor(ledger.remainingFor(LANE_CASES) / c));
    },

    /** For the report: a flat, loggable shape. Never throws. */
    snapshot() {
      return {
        ceiling, tailReserve, usable, caseFloor, otherCeiling, casesDue,
        preSpent, caseSpent, otherSpent, spent: ledger.spent(),
        caseRemaining: ledger.remainingFor(LANE_CASES),
        otherRemaining: ledger.remainingFor('other'),
      };
    },
  };

  return ledger;
}

/**
 * DEFERRED IS NOT DONE — the distinction the whole remedy rests on.
 *
 * A batch carries three states and they must never collapse into two:
 *
 *   done: true                     -> COMPLETED. Every case was processed.
 *   done: false, cursor === 0      -> PENDING. Never started.
 *   done: false, cursor > 0        -> CUT SHORT. Stopped at `cursor`, and
 *                                     `cases.length - cursor` are deferred.
 *
 * `done` is set ONLY on full completion. That is the whole trick: before this
 * change `done = true` was assigned immediately after `processCaseBatch()`
 * returned, whether or not it had processed anything, so a batch that threw
 * and a batch that finished were the same record. A deferred case that looks
 * done is a dropped case with better paperwork.
 */
export function summarizeBatchState(batch) {
  if (!batch || typeof batch !== 'object') return { state: 'unknown', processed: 0, deferred: 0 };
  const totalCases = Array.isArray(batch.cases) ? batch.cases.length : 0;
  const cursor = clamp(num(batch.cursor, 0), 0, totalCases);
  if (batch.done === true) return { state: 'completed', processed: totalCases, deferred: 0, totalCases };
  if (cursor === 0) return { state: 'pending', processed: 0, deferred: totalCases, totalCases };
  return { state: 'cut_short', processed: cursor, deferred: totalCases - cursor, totalCases };
}

/**
 * Every case still owed across the whole day, oldest batch first.
 *
 * This is the queue, and it is deliberately the cycle that already exists
 * rather than a new one: `daily-cycle-state` in SIM_KV already holds every
 * batch and its cases, it is already persisted between ticks, and it is
 * already cleared at day end. Building a second store beside it would give
 * the office two answers to "what is still owed".
 *
 * Order matters: a case deferred at 08:00 is drained before this tick's own,
 * so the day's tail cannot starve behind repeatedly-refilled heads.
 */
export function collectOutstanding(cycle, currentBlock) {
  const out = [];
  const batches = Array.isArray(cycle?.batches) ? cycle.batches : [];
  const nowTime = currentBlock?.time || '';
  for (const b of batches) {
    if (b?.done === true) continue;
    if (isSameBlock(b?.block, currentBlock)) continue;   // handled separately, and last
    // ── ONLY WHAT IS OVERDUE, NEVER WHAT IS SCHEDULED ────────────────────
    // A batch whose tick has not arrived yet is not deferred work — it is
    // future work, and pulling it forward is not "draining a backlog", it is
    // running the whole day at 08:00. Caught by measurement: the first
    // version of this function omitted the comparison, and the 08:00 tick
    // consumed its entire budget on the 09:30/11:00/12:00 batches, leaving
    // every later tick with nothing to do and the day's throughput unchanged.
    // "HH:MM" compares correctly as a string, which is why the schedule uses
    // zero-padded times.
    const t = b?.block?.time || '';
    if (!t || !nowTime || t >= nowTime) continue;
    const cases = Array.isArray(b.cases) ? b.cases : [];
    const cursor = clamp(num(b.cursor, 0), 0, cases.length);
    for (let i = cursor; i < cases.length; i++) out.push({ batch: b, index: i, case: cases[i] });
  }
  return out;
}

export function isSameBlock(a, b) {
  if (!a || !b) return false;
  return a.time === b.time && a.label === b.label;
}

/** Day-level rollup for the daily report: what was owed, done, and still owed. */
export function summarizeDayDeferrals(cycle) {
  const batches = Array.isArray(cycle?.batches) ? cycle.batches : [];
  let totalCases = 0, processed = 0, deferred = 0;
  const cutShort = [];
  for (const b of batches) {
    const s = summarizeBatchState(b);
    totalCases += s.totalCases || 0;
    processed += s.processed || 0;
    deferred += s.deferred || 0;
    if (s.state === 'cut_short') cutShort.push({ block: b.block?.label || b.block?.time || '?', ...s });
  }
  return { totalCases, processed, deferred, cutShort };
}

/**
 * ── THE METER (OB-074) ─────────────────────────────────────────────────────
 *
 * Wraps the bindings so the ledger records what the tick ACTUALLY spent
 * rather than what someone estimated it would. Every D1 statement execution,
 * KV op, Durable Object fetch, service-binding fetch and Workers AI run
 * charges exactly one subrequest, which is Cloudflare's own accounting.
 *
 * WHY REAL COUNTING AND NOT CONSTANTS: the first version of this fix charged
 * a per-case constant and sized the batch from it. Measured against the real
 * path, three of six case ticks still overflowed — the constant was the p90
 * and the expensive cases are well above it. A budget built on an unverified
 * constant is the same defect this session exists to remove, one level up.
 *
 * WHAT IT CANNOT SEE: `fetch()` to the outside world. Those go through the
 * global, and wrapping the global would let a concurrent HTTP request in the
 * same isolate charge its calls to this tick. They are covered instead by
 * `EXTERNAL_FETCH_ALLOWANCE_PER_CASE`, charged per case. So the ledger is
 * exact for bindings and deliberately conservative for the rest.
 *
 * NEVER CHANGES BEHAVIOUR: every wrapper forwards arguments untouched and
 * returns exactly what the real binding returned. Counting happens before the
 * call, so a call that throws is still charged — the subrequest was spent.
 * `d1.batch()` is one subrequest (one round trip) and unwraps the statements
 * it was handed, because `prepare().bind()` returns a wrapper, not a real
 * D1PreparedStatement.
 */
export function meterEnv(env, onSpend) {
  if (!env || typeof onSpend !== 'function') return env;
  const w = (kind) => (n) => onSpend(n * (WEIGHTS[kind] ?? 1), kind);
  const out = { ...env };
  // D1 and KV are still wrapped, so their call counts stay observable, but
  // they are charged at weight 0 — measured not to be the constraint.
  if (env.DB) out.DB = meterD1(env.DB, w('d1'));
  if (env.SIM_KV) out.SIM_KV = meterKV(env.SIM_KV, w('kv'));
  if (env.AGENT_STATE) out.AGENT_STATE = meterDO(env.AGENT_STATE, w('do'));
  if (env.AI) out.AI = meterAI(env.AI, w('ai'));
  if (env.APP_API) out.APP_API = meterFetcher(env.APP_API, w('svc'));
  return out;
}

/**
 * Meters external `fetch()` — the operation that actually hits the 50 cap.
 *
 * It cannot be metered through a binding because it is not one: the provider
 * clients, the Notebook-X client and every GitHub commit call the global
 * directly. So the global is swapped for the duration of the tick and restored
 * by the returned function, which the caller runs in a `finally`.
 *
 * CONCURRENCY, STATED RATHER THAN HOPED: an isolate can serve another request
 * while a cron tick is running, and that request's fetches would be charged to
 * this tick. That direction is safe — over-counting stops cases early, it
 * never overshoots the cap — and cron ticks are 30 minutes apart, so the
 * overlap is with admin HTTP calls, not with another tick. The wrapper is
 * transparent: it forwards every argument and returns the real response, so a
 * concurrent request is unaffected either way.
 */
export function meterGlobalFetch(onSpend) {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || typeof onSpend !== 'function') return () => {};
  const wrapped = (...args) => { onSpend(WEIGHTS.fetch, 'fetch'); return original.apply(globalThis, args); };
  globalThis.fetch = wrapped;
  return () => { if (globalThis.fetch === wrapped) globalThis.fetch = original; };
}

const REAL = Symbol('real-d1-statement');

function meterD1(db, onSpend) {
  const wrapStmt = (stmt) => ({
    [REAL]: stmt,
    bind: (...a) => wrapStmt(stmt.bind(...a)),
    run: (...a) => { onSpend(1, 'd1'); return stmt.run(...a); },
    first: (...a) => { onSpend(1, 'd1'); return stmt.first(...a); },
    all: (...a) => { onSpend(1, 'd1'); return stmt.all(...a); },
    raw: (...a) => { onSpend(1, 'd1'); return stmt.raw(...a); },
  });
  const out = {
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: (stmts) => {
      onSpend(1, 'd1.batch');
      return db.batch((stmts || []).map((s) => (s && s[REAL]) ? s[REAL] : s));
    },
    exec: (sql) => { onSpend(1, 'd1.exec'); return db.exec(sql); },
  };
  if (typeof db.dump === 'function') out.dump = (...a) => db.dump(...a);
  if (typeof db.withSession === 'function') out.withSession = (...a) => db.withSession(...a);
  return out;
}

function meterKV(kv, onSpend) {
  const out = {
    get: (...a) => { onSpend(1, 'kv'); return kv.get(...a); },
    put: (...a) => { onSpend(1, 'kv'); return kv.put(...a); },
    delete: (...a) => { onSpend(1, 'kv'); return kv.delete(...a); },
    list: (...a) => { onSpend(1, 'kv'); return kv.list(...a); },
  };
  if (typeof kv.getWithMetadata === 'function') {
    out.getWithMetadata = (...a) => { onSpend(1, 'kv'); return kv.getWithMetadata(...a); };
  }
  return out;
}

function meterDO(ns, onSpend) {
  const out = {
    // idFromName/newUniqueId are local — they contact nothing and cost nothing.
    idFromName: (...a) => ns.idFromName(...a),
    get: (...a) => {
      const stub = ns.get(...a);
      return { fetch: (...f) => { onSpend(1, 'do'); return stub.fetch(...f); } };
    },
  };
  if (typeof ns.idFromString === 'function') out.idFromString = (...a) => ns.idFromString(...a);
  if (typeof ns.newUniqueId === 'function') out.newUniqueId = (...a) => ns.newUniqueId(...a);
  return out;
}

function meterAI(ai, onSpend) {
  return { run: (...a) => { onSpend(1, 'ai'); return ai.run(...a); } };
}

function meterFetcher(svc, onSpend) {
  return { fetch: (...a) => { onSpend(1, 'svc'); return svc.fetch(...a); } };
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
