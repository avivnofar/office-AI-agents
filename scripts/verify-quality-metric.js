#!/usr/bin/env node
/*
 * Dry-run verification for workers/quality-metric.js and its consumers.
 *
 * WHAT THIS FILE IS FOR. `evaluateResponseQuality()` is a documented
 * length-based placeholder, and the 2026-08-16 sessions traced twelve
 * consumers downstream of it — the mood engine, gap detection, the
 * client-facing fact pack, the meeting agenda, and the Lead QA's
 * cross-embodiment comparison.
 *
 * SESSION 1 made the number honest about what it is: one scorer module,
 * `METRIC_DISCLOSURE` at every render site, and a comparison instrument that
 * REFUSES to rank providers scored by different divisors.
 *
 * SESSION 2 (OB-080) made it mean something: **the two divisors are unified at
 * 800**, a stored score must name the scorer that produced it, and the
 * comparison instrument now STRATIFIES by scorer so it can produce a real
 * comparison instead of only declining one.
 *
 * The checks that actually matter, and the reason for each:
 *
 *   §1 proves the unification is EXACTLY what it claims: data-center scores did
 *      not move at all, notebook-x scores moved down by exactly 25% below the
 *      ceiling, and no caller can change the scale by naming a project. The
 *      last is asserted as a PROPERTY, not by grepping for the word `project`
 *      (KFM-04c).
 *
 *   §2 proves history is still readable. 134 rows predate the `scorer_id`
 *      column; if their scorer could not be recovered, unifying would have
 *      destroyed the ability to interpret them, which is worse than the
 *      confound it fixes.
 *
 *   §4 proves the confound gate is FALSIFIABLE in BOTH directions. A gate that
 *      refuses everything is not a gate, it is an outage. So §4 feeds the
 *      instrument three shapes: the real historical one (must refuse the
 *      pooled ranking AND still compare within a scale), a purely
 *      post-unification one (must not refuse at all — this is the proof the
 *      confound is gone going forward), and a same-scorer gap (must rank).
 *
 *   §8 proves the write gate: a score may not be stored without naming its
 *      scorer. That is the rule whose absence let two divisors run for four
 *      weeks.
 *
 * NO NETWORK. `globalThis.fetch` is a tripwire that throws — none of the code
 * under test may call out, and that is proven rather than claimed. D1 is a
 * recording fake, same technique as verify-improvement-loop.js.
 *
 * Run: node scripts/verify-quality-metric.js
 */

import {
  SCORER_ID, UNIFIED_DIVISOR, UNIFIED_FROM, UNIFIED_FROM_ISO,
  LEGACY_DIVISORS, LEGACY_SCORER_PREFIX, DEFAULT_DIVISOR,
  METRIC_DISCLOSURE, metricDisclosureFor, DIVISOR_UNIFICATION_NOTE,
  lengthProxyScore, scoreWithScorer, scorerForRow, divisorOfScorerId,
  scoresAreComparable, saturationOf,
} from '../workers/quality-metric.js';
import { runCrossEmbodimentComparison, renderComparisonFinding } from '../workers/embodiment-comparison.js';
import { renderGapDigest, detectCapabilityGap } from '../workers/gap-reports.js';
import { buildOfficeEventRow } from '../workers/improvement-loop.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const __vdir = nodePath.dirname(fileURLToPath(import.meta.url));
// Normalised at read time: core.autocrlf=true checks these files out with CRLF
// on the owner's machine and with LF in CI, and a source-text assertion that
// depends on which is a KFM-04b failure waiting to happen.
const readRepo = (rel) => readFileSync(nodePath.join(__vdir, '..', rel), 'utf8').replace(/\r\n/g, '\n');

globalThis.fetch = () => { throw new Error('TRIPWIRE: quality-metric code must make no network call'); };

