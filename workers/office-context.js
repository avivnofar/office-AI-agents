/**
 * workers/office-context.js — the office's own work, made visible to the
 * office.
 *
 * Written 2026-08-07. INERT until SIM_KV simulation-state carries
 * `office_context_enabled: true`. Default OFF, `=== true` only.
 *
 * ── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────
 *
 * The office's weekly report was thin and its meetings only ever discussed
 * cases. Not because the reports were badly written — because THE AGENTS DID
 * NOT KNOW OTHER WORK EXISTED. A survey of every prompt-assembly site on
 * 2026-08-07 (office-AI-agents@be62f57) found eight of them, and the
 * delegation board, the client requirements, the plan and the office's own
 * projects appeared in exactly zero:
 *
 *   1  meeting-engine.js buildMeetingPrompt()  — personas, moods, one agenda
 *   2  agent-base.js _buildPersonaSystemPrompt() — persona, mood, rules
 *   2a └ getDbContext() — `return ''`, a placeholder since the first build
 *   3  agent-runner.js renderDailySummary()    — cases, moods, side plots
 *   4  agent-runner.js generateWeeklySummary() — cases, moods, asset board
 *   5  guide-engine.js's three prompts         — one topic
 *   6  AI-experience note / 7 coworker chat    — inherit 2
 *
 * Everything an agent saw came out of the Q&A pipeline. The bureaucracy the
 * office was supposed to have was not missing; it was disconnected.
 *
 * ── WHERE THE DATA COMES FROM, AND WHY IT IS MARKDOWN ────────────────────
 *
 * The board and the client requirements live in back-office-AI-agents as
 * markdown, and this module PARSES THAT MARKDOWN rather than reading a
 * generated JSON sidecar. That is a deliberate choice with a cost:
 *
 *   A JSON snapshot would be easier to parse and would be a SECOND SOURCE OF
 *   TRUTH. This project has been burned three times by two things that were
 *   supposed to agree and quietly stopped. The board's format is strict and
 *   documented (campus/shared/board/README.md); parsing it means the file
 *   the humans read IS the file the agents read, and a drift between them is
 *   impossible rather than merely unlikely.
 *
 * The parser therefore REFUSES rather than guesses. A section it cannot read
 * is reported as an error, never silently skipped — a board that parsed to
 * three tasks because seventeen headings were malformed would be worse than
 * no board, because "the office is nearly idle" and "the parser broke" would
 * look identical downstream.
 *
 * ── READS, NOT WRITES ────────────────────────────────────────────────────
 *
 * These are GET requests to the GitHub Contents API. resolveRepoWrite()
 * governs WRITES; it is not in this path and should not be. The token reuse
 * question (BACKOFFICE_REPO_TOKEN is scoped for writes and used here for
 * reads) is the same known gap architect-liaison.js flags in its own header,
 * and it is recorded there rather than restated as if it were new.
 */

/*
 * The ONE import in this file, added 2026-08-10. `deliverable-lifecycle.js`
 * imports nothing itself (asserted by scripts/verify-lifecycle.js §11), so this
 * does not reintroduce the JSON-import problem the block below describes: plain
 * `node` can still import this module, and the verifier still exercises the real
 * code rather than a mirror of it.
 */
import { parseInFlight, inFlightSections } from './deliverable-lifecycle.js';
/*
 * The SECOND import, added 2026-08-10 with the policy wiring. Same test as the
 * first: `office-policy.js` imports nothing at all, so plain `node` can still
 * load this module and the verifiers still exercise the real code.
 */
import { buildPolicyBlock, parsePolicy, POLICY_PATH } from './office-policy.js';
/*
 * The THIRD import, added 2026-08-10 with the owner channel. Same test as the
 * other two, and it was checked rather than assumed: `owner-channel.js` imports
 * nothing at all, so plain `node` still loads this module and the verifiers
 * still exercise the real code.
 */
import {
  OWNER_DIR, OWNER_ISSUE_REPLIES_DIR, READ_LOG_PATH, SUBMISSIONS_PATH,
  parseOwnerMessage, parseReadLog, classifyOwnerMessages, ownerMessageSections,
  // The client's replies, transcribed out of GitHub Issue threads (2026-08-23).
  // A SECOND directory with a SECOND parser and a SECOND section, never merged
  // with the owner's own files — see owner-channel.js OWNER_ISSUE_REPLIES_DIR.
  parseIssueReply, issueReplySections,
  parseSubmissions, submissionSections, ageQuestions,
} from './owner-channel.js';

/**
 * Local token estimate — NOT imported from provider-common.js, deliberately.
 *
 * `scripts/verify-providers.js` enforces that nothing outside task-router.js
 * imports the provider layer, "so nothing bypasses the switch or the quota
 * check". Importing provider-common.js from here broke that rule. The rule's
 * PURPOSE is not violated by a pure arithmetic helper — but the rule as
 * written is, and weakening a guard to admit a convenience is how guards stop
 * meaning anything. This module is a prompt-assembly concern and has no
 * business reaching into the provider layer at all.
 *
 * The duplication is real and is handled the way plan item 1.8 handled the
 * same problem for PROVIDER_USAGE_TABLE_SQL: the two implementations are
 * asserted CHARACTER-FOR-CHARACTER IDENTICAL by
 * scripts/verify-office-bureaucracy.js, so a change to one that is not made
 * to the other is a failing check rather than a silent drift.
 *
 * Kept identical to provider-common.js's estimateTokens(): length/3, which
 * deliberately OVER-estimates. Over-estimating costs a few borderline
 * requests; under-estimating silently blows a budget. The asymmetry is the
 * whole argument, and it applies here for the same reason.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3);
}

/*
 * NO JSON IMPORT IN THIS FILE — deliberately, and it is the same reason
 * permission-guard.js has none (see its 2026-07-12 header). A module-scope
 * `import x from '../config/*.json'` needs an import attribute that
 * esbuild/Workers accepts and plain `node` rejects, which would make this
 * module un-importable by scripts/verify-office-bureaucracy.js — and a
 * verifier that cannot import the thing it verifies ends up hand-mirroring
 * it, which is the drift that refactor existed to end. The projects list is
 * therefore PASSED IN by callers (who already import config JSON) rather
 * than read here.
 */

const SIM_STATE_KEY = 'simulation-state';
const OFFICE_CONTEXT_FLAG = 'office_context_enabled';

const BACKOFFICE_REPO_OWNER = 'avivnofar';
const BACKOFFICE_REPO_NAME = 'back-office-AI-agents';
const BOARD_PATH = 'campus/shared/board/BOARD.md';
const REQUIREMENTS_PATH = 'docs/CLIENT-REQUIREMENTS.md';
/**
 * The office→owner questions file (opened 2026-08-10, contract in
 * back-office-AI-agents/channel/to-owner/README.md).
 *
 * WHY IT IS READ HERE and not left as a file a person opens: the failure this
 * file exists to prevent is five personas independently asking the owner the
 * same question, and a shared file only prevents that if the personas can SEE
 * the file. Parsing it into prompts is the whole mechanism; without this line
 * it is a folder with a good README, which is the §7.2 shape (an artifact
 * produced and consumed by nobody) landing on the office's own channel.
 */
const QUESTIONS_PATH = 'channel/to-owner/OPEN-QUESTIONS.md';

/**
 * The deliverable-lifecycle digest (opened 2026-08-10, contract in
 * workers/deliverable-lifecycle.js).
 *
 * WHY IT IS READ HERE. Dispatch worked from 2026-08-09 and nothing then did the
 * work, because after a build there was no next step and no way for the office
 * to see that a built thing was waiting on it. `tasks/office-site/` sat
 * build-complete and unreviewed from 2026-08-07. This is the file that makes a
 * deliverable in review VISIBLE — to a meeting that must assign the reviews, to
 * an agent who owes one, and to the weekly report.
 *
 * It lives in back-office because ~~the Worker CANNOT READ THE WAREHOUSE, where
 * the authoritative record is: `WAREHOUSE_REPO_TOKEN` is deliberately unset and
 * stays unset~~ — **CORRECTED 2026-08-16: the owner set `WAREHOUSE_REPO_TOKEN`
 * on 2026-08-11, verified against the live secret list, so "cannot" is no
 * longer true.** The reason this file lives here is now the DESIGN rule rather
 * than an absent credential: the office decides in back-office and the
 * warehouse-side run applies, so there is exactly one writer of a lifecycle
 * record. `scripts/lifecycle.mjs` rewrites this file wholesale from the
 * warehouse records on every run.
 */
const LIFECYCLE_PATH = 'campus/shared/lifecycle/IN-FLIGHT.md';

/**
 * EXPORTED as of 2026-08-10, for exactly one caller: the owner page's state
 * endpoint fetches a FRESH snapshot rather than reading this cache (its whole job
 * is live read state, and a cached answer there would show him our staleness as
 * the office ignoring him) and then writes the result back here, so the office
 * gets the benefit of the refresh instead of paying for it twice. Nothing else
 * should touch the key directly — use getOfficeSnapshot().
 */
export const CACHE_KEY = 'office-context-cache';
/** How long a cached parse stays usable. The board changes on the order of
 *  once a day; re-fetching it on every agent call would spend two GitHub
 *  round-trips per LLM call to learn nothing new. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * SIZE BUDGETS, in conservatively-estimated tokens (provider-common.js's
 * estimateTokens — length/3, deliberately over-estimating).
 *
 * These bind because this is prompt content that is re-sent constantly. The
 * meeting figure is per meeting; the agent figure is per LLM call, of which
 * there are many a day, and it is the one that actually costs money.
 *
 * REPORT is generous because sites 3 and 4 (renderDailySummary,
 * generateWeeklySummary) are STRING TEMPLATES THAT MAKE NO MODEL CALL. Their
 * output is committed markdown a human reads. Context there is free, so the
 * fuller version goes where it costs nothing — which is also where the
 * client-requirements status most belongs.
 */
/**
 * ── WHAT THE OFFICE IS FOR, IN ORDER (owner decision, 2026-08-23) ────────
 *
 * Until today the office's purpose reached no prompt anywhere. An agent was
 * told its persona, its mood, the board, the requirements and the policy — and
 * nothing at all about what kind of company it works for or which of the three
 * kinds of work in front of it matters most. That is not a documentation gap;
 * a priority nobody is told is a priority nobody can act on, and this project
 * has a name for a decision that never reaches the machine.
 *
 * The owner re-ordered it on 2026-08-23, in the same breath as retiring the
 * case work (`RETIRED-CAPABILITIES.md` R-001, and `casesEnabled()` in
 * agent-runner.js). The two are one decision: third place is where the case
 * work went, and an office told only "stop the cases" would have been left
 * with an empty calendar and no stated reason for what remains.
 *
 * ── WHY THIS RIDES OUTSIDE THE BUDGET, WITH THE POLICY ───────────────────
 *
 * Every other section here competes for `BUDGETS.agent*` and may be trimmed on
 * a busy day. This one may not, for the reason buildPolicyBlock() gives about
 * A1: an ordering that disappears when the board is long is an ordering that
 * volume overrides, and volume is exactly the condition it exists to govern.
 * It renders on the degraded path too — an office that cannot read its own
 * board still knows what it is for.
 *
 * ── WORDED AS INSTRUCTIONS, NOT AS A MISSION STATEMENT ───────────────────
 *
 * Same rule office-policy.js follows: every line is something the reader can
 * act on at the moment it is about to pick up a piece of work. THIRD carries
 * an explicit do-not-start, because the whole point of naming it third is to
 * give an agent a reason not to open that work — a low priority that only says
 * "low" gets done anyway by whoever has a free tick.
 *
 * NOT transcribed from OFFICE-POLICY.md. That file is the owner's and has no
 * rule on this; when he adds one, this constant becomes a transcription and
 * gets pinned by scripts/verify-office-policy.js the way POLICY_DIGEST is.
 * Until then this is the source, and it says so.
 */
export const MISSION_ORDER = Object.freeze({
  decided: '2026-08-23',
  brief: [
    'WHAT THIS OFFICE IS, AND WHAT COMES FIRST (owner, 2026-08-23):',
    'This is a SOFTWARE DEVELOPMENT company. Building working software is the first call on your time.',
    'FIRST — software development. Specs, builds, fixes, review, and shipping them.',
    'SECOND — design and customer experience: interfaces, front-end, UX-driven work, visual assets.',
    'THIRD, explicitly low — audits of the client\'s own products (case work, gap surfacing, audits of Notebook-X and data-center). DO NOT START THIRD-PRIORITY WORK UNLESS YOU WERE ASKED FOR IT. If you have a free hour, it goes to first or second.',
    'Deciding between two pieces of work: the one nearer FIRST wins. Between two at the same rank, the one the owner or the board asked for wins.',
  ],
  full: [
    'WHAT THIS OFFICE IS, AND WHAT COMES FIRST (owner decision, 2026-08-23):',
    'This is a SOFTWARE DEVELOPMENT company before it is anything else. Everything below ranks against that.',
    'FIRST — software development. Writing specs, building, fixing, reviewing and shipping working software. This is the office\'s trade; it is what a free hour goes to by default.',
    'SECOND — design and customer experience. Interfaces, front-end, UX-driven work, visual assets. Second is not optional and not decoration — it is what makes the first deliverable usable.',
    'THIRD, and explicitly low priority — audits of the client\'s own products: the case work and gap surfacing, and audits of Notebook-X and data-center. It is named third so that you have a stated reason NOT to spend time there. DO NOT START THIRD-PRIORITY WORK UNLESS YOU WERE ASKED FOR IT; if you believe a piece of it is urgent, raise it rather than begin it.',
    'HOW TO USE THIS when two pieces of work compete: the one nearer FIRST wins. Between two at the same rank, the one the owner or the board explicitly asked for wins. A third-rank task never displaces a first- or second-rank one, however small it looks.',
    'The case work reached third place on 2026-08-23 and was retired the same day (RETIRED-CAPABILITIES.md R-001) — completed successfully, not failed. Do not restart it on your own initiative.',
  ],
});

