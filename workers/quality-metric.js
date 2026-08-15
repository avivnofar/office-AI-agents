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
 *     it carried an inline `Math.min(1, responseText.length / 600)`. The same
 *     answer text therefore scored **33% higher** on the Notebook-X path than
 *     on the data-center path, purely from the denominator. Nothing recorded
 *     which formula produced which row.
 *
 *  2. **The metric is saturated.** Live D1, 2026-08-16: **101 of 120** scored
 *     notebook-x rows (84%) sit exactly at the 1.0 ceiling, because any answer
 *     of 600+ characters scores 1.0. Above the ceiling the metric carries no
 *     information at all — a brilliant answer and a padded one are the same
 *     number.
 *
 *  3. **Embodiment was confounded with project.** Claude only ever answers
 *     data-center; Gemini and cloudflare-fallback only ever answer notebook-x.
 *     So "provider A scores higher than provider B" and "project A's divisor is
 *     smaller than project B's" were the SAME arithmetic, and no amount of
 *     sample size separated them.
 *
 * ── 2026-08-16, SECOND SESSION: THE DIVISORS ARE UNIFIED (OB-080) ──────────
 *
 * Fact 3 above is a STRUCTURAL confound, not a sampling problem: provider maps
 * one-to-one onto project, so while two divisors exist the Lead QA's signature
 * instrument cannot produce any provider conclusion at all. Disclosure fixed
 * the reporting; it did not make the measurement mean anything.
 *
 * **From `UNIFIED_FROM` there is ONE divisor: 800, for every project.**
 *
 * Why 800 and not 600 — three reasons, in order of weight:
 *
 *  1. **800 was the declared formula; 600 was an accident.** `/800` lived in
 *     the one named, documented function (`evaluateResponseQuality()`, called
 *     out in CLAUDE.md). `/600` was an undeclared inline copy in
 *     `_askNotebookX()` that nobody knew existed until it was measured.
 *     Unifying onto 600 would have enshrined the accident as the standard.
 *
 *  2. **800 is the information-preserving direction, and that is arithmetic,
 *     not preference.** An answer saturates at 800 only if it saturates at 600
 *     (`L >= 800` implies `L >= 600`), so the set of rows stuck at the useless
 *     1.0 ceiling under /800 is a SUBSET of the set under /600 — strictly
 *     smaller whenever any answer lands in [600, 800). Choosing 600 would have
 *     pushed data-center toward the ceiling too, and the metric is already 84%
 *     saturated on the project that used it.
 *
 *  3. **It collapses the default.** `DEFAULT_DIVISOR` was already 800, so
 *     after unification there is exactly ONE number and no "declared vs fell
 *     back to the default" ambiguity to reason about (a KFM-13 shape that now
 *     simply cannot arise).
 *
 * **The behavioural consequence, stated because it is real and not small:**
 * a notebook-x answer now scores **25% lower** than it would have
 * (`min(1,L/800)` vs `min(1,L/600)`). More notebook-x answers will therefore
 * fall below each persona's `escalation_threshold` and be flagged as SOFT
 * capability gaps, and more will land in `_applyQualityMood()`'s IRRITATED
 * band. That direction was chosen deliberately: for a QA office, flagging more
 * is the safe error, and the alternative (raising data-center 33% into the
 * ceiling) both flags less and measures less.
 *
 * **HISTORY IS NOT RESCORED** (A15, and an explicit instruction). Every row
 * written before `UNIFIED_FROM` keeps the number it was given. What changed is
 * that a reader can now tell which formula produced any row — see
 * `scorerForRow()` — and that two rows are compared only when the same
 * divisor produced both.
 *
 * ── THE RULE THIS FILE ENFORCES ────────────────────────────────────────────
 *
 * **Nothing may present a placeholder score as a quality judgment without
 * saying so**, and **no score may be stored without naming what produced it.**
 * The second half is new on 2026-08-16 and is enforced rather than documented:
 * `buildOfficeEventRow()` REFUSES a row that carries a `quality` and no
 * `scorer_id`. That is the whole reason the two divisors went four weeks
 * undetected — the rows did not say.
 */