let passed = 0; let failed = 0;
const check = (label, cond) => {
  if (cond) { passed += 1; console.log(`[PASS] ${label}`); }
  else { failed += 1; console.log(`[FAIL] ${label}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

/* ═══════════════════════════════════════════════════════════════════════════
 * §1  THE UNIFICATION — one divisor, and exactly the movement claimed
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§1 OB-080: one divisor, 800, and the movement is exactly what the note says');

// The two formulas as they existed BEFORE 2026-08-16's second session.
const OLD_DATA_CENTER = (text, ok) => (!ok || !text ? 0 : Math.min(1, text.length / 800));
const OLD_NOTEBOOK_X = (text, found) => (found ? Math.min(1, text.length / 600) : 0);

const SWEEP = [0, 1, 17, 300, 599, 600, 601, 700, 799, 800, 801, 2000, 50000];

let dcUnchanged = true; let nbDiverges = false; let nbRatioHolds = true;
for (const len of SWEEP) {
  const text = 'x'.repeat(len);
  const now = lengthProxyScore(text, { ok: true });

  // data-center was ALWAYS /800. Unifying onto 800 must not have moved a single
  // one of its scores — that is a large part of why 800 was the value kept.
  if (now !== OLD_DATA_CENTER(text, true)) dcUnchanged = false;

  // notebook-x DID move, and the change is disclosed rather than silent.
  const old = OLD_NOTEBOOK_X(text, true);
  if (now !== old) nbDiverges = true;
  // Below both ceilings the new score is exactly 75% of the old one.
  if (len > 0 && len < 600 && Math.abs(now - old * 0.75) > 1e-12) nbRatioHolds = false;
}
check('data-center scores did NOT move — identical to the pre-unification /800 formula at every length', dcUnchanged);
check('notebook-x scores DID move — the change is real and is not being hidden', nbDiverges);
check('and the movement is exactly the ratio the note states: a notebook-x score is now 75% of what it was', nbRatioHolds);

check('the surviving divisor is 800', UNIFIED_DIVISOR === 800);
check('a failed call still scores 0, as before', lengthProxyScore('a'.repeat(900), { ok: false }) === 0);
check('empty response still scores 0, as before', lengthProxyScore('', { ok: true }) === 0);

// THE PROPERTY, not the spelling (KFM-04c). Naming a project must be incapable
// of changing the scale — that is what "unified" means, and a check that greps
// for the word `project` would go green the moment someone renamed the field.
let projectIsInert = true;
for (const len of SWEEP) {
  const t = 'x'.repeat(len);
  const a = lengthProxyScore(t, { ok: true });
  for (const p of ['data-center', 'notebook-x', 'some-future-project', null, undefined]) {
    if (lengthProxyScore(t, { ok: true, project: p }) !== a) projectIsInert = false;
  }
}
check('PROPERTY: naming any project cannot change the score — the scale is not selectable by a caller', projectIsInert);

// THE SATURATION ARGUMENT that decided 800 over 600, asserted as arithmetic
// rather than left as a claim in a comment.
let subsetHolds = true; let strictlySmaller = false;
for (const len of SWEEP) {
  const t = 'x'.repeat(len);
  const satNew = lengthProxyScore(t, { ok: true }) >= 1;
  const satOld = OLD_NOTEBOOK_X(t, true) >= 1;
  if (satNew && !satOld) subsetHolds = false;      // must never saturate at 800 but not at 600
  if (!satNew && satOld) strictlySmaller = true;   // and must sometimes be strictly better
}
check('SATURATION: every answer that hits the ceiling at 800 also hit it at 600 — the ceiling set only shrank', subsetHolds);
check('...and it strictly shrank: answers in [600,800) now carry information where they used to be pinned at 1.0', strictlySmaller);

// The score and the name of what produced it come out together.
const sw = scoreWithScorer('x'.repeat(400), { ok: true });
check('scoreWithScorer returns the number and the scorer id together', sw.quality === 0.5 && sw.scorerId === SCORER_ID);
check('the scorer id carries its divisor in its own name, so comparison needs no lookup table',
  divisorOfScorerId(SCORER_ID) === UNIFIED_DIVISOR);
check('divisorOfScorerId returns null rather than a guess for an id it cannot parse',
  divisorOfScorerId('something-else') === null && divisorOfScorerId(null) === null);

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  HISTORY IS STILL READABLE — the 134 rows that predate scorer_id
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§2 scorerForRow(): a recorded scorer wins, and an old row is still interpretable');

const recorded = scorerForRow({ project: 'notebook-x', scoredAt: '2026-08-01 05:00:00', scorerId: SCORER_ID });
check('a recorded scorer_id is authoritative and beats anything the date would infer',
  recorded.scorerId === SCORER_ID && recorded.divisor === 800 && recorded.source === 'recorded');

const legacyNb = scorerForRow({ project: 'notebook-x', scoredAt: '2026-08-11 06:31:43' });
check('a pre-unification notebook-x row is attributed to the /600 scorer',
  legacyNb.divisor === 600 && legacyNb.scorerId === `${LEGACY_SCORER_PREFIX}@600` && legacyNb.era === 'legacy');
const legacyDc = scorerForRow({ project: 'data-center', scoredAt: '2026-08-11 05:01:37' });
check('a pre-unification data-center row is attributed to the /800 scorer',
  legacyDc.divisor === 800 && legacyDc.scorerId === `${LEGACY_SCORER_PREFIX}@800`);
check('both are reported as INFERRED, not recorded — weaker evidence, counted separately (KFM-13)',
  legacyNb.source === 'inferred' && legacyDc.source === 'inferred');

check('a post-unification row is the unified scorer whatever its project (notebook-x)',
  scorerForRow({ project: 'notebook-x', scoredAt: '2026-08-16 05:00:00' }).divisor === 800);
check('a post-unification row is the unified scorer whatever its project (data-center)',
  scorerForRow({ project: 'data-center', scoredAt: '2026-08-20 05:00:00' }).scorerId === SCORER_ID);

// The boundary itself. Inclusive at UNIFIED_FROM, and one second earlier is legacy.
check('the boundary is inclusive: a row stamped exactly at UNIFIED_FROM is unified',
  scorerForRow({ project: 'notebook-x', scoredAt: UNIFIED_FROM }).divisor === 800);
check('one second before the boundary is still legacy',
  scorerForRow({ project: 'notebook-x', scoredAt: '2026-08-15 23:59:59' }).divisor === 600);
check('an ISO timestamp is read the same way as a SQLite one',
  scorerForRow({ project: 'notebook-x', scoredAt: '2026-08-11T06:31:43Z' }).divisor === 600);

check('no timestamp and no scorer_id is UNKNOWN, not a default (KFM-13)',
  scorerForRow({ project: 'notebook-x' }).source === 'unknown'
  && scorerForRow({ project: 'notebook-x' }).divisor === null);
check('a pre-unification row on an undeclared project reports divisor null with a reason, NOT 800',
  scorerForRow({ project: 'mars', scoredAt: '2026-08-01 05:00:00' }).divisor === null
  && /no declared legacy divisor/.test(scorerForRow({ project: 'mars', scoredAt: '2026-08-01 05:00:00' }).reason));
check('the legacy divisor table still holds exactly the two formulas that ran',
  LEGACY_DIVISORS['data-center'] === 800 && LEGACY_DIVISORS['notebook-x'] === 600);
check('DEFAULT_DIVISOR is retained at 800 and is no longer reachable as a silent fallback',
  DEFAULT_DIVISOR === 800);

/* ═══════════════════════════════════════════════════════════════════════════
 * §3  COMPARABILITY — keyed on the DIVISOR, not on a version string
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§3 scoresAreComparable()');

const S = (id) => ({ scorerId: id, divisor: divisorOfScorerId(id) });

check('legacy /600 and unified /800 are NOT comparable',
  scoresAreComparable([S(`${LEGACY_SCORER_PREFIX}@600`), S(SCORER_ID)]).comparable === false);
check('the refusal names both scorers and both divisors so a reader can see the size of the effect',
  /length-proxy-v1@600=600/.test(scoresAreComparable([S(`${LEGACY_SCORER_PREFIX}@600`), S(SCORER_ID)]).reason)
  && /length-proxy-v2@800=800/.test(scoresAreComparable([S(`${LEGACY_SCORER_PREFIX}@600`), S(SCORER_ID)]).reason));
check('legacy /800 and unified /800 ARE comparable — identical arithmetic, and refusing them would throw away real evidence to honour a version string',
  scoresAreComparable([S(`${LEGACY_SCORER_PREFIX}@800`), S(SCORER_ID)]).comparable === true);
check('one scorer compared with itself IS comparable', scoresAreComparable([S(SCORER_ID), S(SCORER_ID)]).comparable === true);
check('an empty set is refused as could-not-check, NOT accepted as trivially matching (KFM-13)',
  scoresAreComparable([]).comparable === false && scoresAreComparable([]).reason === 'no_scorer_recorded');
check('a group whose divisor could not be established is refused as unknown_divisor, not assumed to match',
  scoresAreComparable([S(SCORER_ID), { scorerId: 'length-proxy-v1@unknown', divisor: null }]).comparable === false
  && /unknown_divisor/.test(scoresAreComparable([S(SCORER_ID), { scorerId: 'length-proxy-v1@unknown', divisor: null }]).reason));

section('§3b saturationOf() — where the metric stops carrying information');
const sat = saturationOf([1, 1, 1, 0.5]);
check('saturation counts scores at the ceiling', sat.saturated === 3 && sat.n === 4 && sat.fraction === 0.75);
check('saturation note names the ceiling in words', /ceiling/.test(sat.note));
check('no saturation produces no note rather than a note saying zero', saturationOf([0.2, 0.3]).note === null);
check('an empty set reports fraction null, not 0', saturationOf([]).fraction === null);

/* ═══════════════════════════════════════════════════════════════════════════
 * §4  THE INSTRUMENT — refuses a pooled ranking, and STILL produces a comparison
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§4 the cross-embodiment comparison: refuses the pooled table, compares within a scale');

const fakeDb = (rows) => ({
  prepare: () => ({ all: async () => ({ results: rows }) }),
});

// (a) THE REAL HISTORICAL SHAPE, as it stands in live D1: every row predates
// the scorer_id column, claude serves only data-center (/800), gemini and
// cloudflare-fallback only notebook-x (/600).
const row = (n, o) => Array.from({ length: n }, () => ({ scorer_id: null, ...o }));
const historical = [
  ...row(10, { agent_id: 1, project: 'data-center', embodiment_model: 'claude', quality: 0.421, created_at: '2026-08-11 05:01:37' }),
  ...row(19, { agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.879, created_at: '2026-08-09 05:02:09' }),
  ...row(66, { agent_id: 3, project: 'notebook-x', embodiment_model: 'gemini', quality: 0.85, created_at: '2026-08-11 06:31:43' }),
];
const hist = await runCrossEmbodimentComparison({ DB: fakeDb(historical) });
const histKinds = hist.findings.map((f) => f.kind);

check('the historical shape still REFUSES the pooled ranking', histKinds.includes('comparison_refused_confounded'));
const refusal = hist.findings.find((f) => f.kind === 'comparison_refused_confounded');
check('and the refusal now names a HISTORICAL boundary with a date, not a standing property of the office',
  refusal.text.includes(UNIFIED_FROM_ISO) && /ROWS WRITTEN BEFORE/.test(refusal.text));
check('the refusal still states plainly that this is not evidence about either provider',
  /NOT evidence about either provider/.test(refusal.text));
check('the refusal carries the dated unification note', refusal.text.includes(DIVISOR_UNIFICATION_NOTE));

// THE POINT OF THE CHANGE: it no longer only declines. gemini (n=66) and
// cloudflare-fallback (n=19) are BOTH /600, so that comparison is legitimate
// and is now made — and the answer is that the 0.879-vs-0.421 "gap" evaporates.
check('AND it now produces a real within-scorer comparison instead of only a refusal',
  histKinds.includes('embodiment_no_gap_on_one_scale') || histKinds.includes('embodiment_quality_gap'));
const onScale = hist.findings.find((f) => f.kind === 'embodiment_no_gap_on_one_scale');
check('on the one scale where two providers can actually be compared, gemini and cloudflare-fallback show NO gap',
  !!onScale && /gemini/.test(onScale.text) && /cloudflare-fallback/.test(onScale.text));
check('and that result is labelled a comparison rather than a refusal',
  !!onScale && /is a comparison, not a refusal/.test(onScale.text));
check('the /800 stratum is reported as too thin rather than silently dropped',
  histKinds.includes('stratum_sample_too_thin'));

// FOUND BY RUNNING IT, not by review: the first live run printed the CURRENT
// divisor (800) in the disclosure attached to a group of rows scored at 600 —
// a caveat that misdescribed the numbers it sat under. A disclosure about the
// wrong rows is worse than none.
check('a stratum finding carries the disclosure for ITS OWN divisor, not the current one',
  /answer_characters \/ 600/.test(onScale.text) && !/answer_characters \/ 800/.test(onScale.text));
check('...and names its own scorer, not the current one',
  /scorer `length-proxy-v1@600`/.test(onScale.text) && !onScale.text.includes(`scorer \`${SCORER_ID}\``));
check('metricDisclosureFor says UNESTABLISHED rather than inventing a divisor it does not have',
  /UNESTABLISHED divisor/.test(metricDisclosureFor(null, 'length-proxy-v1@unknown')));
check('every row is attributed, and the inferred ones are counted separately from recorded ones',
  hist.scorerAttribution.inferred === 95 && hist.scorerAttribution.recorded === 0 && hist.scorerAttribution.unattributed === 0);
check('the strata are named on the result', hist.scorerStrata.includes('length-proxy-v1@600') && hist.scorerStrata.includes('length-proxy-v1@800'));

// (b) THE PROOF THE CONFOUND IS GONE GOING FORWARD. Same providers, same
// projects, same gap — but every row carries the unified scorer. There must be
// NO refusal at all: if this ever starts refusing, unification achieved nothing.
const postUnification = [
  ...row(10, { agent_id: 1, project: 'data-center', embodiment_model: 'claude', quality: 0.421, created_at: '2026-08-20 05:01:37', scorer_id: SCORER_ID }),
  ...row(19, { agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.879, created_at: '2026-08-20 05:02:09', scorer_id: SCORER_ID }),
];
const post = await runCrossEmbodimentComparison({ DB: fakeDb(postUnification) });
const postKinds = post.findings.map((f) => f.kind);
check('CONFOUND GONE: a purely post-unification dataset is NOT refused, even across projects',
  !postKinds.includes('comparison_refused_confounded'));
check('...and it produces the ranking it could never produce before', postKinds.includes('embodiment_quality_gap'));
check('...on rows whose scorer is RECORDED rather than inferred',
  post.scorerAttribution.recorded === 29 && post.scorerAttribution.inferred === 0);
const gapFinding = post.findings.find((f) => f.kind === 'embodiment_quality_gap');
check('the permitted finding names the scorer it rests on', gapFinding.text.includes(SCORER_ID));
check('and says in words that it is not a divisor artifact', /not a divisor artifact/.test(gapFinding.text));

// (c) FALSIFIABILITY IN THE OTHER DIRECTION: a sub-threshold gap on one scale
// must NOT be reported as a gap. If this fails, the instrument reports a gap
// for everything and means nothing.
const smallGap = [
  ...row(10, { agent_id: 1, project: 'notebook-x', embodiment_model: 'claude', quality: 0.85, created_at: '2026-08-20 05:00:00', scorer_id: SCORER_ID }),
  ...row(19, { agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.879, created_at: '2026-08-20 05:00:00', scorer_id: SCORER_ID }),
];
const small = await runCrossEmbodimentComparison({ DB: fakeDb(smallGap) });
check('FALSIFIABILITY: a sub-threshold gap on one scale reports no gap',
  !small.findings.map((f) => f.kind).includes('embodiment_quality_gap'));

check('each embodiment group carries the scorer(s) that produced its numbers',
  hist.byEmbodiment.every((e) => Array.isArray(e.scorers) && e.scorers.length > 0));
check('each embodiment group carries its saturation',
  hist.byEmbodiment.every((e) => typeof e.saturation?.n === 'number'));

// A provider that served BOTH projects before unification has an internally
// incomparable average, and only the per-row scorer can show that.
const mixedProvider = [
  ...row(6, { agent_id: 1, project: 'data-center', embodiment_model: 'groq', quality: 0.4, created_at: '2026-08-10 05:02:11' }),
  ...row(6, { agent_id: 1, project: 'notebook-x', embodiment_model: 'groq', quality: 1.0, created_at: '2026-08-10 05:01:35' }),
  ...row(8, { agent_id: 2, project: 'notebook-x', embodiment_model: 'gemini', quality: 0.9, created_at: '2026-08-11 06:31:43' }),
];
const mixed = await runCrossEmbodimentComparison({ DB: fakeDb(mixedProvider) });
const groqGroup = mixed.byEmbodiment.find((e) => e.embodiment_model === 'groq');
check('a provider whose own rows span two scorers is shown as spanning two scorers',
  groqGroup.scorers.length === 2);
check('and the renderer says its average is not interpretable on its own',
  /not interpretable on its own/.test(renderComparisonFinding(mixed, { date: '2026-08-16' })));

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  EVERY RENDER SITE CARRIES THE DISCLOSURE
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§5 no render site prints a quality number without saying what it is');

const rendered = renderComparisonFinding(hist, { date: '2026-08-16' });
check('the comparison finding prints the disclosure', rendered.includes(METRIC_DISCLOSURE));
// lastIndexOf, not indexOf: the disclosure legitimately appears EARLIER too,
// inside a finding's own text, and asserting on the first occurrence measured
// that instead. What this check is for is the closing copy under the averages.
check('the disclosure appears BELOW the numbers, where a reader who just read an average is',
  rendered.indexOf('By embodiment') < rendered.lastIndexOf(METRIC_DISCLOSURE));
// Asserted as a PROPERTY rather than by looking for the current disclosure
// string: a finding about 600-divisor rows must carry the 600 disclosure, so
// searching for METRIC_DISCLOSURE inside it would demand the WRONG sentence.
// What must hold is that every finding stating an average carries a disclosure
// of its own, so a reader quoting just that line still carries one.
const findingsWithAverages = hist.findings.filter((f) => /avg \d/.test(f.text));
check('every finding that states an average carries a disclosure of its own',
  findingsWithAverages.length > 0
  && findingsWithAverages.every((f) => /LENGTH PROXY/.test(f.text) || f.text.includes(DIVISOR_UNIFICATION_NOTE)));
check('the rendered finding names the scoring project beside each average',
  /scored on project\(s\)/.test(rendered));
check('the rendered finding names the SCORER beside each average — the axis that decides comparability',
  /by scorer\(s\)/.test(rendered));
check('the render declares how many rows had their scorer inferred rather than recorded',
  /predate the scorer_id column/.test(rendered));

const runnerSrc = readRepo('workers/agent-runner.js');
check('the client-facing fact pack imports the disclosure',
  /import \{ METRIC_DISCLOSURE \} from '\.\/quality-metric\.js'/.test(runnerSrc));
check('the fact pack attaches the disclosure to its quality averages',
  /QUALITY CAVEAT[\s\S]{0,120}METRIC_DISCLOSURE/.test(runnerSrc));
check('the fact pack prints the caveat ONLY when an average is present, so it never appears orphaned',
  /anyQuality \? ` QUALITY CAVEAT/.test(runnerSrc));

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  KFM-06 — the gap digest reports HARD and SOFT apart
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§6 the gap digest reports HARD and SOFT apart');

const digest = renderGapDigest('notebook-x', '2026-08-16', [
  { agent_name: 'The QA', title: 'case-1', content: 'טקסט', severity: 'hard' },
  { agent_name: 'The Trainee', title: 'case-2', content: 'טקסט', severity: 'soft' },
  { agent_name: 'The Productive', title: 'case-3', content: 'טקסט', severity: 'soft' },
  { agent_name: 'The Standard Agent', title: 'case-4', content: 'טקסט', severity: 'info' },
]);
check('the headline counts HARD separately', /1 HARD/.test(digest));
check('the headline counts SOFT separately', /2 SOFT/.test(digest));
check('pre-2026-08-16 rows are counted as unclassified, not folded into a tier',
  /1 unclassified/.test(digest));
check('the headline no longer claims N "genuine capability gaps" as one merged number',
  !/genuine capability gap/.test(digest));
check('the digest says in words that the two tiers are not summed',
  /deliberately not summed/.test(digest));
check('the digest explains that a SOFT gap means SHORT, not wrong', /means the answer was SHORT/.test(digest));
check('the digest carries the metric disclosure', digest.includes(METRIC_DISCLOSURE));
check('each entry is labelled with its own tier', /— HARD\n/.test(digest) && /— SOFT\n/.test(digest) && /— UNCLASSIFIED\n/.test(digest));

check('detectCapabilityGap still returns kind hard for a failed request',
  detectCapabilityGap({ project: 'data-center', ok: false }).kind === 'hard');
check('detectCapabilityGap still returns kind soft for a low score',
  detectCapabilityGap({ project: 'data-center', ok: true, quality: 0.2 }).kind === 'soft');
check('detectCapabilityGap still returns no kind for an ordinary answer',
  detectCapabilityGap({ project: 'data-center', ok: true, quality: 0.9 }).kind === null);

const agentBase = readRepo('agents/agent-base.js');
// COMMENTS STRIPPED BEFORE MATCHING (KFM-04c): an earlier run of this verifier
// failed against a COMMENT that quotes the old expression while explaining that
// it was removed. Strip first, then assert.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const agentBaseCode = stripComments(agentBase);
check('the gap kind is passed to fileGapReport rather than discarded',
  /this\.fileGapReport\(project, caseId, hebrewText, gap\.kind\)/.test(agentBaseCode));
check('fileGapReport stores the kind rather than a hardcoded severity',
  /kind === 'hard' \|\| kind === 'soft' \? kind : 'info'/.test(agentBaseCode));
check('the digest query selects severity so the tier survives the round trip',
  /r\.severity/.test(readRepo('workers/gap-reports.js')));

section('§6b there is exactly one scorer, and agent-base.js calls it');
check('no inline `/ 600` computes a score in agent-base.js',
  !/Math\.min\(1,\s*responseText\.length\s*\/\s*600\)/.test(agentBaseCode));
check('no inline `/ 800` computes a score in agent-base.js',
  !/Math\.min\(1,\s*responseText\.length\s*\/\s*800\)/.test(agentBaseCode));
check('...and the comment-stripper actually strips — proven by asserting the quoted expression IS still present in the raw file',
  /Math\.min\(1,\s*responseText\.length\s*\/\s*600\)/.test(agentBase));
check('agent-base.js imports the one scorer', /from '\.\.\/workers\/quality-metric\.js'/.test(agentBaseCode));
check('_askNotebookX() routes through scoreWithScorer so the id travels with the number',
  /scoreWithScorer\(responseText, \{ ok: true \}\)/.test(agentBaseCode));
check('evaluateResponseQuality() routes through lengthProxyScore with no project argument',
  /lengthProxyScore\(responseText, \{ ok \}\)/.test(agentBaseCode));
check('the capability-manifest symbol name is unchanged, so the capability stays SUPPLIED',
  /async evaluateResponseQuality\(/.test(agentBaseCode)
  && /AgentBase#evaluateResponseQuality/.test(readRepo('config/capability-manifest.json')));
check('both ask paths return a scorerId alongside the quality',
  /scorerId: scored\.scorerId/.test(agentBaseCode) && /scorerId: SCORER_ID, response: responseText, source: 'claude'/.test(agentBaseCode));
check('the capture line forwards the scorerId to the improvement loop',
  /scorerId: notAsked \? null : \(result\?\.scorerId \|\| null\)/.test(agentBaseCode));

/* ═══════════════════════════════════════════════════════════════════════════
 * §7  THE DISCLOSURE ITSELF IS HONEST
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§7 the disclosure says the thing that matters');

check('it names the formula', /answer_characters \/ 800/.test(METRIC_DISCLOSURE));
check('it names ONE divisor now, and the two-divisor sentence has moved into the dated note',
  METRIC_DISCLOSURE.includes(String(UNIFIED_DIVISOR)) && METRIC_DISCLOSURE.includes(DIVISOR_UNIFICATION_NOTE));
check('it states that no model reads the question or answer', /No model reads the question/.test(METRIC_DISCLOSURE));
check('it states the failure mode in plain words', /A long wrong answer outscores a short right one/.test(METRIC_DISCLOSURE));
check('it names the scorer version, so a future formula change is distinguishable',
  METRIC_DISCLOSURE.includes(SCORER_ID));
check('the dated note carries the date from which scores are comparable',
  DIVISOR_UNIFICATION_NOTE.includes(UNIFIED_FROM_ISO)
  && /comparable across projects only from that date forward/.test(DIVISOR_UNIFICATION_NOTE));
check('the dated note states that history was NOT rescored (A15)',
  /NOT rescored/.test(DIVISOR_UNIFICATION_NOTE));
check('the dated note names the old divisors so the size of the change is legible',
  /800/.test(DIVISOR_UNIFICATION_NOTE) && /600/.test(DIVISOR_UNIFICATION_NOTE) && /33%/.test(DIVISOR_UNIFICATION_NOTE));

/* ═══════════════════════════════════════════════════════════════════════════
 * §8  THE WRITE GATE — a score may not be stored without naming its scorer
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§8 buildOfficeEventRow refuses an unlabelled score');

const base = { agentId: 1, eventType: 'case_answer', track: 'client' };
const unlabelled = buildOfficeEventRow({ ...base, quality: 0.9 });
check('a scored row with NO scorerId is REFUSED', unlabelled.valid === false);
check('and the refusal explains why rather than just saying invalid',
  /four weeks undetected/.test(unlabelled.reason));
const labelled = buildOfficeEventRow({ ...base, quality: 0.9, scorerId: SCORER_ID });
check('a scored row WITH a scorerId is accepted', labelled.valid === true);
check('and the id is written to the row', labelled.row.scorer_id === SCORER_ID);

// FALSIFIABILITY: the gate must not refuse everything. An unscored row has no
// scorer and must still be accepted, or every meeting/refusal row breaks.
const unscored = buildOfficeEventRow({ agentId: 6, eventType: 'meeting', track: 'office' });
check('FALSIFIABILITY: an UNSCORED row is still accepted with no scorerId', unscored.valid === true);
check('...and carries scorer_id null rather than an invented one', unscored.row.scorer_id === null);
check('a quality of 0 is a real score and still requires a scorer',
  buildOfficeEventRow({ ...base, quality: 0 }).valid === false);
check('a scorerId supplied on an unscored row is not written — no scorer without a score',
  buildOfficeEventRow({ agentId: 6, eventType: 'meeting', track: 'office', scorerId: SCORER_ID }).row.scorer_id === null);

check('the INSERT names the scorer_id column',
  /scorer_id/.test(readRepo('workers/improvement-loop.js').match(/OFFICE_EVENT_INSERT_SQL = `[\s\S]*?`/)[0]));
check('the schema documents the column and that history is not backfilled',
  /scorer_id TEXT/.test(readRepo('database/schema.sql'))
  && /stay NULL/.test(readRepo('database/schema.sql')));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) { console.log('Quality-metric verification FAILED.'); process.exit(1); }
console.log('All scenarios matched expectations.');
