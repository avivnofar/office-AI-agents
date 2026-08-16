/**
 * workers/judge-sampler.js — OB-081. A real evaluation of an answer against the
 * question that was asked, on a SAMPLE, to find out whether the cheap score
 * means anything.
 *
 * ── WHY A SAMPLE AND NOT EVERY CASE ────────────────────────────────────────
 *
 * The cost objection turned out to be false and it is worth recording why,
 * because it had gone unchecked long enough to become the reason: **a real
 * judge costs $0.** The judgment lane's primary is Cerebras on its free tier
 * (`config/model-routing.json`, `config/token-economy.json`), so the money
 * argument against evaluating for real never existed.
 *
 * **The binding constraint is pacing.** Cerebras publishes no daily ceiling, so
 * `config/token-economy.json` records `requests_per_day: null` — which this
 * project reads as UNKNOWN, never as unlimited — and a provider with no known
 * cap is limited by wall clock instead: a 20-second minimum spacing
 * (`task-router.js checkUnknownCapPacing()`, `unknown_cap_min_spacing_ms`).
 * A cron tick is one invocation, its case asks run in sequence, and 20 seconds
 * is longer than a tick's worth of asks. So **one judgment per block is what
 * the pacing allows**, and that is a measured limit rather than a chosen one.
 *
 * ── THE RATE, AND WHY THESE NUMBERS ────────────────────────────────────────
 *
 *   `JUDGE_SAMPLE_RATE = 0.125` — one answer in eight is SELECTED.
 *   `MAX_JUDGEMENTS_PER_BLOCK = 1` — of those, at most one per block is SENT.
 *
 * Two numbers rather than one, deliberately. The rate is what the office
 * intends to sample; the cap is what the provider permits. Collapsing them into
 * "one per block" would hide the difference between *not selected* and
 * *selected and could not be sent*, and the gap between them is the only way to
 * know whether the sample is representative or merely convenient (KFM-03: a
 * count must say what it dropped).
 *
 * Volume check, ~~40–130 answers a day~~ — **struck 2026-08-16, measured.** The
 * office answers **22–29 questions on a full working day**, not 40–130: 29 · 24
 * · 22 · 27 · 24 on 2026-08-09..13, against 200 cases generated each day (the
 * rest are `case_not_asked`). The old figure was never measured against D1.
 *
 * With six `case_batch` blocks Sun–Thu (`config/daily-schedule.json`) and ~24
 * answers a day, 1-in-8 selects **about 3 a day** and the per-block cap of 6
 * never binds. So **the rate binds and the pacing cap does not** — the reverse
 * of what this header used to assume. `MIN_CALIBRATION_SAMPLE = 20` is
 * therefore reachable in **six to seven working days**, not three to four:
 * calendar-wise about a week and a half, since the office rests Friday–Saturday.
 *
 * That projection assumes a selector that actually samples. See `hashToUnit()`
 * — until 2026-08-16 it did not, and the realized rate on real ids was 2.4%.
 *
 * The judgment lane also serves the weekly report's review. One extra call per
 * block against a 1,000-req/min provider does not starve it; the 20-second
 * floor is shared, so the worst case is that a report review is paced out for
 * one tick and taken on the next, which is the pacer working as designed.
 *
 * ── WHAT THIS IS FOR, WHICH IS NOT "A BETTER SCORE" ────────────────────────
 *
 * **The point of the sample is calibration.** The question is not "what is the
 * real quality of this answer" — it is *does the cheap score, which every
 * published quality figure in this office rests on, correlate with a real
 * evaluation at all?* If it does not, then the mood engine, the gap tiers, the
 * fact packs and the Lead QA's instrument are all downstream of noise, and that
 * is the finding.
 *
 * **The cheap score is NOT removed and must not be** until that correlation is
 * measured. It is the pre-filter and it runs on every answer; this runs on one
 * in eight. Deleting the thing under test before the test finishes is how a
 * project ends up with neither number.
 *
 * ── HONESTY CONSTRAINTS BUILT INTO THIS MODULE ─────────────────────────────
 *
 *  · The judge is NEVER told the cheap score. Telling it would contaminate the
 *    correlation with anchoring and measure agreement with an anchor instead.
 *  · The judge is told explicitly that length is not quality, because a judge
 *    that reaches for length as a proxy would reproduce the very metric it is
 *    being used to check and the correlation would be an artifact.
 *  · A correlation over scores with no spread is not a weak correlation, it is
 *    an undefined one. 84% of cheap notebook-x scores sat at the 1.0 ceiling,
 *    so this is the LIKELY case, and `correlate()` refuses rather than
 *    returning a number near zero that a reader would take as "no relationship"
 *    when the truth is "this sample could not answer the question".
 *  · A selected case that could not be judged is RECORDED as such. The realized
 *    sample must be reconstructable from the table, not inferred from its size.
 *
 * ── KNOWN BIAS, STATED RATHER THAN DISCOVERED LATER ────────────────────────
 *
 * Selection is by hash of the case id, which is position-independent. Sending
 * is by pacing, which is not: within a block, the earliest selected case takes
 * the slot. The realized sample is therefore "hash-selected AND early in its
 * block". Nothing suggests position in a block correlates with answer quality —
 * different agents, different topics, different projects — but it is a
 * systematic rather than random sample and any conclusion drawn from it carries
 * that. `renderCalibrationReport()` prints this.
 *
 * **"Position-independent" was FALSE when first written, and that is worth
 * keeping rather than quietly correcting.** It was a claim about a hash nobody
 * had measured on the id shape production actually uses; measured on 2026-08-16
 * it was the opposite — selection was so determined by a case's index that a
 * third of working days had nothing selectable at all. It is true now because
 * `hashToUnit()` was fixed, not because it was ever checked before. A stated
 * bias section is only as good as the measurement behind each of its claims,
 * and this one shipped with the honest-sounding half documented and the
 * load-bearing half assumed.
 *
 * Ships behind `judge_sampler_enabled`, default OFF, same shape as every other
 * switch here.
 */