/**
 * The scorer's identity, and it carries the divisor in its own name so that two
 * rows can be compared by string equality without a lookup table. Bump this if
 * the formula EVER changes — a version with no name is why the two divisors
 * went four weeks without anyone noticing they were different.
 */
export const SCORER_ID = 'length-proxy-v2@800';

/** The one divisor, for every project, from UNIFIED_FROM onward. */
export const UNIFIED_DIVISOR = 800;

/**
 * The instant the office started scoring every project on one scale.
 *
 * Format is SQLite's `CURRENT_TIMESTAMP` shape (`YYYY-MM-DD HH:MM:SS`, UTC),
 * because that is exactly what `reports.created_at` holds — the column is
 * written by the DEFAULT, never by application code — so era attribution is a
 * plain lexicographic string compare with no parsing and no timezone.
 *
 * **Why this exact boundary is safe rather than approximate.** The Worker's
 * cron window runs every 30 minutes from 05:00 to 15:00 UTC only (the two
 * expressions in `wrangler.toml`), so nothing scores a case between 15:01 and
 * 04:59 UTC — the whole night is dead. This change was deployed
 * at ~21:00 UTC on 2026-08-15 — inside that dead window — so no row can exist
 * that was scored by the new formula and stamped before this boundary. The
 * gap between "deployed" and "the boundary" is provably empty rather than
 * merely small.
 */
export const UNIFIED_FROM = '2026-08-16 00:00:00';

/** Human-readable form of the same instant, for prose. */
export const UNIFIED_FROM_ISO = '2026-08-16T00:00:00Z';

/**
 * The pre-unification formulas, frozen. `data-center` from
 * `evaluateResponseQuality()`; `notebook-x` from the inline expression that
 * used to sit in `_askNotebookX()`. These are kept because history is not
 * rescored: they are how a row written before `UNIFIED_FROM` is interpreted,
 * and they are never used to score anything new.
 */
export const LEGACY_DIVISORS = Object.freeze({
  'data-center': 800,
  'notebook-x': 600,
});

/** The scorer id carried by rows written before `UNIFIED_FROM`. */
export const LEGACY_SCORER_PREFIX = 'length-proxy-v1';

/**
 * Kept for the one case a divisor cannot be established: a legacy row whose
 * `project` is not in `LEGACY_DIVISORS`. Such a row's score is uninterpretable
 * and `scorerForRow()` says so rather than guessing 800.
 */
export const DEFAULT_DIVISOR = 800;

/**
 * The dated note that records the change itself. Travels with the numbers for
 * the same reason `METRIC_DISCLOSURE` does: a reader looking at an average that
 * straddles 2026-08-16 needs to know it straddles something.
 */
export const DIVISOR_UNIFICATION_NOTE =
  `DIVISOR UNIFICATION (OB-080), effective ${UNIFIED_FROM_ISO}: until that `
  + 'instant the office ran TWO scorers — divisor 800 for data-center and 600 '
  + 'for notebook-x — so the same answer scored 33% higher on notebook-x. From '
  + `that instant there is ONE divisor, ${UNIFIED_DIVISOR}, for every project. `
  + 'Scores are comparable across projects only from that date forward. '
  + 'Historical rows were NOT rescored and keep the numbers they were given '
  + '(OFFICE-POLICY A15); any average pooling rows from both sides of the date '
  + 'is measuring the formula change as well as the thing.';

/**
 * The disclosure sentence FOR A PARTICULAR SCORER.
 *
 * This is parameterised rather than constant because the first live run of the
 * stratified comparison printed the CURRENT divisor (800) underneath a group of
 * rows scored at 600 — a disclosure that misdescribed the very numbers it was
 * attached to, which is this file's own subject matter committed in the file's
 * own fix. A disclosure that is not about the rows it sits under is worse than
 * none: it is a wrong fact carried by the mechanism built to prevent wrong
 * facts.
 */
