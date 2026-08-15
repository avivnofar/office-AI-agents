/**
 * workers/quality-metric.js — the one place that says what a "quality" number
 * in this office actually is.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `evaluateResponseQuality()` has been a documented length-based placeholder
 * since the 2026-07-18 rebuild (`agents/agent-base.js`, and CLAUDE.md's Q&A
 * engine step 3 says so in as many words). What was NOT visible is how far
 * downstream that placeholder reaches. Traced 2026-08-16: **twelve consumers**,
 * including the mood engine, capability-gap detection, the client-facing report
 * fact packs, the meeting agenda, and the Lead QA's cross-embodiment
 * comparison. Every number the office publishes about the quality of its own
 * work is this function's output.
 *
 * Three facts were established by measurement, not by reading:
 *
 *  1. **There were TWO formulas, not one.** `_askDataCenter()` called
 *     `evaluateResponseQuality()` (divisor 800). `_askNotebookX()` did NOT —
 *     it carried an inline `Math.min(1, responseText.length / 600)` at
 *     `agent-base.js:734`. The same answer text therefore scored **33% higher**
 *     on the Notebook-X path than on the data-center path, purely from the
 *     denominator. Nothing recorded which formula produced which row.
 *
 *  2. **The metric is saturated.** Live D1, 2026-08-16: **101 of 120** scored
 *     notebook-x rows (84%) sit exactly at the 1.0 ceiling, because any answer
 *     of 600+ characters scores 1.0. Above the ceiling the metric carries no
 *     information at all — a brilliant answer and a padded one are the same
 *     number.
 *
 *  3. **Embodiment is confounded with project.** Claude only ever answers
 *     data-center; Gemini and cloudflare-fallback only ever answer notebook-x.
 *     So "provider A scores higher than provider B" and "project A's divisor is
 *     smaller than project B's" are the SAME arithmetic, and no amount of
 *     sample size separates them. See `scoresAreComparable()`.
 *
 * ── WHAT THIS FILE DOES AND DELIBERATELY DOES NOT DO ───────────────────────
 *
 * It does **not** change any score. The two divisors are preserved exactly as
 * they were, because changing them would silently move every mood threshold,
 * gap ceiling and published average in the same breath as making them honest —
 * and OFFICE-POLICY A15 forbids a number changing without explanation. What
 * changes is that the divisors are now **declared data in one place** instead
 * of two undocumented literals in two functions, and that every render site
 * carries `METRIC_DISCLOSURE` alongside the number.
 *
 * History is NOT rescored (explicit instruction, and A15). Existing rows keep
 * their numbers; `scorerForProject()` lets any reader recover which formula
 * produced a row from its `project` column, which is already stored.
 *
 * ── THE RULE THIS FILE ENFORCES ────────────────────────────────────────────
 *
 * **Nothing may present a placeholder score as a quality judgment without
 * saying so.** That is the same defect class as a count that silently drops
 * rows (KFM-03) — a number whose meaning is not carried with it. Import
 * `METRIC_DISCLOSURE` at every site that renders a quality figure to a reader.
 */

/**
 * The scorer's identity. Bump this if the formula EVER changes, so a future
 * reader can tell rows apart — a version with no name is why the two divisors
 * above went four weeks without anyone noticing they were different.
 */
export const SCORER_ID = 'length-proxy-v1';

/**
 * The divisors, exactly as they were before this module existed. `data-center`
 * from `evaluateResponseQuality()`; `notebook-x` from the inline expression at
 * `agent-base.js:734`. NOT harmonised — see this file's header for why.
 */
export const LENGTH_PROXY_DIVISORS = Object.freeze({
  'data-center': 800,
  'notebook-x': 600,
});

/** The divisor applied when a caller names no project. Matches the historical
 *  `evaluateResponseQuality()` default, so an unprojected call is unchanged. */
export const DEFAULT_DIVISOR = 800;

/**
 * The sentence that must travel with every rendered quality number. One
 * sentence, because a caveat nobody reads is a caveat that does not exist.
 */
