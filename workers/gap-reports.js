/**
 * Data Center — AI Agent Simulation — Hebrew capability-gap reports.
 *
 * Replaces the English/GitHub-Issue model-education digest
 * (agent-runner.js's old fileModelEducationDigest(), which opened a
 * 'claude-action'+'model-education' Issue) for the new Q&A-engine rebuild.
 * Per this session's explicit instruction: gap findings are short internal
 * Hebrew office notes, framed as "the tool I work with isn't good enough
 * here, flagging it for the tool to be fixed" — NOT a GitHub Issue, NOT an
 * English customer-facing incident report.
 *
 * Flow:
 *   1. During the day, agent.flagCapabilityGap() (agent-base.js) persists a
 *      `reports` row (type='gap_hebrew', project set) per genuine gap found —
 *      see detectCapabilityGap() below for what counts as "genuine" (stricter
 *      than "the answer was merely mediocre").
 *   2. Once per day, at the schedule's 'report' block, fileGapDigests() here
 *      reads today's gap_hebrew rows, groups by project, and commits ONE file
 *      per project: reports/gaps/<project>/<date>.md — "one file per project
 *      per day, entries appended from whichever agents hit something that
 *      day," exactly as specified. No GitHub Issue, for either project.
 */

/**
 * Classifies an ask-and-evaluate result for gap-flagging purposes. Two tiers,
 * matching the "not just 'okay but not great' — a genuine finding" bar:
 *
 *   - HARD gaps (kind: 'hard') — always worth flagging, regardless of which
 *     persona hit them: the notebook returned NO answer at all
 *     (queryNotebookX() -> null, project 'notebook-x') or the Claude request
 *     itself failed (ok===false, project 'data-center'). These are
 *     unambiguous "the tool failed" signals, not a judgment call.
 *   - SOFT candidates (kind: 'soft') — quality fell below
 *     SOFT_CANDIDATE_CEILING (0.5): a real answer came back but it was weak.
 *     Whether this is actually WORTH FLAGGING is a per-persona call, not
 *     decided here — see agent-base.js's flagCapabilityGap(), which compares
 *     quality against the agent's own `escalation_threshold` config field
 *     (Step 3: QA/Lead QA sensitive -> higher threshold -> flags more of
 *     these candidates; Standard tolerant -> lower threshold -> flags fewer).
 *   - Anything with quality >= 0.5 is not even a candidate — that's an
 *     ordinary imperfect-but-fine answer, not a capability-gap signal.
 */
import { METRIC_DISCLOSURE } from './quality-metric.js';

const SOFT_CANDIDATE_CEILING = 0.5;

export function detectCapabilityGap({ project, ok, quality, notebookAnswerFound }) {
  if (project === 'notebook-x' && notebookAnswerFound === false) {
    return { isGap: true, kind: 'hard', reason: 'no_notebook_coverage' };
  }
  if (ok === false) {
    return { isGap: true, kind: 'hard', reason: 'request_failed' };
  }
  if (typeof quality === 'number' && quality < SOFT_CANDIDATE_CEILING) {
    return { isGap: false, kind: 'soft', reason: 'low_quality' };
  }
  return { isGap: false, kind: null, reason: null };
}

/**
 * Reads today's gap_hebrew report rows (UTC calendar day, matching the rest
 * of this repo's DATE('now') convention), groups by project, and returns one
 * digest per project with >=1 entry today. Does not write anything itself —
 * agent-runner.js's fileGapDigests() (which has commitFileToRepo() in scope)
 * does the actual file commit.
 */
export async function collectTodayGapReports(env) {
  if (!env.DB) return [];

  const { results } = await env.DB.prepare(
    // `severity` carries the gap KIND ('hard' | 'soft'), written since
    // 2026-08-16 — see agent-base.js fileGapReport(). Selected so the digest
    // can count the two tiers apart instead of merging them (finding #22).
    `SELECT r.id, r.agent_id, r.title, r.content, r.project, r.severity, r.created_at, a.name AS agent_name
     FROM reports r JOIN agents a ON a.id = r.agent_id
     WHERE r.type = 'gap_hebrew' AND DATE(r.created_at) = DATE('now')
     ORDER BY r.project, r.created_at ASC`
  ).all();

  const byProject = new Map();
  for (const row of results) {
    const key = row.project || 'unknown';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(row);
  }

  return [...byProject.entries()].map(([project, entries]) => ({ project, entries }));
}

/**
 * Renders one project's daily gap digest as markdown — a short Hebrew entry
 * per finding, each attributed to the agent that hit it. RTL-friendly:
 * headings/metadata in English (repo convention, matches every other report
 * file), entry body in Hebrew as composed by the flagging agent.
 */
export function renderGapDigest(project, dateStr, entries) {
  /*
   * ── FINDING #22 / KFM-06, fixed 2026-08-16 ──────────────────────────────
   *
   * This headline used to read "N genuine capability gaps flagged today",
   * where N merged two populations THIS FILE ITSELF distinguishes 40 lines
   * above: `hard` (the notebook returned nothing, or the request to Claude
   * failed — the tool demonstrably did not work) and `soft` (an answer came
   * back and scored below this persona's threshold). Merging them produces a
   * number that is true and useless: a reader cannot tell one outage from
   * three mediocre answers, and the two demand completely different responses.
   *
   * The soft tier is additionally downstream of a LENGTH PROXY — a `soft` gap
   * means "the answer was short", not "the answer was wrong. So the merged
   * count was partly a measure of verbosity, presented as a count of tool
   * failures. That is why the disclosure below is printed on the digest and
   * not only on reports that show a numeric score.
   *
   * Rows written before today carry `severity: 'info'` and are counted as
   * `unclassified` — not silently folded into either tier (KFM-13: "could not
   * check" is not "checked and found absent"), and not rewritten (A15).
   */
  const hard = entries.filter((e) => e.severity === 'hard').length;
  const soft = entries.filter((e) => e.severity === 'soft').length;
  const unclassified = entries.length - hard - soft;

  const breakdown = [
    `${hard} HARD (the tool produced nothing — no notebook coverage, or the request failed outright)`,
    `${soft} SOFT (an answer came back but scored below the flagging agent's own threshold)`,
    unclassified ? `${unclassified} unclassified (filed before 2026-08-16, when the tier stopped being discarded at write time — not reclassified retroactively)` : null,
  ].filter(Boolean).join('; ');

  const header = `# Capability gaps — ${project} — ${dateStr}\n\n` +
    `${entries.length} capability gap${entries.length === 1 ? '' : 's'} flagged today: ${breakdown}.\n\n` +
    `> **HARD and SOFT are different findings and are deliberately not summed into one headline.** ` +
    `A HARD gap is evidence the tool failed. A SOFT gap is evidence an answer scored low — and the score is a ` +
    `length proxy, so a SOFT gap means the answer was SHORT, not that it was wrong. ${METRIC_DISCLOSURE}\n\n` +
    `Internal office notes — not GitHub Issues, not customer-facing.\n\n`;

  const body = entries.map((e) => {
    const tier = e.severity === 'hard' || e.severity === 'soft' ? e.severity.toUpperCase() : 'UNCLASSIFIED';
    return `## ${e.agent_name} — case \`${e.title}\` — ${tier}\n\n${e.content}\n`;
  }).join('\n---\n\n');

  return header + body;
}
