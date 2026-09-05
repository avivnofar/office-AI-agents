/**
 * workers/architect-spec.js — the Architect's NAMED spec-writing path.
 *
 * Session 31 (2026-08-28), Item A: "wake the Architect, and let it write a
 * spec." The Architect (agent 10) stays `routable: false` in
 * config/model-routing.json — that lane's own `_why` note says he "runs on
 * the Anthropic API exclusively... reserved for him and for genuine
 * data-center Q&A under its own capped budget," and this module does not
 * change that. `routable: false` means "never randomly shuffled into," not
 * "never callable" — the Guides pipeline's `workers/claude-client.js` calls
 * already prove a NAMED, deliberate Anthropic path can exist beside a
 * non-routable lane entry that only states the rule. This module is a
 * second such named path, for a second named purpose: turning one real
 * board task into a buildable spec.
 *
 * WHAT THIS PRODUCES: NOT a second spec format. `workers/spec-builder.js`
 * already defines the seven fields and renders them deterministically
 * (`buildSpec()`, pure, no model, no clock). This module's only job is to
 * get a real model to FILL those seven fields from a real board task's
 * text, as structured JSON, and then hand the answers to the SAME
 * `buildSpec()` the owner's own `/admin/spec` page uses — one
 * implementation of the format, one more caller of it.
 *
 * BUDGET: a THIRD, independent Claude sub-budget — component:'architect' —
 * alongside 'qa' and 'guides' (see workers/model-router.js
 * capUsdForComponent()/currentMonthKey() and
 * config/token-economy.json architect_claude_budget). Checked before every
 * call; the call is refused, not degraded, on exhaustion — there is no
 * fallback model for the Architect, by the same rule that keeps this lane
 * `routable: false`.
 */

import { callClaudeMessages, CLAUDE_MODEL } from './claude-client.js';
import { getClaudeBudgetStatus, recordClaudeSpend } from './model-router.js';
import { buildSpec, SPEC_FIELDS, TASK_TYPES, OPEN_DECISIONS_INSTRUCTION } from './spec-builder.js';

const ANSWER_KEYS = ['title', 'task_type', ...SPEC_FIELDS.map((f) => f.key)];

/**
 * The seven fields, rendered back into the prompt from spec-builder.js's own
 * definitions — so the model is told exactly what the form asks a human,
 * never a second, hand-written description of the same fields.
 */
function fieldGuide() {
  return SPEC_FIELDS.map((f) => `- "${f.key}" (${f.heading}${f.required ? ', required' : ', optional'}): ${f.hint}`).join('\n');
}

export const ARCHITECT_SPEC_SYSTEM = [
  'You are the Architect — Agent 10 of this AI office, root clearance, the office\'s final technical authority.',
  'You are turning ONE real board task into a buildable spec, for a Cerebras-driven builder to execute in the warehouse repo afterward.',
  '',
  'You must answer with a SINGLE JSON object and nothing else — no prose before or after it, no markdown code fence.',
  'The object has exactly these keys: "title", "task_type", "what", "out_of_scope", "where", "io", "constraints", "phases", "done", "open_decisions". All values are plain strings.',
  `"task_type" must be exactly one of: ${TASK_TYPES.join(', ')}.`,
  '',
  'What each of the other fields means (this is the office\'s own spec form — answer it the way a careful human would):',
  fieldGuide(),
  '',
  `Under "open_decisions": ${OPEN_DECISIONS_INSTRUCTION} Do not leave a real ambiguity in the board task unresolved — decide it yourself and record the decision and reasoning as the value of this field. Leave the field genuinely empty only if there is truly nothing to decide.`,
  'Be specific and concrete. "io" especially needs a real example line of input and a real example line of output, not a description of their shape.',
  '',
  // ── THE TWO SECTIONS THE CHAIN'S TWO READERS NEED (2026-09-05, session 43)
  //
  // `where` was already required and is restated below with its own paragraph.
  // `phases` is the half that was missing, and its GRAMMAR is the whole of it:
  // `dispatch.js readPhases()` parses `N. [phase-id] Title` and nothing else, so
  // a beautifully-reasoned prose breakdown here produces a spec that reads as
  // planned and dispatches as empty. runArchitectSpecCall() refuses a reply
  // whose phases do not parse rather than committing one — see its own note.
  'THE "phases" FIELD HAS A GRAMMAR AND IT IS NOT NEGOTIABLE. The office\'s dispatcher reads it with a regular expression and understands NOTHING ELSE. Write between 2 and 8 phases, one per line, each line exactly of the form:',
  '  N. [short-id] What that phase produces.',
  'For example:',
  '  1. [scaffold] Create the directory and an empty module with its CLI entry point.',
  '  2. [parse] Read the input file and produce the row objects.',
  '  3. [tests] One offline test per rule in "What \\"done\\" looks like".',
  'The id is lowercase letters, digits and hyphens. Prose under this heading, bullets instead of numbers, or a missing [id] all parse as ZERO phases and the spec is refused. Separate the lines with real newlines inside the JSON string value.',
  '',
  'This spec is written for a build that will happen INSIDE the warehouse-office-AI-agents repo, by a builder that only has write access there — never in office-AI-agents or back-office-AI-agents, which are Architect/owner-authorized only. So "where" MUST name a path of the exact shape `warehouse-office-AI-agents/tasks/<a-short-lowercase-hyphenated-slug>/...` — never a path in either of the other two repos, and never a bare path with no repo name.',
].join('\n');

