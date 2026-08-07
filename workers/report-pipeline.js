/**
 * workers/report-pipeline.js — the office's substantive reports, drafted by a
 * model and reviewed by another before they are published.
 *
 * Written 2026-08-08. INERT until SIM_KV simulation-state carries
 * `report_pipeline_enabled: true`. Default OFF, `=== true` only.
 *
 * ── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────
 *
 * The owner's complaint, in his words: the weekly report "doesn't summarise
 * anything that makes sense", and the agents "only discuss their own
 * case-solving, not the projects on the todo list or the office's actual
 * work." A daily standup reads sensibly; the weekly does not.
 *
 * The weekly report is a STRING TEMPLATE (agent-runner.js
 * generateWeeklySummary()). It lists per-agent case counts, per-agent moods,
 * the asset-pipeline board, and three hardcoded "action items for next week"
 * that have never once changed. Nothing in it is written; it is assembled.
 * A template cannot say what was most consequential this week, because
 * "consequential" is a judgement and a template has none.
 *
 * So the report gets WRITTEN, by a model, from a fact pack — and because a
 * written report can be confidently wrong in a way a template cannot, it is
 * reviewed by a second persona on a second provider before it publishes.
 *
 * ── THE RULES, AND WHERE THEY WERE PAID FOR ──────────────────────────────
 *
 * Every rule below is lifted from workers/guide-engine.js and the guides
 * pipeline's block handlers in agent-runner.js. They are not re-derived here
 * from taste; each one closed a real failure:
 *
 *   1. NO SELF-QA. The drafter never reviews its own work — neither the same
 *      persona nor the same provider. A Gemini-self-QA pass was considered
 *      and rejected for the guides pipeline on the grounds that Gemini
 *      checking Gemini finds nothing. Enforced here as a REFUSAL, not a
 *      preference: see assertDistinctReviewer().
 *   2. ONE REVISION ROUND. A second rejection is a rejection. There is no
 *      third pass, because a pipeline that keeps asking eventually gets a
 *      yes that means nothing.
 *   3. NEVER ESCALATE TO THE OWNER. A rejected report is saved with its
 *      rejection note and the pipeline moves on — same fire-and-forget
 *      posture as gap digests and guides.
 *   4. AN APPROVE WITH A MISSING OR TRUNCATED BODY IS NOT A DECISION. The
 *      first supervised guides run (2026-08-01) committed a byline-only
 *      file because an APPROVE was parsed out of a response whose guide body
 *      had been cut off at the token ceiling. Here the row stays 'drafted'
 *      so a retry is clean. See validateReportBody().
 *   5. NEVER SILENTLY DROP AN UNVERIFIED MARKER. If the fact pack says a
 *      number is unverified, the published report says so too. A reviewer
 *      that tidies the marker away has changed a claim's status without
 *      changing the claim. See countUnverified().
 *   6. SHIPS OFF. Deploying this does not start it.
 *
 * ── TRUNCATION, AND AN HONEST LIMIT ──────────────────────────────────────
 *
 * The guides pipeline detects a truncated review by reading Anthropic's
 * `stop_reason: max_tokens`. NEITHER workers/groq-client.js NOR
 * workers/gemini-client.js surfaces a finish reason — both return
 * `{text, source}` and nothing else — so that check is not available on this
 * path and pretending otherwise would be worse than saying so.
 *
 * Truncation is therefore detected STRUCTURALLY: the reviewer is required to
 * end the report with a literal sentinel line, and a report missing the
 * sentinel or any required heading is refused. A response cut off at the
 * ceiling loses its tail, which is exactly where the sentinel is. This is
 * weaker than a provider-reported stop reason and is written down as such.
 *
 * ── NO JSON IMPORTS, NO CONFIG IMPORTS, NO PROVIDER IMPORTS ──────────────
 *
 * Same constraint office-context.js and permission-guard.js carry, for the
 * same reason: a module-scope JSON import needs an attribute that plain
 * `node` rejects, which would make this file un-importable by
 * scripts/verify-report-pipeline.js — and a verifier that cannot import the
 * thing it verifies ends up hand-mirroring it, which is the drift the
 * verifier existed to end.
 *
 * Consequence: this module decides WHICH LANE and WHICH FALLBACK PROVIDER,
 * as data. agent-runner.js performs the calls, exactly as it does for the
 * guides pipeline (guide-engine.js holds the prompts and parsers; the model
 * calls and the GitHub commits live in the runner).
 */

/* ─────────────────────────────── The switch ───────────────────────────── */

const SIM_STATE_KEY = 'simulation-state';
export const REPORT_PIPELINE_FLAG = 'report_pipeline_enabled';

/**
 * Reads the flag. Defaults to OFF on every failure path — no SIM_KV binding,
 * unreadable value, absent key. `=== true` rather than truthiness, so a stray
 * "false" string cannot enable it. Same shape as officeContextEnabled() and
 * guidesEnabled(), deliberately.
 */
export async function reportPipelineEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[REPORT_PIPELINE_FLAG] === true;
}

/* ──────────────────────────── Shape constants ─────────────────────────── */

export const REPORT_TYPES = Object.freeze(['weekly', 'monthly']);

/** The QA (agent 6) reviews. Owner requirement: at least one check before
 *  publication, and the QA is the office's quality function. */
