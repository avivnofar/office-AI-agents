/**
 * Data Center — AI Agent Simulation — Gemini call pacing for Notebook-X asks.
 *
 * WHY THIS EXISTS (read before changing MIN_SPACING_MS):
 *
 * Gemini's free-tier quota is rate-limited per-minute, not per-day, and per
 * the owner's own account setup there are THREE separate consumers that can
 * draw against the SAME free-tier quota at any given moment:
 *   (a) Notebook-X's own backend — both its live `/ask` endpoint (real users
 *       hitting the deployed app) and its own weekly gap-analysis job,
 *       neither of which this repo can see or coordinate with in real time;
 *   (b) THIS office-agent Q&A automation (askNotebookX() in agent-base.js);
 *   (c) any other existing Gemini usage already in office-AI-agents itself
 *       (meeting-engine.js report synthesis, coworker-chat spare time,
 *       model-education writeups — see config/token-economy.json).
 *
 * This module can only see and pace (b). It has NO visibility into (a) or
 * (c)'s real-time call rate — that is a genuine blind spot, not an oversight
 * to fix later. Given that blind spot, the only safe posture is to pace (b)
 * conservatively and leave deliberate headroom for the other two, rather
 * than computing "our fair share" of the limit and using all of it — a
 * precise-looking budget split would be false precision, since it assumes
 * knowledge of (a)/(c)'s usage this module doesn't have.
 *
 * Mechanism: rather than blocking a Cloudflare Worker invocation with an
 * in-request sleep (risky against Workers' execution-time limits, and this
 * runs inside a 30-minute-cron tick that already does other work), pacing is
 * enforced by SKIPPING a notebook-x ask if too little wall-clock time has
 * passed since this automation's last one, tracked via a single global KV
 * timestamp (Gemini's quota is account-wide, not per-agent, so a per-agent
 * timestamp would under-pace). A skipped ask is treated the same as "no
 * quota available right now" by the caller — the question is simply not
 * asked this tick, not retried in a tight loop. Because the office
 * simulation already runs across many cron ticks spread through the day
 * (17 ticks between 08:00-16:30 IDT, config/daily-schedule.json), this
 * naturally spreads notebook-x calls across the day rather than bursting —
 * which is also the behavior the owner separately asked for so Notebook-X's
 * own weekly gap-analysis job sees steady usage, not a spike.
 */

const KV_KEY = 'gemini-notebook-x-last-call';

/** Conservative floor: at most one notebook-x Gemini call per 20 real
 * seconds from THIS automation. Free-tier flash-lite RPM limits are commonly
 * in the 10-15 RPM range; at 20s spacing this automation alone could reach
 * ~3 RPM at most, leaving deliberate headroom (the majority of the limit)
 * for consumers (a) and (c) above, which this module cannot observe. */
const MIN_SPACING_MS = 20_000;

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS PACER IS NOT ATOMIC. Corrected 2026-08-16 (audit finding #13 / KFM-16).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The docstring below used to say this function "atomically records" the call
 * time. It does not, and saying so made the race HARDER to find rather than
 * easier — a reader who sees "atomically" stops looking, which is the whole
 * reason KFM-16 is phrased as a question about docstrings.
 *
 * What it actually does is get → compare → put against Workers KV. There is no
 * compare-and-swap in the KV API, so two things can go wrong, and they are
 * DIFFERENT and worth keeping apart:
 *
 *   1. THE RACE. Two overlapping Worker invocations both read the old
 *      timestamp, both find enough time elapsed, and both proceed. Narrow in
 *      practice: cron ticks are 30 minutes apart and calls within one
 *      invocation are awaited in sequence, so this needs a cron tick to
 *      overlap an admin trigger, or two admin triggers at once.
 *
 *   2. THE STALE READ — MORE LIKELY, AND THE ONE THE OLD COMMENT HID.
 *      Workers KV is eventually consistent and caches reads at the edge for up
 *      to 60 seconds. This pacer's floor is 20 seconds. So a `put` from one
 *      invocation is NOT reliably visible to a `get` from the next, and a
 *      perfectly sequential pair of calls 25 seconds apart can read a stale
 *      timestamp and be allowed through. **No concurrency is required for this
 *      one.** A 20-second floor enforced through a store with a 60-second read
 *      cache is structurally unable to hold, and no amount of care in this
 *      function changes that.
 *
 * BOTH FAIL IN THE PERMISSIVE DIRECTION: the pacer under-paces, never
 * over-paces. That is the safe direction for the office (no work is lost) and
 * the unsafe direction for the quota (Gemini's free tier is shared with two
 * consumers this repo cannot observe). It is recorded rather than silently
 * accepted.
 *
 * THE REAL FIX IS A DURABLE OBJECT, NOT A BETTER KV DANCE. The Worker already
 * binds one (`AGENT_STATE`); a DO is single-threaded and strongly consistent,
 * which is exactly and only what this needs. That is a change to a hot path in
 * the ask loop and it is boarded as OB-082 rather than made here — a pacer
 * rewrite is not something to land unsupervised in the same session that
 * deploys it.
 *
 * WHAT WAS FIXED HERE INSTEAD, and it is not nothing: there were TWO copies of
 * this algorithm (this file and `task-router.js`'s `checkUnknownCapPacing`),
 * each with its own key convention and only one of them carrying the false
 * atomicity claim. There is now ONE implementation — `checkKvPacingSlot()`
 * below — and both callers use it, so the correction above cannot be true of
 * one copy and stale on the other. Two copies of a subtle concurrency
 * primitive is the defect underneath the defect.
 */

/**
 * The one KV-backed pacing primitive. Check-and-set: an allowed check consumes
 * the slot. NOT atomic — see the block above before relying on it.
 *
 * Degrades OPEN (allows) without SIM_KV, matching this repo's pattern of
 * degrading open rather than blocking when a binding is missing.
 *
 * @param {object} env - Worker env (expects env.SIM_KV)
 * @param {string} key - the KV key holding this stream's last-call timestamp
 * @param {number} minSpacingMs
 * @param {number} [now] - injectable clock, so a verifier can test the boundary
 * @returns {Promise<{allowed: boolean, waitedMs: number|null, degradedOpen: boolean}>}
 */
export async function checkKvPacingSlot(env, key, minSpacingMs, now = Date.now()) {
  if (!env?.SIM_KV) return { allowed: true, waitedMs: null, degradedOpen: true };

  const lastCallRaw = await env.SIM_KV.get(key).catch(() => null);
  const lastCall = lastCallRaw ? Number(lastCallRaw) : 0;
  const elapsed = now - lastCall;

  if (elapsed < minSpacingMs) {
    return { allowed: false, waitedMs: elapsed, degradedOpen: false };
  }

  await env.SIM_KV.put(key, String(now)).catch(() => {});
  return { allowed: true, waitedMs: elapsed, degradedOpen: false };
}

/**
 * Checks whether a notebook-x Gemini call is allowed right now, and if so,
 * records this moment as the new "last call" so the next check (from this tick
 * or a later one) paces against it.
 *
 * @param {object} env - Worker env (expects env.SIM_KV)
 * @param {number} [now] - injectable clock for tests
 * @returns {Promise<{allowed: boolean, waitedMs: number|null}>}
 */
export async function checkGeminiPacingSlot(env, now = Date.now()) {
  const r = await checkKvPacingSlot(env, KV_KEY, MIN_SPACING_MS, now);
  return { allowed: r.allowed, waitedMs: r.waitedMs };
}

export { MIN_SPACING_MS, KV_KEY };
