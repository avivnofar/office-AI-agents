/**
 * workers/report-pipeline.js — the office's substantive reports, drafted by a
 * model and reviewed by another before they are published.
 *
 * NOTE ON `droppedRowsNote()` BELOW: it is a deliberate second copy of the
 * function of the same name in `workers/office-context.js`, not an oversight.
 * This module imports NOTHING — that is what lets `scripts/verify-report-pipeline.js`
 * load and call it under plain `node` with no bindings, and importing
 * office-context.js (which reaches for config and KV) would end it. The
 * duplication is the smaller cost, and `verify-report-pipeline.js` §13 asserts
 * the two renderers agree so the copies cannot drift silently — which is the
 * actual risk A9's "never two copies" rule is about.
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
 * Truncation is therefore detected STRUCTURALLY: the DRAFT is required to end
 * with a literal sentinel line, and a draft missing the sentinel or any
 * required heading is refused. A response cut off at the ceiling loses its
 * tail, which is exactly where the sentinel is. This is weaker than a
 * provider-reported stop reason and is written down as such.
 *
 * ── THE REVIEWER JUDGES. IT DOES NOT REWRITE. (fixed 2026-08-09) ─────────
 *
 * The first live run failed here, and the cause was the review CONTRACT, not
 * the reviewer. The contract asked for `DECISION`, `NOTES`, and then the
 * COMPLETE finalized report again after a `---REPORT---` marker, and the
 * published artifact was sourced from that re-emission. The routing-off
 * reviewer (Groq llama3-8b-8192) emitted DECISION and NOTES and stopped;
 * parseReportReviewDecision() returned an empty body and the structural gate
 * refused it. That is not truncation — it is an 8B model declining to
 * re-type 792 words verbatim, which is a reasonable thing for it to decline.
 *
 * So the contract no longer asks. The reviewer returns DECISION + NOTES +
 * optional EDITS, and what publishes is `report_pipeline.draft_content` —
 * the stored draft, byte for byte, through the same validation gate. The
 * reviewer's judgement gates the text; it never becomes the text.
 *
 * Two consequences worth naming, because both are load-bearing:
 *   - EDITS are RECORDED, NEVER APPLIED. On a REVISE they are handed back to
 *     the writer, who rewrites. On an APPROVE they are filed in the byline
 *     and the D1 row. Nothing between the decision and the commit edits the
 *     report — a pipeline that patches its own output is a pipeline whose
 *     checks have stopped meaning anything, and that rule already governs
 *     validateReportBody().
 *   - The review's output budget collapses from a whole report (~1,600
 *     tokens) to a decision and a note (~500). That is most of the headroom
 *     the routing-off reviewer's 8,192-token TOTAL context did not have.
 *
 * ⚠ TO A SESSION THAT WANTS TO TIDY THIS UP: re-emitting the report from the
 * reviewer looks like it saves a round trip and lets the reviewer polish as
 * it approves. It does neither. It cost this pipeline its first live run and
 * it cost the guides pipeline a byline-only committed file on 2026-08-01 —
 * two subsystems, same mechanism. Do not reintroduce a `---REPORT---`
 * section. parseReportReviewDecision() actively DISCARDS one if a reviewer
 * emits it anyway.
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

/** Ends every published report. A DRAFT truncated at the token ceiling loses
 *  its tail, and the tail is this line. See the header's honest note on why a
 *  structural check is doing a provider's job here. Since 2026-08-09 this
 *  guards the DRAFT call's output, which is the only call that emits report
 *  text — the reviewer emits a decision and a note, never a report. */
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
  // Heading reordered 2026-08-09: what the office PRODUCED comes before agent
  // state. The first published report opened this section with thirteen lines
  // of mood and irritation and reached its real output — three guides, ten gap
  // findings, fifty notes — only afterwards. That is the case-log shape leaking
  // back into the one section that carries what the client actually asked for.
  // The `key` is unchanged, so the structural match is exactly as strict.
  { n: 5, key: 'Agent state', heading: '## 5. What the office produced, and agent state' },
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
/**
 * @unread-export lane names as constants for a reader;
 *     `planReportProviders()` in this same file resolves lanes from the config,
 *     so the string is not imported anywhere.
 */
export const DRAFT_LANE_HEBREW = 'hebrew_composition';
/**
 * @unread-export see DRAFT_LANE_HEBREW immediately above -- same reason,
 *     same file.
 */
export const DRAFT_LANE_OTHER = 'routine_volume';
/** AD-028's lane. See pickDraftLane(). */
export const DRAFT_LANE_REPORT = 'report_drafting';

/**
 * Which lane drafts a report. Always `report_drafting`, in every language.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OWNER DECISION AD-028 (2026-08-08) — REPORT DRAFTING IS PINNED TO GEMINI.
 * IMPLEMENTED 2026-08-09. READ BEFORE EDITING.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The requirement: **reports are drafted by Gemini.** With `routing_enabled`
 * on, the drafting call must resolve to Gemini whatever the routine lane's
 * primary happens to be.
 *
 * Until 2026-08-09 this function returned `routine_volume` for a non-Hebrew
 * report, and the office's reports are English (Front language is English
 * only, owner decision 2026-08-05). The routine lane's primary is Groq. So
 * the requirement would have broken the moment routing was switched on, and
 * broken silently — nothing at runtime compared the lane's primary against
 * the decision. It was recorded and left unimplemented deliberately, to land
 * in the session that turns routing on; it landed one session earlier
 * instead, in the session that was already rewriting this pipeline.
 *
 * The pin is a LANE (`config/model-routing.json` → `report_drafting`), not a
 * call-site constant, so which provider drafts a report stays a config edit.
 * It is language-independent on purpose: a pin conditional on language is a
 * pin with a path where it does not hold.
 *
 * ⚠ TO A SESSION THAT READS THIS AS AN INCONSISTENCY: it is not one. Do NOT
 * "simplify" report drafting back onto the routine lane, and do NOT repoint
 * `routine_volume`'s primary to Gemini to satisfy it — that lane's primary is
 * Groq by design and serves every other routine caller. Report drafting is
 * exempt by owner decision. **The exemption is the point, not an oversight**,
 * and the tidy-up is a one-line change that looks like a cleanup.
 *
 * Full reasoning, alternatives and the revisit condition:
 * back-office-AI-agents/docs/decisions/ARCHITECTURAL-DECISIONS.md AD-028.
 */