export const REVIEWER_AGENT_ID = 6;

/** The Workflow (agent 12) drafts. Items 4 and 6 of the standing structure —
 *  the productivity picture and what is blocked on whom — ARE his dispatch
 *  function, so the report is his to write. He is not the reviewer, which is
 *  rule 1. */
export const DRAFTER_AGENT_ID = 12;

/** Ends every published report. A response truncated at the token ceiling
 *  loses its tail, and the tail is this line. See the header's honest note on
 *  why a structural check is doing a provider's job here. */
export const REPORT_SENTINEL = '<!-- END OF REPORT -->';

/**
 * The standing structure, from docs/procedures/MEETING-PROTOCOL.md §4.2 and
 * the owner's statement of what a report is for.
 *
 * ITEM 1 IS FIRST AND IS NOT NEGOTIABLE. It is the only question the office
 * exists to answer — "where are we against what the client asked for" — and
 * `docs/CLIENT-REQUIREMENTS.md` is its source. A report that opens with case
 * counts has already told the reader what the office thinks matters.
 *
 * `key` is what validateReportBody() looks for. Matching is on the NUMBER and
 * the leading words, not the full string, so a reviewer may sharpen a heading
 * without failing the structural check — but it may not renumber or drop one.
 */
export const REQUIRED_SECTIONS = Object.freeze([
  { n: 1, key: 'Where we stand', heading: '## 1. Where we stand against the client requirements' },
  { n: 2, key: 'Product decisions', heading: '## 2. Product decisions and the vote record' },
  { n: 3, key: 'Conflicts', heading: '## 3. Conflicts raised and how they resolved' },
  { n: 4, key: 'Productivity', heading: '## 4. Productivity — what sat, who was idle, what ran late' },
  { n: 5, key: 'Agent state', heading: '## 5. Agent state and the improvement loop' },
  { n: 6, key: 'Blocked', heading: '## 6. Blocked, and on whom' },
]);

/** The summary that makes the report finishable. Length discipline: the fix
 *  for a report too long to read is structure and a summary at the top, never
 *  truncation. */
export const SUMMARY_HEADING = '## At a glance';

/**
 * A published report must be at least this many characters. Not a quality
 * bar — a "the body is actually there" bar, the direct analogue of the
 * guides pipeline's 500-character floor, raised because a six-section report
 * that fits in 500 characters has not been written.
 */
export const MIN_APPROVED_REPORT_CHARS = 1200;

/** Words. The owner's bar is "short enough that people actually read it";
 *  the ceiling also keeps the reviewer's full-report response inside the
 *  output-token budget it is given. */
export const TARGET_WORDS = Object.freeze({ min: 550, max: 950 });

/* ───────────────────────── Lane / provider planning ────────────────────── */

/** Lane names are config/model-routing.json keys. Kept as strings here so
 *  this module needs no config import — see the header. */
export const REVIEW_LANE = 'judgment';
export const DRAFT_LANE_HEBREW = 'hebrew_composition';
export const DRAFT_LANE_OTHER = 'routine_volume';

/**
 * Which lane drafts, per the session instruction: the Hebrew composition lane
 * where the report is Hebrew, the routine lane where it is not.
 *
 * ⚠ RECORDED TENSION, NOT RESOLVED HERE. The owner's other stated requirement
 * is that reports are "written by Gemini". The Hebrew lane's primary IS
 * Gemini; the routine lane's primary is Groq. The office's weekly and monthly
 * reports are ENGLISH (Front language is English only, owner decision
 * 2026-08-05), so with routing ON an English report would be drafted by Groq
 * and the "written by Gemini" requirement would stop holding — silently.
 *
 * It does not bite today: `routing_enabled` is OFF, and the routing-off path
 * below drafts on Gemini directly, so the requirement holds exactly as stated
 * in the state this ships in. It would bite the moment routing is switched
 * on, which is an owner action, which is the right moment for him to decide
 * it. planReportProviders() reports the conflict in its return value so the
 * caller can log it rather than discover it in a published report.
 */
export function pickDraftLane(language) {
  return String(language || '').toLowerCase() === 'hebrew' ? DRAFT_LANE_HEBREW : DRAFT_LANE_OTHER;
}

/**
 * Plans both model calls without making either.
 *
 * ROUTING OFF IS A CLEAN DEGRADATION, NOT A FAILURE. With the router off,
 * routeTaskTypeCall() refuses every call with `routing_disabled` and contacts
 * nothing — so this pipeline does not call it at all in that state. It uses
 * the two direct paths that already exist and are already wired for persona
 * voice: agent.queryGeminiDirect() to draft, agent.queryGroqRouted() (Groq
 * with the Cloudflare Workers AI fallback) to review. Different persona,
 * different provider, rule 1 satisfied in both flag states.
 *
 * @param {object} opts
 * @param {boolean} opts.routingOn   result of routingEnabled(env)
 * @param {string}  opts.language    'english' | 'hebrew'
 * @returns {{draft: object, review: object, geminiRequirementHolds: boolean, notes: string[]}}
 */