export function buildArchitectSpecUserPrompt({ taskId, title, taskText, slug }) {
  return [
    `Board task ${taskId} — "${title}"`,
    '',
    'Full text of the task, exactly as it reads on the board:',
    '---',
    taskText,
    '---',
    '',
    `This spec is about to be committed to \`warehouse-office-AI-agents/tasks/${slug}/SPEC.md\`. Your "where" answer MUST start with \`warehouse-office-AI-agents/tasks/${slug}/\` — that directory is already decided, not yours to rename.`,
    '',
    'Produce the JSON object now.',
  ].join('\n');
}

/** Extracts the first top-level {...} block and parses it. Refuses rather
 *  than guessing at a malformed reply — an invented answer here would be
 *  exactly the "convincing wrong spec" spec-builder.js's own header warns
 *  against, just moved one layer earlier. */
export function parseArchitectAnswers(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, reason: 'no JSON object found in the Architect\'s reply' };
  }
  let parsed;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    return { ok: false, reason: `the Architect's reply was not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the Architect\'s reply parsed to something other than a JSON object' };
  }
  const answers = {};
  for (const key of ANSWER_KEYS) answers[key] = typeof parsed[key] === 'string' ? parsed[key] : '';
  return { ok: true, answers };
}

/**
 * Runs the whole named path: budget check -> Anthropic call -> parse ->
 * buildSpec() -> record spend. Never falls back to a routed provider — a
 * refusal here is a refusal, not a degrade, matching the `architect` lane's
 * own "NEVER routed, NEVER shuffled."
 *
 * @param {object} env
 * @param {object} task - { taskId, title, taskText, slug } — `slug` is the
 *   warehouse task directory the caller has already decided to commit this
 *   spec into, so the model's own "where" answer can be anchored to the
 *   real path rather than free to name a different one (see this module's
 *   git history for the live mismatch this closes: a real call named
 *   `tasks/dependency-advisory-check/` while the caller committed to
 *   `tasks/dependency-audit/SPEC.md` — two mechanisms agreeing by
 *   coincidence, not by anything tying them together).
 * @param {string} [date] - YYYY-MM-DD, passed through to buildSpec(); a
 *   parameter rather than `new Date()` so this function can be exercised by
 *   a caller that pins the date, same reason buildSpec() itself takes one.
 * @returns {Promise<object>}
 */
export async function runArchitectSpecCall(env, task, { date, cacheSystem = false } = {}) {
  const asOfDate = date || new Date().toISOString().slice(0, 10);

  if (!env?.ANTHROPIC_API_KEY) {
    return { ok: false, reason: 'anthropic_api_key_not_configured' };
  }

  const budget = await getClaudeBudgetStatus(env, { component: 'architect' });
  if (budget.overBudget) {
    return { ok: false, reason: `architect_spec_budget_exhausted ($${budget.spentUsd.toFixed(2)}/$${budget.capUsd}/mo)`, budget };
  }

  let result;
  try {
    result = await callClaudeMessages({
      apiKey: env.ANTHROPIC_API_KEY,
      system: ARCHITECT_SPEC_SYSTEM,
      messages: [{ role: 'user', content: buildArchitectSpecUserPrompt(task) }],
      maxTokens: 3000,
      effort: 'medium',
      disableThinking: true,
      // SUPERVISED MEASUREMENT ONLY — Session 34, C4. Defaults false, and the
      // scheduled path never sets it. It exists so a session can put a real
      // cache breakpoint on a real call and read the answer out of
      // `usage.cache_creation_input_tokens` instead of arguing from the docs.
      //
      // The answer, measured 2026-08-29: ZERO. ARCHITECT_SPEC_SYSTEM is ~771
      // tokens and Sonnet 5's minimum cacheable prefix is 1,024, so the
      // breakpoint is a silent no-op. See callClaudeMessages()'s CACHING block.
      cacheSystem,
    });
  } catch (err) {
    return { ok: false, reason: `anthropic call threw: ${err.message}` };
  }

  // Spend is recorded whether or not the reply parses — the call was made
  // and cost real money regardless of what came back, the same posture
  // guide review takes (it records spend on REVISE/REJECT, not only APPROVE).
  const spend = await recordClaudeSpend(env, {
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, component: 'architect',
    // Session 34, C3/C5: cache tokens are billed (1.25x write, 0.1x read) and
    // are NOT in result.inputTokens. Passing them keeps the spend guard exact
    // whether or not a breakpoint was set on this call.
    cacheWriteTokens: result.cacheWriteTokens, cacheReadTokens: result.cacheReadTokens,
  });

  const parsed = parseArchitectAnswers(result.text);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, raw: result.text, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, spend, model: CLAUDE_MODEL };
  }

  const spec = buildSpec({ ...parsed.answers, date: asOfDate, item_id: task.taskId });
  if (!spec.ok) {
    return { ok: false, reason: `buildSpec() refused: ${spec.reason}`, answers: parsed.answers, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, spend, model: CLAUDE_MODEL };
  }

  /*
   * ── THE STRICT END OF THE PHASES FIELD (2026-09-05, session 43, Item A) ──
   *
   * `phases` is OPTIONAL on the owner's own form, deliberately — see the
   * field's note in spec-builder.js. It is effectively REQUIRED here, and this
   * is the line that makes it so.
   *
   * The reason is that the two ends of the form serve different people. The
   * owner describing what he wants should not have to produce an
   * implementation plan; the Architect writing a spec FOR THE OFFICE'S OWN
   * BUILD CHAIN has no such excuse — the very next thing to touch this file is
   * `dispatch.js`, which refuses `no_phases`, and a spec that cannot be
   * dispatched is a spec that cost an Anthropic call and moved nothing. This
   * refusal is what makes "every spec the office writes for itself is
   * dispatchable" true by construction rather than by hope.
   *
   * It fires AFTER the spend is recorded, on purpose: the call happened and
   * cost money whatever came back, the same posture the parse failure above
   * takes. And it names the count it got, because "no phases" and "one phase
   * the parser could not read" are different mistakes.
   */
  if (!spec.phases?.length) {
    return {
      ok: false,
      reason: 'the Architect\'s spec has no "## Phases" list the dispatcher can read, so it would be '
        + 'refused with `no_phases` the moment it was paired. Nothing was committed. '
        + `(${(parsed.answers.phases || '').split(/\r?\n/).filter((l) => l.trim()).length} non-empty line(s) were written under that heading, 0 parsed.)`,
      answers: parsed.answers,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      spend,
      model: CLAUDE_MODEL,
    };
  }

  return {
    ok: true,
    markdown: spec.markdown,
    title: spec.title,
    // Reported, not just used: a caller reading a dispatch record wants to see
    // the same phase count `dispatch.js` will see, without re-parsing the file.
    phases: spec.phases,
    answers: parsed.answers,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    spend,
    budget,
    model: CLAUDE_MODEL,
    stopReason: result.stopReason,
  };
}

/**
 * Session 31, Item E: the Architect's SECOND and LAST touch on a build —
 * approval, once no blocking review remains. He does not repair (E1); by
 * the time this is called, the repair loop has already brought every
 * blocking review to a non-blocking state or the loop has stopped and
 * surfaced the stalemate to the owner instead of reaching here.
 *
 * Same named path, same component:'architect' sub-budget as
 * runArchitectSpecCall() above — "one live call" and "the second Anthropic
 * touch" from the brief both assume ONE budget for the Architect's work on
 * a build, not per-call-type budgets that would need their own accounting.
 */
export const ARCHITECT_APPROVAL_SYSTEM = [
  'You are the Architect — Agent 10 of this AI office, root clearance, the office\'s final technical authority.',
  'You are giving the FINAL approval on a build before it merges. You do not repair code yourself — if something is genuinely wrong, you say so and refuse; you do not fix it in this call.',
  '',
  'Answer with a SINGLE JSON object and nothing else: { "verdict": "approve" | "block", "reasoning": "<why>" }.',
  '"approve" means the artifact is ready to merge as-is. "block" means it is not, and "reasoning" must say plainly what is wrong — that becomes a new finding for the repair loop, so be specific.',
].join('\n');

export function buildArchitectApprovalUserPrompt({ taskId, slug, specText, artifactContent, reviewSummary }) {
  return [
    `Board task ${taskId || slug} — warehouse \`tasks/${slug}/\`.`,
    '',
    'The spec:',
    '---', specText, '---',
    '',
    'The artifact as it stands now:',
    '---', artifactContent, '---',
    '',
    'What the review loop found (empty means no reviewer raised a blocking finding this round):',
    '---', reviewSummary || '(no outstanding blocking findings recorded)', '---',
    '',
    'Give your verdict now.',
  ].join('\n');
}