/**
 * Renders MISSION_ORDER. `brief` for a single agent (paid on every model call),
 * `full` for meetings and reports, matching buildPolicyBlock()'s shapes exactly
 * so the two blocks that ride outside the budget behave the same way.
 */
export function buildMissionBlock(shape = 'brief') {
  const lines = shape === 'full' ? MISSION_ORDER.full : MISSION_ORDER.brief;
  const text = lines.join('\n');
  return { text, tokens: estimateTokens(text), shape: shape === 'full' ? 'full' : 'brief' };
}

export const BUDGETS = Object.freeze({
  meeting: 4600,
  /**
   * ── RAISED 400 -> 520 ON 2026-08-10. THIS CLOSES OB-030's OPEN HALF. ────
   *
   * OB-030 kept the `agent` question open because raising it "needs a per-day
   * cost figure that this session did not measure". This session measured it,
   * because the policy wiring forced the question.
   *
   * At 400 the ADMIN agent shape measured 327 tokens — 82%, comfortably
   * "fitting" — while dropping `deliverables-count` and `questions-headline`
   * outright. So an admin was being told neither that a deliverable was sitting
   * in the review loop nor that the office had questions open with the owner.
   * Same pattern the meeting budget hit twice: the percentage was never the
   * number that mattered.
   *
   * THE PER-DAY COST, measured rather than feared: the cron runs 21 ticks a day
   * and `computeDailyQuestionVolume()` caps the day at roughly 100 questions,
   * each of which may carry follow-ups — call it ~150 agent model calls a day.
   * 120 extra tokens × 150 calls = **~18,000 additional input tokens per day**,
   * spread across Groq, Cloudflare Workers AI and Gemini, all on free tiers
   * whose limits are counted in REQUESTS, not tokens. The routing lanes that do
   * meter tokens (Cerebras, 131,000 per request) are not on this path.
   *
   * That is the figure OB-030 asked for and it does not bind. What binds is the
   * fitter, which still runs and still reports what it cut.
   */
  agent: 880,
  /**
   * ── RAISED AGAIN 520 -> 880 / 380 -> 660 ON 2026-08-10, WITH THE OWNER
   *    CHANNEL. MEASURED, AND THE FIRST MEASUREMENT WAS A REGRESSION. ──────
   *
   * The owner channel puts the client's own messages into every agent prompt at
   * `headline` priority. At the previous numbers, ONE owner message of ordinary
   * length caused the fitter to drop — from the STANDARD shape —
   * `requirements-status`, `board-counts`, `own-tasks` and `questions-headline`.
   *
   * **`requirements-status` is one of the two things A11 names as universal:**
   * *"Everyone sees the client requirements and this policy. Nobody can obey
   * what they cannot see."* So the first cut of this feature made an agent
   * unable to see the requirements in order to show it the owner — which is the
   * same rule being satisfied and violated in one render, and it is exactly the
   * failure this block has now recorded four times: **the percentage was never
   * the number that mattered; what the fitter had to cut to reach it is.**
   *
   * ── THE CURVE, MEASURED against the live 46-task board, the live
   *    requirements file, the live questions file, and 0 / 1 / 3 owner
   *    messages (2026-08-10) ────────────────────────────────────────────────
   *
   *     standard  380 -> drops requirements-status, board-counts, own-tasks,
   *                      questions-headline (the A11 floor)
   *               520 -> drops questions-headline, own-tasks
   *               600 -> drops questions-headline
   *               660 -> NOTHING DROPPED at 0, 1 and 3 messages (647 / 652)
   *
   *     admin     520 -> drops board-stuck, requirements-detail, board-titles,
   *                      submissions-count, questions-open, questions-headline
   *               700 -> still drops questions-open
   *               880 -> 0 msgs: NOTHING dropped (854). 1 msg: 877, drops only
   *                      board-stuck and requirements-detail. 3 msgs: 831,
   *                      also drops board-titles.
   *
   * **880 does not clear the three-message case, and that is deliberate rather
   * than an oversight** — the same call the meeting budget made about three
   * deliverables in flight. A budget that grows with however much the client has
   * written is not a budget; what it must never do is drop the rule's own
   * content, and at 880 what it drops is the office's recitation of itself.
   *
   * ── THE HONEST ACCOUNTING, BECAUSE THE RAISE BUYS MORE THAN ONE THING ───
   *
   * Two-thirds of this raise is NOT paying for owner messages. At 520 the admin
   * shape was already dropping four sections with no owner message present; at
   * 880 it drops none. So the feature exposed a budget that had been quietly too
   * small and the raise fixes both at once. Saying "this is the cost of the
   * owner channel" would be a number a later session could not reproduce.
   *
   * ── THE PER-DAY COST, MEASURED RATHER THAN FEARED ───────────────────────
   *
   * ~150 agent model calls a day (21 cron ticks, `computeDailyQuestionVolume()`
   * caps the day near 100 questions, some carrying follow-ups). ~330 extra
   * tokens × 150 calls = **~50,000 additional input tokens per day**, spread
   * across Groq, Cloudflare Workers AI and Gemini — **all on free tiers whose
   * limits are counted in REQUESTS, not tokens.** The one lane that meters
   * tokens (Cerebras, 131,000 per request) is not on this path. That is the
   * same argument the 400 -> 520 raise made, at three times the size, and it
   * still does not bind. What binds is the fitter, which still runs and still
   * reports what it cut.
   */
  /**
   * ── A11 RANK FILTERING, ADDED 2026-08-10 ────────────────────────────────
   *
   * OFFICE-POLICY.md A11: *"Admins see everything — the full board,
   * deliverables in flight, requirements, open gaps. Regular agents see their
   * own tasks, plus a brief picture of the office: how many deliverables are in
   * flight, what is blocked, what the last meeting concluded. Headlines, not
   * detail."*
   *
   * `agent_standard` is that brief picture. It is a SEPARATE BUDGET and a
   * SEPARATE SECTION SET (see STANDARD_SECTIONS), not merely a smaller number:
   * relying on the fitter to shrink its way down to headlines would produce the
   * same reduction by accident, and would silently un-produce it the day the
   * board shrank. A11 is a rule about what a rank is SHOWN, so it is enforced
   * by what is BUILT, and the budget is a second line of defence behind it.
   *
   * 380 was measured, not guessed, and THREE earlier numbers were wrong in the
   * way this module's own header warns about. At 200 the standard shape
   * measured 151 tokens — 76%, comfortably "fitting" — while the fitter quietly
   * dropped `deliverables-count`, one of the three things A11 names by name as
   * the brief picture. At 240, and again at 340, it dropped `questions-headline`
   * instead. A shape that fits by cutting the rule's own content is the failure
   * mode; the percentage never was. Every one of those three numbers was found
   * by reading `dropped` on a live read-back, not by reasoning about the size.
   *
   * ── THE HONEST SIZE OF THE SAVING ──────────────────────────────────────
   *
   * 380 against 520 is a 140-token difference in the BUDGET, and the measured
   * difference in what is actually rendered is far smaller than that. Live
   * read-back against the 46-task board on 2026-08-10:
   *
   *     Agent 6  (sudo,     admin)   358 tokens
   *     Agent 12 (sudo,     admin)   442 tokens
   *     Agent 3  (standard, filtered) 353 tokens
   *     Agent 4  (standard, filtered) 367 tokens
   *
   * **A standard agent costs almost exactly what an admin costs**, and pretending
   * otherwise would be the kind of number a later session cannot reproduce. Two
   * reasons, both worth knowing:
   *
   *   1. A11 itself. *"Everyone sees the client requirements and this policy."*
   *      Those two are most of what a small agent shape contains, and they are
   *      the two the rule refuses to withhold.
   *   2. The fitter was already doing most of this cut for budget reasons. At
   *      520 the admin shape STILL drops the board titles, the stuck list, the
   *      requirement prose, the deliverable picture and the projects list —
   *      the same sections rank filtering withholds.
   *
   * So the token case for A11 is real but SECOND, and small. The first argument
   * is the one A11 gives: *"If everyone always knows everything, the meeting
   * teaches nothing."* What genuinely changed is that the cut is now RULE-DRIVEN
   * and stable — `withheld` says who was not shown what and why — instead of a
   * side effect of a budget that this project raises roughly monthly. A rule
   * enforced only by a budget stops being enforced the next time the budget
   * moves, and this one moved twice in the week before it was written.
   */
  agent_standard: 660,
  report: 8000,
});

/**
 * Who is an admin, for A11.
 *
 * Derived from the `clearance` tier that already exists on every agent in
 * config/agents-config.json — `standard` for agents 1-4, and specialist / sudo /
 * root for everyone else. DELIBERATELY NOT a new list of agent ids: a second
 * list would be a second source of truth for "who is an admin", and the day
 * someone's clearance changed the two would disagree with no error anywhere.
 *
 * Passed IN by callers (this module imports no JSON — see the block above).
 * An ABSENT clearance is treated as standard, i.e. the LESS-INFORMED shape.
 * Failing towards showing less is the only safe direction for an information
 * rule: the cost of an admin briefly seeing headlines is a worse prompt, and
 * the cost of the inverse is A11 not holding.
 */
export const ADMIN_CLEARANCES = Object.freeze(['specialist', 'sudo', 'root']);

export function isAdminClearance(clearance) {
  return ADMIN_CLEARANCES.includes(String(clearance || '').toLowerCase());
}

/**
 * The sections a NON-ADMIN agent is shown. Everything else is admin-only.
 *
 * `own-tasks` and `own-review` are here because A11's exception is explicit —
 * a regular agent sees ITS OWN work in full. The office-wide recitations
 * (`board-titles`, `board-stuck`, `questions-open`, `deliverables`,
 * `review-work`, `gap-agenda`, `requirements-detail`, `projects`) are not.
 *
 * `errors` is here deliberately. A degraded snapshot must not be hidden from
 * the ranks that were shown less of it — otherwise a standard agent cannot tell
 * "the office has one task" from "the board did not parse".
 *
 * `board-counts` carries A11's "what is blocked" — it already renders
 * `6 BLOCKED · 4 NOT-READY` — so no separate blocked section is needed.
 *
 * `requirements-status` IS here, and it is here because A11 says so in as many
 * words: *"Everyone sees the client requirements and this policy. Nobody can
 * obey what they cannot see."* The first draft of this list withheld it — an
 * over-application of "headlines, not detail" to the one thing A11 names as
 * universal — and the pre-existing verifier caught it ("every shape keeps the
 * requirement STATUS lines"). `requirements-detail` (the prose) is a different
 * thing and stays admin-only; the STATUS lines are what "seeing the
 * requirements" means.
 *
 * `questions-headline` is here for a narrower reason: it exists to stop the
 * same question being asked twice in two voices, and a standard agent filing a
 * gap note is exactly a second voice. It renders a COMPACT variant at this rank
 * (see `questionsHeadlineText`) — the 150-token instructional version is aimed
 * at whoever composes an entry, which under A8 is an admin act.
 */
export const STANDARD_SECTIONS = Object.freeze([
  'headline',
  /*
   * ── THE OWNER'S MESSAGES REACH EVERY RANK, IN FULL (2026-08-10) ────────
   *
   * This is the one addition to this list that is NOT a headline-or-count
   * compromise, and the reason is A11's own carve-out rather than an
   * exception to it: *"Everyone sees the client requirements and this policy.
   * Nobody can obey what they cannot see."*
   *
   * An owner message is the client saying what he wants — the same class of
   * thing as a client requirement, arriving by a faster route. A11 withholds
   * the office's recitations about ITSELF (the board, the deliverable picture,
   * the projects list) from regular agents so that a meeting still teaches
   * something. It does not withhold instructions, and a rank rule that
   * filtered the client's own words would be a rank rule deciding who has to
   * obey him.
   *
   * The body is still abridged for the `agent` shape — see
   * owner-channel.js bodyForShape() — but that is a BUDGET decision applied
   * identically to admins and standard agents, and it says it is abridged.
   * Rank decides nothing here.
   */
  'owner-messages-count',
  'owner-messages',
  /*
   * ── AND HIS ISSUE REPLIES REACH EVERY RANK TOO (2026-08-23) ────────────
   *
   * Same A11 carve-out, same reasoning, one file over. A reply the client typed
   * into an Issue thread is the client saying what he wants — it differs from
   * the block above only in WHERE he wrote it and in who transcribed it, and
   * neither of those is a reason for a rank rule to decide who has to obey him.
   *
   * Unlike `owner-messages`, the body is NOT abridged for the `agent` shape.
   * See owner-channel.js issueReplyBodyForShape(): an Issue comment has no
   * structure, so a first-paragraph trim can drop the operative half.
   */
  'owner-issue-replies-count',
  'owner-issue-replies',
  'own-tasks',
  'own-review',
  'board-counts',
  'requirements-headline',
  'requirements-status',
  'questions-headline',
  /*
   * The COUNT only. A standard agent needs to know the office already has
   * three submissions in front of the client — the same anti-duplication
   * argument `questions-headline` carries — and does not need the entries.
   * Composing a submission is an admin act under A8.
   */
  'submissions-count',
  'deliverables-count',
  'errors',
]);