import { SIM_STATE_KEY } from './improvement-loop.js';

/** SIM_KV flag. Absent or false means this module contacts nothing. */
export const JUDGE_SAMPLER_FLAG = 'judge_sampler_enabled';

/** One answer in eight is selected for a real evaluation. See the header. */
export const JUDGE_SAMPLE_RATE = 0.125;

/**
 * **What selected this row.** Same discipline as `reports.scorer_id`, and for
 * the same reason that one exists: two divisors survived four weeks undetected
 * for exactly one reason — *the rows did not say* (KFM-28, check 5).
 *
 * `v1` was `hashToUnit`'s raw `h / 2^32`, whose per-day selection was so
 * clustered that a third of working days had nothing selectable at all. It
 * produced **zero** rows in production: the switch went on 2026-08-16 00:52
 * Israel and the defect was found the same morning before any judgement was
 * written. So there is no history under `v1` to preserve, and none was
 * rescored — there was nothing to rescore. That is luck about timing, not a
 * licence: a selector change after rows exist is a scale change and would need
 * the cutover treatment `UNIFIED_FROM` got in `quality-metric.js`.
 *
 * Named `@0.125` because a rate change is also a selector change — a bucket
 * means nothing without the threshold it was compared against.
 */
export const SELECTOR_ID = 'hash-select-v2@0.125';

/**
 * What the 20-second unknown-cap pacing floor allows per block, measured.
 *
 * **This is a description, not a second gate, and the distinction is
 * deliberate.** The obvious implementation — a counter — would have to live at
 * module scope, and a Workers isolate is REUSED across invocations: a
 * module-scope counter would carry yesterday's tick into today's and silently
 * stop judging anything after the first ever call. So the enforcement is the
 * pacer, which is stateful in the right place (KV, keyed by provider), and the
 * cases pacing turns away are RECORDED as `paced_out` rather than vanishing.
 * `scripts/verify-judge-sampler.js` asserts no second counter exists.
 */