export function metricDisclosureFor(divisor, scorerId) {
  const formula = typeof divisor === 'number' ? `answer_characters / ${divisor}` : 'answer_characters / an UNESTABLISHED divisor';
  return 'Quality scores here are a LENGTH PROXY, not a quality judgment: '
    + `score = min(1, ${formula}), scorer \`${scorerId || 'unrecorded'}\`. `
    + 'No model reads the question or the answer to produce this number. '
    + 'A long wrong answer outscores a short right one, and any answer past the '
    + `divisor scores 1.0 regardless of content. ${DIVISOR_UNIFICATION_NOTE}`;
}

/**
 * The sentence that must travel with every rendered quality number produced by
 * the CURRENT scorer. One sentence, because a caveat nobody reads is a caveat
 * that does not exist. Anything rendering historical rows must use
 * `metricDisclosureFor()` with that stratum's own divisor instead.
 */
export const METRIC_DISCLOSURE = metricDisclosureFor(UNIFIED_DIVISOR, SCORER_ID);

/**
 * Normalises a stored timestamp to the `YYYY-MM-DD HH:MM:SS` shape used by
 * `UNIFIED_FROM`, so an ISO string and a SQLite timestamp compare the same way.
 * Returns null for anything unparseable — "could not check", never a default.
 */
function normaliseStamp(scoredAt) {
  if (typeof scoredAt !== 'string' || scoredAt.length < 19) return null;
  const s = scoredAt.replace('T', ' ').slice(0, 19);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s : null;
}

/**
 * **Which scorer produced a stored row**, and therefore whether its number may
 * be pooled with another row's.
 *
 * Two sources, in order, and the result says which was used — because
 * "recorded on the row" and "inferred from a date" are different strengths of
 * evidence and collapsing them is exactly the KFM-13 shape this project keeps
 * finding.
 *
 *   1. `scorer_id` written on the row. Authoritative. Every row from
 *      2026-08-16 onward carries one, because `buildOfficeEventRow()` refuses
 *      a scored row without it.
 *   2. Otherwise inferred from `created_at` against `UNIFIED_FROM`, and for a
 *      pre-unification row from its `project`. This is how the 134 rows that
 *      predate the column are read, and it is exact for them: every one was
 *      written before the boundary.
 *
 * @param {{project?: string|null, scoredAt?: string|null, scorerId?: string|null}} row
 * @returns {{scorerId: string|null, divisor: number|null, source: 'recorded'|'inferred'|'unknown', era: 'unified'|'legacy'|'unknown', reason: string|null}}
 */
export function scorerForRow({ project = null, scoredAt = null, scorerId = null } = {}) {
  if (typeof scorerId === 'string' && scorerId) {
    const divisor = divisorOfScorerId(scorerId);
    return {
      scorerId,
      divisor,
      source: 'recorded',
      era: scorerId === SCORER_ID ? 'unified' : 'legacy',
      reason: divisor === null ? 'scorer_id names no divisor this module knows' : null,
    };
  }

  const stamp = normaliseStamp(scoredAt);
  if (stamp === null) {
    return { scorerId: null, divisor: null, source: 'unknown', era: 'unknown', reason: 'no scorer_id and no usable created_at' };
  }

  if (stamp >= UNIFIED_FROM) {
    return { scorerId: SCORER_ID, divisor: UNIFIED_DIVISOR, source: 'inferred', era: 'unified', reason: null };
  }

  const known = project !== null && Object.prototype.hasOwnProperty.call(LEGACY_DIVISORS, project);
  if (!known) {
    // A pre-unification row whose project has no declared divisor. Its score is
    // uninterpretable and saying "probably 800" would be an invention.
    return {
      scorerId: `${LEGACY_SCORER_PREFIX}@unknown`,
      divisor: null,
      source: 'inferred',
      era: 'legacy',
      reason: `pre-unification row on project ${JSON.stringify(project)}, which has no declared legacy divisor`,
    };
  }
  const d = LEGACY_DIVISORS[project];
  return { scorerId: `${LEGACY_SCORER_PREFIX}@${d}`, divisor: d, source: 'inferred', era: 'legacy', reason: null };
}