/**
 * ── RAISED AGAIN 2026-08-10, WITH THE DELIVERABLE LIFECYCLE ──────────────
 *
 * `meeting` 3,500 -> 4,600 and `report` 6,000 -> 8,000. Measured, not guessed,
 * against the real board (43 tasks), the real requirements file, the real
 * questions file and the real IN-FLIGHT digest on 2026-08-10:
 *
 *     one deliverable, IN-REVIEW      full untrimmed shape  3,593
 *     one deliverable, GAPS-RAISED    full untrimmed shape  4,277
 *     three deliverables, GAPS-RAISED full untrimmed shape  5,944
 *
 * At 3,500 the GAPS-RAISED case fitted at 3,488 — and fitted by TRIMMING the
 * requirement detail as well as the board-stuck list. That is the same failure
 * mode the 1,200 -> 3,500 raise was made for: a shape that "fits" while the
 * fitter quietly removes the thing agenda item 1 is about. **The percentage was
 * never the number that mattered; what the fitter had to cut to reach it is.**
 *
 * 4,600 clears the one-deliverable GAPS-RAISED shape with ~7.5% headroom — the
 * same headroom the previous raise chose. It does NOT clear three deliverables
 * at once, and that is deliberate rather than an oversight: the fitter then
 * trims the gap agenda by item, lowest priority first, and says so. A budget
 * that scales with however much work is in flight is not a budget.
 *
 * `report` is FREE — sites 3 and 4 are string templates that make no model
 * call — so it goes to 8,000, clearing the three-deliverable case with room.
 * The report pipeline's own reviewer context is a different ceiling entirely
 * (`report-pipeline.js` DIRECT_REVIEW_CONTEXT_TOKENS, 131,000).
 *
 * `agent` STAYS AT 400 and OB-030 keeps its open half. What changed for an
 * agent is targeted instead: the `own-review` section renders THIS agent's own
 * outstanding review obligation at `headline` priority, so it survives every
 * trim. One line, not the picture.
 */

/**
 * ── `meeting` RAISED 1,200 -> 3,500 ON 2026-08-10. THIS CLOSES OB-030. ────
 *
 * OB-030 asked for a measurement and a recommendation, because "changing the
 * budget is a code change and not yours to make". The measurement now exists
 * and the owner took the decision in the routing-enable session, so it is
 * applied here rather than left boarded.
 *
 * **The number that decided it was never the percentage.** At 1,200 the
 * meeting shape measured 1,181 tokens — 98.4%, comfortably "fitting" — while
 * fitToBudget() quietly shrank FOUR sections to a single item each. Measured
 * against the real 41-task board, the real requirements file and the real
 * questions file on 2026-08-10, a meeting was being shown:
 *
 *     open work        1 of 26        projects         1 of 5
 *     requirements     1 of 8         stuck items      1 of 12
 *
 * §2 of MEETING-PROTOCOL.md exists so meetings know what the office is doing.
 * A meeting that sees one of twenty-six tasks does not. The fitter was working
 * exactly as designed; the design had run out of room.
 *
 * **The curve, measured, not guessed** — same board, budget varied:
 *
 *     1,200 ->  1 of 26 tasks     2,400 -> all tasks, only board-stuck trimmed
 *     1,600 -> 11 of 26 tasks     2,800 -> board-stuck 5 of 12
 *     2,000 -> 23 of 26 tasks     3,236 -> nothing trimmed at all
 *
 * 3,236 is the shape's full untrimmed size today. 3,500 clears it with ~8%
 * headroom, so nothing is hidden from a meeting and the board can grow before
 * the fitter starts choosing again. It is still a real budget with a real
 * fitter behind it — not "no limit".
 *
 * **`agent` was deliberately NOT raised, and that is the open half of OB-030.**
 * It measures 305/400 (76%) and drops the board titles, the projects, the
 * requirement detail, the stuck list and the open-questions list ENTIRELY,
 * keeping only the headline counts. That is defensible — an agent needs to
 * know a question is open, not to recite it — but it is a real limit and it is
 * the one shape that costs money on EVERY model call, of which there are many
 * a day. The meeting shape is per meeting. Raising `agent` needs a per-day cost
 * figure that this session did not measure, so it keeps its number and OB-030
 * keeps that question.
 */

/**
 * WHAT GETS CUT FIRST, decided 2026-08-07 and stated so a later session does
 * not re-derive it from taste:
 *
 *   Knowing six requirements exist and where they stand is most of the value.
 *   Being able to recite them is not worth 4x the tokens on every call.
 *
 * So: counts and status lines are the LAST thing dropped; task bodies and
 * requirement prose are the FIRST. Lower priority number = kept longer.
 */
const PRIORITY = Object.freeze({
  headline: 0,   // "the office has N tasks, M requirements, here is the deadline"
  status: 1,     // per-requirement id + status; per-state task counts
  titles: 2,     // task titles and assignees
  detail: 3,     // metrics, blocked-by reasons, requirement prose
});

/**
 * OPEN QUESTIONS SIT AT `status`, AND ANSWERED ONES DO NOT APPEAR AT ALL.
 *
 * Stated here rather than left to the section-building code, because it is the
 * one budget decision in this module that was made for a reason other than
 * size, and the reason is in channel/to-owner/README.md:
 *
 *   An UNANSWERED question is operational — an agent about to do the work needs
 *   to know the question is already asked, who asked it, and what the office
 *   will do on silence. An ANSWERED question's text is HISTORY, and history
 *   belongs in the file rather than in every prompt.
 *
 * So unanswered entries render as items (shrinkable, never below one), and
 * answered/declined/withdrawn entries collapse to a COUNT that rides in the
 * headline. The count is deliberately kept: dropping it would make "the owner
 * has answered eleven questions" and "nobody has ever asked him anything" look
 * identical in a prompt, which is this project's most-repeated defect shape.
 */
const QUESTIONS_PRIORITY = PRIORITY.status;

/* ─────────────────────────────── The switch ───────────────────────────── */

/**
 * Reads the flag. Defaults to OFF on every failure path — no SIM_KV binding,
 * unreadable value, absent key. `=== true` rather than truthiness, so a
 * stray "false" string cannot enable it. Same shape as
 * improvementLoopEnabled(), deliberately.
 */
export async function officeContextEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[OFFICE_CONTEXT_FLAG] === true;
}

/* ──────────────────────────────── Parsers ─────────────────────────────── */

/** One `- **Field:** value` line from a board task block. */
function boardField(block, field) {
  const re = new RegExp(`^- \\*\\*${field}:\\*\\*\\s*(.+)$`, 'm');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

/** Strips markdown emphasis so a value can be compared as a plain string. */
function plain(text) {
  return String(text || '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

export const BOARD_STATES = Object.freeze(['READY', 'IN-PROGRESS', 'BLOCKED', 'NOT-READY', 'DONE']);

/**
 * Parses campus/shared/board/BOARD.md into tasks.
 *
 * Counts are DERIVED from the parsed tasks, never read from the file's own
 * "**Counts:**" line. That line is hand-maintained; deriving means the two
 * cannot disagree, and if they do it is the human line that is stale.
 *
 * @returns {{ok: true, tasks: Array, counts: object} | {ok: false, reason: string}}
 */
export function parseBoard(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, reason: 'board markdown was empty or not a string' };
  }

  // Split on task headings: "### OB-NNN — Title"
  const headingRe = /^### (OB-\d{3}) — (.+)$/gm;
  const starts = [];
  let m;
  while ((m = headingRe.exec(markdown)) !== null) {
    starts.push({ id: m[1], title: m[2].trim(), index: m.index });
  }
  if (!starts.length) {
    return { ok: false, reason: 'no "### OB-NNN — Title" task headings found — board format changed or file is not the board' };
  }

  const tasks = [];
  const malformed = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : markdown.length;
    const block = markdown.slice(starts[i].index, end);

    const state = plain(boardField(block, 'State'));
    const assignee = plain(boardField(block, 'Assignee'));

    // REFUSE, do not guess. A task whose state we cannot read is not counted
    // as READY, and is not silently dropped either — it is reported.
    if (!state || !BOARD_STATES.includes(state)) {
      malformed.push(`${starts[i].id}: unreadable State ("${state ?? 'absent'}")`);
      continue;
    }

    const agentMatch = /Agent\s+(\d+)/.exec(assignee || '');
    tasks.push({
      id: starts[i].id,
      title: starts[i].title,
      state,
      assignee: assignee || null,
      agentId: agentMatch ? Number(agentMatch[1]) : null,
      urgency: plain(boardField(block, 'Urgency')) || null,
      metric: plain(boardField(block, 'Metric')) || null,
      blockedBy: plain(boardField(block, 'Blocked by')) || null,
      // ── THE TWO FIELDS ADDED 2026-08-10 ───────────────────────────────
      //
      // `Dispatched:` already existed on the board — dispatch.js has written it
      // since 2026-08-09 — and this parser could not see it, so the office read
      // a task as IN-PROGRESS with no idea WHO held it. That is half of OB-032's
      // gap surviving inside the fix for the other half.
      //
      // `Offered:` is new, and it is the whole of requirement 1.3: the office
      // may leave work for the Architect's midnight run WITHOUT removing it from
      // the board and WITHOUT blocking it. An offer is therefore a MARKER, never
      // a state — a task carrying it is still exactly as READY and exactly as
      // claimable as it was before, and if the run never takes it the office
      // proceeds as though the offer was never made.
      //
      // NEITHER FIELD AFFECTS THE COUNTS, deliberately. `State:` remains the one
      // thing that decides what a task is. An offer that quietly moved a task
      // out of the READY count would be the "not removed from the board and not
      // blocked" rule broken by the mechanism meant to implement it.
      dispatched: plain(boardField(block, 'Dispatched')) || null,
      offered: plain(boardField(block, 'Offered')) || null,
      // ── THE THIRD MARKER, ADDED 2026-08-10 ────────────────────────────
      //
      // `Stage:` is the deliverable lifecycle's projection onto the board —
      // where a BUILT thing has got to in the review loop (see
      // workers/deliverable-lifecycle.js). It exists because ~~the office cannot
      // read the warehouse: `WAREHOUSE_REPO_TOKEN` is deliberately unset and
      // stays unset~~ — CORRECTED 2026-08-16: the owner set that secret on
      // 2026-08-11 (verified against the live secret list), so the reason is
      // no longer an absent credential. It is that NOTHING IN THE WORKER READS
      // THE WAREHOUSE — no call site fetches from it, only `warehouse_write`
      // pushes to it — so this one line is still how a meeting learns that a
      // deliverable is sitting in IN-REVIEW waiting on four admins.
      //
      // IT IS THE SAME KIND OF THING `Dispatched:` AND `Offered:` ARE, and it
      // keeps the same rule: **not a state, and it moves no state count.**
      // A board task whose deliverable is in review is still IN-PROGRESS,
      // because the office still owes work on it. Letting a Stage value into
      // the counts would give the board two grammars for "what is this task",
      // which is the drift the single `State:` field exists to prevent.
      stage: plain(boardField(block, 'Stage')) || null,
    });
  }

  if (!tasks.length) {
    return { ok: false, reason: `found ${starts.length} task heading(s) but none had a readable State — ${malformed.join('; ')}` };
  }

  const counts = { total: tasks.length };
  for (const s of BOARD_STATES) counts[s] = tasks.filter((t) => t.state === s).length;

  /*
   * ── IN-PROGRESS WITH NO START RECORD (2026-08-17) ─────────────────────────
   *
   * `OB-032`'s Task line has said since 2026-08-08 that *"the board has no
   * IN-PROGRESS transition written by any path"*. That sentence is now STALE and
   * its own later notes say so: `dispatch.js applyToBoard()` writes a
   * `Dispatched:` line, this parser reads it, and `buildReportFacts()` derives a
   * real `dispatchedCount` from it. The Workflow's two affected productivity
   * measures became computable on 2026-08-10.
   *
   * WHAT SURVIVED IS NARROWER AND WAS INVISIBLE. `dispatch.js` is not the only
   * way a task reaches `IN-PROGRESS` — a session can hand-edit the `State:` line,
   * and one has: `OB-081` was moved to IN-PROGRESS on 2026-08-16 by a session and
   * carries no `Dispatched:` line at all. Measured 2026-08-17: of three
   * IN-PROGRESS tasks, two had a start record and one did not.
   *
   * So the defect is no longer *"nothing records a start"* — it is **"not every
   * path records a start, and the two are indistinguishable downstream."** A
   * task with no `Dispatched:` line has no start date, so *time-to-start* and
   * *work past its metric line* silently skip it rather than reporting it as
   * unmeasurable. That is this project's dominant shape once more: absence read
   * as fact.
   *
   * Reported, never repaired. Inventing a start date would be strictly worse
   * than the silence — `OB-032`'s own note warns against solving this by hand,
   * because *"a state that a human maintains by hand is the same silence with
   * more steps."* This makes the hand-maintained case VISIBLE; it does not
   * legitimise it.
   */
  const unrecordedStarts = tasks
    .filter((t) => t.state === 'IN-PROGRESS' && !t.dispatched)
    .map((t) => `${t.id}: IN-PROGRESS with no "Dispatched:" line — the start was not recorded by dispatch.js,`
      + ' so this task has no start date and every time-to-start measure silently skips it');

  return { ok: true, tasks, counts, malformed, unrecordedStarts };
}