export const MAX_JUDGEMENTS_PER_BLOCK = 1;

/** Below this many judged pairs, no correlation is reported at all. */
export const MIN_CALIBRATION_SAMPLE = 20;

/**
 * Below this spread in the cheap scores, a correlation is undefined rather than
 * weak. Chosen against the measured saturation: 84% of notebook-x cheap scores
 * sat at exactly 1.0, and a sample drawn from that has almost no variance.
 */
export const MIN_CHEAP_SCORE_STDDEV = 0.02;

/** The lane. Cerebras primary, Mistral backup — see config/model-routing.json. */
export const JUDGE_LANE = 'judgment';

/**
 * Reasoning models charge their thinking against `max_tokens`, so a small
 * budget returns an empty answer rather than a short one — the defect the
 * routing supervised test found on 2026-08-10. Sized above
 * `cerebras-client.js MIN_OUTPUT_TOKENS` so the floor never has to rescue it.
 */
export const JUDGE_MAX_TOKENS = 700;

/** Truncation applied to the answer before it is judged, in characters.
 *  Well above any answer this office has produced; present so a pathological
 *  response cannot blow the lane's input cap. A truncated answer is FLAGGED,
 *  never judged silently — see buildJudgePrompt(). */
export const MAX_ANSWER_CHARS = 20000;
export const MAX_QUESTION_CHARS = 4000;

/** Outcomes a selected case can reach. Every one is written to D1. */
export const JUDGE_OUTCOMES = Object.freeze([
  'judged',            // a real score came back and parsed
  'paced_out',         // selected, but the lane refused on pacing/quota
  'lane_error',        // the lane was reached and failed
  'unparseable',       // the judge answered and the answer had no usable score
  'truncated_input',   // the answer was too long to judge honestly
]);

export async function judgeSamplerEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[JUDGE_SAMPLER_FLAG] === true;
}

/**
 * A stable unit-interval hash of a case id. FNV-1a **plus a finalizer**, which
 * is small, has no dependencies and is deterministic across invocations — the
 * last property is the one that matters: the same case is selected or not
 * selected every time anybody re-runs this, so the sample is reproducible and
 * auditable rather than a thing that happened once.
 *
 * NOT `Math.random()`: a random sample cannot be re-derived, so a reader asking
 * "why was that case judged and not this one" has no answer, and a rerun
 * silently produces a different population.
 *
 * ── WHY THE FINALIZER, MEASURED 2026-08-16 ─────────────────────────────────
 *
 * This function used to end at `h / 0x100000000` — the raw FNV-1a state divided
 * into the unit interval. **That is the HIGH 32 bits, and FNV-1a barely moves
 * them with the LAST bytes of its input.** Each step is `h = (h ^ c) * PRIME`,
 * and multiplication propagates bits only upward through carries, so the top of
 * the word is dominated by the input's *prefix* while the trailing characters
 * land in the low bits that the division throws away.
 *
 * Production case ids are `qa-<year>-w<week>-d<dow>-<NNN>`. Every id the office
 * asks **in one day shares a 15-character prefix** and differs only in the last
 * three digits — precisely the input shape that defect is blind to.
 *
 * **The aggregate rate hid it completely.** Over the full 52-week namespace the
 * old hash selected 12.09%, against a declared 12.5% — correct, and the reason
 * nobody looked. The defect lives entirely in the per-day distribution, which is
 * the only scale that matters, because the sample accrues one day at a time and
 * the send cap is per block. Measured over 260 simulated working days, selectable
 * cases out of each day's 200:
 *
 *   | selector        | mean | sd   | median | days with ZERO selectable |
 *   |-----------------|------|------|--------|---------------------------|
 *   | old, `h/2^32`   | 24.2 | 28.9 | 8      | **80 of 260 (31%)**       |
 *   | with finalizer  | 25.2 | 5.0  | 25     | 0 of 260                  |
 *
 * A uniform selector has sd ≈ 4.7. The old one was six times that, and on
 * roughly a third of days **no case in the whole namespace could be selected at
 * any rate ≤ 0.125** — the sampler was structurally incapable of sampling.
 *
 * Confirmed against the office's real answered cases, not simulated ones: of
 * 125 ids actually asked between 2026-08-07 and 2026-08-16, the old selector
 * would have picked **3 (2.4%)**, and on 2026-08-13 — a full working day, 22
 * distinct asks — it would have picked **none**, because that day's entire
 * 200-id namespace hashed above the threshold.
 *
 * The fix is murmur3's `fmix32` avalanche step, which diffuses the low bits
 * (where the trailing digits actually are) up into the high ones. FNV-1a is
 * unchanged as the mixing stage; determinism and reproducibility are unchanged.
 *
 * See `scripts/verify-judge-sampler.js` §2b, which measures uniformity on the
 * REAL id shape per day and carries the old expression as a falsifying control.
 * §2's original rate check passed throughout: it drew `case-0`…`case-3999`,
 * ids that vary in length and in every position, so it measured a namespace
 * production does not have (KFM-28).
 */