export function planReportProviders({ routingOn, language = 'english' } = {}) {
  const notes = [];

  if (!routingOn) {
    notes.push('routing_enabled is off — using the direct provider paths (Gemini draft, Groq review). No router call is made.');
    return {
      draft: { mode: 'direct', path: 'queryGeminiDirect', provider: 'gemini', lane: null, agentId: DRAFTER_AGENT_ID },
      review: { mode: 'direct', path: 'queryGroqRouted', provider: 'groq', lane: null, agentId: REVIEWER_AGENT_ID },
      geminiRequirementHolds: true,
      notes,
    };
  }

  const lane = pickDraftLane(language);
  const geminiRequirementHolds = lane === DRAFT_LANE_HEBREW;
  if (!geminiRequirementHolds) {
    notes.push(
      `routing_enabled is on and this report is ${language}, so drafting resolves to the "${lane}" lane, whose primary is NOT Gemini. `
      + 'The owner requirement "reports are written by Gemini" does not hold in this configuration. This is recorded, not worked around — see pickDraftLane().'
    );
  }

  return {
    draft: { mode: 'routed', path: 'routeTaskTypeCall', provider: null, lane, agentId: DRAFTER_AGENT_ID },
    review: { mode: 'routed', path: 'routeTaskTypeCall', provider: null, lane: REVIEW_LANE, agentId: REVIEWER_AGENT_ID },
    geminiRequirementHolds,
    notes,
  };
}

/**
 * RULE 1, enforced rather than assumed. Called with the provider ids that
 * ACTUALLY answered, not the ones that were planned — a lane degrading to its
 * backup can land both calls on the same provider (hebrew_composition and
 * judgment both back off to Mistral), and a review is not a review when the
 * same model wrote the thing.
 *
 * Two mechanisms agreeing by accident is not a guard: the personas differ by
 * construction (12 drafts, 6 reviews) and that is checked too, because a
 * future session changing one constant should not silently remove the other
 * half of the rule.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertDistinctReviewer({ draftProvider, reviewProvider, draftAgentId, reviewAgentId }) {
  if (draftAgentId != null && draftAgentId === reviewAgentId) {
    return { ok: false, reason: `same persona drafted and reviewed (agent ${draftAgentId}) — no self-QA` };
  }
  if (draftProvider && reviewProvider && draftProvider === reviewProvider) {
    return { ok: false, reason: `same provider drafted and reviewed ("${draftProvider}") — no self-QA` };
  }
  return { ok: true };
}

/* ───────────────────────────── The fact pack ───────────────────────────── */

/**
 * ── THE CONTEXT CEILING, AND WHY THESE TWO NUMBERS EXIST ─────────────────
 *
 * The REVIEW call is the constrained one, and only in the routing-off state.
 * With routing off the reviewer is Groq's `llama3-8b-8192`, whose 8,192
 * tokens are TOTAL — prompt plus completion, not input alone. The review
 * prompt carries the whole fact pack AND the whole draft, so the first real
 * fact pack (10,605 characters, ~3,535 tokens, measured 2026-08-08 against
 * the live 27-task board) put the call within a few hundred tokens of the
 * ceiling before the completion was even counted.
 *
 * With routing ON this does not bind at all: the judgment lane is Cerebras
 * at a measured 131,000-token input. So the ceiling is a property of the
 * DEGRADED path, which is the path that ships.
 *
 * Two independent measures, because trimming alone would be a guess that
 * silently stops being true when the board grows:
 *   1. Bound the pack — cap the task list and clip the long blocked-by
 *      prose, both with a visible marker.
 *   2. REFUSE the call when it still would not fit (estimateReviewFit()).
 *      A request that overruns the ceiling does not error cleanly on this
 *      path — neither groq-client.js nor gemini-client.js reports a finish
 *      reason — so it would come back as a plausible-looking truncated
 *      review. Refusing is the only way that failure stays visible.
 */
/**
 * 18, not 27 and not 40. Measured 2026-08-08 against the live board: at 22
 * tasks the review call came to ~8,065 of the routing-off reviewer's 8,192
 * total tokens — a 1.5% margin, which is not a margin. At 18 it is ~7%.
 *
 * This number is a symptom, not a solution. The real fix is the judgment
 * lane (Cerebras, 131,000-token input), where the ceiling does not exist at
 * all; enabling routing removes the constraint rather than managing it.
 * Until then the cap is visible in the pack ("showing 18 of 27") and
 * estimateReviewFit() refuses anything that still would not fit.
 */
export const BOARD_TASKS_IN_PACK = 18;
/** The blocked list is bounded too. An unbounded list inside a bounded
 *  context is the exact failure office-context.js already learned once: it
 *  passed every test at three items and would have blown its budget the first
 *  day the board grew. */
export const BLOCKED_IN_PACK = 12;
const BLOCKED_BY_MAX_CHARS = 150;

/** Total context of the routing-off reviewer (Groq llama3-8b-8192). */
export const DIRECT_REVIEW_CONTEXT_TOKENS = 8192;
/** Headroom for the estimate itself being wrong in the cheap direction.
 *  estimateTokens over-estimates by design (length/3), which is the right
 *  asymmetry here: over-estimating costs a skipped review, under-estimating
 *  publishes a truncated one. */
const CONTEXT_SAFETY_MARGIN = 400;