/**
 * The four heading markers an entry in channel/to-owner/OPEN-QUESTIONS.md can
 * carry. Absent means OPEN — that is the default and it is the only one that is
 * a default, because "asked and not yet answered" is the state an entry is born
 * in and the only one that needs no writer.
 *
 * DECLINED is a real outcome and is NOT counted as open. An owner who chooses
 * not to answer has answered the question of whether he will; leaving it open
 * would report the office as blocked on a decision that has been made.
 */
export const QUESTION_MARKERS = Object.freeze(['ANSWERED', 'DECLINED', 'WITHDRAWN']);

/**
 * Is an `Answer:` field a real answer, or the empty placeholder an unanswered
 * entry is born with?
 *
 * WHY THIS EXISTS (2026-08-17). Until today the heading suffix was the ONLY
 * thing that closed a question, and the `Answer:` field — the field the
 * contract creates for answers, and the only one the owner would ever think to
 * fill — was not read by this parser at all. `Q-001` is the live instance: the
 * owner answered it on 2026-08-12, somebody transcribed his answer into the
 * `Answer:` field with a note asking for the item to be closed, and because
 * nobody also edited the `###` heading the office went on reporting it as
 * *awaiting his decision* for five days — on the `/owner` page he reads, in
 * every agent prompt, and climbing the age ladder the whole time.
 *
 * **The state and the answer lived in two places and only one was
 * authoritative.** That is the defect, not the missing marker: asking the
 * client to edit a heading *as well as* write the answer is a second habit, and
 * `channel/from-owner/README.md`'s criterion 1 is that he must not have to
 * acquire one.
 *
 * The placeholder an open entry carries is a bare em-dash, sometimes followed
 * by an italic aside (`— *(never asked of him; withdrawn below)*`). Both are
 * stripped before measuring. The 20-character floor is deliberately generous:
 * this predicate can only ever CLOSE a question, so a false positive silences a
 * live question and a false negative merely leaves the status quo. It errs
 * toward leaving the question open.
 */
function hasSubstantiveAnswer(answerField) {
  const stripped = plain(answerField)
    .replace(/^[—–-]+\s*/, '')      // the leading placeholder dash
    .replace(/\((?:[^()]*)\)/g, '') // parenthetical asides, incl. the italic ones
    .trim();
  return stripped.length >= 20;
}

/**
 * Parses channel/to-owner/OPEN-QUESTIONS.md into entries.
 *
 * Same posture as parseBoard(), for the same reason: REFUSE, do not guess. An
 * entry missing `Asked by:` or `If no answer comes:` is reported as malformed
 * and does not reach the office — and the second of those is the one worth
 * refusing on. The contract makes the fallback mandatory precisely because a
 * question with no fallback is a stall dressed as a question, so an entry that
 * reached a prompt WITHOUT one would put the agent in front of an open question
 * and give it no path but to wait. That is the state this file exists to end.
 *
 * Counts are DERIVED, never read from the file's own "**Counts:**" line — the
 * board's rule, and if the two disagree the hand-maintained line is the stale
 * one.
 *
 * @returns {{ok: true, questions: Array, counts: object, malformed: string[]} | {ok: false, reason: string}}
 */
export function parseOpenQuestions(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, reason: 'open-questions markdown was empty or not a string' };
  }

  const headingRe = /^### (Q-\d{3}) — (.+)$/gm;
  const starts = [];
  let m;
  while ((m = headingRe.exec(markdown)) !== null) {
    starts.push({ id: m[1], heading: m[2].trim(), index: m.index });
  }
  if (!starts.length) {
    // An EMPTY questions file is a legitimate and healthy state — the office has
    // nothing it needs the owner for. It is NOT a parse failure, and reporting it
    // as one would put a spurious error into every prompt for as long as the
    // office happened to have no questions.
    return { ok: true, questions: [], counts: { total: 0, open: 0, closed: 0 }, malformed: [], unmarked: [] };
  }

  const questions = [];
  const malformed = [];
  const unmarked = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : markdown.length;
    const block = markdown.slice(starts[i].index, end);

    const askedBy = plain(boardField(block, 'Asked by'));
    const fallback = plain(boardField(block, 'If no answer comes'));
    if (!askedBy || !fallback) {
      malformed.push(
        `${starts[i].id}: ${!askedBy ? 'no readable "Asked by" line' : 'no readable "If no answer comes" line'}`
        + ' — the contract requires both; an entry with no fallback is a stall dressed as a question'
      );
      continue;
    }

    // The marker is a SUFFIX on the heading, so the question text itself may
    // contain any punctuation including the em-dash the heading is split on.
    const headingMarker = QUESTION_MARKERS.find((k) => new RegExp(`—\\s*${k}\\s*$`).test(starts[i].heading)) || null;
    const question = plain(
      starts[i].heading.replace(/—\s*(?:ANSWERED|DECLINED|WITHDRAWN)\s*$/, '').replace(/~~/g, '')
    );

    /*
     * AN ANSWER CLOSES A QUESTION, whether or not anyone also edited the
     * heading. See hasSubstantiveAnswer() for the five-day live instance this
     * was built from.
     *
     * The heading still WINS when it is present — DECLINED and WITHDRAWN are
     * outcomes that an `Answer:` field cannot express, and inferring ANSWERED
     * over an explicit WITHDRAWN would overwrite a stated decision with a
     * guessed one. Inference only ever fills a gap; it never overrides.
     *
     * The disagreement is REPORTED rather than quietly repaired. A file whose
     * heading and body say different things is a fact about the office worth
     * surfacing — and `unmarked` is what tells a later session to go and write
     * the marker, which keeps the file readable to a human who is not running
     * this parser.
     */
    const answer = plain(boardField(block, 'Answer')) || null;
    const inferredAnswer = headingMarker === null && hasSubstantiveAnswer(answer);
    if (inferredAnswer) {
      unmarked.push(
        `${starts[i].id}: carries an answer in its "Answer:" field but its heading has no ANSWERED marker`
        + ' — counted as ANSWERED from the answer itself; the heading should be marked so the file reads the same to a human'
      );
    }
    const marker = headingMarker || (inferredAnswer ? 'ANSWERED' : null);

    const agentMatch = /Agent\s+(\d+)/.exec(askedBy);
    questions.push({
      id: starts[i].id,
      question,
      marker,
      markerInferred: inferredAnswer,
      answer,
      open: marker === null,
      askedBy,
      agentId: agentMatch ? Number(agentMatch[1]) : null,
      date: plain(boardField(block, 'Date')) || null,
      blocking: plain(boardField(block, 'Blocking')) || null,
      need: plain(boardField(block, 'What I need')) || null,
      fallback,
    });
  }

  if (!questions.length) {
    return { ok: false, reason: `found ${starts.length} question heading(s) but none was readable — ${malformed.join('; ')}` };
  }

  const open = questions.filter((q) => q.open).length;
  return {
    ok: true,
    questions,
    counts: { total: questions.length, open, closed: questions.length - open },
    malformed,
    // Separate from `malformed` on purpose: a malformed entry is DROPPED and
    // never reaches the office, whereas an unmarked-but-answered entry is read
    // correctly and merely disagrees with its own heading. Folding the two
    // together would make a bookkeeping nit look like lost input.
    unmarked,
  };
}

const REQ_STATUSES = Object.freeze(['not started', 'in progress', 'in review', 'delivered']);

/**
 * Parses docs/CLIENT-REQUIREMENTS.md's requirement table and its due date.
 *
 * @returns {{ok: true, due: string|null, requirements: Array} | {ok: false, reason: string}}
 */
export function parseRequirements(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, reason: 'requirements markdown was empty or not a string' };
  }

  // The `>?` accepts the line inside a blockquote. It was NOT there until
  // 2026-08-08, and the real defect was not the anchor — it was that a `null`
  // due date rendered as nothing at all. The date lived at
  // `> - **Due:** **2026-09-07**`, the regex could not see it, and the office
  // ran for a day with no deadline in any prompt while every signal available
  // said healthy: no error, `degraded:false`, no `malformed` entry, and a
  // headline that read "8 on record" as though a commitment window with no end
  // date were the normal case. A missing due date is now REPORTED (below) and
  // RENDERED (buildOfficeContext) — the anchor fix alone would have closed this
  // instance and left the silence in place for the next one.
  const dueMatch = /^\s*>?\s*- \*\*Due:\*\*\s*\*\*(.+?)\*\*\s*$/m.exec(markdown);
  const due = dueMatch ? dueMatch[1].trim() : null;

  const rowRe = /^\|\s*\*\*(REQ-[0-9A-Za-z]+)\*\*\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/gm;
  const requirements = [];
  const malformed = [];
  let m;
  while ((m = rowRe.exec(markdown)) !== null) {
    const id = m[1];
    const title = plain(m[2]);
    const urgencyCell = plain(m[3]);
    const status = plain(m[4]).toLowerCase();

    if (!REQ_STATUSES.includes(status)) {
      // Refuse rather than default to "not started" — a requirement silently
      // reported as unstarted when it is in review is a status the weekly
      // meeting would then "correct" in the wrong direction.
      malformed.push(`${id}: unreadable status ("${status || 'absent'}")`);
      continue;
    }

    requirements.push({
      id,
      title,
      urgent: /URGENT/i.test(urgencyCell),
      crossCutting: /cross-cutting/i.test(urgencyCell),
      status,
    });
  }

  if (!requirements.length) {
    return { ok: false, reason: `no readable requirement rows found${malformed.length ? ` — ${malformed.join('; ')}` : ''}` };
  }

  // Same rule the per-row status check follows: REFUSE, do not guess — and say
  // so. An absent commitment date is not a benign omission; every report is
  // required to lead with where the office stands against the deadline, so a
  // null here silently removes the thing the reports are measured against.
  // `malformed` is the module's existing channel for "input we could not read",
  // is surfaced by the office_context_status trigger, and is logged by
  // getOfficeContext() — so this makes the failure visible in three places
  // without inventing a fourth mechanism.
  if (!due) {
    malformed.push('commitment Due date not found — expected `- **Due:** **YYYY-MM-DD**` (a leading `>` is tolerated). The office has no deadline in any prompt until this parses.');
  }

  return { ok: true, due, requirements, malformed };
}

/* ─────────────────────────────── Fetching ─────────────────────────────── */

/*
 * EXPORTED 2026-08-17, for `agent-runner.js processAdminDeskBlock()`. It was
 * module-private and had no reason not to be until a second caller needed to
 * read one known back-office path — the admin-desk block reads a deliverable's
 * SPEC/README so a reviewer reviews the artifact rather than its summary.
 *
 * A second copy of these ten lines in agent-runner.js would be a second place
 * the auth header, the base64/UTF-8 decode and the failure shape could drift.
 */
export async function fetchBackOfficeFile(env, filePath) {
  const url = `https://api.github.com/repos/${BACKOFFICE_REPO_OWNER}/${BACKOFFICE_REPO_NAME}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.BACKOFFICE_REPO_TOKEN}`,
    },
  }).catch((err) => ({ ok: false, status: 0, _err: err?.message }));

  if (!res?.ok) return { text: null, reason: `GET ${filePath} failed: HTTP ${res?.status ?? 'network error'}` };
  const body = await res.json().catch(() => null);
  if (!body?.content) return { text: null, reason: `${filePath}: no content field in Contents API response` };
  try {
    return { text: decodeURIComponent(escape(atob(body.content.replace(/\n/g, '')))), reason: null };
  } catch (err) {
    return { text: null, reason: `${filePath}: base64/UTF-8 decode failed — ${err.message}` };
  }
}

/**
 * Lists a back-office DIRECTORY. The first directory read this module has ever
 * needed, and it exists for exactly one reason: the owner writes one file per
 * message and cannot be asked to maintain an index of them.
 *
 * ── THE COST, MEASURED AND REPORTED RATHER THAN ABSORBED ─────────────────
 *
 * Every other source here is ONE GET for a known path. `channel/from-owner/` is
 * a listing plus one GET per message, so a snapshot refresh costs
 * `5 + 1 + N + 1` GitHub requests where N is the number of owner messages —
 * against 5 before. At the cap below that is a worst case of 19 requests per
 * refresh, and a refresh happens at most every CACHE_TTL_MS (30 minutes) and
 * only from the handful of callers that pass `allowFetch`. The per-LLM-call
 * agent path never fetches at all, which is the number that would have mattered.
 *
 * ── WHY THE OWNER IS NOT ASKED FOR AN INDEX FILE ─────────────────────────
 *
 * It would collapse this to one GET. It would also be a NEW HABIT, and
 * criterion 1 of OB-023 — the owner's own, listed first — is that he must not
 * have to acquire one. He writes a file from his phone; that is the whole
 * interaction the channel is allowed to require. Spending fourteen HTTP
 * requests every half hour to avoid asking him to maintain a table of contents
 * is the correct trade and it is not close.
 */