export function hashToUnit(key) {
  const s = String(key ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // fmix32 — the avalanche step. Without it the division below reads only the
  // bits the input's trailing characters never reached.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/**
 * Is this case in the sample? Pure and deterministic.
 *
 * @param {string} caseId
 * @param {number} [rate]
 * @returns {{selected: boolean, bucket: number, rate: number}}
 */
export function isSelectedForJudging(caseId, rate = JUDGE_SAMPLE_RATE) {
  const bucket = hashToUnit(caseId);
  return { selected: bucket < rate, bucket: Math.round(bucket * 10000) / 10000, rate };
}

/**
 * The prompt. Two properties are load-bearing and both are asserted by the
 * verifier rather than trusted:
 *
 *  1. **The cheap score is not in it.** Anchoring the judge on the number under
 *     test would make the correlation measure obedience.
 *  2. **Length is named as irrelevant.** Without that line a judge reaches for
 *     the same proxy and the correlation becomes an artifact of two length
 *     heuristics agreeing.
 */
export function buildJudgePrompt({ question, answer }) {
  const q = String(question ?? '');
  const a = String(answer ?? '');
  const truncated = q.length > MAX_QUESTION_CHARS || a.length > MAX_ANSWER_CHARS;
  return {
    truncated,
    systemPrompt:
      'You are a strict technical evaluator for an IT and cybersecurity help desk. '
      + 'You judge ONE answer against ONE question and return a numeric score.\n\n'
      + 'SCORING RUBRIC (0.00 to 1.00):\n'
      + '  0.00-0.20  does not address the question, or is factually wrong in a way that would mislead\n'
      + '  0.21-0.40  addresses the topic but misses what was actually asked, or is materially incomplete\n'
      + '  0.41-0.60  partially correct and usable, with real gaps or unsupported claims\n'
      + '  0.61-0.80  correct and useful; a competent practitioner could act on it\n'
      + '  0.81-1.00  correct, complete for the question asked, and specific\n\n'
      + 'RULES:\n'
      + '  - LENGTH IS NOT QUALITY. A short precise answer scores HIGHER than a long vague one. '
      + 'Do not reward padding, restatement of the question, or lists of generalities.\n'
      + '  - Judge only against the question asked. Do not reward extra material that was not asked for.\n'
      + '  - If the answer is empty or refuses, score 0.00.\n\n'
      + 'OUTPUT FORMAT, exactly two lines and nothing else:\n'
      + 'SCORE: <number between 0.00 and 1.00>\n'
      + 'REASON: <one sentence, max 30 words>',
    prompt:
      `QUESTION:\n${q.slice(0, MAX_QUESTION_CHARS)}\n\n`
      + `ANSWER:\n${a.slice(0, MAX_ANSWER_CHARS)}\n\n`
      + 'Score this answer against this question using the rubric.',
  };
}

/**
 * Parses the judge's reply. REFUSES rather than defaults — an unparseable reply
 * is recorded as `unparseable` and contributes nothing to the correlation. A
 * defaulted 0.5 would be a fabricated measurement sitting in the population
 * whose whole purpose is to be trustworthy.
 *
 * @returns {{ok: true, score: number, reason: string} | {ok: false, why: string}}
 */
export function parseJudgeVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, why: 'empty_reply' };
  const m = text.match(/SCORE:\s*([0-9]*\.?[0-9]+)/i);
  if (!m) return { ok: false, why: 'no_score_line' };
  const score = Number(m[1]);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    return { ok: false, why: `score_out_of_range: ${m[1]}` };
  }
  const r = text.match(/REASON:\s*(.+)/i);
  return { ok: true, score, reason: (r ? r[1] : '').trim().slice(0, 300) };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * CALIBRATION — the actual output of this whole mechanism
 * ═══════════════════════════════════════════════════════════════════════════ */

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}
/** Average ranks, which matters here specifically: the cheap score has a huge
 *  tie block at 1.0, and naive ranking would invent an ordering inside it. */
