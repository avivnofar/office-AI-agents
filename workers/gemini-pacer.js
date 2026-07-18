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

/**
 * Checks whether a notebook-x Gemini call is allowed right now, and if so,
 * atomically records this moment as the new "last call" so the next check
 * (from this tick or a later one) paces against it. No-ops permissively
 * (always allows) if SIM_KV isn't bound — matches this repo's existing
 * pattern of degrading open rather than blocking when a binding is missing
 * in a dev/test context.
 *
 * @param {object} env - Worker env (expects env.SIM_KV)
 * @returns {Promise<{allowed: boolean, waitedMs: number|null}>}
 */
export async function checkGeminiPacingSlot(env) {
  if (!env?.SIM_KV) return { allowed: true, waitedMs: null };

  const now = Date.now();
  const lastCallRaw = await env.SIM_KV.get(KV_KEY);
  const lastCall = lastCallRaw ? Number(lastCallRaw) : 0;
  const elapsed = now - lastCall;

  if (elapsed < MIN_SPACING_MS) {
    return { allowed: false, waitedMs: elapsed };
  }

  await env.SIM_KV.put(KV_KEY, String(now));
  return { allowed: true, waitedMs: elapsed };
}

export { MIN_SPACING_MS };