function clip(text, max = BLOCKED_BY_MAX_CHARS) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}… [clipped, full text on the board]`;
}

/** Kept identical to office-context.js estimateTokens() and
 *  provider-common.js's — length/3, deliberately over-estimating. */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3);
}

/**
 * Does the review call fit the routing-off reviewer's total context?
 *
 * @returns {{fits: boolean, estimated: number, ceiling: number, reason: string|null}}
 */
export function estimateReviewFit({ factPack, draftContent, systemPrompt = REVIEW_SYSTEM, maxOutputTokens }) {
  const estimated = estimateTokens(factPack) + estimateTokens(draftContent)
    + estimateTokens(systemPrompt) + maxOutputTokens + CONTEXT_SAFETY_MARGIN;
  const fits = estimated <= DIRECT_REVIEW_CONTEXT_TOKENS;
  return {
    fits,
    estimated,
    ceiling: DIRECT_REVIEW_CONTEXT_TOKENS,
    reason: fits ? null
      : `review input+output ~${estimated} tokens exceeds the routing-off reviewer's ${DIRECT_REVIEW_CONTEXT_TOKENS}-token TOTAL context. `
        + 'Refused rather than sent: an overrun returns a truncated review that looks like a real one, because this provider reports no finish reason. '
        + 'Enabling routing moves the review to the judgment lane (131,000-token input) and removes this ceiling.',
  };
}

/**
 * Renders the deterministic facts the drafter is allowed to use.
 *
 * THE DRAFTER GETS FACTS AND NOTHING ELSE. Everything numeric in a published
 * report traces to a line in here, and the prompt forbids inventing any
 * figure not present. That is the whole reason a fact pack exists rather
 * than "here is the database, write something".
 *
 * A value the office could not read is rendered as an explicit UNVERIFIED or
 * UNREADABLE line, never omitted — office-context.js's due-date defect is the
 * worked example: a null rendered as nothing, and a commitment window with no
 * end date read exactly like a healthy one for a full day.
 *
 * @param {object} f
 * @returns {string}
 */
export function buildFactPack(f = {}) {
  const lines = [];
  const push = (s) => lines.push(s);

  push(`REPORT TYPE: ${f.reportType || 'unknown'}`);
  push(`PERIOD: ${f.periodLabel || 'unknown'}`);
  push(`GENERATED: ${f.dateStr || 'unknown'}`);
  push('');

  push('=== 1. CLIENT REQUIREMENTS (source: back-office docs/CLIENT-REQUIREMENTS.md) ===');
  if (f.requirements?.requirements?.length) {
    push(
      f.requirements.due
        ? `Commitment due date: ${f.requirements.due}. This date MUST appear in section 1 of the report.`
        : 'Commitment due date: UNVERIFIED — could not be parsed from docs/CLIENT-REQUIREMENTS.md. '
          + 'Report this as a DEFECT in section 1, in those words. Do not write that there is no deadline.'
    );
    if (f.daysRemaining != null) push(`Days remaining to the commitment date: ${f.daysRemaining}.`);
    for (const r of f.requirements.requirements) {
      push(`- ${r.id} [${r.status}]${r.urgent ? ' [URGENT — owner-assigned]' : ''}${r.crossCutting ? ' [cross-cutting]' : ''}: ${r.title}`);
    }
    push('Statuses are set by the weekly meeting. A status carried forward unchecked is a CLAIM, not evidence — say which when you know.');
  } else {
    push('UNREADABLE — the client requirements could not be read this cycle. Say so plainly in section 1; do not write that there are none.');
  }
  push('');

  push('=== 2/3. MEETING DECISIONS, VOTES AND CONFLICTS THIS PERIOD ===');
  if (f.decisions?.length) {
    for (const d of f.decisions) push(`- ${d}`);
  } else {
    // Reached only when the caller has POSITIVELY established that meeting
    // rows exist historically and none fall in this window. The caller is
    // responsible for the harder case — "we cannot see decisions at all" —
    // and passes an explicit UNVERIFIED line for it, because an empty array
    // cannot distinguish the two and this section is the one where that
    // confusion is most expensive. See agent-runner.js buildReportFacts().
    push('None recorded this period, and the record is known to be working. Say "no product decisions were taken this period" plainly — do not dress an empty period up as progress.');
  }
  push('');

  push('=== 4. THE OFFICE\'S OWN WORK — DELEGATION BOARD (source: back-office campus/shared/board/BOARD.md) ===');
  if (f.board?.counts) {
    const c = f.board.counts;
    push(`Board totals: ${c.total} tasks — ${['READY', 'IN-PROGRESS', 'BLOCKED', 'NOT-READY', 'DONE'].filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(' · ')}.`);
    push(`DISPATCHED: ${f.dispatchedCount ?? 'UNVERIFIED — the office does not yet record dispatch, so "READY" means ready to be dispatched, not started.'}`);
    for (const t of (f.board.tasks || []).slice(0, BOARD_TASKS_IN_PACK)) {
      const waiting = t.blockedBy && t.blockedBy !== 'nothing' ? ` — waiting on: ${clip(t.blockedBy)}` : '';
      push(`- ${t.id} [${t.state}] ${t.assignee || 'unassigned'} — ${t.title}${waiting}`);
    }
    // NO SILENT CAPS — the same rule office-context.js renderSection() keeps.
    // A truncated list that does not say it was truncated reads as the whole
    // list, and a report writer told "here are the office's tasks" will write
    // about that set as if it were all of them.
    if ((f.board.tasks || []).length > BOARD_TASKS_IN_PACK) {
      push(`(showing ${BOARD_TASKS_IN_PACK} of ${f.board.tasks.length} board tasks — say so if you refer to the board's size)`);
    }
  } else {
    push('UNREADABLE — the delegation board could not be read this cycle. Say so; do not report the office as having no open work.');
  }
  push('');

  push('=== 4b. PROJECTS THE OFFICE IS RESPONSIBLE FOR (source: config/office-projects.json) ===');
  if (f.projects?.length) {
    for (const p of f.projects) push(`- ${p.name} (${p.visibility}) — ${p.role}`);
  } else {
    push('UNREADABLE — no project list was passed to this report.');
  }
  push('');

  push('=== 4c. PRODUCTIVITY MEASURES (the Workflow\'s four, reported SEPARATELY — there is deliberately no single score) ===');
  if (f.workflowMetrics) {
    push(f.workflowMetrics);
  } else {
    push('Not computed this cycle. An agent with no recorded activity reports "no activity ever recorded", never "0 days" — those are different facts.');
  }
  push('');

  push('=== 5. AGENT STATE AND THE IMPROVEMENT LOOP ===');
  if (f.agentRows?.length) {
    for (const a of f.agentRows) push(`- Agent ${a.agentId} (${a.name}): ${a.weeklyCases} case(s) this period, mood ${a.mood}, irritation ${a.irritation}/5`);
  } else {
    push('No per-agent rows available this cycle.');
  }
  push(f.captureSummary || 'Improvement-loop capture: UNVERIFIED — no event counts were passed to this report.');
  push('');

  push('=== 5b. CAPABILITY GAPS FLAGGED THIS PERIOD (the Q&A engine\'s findings against the two client AI systems) ===');
  if (f.gapSummary) push(f.gapSummary);
  else push('No capability-gap figures were passed to this report.');
  push('');

  // ADDED 2026-08-08 after judging the first sample. The pack described the
  // office's STATE — requirements, board, moods — and not one thing the
  // office had PRODUCED, so a report built from it could answer "where do we
  // stand" and not "what did you do". Those are different questions and the
  // client asked the second one.
  push('=== 5c. WHAT THE OFFICE ACTUALLY PRODUCED THIS PERIOD ===');
  if (f.artifacts?.length) {
    for (const a of f.artifacts) push(`- ${a}`);
  } else {
    push('UNVERIFIED — no record of produced artifacts was passed to this report. Do not write that the office produced nothing.');
  }
  push('');

  push('=== 6. BLOCKED WORK ===');
  if (f.blocked?.length) {
    // Clipped for the same reason the board list is: this section repeats the
    // blocked-by prose already carried above, and the review call has to fit
    // the fact pack AND the draft inside an 8,192-token total context on the
    // routing-off path. Clipped visibly, never silently.
    for (const b of f.blocked.slice(0, BLOCKED_IN_PACK)) push(`- ${clip(b, 190)}`);
    if (f.blocked.length > BLOCKED_IN_PACK) {
      push(`(showing ${BLOCKED_IN_PACK} of ${f.blocked.length} blocked items — say the true total if you cite a count)`);
    }
  } else {
    push('Nothing was reported blocked this period.');
  }
  push('');

  push('=== ASSET PIPELINE (context only — do NOT lead with this) ===');
  push(f.pipelineSummary || 'No pipeline items.');

  return lines.join('\n');
}

