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

const CACHE_KEY = 'office-context-cache';
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
export const BUDGETS = Object.freeze({
  meeting: 3500,
  agent: 400,
  report: 6000,
});

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
    });
  }

  if (!tasks.length) {
    return { ok: false, reason: `found ${starts.length} task heading(s) but none had a readable State — ${malformed.join('; ')}` };
  }

  const counts = { total: tasks.length };
  for (const s of BOARD_STATES) counts[s] = tasks.filter((t) => t.state === s).length;

  return { ok: true, tasks, counts, malformed };
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
    return { ok: true, questions: [], counts: { total: 0, open: 0, closed: 0 }, malformed: [] };
  }

  const questions = [];
  const malformed = [];
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
    const marker = QUESTION_MARKERS.find((k) => new RegExp(`—\\s*${k}\\s*$`).test(starts[i].heading)) || null;
    const question = plain(
      starts[i].heading.replace(/—\s*(?:ANSWERED|DECLINED|WITHDRAWN)\s*$/, '').replace(/~~/g, '')
    );

    const agentMatch = /Agent\s+(\d+)/.exec(askedBy);
    questions.push({
      id: starts[i].id,
      question,
      marker,
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

async function fetchBackOfficeFile(env, filePath) {
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
 * Fetches and parses both back-office sources. Returns a snapshot object that
 * is safe to cache and safe to render — including when it failed, because the
 * failure is data too.
 */
export async function fetchOfficeSnapshot(env) {
  if (!env?.BACKOFFICE_REPO_TOKEN) {
    return { fetched_at: Date.now(), board: null, requirements: null, questions: null, errors: ['BACKOFFICE_REPO_TOKEN is not configured — office context cannot be read'] };
  }

  const errors = [];
  const [boardFile, reqFile, questionsFile] = await Promise.all([
    fetchBackOfficeFile(env, BOARD_PATH),
    fetchBackOfficeFile(env, REQUIREMENTS_PATH),
    fetchBackOfficeFile(env, QUESTIONS_PATH),
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
    else questions = { ok: true, questions: [], counts: { total: 0, open: 0, closed: 0 }, malformed: [] };
  } else {
    const parsed = parseOpenQuestions(questionsFile.text);
    if (parsed.ok) questions = parsed;
    else errors.push(`open-questions parse failed: ${parsed.reason}`);
  }

  return { fetched_at: Date.now(), board, requirements, questions, errors };
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
 * Builds the office-context block.
 *
 * @param {object} snapshot  from fetchOfficeSnapshot()
 * @param {'meeting'|'agent'|'report'} shape
 * @param {object} [opts]  {agentId, projects} — agentId narrows 'agent' shape
 *                          to that agent's own tasks; projects is the list
 *                          from config/office-projects.json, passed in
 * @returns {{text: string|null, degraded: boolean, reason: string|null, tokens: number, dropped: string[]}}
 */
export function buildOfficeContext(snapshot, shape, opts = {}) {
  const projects = opts.projects || [];
  const budget = BUDGETS[shape] ?? BUDGETS.agent;
  const errors = snapshot?.errors || [];
  const board = snapshot?.board || null;
  const requirements = snapshot?.requirements || null;
  const questions = snapshot?.questions || null;

  // `questions` is NOT in this guard, deliberately. An office with a readable
  // questions file and no readable board has no office context worth the name —
  // it would render "you have 4 open questions" with nothing to attach them to.
  // The empty-questions case is common and healthy; the questions-only case is a
  // failure and should say so through the same "no snapshot" path as before.
  if (!board && !requirements) {
    return {
      text: null,
      degraded: true,
      reason: errors.length ? errors.join(' | ') : 'no office snapshot available',
      tokens: 0,
      dropped: [],
    };
  }

  const sections = [];

  sections.push({
    label: 'headline',
    priority: PRIORITY.headline,
    text: 'THE OFFICE\'S OWN WORK (not the case pipeline). This is real work the office is accountable for.',
  });

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
      text: `Delegation board (back-office campus/shared/board/BOARD.md): ${board.counts.total} tasks — ${boardCountLine(board.counts)}.`,
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
    const open = questions.questions.filter((q) => q.open);
    const closed = questions.counts.closed;
    sections.push({
      label: 'questions-headline',
      priority: QUESTIONS_PRIORITY,
      text: `Open questions to the client (back-office channel/to-owner/OPEN-QUESTIONS.md): ${open.length} awaiting an answer`
        + `${closed ? `, ${closed} already answered/declined/withdrawn (text not repeated here — read the file)` : ''}.`
        + ' BEFORE asking the client anything, check this list: a question already open must not be asked again in another voice.'
        + ' Every entry names what the office will do if no answer comes, so an open question is never a reason to stop work.',
    });
    if (open.length) {
      sections.push({
        label: 'questions-open',
        priority: QUESTIONS_PRIORITY,
        header: 'Already asked and still open',
        items: open.map((q) => `- ${q.id} (${q.askedBy}, ${q.date || 'undated'}) ${q.question} — blocking: ${firstFew(q.blocking) || 'unstated'} — on silence: ${firstSentence(q.fallback)}`),
      });
    }
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

  const fitted = fitToBudget(sections, budget);
  return {
    text: fitted.text,
    degraded: errors.length > 0,
    reason: errors.length ? errors.join(' | ') : null,
    tokens: fitted.tokens,
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

export async function getOfficeContext(env, { shape = 'agent', agentId = null, allowFetch = false, snapshot: given = undefined, projects = [] } = {}) {
  if (!(await officeContextEnabled(env))) {
    return { text: null, degraded: false, reason: 'office_context_disabled', tokens: 0, dropped: [] };
  }

  const snapshot = given !== undefined ? given : await getOfficeSnapshot(env, { allowFetch });

  if (!snapshot) {
    return { text: null, degraded: true, reason: 'no cached office snapshot and this caller may not fetch', tokens: 0, dropped: [] };
  }

  const built = buildOfficeContext(snapshot, shape, { agentId, projects });
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
  ];
  if (malformed.length) {
    console.warn(`[office-context] ${shape} built from UNREADABLE input — ${malformed.join(' | ')}`);
  }
  return built;
}