export async function fetchBackOfficeDir(env, dirPath) {
  const url = `https://api.github.com/repos/${BACKOFFICE_REPO_OWNER}/${BACKOFFICE_REPO_NAME}/contents/${dirPath}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.BACKOFFICE_REPO_TOKEN}`,
    },
  }).catch((err) => ({ ok: false, status: 0, _err: err?.message }));

  if (!res?.ok) return { entries: null, reason: `GET ${dirPath}/ failed: HTTP ${res?.status ?? 'network error'}` };
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) return { entries: null, reason: `${dirPath}/: Contents API did not return a directory listing` };
  return { entries: body, reason: null };
}

/**
 * How many owner messages are fetched in one refresh.
 *
 * A cap is necessary — an unbounded directory is an unbounded number of
 * subrequests, and Cloudflare's per-invocation limit is a real ceiling this
 * project has already hit once (`{"type":"day"}`, 2026-07-19).
 *
 * **The cap is not silent.** `renderSection()`'s NO SILENT CAPS rule applies
 * with more force to an owner instruction than to anything else this module
 * renders: a truncated list of the client's own messages that does not say it
 * was truncated is the office believing it has read everything he wrote. When
 * the cap bites, the overflow is reported as an ERROR, not a note — it lands in
 * the errors section and rides in every prompt until it clears.
 */
const MAX_OWNER_MESSAGES = 12;

/**
 * Fetches and parses every back-office source. Returns a snapshot object that
 * is safe to cache and safe to render — including when it failed, because the
 * failure is data too.
 */
export async function fetchOfficeSnapshot(env, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!env?.BACKOFFICE_REPO_TOKEN) {
    return { fetched_at: Date.now(), board: null, requirements: null, questions: null, lifecycle: null, policy: null, owner: null, submissions: null, errors: ['BACKOFFICE_REPO_TOKEN is not configured — office context cannot be read'] };
  }

  const errors = [];
  const [boardFile, reqFile, questionsFile, lifecycleFile, policyFile, submissionsFile, ownerDir, readLogFile, issueReplyDir] = await Promise.all([
    fetchBackOfficeFile(env, BOARD_PATH),
    fetchBackOfficeFile(env, REQUIREMENTS_PATH),
    fetchBackOfficeFile(env, QUESTIONS_PATH),
    fetchBackOfficeFile(env, LIFECYCLE_PATH),
    fetchBackOfficeFile(env, POLICY_PATH),
    fetchBackOfficeFile(env, SUBMISSIONS_PATH),
    fetchBackOfficeDir(env, OWNER_DIR),
    fetchBackOfficeFile(env, READ_LOG_PATH),
    // ── THE SECOND OWNER-SIDE DIRECTORY (2026-08-23, Session 14 ITEM B) ──
    //
    // Until this line existed the snapshot listed OWNER_DIR and only OWNER_DIR,
    // so `channel/from-owner-issues/` — a SIBLING, written by the office's own
    // recordIssueReplies() — was read by no lister, parser or prompt builder
    // anywhere. The client's first-ever reply was read, recorded and committed
    // to git on 2026-08-23 and reached zero agent prompts.
    //
    // It rides the SAME Promise.all rather than a follow-up fetch: this function
    // already costs eight round trips and a ninth in parallel costs no extra
    // wall-clock, while a sequential fetch would.
    fetchBackOfficeDir(env, OWNER_ISSUE_REPLIES_DIR),
  ]);

  let board = null;
  if (boardFile.reason) errors.push(boardFile.reason);
  else {
    const parsed = parseBoard(boardFile.text);
    if (parsed.ok) board = parsed;
    else errors.push(`board parse failed: ${parsed.reason}`);
  }

  let requirements = null;
  if (reqFile.reason) errors.push(reqFile.reason);
  else {
    const parsed = parseRequirements(reqFile.text);
    if (parsed.ok) requirements = parsed;
    else errors.push(`requirements parse failed: ${parsed.reason}`);
  }

  // The questions file is the one source whose ABSENCE is not an error. The
  // other two must exist for the office to function; this one is a channel the
  // office may legitimately have nothing in — and a 404 on it while the office
  // has no questions is indistinguishable from a healthy empty file. It is
  // reported as an error only when the fetch failed for a reason OTHER than the
  // file not being there, so "the owner channel is unreachable" stays loud while
  // "the office has nothing to ask" stays quiet.
  let questions = null;
  if (questionsFile.reason) {
    if (!/HTTP 404/.test(questionsFile.reason)) errors.push(questionsFile.reason);
    else questions = { ok: true, questions: [], counts: { total: 0, open: 0, closed: 0 }, malformed: [], unmarked: [] };
  } else {
    const parsed = parseOpenQuestions(questionsFile.text);
    if (parsed.ok) questions = parsed;
    else errors.push(`open-questions parse failed: ${parsed.reason}`);
  }

  // Same rule the questions channel keeps, and for the same reason: a 404 here
  // is the HEALTHY empty state — the office has nothing in the review loop —
  // and reporting it as an error would put a permanent complaint into every
  // prompt for as long as that were true. Any OTHER failure stays loud.
  let lifecycle = null;
  if (lifecycleFile.reason) {
    if (!/HTTP 404/.test(lifecycleFile.reason)) errors.push(lifecycleFile.reason);
    else lifecycle = { ok: true, records: [], counts: { total: 0 }, malformed: [] };
  } else {
    const parsed = parseInFlight(lifecycleFile.text);
    if (parsed.ok) lifecycle = parsed;
    else errors.push(`lifecycle parse failed: ${parsed.reason}`);
  }

  /*
   * ── THE POLICY (added 2026-08-10) ──────────────────────────────────────
   *
   * Fetched for CORROBORATION, not for content. buildPolicyBlock() renders its
   * transcribed digest with or without this — see office-policy.js's header for
   * why a constraint may not depend on a network read. What the live file adds
   * is the two facts that go stale: the re-check date, and which rules still
   * carry the ⚖️ provisional marker.
   *
   * A failure here is therefore an ERROR (the office is running on an unverified
   * transcription) but never a refusal. A 404 is NOT the healthy-empty case the
   * questions channel and the lifecycle digest get: the policy is required to
   * exist, and a missing policy file is exactly the state worth shouting about.
   */
  let policy = null;
  if (policyFile.reason) {
    errors.push(`${policyFile.reason} — the policy digest is rendering from workers/office-policy.js POLICY_DIGEST without live corroboration`);
  } else {
    const parsed = parsePolicy(policyFile.text);
    if (parsed.ok) policy = parsed;
    else errors.push(`policy parse failed: ${parsed.reason}`);
  }

  /*
   * ── THE OWNER'S OWN MESSAGES (added 2026-08-10) ────────────────────────
   *
   * A 404 on the DIRECTORY is the healthy empty state — the same rule the
   * questions channel and the lifecycle digest already keep. Any other failure
   * is LOUD, and louder than those two: "the office cannot read what the client
   * wrote" is not a degraded nicety, it is the channel being down.
   */
  let owner = null;
  if (ownerDir.reason) {
    if (!/HTTP 404/.test(ownerDir.reason)) {
      errors.push(`${ownerDir.reason} — THE OWNER CHANNEL IS UNREADABLE. Anything the client has written is invisible to the office right now.`);
    } else {
      owner = { ok: true, messages: [], classified: classifyOwnerMessages([], { byKey: new Map() }), malformed: [] };
    }
  } else {
    const files = ownerDir.entries
      .filter((e) => e.type === 'file' && /\.md$/i.test(e.name) && e.name.toUpperCase() !== 'README.MD')
      .sort((a, b) => String(b.name).localeCompare(String(a.name)));

    /* ── ANYTHING IN HERE THE OFFICE CANNOT READ IS AN ERROR, NOT A FILTER ──
     *
     * Found live on 2026-08-10, and it is the worst thing this session found.
     *
     * `channel/from-owner/` contained `messages-from-aviv/aviv-is-writing-to-the-office.md`,
     * committed by the owner, reading in full:
     *
     *   > this is a test note to see if the office responds. find a way to let me
     *   > know you've read this.
     *
     * **The office never saw it.** Not "read and ignored" — INVISIBLE. Three
     * independent reasons, and the filter above only knows about one of them: it
     * was in a SUBDIRECTORY, so `type === 'file'` excluded it before any parser
     * ran; its filename was not `YYYY-MM-DD-<slug>.md`; and it had no front
     * matter. A top-level file that fails to parse at least lands in `malformed`
     * and is reported. A subdirectory landed nowhere at all.
     *
     * So the channel built specifically to end the failure *"a message the office
     * has not read looks exactly like a message the office has read and ignored"*
     * had a third state nobody had named: **a message the office cannot even see.**
     * And the message it swallowed was him testing exactly that.
     *
     * The filter is unchanged — those entries genuinely cannot be parsed and must
     * not be guessed at. What changes is that being unreadable is now LOUD. Every
     * entry in this directory that is not a readable message is reported as an
     * ERROR, which rides at the top of every prompt until it clears, because an
     * instruction from the client that nothing mentions is the one failure this
     * whole channel exists to prevent.
     *
     * NOT auto-corrected, deliberately: the office never writes into
     * `from-owner/`, and moving or renaming the client's own file to make it
     * parse would be the office editing his words to suit its parser. It is
     * reported to him instead — the standing rule that reality wins over
     * documentation but the OWNER decides which side changes.
     */
    /*
     * `README.md` and `.gitkeep` are exempt, and the exemption is narrow on
     * purpose: they are the directory's own INFRASTRUCTURE — the contract and the
     * file that makes an empty folder exist in git — and neither could ever be a
     * message. Everything else is a candidate.
     *
     * Keeping the list this short matters more than it looks. An error that fires
     * on every refresh for something that is fine trains a reader to skip the
     * whole line, and this line is the only thing standing between an invisible
     * owner instruction and silence. A false positive here costs the real one.
     */
    const OWNER_DIR_INFRASTRUCTURE = new Set(['README.MD', '.GITKEEP']);
    const unreadableEntries = ownerDir.entries.filter((e) => {
      if (OWNER_DIR_INFRASTRUCTURE.has(String(e.name).toUpperCase())) return false;
      if (e.type !== 'file') return true;
      return !/\.md$/i.test(e.name);
    });
    if (unreadableEntries.length) {
      errors.push(
        `${OWNER_DIR}/ CONTAINS ${unreadableEntries.length} ENTR${unreadableEntries.length === 1 ? 'Y' : 'IES'} THE OFFICE CANNOT READ AS A MESSAGE`
        + ` — ${unreadableEntries.map((e) => `${e.name}${e.type === 'dir' ? '/ (a directory: the contract is ONE FILE PER MESSAGE at the top level, so nothing inside it is ever listed)' : ' (not a .md file)'}`).join('; ')}.`
        + ' THE CLIENT MAY HAVE WRITTEN SOMETHING NOBODY HAS SEEN. This is a THIRD state beyond unread and read-and-ignored:'
        + ' invisible. It is reported and deliberately NOT auto-corrected — the office does not write into his folder, and renaming'
        + ' his file to suit our parser would be editing the client\'s words. Reply in channel/from-office/ and ask him to move it.'
      );
    }

    const capped = files.slice(0, MAX_OWNER_MESSAGES);
    if (files.length > capped.length) {
      errors.push(
        `${OWNER_DIR}/ holds ${files.length} messages and only the ${capped.length} most recent were read this cycle`
        + ` (MAX_OWNER_MESSAGES=${MAX_OWNER_MESSAGES}). ${files.length - capped.length} of the client's messages are NOT in this context.`
        + ' Reported as an error rather than a note: a silently truncated list of the client\'s own instructions is the office believing it has read everything he wrote.'
      );
    }

    const fetched = await Promise.all(capped.map((f) => fetchBackOfficeFile(env, `${OWNER_DIR}/${f.name}`)));
    const messages = [];
    const malformed = [];
    capped.forEach((f, i) => {
      if (fetched[i].reason) { errors.push(fetched[i].reason); return; }
      const parsed = parseOwnerMessage(fetched[i].text, f.name, f.sha);
      if (parsed.ok) messages.push(parsed.message);
      else malformed.push(parsed.reason);
    });

    // The read log's ABSENCE is healthy — no owner message has ever been read.
    // Its being UNREADABLE for any other reason is not, and it is loud, because
    // an unreadable log makes every message look UNREAD and the office would
    // re-record reads it had already made.
    let readLog = { ok: true, records: [], byKey: new Map() };
    if (readLogFile.reason) {
      if (!/HTTP 404/.test(readLogFile.reason)) {
        errors.push(`${readLogFile.reason} — the read record could not be read, so every owner message below will report as NOT YET READ even if it was.`);
      }
    } else {
      readLog = parseReadLog(readLogFile.text);
    }

    // NOTE `readLog.records`, not `readLog`. The snapshot is JSON-serialised into
    // SIM_KV, and parseReadLog()'s `byKey` is a Map — which survives that round
    // trip as `{}`. Storing it would give the daily block an empty index that
    // LOOKED populated, so every message would re-record as newly read. The
    // classification is already computed here, where the Map is real.
    owner = { ok: true, messages, classified: classifyOwnerMessages(messages, readLog), readLog: { records: readLog.records }, malformed };
  }

  /*
   * ── SUBMISSIONS (added 2026-08-10) ─────────────────────────────────────
   *
   * 404 is healthy, exactly as for OPEN-QUESTIONS.md: the office may
   * legitimately have nothing awaiting a decision.
   *
   * `today` is passed IN rather than read from the clock here so the verifier
   * can pin a date and assert a rung. The rung is therefore computed at PARSE
   * time and cached with the snapshot for up to CACHE_TTL_MS (30 minutes) —
   * which can only be wrong within half an hour of a day boundary, on a ladder
   * whose steps are 3, 7 and 14 days. Stated rather than left to be discovered.
   */
  let submissions = null;
  if (submissionsFile.reason) {
    if (!/HTTP 404/.test(submissionsFile.reason)) errors.push(submissionsFile.reason);
    else submissions = { ok: true, submissions: [], counts: { total: 0, open: 0, closed: 0, escalated: 0, overdue: 0 }, malformed: [] };
  } else {
    const parsed = parseSubmissions(submissionsFile.text, today);
    if (parsed.ok) submissions = parsed;
    else errors.push(`submissions parse failed: ${parsed.reason}`);
  }

  /*
   * ── THE CLIENT'S ISSUE REPLIES (added 2026-08-23, Session 14 ITEM B) ────
   *
   * A 404 here is HEALTHY and must stay quiet: `channel/from-owner-issues/` is
   * created by the office's own `recordIssueReplies()` the first time the client
   * answers an Issue, so before that day it legitimately does not exist. Any
   * OTHER failure is loud, for the reason this whole item exists — a directory
   * the office cannot read looks exactly like a client who has not replied.
   *
   * NO CAP on the number read, deliberately, and it is a different judgement
   * from MAX_OWNER_MESSAGES above rather than an oversight. These files are
   * short (one comment each), the office writes them itself so their size is
   * known, and there are 1 of them today. If that stops being true the right
   * answer is a cap that SAYS it bit, copied from the owner-message branch
   * above — not a silent slice added here later.
   */
  let ownerIssueReplies = null;
  if (issueReplyDir.reason) {
    if (!/HTTP 404/.test(issueReplyDir.reason)) {
      errors.push(`${issueReplyDir.reason} — ${OWNER_ISSUE_REPLIES_DIR}/ could not be listed, so THE CLIENT'S REPLIES ARE NOT IN THIS CONTEXT. A directory the office cannot read looks exactly like a client who has not replied.`);
    } else {
      ownerIssueReplies = { ok: true, replies: [], malformed: [] };
    }
  } else {
    const replyFiles = (issueReplyDir.entries || [])
      .filter((e) => e.type === 'file' && /\.md$/i.test(e.name) && !/^README\.md$/i.test(e.name));
    const fetchedReplies = await Promise.all(
      replyFiles.map((f) => fetchBackOfficeFile(env, `${OWNER_ISSUE_REPLIES_DIR}/${f.name}`))
    );
    const replies = [];
    const replyMalformed = [];
    replyFiles.forEach((f, i) => {
      if (fetchedReplies[i].reason) { errors.push(fetchedReplies[i].reason); return; }
      const parsed = parseIssueReply(fetchedReplies[i].text, f.name, f.sha);
      if (parsed.ok) replies.push(parsed.reply);
      else replyMalformed.push(parsed.reason);
    });
    ownerIssueReplies = { ok: true, replies, malformed: replyMalformed };
  }

  return { fetched_at: Date.now(), today, board, requirements, questions, lifecycle, policy, owner, ownerIssueReplies, submissions, errors };
}

