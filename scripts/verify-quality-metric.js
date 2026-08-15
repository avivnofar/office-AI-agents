#!/usr/bin/env node
/*
 * Dry-run verification for workers/quality-metric.js and the four consumers
 * rewired to it on 2026-08-16.
 *
 * WHAT THIS FILE IS FOR. `evaluateResponseQuality()` is a documented
 * length-based placeholder, and this session traced twelve consumers
 * downstream of it — the mood engine, gap detection, the client-facing fact
 * pack, the meeting agenda, and the Lead QA's cross-embodiment comparison.
 * The placeholder was not replaced (see §1 and the module header for why).
 * What changed is that it can no longer be PRESENTED as a quality judgment
 * without saying what it is, and the one instrument that drew a provider
 * conclusion from it now refuses to.
 *
 * The two checks that actually matter, and the reason for each:
 *
 *   §1 proves NO SCORE MOVED. The whole risk of centralising two formulas is
 *      that one of them quietly changes and every historical average becomes
 *      incomparable to every future one. So the old expressions are written
 *      out literally here and asserted equal to the new function across a
 *      sweep of lengths, including both ceilings.
 *
 *   §4 proves the confound gate is FALSIFIABLE. A gate that refuses
 *      everything is not a gate, it is an outage — the same lesson
 *      verify-gate-call-audit.js §5 records about RETIRED verdicts. So §4
 *      feeds the instrument two shapes: the real confounded one (must refuse)
 *      and a same-project one (must still rank). If either half stops holding,
 *      the gate is worthless in one direction or the other.
 *
 * NO NETWORK. `globalThis.fetch` is a tripwire that throws — none of the code
 * under test may call out, and that is proven rather than claimed. D1 is a
 * recording fake, same technique as verify-improvement-loop.js.
 *
 * Run: node scripts/verify-quality-metric.js
 */

import {
  SCORER_ID, LENGTH_PROXY_DIVISORS, DEFAULT_DIVISOR, METRIC_DISCLOSURE,
  scorerForProject, lengthProxyScore, scoresAreComparable, saturationOf,
} from '../workers/quality-metric.js';
import { runCrossEmbodimentComparison, renderComparisonFinding } from '../workers/embodiment-comparison.js';
import { renderGapDigest, detectCapabilityGap } from '../workers/gap-reports.js';

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
 * §1  NO SCORE MOVED — the formulas are byte-identical to what they replaced
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§1 the two historical formulas are preserved exactly');

// Written out as they existed before 2026-08-16. agent-base.js
// evaluateResponseQuality() and the inline expression at agent-base.js:734.
const OLD_DATA_CENTER = (text, ok) => (!ok || !text ? 0 : Math.min(1, text.length / 800));
const OLD_NOTEBOOK_X = (text, found) => (found ? Math.min(1, text.length / 600) : 0);

let dcMatches = true; let nbMatches = true;
// Sweep across both ceilings (600 and 800) and past them, plus the empty case.
for (const len of [0, 1, 17, 300, 599, 600, 601, 799, 800, 801, 2000, 50000]) {
  const text = 'x'.repeat(len);
  if (lengthProxyScore(text, { project: 'data-center', ok: true }) !== OLD_DATA_CENTER(text, true)) dcMatches = false;
  if (lengthProxyScore(text, { project: 'notebook-x', ok: true }) !== OLD_NOTEBOOK_X(text, true)) nbMatches = false;
}
check('data-center scores are identical to the pre-2026-08-16 /800 formula at every length', dcMatches);
check('notebook-x scores are identical to the pre-2026-08-16 /600 formula at every length', nbMatches);
check('a failed call still scores 0, as before', lengthProxyScore('a'.repeat(900), { project: 'data-center', ok: false }) === 0);
check('empty response still scores 0, as before', lengthProxyScore('', { project: 'data-center', ok: true }) === 0);

// The divergence itself, asserted as a fact rather than left in a comment:
// this is the number that made a fallback provider outrank the primary.
const sameText = 'x'.repeat(600);
check('THE DIVERGENCE: the same 600-char answer scores 1.0 on notebook-x and 0.75 on data-center',
  lengthProxyScore(sameText, { project: 'notebook-x' }) === 1
  && lengthProxyScore(sameText, { project: 'data-center' }) === 0.75);

