/**
 * workers/day-advance-guard.js — SESSION 37, ITEM 1 (2026-08-29).
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `runScheduledBlock()`'s cycle-open condition in agent-runner.js —
 * `isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek` — had no memory
 * beyond the cycle itself, and the cycle is deleted the moment a day
 * finalizes, successfully or not (`finalizeScheduledDay()`'s
 * `clearCycleState()` runs unconditionally, even when finalize threw).
 * `dayOfWeek` is a 1-7 value that repeats every week. Nothing distinguished
 * "today's legitimate first block" from "a tick landing after today's cycle
 * already opened and closed" — any tick whose dayOfWeek differed from a
 * (possibly already-cleared) cycle's would silently open a SECOND day and
 * advance `current_day` again.
 *
 * Measured live, 2026-08-29 (a Saturday — one scheduled block, at 08:00):
 * D1 `block_admissions` carries day 66 (the real 08:00 Saturday tick,
 * `at: "08:00"`, `created_at: 2026-08-29 05:00:38`) AND day 67 (`at:
 * "14:30"`, `created_at: 2026-08-29 12:00:04`) — "14:30" belongs to
 * `full_day_schedule` (Sun-Thu), not `saturday_schedule`, so this second
 * admission can only have run under a dayOfWeek that did not match the real
 * calendar day. `year_stats` shows current_day stopped at 66 (no row was
 * ever written for 67), because "14:30" is not `full_day_schedule`'s last
 * block — the phantom day opened but never finalized, leaving a day-67
 * cycle sitting in SIM_KV that the NEXT real tick would have collided with.
 *
 * ── THE FIX ───────────────────────────────────────────────────────────────
 *
 * A guard, not a rewrite: a durable marker (survives the cycle being
 * cleared) recording the Israel-local calendar DATE a day was last opened
 * for. A tick that would open a new cycle first checks this marker; if
 * today's date is already recorded, it refuses rather than opening a second
 * day. The existing `isFirstBlock || !cycle || cycle.dayOfWeek !== dayOfWeek`
 * condition is untouched — it still decides WHEN a new cycle would be
 * opened; this only decides whether that open is allowed to proceed.
 *
 * Extracted into its own module — no JSON import, so it loads under plain
 * Node — for the same reason workers/qa-topics.js, workers/gap-reports.js
 * and workers/gemini-pacer.js were (see scripts/verify-qa-engine.js's
 * header): it is the only way a verifier can call the REAL function against
 * a mock KV instead of text-matching a stand-in.
 */

const LAST_DAY_ADVANCE_KEY = 'last-day-advance';

/**
 * Israel-local calendar date (YYYY-MM-DD) for `date`, using the same
 * fixed-offset convention agent-runner.js's `israelTimeParts()` uses
 * (`ISRAEL_UTC_OFFSET_HOURS`, passed in as `offsetHours` so this file makes
 * no claim about DST on its own).
 */
export function israelDateStr(date, offsetHours) {
  return new Date(date.getTime() + offsetHours * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * True if a day has already been opened for `todayDate`.
 *
 * Fails CLOSED: a KV read that throws is not treated as "safe to advance" —
 * it is treated as "already advanced", refusing this tick's cycle-open
 * rather than risking a second one. A real not-yet-advanced day just waits
 * for the next tick (30 minutes later, cheap); a real second advance is the
 * bug this file exists to stop, and can't be undone once it lands in D1.
 */
export async function alreadyAdvancedToday(env, todayDate) {
  if (!env?.SIM_KV) return false; // no KV bound — nothing to guard against, matches every other SIM_KV-gated check in this estate
  try {
    const marker = await env.SIM_KV.get(LAST_DAY_ADVANCE_KEY, 'json');
    return !!marker && marker.date === todayDate;
  } catch (err) {
    console.warn(`[day-advance-guard] could not read ${LAST_DAY_ADVANCE_KEY}, refusing to advance this tick: ${err?.message || err}`);
    return true;
  }
}

/**
 * Records that `todayDate` has now had a day opened for it (`day` is the
 * cycle's day number, kept only for diagnostics). Best-effort and cannot
 * throw (KFM-14 shape) — a lost marker write must not cost the tick that
 * already opened the day; it only means this guard cannot help on the NEXT
 * stray tick either, same as if SIM_KV were absent.
 */
export async function recordDayAdvance(env, todayDate, day) {
  if (!env?.SIM_KV) return;
  try {
    await env.SIM_KV.put(LAST_DAY_ADVANCE_KEY, JSON.stringify({ date: todayDate, day }));
  } catch (err) {
    console.warn(`[day-advance-guard] could not record advance to day ${day}: ${err?.message || err}`);
  }
}

export const LAST_DAY_ADVANCE_KEY_NAME = LAST_DAY_ADVANCE_KEY;