/* ─────────────────────────────── Draft prompt ──────────────────────────── */

export const DRAFT_SYSTEM = `You are writing the office's own periodic report. You are not summarising a support queue.

The report is read by the office's client. He has said, in these words, that the existing report "doesn't summarise anything that makes sense" and that the agents "only discuss their own case-solving, not the projects on the todo list or the office's actual work." Writing another case tally is the one failure mode that matters.

Absolute rules:
- Use ONLY the facts in the FACTS block. Invent no number, no name, no date, no decision. If a fact is not there, the report does not claim it.
- A fact marked UNVERIFIED or UNREADABLE stays marked in your text, in those words. Never tidy one away — it changes a claim's status without changing the claim.
- Say "nothing moved" plainly when nothing moved. Dressing an empty period up as progress is worse than an empty period.
- English only.`;

export function buildDraftPrompt(factPack, { reportType, periodLabel, priorDraft } = {}) {
  const structure = REQUIRED_SECTIONS.map((s) => s.heading).join('\n');

  const base = `Write the office's ${reportType} report for ${periodLabel}.

FACTS — everything you may state, and nothing else:
"""
${factPack}
"""

Required structure, in this order, using these headings EXACTLY:

${SUMMARY_HEADING}
${structure}

Rules on the structure:
- "${SUMMARY_HEADING}" comes first and is 3-5 bullets: the most consequential thing, the most urgent thing, and what a reader must not miss. Someone who reads only this section should know how the office is doing.
- Section 1 is first among the numbered sections, always. It names each requirement by its REQ id, states its status, and puts the commitment due date in the text. If the due date is UNVERIFIED in the FACTS, say that it is a defect in those words.
- Sections 2 and 3 report decisions and conflicts. If there were none, say so in one line and move on.
- Section 4 reports the four productivity measures SEPARATELY. Do not average them into a score. It must also NAME the projects the office is responsible for and say what moved on each — a report that never names the office's projects has failed its reader, and that is the specific complaint this report exists to answer.
- Section 5 covers agent state, what the office actually PRODUCED this period, and what the improvement loop found. "What we produced" is a different question from "how we are doing" and the client asked the first one.
- Section 6 names what is blocked AND on whom or on what. "Blocked" with no owner is not a finding.

Length and readability — this is judged:
- ${TARGET_WORDS.min}-${TARGET_WORDS.max} words total. A report nobody finishes has failed.
- Prose in short paragraphs, bullets where a list is genuinely a list. No tables.
- No filler sections. A section with nothing in it gets one honest line.

End the report with this exact line, on its own, and write nothing after it:
${REPORT_SENTINEL}`;

  if (priorDraft) {
    return `${base}

This is a REVISION of a draft the reviewer sent back. Reviewer's note:
"""${priorDraft.reviewNotes || '(no note recorded)'}"""

Previous draft:
"""${priorDraft.draftContent || ''}"""

Rewrite the report to fully address the reviewer's note. Keep the structure above.`;
  }
  return base;
}