export function parseArchitectVerdict(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return { ok: false, reason: 'no JSON object found in the Architect\'s reply' };
  let parsed;
  try { parsed = JSON.parse(s.slice(start, end + 1)); } catch (err) { return { ok: false, reason: `not valid JSON: ${err.message}` }; }
  const verdict = String(parsed?.verdict || '').toLowerCase().trim();
  if (verdict !== 'approve' && verdict !== 'block') {
    return { ok: false, reason: `verdict must be "approve" or "block", got ${JSON.stringify(parsed?.verdict)}` };
  }
  return { ok: true, verdict, reasoning: String(parsed?.reasoning || '') };
}

export async function runArchitectApprovalCall(env, task) {
  if (!env?.ANTHROPIC_API_KEY) return { ok: false, reason: 'anthropic_api_key_not_configured' };

  const budget = await getClaudeBudgetStatus(env, { component: 'architect' });
  if (budget.overBudget) {
    return { ok: false, reason: `architect_spec_budget_exhausted ($${budget.spentUsd.toFixed(2)}/$${budget.capUsd}/mo)`, budget };
  }

  let result;
  try {
    result = await callClaudeMessages({
      apiKey: env.ANTHROPIC_API_KEY,
      system: ARCHITECT_APPROVAL_SYSTEM,
      messages: [{ role: 'user', content: buildArchitectApprovalUserPrompt(task) }],
      maxTokens: 1500,
      effort: 'medium',
      disableThinking: true,
    });
  } catch (err) {
    return { ok: false, reason: `anthropic call threw: ${err.message}` };
  }

  const spend = await recordClaudeSpend(env, {
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, component: 'architect',
    // Session 34, C3/C5: cache tokens are billed (1.25x write, 0.1x read) and
    // are NOT in result.inputTokens. Passing them keeps the spend guard exact
    // whether or not a breakpoint was set on this call.
    cacheWriteTokens: result.cacheWriteTokens, cacheReadTokens: result.cacheReadTokens,
  });

  const parsed = parseArchitectVerdict(result.text);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, raw: result.text, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, spend, model: CLAUDE_MODEL };
  }

  return {
    ok: true,
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    spend,
    budget,
    model: CLAUDE_MODEL,
  };
}