/* ──────────────────────────────── Rendering ───────────────────────────── */

/** Renders one section: either a plain `text`, or a `header` plus a list of
 *  `items` that can be shortened without destroying the section. */
function renderSection(s) {
  if (!s.items) return s.text;
  const shown = s.items.slice(0, s.show);
  if (!shown.length) return null;
  // NO SILENT CAPS. A truncated list that does not say it was truncated reads
  // as the complete list, and "the office has 12 open tasks" is a different
  // claim from "here are 12 of the office's 60 open tasks".
  const note = shown.length < s.items.length ? ` (showing ${shown.length} of ${s.items.length})` : '';
  return `${s.header}${note}:\n${shown.join('\n')}`;
}

/**
 * Assembles prioritised sections and shrinks them until they fit the budget.
 *
 * TWO-STAGE, and the order matters — this was originally drop-only, and
 * drop-only was wrong in a way the verifier caught:
 *
 *   With 60 board tasks, the "Open work" section alone exceeded the 1,200-token
 *   meeting budget, so the whole section was dropped — leaving roughly 1,050
 *   tokens of budget UNUSED and giving a full meeting LESS office context than
 *   a single agent got. The failure was invisible in testing with three tasks,
 *   because nothing bound. It would have appeared the first day the board grew.
 *
 * So: list sections SHRINK BY ITEM first (lowest priority first, and never
 * below one item, so a section's existence survives), and only a section that
 * is still too big at one item gets dropped entirely. Items are whole lines —
 * nothing is ever cut mid-sentence, because a half sentence in a prompt reads
 * as a fact the model then completes.
 */
export function fitToBudget(sections, budget) {
  const kept = sections
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((s) => ({ ...s, show: s.items ? s.items.length : 0 }));

  const dropped = [];
  const trimmed = [];
  const render = () => kept.map(renderSection).filter(Boolean).join('\n');
  let out = render();

  // Stage 1 — shrink lists, least important first.
  let guard = 0;
  while (estimateTokens(out) > budget && guard < 5000) {
    guard += 1;
    let idx = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i].items && kept[i].show > 1) { idx = i; break; }
      if (kept[i].items && kept[i].show > 1 && kept[i].priority >= kept[idx]?.priority) idx = i;
    }
    if (idx === -1) break;
    kept[idx].show -= 1;
    if (!trimmed.includes(kept[idx].label)) trimmed.push(kept[idx].label);
    out = render();
  }

  // Stage 2 — only now drop whole sections, lowest priority first.
  while (estimateTokens(out) > budget && kept.length > 1) {
    let worstIdx = 0;
    for (let i = 1; i < kept.length; i += 1) {
      if (kept[i].priority >= kept[worstIdx].priority) worstIdx = i;
    }
    dropped.push(kept[worstIdx].label);
    kept.splice(worstIdx, 1);
    out = render();
  }

  return { text: out, dropped, trimmed, tokens: estimateTokens(out) };
}

function requirementLines(requirements, { detail }) {
  return requirements.map((r) => {
    const flag = r.urgent ? ' [URGENT — owner-assigned]' : '';
    return detail
      ? `- ${r.id} (${r.status})${flag}: ${r.title}`
      : `- ${r.id}: ${r.status}${flag}`;
  });
}

/**
 * The FIRST SENTENCE of a field, plus an explicit marker when there was more.
 *
 * ── WHY A SENTENCE AND NOT A CHARACTER COUNT ─────────────────────────────
 *
 * A `If no answer comes:` field is a commitment followed by its reasoning, and
 * it runs 300–600 characters. Rendering all of it for every open question cost
 * the meeting shape enough budget that fitToBudget() crushed "Open work" from
 * 26 items to 1 — measured, not feared. Rendering a character-clipped prefix
 * would have been worse than either: this module's own fitter rule is that
 * items are whole lines because *a half sentence in a prompt reads as a fact the
 * model then completes*, and a mid-word clip of a commitment is exactly that
 * hazard applied to the sentence that says what the office will do.
 *
 * The first sentence IS the commitment; what follows it is why. So the prompt
 * gets a complete, true sentence and a pointer, and the file keeps the argument.
 * The marker is not optional — an abridged fallback that does not say it is
 * abridged reads as the whole undertaking.
 */
function firstSentence(text, { pointer = 'full text in the file' } = {}) {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(s);
  if (!m || m[0].length >= s.length) return s;
  return `${m[0]} […${pointer}]`;
}

/** First few `·`-separated items of a list field, with the true remainder named.
 *  Same NO SILENT CAPS rule renderSection() keeps — a shortened list that does
 *  not say it was shortened reads as the complete one. */
function firstFew(text, n = 3) {
  const parts = String(text || '').split('·').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= n) return parts.join(' · ');
  return `${parts.slice(0, n).join(' · ')} (+${parts.length - n} more)`;
}

function boardCountLine(counts) {
  return BOARD_STATES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ');
}

/**
 * The sentence that makes a dropped row visible. Appended to EVERY count that
 * excluded rows, everywhere that count is rendered.
 *
 * ── WHY THIS EXISTS (audit 2026-08-15, finding #3) ────────────────────────
 *
 * The parsers in this file have always recorded unreadable rows in `malformed`
 * and excluded them from `counts`. Nothing ever rendered that. The only signal
 * was one `console.warn` in getOfficeContext() — a server log nobody reads —
 * so **a corrupted board and a smaller-but-clean board were textually
 * identical in every report the office publishes, including the client-facing
 * weekly's "Board totals" line.** A count that silently drops its failures
 * reports a number it cannot support.
 *
 * The number is deliberately stated even though the reasons are truncated: how
 * MANY rows vanished is the fact that changes how much a reader should trust
 * the total, and it must survive any shortening of the detail.
 *
 * At the time of writing the live board dropped ZERO rows — this is a latent
 * defect being closed before it bites, not an active miscount being corrected.
 *
 * @param {string[]} malformed  entries from a parse* function
 * @param {string} noun         what was dropped, e.g. 'board task'
 * @returns {string} '' when nothing was dropped, else a leading-space sentence
 */
export function droppedRowsNote(malformed, noun = 'row') {
  const list = Array.isArray(malformed) ? malformed.filter(Boolean) : [];
  if (!list.length) return '';
  const plural = list.length === 1 ? noun : `${noun}s`;
  return ` **${list.length} ${plural} could not be read and are NOT included in this count** — ${firstFew(list.join(' · '), 2)}.`;
}

/**
 * Builds the office-context block.
 *
 * @param {object} snapshot  from fetchOfficeSnapshot()
 * @param {'meeting'|'agent'|'report'} shape
 * @param {object} [opts]  {agentId, agentName, clearance, projects} — agentId
 *                          narrows the 'agent' shape to that agent's own
 *                          tasks AND (2026-08-11, Phase 3) scopes addressed
 *                          owner messages, together with agentName; clearance
 *                          drives A11 rank filtering; projects is the list from
 *                          config/office-projects.json, passed in
 * @returns {{text: string|null, degraded: boolean, reason: string|null, tokens: number, dropped: string[]}}
 */