check('an unknown project reports declared:false rather than silently claiming the default is its divisor',
  scorerForProject('some-future-project').declared === false
  && scorerForProject('some-future-project').divisor === DEFAULT_DIVISOR);
check('a known project reports declared:true', scorerForProject('notebook-x').declared === true
  && scorerForProject('notebook-x').divisor === 600);

/* ═══════════════════════════════════════════════════════════════════════════
 * §2  THE INLINE SECOND FORMULA IS GONE FROM agent-base.js
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§2 there is exactly one scorer, and agent-base.js calls it');

const agentBase = readRepo('agents/agent-base.js');

// COMMENTS STRIPPED BEFORE MATCHING, and the first run of this verifier is why:
// the check below failed against a COMMENT that quotes the old expression while
// explaining that it was removed. A source-text check that cannot tell code
// from prose about code reports the opposite of the truth — and it would have
// gone green again the moment someone deleted the explanation. Strip first,
// then assert.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const agentBaseCode = stripComments(agentBase);
check('the inline `/ 600` literal no longer computes a score in agent-base.js',
  !/Math\.min\(1,\s*responseText\.length\s*\/\s*600\)/.test(agentBaseCode));
check('the inline `/ 800` literal no longer computes a score in agent-base.js',
  !/Math\.min\(1,\s*responseText\.length\s*\/\s*800\)/.test(agentBaseCode));
check('...and the comment-stripper actually strips — proven by asserting the quoted expression IS still present in the raw file',
  /Math\.min\(1,\s*responseText\.length\s*\/\s*600\)/.test(agentBase));
check('agent-base.js imports the one scorer', /import \{ lengthProxyScore \} from '\.\.\/workers\/quality-metric\.js'/.test(agentBase));
check('_askNotebookX() routes through lengthProxyScore with its project named',
  /lengthProxyScore\(responseText, \{ project: 'notebook-x'/.test(agentBase));
check('evaluateResponseQuality() routes through lengthProxyScore with its project named',
  /lengthProxyScore\(responseText, \{ project: 'data-center', ok \}\)/.test(agentBase));
check('the capability-manifest symbol name is unchanged, so the capability stays SUPPLIED',
  /async evaluateResponseQuality\(/.test(agentBase)
  && /AgentBase#evaluateResponseQuality/.test(readRepo('config/capability-manifest.json')));

/* ═══════════════════════════════════════════════════════════════════════════
 * §3  COMPARABILITY — mixed divisors are refused, and "no data" is not "same"
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§3 scoresAreComparable()');

check('two projects with different divisors are NOT comparable',
  scoresAreComparable(['data-center', 'notebook-x']).comparable === false);
check('the refusal names both divisors so the reader can see the size of the effect',
  /data-center=800/.test(scoresAreComparable(['data-center', 'notebook-x']).reason)
  && /notebook-x=600/.test(scoresAreComparable(['data-center', 'notebook-x']).reason));
check('one project compared with itself IS comparable', scoresAreComparable(['notebook-x', 'notebook-x']).comparable === true);
check('an empty project set is refused as could-not-check, NOT accepted as trivially matching (KFM-13)',
  scoresAreComparable([]).comparable === false && scoresAreComparable([]).reason === 'no_project_recorded');
check('nulls do not count as a project',
  scoresAreComparable([null, undefined]).reason === 'no_project_recorded');

section('§3b saturationOf() — where the metric stops carrying information');
const sat = saturationOf([1, 1, 1, 0.5]);
check('saturation counts scores at the ceiling', sat.saturated === 3 && sat.n === 4 && sat.fraction === 0.75);
check('saturation note names the ceiling in words', /ceiling/.test(sat.note));
check('no saturation produces no note rather than a note saying zero', saturationOf([0.2, 0.3]).note === null);
check('an empty set reports fraction null, not 0', saturationOf([]).fraction === null);

/* ═══════════════════════════════════════════════════════════════════════════
 * §4  THE CONFOUND GATE — refuses the real shape, and STILL RANKS a valid one
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§4 the cross-embodiment comparison refuses a confounded ranking — and only a confounded one');

const fakeDb = (rows) => ({
  prepare: () => ({ all: async () => ({ results: rows }) }),
});

// (a) THE REAL SHAPE, as measured on live D1 2026-08-16: claude serves only
// data-center, cloudflare-fallback and gemini serve only notebook-x. This is
// the input that produced "cloudflare-fallback (0.879) scores higher than
// claude (0.421)" — the finding that started this session.
const confounded = [
  ...Array.from({ length: 10 }, () => ({ agent_id: 1, project: 'data-center', embodiment_model: 'claude', quality: 0.421 })),
  ...Array.from({ length: 19 }, () => ({ agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.879 })),
  ...Array.from({ length: 66 }, () => ({ agent_id: 3, project: 'notebook-x', embodiment_model: 'gemini', quality: 0.85 })),
];
const confoundedResult = await runCrossEmbodimentComparison({ DB: fakeDb(confounded) });
const confoundedKinds = confoundedResult.findings.map((f) => f.kind);

check('the live confounded shape produces comparison_refused_confounded',
  confoundedKinds.includes('comparison_refused_confounded'));
check('and does NOT produce the embodiment_quality_gap claim it used to',
  !confoundedKinds.includes('embodiment_quality_gap'));
const refusal = confoundedResult.findings.find((f) => f.kind === 'comparison_refused_confounded');
check('the refusal states plainly that this is not evidence about either provider',
  /NOT evidence about either provider/.test(refusal.text));
check('the refusal carries a remedy, per OFFICE-POLICY A8 (a blockage report must propose one)',
  /Remedy:/.test(refusal.text));
check('the refusal carries the metric disclosure', refusal.text.includes(METRIC_DISCLOSURE));

// (b) FALSIFIABILITY. Same provider names, same averages, same gap size —
// but both now serve ONE project, so the divisor is shared and the comparison
// is legitimate. The gate MUST let this through. If this check ever fails,
// the gate has become a blanket refusal and the instrument is dead.
const sameProject = [
  ...Array.from({ length: 10 }, () => ({ agent_id: 1, project: 'notebook-x', embodiment_model: 'claude', quality: 0.421 })),
  ...Array.from({ length: 19 }, () => ({ agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.879 })),
];
const validResult = await runCrossEmbodimentComparison({ DB: fakeDb(sameProject) });
const validKinds = validResult.findings.map((f) => f.kind);
check('FALSIFIABILITY: an identical gap within ONE project is still reported as embodiment_quality_gap',
  validKinds.includes('embodiment_quality_gap'));
check('and is NOT refused', !validKinds.includes('comparison_refused_confounded'));
check('the permitted finding names the scorer and divisor it rests on',
  validResult.findings.find((f) => f.kind === 'embodiment_quality_gap').text.includes(SCORER_ID));

// (c) A gap too small to report stays unreported whether or not projects match.
const smallGap = [
  ...Array.from({ length: 10 }, () => ({ agent_id: 1, project: 'notebook-x', embodiment_model: 'claude', quality: 0.85 })),
  ...Array.from({ length: 19 }, () => ({ agent_id: 2, project: 'notebook-x', embodiment_model: 'cloudflare-fallback', quality: 0.879 })),
];
const smallResult = await runCrossEmbodimentComparison({ DB: fakeDb(smallGap) });
check('a sub-threshold gap on one project reports no gap, as before',
  !smallResult.findings.map((f) => f.kind).includes('embodiment_quality_gap'));

check('each embodiment group carries the project(s) that scored it',
  confoundedResult.byEmbodiment.every((e) => Array.isArray(e.projects) && e.projects.length > 0));
check('each embodiment group carries its saturation',
  confoundedResult.byEmbodiment.every((e) => typeof e.saturation?.n === 'number'));

/* ═══════════════════════════════════════════════════════════════════════════
 * §5  EVERY RENDER SITE CARRIES THE DISCLOSURE
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§5 no render site prints a quality number without saying what it is');

const rendered = renderComparisonFinding(confoundedResult, { date: '2026-08-16' });
check('the comparison finding prints the disclosure', rendered.includes(METRIC_DISCLOSURE));
// lastIndexOf, not indexOf: the disclosure legitimately appears EARLIER too,
// inside the refusal finding's own text, and asserting on the first occurrence
// measured that instead. What this check is for is the closing one — the copy
// that sits under the per-embodiment averages.
check('the disclosure appears BELOW the numbers, where a reader who just read an average is',
  rendered.indexOf('By embodiment') < rendered.lastIndexOf(METRIC_DISCLOSURE));
check('and it also travels inside the refusal finding itself, so a reader quoting just that line still carries it',
  rendered.indexOf(METRIC_DISCLOSURE) < rendered.indexOf('By embodiment'));
check('the rendered finding names the scoring project beside each average',
  /scored on project\(s\)/.test(rendered));

const runnerSrc = readRepo('workers/agent-runner.js');
check('the client-facing fact pack imports the disclosure',
  /import \{ METRIC_DISCLOSURE \} from '\.\/quality-metric\.js'/.test(runnerSrc));
check('the fact pack attaches the disclosure to its quality averages',
  /QUALITY CAVEAT[\s\S]{0,120}METRIC_DISCLOSURE/.test(runnerSrc));
check('the fact pack prints the caveat ONLY when an average is present, so it never appears orphaned',
  /anyQuality \? ` QUALITY CAVEAT/.test(runnerSrc));

/* ═══════════════════════════════════════════════════════════════════════════
 * §6  FINDING #22 / KFM-06 — the gap digest stops merging two populations
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

// The classifier itself is untouched — the tiers it produces are the tiers now
// persisted. Asserted so a future edit to one cannot silently drift from the other.
check('detectCapabilityGap still returns kind hard for a failed request',
  detectCapabilityGap({ project: 'data-center', ok: false }).kind === 'hard');
check('detectCapabilityGap still returns kind soft for a low score',
  detectCapabilityGap({ project: 'data-center', ok: true, quality: 0.2 }).kind === 'soft');
check('detectCapabilityGap still returns no kind for an ordinary answer',
  detectCapabilityGap({ project: 'data-center', ok: true, quality: 0.9 }).kind === null);

const agentBaseSrc = agentBase;
check('the gap kind is passed to fileGapReport rather than discarded',
  /this\.fileGapReport\(project, caseId, hebrewText, gap\.kind\)/.test(agentBaseSrc));
check('fileGapReport stores the kind rather than a hardcoded severity',
  /kind === 'hard' \|\| kind === 'soft' \? kind : 'info'/.test(agentBaseSrc));
check('the digest query selects severity so the tier survives the round trip',
  /r\.severity/.test(readRepo('workers/gap-reports.js')));

/* ═══════════════════════════════════════════════════════════════════════════
 * §7  THE DISCLOSURE ITSELF IS HONEST
 * ═══════════════════════════════════════════════════════════════════════════ */
section('§7 the disclosure says the thing that matters');

check('it names the formula', /answer_characters \/ divisor/.test(METRIC_DISCLOSURE));
check('it names both divisors', /800/.test(METRIC_DISCLOSURE) && /600/.test(METRIC_DISCLOSURE));
check('it states that no model reads the question or answer', /No model reads the question/.test(METRIC_DISCLOSURE));
check('it states the failure mode in plain words', /A long wrong answer outscores a short right one/.test(METRIC_DISCLOSURE));
check('it names the scorer version, so a future formula change is distinguishable',
  METRIC_DISCLOSURE.includes(SCORER_ID));
check('the divisors in the disclosure are read from the table, not typed twice',
  METRIC_DISCLOSURE.includes(String(LENGTH_PROXY_DIVISORS['data-center']))
  && METRIC_DISCLOSURE.includes(String(LENGTH_PROXY_DIVISORS['notebook-x'])));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) { console.log('Quality-metric verification FAILED.'); process.exit(1); }
console.log('All scenarios matched expectations.');
