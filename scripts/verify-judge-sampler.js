#!/usr/bin/env node
/*
 * Dry-run verification for workers/judge-sampler.js — OB-081.
 *
 * WHAT THIS IS FOR. The cheap quality score is `min(1, characters/800)` and
 * every quality figure this office has ever published rests on it. This module
 * sends one answer in eight to a real evaluator and asks the only question that
 * matters: **does the cheap score correlate with a real one at all?**
 *
 * A calibration instrument is worth exactly as much as its own honesty, so the
 * checks that matter here are about refusals rather than results:
 *
 *   §2 the sample is REPRODUCIBLE. A random sample cannot be re-derived, so
 *      nobody can answer "why that case and not this one", and a rerun quietly
 *      measures a different population.
 *
 *   §3 the judge is never shown the cheap score, and is told length is not
 *      quality. Without the first the correlation measures anchoring; without
 *      the second it measures two length heuristics agreeing.
 *
 *   §4 a reply that cannot be parsed is REFUSED, not defaulted. A defaulted 0.5
 *      is a fabricated measurement inside the population whose entire purpose is
 *      to be trustworthy.
 *
 *   §5 the correlation refuses on no-variance rather than returning r near
 *      zero. This is the EXPECTED case — 84% of cheap scores sit at the 1.0
 *      ceiling — and "no relationship" and "this sample cannot answer the
 *      question" are different findings that look identical as a number.
 *
 *   §7 the switch is off by default and nothing is contacted while it is.
 *
 * NO NETWORK. globalThis.fetch is a tripwire that throws.
 *
 * Run: node scripts/verify-judge-sampler.js
 */

import {
  JUDGE_SAMPLER_FLAG, JUDGE_SAMPLE_RATE, MAX_JUDGEMENTS_PER_BLOCK,
  MIN_CALIBRATION_SAMPLE, MIN_CHEAP_SCORE_STDDEV, JUDGE_LANE, JUDGE_MAX_TOKENS,
  JUDGE_OUTCOMES, JUDGEMENT_TABLE_SQL, JUDGEMENT_INSERT_SQL,
  judgeSamplerEnabled, hashToUnit, isSelectedForJudging,
  buildJudgePrompt, parseJudgeVerdict, correlate,
  buildJudgementRow, recordJudgement, runCalibration, renderCalibrationReport,
} from '../workers/judge-sampler.js';
import { MIN_OUTPUT_TOKENS } from '../workers/cerebras-client.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const __vdir = nodePath.dirname(fileURLToPath(import.meta.url));
const readRepo = (rel) => readFileSync(nodePath.join(__vdir, '..', rel), 'utf8').replace(/\r\n/g, '\n');

globalThis.fetch = () => { throw new Error('TRIPWIRE: judge-sampler code must make no network call of its own'); };
if (!globalThis.crypto?.randomUUID) globalThis.crypto = { randomUUID: () => 'test-uuid' };