function ranks(xs) {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

/**
 * **Does the cheap score correlate with a real evaluation?**
 *
 * Returns a verdict, not just a number, because every way this can fail to be
 * answerable produces a number that looks like an answer:
 *
 *   · too few pairs      -> `insufficient_sample`, not "r = 0.3 (weak)"
 *   · no spread in the cheap score -> `cheap_score_has_no_variance`, not r ≈ 0.
 *     This is the expected outcome given measured saturation, and it is a
 *     finding about the metric rather than a failure of the method: a score
 *     that is 1.0 for 84% of answers cannot correlate with anything.
 *   · no spread in the judge score -> `judge_score_has_no_variance`, which
 *     would mean the judge is not discriminating and the fault is here.
 *
 * @param {Array<{cheap: number, judge: number}>} pairs
 */
export function correlate(pairs) {
  const clean = (pairs || []).filter(
    (p) => typeof p?.cheap === 'number' && typeof p?.judge === 'number'
      && !Number.isNaN(p.cheap) && !Number.isNaN(p.judge),
  );
  const n = clean.length;
  const base = { n, r: null, rho: null, meanCheap: null, meanJudge: null, sdCheap: null, sdJudge: null };

  if (n < MIN_CALIBRATION_SAMPLE) {
    return {
      ...base,
      verdict: 'insufficient_sample',
      interpretable: false,
      note: `${n} judged pair(s); ${MIN_CALIBRATION_SAMPLE} are required before any correlation is reported. A correlation on fewer is a number, not evidence.`,
    };
  }

  const cheap = clean.map((p) => p.cheap);
  const judge = clean.map((p) => p.judge);
  const sdCheap = stddev(cheap); const sdJudge = stddev(judge);
  const stats = {
    n,
    meanCheap: round3(mean(cheap)),
    meanJudge: round3(mean(judge)),
    sdCheap: round3(sdCheap),
    sdJudge: round3(sdJudge),
  };

  if (sdCheap < MIN_CHEAP_SCORE_STDDEV) {
    return {
      ...stats, r: null, rho: null,
      verdict: 'cheap_score_has_no_variance',
      interpretable: false,
      note: `The cheap score has almost no spread in this sample (sd ${round3(sdCheap)} < ${MIN_CHEAP_SCORE_STDDEV}). A correlation cannot be computed, and reporting one near zero would read as "no relationship" when the truth is "this sample cannot answer the question". THIS IS ITSELF THE FINDING: a length proxy that saturates at the divisor is constant across most answers, so it carries no information to correlate with — which is what the measured 84% ceiling rate predicted.`,
    };
  }
  if (sdJudge < MIN_CHEAP_SCORE_STDDEV) {
    return {
      ...stats, r: null, rho: null,
      verdict: 'judge_score_has_no_variance',
      interpretable: false,
      note: `The JUDGE's scores have almost no spread (sd ${round3(sdJudge)}). That is a fault in the judge or the rubric, not in the cheap score, and no conclusion about the cheap score can be drawn until it is fixed.`,
    };
  }

  const r = pearson(cheap, judge);
  const rho = pearson(ranks(cheap), ranks(judge));
  return {
    ...stats,
    r: round3(r),
    rho: round3(rho),
    verdict: interpretR(r),
    interpretable: true,
    note: `Pearson r = ${round3(r)}, Spearman rho = ${round3(rho)} over ${n} judged pairs. ${MEANING[interpretR(r)]}`,
  };
}

const MEANING = {
  no_relationship: 'The cheap score does not track a real evaluation. Every published quality figure downstream of it is measuring answer length and nothing else — it is noise with respect to quality, not a rough signal.',
  weak_relationship: 'The cheap score tracks a real evaluation only weakly. It is defensible as a pre-filter and is NOT defensible as a quality figure in a report.',
  moderate_relationship: 'The cheap score tracks a real evaluation moderately. Usable as a pre-filter; still not a quality judgment, and the disclosure stays.',
  strong_relationship: 'The cheap score tracks a real evaluation strongly. That would be a surprising result for a length proxy and deserves a second look at whether the judge is itself reading length.',
  inverse_relationship: 'The cheap score moves OPPOSITE to a real evaluation — longer answers are worse ones. That inverts the meaning of every threshold built on it (mood, gap tiers, escalation) and is urgent.',
};

function interpretR(r) {
  if (r === null) return 'no_relationship';
  if (r <= -0.2) return 'inverse_relationship';
  if (Math.abs(r) < 0.2) return 'no_relationship';
  if (Math.abs(r) < 0.4) return 'weak_relationship';
  if (Math.abs(r) < 0.7) return 'moderate_relationship';
  return 'strong_relationship';
}

function round3(n) { return n === null || n === undefined ? null : Math.round(n * 1000) / 1000; }

/* ═══════════════════════════════════════════════════════════════════════════
 * PERSISTENCE
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Created lazily rather than in `database/schema.sql`, the same call
 * `task-router.js PROVIDER_USAGE_TABLE_SQL` and `repo-write.js
 * REPO_WRITE_TABLE_SQL` made: a table nothing writes until a switch is flipped
 * should not become a migration everyone has to run first.
 *
 * `outcome` is why this table has rows for cases that were never judged. The
 * realized sample must be reconstructable from what is stored — "how many did
 * we select and fail to send" is not answerable from a table that only keeps
 * successes, and that question is the difference between a representative
 * sample and a convenient one.
 */
export const JUDGEMENT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS quality_judgements (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  agent_id INTEGER,
  project TEXT,
  cheap_quality REAL,
  cheap_scorer_id TEXT,
  judge_score REAL,
  judge_provider TEXT,
  judge_reason TEXT,
  outcome TEXT NOT NULL,
  sample_bucket REAL,
  selector_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * `selector_id` was added 2026-08-16, after the table already existed in
 * production (created empty ahead of the first live write). `CREATE TABLE IF
 * NOT EXISTS` does not retrofit a column onto an existing table, so the live
 * database needed:
 *
 *   ALTER TABLE quality_judgements ADD COLUMN selector_id TEXT;
 *
 * Run and read back 2026-08-16 against 0 rows. Kept here rather than in
 * `database/schema.sql` for the same reason the CREATE is (see above).
 */
export const JUDGEMENT_SELECTOR_MIGRATION_SQL = 'ALTER TABLE quality_judgements ADD COLUMN selector_id TEXT';

export const JUDGEMENT_INSERT_SQL = `INSERT INTO quality_judgements
  (id, case_id, agent_id, project, cheap_quality, cheap_scorer_id, judge_score, judge_provider, judge_reason, outcome, sample_bucket, selector_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Validates one judgement row. Pure, so the verifier exercises every refusal
 * without a database.
 */
export function buildJudgementRow({
  caseId = null, agentId = null, project = null,
  cheapQuality = null, cheapScorerId = null,
  judgeScore = null, judgeProvider = null, judgeReason = null,
  outcome, sampleBucket = null, selectorId = SELECTOR_ID,
}) {
  if (!JUDGE_OUTCOMES.includes(outcome)) {
    return { valid: false, reason: `unknown outcome "${outcome}" — add it to JUDGE_OUTCOMES rather than passing a free string` };
  }
  // A `judged` row without a score is the one shape that would corrupt the
  // correlation silently: it would be counted as a successful judgement and
  // contribute nothing, making the realized sample look larger than it is.
  if (outcome === 'judged' && (typeof judgeScore !== 'number' || Number.isNaN(judgeScore) || judgeScore < 0 || judgeScore > 1)) {
    return { valid: false, reason: `outcome "judged" requires a judge_score in [0,1], got ${JSON.stringify(judgeScore)}` };
  }
  // And the inverse: a score on a row that says it was not judged is a claim
  // that a measurement exists where it does not.
  if (outcome !== 'judged' && judgeScore !== null && judgeScore !== undefined) {
    return { valid: false, reason: `outcome "${outcome}" must carry judge_score null — a score on an unjudged row claims a measurement that was never made` };
  }
  return {
    valid: true,
    row: {
      case_id: caseId, agent_id: agentId, project,
      cheap_quality: typeof cheapQuality === 'number' ? cheapQuality : null,
      cheap_scorer_id: cheapScorerId || null,
      judge_score: outcome === 'judged' ? judgeScore : null,
      judge_provider: judgeProvider || null,
      judge_reason: judgeReason ? String(judgeReason).slice(0, 300) : null,
      outcome,
      sample_bucket: typeof sampleBucket === 'number' ? sampleBucket : null,
      selector_id: selectorId || null,
    },
  };
}

/**
 * Writes one judgement. NEVER THROWS and returns nothing a caller should branch
 * on — it sits on the live Q&A path behind `recordOfficeEvent()`, and KFM-14
 * is absolute here: a lost measurement must never cost the operation.
 */
export async function recordJudgement(env, fields) {
  try {
    if (!(await judgeSamplerEnabled(env))) return { recorded: false, reason: 'judge_sampler_disabled' };
    if (!env?.DB) return { recorded: false, reason: 'no_db_binding' };

    const built = buildJudgementRow(fields);
    if (!built.valid) {
      console.warn(`[judge-sampler] refused row: ${built.reason}`);
      return { recorded: false, reason: built.reason };
    }
    const r = built.row;
    await env.DB.prepare(JUDGEMENT_TABLE_SQL).run();
    await env.DB.prepare(JUDGEMENT_INSERT_SQL)
      .bind(crypto.randomUUID(), r.case_id, r.agent_id, r.project, r.cheap_quality, r.cheap_scorer_id,
        r.judge_score, r.judge_provider, r.judge_reason, r.outcome, r.sample_bucket, r.selector_id)
      .run();
    return { recorded: true, outcome: r.outcome };
  } catch (e) {
    console.warn(`[judge-sampler] capture failed, continuing: ${e?.message || e}`);
    return { recorded: false, reason: 'capture_error' };
  }
}

/**
 * Reads every judgement and reports the calibration. Always returns; a thin or
 * uninterpretable sample is a result, not an error.
 */
export async function runCalibration(env) {
  if (!env?.DB) return { ok: false, reason: 'no_db_binding' };
  let rows = [];
  try {
    await env.DB.prepare(JUDGEMENT_TABLE_SQL).run();
    const res = await env.DB.prepare(
      'SELECT case_id, agent_id, project, cheap_quality, cheap_scorer_id, judge_score, judge_provider, outcome, sample_bucket, selector_id, created_at FROM quality_judgements'
    ).all();
    rows = res.results || [];
  } catch (e) {
    return { ok: false, reason: `read_failed: ${e?.message || e}` };
  }

  const byOutcome = {};
  for (const o of JUDGE_OUTCOMES) byOutcome[o] = 0;
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  const judged = rows.filter((r) => r.outcome === 'judged' && typeof r.judge_score === 'number');

  // KFM-28 applied to this instrument's own population: rows chosen by
  // different selectors are not one sample. A selector determines WHICH cases
  // can appear at all, so pooling across two of them measures the selectors as
  // much as the scores. Correlate within the current selector and say so,
  // rather than pooling and carrying a caveat nobody reads (KFM-07).
  const bySelector = {};
  for (const r of judged) {
    const k = r.selector_id || 'unrecorded';
    bySelector[k] = (bySelector[k] || 0) + 1;
  }
  const selectorsPresent = Object.keys(bySelector);
  const mixedSelectors = selectorsPresent.length > 1;
  const scope = mixedSelectors ? judged.filter((r) => r.selector_id === SELECTOR_ID) : judged;
  const pairs = scope.map((r) => ({ cheap: r.cheap_quality, judge: r.judge_score }));

  return {
    ok: true,
    selectedTotal: rows.length,
    byOutcome,
    selectorId: SELECTOR_ID,
    bySelector,
    // Stated rather than left to be inferred from `bySelector`: a reader who
    // sees only `n` must not think it counted every judged row.
    correlatedOver: mixedSelectors
      ? `${SELECTOR_ID} only — ${judged.length} judged row(s) span ${selectorsPresent.length} selectors and are NOT one sample`
      : `all ${judged.length} judged row(s) (single selector)`,
    // The realized rate is what actually got sent, and it is reported next to
    // the intended one because the gap between them is the sample's honesty.
    intendedRate: JUDGE_SAMPLE_RATE,
    sendCapPerBlock: MAX_JUDGEMENTS_PER_BLOCK,
    sentFraction: rows.length ? round3(judged.length / rows.length) : null,
    calibration: correlate(pairs),
  };
}

/** Markdown for the Lead QA's weekly finding / the owner's report. */
export function renderCalibrationReport(result, { date } = {}) {
  if (!result?.ok) return `Judge calibration could not run: ${result?.reason || 'unknown error'}.`;
  const c = result.calibration;
  return [
    `## Cheap-score calibration — ${date || ''}`.trim(),
    '',
    `${result.selectedTotal} case(s) were selected for real evaluation at a declared rate of ${Math.round(result.intendedRate * 100)}% (1 in ${Math.round(1 / result.intendedRate)}), capped at ${result.sendCapPerBlock} per block by the judgment lane's 20-second unknown-cap pacing floor.`,
    '',
    '### What happened to the selected cases',
    ...JUDGE_OUTCOMES.map((o) => `- ${o}: ${result.byOutcome[o] || 0}`),
    result.sentFraction === null ? '' : `\nOf the selected cases, ${Math.round(result.sentFraction * 100)}% produced a usable judgement. The rest are listed above rather than dropped — a sample whose losses are unrecorded cannot be shown to be representative.`,
    '',
    '### Does the cheap score mean anything?',
    '',
    `**${c.verdict}** (n=${c.n}${c.r === null ? '' : `, r=${c.r}, rho=${c.rho}`})`,
    '',
    c.note,
    '',
    '> **Known bias.** Selection is by hash of the case id and is position-independent; SENDING is by pacing and is not — within a block the earliest selected case takes the only slot. The realized sample is therefore "hash-selected and early in its block". Nothing indicates position correlates with answer quality, but this is a systematic sample, not a random one.',
    '',
    '> The cheap score is deliberately still computed on every answer. It is the pre-filter; this measures whether it is worth anything, and removing it before that question is answered would leave the office with no score at all.',
  ].filter((l) => l !== '').join('\n');
}
