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

export const MIN_SAMPLE_FOR_FINDING = 5;

/**
 * @param {object} env - needs env.DB (D1)
 * @returns {Promise<object>} the full comparison, always returns even on a thin sample
 */
export async function runCrossEmbodimentComparison(env) {
  if (!env?.DB) return { ok: false, reason: 'no_db_binding' };

  const rows = await env.DB.prepare(
    `SELECT agent_id, project, embodiment_model, quality
     FROM reports WHERE type = 'office_event' AND event_type = 'case_answer'`
  ).all();
  const all = rows.results || [];

  const reliable = all.filter((r) => r.embodiment_model !== null && r.embodiment_model !== '');
  const unreliable = all.filter((r) => r.embodiment_model === null || r.embodiment_model === '');

  return {
    ok: true,
    generatedAt: null, // stamped by the caller — see this module's header note on why timestamps are not computed here (workflow determinism)
    totalCaseAnswerRows: all.length,
    reliableRowCount: reliable.length,
    unreliableRowCount: unreliable.length,
    unreliableNote: unreliable.length
      ? `${unreliable.length} of ${all.length} case_answer rows carry no reliable embodiment_model (pre-2026-08-10 capture bug, see this module's header) and are EXCLUDED from every comparison below, not averaged in.`
      : null,
    byAgent: groupAndScore(reliable, 'agent_id'),
    byEmbodiment: groupAndScore(reliable, 'embodiment_model'),
    byAgentAndEmbodiment: groupPair(reliable, 'agent_id', 'embodiment_model'),
    byProjectAndEmbodiment: groupPair(reliable, 'project', 'embodiment_model'),
    findings: buildFindings(reliable),
  };
}

function groupAndScore(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.quality);
  }
  return [...groups.entries()].map(([k, qualities]) => ({
    [key]: k,
    n: qualities.length,
    avgQuality: round3(avg(qualities)),
    meetsMinSample: qualities.length >= MIN_SAMPLE_FOR_FINDING,
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
    const sorted = [...qualifyingEmbodiments].sort((a, b) => b.avgQuality - a.avgQuality);
    const best = sorted[0]; const worst = sorted[sorted.length - 1];
    if (best.avgQuality - worst.avgQuality > 0.1) {
      findings.push({
        kind: 'embodiment_quality_gap',
        text: `${best.embodiment_model} (n=${best.n}, avg ${best.avgQuality}) scores higher than ${worst.embodiment_model} (n=${worst.n}, avg ${worst.avgQuality}) on reliably-attributed rows — a gap worth the Lead QA's attention, not yet a conclusion (A3's provider-blame threshold is separate and higher; see probation-review.js canBlameProvider()).`,
      });
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
    '### Findings',
    ...result.findings.map((f) => `- **${f.kind}**: ${f.text}`),
    '',
    '### By embodiment (reliable rows only)',
    ...result.byEmbodiment.map((e) => `- ${e.embodiment_model}: n=${e.n}, avg quality ${e.avgQuality}${e.meetsMinSample ? '' : ` (below the n=${MIN_SAMPLE_FOR_FINDING} floor — not a finding on its own)`}`),
  ];
  return lines.filter((l) => l !== '').join('\n');
}