export function buildOfficeContext(snapshot, shape, opts = {}) {
  const projects = opts.projects || [];
  // Phase 3 (2026-08-11): who an ADDRESSED owner message reaches. Empty for
  // any shape/opts that doesn't identify a specific agent — ownerMessageSections()
  // treats an empty candidate list as "matches nothing addressed", which is
  // correct: a meeting/report shape ignores this anyway (see that function),
  // and an 'agent' call with no agentId has nothing to scope BY.
  const ownerCandidates = opts.agentId != null ? [opts.agentId, opts.agentName].filter((v) => v != null) : [];
  /*
   * A11: an `agent` shape for a non-admin is a DIFFERENT shape, with its own
   * budget and its own section set. Meetings and reports are unaffected — a
   * meeting's attendees are admins by construction (relationships.json
   * meeting_default_attendees), and a report is read by the owner.
   */
  const rankFiltered = shape === 'agent' && !isAdminClearance(opts.clearance);
  const budget = rankFiltered ? BUDGETS.agent_standard : (BUDGETS[shape] ?? BUDGETS.agent);
  const errors = snapshot?.errors || [];
  const board = snapshot?.board || null;
  const requirements = snapshot?.requirements || null;
  const questions = snapshot?.questions || null;
  const lifecycle = snapshot?.lifecycle || null;

  // `questions` is NOT in this guard, deliberately. An office with a readable
  // questions file and no readable board has no office context worth the name —
  // it would render "you have 4 open questions" with nothing to attach them to.
  // The empty-questions case is common and healthy; the questions-only case is a
  // failure and should say so through the same "no snapshot" path as before.
  if (!board && !requirements) {
    /*
     * THE POLICY STILL RENDERS HERE. Changed 2026-08-10.
     *
     * Before the policy wiring this returned `text: null` — correct then, and
     * wrong now. A1 and A7 are CONSTRAINTS, and a constraint that vanishes when
     * a GitHub read fails is a constraint a network blip removes. The office's
     * worst day is precisely the day an agent should still be told it may not
     * touch the Worker code.
     *
     * `degraded` stays true and the reason is unchanged, so every existing
     * caller's logging and every existing check still see the failure. What
     * changed is that the failure no longer takes the rules down with it.
     */
    const policyOnly = buildPolicyBlock(shape === 'agent' ? 'brief' : 'full', { parsed: snapshot?.policy || null });
    // The mission ordering survives a failed board read for the same reason the
    // policy does: it is a constraint, and a constraint a network blip removes
    // was never one. See MISSION_ORDER's header.
    const missionOnly = buildMissionBlock(shape === 'agent' ? 'brief' : 'full');
    /*
     * ── AND THE OWNER'S MESSAGES SURVIVE HERE TOO (2026-08-10) ────────────
     *
     * Exactly the argument the policy block above makes, applied to the other
     * thing an agent must never lose to a network blip. If the board read fails
     * and the owner channel read succeeded, returning policy alone would drop
     * the client's own instruction on the ground — and it would do it silently,
     * because `degraded: true` reads as "the office's own work is incomplete",
     * not as "the client told us something and you were not shown it".
     *
     * Rendered raw rather than through fitToBudget(): there is nothing here to
     * balance it against, and an instruction trimmed to fit a budget it is the
     * only occupant of would be a trim for its own sake.
     */
    const ownerOnly = snapshot?.owner?.classified
      ? ownerMessageSections(snapshot.owner.classified, { shape, candidates: ownerCandidates, malformed: snapshot.owner.malformed }).map(renderSection).filter(Boolean).join('\n')
      : '';
    /*
     * ── AND HIS REPLIES SURVIVE THE DEGRADED PATH TOO (2026-08-23) ───────
     *
     * Exactly the argument the two blocks above make, applied to the third
     * thing an agent must never lose to a network blip. Left out of here, a
     * failed BOARD read would silently drop the client's reply — and it would
     * do it in the one code path where `degraded: true` already reads as "the
     * office's own work is incomplete" rather than "the client answered you and
     * you were not shown it".
     */
    const issueRepliesOnly = snapshot?.ownerIssueReplies?.replies?.length || snapshot?.ownerIssueReplies?.malformed?.length
      ? issueReplySections(snapshot.ownerIssueReplies.replies, { shape, malformed: snapshot.ownerIssueReplies.malformed }).map(renderSection).filter(Boolean).join('\n')
      : '';
    return {
      text: [missionOnly.text, policyOnly.text, ownerOnly, issueRepliesOnly].filter(Boolean).join('\n\n'),
      degraded: true,
      reason: errors.length ? errors.join(' | ') : 'no office snapshot available',
      tokens: 0,
      policyTokens: policyOnly.tokens,
      missionTokens: missionOnly.tokens,
      totalTokens: policyOnly.tokens + missionOnly.tokens,
      rankFiltered: shape === 'agent' && !isAdminClearance(opts.clearance),
      withheld: [],
      dropped: [],
    };
  }

  const sections = [];

  sections.push({
    label: 'headline',
    priority: PRIORITY.headline,
    text: 'THE OFFICE\'S OWN WORK (not the case pipeline). This is real work the office is accountable for.',
  });

  /*
   * ── THE OWNER'S MESSAGES GO FIRST, AND FIRST IS NOT DECORATION ──────────
   *
   * Pushed here — before the requirements, before the board — because
   * `fitToBudget()` breaks ties among equal priorities by INDEX, dropping the
   * later one. Everything in this block sits at PRIORITY.headline alongside the
   * requirements headline and the deliverables count, so position is what
   * decides which of them survives a squeeze. The client's own instruction
   * should be the last thing standing, so it is pushed first.
   *
   * That is the same mechanism the `deliverables-count` comment below records
   * being MEASURED into its slot. Position among equal priorities is load-bearing
   * in this function and is not stylistic ordering.
   */
  if (snapshot?.owner?.classified) {
    for (const s of ownerMessageSections(snapshot.owner.classified, { shape, candidates: ownerCandidates, malformed: snapshot.owner.malformed })) {
      sections.push({ ...s, priority: PRIORITY.headline });
    }
  }

  /*
   * ── AND HIS REPLIES, IMMEDIATELY AFTER (2026-08-23, Session 14 ITEM B) ──
   *
   * Second, not first, and the ordering is the same load-bearing mechanism the
   * block above documents: `fitToBudget()` breaks ties among equal priorities by
   * INDEX and drops the later one. A file the client WROTE outranks a comment
   * the office TRANSCRIBED if only one of the two can survive a squeeze — his
   * own handwriting is the stronger artefact. Both sit at headline priority, so
   * in practice both survive; this decides only the case where they cannot.
   *
   * Pushed unconditionally when the snapshot has the key at all, INCLUDING when
   * `replies` is empty — the count line renders at zero on purpose. "He has not
   * replied" and "the reply directory could not be read" must not look alike,
   * and the second lands in `errors` rather than here.
   */
  if (snapshot?.ownerIssueReplies) {
    for (const s of issueReplySections(snapshot.ownerIssueReplies.replies, { shape, malformed: snapshot.ownerIssueReplies.malformed })) {
      sections.push({ ...s, priority: PRIORITY.headline });
    }
  }

  if (requirements) {
    const urgentCount = requirements.requirements.filter((r) => r.urgent).length;
    sections.push({
      label: 'requirements-headline',
      priority: PRIORITY.headline,
      // A null `due` renders as a LOUD marker, never as nothing. Omitting it
      // produced a headline that was indistinguishable from a genuine
      // no-deadline state, which is how it survived a full day unnoticed.
      text: `Client requirements: ${requirements.requirements.length} on record${requirements.due ? `, commitment due ${requirements.due}` : ', COMMITMENT DUE DATE UNREADABLE — the deadline could not be parsed from docs/CLIENT-REQUIREMENTS.md and this is a defect, not an absence of deadline'}${urgentCount ? `, ${urgentCount} marked URGENT by the client` : ''}. Full text: back-office docs/CLIENT-REQUIREMENTS.md.`,
    });
    sections.push({
      label: 'requirements-status',
      priority: PRIORITY.status,
      text: requirementLines(requirements.requirements, { detail: false }).join('\n'),
    });
    sections.push({
      label: 'requirements-detail',
      priority: PRIORITY.detail,
      header: 'Requirement detail',
      items: requirementLines(requirements.requirements, { detail: true }),
    });
  }

  if (board) {
    sections.push({
      label: 'board-counts',
      priority: PRIORITY.status,
      // The unrecorded-start note rides on the counts line rather than getting a
      // section of its own: it is a caveat ON the IN-PROGRESS number, and a
      // reader who sees that number without it has been told something slightly
      // false. Riding here also means it cannot be dropped while the count it
      // qualifies survives — two sections could be split by the fitter.
      text: `Delegation board (back-office campus/shared/board/BOARD.md): ${board.counts.total} tasks — ${boardCountLine(board.counts)}.${droppedRowsNote(board.malformed, 'board task')}`
        + ((board.unrecordedStarts || []).length
          ? ` ⚠️ ${board.unrecordedStarts.length} of the ${board.counts['IN-PROGRESS']} IN-PROGRESS task(s) carry NO "Dispatched:" start record`
            + ` (${board.unrecordedStarts.map((s) => s.split(':')[0]).join(', ')}) — they were started by hand, not by dispatch.js,`
            + ' so any time-to-start or overdue measure silently omits them rather than reporting them as unmeasurable.'
          : ''),
    });

    const mine = opts.agentId ? board.tasks.filter((t) => t.agentId === opts.agentId) : [];
    if (opts.agentId && mine.length) {
      sections.push({
        label: 'own-tasks',
        priority: PRIORITY.status,
        header: 'Your own board tasks',
        items: mine.map((t) => `- ${t.id} [${t.state}]${t.urgency ? ' [URGENT]' : ''} ${t.title}`),
      });
    } else if (opts.agentId) {
      sections.push({
        label: 'own-tasks',
        priority: PRIORITY.status,
        text: 'You have no tasks on the delegation board right now.',
      });
    }

    const actionable = board.tasks.filter((t) => t.state === 'READY' || t.state === 'IN-PROGRESS');
    if (actionable.length) {
      sections.push({
        label: 'board-titles',
        priority: PRIORITY.titles,
        header: 'Open work',
        // `held by` is what stops the same task being picked up twice. Before
        // 2026-08-10 the office could see a task was IN-PROGRESS and could not
        // see who had it, which is a race the prompt itself invites.
        items: actionable.map((t) => `- ${t.id} [${t.state}] ${t.assignee || 'unassigned'} — ${t.title}${t.urgency ? ' (URGENT)' : ''}${t.dispatched ? ` [HELD: ${t.dispatched}]` : ''}${t.offered ? ' [OFFERED to the Architect\'s next unattended run — still yours to claim; claiming it writes the Dispatched line and the run then refuses it]' : ''}`),
      });
    }

    const stuck = board.tasks.filter((t) => t.state === 'BLOCKED' || t.state === 'NOT-READY');
    if (stuck.length) {
      sections.push({
        label: 'board-stuck',
        priority: PRIORITY.detail,
        header: 'Stuck (not a capacity problem — these are waiting on something)',
        items: stuck.map((t) => `- ${t.id} [${t.state}] ${t.title} — waiting on: ${t.blockedBy || 'unstated'}`),
      });
    }
  }

  // ── WHAT THE OFFICE HAS ALREADY ASKED THE OWNER (added 2026-08-10) ──────
  //
  // The purpose is negative and worth naming: this section exists to stop a
  // question being asked a second time, not to prompt anyone to ask one. So the
  // headline states the counts even when there is nothing open — "the office has
  // asked the owner nothing" is a fact an agent should be able to see, and it is
  // a DIFFERENT fact from "the channel could not be read", which lands in the
  // errors section instead.
  if (questions) {
    /*
     * ── THE AGE LADDER, APPLIED HERE RATHER THAN IN THE PARSER ───────────
     *
     * A8: *"keeps surfacing the question until it is answered [...] a question
     * asked once and forgotten is the graveyard this rule exists to prevent."*
     *
     * An entry that renders identically on day 1 and day 40 IS forgotten,
     * whatever the file says about it. `ageQuestions()` gives each open entry a
     * rung, and a risen entry is re-pushed at `headline` priority below — so the
     * older a question gets, the harder it becomes for the budget fitter to make
     * it disappear. The re-surfacing is not a reminder someone sends; it is a
     * property of how the prompt is assembled.
     *
     * Applied at RENDER time, not parse time, so the rung follows the calendar
     * rather than the cache.
     */
    const today = opts.today || snapshot?.today || new Date().toISOString().slice(0, 10);
    const aged = ageQuestions(questions.questions, today);
    const open = aged.filter((q) => q.open);
    const closed = questions.counts.closed;
    const risenQuestions = open.filter((q) => q.escalation?.headline);
    /*
     * TWO WIDTHS, ONE FACT. The long form is instruction for whoever COMPOSES
     * an entry — a meeting, a report, an admin — and it costs ~150 tokens. The
     * agent shape is spent on every model call and needs the fact and the
     * prohibition, not the procedure. Measured: the long form alone was 60% of
     * the standard rank's whole office-context budget.
     *
     * The COUNTS are identical in both. That is the part that must never differ
     * by shape — "the owner has answered eleven questions" and "nobody has ever
     * asked him anything" looking alike is the defect this section was built to
     * prevent, and it would come straight back if the short form dropped them.
     */
    const questionsHeadlineText = shape === 'agent'
      ? `Open questions to the client (back-office channel/to-owner/OPEN-QUESTIONS.md): ${open.length} awaiting an answer`
        + `${closed ? `, ${closed} already answered/declined/withdrawn` : ''}.`
        + ' Check that list before asking the client anything — a question already open must not be asked again in another voice.'
        + ' Every entry says what the office does on silence, so an open question never stops work.'
      : `Open questions to the client (back-office channel/to-owner/OPEN-QUESTIONS.md): ${open.length} awaiting an answer`
        + `${closed ? `, ${closed} already answered/declined/withdrawn (text not repeated here — read the file)` : ''}.`
        + ' BEFORE asking the client anything, check this list: a question already open must not be asked again in another voice.'
        + ' Every entry names what the office will do if no answer comes, so an open question is never a reason to stop work.';

    sections.push({
      label: 'questions-headline',
      priority: QUESTIONS_PRIORITY,
      text: questionsHeadlineText,
    });
    if (open.length) {
      sections.push({
        label: 'questions-open',
        priority: QUESTIONS_PRIORITY,
        header: 'Already asked and still open',
        items: open.map((q) => `- ${q.id} [${q.escalation.rung}${q.escalation.days === null ? ', DATE UNREADABLE' : `, ${q.escalation.days}d`}] (${q.askedBy}, ${q.date || 'undated'}) ${q.question} — blocking: ${firstFew(q.blocking) || 'unstated'} — on silence: ${firstSentence(q.fallback)}`),
      });
    }
    /*
     * A SECOND SECTION for the risen entries, at `headline`, rather than simply
     * re-ordering the one above. Two reasons, and the second is the load-bearing
     * one:
     *
     *   1. `questions-open` sits at `status` and is shrinkable — the fitter takes
     *      it down to one item on a busy day, and which item survives is an
     *      artefact of array order.
     *   2. An OVERDUE entry must survive a trim that a fresh one does not. Same
     *      priority for both would make ageing purely cosmetic, and the whole
     *      point of the ladder is that visibility CHANGES.
     *
     * The duplication between the two sections for a risen entry is deliberate
     * and cheap: seeing an escalated question twice in a prompt is the intended
     * effect of "keeps surfacing", not a rendering bug.
     */
    if (risenQuestions.length) {
      sections.push({
        label: 'questions-overdue',
        priority: PRIORITY.headline,
        header: 'ASKED AND NOT ANSWERED — these have been waiting and they do not go quiet',
        items: risenQuestions.map((q) => `- ${q.id} [${q.escalation.rung}${q.escalation.days === null ? ', DATE UNREADABLE — rung forced to the top, because an entry whose age cannot be established must never look fresh' : `, ${q.escalation.days} days unanswered`}] ${q.question}`
          + ` — ${q.escalation.takeFallback ? 'THE FALLBACK HAS BEEN TAKEN and the question is STILL OPEN and still being asked' : 'on silence'}: ${firstSentence(q.fallback)}`),
      });
    }
  }

  // ── SUBMISSIONS TO THE CLIENT (added 2026-08-10) ───────────────────────
  //
  // A8 draws the line this section renders: *the owner receives finished work,
  // not questions.* A submission and a question are therefore different acts
  // and are shown as different things — a meeting handed one blob treats them
  // alike and then wonders why the client is being asked things rather than
  // shown things.
  if (snapshot?.submissions) {
    for (const s of submissionSections(snapshot.submissions, { shape })) {
      sections.push({ ...s, priority: s.priority === 0 ? PRIORITY.headline : PRIORITY.status });
    }
  }

  // ── DELIVERABLES IN FLIGHT (added 2026-08-10) ──────────────────────────
  //
  // Three sections, not one, because they are three different acts and a
  // meeting given one blob does all of them badly:
  //
  //   deliverables  — what exists and where it has got to.
  //   review-work   — WHO OWES WHAT, worded as an assignment. Owner-stated:
  //                   *admins are assigned review tasks in the morning meeting,
  //                   the same way any other work is assigned — reviewing is
  //                   work, not a courtesy someone performs when they notice.*
  //   gap-agenda    — the gaps themselves, because *gaps go to a meeting* and a
  //                   meeting handed a COUNT cannot decide anything.
  //
  // They sit at `status` priority, above task titles: a deliverable waiting on
  // five named admins is more actionable than the list of open board tasks, and
  // if something has to be cut it should be the recitation, not the assignment.
  if (lifecycle && lifecycle.records.length) {
    const built = inFlightSections(lifecycle.records, { names: opts.agentNames || {} });

    // ── A11'S "BRIEF PICTURE", AS ONE LINE ────────────────────────────────
    //
    // A11 names three things a regular agent sees: *how many deliverables are
    // in flight, what is blocked, what the last meeting concluded.* The first
    // two are here; the third is not in this snapshot at all (it lives in D1
    // `meetings`, which this module does not read) and is boarded rather than
    // faked. A count an agent can see is the difference between knowing the
    // office has work in review and believing it has none.
    sections.push({
      label: 'deliverables-count',
      // `headline`, not `status`, and it was MEASURED into that slot. At
      // `status` the fitter dropped it from every agent shape — admin and
      // standard alike — because it is pushed after the questions sections and
      // the drop loop takes the later index among equal priorities. A11 names
      // "how many deliverables are in flight" as part of the floor EVERY rank
      // sees, which is the same argument `own-review` already sits at headline
      // on. One line, dropped last, never trimmed.
      priority: PRIORITY.headline,
      text: `Deliverables in the review loop: ${lifecycle.records.length}`
        + ` — ${lifecycle.records.map((r) => `${r.slug} [${r.stage} r${r.round}]`).join(', ')}.`
        + ` ${lifecycle.records.reduce((n, r) => n + (r.open_gaps || 0), 0)} open gap(s) across them.`,
    });

    // ── WHAT *THIS* AGENT OWES, AT HEADLINE PRIORITY ────────────────────
    //
    // The `agent` shape is 400 tokens and measured 305 before this feature; it
    // already drops the board titles, the projects and the requirement detail
    // entirely. Everything below therefore never reaches a single agent, and a
    // reviewer who cannot see that he owes a review will not write one.
    //
    // So the one fact an individual agent needs rides at `headline`, which is
    // dropped last and never trimmed: HIS OWN outstanding review. This is
    // exactly what `own-tasks` already does for the board, applied to review
    // work — and it is deliberately ONE LINE rather than the whole picture,
    // because raising the `agent` budget is the open half of OB-030 and needs a
    // per-day cost figure this session did not measure.
    if (opts.agentId) {
      const owed = lifecycle.records.filter((r) => (r.owed_by || []).includes(opts.agentId));
      if (owed.length) {
        sections.push({
          label: 'own-review',
          priority: PRIORITY.headline,
          text: `YOU OWE A REVIEW: ${owed.map((r) => `\`${r.slug}\` r${r.round} — ${(r.required || []).includes(opts.agentId) ? 'a FULL REASONED REVIEW' : 'a brief comment OR an explicit ABSTENTION'}`).join('; ')}. Assigned as work, not offered. Nothing to say? Abstain explicitly — your silence will never be read as approval, it is recorded as an outstanding obligation blocking the deliverable.`,
        });
      }
    }

    // ── PRIORITY `titles`, NOT `status`, AND IT WAS MEASURED ────────────
    //
    // These went in at `status` first, and the live read-back caught the cost:
    // the 400-token agent shape started dropping `questions-headline` as well,
    // so an agent stopped being told the office has four open questions with
    // the owner. That is a REGRESSION I INTRODUCED, not an acceptable trade —
    // the whole-office deliverable picture is meeting-and-report content, and
    // what an individual agent needs is HIS OWN obligation, which rides at
    // `headline` above and survives every trim.
    //
    // At `titles` they sit beside the board's own task list — the same class of
    // thing, cut at the same point — and the questions headline keeps its place.
    if (built.flight) {
      sections.push({ label: 'deliverables', priority: PRIORITY.titles, header: built.flight.header, items: built.flight.items });
    }
    if (built.assignments) {
      sections.push({ label: 'review-work', priority: PRIORITY.titles, header: built.assignments.header, items: built.assignments.items });
    }
    if (built.agenda) {
      sections.push({ label: 'gap-agenda', priority: PRIORITY.titles, header: built.agenda.header, items: built.agenda.items });
    }
  } else if (lifecycle) {
    // Said explicitly rather than omitted. "Nothing is in review" and "the
    // office cannot see what is in review" are different facts, and the second
    // one belongs in the errors section instead — which is where an unreadable
    // digest already lands.
    //
    // Labelled `deliverables-count` and not `deliverables`, so the empty case
    // reaches a standard agent too. A rank that is told the count when it is
    // three and told nothing when it is zero cannot tell zero from unread.
    sections.push({
      label: 'deliverables-count',
      // `headline`, not `status`, and it was MEASURED into that slot. At
      // `status` the fitter dropped it from every agent shape — admin and
      // standard alike — because it is pushed after the questions sections and
      // the drop loop takes the later index among equal priorities. A11 names
      // "how many deliverables are in flight" as part of the floor EVERY rank
      // sees, which is the same argument `own-review` already sits at headline
      // on. One line, dropped last, never trimmed.
      priority: PRIORITY.headline,
      text: 'DELIVERABLES IN FLIGHT — none. No built deliverable is currently in the review loop.',
    });
  }

  if (projects.length) {
    sections.push({
      label: 'projects',
      priority: PRIORITY.titles,
      header: 'Projects the office is responsible for',
      items: projects.map((p) => `- ${p.name} (${p.role})`),
    });
  }

  // Errors are surfaced, never swallowed — a partial snapshot that reads as
  // a complete one is the failure mode this whole module exists to avoid.
  if (errors.length) {
    sections.push({
      label: 'errors',
      priority: PRIORITY.status,
      text: `NOTE — part of the office's work could not be read this cycle: ${errors.join(' | ')}. Treat the above as incomplete.`,
    });
  }

  /*
   * ── A11 ENFORCED BY CONSTRUCTION, BEFORE THE FITTER RUNS ────────────────
   *
   * Filtering here rather than inside fitToBudget() is deliberate. The fitter's
   * job is "make this fit"; A11's rule is "this rank does not see that", and the
   * two must not be the same decision — a rule enforced only by a budget stops
   * being enforced the moment the budget is raised, which is a thing this
   * project does roughly monthly (see the BUDGETS block above, twice in one
   * week). `withheld` is REPORTED, not silent: the same NO SILENT CAPS rule
   * renderSection() keeps, applied to rank instead of length.
   */
  const withheld = rankFiltered
    ? sections.filter((s) => !STANDARD_SECTIONS.includes(s.label)).map((s) => s.label)
    : [];
  const visible = rankFiltered
    ? sections.filter((s) => STANDARD_SECTIONS.includes(s.label))
    : sections;

  const fitted = fitToBudget(visible, budget);

  /*
   * ── THE POLICY RIDES OUTSIDE THE BUDGET, AND THAT IS THE WHOLE POINT ────
   *
   * A11: *"Everyone sees the client requirements and this policy. Nobody can
   * obey what they cannot see."* A policy inside the office-context budget would
   * be a policy the fitter is entitled to trim on a busy day — and A1 trimmed
   * on a busy day is A1 absent on exactly the day it matters.
   *
   * So it is PREPENDED after the fit, and its cost is reported separately as
   * `policyTokens` rather than folded into `tokens`. The two numbers answer two
   * different questions and adding them together would answer neither: `tokens`
   * is what the fitter managed, `policyTokens` is what the rule costs.
   *
   * Shape mapping: `brief` for a single agent (per model call, many a day),
   * `full` for meetings and reports (once per meeting; reports make no model
   * call at all).
   */
  const policy = buildPolicyBlock(shape === 'agent' ? 'brief' : 'full', { parsed: snapshot?.policy || null });
  /*
   * FIRST, ahead of even the policy, and that ordering is the argument.
   * The policy tells an agent what it may not do; this tells it what to pick
   * up. A reader that has already spent its attention on five prohibitions
   * before being told what the office is for has been told the constraints of
   * a job it has not been given. Both ride outside the budget; neither is
   * trimmed; the mission is simply read first.
   */
  const mission = buildMissionBlock(shape === 'agent' ? 'brief' : 'full');

  return {
    text: `${mission.text}\n\n${policy.text}\n\n${fitted.text}`,
    degraded: errors.length > 0,
    reason: errors.length ? errors.join(' | ') : null,
    tokens: fitted.tokens,
    policyTokens: policy.tokens,
    missionTokens: mission.tokens,
    totalTokens: fitted.tokens + policy.tokens + mission.tokens,
    rankFiltered,
    withheld,
    dropped: fitted.dropped,
    trimmed: fitted.trimmed,
  };
}

