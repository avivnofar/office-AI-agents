/**
 * workers/embodiment-comparison.js — the Lead QA's signature instrument.
 *
 * OFFICE-POLICY.md A3 / plan items 1.5 and 2.7 / capability-manifest.json's
 * `cross-embodiment-comparison`. "The Lead QA's signature instrument: compare
 * report quality across agents AND across embodiment models — 'this persona
 * is more consistent under that provider'." The inputs (`reports.quality`,
 * `reports.embodiment_model`, `reports.agent_id`, `reports.project`) were
 * real and collecting since 2026-08-06 (improvement-loop.js); nothing read
 * them and compared. This module is the reader.
 *
 * ── READ THIS BEFORE TRUSTING A NUMBER OUT OF IT ───────────────────────────
 *
 * Built 2026-08-10 in the same session that found `embodiment_model` was
 * itself unreliable before this date — see agent-base.js's "source ADDED
 * 2026-08-10" notes on _askDataCenter()/_askNotebookX(). Every row written
 * before that fix landed either NULL or attributed to the provider that
 * phrased a follow-up QUESTION rather than the one that produced the scored
 * ANSWER. This module does not silently exclude those rows — a comparison
 * that quietly drops bad data looks more confident than the evidence
 * supports, which is exactly what OB-044 (week-07's false "Nothing moved")
 * was about at a different layer. Instead it COUNTS them, reports them
 * separately, and STAYS OUT of the pooled comparison, tagging every finding
 * with the reliable sample size it actually rests on. `unreliableRowCount`
 * is a top-level field for exactly that reason: read it before believing any
 * `byEmbodiment` number.
 *
 * ── WHY IT DOES NOT REFUSE TO RUN ON A THIN SAMPLE ─────────────────────────
 *
 * "Report what it actually finds on real data. If the sample is too thin for
 * a conclusion, that is the finding, and it belongs in the report rather than
 * being dressed up." (session brief, 2026-08-10, echoing OFFICE-POLICY.md's
 * own posture on A15/A8). So this module always runs and always returns a
 * result; `verdict` says whether the sample supports a conclusion, and
 * `MIN_SAMPLE_FOR_FINDING` is the one number that decides it — named and
 * exported so a future session does not have to reverse-engineer a magic 5
 * from a comment.
 */

import {
  METRIC_DISCLOSURE, metricDisclosureFor, DIVISOR_UNIFICATION_NOTE, UNIFIED_FROM_ISO,
  scoresAreComparable, saturationOf, scorerForRow,
} from './quality-metric.js';

export const MIN_SAMPLE_FOR_FINDING = 5;

/**
 * ── SCORER STRATIFICATION, added 2026-08-16 (OB-080) ────────────────────────
 *
 * The first version of this instrument pooled every row and ranked providers.
 * On live D1 that produced "cloudflare-fallback (0.879) scores higher than
 * claude (0.421)" — a fact about two divisors, because provider maps one-to-one
 * onto project and the divisor was chosen by project. The fix that session was
 * a REFUSAL: rank nothing when the scorers differ.
 *
 * A refusal is correct and it is not an answer. What makes an answer possible
 * is stratifying: **compare only within one scorer, and report each stratum
 * separately.** The divisors are unified from `UNIFIED_FROM` so future rows all
 * share one stratum — but history is not rescored, so the strata are permanent
 * and this instrument has to be able to read across the boundary without
 * pretending it is not there.
 *
 * The pooled cross-stratum ranking is still refused. What is new is that a
 * within-stratum ranking is now attempted and reported, which is how the
 * instrument produces a provider comparison at all.
 */
function stratifyRows(rows) {
  return rows.map((r) => {
    const s = scorerForRow({ project: r.project, scoredAt: r.created_at, scorerId: r.scorer_id });
    return { ...r, _scorerId: s.scorerId, _divisor: s.divisor, _scorerSource: s.source, _era: s.era };
  });
}

/**
 * @param {object} env - needs env.DB (D1)
 * @returns {Promise<object>} the full comparison, always returns even on a thin sample
 */