/* ─────────────────────────────── Review prompt ─────────────────────────── */

export const REVIEW_SYSTEM = `You are the QA. You are the LAST check before this report is published where the client can read it. There is no owner review step behind you — internal review is the entire quality control.

You have the FACTS the writer was given and the report they wrote. Check, in this order:

1. Does every claim in the report trace to a line in the FACTS? A number that is not in the FACTS is a fabrication, and it is a REJECT, not a REVISE.
2. Did the writer keep every UNVERIFIED and UNREADABLE marker? Silently dropping one is a REJECT — it changes a claim's status without changing the claim.
3. Does section 1 lead on the client requirements, with the commitment due date visible?
4. Does the report say what actually happened, or does it summarise cases and moods? A case tally is exactly what this pipeline exists to stop.
5. Is it short enough that someone would finish it, and structured so they could?

Respond in EXACTLY this format, nothing before or after:

DECISION: APPROVE | REVISE | REJECT
NOTES: <your reasoning — required and specific for REVISE/REJECT, one or two sentences for APPROVE>
---REPORT---
<the finalized report markdown, ONLY when DECISION is APPROVE — omit this section entirely for REVISE and REJECT>

An APPROVE MUST be followed by the ---REPORT--- marker and the COMPLETE finalized report, ending with its sentinel line. The text you output there is exactly what gets published: never reply APPROVE with only notes, a summary, or a pointer back to the draft. You may edit the report as you publish it — that is expected — but you may not shorten it past its required sections. Keep NOTES to one or two sentences on APPROVE so the report itself gets your output budget.`;

export function buildReviewPrompt(factPack, draftContent, { reportType, periodLabel, isSecondPass } = {}) {
  const secondPass = isSecondPass
    ? '\n\nThis is the SECOND review pass, after one revision round. If it still does not meet the bar, DECISION must be REJECT — there is no further round.'
    : '';
  return `Report type: ${reportType} · Period: ${periodLabel}

FACTS the writer was given:
"""
${factPack}
"""

The report to review:
"""
${draftContent}
"""${secondPass}`;
}

/** Parses the reviewer's structured response. Mirrors guide-engine.js
 *  parseReviewDecision() — an unparseable response is a REJECT, never an
 *  APPROVE, because the failure direction has to be the safe one. */
export function parseReportReviewDecision(text) {
  const raw = String(text || '');
  const decisionMatch = raw.match(/DECISION:\s*(APPROVE|REVISE|REJECT)/i);
  const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'REJECT';

  const splitIndex = raw.indexOf('---REPORT---');
  const notesBlock = splitIndex >= 0 ? raw.slice(0, splitIndex) : raw;
  const notesMatch = notesBlock.match(/NOTES:\s*([\s\S]*)$/);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  const finalReport = splitIndex >= 0 ? raw.slice(splitIndex + '---REPORT---'.length).trim() : '';

  return { decision, notes, finalReport: decision === 'APPROVE' ? finalReport : '' };
}

/* ────────────────────────────── Validation ─────────────────────────────── */

/** Counts UNVERIFIED / UNREADABLE markers. Used to prove the reviewer did not
 *  quietly remove one on its way to publication (rule 5). */
export function countUnverified(text) {
  const m = String(text || '').match(/\b(UNVERIFIED|UNREADABLE)\b/g);
  return m ? m.length : 0;
}