/* ──────────────────────────────── Cache ───────────────────────────────── */

/**
 * The one function callers use.
 *
 * Cache-only by default. `allowFetch` is opt-in and passed by the small
 * number of callers that run once per cycle (the meeting engine, the daily
 * and weekly report renderers) — never by the per-LLM-call agent path, which
 * would otherwise spend two GitHub round-trips on every single model call.
 *
 * Returns {text: null} when the switch is off. No fetch, no cache read, no
 * log noise — off means off.
 */
export async function getOfficeSnapshot(env, { allowFetch = false } = {}) {
  if (!(await officeContextEnabled(env))) return null;

  let snapshot = null;
  if (env.SIM_KV) {
    snapshot = await env.SIM_KV.get(CACHE_KEY, 'json').catch(() => null);
  }

  const stale = !snapshot || (Date.now() - (snapshot.fetched_at || 0)) > CACHE_TTL_MS;
  if (stale && allowFetch) {
    snapshot = await fetchOfficeSnapshot(env);
    if (env.SIM_KV) await env.SIM_KV.put(CACHE_KEY, JSON.stringify(snapshot)).catch(() => {});
  }

  return snapshot;
}

export async function getOfficeContext(env, { shape = 'agent', agentId = null, agentName = null, clearance = null, allowFetch = false, snapshot: given = undefined, projects = [], agentNames = {}, today = undefined } = {}) {
  /*
   * THE POLICY HAS NO SWITCH OF ITS OWN, deliberately — the same decision
   * deliverable-lifecycle.js took on 2026-08-10 and for the same reason. It
   * rides on `office_context_enabled`, which is live ON. A separate flag would
   * be an eighth switch whose documented state goes stale the moment someone
   * toggles it (OB-040), guarding a body of rules that the office is supposed to
   * be unable to opt out of. Off means off: no fetch, no digest, no log noise.
   */
  if (!(await officeContextEnabled(env))) {
    return { text: null, degraded: false, reason: 'office_context_disabled', tokens: 0, policyTokens: 0, dropped: [] };
  }

  const snapshot = given !== undefined ? given : await getOfficeSnapshot(env, { allowFetch });

  if (!snapshot) {
    return { text: null, degraded: true, reason: 'no cached office snapshot and this caller may not fetch', tokens: 0, dropped: [] };
  }

  // `agentNames` was accepted by buildOfficeContext() and never passed by this
  // function, so inFlightSections() has been rendering agent ids where it could
  // have rendered names since the lifecycle landed. Threaded through 2026-08-10
  // while the signature was being changed anyway; it is a legibility fix, not a
  // behaviour change — the ids were correct, they were just harder to read.
  const built = buildOfficeContext(snapshot, shape, { agentId, agentName, clearance, projects, agentNames, today });
  if (built.degraded) {
    console.warn(`[office-context] degraded (${shape}): ${built.reason}`);
  }
  if (built.dropped.length) {
    console.warn(`[office-context] ${shape} over budget — dropped: ${built.dropped.join(', ')}`);
  }
  // Unreadable INPUT is a different failure from a degraded or over-budget
  // RENDER, and it had no log line at all until 2026-08-08 — the parsers
  // recorded `malformed` faithfully and nothing ever read it, so a board task
  // with an unreadable State and a missing commitment date were both invisible
  // in production logs. Warn once per call, naming the shape.
  const malformed = [
    ...(snapshot?.requirements?.malformed || []),
    ...(snapshot?.board?.malformed || []),
    ...(snapshot?.questions?.malformed || []),
    ...(snapshot?.lifecycle?.malformed || []),
    ...(snapshot?.policy?.malformed || []),
    // An unreadable OWNER message is the most serious entry this list can carry
    // — it is the client's own words failing to reach the office — so it is
    // prefixed rather than left to look like one more parse note.
    ...((snapshot?.owner?.malformed || []).map((r) => `OWNER MESSAGE UNREADABLE — ${r}`)),
    ...(snapshot?.submissions?.malformed || []),
  ];
  if (malformed.length) {
    console.warn(`[office-context] ${shape} built from UNREADABLE input — ${malformed.join(' | ')}`);
  }
  return built;
}