export async function runCrossEmbodimentComparison(env) {
  if (!env?.DB) return { ok: false, reason: 'no_db_binding' };

  // `created_at` and `scorer_id` ADDED 2026-08-16: without them this query
  // cannot tell which formula produced a row, which is precisely what made the
  // false finding unfalsifiable. `scorer_id` is authoritative where present;
  // `created_at` is how the 134 rows that predate the column are attributed.
  const rows = await env.DB.prepare(
    `SELECT agent_id, project, embodiment_model, quality, created_at, scorer_id
     FROM reports WHERE type = 'office_event' AND event_type = 'case_answer'`
  ).all();
  const all = stratifyRows(rows.results || []);

  const reliable = all.filter((r) => r.embodiment_model !== null && r.embodiment_model !== '');
  const unreliable = all.filter((r) => r.embodiment_model === null || r.embodiment_model === '');

  const strata = [...new Set(all.map((r) => r._scorerId))];
  const inferred = all.filter((r) => r._scorerSource === 'inferred').length;
  const unattributed = all.filter((r) => r._scorerSource === 'unknown').length;

  return {
    ok: true,
    generatedAt: null, // stamped by the caller — see this module's header note on why timestamps are not computed here (workflow determinism)
    totalCaseAnswerRows: all.length,
    reliableRowCount: reliable.length,
    unreliableRowCount: unreliable.length,
    unreliableNote: unreliable.length
      ? `${unreliable.length} of ${all.length} case_answer rows carry no reliable embodiment_model (pre-2026-08-10 capture bug, see this module's header) and are EXCLUDED from every comparison below, not averaged in.`
      : null,
    // How the scorer behind each row was established. `inferred` is not a
    // defect — it is the only honest reading of a row written before the
    // scorer_id column existed — but it is weaker evidence than `recorded` and
    // is counted rather than blended in (KFM-13).
    scorerStrata: strata,
    scorerAttribution: {
      recorded: all.length - inferred - unattributed,
      inferred,
      unattributed,
      note: inferred
        ? `${inferred} of ${all.length} rows predate the scorer_id column and their scorer is INFERRED from created_at against ${UNIFIED_FROM_ISO} (exact for them: every one was written before that boundary). ${unattributed} could not be attributed at all.`
        : null,
    },
    byAgent: groupAndScore(reliable, 'agent_id'),
    byEmbodiment: groupAndScore(reliable, 'embodiment_model'),
    byAgentAndEmbodiment: groupPair(reliable, 'agent_id', 'embodiment_model'),
    byProjectAndEmbodiment: groupPair(reliable, 'project', 'embodiment_model'),
    byScorerAndEmbodiment: groupPair(reliable, '_scorerId', 'embodiment_model'),
    findings: buildFindings(reliable),
  };
}

function groupAndScore(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, { qualities: [], projects: new Set(), scorers: new Map() });
    groups.get(k).qualities.push(r.quality);
    groups.get(k).projects.add(r.project ?? null);
    groups.get(k).scorers.set(r._scorerId, r._divisor ?? null);
  }
  return [...groups.entries()].map(([k, g]) => ({
    [key]: k,
    n: g.qualities.length,
    avgQuality: round3(avg(g.qualities)),
    meetsMinSample: g.qualities.length >= MIN_SAMPLE_FOR_FINDING,
    projects: [...g.projects],
    // WHICH SCORER(S) produced these numbers, carried on the group itself and
    // read straight off the rows rather than re-derived from `project`. A group
    // spanning more than one entry here is internally incomparable — its own
    // average pools two scales — which is a thing only this field can show.
    // Added 2026-08-16.
    scorers: [...g.scorers.entries()].map(([scorerId, divisor]) => ({ scorerId, divisor })),
    saturation: saturationOf(g.qualities),
  })).sort((a, b) => b.n - a.n);
}

function groupPair(rows, keyA, keyB) {
  const groups = new Map();
  for (const r of rows) {
    const a = r[keyA]; const b = r[keyB];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    const k = `${a}::${b}`;
    if (!groups.has(k)) groups.set(k, { [keyA]: a, [keyB]: b, qualities: [] });
    groups.get(k).qualities.push(r.quality);
  }
  return [...groups.values()].map((g) => ({
    [keyA]: g[keyA],
    [keyB]: g[keyB],
    n: g.qualities.length,
    avgQuality: round3(avg(g.qualities)),
    meetsMinSample: g.qualities.length >= MIN_SAMPLE_FOR_FINDING,
  })).sort((a, b) => b.n - a.n);
}

/**
 * Turns the grouped numbers into the kind of sentence A3/1.5 actually wants
 * ("this persona is more consistent under that provider" /
 * "that provider invents facts in meetings") — but ONLY when the underlying
 * cells meet MIN_SAMPLE_FOR_FINDING on BOTH sides of the comparison. A
 * finding built on a 1-row cell is not a finding; it is noise wearing a
 * sentence, and this function's whole job is to not manufacture one.
 */