/**
 * Structural gate on an APPROVE body. Everything here is a REFUSAL that
 * leaves the row 'drafted' for a clean retry — none of it is a repair,
 * deliberately: a pipeline that patches its own output is a pipeline whose
 * checks have stopped meaning anything.
 *
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validateReportBody(finalReport, { factPack = '', due = null, projectNames = [] } = {}) {
  const reasons = [];
  const body = String(finalReport || '');
  const trimmed = body.trim();

  if (trimmed.length < MIN_APPROVED_REPORT_CHARS) {
    reasons.push(`body is ${trimmed.length} chars, under the ${MIN_APPROVED_REPORT_CHARS}-char floor — missing or truncated`);
  }

  // Truncation detector. See the header: no provider on this path reports a
  // finish reason, so the sentinel is standing in for one.
  if (!trimmed.endsWith(REPORT_SENTINEL)) {
    reasons.push(`body does not end with the sentinel "${REPORT_SENTINEL}" — treat as truncated, not as a decision`);
  }

  if (!new RegExp(`^${escapeRe(SUMMARY_HEADING)}\\s*$`, 'm').test(body)) {
    reasons.push(`missing the "${SUMMARY_HEADING}" section`);
  }

  for (const s of REQUIRED_SECTIONS) {
    // Number + leading words, so the reviewer may sharpen a heading's wording
    // but may not renumber, reorder or drop a section.
    const re = new RegExp(`^##\\s*${s.n}\\.\\s*.*${escapeRe(s.key)}`, 'im');
    if (!re.test(body)) reasons.push(`missing required section ${s.n} ("${s.key}")`);
  }

  // Section 1 must carry the deadline the whole report is measured against.
  // Only required when the office could actually read it — a due date that
  // failed to parse is a defect the report REPORTS, not one it invents past.
  if (due && !body.includes(due)) {
    reasons.push(`the commitment due date (${due}) does not appear in the report`);
  }

  // THE PROJECTS CHECK. The office's own projects reaching no report is the
  // exact defect that produced office-context.js and then survived its first
  // implementation at four of five call sites. Passing the list in is not the
  // same as the report using it, so the gate is on the OUTPUT: if the office
  // has projects and the report names none of them, it is the case log this
  // pipeline exists to replace. One name is enough — a project with genuinely
  // nothing to report should not force a sentence about itself.
  if (projectNames.length && !projectNames.some((n) => n && finalReport.includes(n))) {
    reasons.push(`the report names none of the office's ${projectNames.length} projects (${projectNames.join(', ')}) — that is a case log, not an office report`);
  }

  const packMarkers = countUnverified(factPack);
  const bodyMarkers = countUnverified(body);
  if (packMarkers > 0 && bodyMarkers < 1) {
    reasons.push(`the facts carried ${packMarkers} UNVERIFIED/UNREADABLE marker(s) and the report carries none — a marker was dropped`);
  }

  return { ok: reasons.length === 0, reasons };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word count, for the length-discipline line in the byline. Not a gate — the
 *  prompt asks for a range and the reviewer judges it; counting it here only
 *  makes drift visible in the published file. */