let passed = 0; let failed = 0;
const check = (label, cond) => {
  if (cond) { passed += 1; console.log(`[PASS] ${label}`); }
  else { failed += 1; console.log(`[FAIL] ${label}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

const fakeEnv = ({ flag, withDb = true } = {}) => {
  const writes = [];
  return {
    writes,
    SIM_KV: { get: async () => (flag === undefined ? {} : { [JUDGE_SAMPLER_FLAG]: flag }) },
    ...(withDb ? {
      DB: {
        prepare(sql) {
          return {
            bind: (...args) => ({ run: async () => { writes.push({ sql, args }); return { success: true }; } }),
            run: async () => { writes.push({ sql, args: [] }); return { success: true }; },
            all: async () => ({ results: [] }),
          };
        },
      },
    } : {}),
  };
};

/* ═══════════════════════════════════════════════════════════════════════════
 * §1  THE RATE IS DECLARED, AND THE CAP IS NOT A SECOND COUNTER
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§1 the sampling rate and the pacing cap');

check('the declared rate is 1 in 8', JUDGE_SAMPLE_RATE === 0.125);
check('the per-block send limit is 1, which is what the 20s pacing floor allows', MAX_JUDGEMENTS_PER_BLOCK === 1);
check('the lane is the judgment lane, which is free-tier — cost was never the barrier', JUDGE_LANE === 'judgment');
// The 2026-08-10 supervised test measured this: the judgment-lane model spends
// output tokens THINKING, so a small budget returns an empty string inside a
// well-formed success envelope. Asking for a 0-1 score is exactly the call that
// invites too small a budget.
check('the output budget clears the reasoning-model floor without relying on the client to rescue it',
  JUDGE_MAX_TOKENS > MIN_OUTPUT_TOKENS);

// NO SECOND COUNTER. A module-scope counter in a reused Workers isolate would
// carry one tick into the next and silently stop judging after the first call.
// The pacer is the cap, and cases it turns away are recorded.
const samplerSrc = readRepo('workers/judge-sampler.js');
const agentBaseSrc = readRepo('agents/agent-base.js');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const samplerCode = stripComments(samplerSrc);
check('MAX_JUDGEMENTS_PER_BLOCK is a declared constant and is NOT used as a live counter anywhere',
  (samplerCode.match(/MAX_JUDGEMENTS_PER_BLOCK/g) || []).length >= 1
  && !/MAX_JUDGEMENTS_PER_BLOCK\s*[<>]/.test(samplerCode)
  && !/MAX_JUDGEMENTS_PER_BLOCK/.test(stripComments(agentBaseSrc)));
check('...and a paced-out case is an explicit recorded outcome rather than an absence',
  JUDGE_OUTCOMES.includes('paced_out'));

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  THE SAMPLE IS REPRODUCIBLE
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§2 selection is deterministic, so the sample can be re-derived and audited');

check('the same case id always yields the same bucket', hashToUnit('case-42') === hashToUnit('case-42'));
check('different case ids yield different buckets', hashToUnit('case-42') !== hashToUnit('case-43'));
check('buckets are in [0,1)', [...Array(200).keys()].every((i) => {
  const b = hashToUnit(`case-${i}`);
  return b >= 0 && b < 1;
}));
check('selection is stable across calls',
  isSelectedForJudging('case-7').selected === isSelectedForJudging('case-7').selected);
check('nothing in the selection path uses Math.random', !/Math\.random/.test(samplerCode));

// The realized rate over many ids must land near the declared one. A hash that
// selected 1% or 40% would make the declared rate a fiction.
const N = 4000;
let hits = 0;
for (let i = 0; i < N; i += 1) if (isSelectedForJudging(`case-${i}`).selected) hits += 1;
const realized = hits / N;
check(`the hash actually delivers roughly the declared rate (measured ${(realized * 100).toFixed(1)}% over ${N} ids)`,
  Math.abs(realized - JUDGE_SAMPLE_RATE) < 0.02);
// FALSIFIABILITY: a different rate must change the selection, or the rate
// parameter is decorative.
let hitsHalf = 0;
for (let i = 0; i < N; i += 1) if (isSelectedForJudging(`case-${i}`, 0.5).selected) hitsHalf += 1;
check('FALSIFIABILITY: raising the rate to 50% actually selects about half', Math.abs(hitsHalf / N - 0.5) < 0.03);

/* ═══════════════════════════════════════════════════════════════════════════
 * §2b  THE RATE HOLDS ON THE ID SHAPE PRODUCTION ACTUALLY USES
 *
 * §2 above passed every day while the selector was broken, and the reason is
 * the whole point of this section: it draws `case-0`…`case-3999` — ids that
 * differ in LENGTH and in EVERY position. Production ids are
 * `qa-<year>-w<week>-d<dow>-<NNN>`, and every id the office asks in ONE DAY
 * shares a 15-character prefix and differs only in the last three digits.
 *
 * The aggregate rate over all weeks was 12.09% — correct — while the per-day
 * rate ranged from 0 to 108 out of 200. **A sample accrues one day at a time,
 * so the per-day distribution is the only one that matters**, and measuring the
 * aggregate hid the defect completely (KFM-28: a number can be right for the
 * pooled population and meaningless at the grouping actually used).
 *
 * The old expression is kept below as a CONTROL. Per this project's standard,
 * a test that describes a fix is not a test that catches a bug: §2b asserts the
 * control FAILS the same thresholds the live function must pass.
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§2b uniformity on the real case-id shape, measured PER DAY');

const dayIds = (w, d) => [...Array(200).keys()]
  .map((i) => `qa-2026-w${String(w).padStart(2, '0')}-d${d}-${String(i + 1).padStart(3, '0')}`);

/** Selected-out-of-200 for each of 260 simulated working days. */
const perDayCounts = (fn) => {
  const out = [];
  for (let w = 1; w <= 52; w += 1) {
    for (let d = 1; d <= 5; d += 1) out.push(dayIds(w, d).filter((id) => fn(id) < JUDGE_SAMPLE_RATE).length);
  }
  return out;
};
const spread = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: m, sd: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length), zero: xs.filter((x) => x === 0).length };
};

/** THE CONTROL: `hashToUnit` exactly as it stood before 2026-08-16 — FNV-1a
 *  with no finalizer, divided out of the high 32 bits. Frozen, never re-synced
 *  to the live function; if it is, this section stops proving anything. */
const hashV1 = (key) => {
  const s = String(key ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 0x100000000;
};

const live = spread(perDayCounts(hashToUnit));
const v1 = spread(perDayCounts(hashV1));
// A uniform selector over 200 ids at p=0.125 has mean 25 and sd sqrt(200*.125*.875) = 4.68.
check(`per-day mean lands near the declared rate (${live.mean.toFixed(1)} of 200, expect ~25)`,
  Math.abs(live.mean - 25) < 3);
check(`per-day spread is near-binomial (sd ${live.sd.toFixed(1)}, expect ~4.7, must stay under 10)`,
  live.sd < 10);
check(`EVERY working day has selectable cases (${live.zero} of 260 days with none)`, live.zero === 0);

check(`CONTROL: the pre-2026-08-16 hash FAILS the spread check (sd ${v1.sd.toFixed(1)})`, v1.sd >= 10);
check(`CONTROL: the pre-2026-08-16 hash left whole days unsamplable (${v1.zero} of 260)`, v1.zero > 0);
check(`CONTROL: and its per-day MEAN looked fine (${v1.mean.toFixed(1)} of 200) — which is why the aggregate check missed it`,
  Math.abs(v1.mean - 25) < 3);
// The real day the office ran on 2026-08-13: 22 distinct asks, none selectable
// under v1. Named rather than described, so a future change that reintroduces
// the defect fails on a case that actually happened.
check('CONTROL: 2026-08-13 (qa-2026-w07-d5-*) had ZERO selectable cases under the old hash',
  dayIds(7, 5).filter((id) => hashV1(id) < JUDGE_SAMPLE_RATE).length === 0);
check('and that same real day is samplable now',
  dayIds(7, 5).filter((id) => hashToUnit(id) < JUDGE_SAMPLE_RATE).length > 0);

/* ═══════════════════════════════════════════════════════════════════════════
 * §3  THE PROMPT CANNOT CONTAMINATE THE MEASUREMENT
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§3 the judge is not anchored, and is told length is not quality');

const built = buildJudgePrompt({ question: 'How do I harden SSH on Ubuntu?', answer: 'Disable password auth in sshd_config and use keys.' });
const whole = `${built.systemPrompt}\n${built.prompt}`;
check('the prompt contains the question', /harden SSH/.test(built.prompt));
check('the prompt contains the answer', /sshd_config/.test(built.prompt));
check('the prompt does NOT contain the cheap score or its formula',
  !/0\.\d\d/.test(built.prompt.replace(/0\.00|1\.00/g, '')) && !/length proxy|characters ?\/|min\(1/i.test(whole));
check('LENGTH IS NOT QUALITY is stated to the judge in as many words', /LENGTH IS NOT QUALITY/.test(built.systemPrompt));
check('...and padding is named explicitly, since that is how a length proxy is gamed',
  /padding/i.test(built.systemPrompt));
check('the rubric spans the full range with named bands', /0\.00-0\.20/.test(built.systemPrompt) && /0\.81-1\.00/.test(built.systemPrompt));
check('an exact output format is demanded, so parsing is not guesswork', /SCORE: <number/.test(built.systemPrompt));
check('a normal-sized pair is not flagged as truncated', built.truncated === false);
check('an oversized answer IS flagged rather than silently sliced',
  buildJudgePrompt({ question: 'q', answer: 'x'.repeat(50000) }).truncated === true);
check('...and the Q&A path records that case as truncated_input rather than judging a slice',
  /outcome: 'truncated_input'/.test(stripComments(agentBaseSrc)));

/* ═══════════════════════════════════════════════════════════════════════════
 * §4  AN UNPARSEABLE REPLY IS REFUSED, NEVER DEFAULTED
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§4 parseJudgeVerdict refuses rather than inventing a score');

check('a well-formed reply parses', parseJudgeVerdict('SCORE: 0.72\nREASON: correct and specific.').score === 0.72);
check('...and carries the reason', /correct and specific/.test(parseJudgeVerdict('SCORE: 0.72\nREASON: correct and specific.').reason));
check('an integer score parses', parseJudgeVerdict('SCORE: 1\nREASON: x').score === 1);
check('an empty reply is refused', parseJudgeVerdict('').ok === false);
check('a reply with no SCORE line is refused', parseJudgeVerdict('This answer looks pretty good to me.').ok === false);
check('...with a reason naming what was missing', parseJudgeVerdict('good').why === 'no_score_line');
check('a score above 1 is refused, not clamped', parseJudgeVerdict('SCORE: 7\nREASON: x').ok === false);
check('a negative score is refused', parseJudgeVerdict('SCORE: -0.2\nREASON: x').ok === false);
check('a non-string reply is refused rather than coerced', parseJudgeVerdict(null).ok === false);
check('NO DEFAULT ANYWHERE: no refusal path returns a number',
  [parseJudgeVerdict(''), parseJudgeVerdict('x'), parseJudgeVerdict('SCORE: 9')].every((v) => v.ok === false && v.score === undefined));
check('a missing REASON does not sink an otherwise valid score — the number is the measurement',
  parseJudgeVerdict('SCORE: 0.4').ok === true);

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  THE CORRELATION REFUSES WHERE IT CANNOT ANSWER
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§5 correlate() — every way this can be unanswerable is a named verdict');

const pairs = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const thin = correlate(pairs(5, (i) => ({ cheap: i / 5, judge: i / 5 })));
check('below the sample floor, NO correlation is reported', thin.verdict === 'insufficient_sample' && thin.r === null);
check('...and it is marked uninterpretable rather than merely small', thin.interpretable === false);
check('the floor is stated as a number a reader can check', MIN_CALIBRATION_SAMPLE === 20);

// THE EXPECTED CASE. The cheap score saturates: 84% of measured notebook-x
// scores sat at exactly 1.0. A sample drawn from that has no variance, and a
// correlation over it is undefined, not weak.
const saturated = correlate(pairs(30, (i) => ({ cheap: 1, judge: (i % 10) / 10 })));
check('a cheap score with no spread yields cheap_score_has_no_variance, NOT r near zero',
  saturated.verdict === 'cheap_score_has_no_variance' && saturated.r === null);
check('...and says in words that this is itself the finding', /THIS IS ITSELF THE FINDING/.test(saturated.note));
check('...and connects it to the measured 84% ceiling rate', /84%/.test(saturated.note));
check('the variance floor is a stated number', MIN_CHEAP_SCORE_STDDEV === 0.02);

const judgeFlat = correlate(pairs(30, (i) => ({ cheap: (i % 10) / 10, judge: 0.7 })));
check('a JUDGE with no spread is reported as a fault in the judge, not in the cheap score',
  judgeFlat.verdict === 'judge_score_has_no_variance');
check('...and refuses to conclude anything about the cheap score', /no conclusion about the cheap score/.test(judgeFlat.note));

// A real signal must come through, or the instrument only ever refuses.
const strong = correlate(pairs(40, (i) => ({ cheap: i / 40, judge: i / 40 + (i % 3) * 0.01 })));
check('FALSIFIABILITY: a genuinely strong relationship IS reported as one',
  strong.verdict === 'strong_relationship' && strong.interpretable === true && strong.r > 0.9);
const none = correlate(pairs(60, (i) => ({ cheap: (i % 7) / 7, judge: ((i * 13) % 11) / 11 })));
check('...and an unrelated pair of series is reported as no_relationship',
  none.verdict === 'no_relationship' && none.interpretable === true);
check('...whose meaning is spelled out as "measuring length and nothing else"',
  /measuring answer length and nothing else/.test(none.note));

// The inverse case gets its own verdict because it is the urgent one: it would
// mean every threshold built on the cheap score points the wrong way.
const inverse = correlate(pairs(40, (i) => ({ cheap: i / 40, judge: 1 - i / 40 })));
check('an INVERSE relationship has its own verdict rather than being folded into "strong"',
  inverse.verdict === 'inverse_relationship');
check('...and is described as inverting every threshold built on the score',
  /inverts the meaning of every threshold/.test(inverse.note));

// Ties. The cheap score has a huge tie block at 1.0 and naive ranking would
// invent an ordering inside it.
const tied = correlate(pairs(40, (i) => ({ cheap: i < 30 ? 1 : 0.5, judge: i < 30 ? 0.9 : 0.2 })));
check('Spearman handles the big tie block at the ceiling with average ranks rather than an invented order',
  tied.rho !== null && Math.abs(tied.rho) <= 1);
check('non-numeric pairs are dropped rather than coerced to zero',
  correlate([{ cheap: 'x', judge: 1 }, ...pairs(25, (i) => ({ cheap: i / 25, judge: i / 25 }))]).n === 25);

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  THE ROW REFUSES ANY SHAPE THAT WOULD CORRUPT THE POPULATION
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§6 buildJudgementRow()');

check('a valid judged row builds',
  buildJudgementRow({ outcome: 'judged', judgeScore: 0.6 }).valid === true);
check('an unknown outcome is refused rather than stored as a free string',
  buildJudgementRow({ outcome: 'sort_of_worked' }).valid === false);
check('outcome "judged" with NO score is REFUSED — it would inflate the realized sample with nothing in it',
  buildJudgementRow({ outcome: 'judged' }).valid === false);
check('outcome "judged" with an out-of-range score is refused',
  buildJudgementRow({ outcome: 'judged', judgeScore: 1.5 }).valid === false);
check('a score on a NON-judged row is refused — it claims a measurement that was never made',
  buildJudgementRow({ outcome: 'paced_out', judgeScore: 0.6 }).valid === false);
check('a paced_out row with no score is valid, because that is the common case by design',
  buildJudgementRow({ outcome: 'paced_out' }).valid === true);
check('a judged score of exactly 0 is a real score and is accepted',
  buildJudgementRow({ outcome: 'judged', judgeScore: 0 }).valid === true);
check('the cheap score and its scorer id are both carried, so a row is interpretable on its own',
  (() => { const r = buildJudgementRow({ outcome: 'judged', judgeScore: 0.5, cheapQuality: 0.75, cheapScorerId: 'length-proxy-v2@800' }).row;
    return r.cheap_quality === 0.75 && r.cheap_scorer_id === 'length-proxy-v2@800'; })());
check('the INSERT names one placeholder per column',
  (JUDGEMENT_INSERT_SQL.match(/\?/g) || []).length === JUDGEMENT_INSERT_SQL.match(/\(([^)]*)\)/)[1].split(',').length);
check('the table is created lazily and is deliberately absent from schema.sql',
  /CREATE TABLE IF NOT EXISTS quality_judgements/.test(JUDGEMENT_TABLE_SQL)
  && !/quality_judgements/.test(readRepo('database/schema.sql')));

/* ═══════════════════════════════════════════════════════════════════════════
 * §7  THE SWITCH — off by default, and off means nothing happens
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§7 judge_sampler_enabled, default OFF');

check('flag ABSENT -> disabled (the shipped default)', (await judgeSamplerEnabled(fakeEnv({}))) === false);
check('flag false -> disabled', (await judgeSamplerEnabled(fakeEnv({ flag: false }))) === false);
check('flag "true" as a string -> disabled (=== true, not truthiness)', (await judgeSamplerEnabled(fakeEnv({ flag: 'true' }))) === false);
check('flag true -> enabled', (await judgeSamplerEnabled(fakeEnv({ flag: true }))) === true);
check('no SIM_KV binding at all -> disabled', (await judgeSamplerEnabled({})) === false);

{
  const env = fakeEnv({});
  const r = await recordJudgement(env, { outcome: 'judged', judgeScore: 0.5 });
  check('with the flag off, recordJudgement writes NOTHING', env.writes.length === 0 && r.reason === 'judge_sampler_disabled');
}
{
  const env = fakeEnv({ flag: true });
  await recordJudgement(env, { outcome: 'judged', judgeScore: 0.5, caseId: 'c1' });
  check('with the flag on, it creates the table then writes one row', env.writes.length === 2);
  check('...and the row carries the outcome', env.writes[1].args[9] === 'judged');
}
{
  const env = { SIM_KV: { get: async () => ({ [JUDGE_SAMPLER_FLAG]: true }) }, DB: { prepare() { throw new Error('D1 exploded'); } } };
  const r = await recordJudgement(env, { outcome: 'judged', judgeScore: 0.5 });
  check('KFM-14: a throwing D1 is swallowed — a lost measurement never costs the answer', r.reason === 'capture_error');
}

check('the Q&A path calls the sampler AFTER everything else and never branches on it',
  /await this\._maybeJudgeSample\(/.test(stripComments(agentBaseSrc)));
check('...inside a try/catch that swallows, so it cannot break an answer',
  /judge sample failed, continuing/.test(agentBaseSrc));
check('...and skips entirely when the ask never reached a provider',
  /if \(notAsked\) return;/.test(stripComments(agentBaseSrc)));
check('THE CHEAP SCORE IS NOT REMOVED — it still runs on every answer',
  /lengthProxyScore\(responseText, \{ ok \}\)/.test(stripComments(agentBaseSrc))
  && /scoreWithScorer\(responseText/.test(stripComments(agentBaseSrc)));

/* ═══════════════════════════════════════════════════════════════════════════
 * §8  THE REPORT SAYS WHAT IT CANNOT SAY
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§8 renderCalibrationReport()');

const emptyCalib = await runCalibration(fakeEnv({ flag: true }));
check('calibration runs on an empty table and reports insufficient_sample rather than erroring',
  emptyCalib.ok === true && emptyCalib.calibration.verdict === 'insufficient_sample');
check('no DB binding is reported as such, not as an empty result',
  (await runCalibration({})).reason === 'no_db_binding');

const rendered = renderCalibrationReport({
  ok: true,
  selectedTotal: 40,
  byOutcome: { judged: 24, paced_out: 15, lane_error: 1, unparseable: 0, truncated_input: 0 },
  intendedRate: JUDGE_SAMPLE_RATE,
  sendCapPerBlock: MAX_JUDGEMENTS_PER_BLOCK,
  sentFraction: 0.6,
  calibration: correlate(pairs(24, (i) => ({ cheap: i / 24, judge: i / 24 }))),
}, { date: '2026-08-16' });

check('the report states the declared rate', /1 in 8/.test(rendered));
check('the report names pacing as the cap, so the sample size is not read as a choice', /pacing floor/.test(rendered));
check('every outcome is listed, including the ones that produced nothing (KFM-03)',
  JUDGE_OUTCOMES.every((o) => rendered.includes(o)));
check('the report discloses the position bias rather than leaving it to be discovered',
  /Known bias/.test(rendered) && /early in its block/.test(rendered));
check('the report says the cheap score is deliberately still computed', /deliberately still computed/.test(rendered));
check('the report leads with a verdict, not a bare number', /\*\*strong_relationship\*\*/.test(rendered));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) { console.log('Judge-sampler verification FAILED.'); process.exit(1); }
console.log('All scenarios matched expectations.');