function buildFindings(rows) {
  const findings = [];
  const byEmbodiment = groupAndScore(rows, 'embodiment_model');
  const qualifyingEmbodiments = byEmbodiment.filter((e) => e.meetsMinSample);

  if (qualifyingEmbodiments.length < 2) {
    findings.push({
      kind: 'insufficient_sample',
      text: `Only ${qualifyingEmbodiments.length} embodiment(s) have ${MIN_SAMPLE_FOR_FINDING}+ reliably-attributed rows (${byEmbodiment.map((e) => `${e.embodiment_model}: n=${e.n}`).join(', ') || 'none'}). A cross-embodiment quality comparison needs at least two providers each meeting the sample floor to say anything — the data does not support one yet.`,
    });
  } else {
    /*
     * ── THE POOLED RANKING IS STILL REFUSED, AND THE REASON HAS CHANGED ───
     *
     * Before the confound gate, the branch below fired whenever two averages
     * differed by 0.1. On live D1 that produced, verbatim:
     *
     *   "cloudflare-fallback (n=19, avg 0.879) scores higher than claude
     *    (n=10, avg 0.421) on reliably-attributed rows"
     *
     * — a degraded FALLBACK provider beating the office's primary. The
     * sentence is arithmetically correct and it is not a fact about either
     * provider: `quality` was a length proxy whose divisor was chosen by
     * PROJECT (800 data-center / 600 notebook-x), and each provider serves
     * exactly one project.
     *
     * 2026-08-16 (OB-080) unified the divisors, so the office no longer
     * CREATES that confound. It does not erase it: history is not rescored
     * (A15), so pre-unification rows keep two scales forever and a pooled
     * average over them still measures the formula as well as the provider.
     * The refusal therefore survives, and it now names a HISTORICAL boundary
     * with an expiry — "rows from before 2026-08-16" — rather than a standing
     * property of the office, which is a different and much better sentence.
     *
     * A caveat under a ranked list is still a ranked list (KFM-07), so it
     * refuses rather than qualifies. What is new is the stratified comparison
     * below, which is the instrument finally answering the question instead of
     * only declining it.
     */
    const pooled = scoresAreComparable(qualifyingEmbodiments.flatMap((e) => e.scorers));
    if (!pooled.comparable) {
      const sorted = [...qualifyingEmbodiments].sort((a, b) => b.avgQuality - a.avgQuality);
      const best = sorted[0]; const worst = sorted[sorted.length - 1];
      findings.push({
        kind: 'comparison_refused_confounded',
        text: `REFUSED to rank embodiments in one pooled table. ${best.embodiment_model} (n=${best.n}, avg ${best.avgQuality}) and ${worst.embodiment_model} (n=${worst.n}, avg ${worst.avgQuality}) rest on rows scored by DIFFERENT scorers — ${pooled.reason}. A difference between these averages is indistinguishable from the difference between their divisors, so no provider conclusion can be drawn from the pooled numbers and the apparent gap is NOT evidence about either provider. This is now a fact about ROWS WRITTEN BEFORE ${UNIFIED_FROM_ISO}, not about how the office scores today: the divisors were unified on that date (OB-080) and every row after it shares one scale. The comparison the office CAN make is the per-scorer one below. ${DIVISOR_UNIFICATION_NOTE}`,
      });
    }

    /*
     * ── THE COMPARISON THAT IS ACTUALLY VALID ────────────────────────────
     * Within one scorer, a ranking is legitimate — same formula, same
     * denominator, no confound left to separate. This runs whether or not the
     * pooled ranking was refused, because a refusal that offers nothing in its
     * place is why the Lead QA's signature instrument had produced exactly one
     * conclusion in its life and that conclusion was false.
     */
    for (const stratum of strataOf(rows)) {
      // A stratum whose divisor could not be established cannot support a
      // comparison OR a refusal-with-a-reason: saying "no gap on one scale"
      // about rows whose scale is unknown would be the original defect wearing
      // the new vocabulary. Reported as a could-not-check (KFM-13).
      if (typeof stratum.divisor !== 'number') {
        findings.push({
          kind: 'stratum_scorer_unknown',
          text: `${stratum.n} row(s) carry no scorer_id and no usable created_at, so the formula that produced their scores cannot be established. They are NOT compared and NOT pooled — an unattributable score is a could-not-check, not a score that happens to match.`,
        });
        continue;
      }
      const inStratum = groupAndScore(rows.filter((r) => r._scorerId === stratum.scorerId), 'embodiment_model');
      const qualifying = inStratum.filter((e) => e.meetsMinSample);
      if (qualifying.length < 2) {
        findings.push({
          kind: 'stratum_sample_too_thin',
          text: `Scorer \`${stratum.scorerId}\` (divisor ${stratum.divisor ?? 'unknown'}): only ${qualifying.length} embodiment(s) reach n=${MIN_SAMPLE_FOR_FINDING} (${inStratum.map((e) => `${e.embodiment_model}: n=${e.n}`).join(', ') || 'none'}). Comparable rows exist but not enough of them to rank anything on this scale.`,
        });
        continue;
      }
      const sorted = [...qualifying].sort((a, b) => b.avgQuality - a.avgQuality);
      const best = sorted[0]; const worst = sorted[sorted.length - 1];
      const gap = round3(best.avgQuality - worst.avgQuality);
      if (gap > 0.1) {
        findings.push({
          kind: 'embodiment_quality_gap',
          text: `Scorer \`${stratum.scorerId}\` (divisor ${stratum.divisor}): ${best.embodiment_model} (n=${best.n}, avg ${best.avgQuality}) scores higher than ${worst.embodiment_model} (n=${worst.n}, avg ${worst.avgQuality}) — gap ${gap}, on rows scored by ONE formula, so this one is not a divisor artifact. A gap worth the Lead QA's attention, not yet a conclusion (A3's provider-blame threshold is separate and higher; see probation-review.js canBlameProvider()). ${metricDisclosureFor(stratum.divisor, stratum.scorerId)}`,
        });
      } else {
        findings.push({
          kind: 'embodiment_no_gap_on_one_scale',
          text: `Scorer \`${stratum.scorerId}\` (divisor ${stratum.divisor}): ${qualifying.map((e) => `${e.embodiment_model} (n=${e.n}, avg ${e.avgQuality})`).join(' vs ')} — gap ${gap}, below the 0.1 floor. **This is a comparison, not a refusal**: these rows share one formula, so the absence of a gap is a real (if weak) result about the providers rather than an artifact. ${metricDisclosureFor(stratum.divisor, stratum.scorerId)}`,
        });
      }
    }
  }

  const byAgent = groupAndScore(rows, 'agent_id');
  const thinAgents = byAgent.filter((a) => !a.meetsMinSample);
  if (thinAgents.length) {
    findings.push({
      kind: 'per_agent_sample_too_thin',
      text: `${thinAgents.length} of ${byAgent.length} agents with any reliably-attributed row have fewer than ${MIN_SAMPLE_FOR_FINDING} — per-agent embodiment comparison (as opposed to the office-wide pool) is not supported yet for: ${thinAgents.map((a) => `agent ${a.agent_id} (n=${a.n})`).join(', ')}.`,
    });
  }

  if (!findings.length) {
    findings.push({ kind: 'no_finding', text: 'Reliable sample exists but shows no gap worth flagging (all qualifying embodiments within 0.1 avg quality of each other).' });
  }

  return findings;
}