/**
 * The divisor named by a scorer id. Ids are `name@divisor` by construction
 * precisely so this needs no registry that could drift from the ids in use.
 */
export function divisorOfScorerId(scorerId) {
  if (typeof scorerId !== 'string') return null;
  const at = scorerId.lastIndexOf('@');
  if (at === -1) return null;
  const n = Number(scorerId.slice(at + 1));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The score itself.
 *
 * **`project` is deliberately not a parameter.** It used to select the divisor,
 * and that is the entire defect this module was created to describe. A caller
 * cannot change the scale by naming a project, and
 * `scripts/verify-quality-metric.js` asserts that as a property rather than by
 * grepping for the word.
 *
 * @param {string} responseText
 * @param {object} [opts]
 * @param {boolean} [opts.ok=true] - a failed call scores 0, as before
 * @returns {number} 0..1
 */
export function lengthProxyScore(responseText, { ok = true } = {}) {
  if (!ok || !responseText) return 0;
  return Math.min(1, responseText.length / UNIFIED_DIVISOR);
}

/**
 * The score AND the identity of what produced it, together, so that a caller
 * physically cannot store one without the other. Use this at every site that
 * persists a quality number — `buildOfficeEventRow()` refuses the row otherwise.
 *
 * @returns {{quality: number, scorerId: string}}
 */
export function scoreWithScorer(responseText, { ok = true } = {}) {
  return { quality: lengthProxyScore(responseText, { ok }), scorerId: SCORER_ID };
}

/**
 * **The gate this module exists for.** Two scores may only be pooled when the
 * same divisor produced both.
 *
 * Keyed on the DIVISOR rather than the scorer id, deliberately: a legacy
 * data-center row (`length-proxy-v1@800`) and a post-unification row
 * (`length-proxy-v2@800`) are the identical arithmetic, and refusing to compare
 * them would throw away real evidence to honour a version string. What is
 * genuinely incomparable is a legacy notebook-x row, scored `/600`.
 *
 * @param {Array<{scorerId: string|null, divisor: number|null}>} scorers
 * @returns {{comparable: boolean, reason: string|null, divisors: number[], scorerIds: string[]}}
 */
export function scoresAreComparable(scorers) {
  const list = (scorers || []).filter((s) => s && typeof s === 'object');
  const scorerIds = [...new Set(list.map((s) => s.scorerId).filter(Boolean))];

  if (!list.length) {
    // Nothing to check is NOT "they all match" — it is "could not check".
    return { comparable: false, reason: 'no_scorer_recorded', divisors: [], scorerIds };
  }
  const unknown = list.filter((s) => typeof s.divisor !== 'number');
  if (unknown.length) {
    return {
      comparable: false,
      reason: `unknown_divisor: ${unknown.length} of ${list.length} score group(s) name no divisor (${[...new Set(unknown.map((s) => s.scorerId || 'no scorer id'))].join(', ')})`,
      divisors: [],
      scorerIds,
    };
  }
  const divisors = [...new Set(list.map((s) => s.divisor))];
  if (divisors.length > 1) {
    return {
      comparable: false,
      reason: `mixed_divisors: ${[...new Set(list.map((s) => `${s.scorerId}=${s.divisor}`))].join(', ')}`,
      divisors,
      scorerIds,
    };
  }
  return { comparable: true, reason: null, divisors, scorerIds };
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
