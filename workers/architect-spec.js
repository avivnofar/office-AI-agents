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
  'The object has exactly these keys: "title", "task_type", "what", "out_of_scope", "where", "io", "constraints", "done", "open_decisions". All values are plain strings.',
  `"task_type" must be exactly one of: ${TASK_TYPES.join(', ')}.`,
  '',
  'What each of the other fields means (this is the office\'s own spec form — answer it the way a careful human would):',
  fieldGuide(),
  '',
  `Under "open_decisions": ${OPEN_DECISIONS_INSTRUCTION} Do not leave a real ambiguity in the board task unresolved — decide it yourself and record the decision and reasoning as the value of this field. Leave the field genuinely empty only if there is truly nothing to decide.`,
  'Be specific and concrete. "io" especially needs a real example line of input and a real example line of output, not a description of their shape.',
].join('\n');

export function buildArchitectSpecUserPrompt({ taskId, title, taskText }) {
  return [
    `Board task ${taskId} — "${title}"`,
    '',
    'Full text of the task, exactly as it reads on the board:',
    '---',
    taskText,
    '---',
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
 * @param {object} task - { taskId, title, taskText }
 * @param {string} [date] - YYYY-MM-DD, passed through to buildSpec(); a
 *   parameter rather than `new Date()` so this function can be exercised by
 *   a caller that pins the date, same reason buildSpec() itself takes one.
 * @returns {Promise<object>}
 */
export async function runArchitectSpecCall(env, task, { date } = {}) {
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
    });
  } catch (err) {
    return { ok: false, reason: `anthropic call threw: ${err.message}` };
  }

  // Spend is recorded whether or not the reply parses — the call was made
  // and cost real money regardless of what came back, the same posture
  // guide review takes (it records spend on REVISE/REJECT, not only APPROVE).
  const spend = await recordClaudeSpend(env, {
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, component: 'architect',
  });

  const parsed = parseArchitectAnswers(result.text);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, raw: result.text, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, spend, model: CLAUDE_MODEL };
  }

  const spec = buildSpec({ ...parsed.answers, date: asOfDate, item_id: task.taskId });
  if (!spec.ok) {
    return { ok: false, reason: `buildSpec() refused: ${spec.reason}`, answers: parsed.answers, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, spend, model: CLAUDE_MODEL };
  }

  return {
    ok: true,
    markdown: spec.markdown,
    title: spec.title,
    answers: parsed.answers,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    spend,
    budget,
    model: CLAUDE_MODEL,
    stopReason: result.stopReason,
  };
}