/**
 * The distinct scorers present in a row set, largest first, so the stratified
 * comparison reports the biggest comparable population before the tail.
 */
function strataOf(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r._scorerId)) m.set(r._scorerId, { scorerId: r._scorerId, divisor: r._divisor ?? null, n: 0 });
    m.get(r._scorerId).n += 1;
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

function avg(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}
function round3(n) { return n === null ? null : Math.round(n * 1000) / 1000; }

/**
 * Renders the comparison as the Lead QA's weekly finding — Markdown, English
 * (the report body language, A9) — for a caller to hand to
 * writeActiveContextAmendment()/fileWeeklyReport() or a meeting record.
 */
export function renderComparisonFinding(result, { date } = {}) {
  if (!result?.ok) return `Cross-embodiment comparison could not run: ${result?.reason || 'unknown error'}.`;
  const stamp = date || new Date().toISOString().slice(0, 10);
  const lines = [
    `## Cross-embodiment comparison — ${stamp}`,
    '',
    `${result.totalCaseAnswerRows} case_answer rows total. ${result.reliableRowCount} carry a reliably-attributed embodiment_model; ${result.unreliableRowCount} do not and are excluded from every number below.`,
    result.unreliableNote ? `\n> ${result.unreliableNote}` : '',
    '',
    '### Scorers behind these numbers',
    '',
    `Rows are grouped by the formula that scored them: ${(result.scorerStrata || []).join(', ') || 'none recorded'}.`,
    result.scorerAttribution?.note ? `\n> ${result.scorerAttribution.note}` : '',
    '',
    '### Findings',
    ...result.findings.map((f) => `- **${f.kind}**: ${f.text}`),
    '',
    '### By embodiment (reliable rows only)',
    ...result.byEmbodiment.map((e) => `- ${e.embodiment_model}: n=${e.n}, avg quality ${e.avgQuality}${e.meetsMinSample ? '' : ` (below the n=${MIN_SAMPLE_FOR_FINDING} floor — not a finding on its own)`}`
      + ` — scored on project(s) ${e.projects.map((p) => p ?? 'unrecorded').join('/')}`
      + ` by scorer(s) ${e.scorers.map((s) => `${s.scorerId}`).join(' + ')}`
      + (e.scorers.length > 1 ? ' **— this average itself pools more than one scale and is not interpretable on its own**' : '')
      + (e.saturation?.note ? `; ${e.saturation.note}` : '')),
    '',
    '### What "quality" means in the numbers above',
    '',
    // Printed BELOW the numbers, not above: a reader who has just read an
    // average is the reader who needs this sentence. Mandatory at every render
    // site — see workers/quality-metric.js.
    `> ${METRIC_DISCLOSURE}`,
  ];
  return lines.filter((l) => l !== '').join('\n');
}