export const METRIC_DISCLOSURE =
  'Quality scores here are a LENGTH PROXY, not a quality judgment: '
  + `score = min(1, answer_characters / divisor), scorer \`${SCORER_ID}\`, `
  + `divisor ${LENGTH_PROXY_DIVISORS['data-center']} for data-center and `
  + `${LENGTH_PROXY_DIVISORS['notebook-x']} for notebook-x. `
  + 'No model reads the question or the answer to produce this number. '
  + 'A long wrong answer outscores a short right one, and any answer past the '
  + 'divisor scores 1.0 regardless of content.';

/**
 * Which formula a row's score came from, recoverable from the row's own
 * `project` value — which D1 already stores, so no migration is needed to tell
 * a 600-divisor row from an 800-divisor one.
 *
 * @param {string|null|undefined} project
 * @returns {{ scorerId: string, project: string|null, divisor: number, declared: boolean }}
 *   `declared: false` means this project has no entry and fell back to the
 *   default — which is a "could not check", not a "checked and it is 800"
 *   (KFM-13). Callers that care must read this field rather than the divisor.
 */
export function scorerForProject(project) {
  const key = project || null;
  const declared = key !== null && Object.prototype.hasOwnProperty.call(LENGTH_PROXY_DIVISORS, key);
  return {
    scorerId: SCORER_ID,
    project: key,
    divisor: declared ? LENGTH_PROXY_DIVISORS[key] : DEFAULT_DIVISOR,
    declared,
  };
}

/**
 * The score itself. Byte-identical in behaviour to the two expressions it
 * replaces — deliberately, see the header.
 *
 * @param {string} responseText
 * @param {object} [opts]
 * @param {string} [opts.project] - selects the divisor
 * @param {boolean} [opts.ok=true] - a failed call scores 0, as before
 * @returns {number} 0..1
 */
export function lengthProxyScore(responseText, { project, ok = true } = {}) {
  if (!ok || !responseText) return 0;
  const { divisor } = scorerForProject(project);
  return Math.min(1, responseText.length / divisor);
}

/**
 * **The gate this module exists for.** Two scores may only be compared when
 * the same formula produced both.
 *
 * The Lead QA's cross-embodiment comparison pools `reports.quality` by
 * `embodiment_model`. Because each provider serves exactly one project (Claude
 * → data-center, Gemini/cloudflare-fallback → notebook-x), pooling across
 * providers pools across DIVISORS, and the resulting "gap" is arithmetically
 * indistinguishable from the divisor difference. Measured on live D1
 * 2026-08-16, that instrument's headline finding was
 * `cloudflare-fallback (0.879) scores higher than claude (0.421)` — a
 * comparison of 600-divisor numbers against 800-divisor ones.
 *
 * @param {Array<string|null>} projects - the distinct projects behind the scores being pooled
 * @returns {{ comparable: boolean, reason: string|null, divisors: number[] }}
 */
export function scoresAreComparable(projects) {
  const distinct = [...new Set((projects || []).filter((p) => p !== null && p !== undefined))];
  const divisors = [...new Set(distinct.map((p) => scorerForProject(p).divisor))];

  if (!distinct.length) {
    // No project on any row is NOT "they all match" — it is "could not check".
    return { comparable: false, reason: 'no_project_recorded', divisors: [] };
  }
  if (divisors.length > 1) {
    return {
      comparable: false,
      reason: `mixed_divisors: ${distinct.map((p) => `${p}=${scorerForProject(p).divisor}`).join(', ')}`,
      divisors,
    };
  }
  return { comparable: true, reason: null, divisors };
}

/**
 * How much of a set of scores sits at the ceiling, where the metric stops
 * carrying information. Rendered next to any average so a reader can see when
 * an average is really "most answers were longer than the divisor".
 *
 * @param {number[]} qualities
 * @returns {{ n: number, saturated: number, fraction: number|null, note: string|null }}
 */
export function saturationOf(qualities) {
  const valid = (qualities || []).filter((q) => typeof q === 'number' && !Number.isNaN(q));
  if (!valid.length) return { n: 0, saturated: 0, fraction: null, note: null };
  const saturated = valid.filter((q) => q >= 1).length;
  const fraction = saturated / valid.length;
  return {
    n: valid.length,
    saturated,
    fraction: Math.round(fraction * 1000) / 1000,
    note: saturated
      ? `${saturated} of ${valid.length} scores (${Math.round(fraction * 100)}%) are at the 1.0 ceiling, where this metric stops distinguishing answers.`
      : null,
  };
}