export function wordCount(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/* ─────────────────────────── Rendering / paths ─────────────────────────── */

/**
 * Byline header. Only personas that actually touched the report are named,
 * and the provider that answered is named beside each — the embodiment map is
 * a measurement instrument (config/model-routing.json `_why_random`), and a
 * report that does not say who wrote it cannot feed it.
 */
export function renderReportFile({
  reportType, periodLabel, dateStr, finalReport,
  drafterName, drafterProvider, reviewerName, reviewerProvider, revisionCount = 0,
}) {
  return `<!--
Drafted by: ${drafterName} (${drafterProvider || 'provider not recorded'})
Reviewed and published by: ${reviewerName} (${reviewerProvider || 'provider not recorded'})
Report type: ${reportType} · Period: ${periodLabel} · Date: ${dateStr}
Revision rounds: ${revisionCount} of 1 permitted
Words: ${wordCount(finalReport)}
Pipeline: workers/report-pipeline.js — drafted, reviewed, published. Not a template.
-->

${String(finalReport).trim()}
`;
}

/** A rejected report is SAVED with its rejection note and the pipeline moves
 *  on. It is never sent to the owner — same posture as a rejected guide. */
export function renderRejectedReportFile({
  reportType, periodLabel, dateStr, draftContent, reviewNotes, drafterName, reviewerName, structuralReasons = [],
}) {
  const structural = structuralReasons.length
    ? `\n**Structural refusals:**\n\n${structuralReasons.map((r) => `- ${r}`).join('\n')}\n`
    : '';
  return `# REJECTED ${reportType.toUpperCase()} REPORT — ${periodLabel}

**Drafted by:** ${drafterName} · **Reviewed by:** ${reviewerName} · **Date:** ${dateStr}

**Reviewer's note:**

${reviewNotes || '_No note provided._'}
${structural}
---

${String(draftContent).trim()}
`;
}

/** Published path. Phase 3 (plan item 0.4) moves the RAW output to
 *  back-office; the reviewed version keeps publishing here. */
export function reportPath(reportType, periodLabel) {
  return `reports/${reportType}/${periodLabel}-report.md`;
}

export function rejectedReportPath(reportType, periodLabel) {
  return `reports/_drafts/${reportType}-${periodLabel}.md`;
}

/* ────────────────────── The index: newest surfaces first ────────────────── */

export const LATEST_INDEX_PATH = 'reports/LATEST.md';
/** How many entries the index keeps. Old reports are never deleted — they stay
 *  in reports/<type>/ forever. This bounds the INDEX, not the archive. */
export const LATEST_INDEX_KEEP = 20;

const LATEST_HEADER = `# Latest reports

*The office's most recent reviewed reports, newest first. Maintained by
\`workers/report-pipeline.js\` — every entry below was drafted by one persona,
reviewed by another on a different provider, and published only after passing
a structural check.*

*This is an INDEX, not an archive. It keeps the most recent entries; nothing is
ever deleted from \`reports/<type>/\`, per the standing rule that what was
published stays published.*

`;

const LATEST_ENTRY_RE = /^- \[(.+?)\]\((.+?)\) — (\S+) · (\S+) · (\d+) words$/;

/** Parses reports/LATEST.md back into entries so a publish can prepend to it
 *  without a second source of truth. An unparseable line is DROPPED from the
 *  index, never silently rewritten — the file it points at is untouched. */
export function parseLatestIndex(text) {
  const entries = [];
  for (const raw of String(text || '').split('\n')) {
    const m = LATEST_ENTRY_RE.exec(raw.trim());
    if (m) entries.push({ title: m[1], path: m[2], reportType: m[3], dateStr: m[4], words: Number(m[5]) });
  }
  return entries;
}

export function renderLatestIndex(entries) {
  if (!entries.length) return `${LATEST_HEADER}_No reviewed reports have been published yet._\n`;
  const lines = entries
    .slice(0, LATEST_INDEX_KEEP)
    .map((e) => `- [${e.title}](${e.path}) — ${e.reportType} · ${e.dateStr} · ${e.words} words`);
  const omitted = entries.length > LATEST_INDEX_KEEP
    ? `\n\n_Showing the ${LATEST_INDEX_KEEP} most recent of ${entries.length}. Older reports remain in \`reports/<type>/\`._\n`
    : '\n';
  return `${LATEST_HEADER}${lines.join('\n')}${omitted}`;
}

/** Prepends one entry, de-duplicating by path so republishing the same period
 *  moves it to the top rather than listing it twice. */
export function addToLatestIndex(existing, entry) {
  return [entry, ...existing.filter((e) => e.path !== entry.path)];
}

/* ────────────────────────── D1: report_pipeline ────────────────────────── */

export const REPORT_PIPELINE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS report_pipeline (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  report_type TEXT NOT NULL,
  period_label TEXT NOT NULL,
  status TEXT DEFAULT 'drafted',
  fact_pack TEXT,
  draft_content TEXT,
  final_content TEXT,
  review_notes TEXT,
  revision_count INTEGER DEFAULT 0,
  drafter_agent_id INTEGER,
  drafter_provider TEXT,
  reviewer_agent_id INTEGER,
  reviewer_provider TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/** The drafted-but-unreviewed row for this period, if any. Same self-healing
 *  shape as the guides pipeline's getTodayDraftRow(): a missed review tick
 *  carries the draft forward instead of silently dropping it. */
export async function getPendingReportRow(env, reportType, periodLabel) {
  if (!env?.DB) return null;
  await env.DB.prepare(REPORT_PIPELINE_TABLE_SQL).run();
  return env.DB.prepare(
    `SELECT * FROM report_pipeline WHERE report_type = ? AND period_label = ? AND status = 'drafted' ORDER BY created_at DESC LIMIT 1`
  ).bind(reportType, periodLabel).first();
}

export async function getLatestReportRow(env, reportType, periodLabel) {
  if (!env?.DB) return null;
  await env.DB.prepare(REPORT_PIPELINE_TABLE_SQL).run();
  return env.DB.prepare(
    `SELECT * FROM report_pipeline WHERE report_type = ? AND period_label = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(reportType, periodLabel).first();
}

export async function insertReportRow(env, row) {
  if (!env?.DB) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(REPORT_PIPELINE_TABLE_SQL).run();
  await env.DB.prepare(
    `INSERT INTO report_pipeline
      (id, date, report_type, period_label, status, fact_pack, draft_content, final_content,
       review_notes, revision_count, drafter_agent_id, drafter_provider, reviewer_agent_id, reviewer_provider, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(
    id, row.date, row.reportType, row.periodLabel, row.status ?? 'drafted',
    row.factPack ?? null, row.draftContent ?? null, row.finalContent ?? null,
    row.reviewNotes ?? null, row.revisionCount ?? 0,
    row.drafterAgentId ?? null, row.drafterProvider ?? null,
    row.reviewerAgentId ?? null, row.reviewerProvider ?? null
  ).run();
  return id;
}

export async function updateReportRow(env, id, patch) {
  if (!env?.DB || !id) return;
  const fields = [];
  const values = [];
  for (const [key, column] of [
    ['status', 'status'], ['draftContent', 'draft_content'], ['finalContent', 'final_content'],
    ['reviewNotes', 'review_notes'], ['revisionCount', 'revision_count'],
    ['reviewerProvider', 'reviewer_provider'], ['drafterProvider', 'drafter_provider'],
  ]) {
    if (key in patch) {
      fields.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  await env.DB.prepare(`UPDATE report_pipeline SET ${fields.join(', ')} WHERE id = ?`).bind(...values, id).run();
}

/* ──────────────────────────── Period labelling ─────────────────────────── */

/** `week-07` / `month-02`. Stable, sortable, and the same shape the existing
 *  reports/weekly/week-NN-*.md files already use. */
export function periodLabelFor(reportType, n) {
  const num = String(n ?? 0).padStart(2, '0');
  return reportType === 'monthly' ? `month-${num}` : `week-${num}`;
}

/** Whole days from `fromIso` to the commitment date, or null when the due
 *  date could not be read. Null is returned rather than a guess — the report
 *  must be able to tell "no deadline" from "deadline unreadable". */
export function daysUntil(dueDateStr, nowMs = Date.now()) {
  if (!dueDateStr) return null;
  const due = Date.parse(`${String(dueDateStr).trim()}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  return Math.ceil((due - nowMs) / (24 * 60 * 60 * 1000));
}