export function pickDraftLane(_language) {
  return DRAFT_LANE_REPORT;
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
 * @param {string|null} opts.draftLanePrimary  the provider the draft lane
 *   ACTUALLY resolves to, read from the live table by the caller
 *   (model-router.js resolveTaskLane). This module imports no config — see the
 *   header — so it cannot read the lane itself, and AD-028 is worth more than
 *   an assumption: the check is against the resolved value, not against the
 *   lane's name. Omitted means "the caller did not look", which is reported as
 *   NOT holding rather than assumed to hold.
 * @returns {{draft: object, review: object, geminiRequirementHolds: boolean, notes: string[]}}
 */
export function planReportProviders({ routingOn, language = 'english', draftLanePrimary = null } = {}) {
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
  const geminiRequirementHolds = draftLanePrimary === 'gemini';
  if (!geminiRequirementHolds) {
    notes.push(
      draftLanePrimary === null
        ? `routing_enabled is on and drafting resolves to the "${lane}" lane, but that lane's primary provider was not read from the table, `
          + 'so AD-028 ("reports are written by Gemini") could not be verified for this run. Reported as NOT holding rather than assumed — '
          + 'the caller must pass draftLanePrimary from model-router.js resolveTaskLane().'
        : `routing_enabled is on and drafting resolves to the "${lane}" lane, whose primary is "${draftLanePrimary}" and NOT Gemini. `
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
 * ⚠ HISTORICAL AS OF 2026-08-10 — THE CONSTRAINT DESCRIBED BELOW IS GONE.
 * Routing was enabled and DIRECT_REVIEW_CONTEXT_TOKENS was raised 8,192 ->
 * 131,000 the same day, so neither path is squeezed any more and
 * BOARD_TASKS_IN_PACK went 18 -> 60 with it. This block is kept as written
 * because it is what produced the two measures, and BOTH measures remain
 * correct and still run under the larger ceiling — a bounded pack and a
 * refusal are right regardless of how much room there is.
 *
 * The REVIEW call is the constrained one, and only in the routing-off state.
 * With routing off the reviewer was Groq's `llama3-8b-8192`, whose 8,192
 * tokens are TOTAL — prompt plus completion, not input alone. (That model was
 * decommissioned; see DIRECT_REVIEW_CONTEXT_TOKENS below.)
 * The review
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
 * 60, raised from 18 on 2026-08-10 when routing was enabled.
 *
 * ── WHY 18 EXISTED, AND WHY IT NO LONGER SHOULD ──────────────────────────
 *
 * 18 was measured 2026-08-08 against the live board: at 22 tasks the review
 * call came to ~8,065 of the routing-off reviewer's 8,192 total tokens — a
 * 1.5% margin, which is not a margin. At 18 it was ~7%. It was always a
 * symptom of DIRECT_REVIEW_CONTEXT_TOKENS below, never a judgement about how
 * much board a report should see.
 *
 * That ceiling is gone on BOTH paths (see DIRECT_REVIEW_CONTEXT_TOKENS), so
 * the cap that existed to respect it goes with it. Measured 2026-08-10
 * against the real 41-task board: the fact pack at 18 tasks was 3,827
 * estimated tokens and at the full 41 it is 4,780 — against a ceiling of
 * 131,000. The truncation was costing the office 23 of its own 41 tasks in
 * every report, to save 953 tokens out of a budget with six figures of room.
 *
 * ── STILL BOUNDED, DELIBERATELY ──────────────────────────────────────────
 *
 * 60 rather than "no cap". An unbounded list inside a bounded context is the
 * exact failure office-context.js already learned once — it passed every test
 * at three items and would have blown its budget the first day the board grew.
 * 60 clears today's 41 with room for the board to grow by half again, and if
 * it is ever exceeded the "(showing 60 of N)" marker still fires rather than
 * the list silently reading as complete.
 */
export const BOARD_TASKS_IN_PACK = 60;
/** The blocked list is bounded too, for the same reason, and raised 12 -> 30
 *  in the same 2026-08-10 change. NOT BINDING TODAY: the live board carries 7
 *  blocked items, so this cap has never actually clipped anything. Raised
 *  anyway so it does not become the next binding constraint the moment the
 *  board's blocked list grows — the point of lifting the ceiling was to stop
 *  managing scarcity that no longer exists. */
export const BLOCKED_IN_PACK = 30;
const BLOCKED_BY_MAX_CHARS = 150;

/**
 * Total context available to the review call, whichever path serves it.
 *
 * ── RAISED 8,192 -> 131,000 ON 2026-08-10, BY OWNER DECISION (OB-037) ────
 *
 * The old 8,192 was the TOTAL context of Groq's `llama3-8b-8192`. That model
 * was found decommissioned on 2026-08-09 (shut down 2025-08-30) and the client
 * now sends `llama-3.1-8b-instant`, whose context is 131,072. The session that
 * found it deliberately did NOT raise this number — raising it relaxes
 * `BOARD_TASKS_IN_PACK` above and changes what every report is built from, and
 * that was not a change to make in the same breath as a provider fix. It was
 * boarded as OB-037 and blocked on the owner. He approved it on 2026-08-10,
 * in the session that enabled routing, which is what put a real measurement
 * behind both halves of the decision.
 *
 * ── WHY 131,000 AND NOT 131,072 ──────────────────────────────────────────
 *
 * The two paths have DIFFERENT real ceilings, and this constant has to be safe
 * for both:
 *
 *   routing ON  — judgment lane, Cerebras `gpt-oss-120b`: 131,000 tokens of
 *                 INPUT, measured by binary search 2026-08-06. Output is
 *                 counted separately by that provider.
 *   routing OFF — direct path, Groq `llama-3.1-8b-instant`: 131,072 tokens
 *                 TOTAL, prompt plus completion.
 *
 * estimateReviewFit() below measures a TOTAL (fact pack + draft + system
 * prompt + max output + margin). Comparing that total against the smaller of
 * the two numbers, and against an INPUT-only limit as though it were a total
 * budget, is conservative in both directions at once. That is the whole
 * reason to take 131,000 rather than 131,072 — it is not a rounding
 * preference.
 *
 * ── THIS GUARD NO LONGER BINDS, AND THAT IS THE POINT ────────────────────
 *
 * Measured 2026-08-10 against the real 41-task board: the full review call is
 * ~7,600 tokens against 131,000 — about 6% of the ceiling. The guard is now a
 * backstop against something going badly wrong rather than a daily
 * constraint. It is kept, not deleted, because the failure it catches is
 * silent: neither groq-client.js nor gemini-client.js reports a finish reason,
 * so an overrun on the direct path comes back as a plausible-looking truncated
 * review rather than an error. A guard that rarely fires is still the only
 * thing standing between that failure and a published report.
 *
 * NOTE the number is NOT re-verified by this session against a live catalog.
 * 131,072 is carried from the 2026-08-09 finding and 131,000 from the
 * 2026-08-06 measurement. This project has been burned three times by a model
 * whose limits stopped being true, so treat both as due for the monthly
 * model-currency check rather than as permanent.
 */
export const DIRECT_REVIEW_CONTEXT_TOKENS = 131000;
/** Headroom for the estimate itself being wrong in the cheap direction.
 *  estimateTokens over-estimates by design (length/3), which is the right
 *  asymmetry here: over-estimating costs a skipped review, under-estimating
 *  publishes a truncated one. */
const CONTEXT_SAFETY_MARGIN = 400;

function clip(text, max = BLOCKED_BY_MAX_CHARS) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}… [clipped, full text on the board]`;
}

/**
 * Kept identical to office-context.js droppedRowsNote() — see this file's
 * header for why it is copied rather than imported, and
 * verify-report-pipeline.js §13 for the assertion that the two agree.
 *
 * Audit 2026-08-15, finding #3: a count that silently excludes the rows it
 * could not read publishes a number it cannot support. The weekly report's
 * "Board totals" line did exactly that — `f.board.malformed` was carried into
 * the fact pack and read by nothing — so a corrupted board and a
 * smaller-but-clean board produced identical client-facing text.
 */
function droppedRowsNote(malformed, noun = 'row') {
  const list = Array.isArray(malformed) ? malformed.filter(Boolean) : [];
  if (!list.length) return '';
  const plural = list.length === 1 ? noun : `${noun}s`;
  const parts = list.join(' · ').split('·').map((s) => s.trim()).filter(Boolean);
  const detail = parts.length <= 2 ? parts.join(' · ') : `${parts.slice(0, 2).join(' · ')} (+${parts.length - 2} more)`;
  return ` **${list.length} ${plural} could not be read and are NOT included in this count** — ${detail}.`;
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
 * ── `systemPrompt` IS REQUIRED, AND IT IS NOT REVIEW_SYSTEM (fixed 2026-08-09)
 *
 * This parameter defaulted to REVIEW_SYSTEM, and REVIEW_SYSTEM is not what
 * gets sent. agent-base.js queryGroqRouted() sends
 * `_buildPersonaSystemPrompt(...)`, which takes the system prompt it is given
 * and APPENDS the agent's state line, its behavioral rules and the office
 * context block (agent-base.js:266-274). Measured on the first live run:
 * 8,347 tokens against an 8,192 ceiling. The call overran, and the only thing
 * that stopped the guard from saying so was its own over-estimating bias
 * (length/3 against a real ~length/4) pointing the other way.
 *
 * A guard that measures the wrong string and happens not to bite is the exact
 * shape this project has now named in three subsystems. So the caller must
 * pass the ASSEMBLED prompt — the one the provider will actually receive —
 * and a call that omits it is REFUSED rather than estimated optimistically.
 * Fail-closed on a missing input, because the asymmetry is unchanged:
 * over-estimating costs a skipped review, under-estimating publishes a
 * truncated one.
 *
 * @returns {{fits: boolean, estimated: number|null, ceiling: number, reason: string|null}}
 */
export function estimateReviewFit({ factPack, draftContent, systemPrompt, maxOutputTokens }) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.length) {
    return {
      fits: false,
      estimated: null,
      ceiling: DIRECT_REVIEW_CONTEXT_TOKENS,
      reason: 'estimateReviewFit() was called without the system prompt that will actually be sent. '
        + 'It must be the ASSEMBLED persona prompt (agent-base.js _buildPersonaSystemPrompt), not REVIEW_SYSTEM — '
        + 'the assembly appends the state line, the behavioral rules and the office-context block, and measuring the '
        + 'un-assembled string under-reports the request by roughly a thousand tokens. Refused rather than guessed.',
    };
  }
  const estimated = estimateTokens(factPack) + estimateTokens(draftContent)
    + estimateTokens(systemPrompt) + maxOutputTokens + CONTEXT_SAFETY_MARGIN;
  const fits = estimated <= DIRECT_REVIEW_CONTEXT_TOKENS;
  return {
    fits,
    estimated,
    ceiling: DIRECT_REVIEW_CONTEXT_TOKENS,
    reason: fits ? null
      : `review input+output ~${estimated} tokens exceeds the reviewer's ${DIRECT_REVIEW_CONTEXT_TOKENS}-token context. `
        + 'Refused rather than sent: an overrun returns a truncated review that looks like a real one, because the direct-path providers report no finish reason. '
        + 'Since 2026-08-10 this ceiling is the same order of magnitude on both paths (Cerebras 131,000 input / Groq llama-3.1-8b-instant 131,072 total), '
        + 'so hitting it means something is genuinely wrong upstream rather than that the board grew.',
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
 * ── THE MARKER CONTRACT IS THE LITERAL TOKEN (settled 2026-08-09) ────────
 *
 * The first live draft was refused for dropping a marker, and it had not
 * disobeyed: DRAFT_SYSTEM said to keep the marker "in those words", while the
 * lines below told the writer to report the same fact as prose — "report this
 * as a DEFECT in section 1", and a DISPATCHED value whose text reads as a
 * sentence to copy. The writer kept the MEANING ("This section is a gap in
 * the office's own record-keeping", "As the office does not yet record
 * dispatch") and lost the WORD. countUnverified() matches the word, and fired
 * correctly by its own definition. Two instruction sites contradicted; the
 * checker agreed with one of them.
 *
 * The contract is now the LITERAL TOKEN, everywhere, and the reason is that
 * it is the only half of the choice that can be checked. "Conveys the same
 * status" is a judgement, and a rule no program can evaluate is a rule the
 * pipeline cannot enforce — rule 5 exists precisely so a dropped marker is
 * caught mechanically rather than noticed. So: MARKER_RULE below states it
 * once, the DISPATCHED and due-date lines no longer ask for a paraphrase,
 * DRAFT_SYSTEM and buildDraftPrompt() say the same thing, REVIEW_SYSTEM
 * checks for the same thing, and countUnverified() is unchanged because it
 * was already right.
 *
 * @param {object} f
 * @returns {string}
 */

/** Stated once, at the top of every fact pack, because it governs every
 *  section below it and repeating it per-line is how the two sites drifted
 *  apart in the first place. */
export const MARKER_RULE =
  'MARKER RULE — READ FIRST. Any line below containing the word UNVERIFIED or UNREADABLE marks a fact the office '
  + 'could not establish. Where your report states such a fact, your sentence must contain that same literal word, '
  + 'spelled exactly. Conveying the same meaning in other words does NOT satisfy this rule: an automated check looks '
  + 'for the word itself, and a report that carries the meaning without the word is refused and never published.';

/** `opts.nowMs` exists so the commitment-date wording is testable at a fixed
 *  clock — audit #5's whole point is what this renders on a date that has not
 *  arrived yet, and a check that cannot set the date cannot prove it. */
export function buildFactPack(f = {}, { nowMs = Date.now() } = {}) {
  const lines = [];
  const push = (s) => lines.push(s);

  push(`REPORT TYPE: ${f.reportType || 'unknown'}`);
  push(`PERIOD: ${f.periodLabel || 'unknown'}`);
  push(`GENERATED: ${f.dateStr || 'unknown'}`);
  push('');
  push(MARKER_RULE);
  push('');

  push('=== 1. CLIENT REQUIREMENTS (source: back-office docs/CLIENT-REQUIREMENTS.md) ===');
  if (f.requirements?.requirements?.length) {
    push(
      f.requirements.due
        ? `Commitment due date: ${f.requirements.due}. This date MUST appear in section 1 of the report.`
        : 'Commitment due date: UNVERIFIED — could not be parsed from docs/CLIENT-REQUIREMENTS.md. '
          + 'Section 1 must report this as a defect AND must contain the literal word UNVERIFIED when it does. '
          + 'Do not write that there is no deadline.'
    );
    // Was `Days remaining to the commitment date: ${f.daysRemaining}.` — which
    // prints "-3" from 2026-09-10 (audit #5 / KFM-18). `daysRemainingLine()`
    // owns the wording for all three cases; `f.daysRemaining` stays the
    // signed number so nothing downstream loses the fact.
    if (f.requirements?.due) {
      const line = daysRemainingLine(f.requirements.due, nowMs);
      if (line) push(line);
    } else if (f.daysRemaining != null) {
      push(`Days remaining to the commitment date: ${f.daysRemaining}.`);
    }
    for (const r of f.requirements.requirements) {
      push(`- ${r.id} [${r.status}]${r.urgent ? ' [URGENT — owner-assigned]' : ''}${r.crossCutting ? ' [cross-cutting]' : ''}: ${r.title}`);
    }
    push('Statuses are set by the weekly meeting. A status carried forward unchecked is a CLAIM, not evidence — say which when you know.');
  } else {
    push('UNREADABLE — the client requirements could not be read this cycle. Say so plainly in section 1; do not write that there are none.');
  }
  push('');

  // ── 1b. WHAT THE OFFICE NEEDS FROM THE CLIENT (added 2026-08-10) ────────
  //
  // The report is read by the client. A question the office is waiting on him
  // for belongs in it — and so does the fallback, because the fallback is the
  // reason the question is not a stall. He reads finished work; this section
  // exists so he can see the assumptions that work was finished under, and
  // overturn one if it is wrong.
  push('=== 1b. OPEN QUESTIONS TO THE CLIENT (source: back-office channel/to-owner/OPEN-QUESTIONS.md) ===');
  if (f.questions?.counts) {
    const open = (f.questions.questions || []).filter((q) => q.open);
    push(`${open.length} question(s) awaiting an answer; ${f.questions.counts.closed} answered, declined or withdrawn.`);
    for (const q of open) {
      push(`- ${q.id} (${q.askedBy}, ${q.date || 'undated'}): ${q.question}`);
      push(`    blocking: ${q.blocking || 'unstated'}`);
      push(`    if no answer comes: ${q.fallback}`);
    }
    if (open.length) {
      push('Report these as OPEN QUESTIONS with their fallbacks. NOT as blocked work — every one names what the office does anyway. A report that presents an open question as a stall is misreporting it.');
    }
  } else {
    push('UNREADABLE — the office→owner questions channel could not be read this cycle. Say so; do not report that the office has nothing to ask.');
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
    // The dropped-row note (audit 2026-08-15, finding #3). `f.board.malformed`
    // has been carried into this fact pack since the board parser existed and
    // was read by nothing, so this client-facing line published a total that
    // silently excluded every row the parser could not read. A corrupted board
    // and a smaller clean board produced identical text here.
    push(`Board totals: ${c.total} tasks — ${['READY', 'IN-PROGRESS', 'BLOCKED', 'NOT-READY', 'DONE'].filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(' · ')}.${droppedRowsNote(f.board.malformed, 'board task')}`);
    // The old form of this line was `DISPATCHED: ${count ?? '<a sentence>'}`,
    // and the sentence read as prose to reuse rather than a marked fact. The
    // first live draft duly wrote "As the office does not yet record
    // dispatch…" and lost the word. Split, so the VALUE and the INSTRUCTION
    // are not the same string.
    // ── OB-036/OB-038 CLOSED HERE, 2026-08-10 ──────────────────────────
    //
    // `dispatchedCount` was hardcoded `null` at its only call site, so this
    // branch was unreachable and every report published DISPATCHED: UNVERIFIED
    // — including reports written AFTER the board grew an IN-PROGRESS task with
    // a real `Dispatched:` line. Two consumers of the same file, one updated:
    // `office-context.js` counted the transition and the fact pack did not.
    //
    // The count now comes from the SAME markdown the humans read (the board's
    // `Dispatched:` field, written by dispatch.js), for the same reason
    // office-context.js parses the board instead of a JSON sidecar: a second
    // source of truth is a drift waiting to happen.
    //
    // ZERO IS A REAL NUMBER AND MUST NOT RENDER AS UNVERIFIED. "The record works
    // and nothing was dispatched" and "there is no record" are different facts,
    // and collapsing them is the defect this whole pipeline was built to stop —
    // so `0` takes the first branch, and only an unreadable board takes the
    // second. `!= null` does that; `if (f.dispatchedCount)` would not, which is
    // worth stating because it is the kind of edit that looks like a tidy-up.
    if (f.dispatchedCount != null) {
      push(`DISPATCHED: ${f.dispatchedCount} of the ${c.total} tasks carry a Dispatched line naming a holder and a deadline.`);
      if (f.dispatchedCount === 0) {
        push('  ^ Zero dispatched is a REAL measurement, not an absent one: the board records dispatch and none happened this period. Do NOT write UNVERIFIED for this.');
      }
      // Disagreement between the two board fields is itself a finding, and the
      // report should carry it rather than silently prefer one.
      if (f.inProgressCount != null && f.inProgressCount !== f.dispatchedCount) {
        push(`  ^ NOTE: ${f.inProgressCount} task(s) are IN-PROGRESS but ${f.dispatchedCount} carry a Dispatched line. The two should agree; where they do not, one of the writes is incomplete and that is a defect in the board's own record.`);
      }
    } else {
      push('DISPATCHED: UNVERIFIED — the board could not be read, so dispatch could not be counted at all. This is not evidence that nothing was dispatched.');
      // The anchors in this sentence ("dispatch", "satisfy the marker rule") are
      // load-bearing: verify-report-pipeline.js locates this line by them to
      // prove the INSTRUCTION is a separate line from the VALUE and that it
      // demands the literal token. Reword it and the guard silently stops
      // finding it — which is the failure mode the guard is about.
      push('  ^ When section 4 states this, the sentence must contain the literal word UNVERIFIED. Writing "the board could not be read" or "the office does not record dispatch" without that word does not satisfy the marker rule.');
    }
    if (f.offeredCount) {
      push(`OFFERED to an unattended Architect run: ${f.offeredCount}. An offer does NOT remove a task from the board or block it — those tasks are still READY and still claimable by the office.`);
    }
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

  push('=== 4a-bis. DELIVERABLES IN FLIGHT (source: back-office campus/shared/lifecycle/IN-FLIGHT.md) ===');
  // ── ADDED 2026-08-10 WITH THE DELIVERABLE LIFECYCLE ────────────────────
  //
  // Section 4 counted BOARD TASKS and could say nothing about what the office
  // had actually BUILT. week-07 is the evidence: it reported 34 board tasks and
  // never mentioned that `tasks/office-site/` had been finished for two days and
  // reviewed by nobody, because no fact in the pack could have told it.
  //
  // ABSENT AND EMPTY ARE DIFFERENT, and the two branches below keep them apart —
  // the §7.6 rule this pipeline exists to enforce. "Nothing is in review" is a
  // measurement; "the digest could not be read" is a failure, and a report that
  // renders the second as the first is exactly what the structural gate refuses.
  if (f.lifecycle) {
    if (!f.lifecycle.records.length) {
      push('NONE — no built deliverable is in the review loop. This is a REAL measurement, not an absent one: the digest was read and it is empty. Do NOT write UNVERIFIED for this.');
    } else {
      push(`${f.lifecycle.records.length} deliverable(s) in flight. A board task can be IN-PROGRESS while its deliverable sits in review; the two are different facts and section 4 counts the first.`);
      for (const r of f.lifecycle.records) {
        push(`- ${r.slug}${r.board_task ? ` (${r.board_task})` : ''} [${r.stage}, round ${r.round}] waiting on ${r.waiting_on}`);
        push(`  gaps: ${r.open_gaps} open, ${r.awaiting_vote} AWAITING A VOTE, ${r.unclassified} unclassified. Reviews still owed by: ${(r.owed_by || []).map((x) => `Agent ${x}`).join(', ') || 'nobody'}.`);
        if (!r.converging) push(`  ^ NOT CONVERGING: ${r.convergence_note}. Report this as a finding; there is no cap on review rounds.`);
        for (const x of (r.refusals || [])) push(`  ${x}`);
      }
    }
  } else {
    push('UNREADABLE — the deliverable-lifecycle digest could not be read this cycle. Say so; do NOT report the office as having built nothing.');
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

  // ── ORDER IS THE POINT HERE (reordered 2026-08-09) ──────────────────
  //
  // This block was added 2026-08-08 after judging the first sample: the pack
  // described the office's STATE — requirements, board, moods — and not one
  // thing the office had PRODUCED, so a report built from it could answer
  // "where do we stand" and not "what did you do", and the client asked the
  // second question.
  //
  // It was added LAST, as 5c, after the agent-state block. The first published
  // report duly opened section 5 with thirteen lines of mood and irritation and
  // reached the three guides and ten gap findings afterwards — a fact pack's
  // running order becomes a report's running order, and the case-log shape came
  // back in through the ordering. Output now comes first, and section 5b's
  // agent state is explicitly labelled as the tail of the section.
  push('=== 5. WHAT THE OFFICE ACTUALLY PRODUCED THIS PERIOD (section 5 OPENS with this) ===');
  if (f.artifacts?.length) {
    for (const a of f.artifacts) push(`- ${a}`);
  } else {
    push('UNVERIFIED — no record of produced artifacts was passed to this report. Do not write that the office produced nothing.');
  }
  push('');

  // ── 5a-bis. THE AXIS THE CONSISTENCY CHECK WAS MISSING (OB-038) ────────
  //
  // week-07 published "office-AI-agents: Nothing moved" in a period with 61
  // commits, and validateReportBody()'s consistency check could not catch it
  // because every fact it was given was indexed on THE PROJECT ASKED, never on
  // THE REPO WRITTEN TO. All five gap digests in 5a are attributed to
  // data-center or notebook-x — the systems the questions went to — and all
  // five were written INTO office-AI-agents. The two axes never met.
  //
  // The check was not weak and has not been weakened. What was missing was the
  // fact, and this section is the fact: one line per repository, naming the
  // repository, carrying a positive integer. projectsWithOutput() scans
  // sections 5/5a/5b for exactly that shape, so `office-AI-agents` now becomes
  // creditable with output without one word of the check changing.
  push('=== 5a-bis. WHERE THE OFFICE\'S OUTPUT WAS WRITTEN (indexed on the REPOSITORY, not on the system asked) ===');
  if (f.repoWrites?.length) {
    for (const w of f.repoWrites) push(`- ${w}`);
    push('This section and 5a index the SAME work on two different axes: 5a says which system a question was put to, this says which repository the answer was filed in. A project credited here MOVED, whatever 5a says about it.');
  } else if (f.repoWrites === null) {
    push('UNVERIFIED — the repo-write record could not be read this cycle, so which repositories received output is unknown. Do NOT infer that nothing was written; every gap digest and guide in the sections above was written somewhere.');
  } else {
    push('No repo write has been recorded this period. NOTE: durable recording of repo writes began 2026-08-10 — for any period before that the correct statement is UNVERIFIED, not zero, and section 5 above will still name output that was written somewhere.');
  }
  push('');

  push('=== 5a. CAPABILITY GAPS FLAGGED THIS PERIOD (the Q&A engine\'s findings against the two client AI systems) ===');
  if (f.gapSummary) push(f.gapSummary);
  else push('No capability-gap figures were passed to this report.');
  push('');

  push('=== 5b. AGENT STATE AND THE IMPROVEMENT LOOP (this comes AFTER the output above, and is the shorter half) ===');
  if (f.agentRows?.length) {
    for (const a of f.agentRows) push(`- Agent ${a.agentId} (${a.name}): ${a.weeklyCases} case(s) this period, mood ${a.mood}, irritation ${a.irritation}/5`);
  } else {
    push('No per-agent rows available this cycle.');
  }
  push(f.captureSummary || 'Improvement-loop capture: UNVERIFIED — no event counts were passed to this report.');
  push('Do NOT open section 5 with a per-agent mood list. Mood and irritation are the office\'s internal weather; the client asked what was produced.');
  // The Architect's unattended night work. Present only when a run was actually
  // filed — an absent line means nothing is known, and the fact pack says so
  // rather than reporting a quiet night, because a night with no run is the
  // normal case and is not a fact about the office at all.
  if (f.architectRuns?.length) {
    push(`Unattended Architect sessions filed this period: ${f.architectRuns.length}.`);
    for (const r of f.architectRuns) push(`- ${r.created_at}: ${r.title}`);
    push('These are occasional, unannounced, unattended runs — NOT a shift and NOT a schedule. Report what they produced; do not report them as a cadence, and do not imply the next one is expected.');
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
- A fact the FACTS mark UNVERIFIED or UNREADABLE keeps that literal word in your own sentence. Writing something that means the same thing is NOT enough: an automated check looks for the word itself, and a report that conveys the status without the word is refused. Never tidy one away — it changes a claim's status without changing the claim.
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
- Section 1 is first among the numbered sections, always. It names each requirement by its REQ id, states its status, and puts the commitment due date in the text. If the due date is UNVERIFIED in the FACTS, section 1 says so using the literal word UNVERIFIED.
- Every UNVERIFIED or UNREADABLE fact you report carries that literal word into your sentence. This is checked mechanically; a paraphrase fails it.
- Sections 2 and 3 report decisions and conflicts. If there were none, say so in one line and move on.
- Section 4 reports the four productivity measures SEPARATELY. Do not average them into a score. It must also NAME the projects the office is responsible for and say what moved on each — a report that never names the office's projects has failed its reader, and that is the specific complaint this report exists to answer.
- Section 5 OPENS with what the office actually PRODUCED this period — guides, findings, notes, anything shipped — then the improvement loop, then agent state LAST and briefly. "What we produced" is a different question from "how we are doing" and the client asked the first one. Do not lead this section with a per-agent mood list.
- Never say a project did not move if these FACTS credit that project with output. Saying "nothing moved" is right when nothing moved and false when the same FACTS record work against it.
- State what happened; do not explain WHY the office did it. These FACTS record events, never motives, so any sentence about what the office focused on, prioritised or chose is invented — it is refused even when the events it connects are real.
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

You JUDGE the report. You do not rewrite it and you do not reproduce it. The text that publishes is the writer's draft exactly as written; your decision is what gates it. Do not output the report, any part of the report, or a corrected version of it — there is no section in your reply for that, and any report text you emit is discarded.

You have the FACTS the writer was given and the report they wrote. Check, in this order:

1. Does every claim in the report trace to a line in the FACTS? A number that is not in the FACTS is a fabrication, and it is a REJECT, not a REVISE.
2. Did the writer keep every UNVERIFIED and UNREADABLE marker as that literal word? A paraphrase that conveys the same meaning is a DROPPED marker, not a kept one — it changes a claim's status without changing the claim.
3. Does section 1 lead on the client requirements, with the commitment due date visible?
4. Does the report say what actually happened, or does it summarise cases and moods? A case tally is exactly what this pipeline exists to stop.
5. Is it short enough that someone would finish it, and structured so they could?

Respond in EXACTLY this format, nothing before or after:

DECISION: APPROVE | REVISE | REJECT
NOTES: <your reasoning — required and specific for REVISE/REJECT, one or two sentences for APPROVE>
EDITS:
- <optional. One bullet per change you want, naming the section. Leave this section out entirely if you want none.>

Rules on your reply:
- APPROVE means "publish this text as it stands". If you want any wording changed, the decision is REVISE and the changes go in EDITS, where the writer will act on them.
- EDITS on an APPROVE are recorded as observations and are NOT applied. Nothing rewrites the report between your decision and its publication.
- Keep the whole reply short. You are writing a decision, not a document.`;

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

/** Empty-ish EDITS. An 8B reviewer told a section is optional will frequently
 *  emit the header with "none" under it rather than omitting it. */
/** Leading bullet stripped first: the live reviewer answered `- None.` under
 *  the EDITS header, which the un-bulleted form missed and which then rendered
 *  into a published byline as "RECORDED, NOT APPLIED — - None." */
const NO_EDITS_RE = /^(?:[-*•]\s*)?(none|n\/?a|-+|—|no edits|nothing|no changes( needed)?)[.!]?$/i;

/**
 * Parses the reviewer's structured response into a DECISION, a NOTE and an
 * optional EDITS list. Mirrors guide-engine.js parseReviewDecision() — an
 * unparseable response is a REJECT, never an APPROVE, because the failure
 * direction has to be the safe one.
 *
 * ⚠ THERE IS DELIBERATELY NO `finalReport` HERE. It is not an oversight and it
 * is not a field waiting to be re-added. What publishes is
 * `report_pipeline.draft_content`; sourcing the published artifact from the
 * reviewer's own output is the mechanism that failed this pipeline's first
 * live run and the guides pipeline's first supervised run. See the header.
 *
 * A reviewer that emits a `---REPORT---` section anyway — an older prompt in
 * a cache, a model pattern-matching on the old contract — has that text
 * DISCARDED, not published and not folded into the notes. `reEmitted` says so
 * to the caller so the drift is visible in the log instead of silent.
 */
export function parseReportReviewDecision(text) {
  const raw = String(text || '');

  // Cut any re-emitted report off the front-matter before parsing anything, so
  // a stray report body can never be mistaken for a NOTE or an EDIT.
  const strayIndex = raw.indexOf('---REPORT---');
  const head = strayIndex >= 0 ? raw.slice(0, strayIndex) : raw;

  const decisionMatch = head.match(/DECISION:\s*(APPROVE|REVISE|REJECT)/i);
  const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'REJECT';

  const editsIndex = head.search(/^[ \t]*EDITS:/im);
  const notesRegion = editsIndex >= 0 ? head.slice(0, editsIndex) : head;
  const notesMatch = notesRegion.match(/NOTES:\s*([\s\S]*)$/i);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  let edits = '';
  if (editsIndex >= 0) {
    edits = head.slice(editsIndex).replace(/^[ \t]*EDITS:/i, '').trim();
    if (NO_EDITS_RE.test(edits)) edits = '';
  }

  return { decision, notes, edits, reEmitted: strayIndex >= 0 };
}

/* ────────────────────────────── Validation ─────────────────────────────── */

/**
 * Counts UNVERIFIED / UNREADABLE markers. Used to prove a marker in the facts
 * survived into the published text (rule 5).
 *
 * THIS MATCHES THE LITERAL TOKEN, AND THAT IS THE CONTRACT — not an accident
 * of implementation, and not a strictness to relax the next time a draft is
 * refused for a paraphrase. See buildFactPack()'s marker-contract note: the
 * literal token was chosen over "conveys the same status" because only one of
 * the two can be checked, and rule 5 is worth nothing unchecked. Every
 * instruction site (MARKER_RULE, DRAFT_SYSTEM, buildDraftPrompt(),
 * REVIEW_SYSTEM) now asks for exactly what this function measures.
 */
export function countUnverified(text) {
  const m = String(text || '').match(/\b(UNVERIFIED|UNREADABLE)\b/g);
  return m ? m.length : 0;
}

/**
 * The fact pack's OWN boilerplate — MARKER_RULE, and the handful of
 * instruction/negative-example lines buildFactPack() pushes alongside a
 * REAL zero or a REAL value (e.g. "Do NOT write UNVERIFIED for this.") —
 * itself contains the literal words countUnverified() matches. MARKER_RULE
 * alone contributes 2 to any factPack, unconditionally, which used to make
 * `countUnverified(factPack) > 0` true for EVERY report regardless of
 * whether the period actually had anything genuinely unverified (audit א.1:
 * measured `countUnverified(MARKER_RULE) = 2`, `countUnverified(buildFactPack(...)) = 10`,
 * so `packMarkers > 0` never varied with the real data). Listed verbatim so
 * a genuine data marker (e.g. "UNREADABLE — the client requirements could
 * not be read this cycle.") is never accidentally matched by a fragment of
 * one of these and stripped along with it.
 */
export const MARKER_RULE_BOILERPLATE = [
  MARKER_RULE,
  'Section 1 must report this as a defect AND must contain the literal word UNVERIFIED when it does. ',
  '  ^ Zero dispatched is a REAL measurement, not an absent one: the board records dispatch and none happened this period. Do NOT write UNVERIFIED for this.',
  '  ^ When section 4 states this, the sentence must contain the literal word UNVERIFIED. Writing "the board could not be read" or "the office does not record dispatch" without that word does not satisfy the marker rule.',
  'NONE — no built deliverable is in the review loop. This is a REAL measurement, not an absent one: the digest was read and it is empty. Do NOT write UNVERIFIED for this.',
  'No repo write has been recorded this period. NOTE: durable recording of repo writes began 2026-08-10 — for any period before that the correct statement is UNVERIFIED, not zero, and section 5 above will still name output that was written somewhere.',
];

/**
 * The number of GENUINE UNVERIFIED/UNREADABLE markers in a fact pack — every
 * occurrence of MARKER_RULE_BOILERPLATE removed first, so a fully clean
 * period (no genuine gap anywhere) counts zero, not two. This is what the
 * duplicate-publish-style structural gate below should have been counting
 * all along; countUnverified() itself is unchanged and still matches the
 * literal token everywhere else (the drafted BODY, which never contains
 * this boilerplate, is still measured with countUnverified() directly).
 */
export function countGenuineMarkers(text) {
  let stripped = String(text || '');
  for (const boilerplate of MARKER_RULE_BOILERPLATE) {
    stripped = stripped.split(boilerplate).join('');
  }
  return countUnverified(stripped);
}

/* ── TWO CHECKS ADDED 2026-08-09, AFTER THE FIRST PUBLISHED REPORT ───────
 *
 * The first report to clear this gate said, in section 4:
 *
 *   "nothing moved on Data Center, Notebook-X, office-AI-agents,
 *    back-office-AI-agents, or warehouse-office-AI-agents this period, as the
 *    office focused on clearing internal administrative tasks and
 *    capability-gap reporting."
 *
 * The section below it then listed three approved guides and ten capability-gap
 * findings — three against Data Center, seven against Notebook-X. Both claims
 * came from the same fact pack. The QA read both and approved.
 *
 * BOTH CHECKS LIVE HERE AND NOT IN THE REVIEW PROMPT. The reviewer had the
 * facts, had the draft, had a checklist item for exactly this ("does the report
 * say what actually happened"), and passed it. Asking it more loudly is the
 * move this project has already learned does not work; the gate is where a
 * rule becomes enforcement.
 */

/** Phrases that assert a project did not move. The drafter is DELIBERATELY
 *  told to say "nothing moved" plainly when nothing moved (DRAFT_SYSTEM), so
 *  this is not a banned phrase — it is a phrase that must not contradict the
 *  facts the sentence is drawn from. */
const NO_MOVEMENT_RE = /\b(nothing (?:moved|progressed|changed|happened|shipped)|no (?:movement|progress|activity|work|change)\b|did ?n[o']t move|made no progress|saw no (?:movement|progress|activity))/i;

/**
 * Which projects does the fact pack attribute PRODUCED OUTPUT to?
 *
 * Scoped to the produced/gap sections rather than the whole pack on purpose:
 * every project is NAMED in section 4b (the roster) and most appear in the
 * board, and neither of those is output. Only a positive count inside the
 * sections that record what the office made counts as movement.
 *
 * Matching is on both the project's key (`notebook-x` — how the gap rows are
 * attributed) and its display name (`Notebook-X` — how the report writes it),
 * because the fact pack carries the first and the report carries the second.
 */
export function projectsWithOutput(factPack, projects = []) {
  const pack = String(factPack || '');
  const start = pack.search(/^=== 5[ab]?\./m);
  const end = pack.search(/^=== 6\./m);
  if (start < 0) return [];
  const region = pack.slice(start, end > start ? end : undefined);

  const withOutput = [];
  for (const p of projects) {
    const aliases = [p?.key, p?.name].filter(Boolean).map((a) => String(a));
    if (!aliases.length) continue;
    const hit = region.split('\n').some((line) => {
      if (!aliases.some((a) => line.toLowerCase().includes(a.toLowerCase()))) return false;
      // A positive integer on the line. "0 findings" and "none" are not output.
      const nums = line.match(/\b(\d+)\b/g) || [];
      return nums.some((n) => Number(n) > 0);
    });
    if (hit) withOutput.push(p);
  }
  return withOutput;
}

/**
 * A motive attributed to the office or its agents.
 *
 * ── WHY THIS IS NARROWER THAN "AN UNSUPPORTED CAUSAL CLAIM" ──────────────
 *
 * The general rule — "a causal claim not present in the facts is a
 * fabrication" — is correct and is NOT mechanically checkable. A report may
 * legitimately reason FROM the facts ("neither has a stamped deadline yet, so
 * neither can be reported as late"), and no regular expression separates a
 * sound inference from an invented one. A check that tried would be wrong in
 * both directions, and a guard that is wrong and happens not to bite is the
 * exact thing this session was convened to fix. Writing one would have been
 * worse than writing none.
 *
 * What IS checkable is the specific class the live failure belongs to: a
 * claim about why the OFFICE acted — its focus, its priorities, its choices.
 * The fact pack records what happened and never why anyone did it, so there is
 * no line in it that could ground such a claim, whatever it says. That makes
 * the refusal sound rather than heuristic: the source material cannot support
 * this shape of sentence at all.
 *
 * The narrower scope is recorded rather than quietly taken. A report that
 * invents a cause NOT about the office's own motives still gets past this, and
 * the reviewer remains the only thing looking for it.
 */
const MOTIVE_CLAIM_RE = new RegExp(
  // a causal connective …
  '\\b(?:as|because|since|due to|owing to|thanks to|driven by|in order to|so as to|the reason(?:\\s+\\w+){0,3}\\s+is)\\b'
  // … then, close by, the office or its people …
  + '[^.!?\\n]{0,60}?\\b(?:the office|the team|the agents?|we|they|management|the personas?)\\b'
  // … doing something volitional.
  + '[^.!?\\n]{0,60}?\\b(?:focus(?:ed|es|ing)?|prioriti[sz](?:ed|es|ing)?|chose|choos(?:e|ing)|decid(?:ed|es|ing)|opted?|elect(?:ed|s)?|prefer(?:red|s)?|intend(?:ed|s)?|deliberately|intentionally|aimed?|sought|wanted|tried)\\b',
  'i'
);

/**
 * Structural gate on an APPROVE body. Everything here is a REFUSAL that
 * leaves the row 'drafted' for a clean retry — none of it is a repair,
 * deliberately: a pipeline that patches its own output is a pipeline whose
 * checks have stopped meaning anything.
 *
 * `projects` (full `{key, name}` objects) supersedes `projectNames`; the older
 * parameter still works so no existing caller silently loses its naming check.
 * The consistency check needs the keys, which names alone do not carry.
 *
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validateReportBody(finalReport, { factPack = '', due = null, projectNames = [], projects = [] } = {}) {
  const projectList = projects.length ? projects : projectNames.map((name) => ({ key: null, name }));
  projectNames = projectList.map((p) => p.name).filter(Boolean);
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
  if (projectNames.length && !projectNames.some((n) => n && body.includes(n))) {
    reasons.push(`the report names none of the office's ${projectNames.length} projects (${projectNames.join(', ')}) — that is a case log, not an office report`);
  }

  // ── CONSISTENCY: "nothing moved" against output the facts attribute ──
  //
  // Sentence-scoped, not report-scoped. A report may legitimately say nothing
  // moved on project A in the same paragraph that credits project B — what it
  // may not do is say nothing moved on a project the facts credit with output.
  const produced = projectsWithOutput(factPack, projectList);
  if (produced.length) {
    for (const sentence of body.split(/(?<=[.!?])\s+|\n/)) {
      if (!NO_MOVEMENT_RE.test(sentence)) continue;
      const contradicted = produced.filter((p) => p.name && sentence.includes(p.name));
      if (contradicted.length) {
        reasons.push(
          `the report claims no movement on ${contradicted.map((p) => p.name).join(', ')} `
          + `while the facts credit ${contradicted.length > 1 ? 'those projects' : 'that project'} with output this period `
          + `("${sentence.trim().slice(0, 140)}…"). Saying "nothing moved" is correct when nothing moved; `
          + 'it is a false claim when the same fact pack records work produced against that project.'
        );
        break;
      }
    }
  }

  // ── FABRICATION: a motive attributed to the office ───────────────────
  //
  // Not "an unsupported causal claim" — see MOTIVE_CLAIM_RE for why the
  // general form is not checkable and why this narrower one is sound.
  const motive = body.split(/(?<=[.!?])\s+|\n/).find((s) => MOTIVE_CLAIM_RE.test(s));
  if (motive) {
    reasons.push(
      `the report asserts a motive for the office's own actions ("${motive.trim().slice(0, 140)}…"). `
      + 'The fact pack records what happened and never why anyone did it, so no line in it can ground a claim of this shape — '
      + 'it is a fabrication even when the facts it connects are real. State what happened; do not explain why it happened.'
    );
  }

  // ── FIXED 2026-08-14 (audit א.1) ────────────────────────────────────────
  // packMarkers used to be countUnverified(factPack) directly. MARKER_RULE
  // alone contributes 2 to every factPack unconditionally (it teaches the
  // rule using the words it governs), so `packMarkers > 0` was true for
  // EVERY report regardless of whether the period had a genuine gap —
  // collapsing rule 5 to "the body must contain the marker word", which
  // some of the SAME boilerplate explicitly instructs the writer NOT to do
  // at that spot. countGenuineMarkers() strips MARKER_RULE_BOILERPLATE
  // before counting, so a period with zero real UNVERIFIED/UNREADABLE facts
  // now correctly measures zero.
  const packMarkers = countGenuineMarkers(factPack);
  const bodyMarkers = countUnverified(body);
  if (packMarkers > 0 && bodyMarkers < 1) {
    reasons.push(
      `the facts carried ${packMarkers} genuine UNVERIFIED/UNREADABLE marker(s) and the report carries none — a marker was dropped. `
      + 'The contract is the literal word, not the conveyed meaning (see countUnverified()); a sentence that means '
      + '"we could not establish this" without containing UNVERIFIED or UNREADABLE does not satisfy it.'
    );
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
/**
 * A provider that answered when a different one was planned.
 *
 * ── A FALLBACK NOBODY NOTICES IS A MEASUREMENT NOBODY CAN TRUST ─────────
 *
 * Both of the first two live runs planned Groq for the review and were
 * answered by Cloudflare Workers AI. Nothing said so. The degradation is
 * correct behaviour — it is exactly what the fallback exists for — but the
 * byline is the embodiment record (config/model-routing.json `_why_random`),
 * and a record that names the planned provider instead of the one that
 * answered is measuring the wrong thing.
 *
 * ── THE CAUSE, CORRECTED 2026-08-09 ──────────────────────────────────────
 *
 * This comment previously read: *"The cause, found 2026-08-09, was a dead
 * GROQ_API_KEY returning HTTP 401 on every call."* **That was wrong**, and it
 * is left visible here rather than quietly overwritten, because the error is
 * more instructive than the fact.
 *
 * The real cause, captured the same day from `wrangler tail` during a live
 * call, was **HTTP 400 `model_decommissioned`**: `llama3-8b-8192` was shut
 * down by Groq on 2025-08-30. The key was never dead — it authenticated on
 * every one of those calls, and Groq's own dashboard showed the usage.
 *
 * Nobody had read the response body. The symptom — every Groq call silently
 * answered by someone else — is identical under a dead key and a dead model,
 * and "the key expired" is the cheaper story. Acting on it would have meant
 * rotating a working credential across four places, with four confusably-named
 * Groq keys in play. See AD-030 in back-office-AI-agents.
 */
export function providerLabel(planned, actual) {
  if (!actual) return `${planned || 'provider'} — NO PROVIDER RECORDED`;
  if (!planned || planned === actual) return actual;
  return `${actual} — SUBSTITUTED, ${planned} was planned and did not answer`;
}

export function renderReportFile({
  reportType, periodLabel, dateStr, finalReport,
  drafterName, drafterProvider, reviewerName, reviewerProvider, revisionCount = 0, reviewerEdits = '',
  drafterPlanned = null, reviewerPlanned = null, workerVersion = null,
}) {
  // Recorded, never applied. The line exists so an edit the reviewer wanted is
  // visible in the artifact rather than living only in a D1 column — and so
  // the difference between "asked for" and "applied" is on the page.
  const edits = String(reviewerEdits || '').trim();
  const editsLine = edits
    ? `Reviewer's edits: RECORDED, NOT APPLIED — ${clip(edits.replace(/\s+/g, ' '), 400)}\n`
    : '';
  return `<!--
Drafted by: ${drafterName} (${providerLabel(drafterPlanned, drafterProvider)})
Reviewed by: ${reviewerName} (${providerLabel(reviewerPlanned, reviewerProvider)})
Published text: the draft above, as written. The reviewer judged it; it did not rewrite it.
${editsLine}Report type: ${reportType} · Period: ${periodLabel} · Date: ${dateStr}
Revision rounds: ${revisionCount} of 1 permitted
Words: ${wordCount(finalReport)}
Worker version: ${workerVersion || 'UNRECORDED — no version_metadata binding on this deploy'}
Pipeline: workers/report-pipeline.js — drafted, reviewed, published. Not a template.
-->

${String(finalReport).trim()}
`;
}

/**
 * A report that did not publish is SAVED with the reason it did not. It is
 * never sent to the owner — same posture as a rejected guide.
 *
 * `headline` exists because there are now TWO ways not to publish and they are
 * not the same event. A REJECT is the reviewer's judgement. A structural
 * refusal is the gate overruling an APPROVE, which means the reviewer said
 * yes — and a file headed "REJECTED" over an approving reviewer's note would
 * be the artifact lying about what happened. Default stays REJECTED so the
 * pre-existing call site is unchanged.
 */
export function renderRejectedReportFile({
  reportType, periodLabel, dateStr, draftContent, reviewNotes, drafterName, reviewerName,
  structuralReasons = [], headline = null,
}) {
  const structural = structuralReasons.length
    ? `\n**Structural refusals:**\n\n${structuralReasons.map((r) => `- ${r}`).join('\n')}\n`
    : '';
  return `# ${headline || `REJECTED ${reportType.toUpperCase()} REPORT`} — ${periodLabel}

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

/** Whether this period was EVER approved -- not just whether the MOST RECENT
 *  row is approved. The duplicate-publish guard needs this distinction: a
 *  period can be approved once and then have later, unrelated rows (e.g. a
 *  stuck self-locking-gate retry loop, audit א.2) land as 'rejected' on top
 *  of it, which would make the latest row 'rejected' while the period is
 *  still published and must never be redrafted. Confirmed against live D1
 *  2026-08-14: week-07 carries 3 approved rows from 08-09 followed by 7
 *  rejected retries through 08-14 -- getLatestReportRow() alone would have
 *  missed this exact case, which is why this function exists instead of
 *  reusing it for the guard. */
export async function getApprovedReportRow(env, reportType, periodLabel) {
  if (!env?.DB) return null;
  await env.DB.prepare(REPORT_PIPELINE_TABLE_SQL).run();
  return env.DB.prepare(
    `SELECT * FROM report_pipeline WHERE report_type = ? AND period_label = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`
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
    ['factPack', 'fact_pack'],
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

/**
 * `year-1-week-07` / `year-1-month-02`. Stable and sortable.
 *
 * ── OB-086 / KFM-17, 2026-08-16: THE YEAR IS NOT DECORATION ────────────────
 *
 * This returned `week-07` until 2026-08-16, and the missing year was a live
 * defect in **two** places at once, because this label is not only a filename:
 *
 *  1. **The published path.** `reportPath()` builds
 *     `reports/weekly/<label>-report.md` in the PUBLIC repo. `current_week`
 *     resets to 0 at year end (`agent-runner.js`, `isYearEnd`), so year 2's
 *     week-07 would have written straight over year 1's published — possibly
 *     owner-edited — report.
 *  2. **The duplicate-publish guard's key.** `getApprovedReportRow()` looks up
 *     `(report_type, period_label)`. So the guard would NOT have let the
 *     overwrite through — it would have done the opposite and refused to
 *     publish year 2 at all, on the grounds that "week-07 was already
 *     approved" a year earlier. **Both outcomes are wrong, and they are the
 *     same missing field.** A guard whose key cannot distinguish two periods
 *     does not protect the first one; it erases the second.
 *
 * **Simulation year, not calendar year.** The index that collides is a
 * simulation index — `current_week` is `ceil(current_day / 7)` over a 365-day
 * simulation year that advances six days a calendar week (Sunday–Friday;
 * Saturday is the rest day, A13). A simulation year is therefore ~366 calendar
 * days but is not aligned to one, so a calendar year would not reliably
 * separate the two cycles. `campus/shared/promotions/promotion-results-year-N.md`
 * already set this precedent.
 *
 * @param {string} reportType  'weekly' | 'monthly'
 * @param {number} n           the period index within the simulation year
 * @param {number} yearNumber  `yearState.stats.year_number`, 1-based
 */
export function periodLabelFor(reportType, n, yearNumber = 1) {
  const num = String(n ?? 0).padStart(2, '0');
  const year = Number.isInteger(yearNumber) && yearNumber > 0 ? yearNumber : 1;
  return `year-${year}-${reportType === 'monthly' ? 'month' : 'week'}-${num}`;
}

/**
 * The label this function returned BEFORE the year was added — `week-07`.
 *
 * Kept because the office already published under it: live D1 on 2026-08-16
 * held approved rows for `week-07` and `week-08` and a rejected `week-09`, and
 * the matching files are in the public repo. Those are **not renamed** (A15 —
 * corrections are appended, history is not rewritten, and every link to them
 * would break).
 *
 * The consequence has to be handled rather than noted: if the guard looked up
 * only the new label, sim week 8 would read as never-published and the office
 * would draft it again and publish to `year-1-week-08-report.md` **beside**
 * the existing `week-08-report.md` — one period, two published reports. That
 * is the same defect this change exists to prevent, arriving from the other
 * direction, and it would have fired within days: `current_week` was 8 when
 * this was written.
 *
 * Year 1 only. No other simulation year ever wrote a label in this shape, so
 * returning one for year 2+ would invent a collision rather than resolve one.
 */
export function legacyPeriodLabelFor(reportType, n) {
  const num = String(n ?? 0).padStart(2, '0');
  return reportType === 'monthly' ? `month-${num}` : `week-${num}`;
}

/**
 * Every label under which this period may ALREADY have published, newest shape
 * first. The duplicate-publish guard checks all of them; `reportPath()` uses
 * only `[0]`, so nothing new is ever written at a yearless path.
 *
 * This is the "tolerate two shapes and say which is which" OB-086 asks for:
 * the guard reports WHICH label matched, so a refusal naming `week-08` is
 * legible as a pre-2026-08-16 publication rather than looking like a bug.
 */
export function periodLabelCandidates(reportType, n, yearNumber = 1) {
  const canonical = periodLabelFor(reportType, n, yearNumber);
  const year = Number.isInteger(yearNumber) && yearNumber > 0 ? yearNumber : 1;
  return year === 1 ? [canonical, legacyPeriodLabelFor(reportType, n)] : [canonical];
}

/** Whole days from `fromIso` to the commitment date, or null when the due
 *  date could not be read. Null is returned rather than a guess — the report
 *  must be able to tell "no deadline" from "deadline unreadable".
 *
 *  SIGNED ON PURPOSE. A negative value is the real answer and callers need it
 *  to say OVERDUE; see `daysRemainingLine()`, which is what a report renders.
 *  Clamping here would have destroyed the fact at its source. */
export function daysUntil(dueDateStr, nowMs = Date.now()) {
  if (!dueDateStr) return null;
  const due = Date.parse(`${String(dueDateStr).trim()}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  return Math.ceil((due - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * The sentence a CLIENT-FACING report prints about the commitment date.
 *
 * ── AUDIT 2026-08-15, FINDING #5 / KFM-18 ────────────────────────────────
 *
 * The fact pack used to interpolate `daysUntil()` raw:
 *
 *     Days remaining to the commitment date: -3.
 *
 * From 2026-09-10, in a report that goes to the client. Nothing was wrong
 * with the arithmetic — a bare `Math.ceil` with no floor and no OVERDUE
 * branch is simply the wrong SENTENCE for a passed deadline. "Days
 * remaining: -3" reads as a rendering bug and buries the one fact that
 * actually needed saying, which is that the office is three days late.
 *
 * Three cases, three different sentences, because they are three different
 * facts and a client reading the wrong one draws the wrong conclusion:
 *
 *   future   "N day(s) remaining"      — the ordinary case.
 *   today    "due TODAY"               — not "0 days remaining", which reads
 *                                        as a rounding artifact on the last
 *                                        day it is still possible to deliver.
 *   past     "OVERDUE by N day(s)"     — named, not negated.
 *
 * Returns null for an unreadable date so the caller keeps printing its own
 * UNVERIFIED line rather than this function inventing a softer one.
 */
export function daysRemainingLine(dueDateStr, nowMs = Date.now()) {
  const d = daysUntil(dueDateStr, nowMs);
  if (d == null) return null;
  if (d > 0) return `Days remaining to the commitment date: ${d}.`;
  if (d === 0) return 'The commitment date is TODAY. Say so in section 1 — this is the last day delivery is still on time.';
  return `OVERDUE: the commitment date passed ${Math.abs(d)} day(s) ago. `
    + 'Section 1 must state this plainly as a missed commitment — do not report it as time remaining, and do not soften it.';
}
