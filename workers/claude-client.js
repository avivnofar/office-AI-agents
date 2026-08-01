/**
 * Data Center — AI Agent Simulation — direct Anthropic Messages API client.
 *
 * Used ONLY by the Guides pipeline (workers/guide-engine.js) for the
 * Architect's (agent 10) review/finalize pass and the weekly verification
 * pass — see CLAUDE.md "Guides" section for why this bypasses data-center-api's
 * /api/chat (agent-base.js _askDataCenter()): that path is sized for short
 * chat answers with its own model/prompt/output-token limit, not a rewritten
 * 3-5 page guide.
 *
 * Cloudflare Workers can fetch api.anthropic.com directly — the "error 1042"
 * restriction (a Worker can't fetch another Worker's *.workers.dev URL) only
 * applies to *.workers.dev targets, not arbitrary external hosts.
 *
 * No Groq, no Gemini here — this file talks to exactly one model,
 * claude-sonnet-5, via ANTHROPIC_API_KEY (Worker secret).
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Current Sonnet-tier model — see config/token-economy.json app_search_model and CLAUDE.md's pricing note. */
export const CLAUDE_MODEL = 'claude-sonnet-5';

/**
 * Anthropic's server-side web search tool (see docs.claude.com Server Tools
 * reference). Used only by the weekly verification pass — declaring it
 * alongside a normal review call would be pointless spend for a task that
 * doesn't need fresh grounding.
 */
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };

/** A server-side-tool turn that hits its internal iteration cap returns
 * stop_reason 'pause_turn' — resume by re-sending history unchanged, per
 * Anthropic's documented pattern. Capped here so a pathological loop can't
 * run away with budget. */
const MAX_PAUSE_TURN_RESUMES = 3;

/**
 * Calls Claude (Sonnet 5) directly via the Messages API.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - ANTHROPIC_API_KEY (Worker secret)
 * @param {string} [opts.model] - defaults to CLAUDE_MODEL
 * @param {string} [opts.system] - system prompt
 * @param {Array<{role: 'user'|'assistant', content: string}>} opts.messages
 * @param {number} [opts.maxTokens]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [opts.effort] - defaults to 'medium';
 *   the review/verify tasks here are bounded editing/fact-checking work, not
 *   open-ended agentic exploration, so the API's own 'high' default would
 *   overspend against the $4.50/mo guides soft-stop for no quality benefit.
 * @param {boolean} [opts.webSearch] - adds the web_search server tool
 *   (weekly verification pass only). Sonnet 5 tool calls behave normally with
 *   thinking on (the default) — thinking is deliberately left enabled
 *   whenever a tool is in play, since disabling it risks a tool call
 *   silently arriving as plain text instead of a real tool_use block.
 * @param {boolean} [opts.disableThinking] - only safe to set when webSearch
 *   is false (see above). Sonnet 5 accepts {type:"disabled"} without an
 *   effort ceiling (that restriction is Opus-5-only), and disabling it for a
 *   plain text-editing task keeps spend predictable against the guides budget.
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, stopReason: string}>}
 */
export async function callClaudeMessages({
  apiKey,
  model = CLAUDE_MODEL,
  system,
  messages,
  maxTokens = 4096,
  effort = 'medium',
  webSearch = false,
  disableThinking = false,
}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  let conversation = messages.map((m) => ({ ...m }));
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let resumeCount = 0; resumeCount <= MAX_PAUSE_TURN_RESUMES; resumeCount += 1) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: conversation,
      output_config: { effort },
    };
    if (system) body.system = system;
    if (webSearch) body.tools = [WEB_SEARCH_TOOL];
    if (disableThinking && !webSearch) body.thinking = { type: 'disabled' };

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    totalInputTokens += data.usage?.input_tokens ?? 0;
    totalOutputTokens += data.usage?.output_tokens ?? 0;

    if (data.stop_reason === 'pause_turn' && resumeCount < MAX_PAUSE_TURN_RESUMES) {
      // Server-side tool hit its internal iteration cap — resume by
      // appending the assistant turn as-is and re-sending, per Anthropic's
      // documented pause_turn pattern (no synthetic "continue" message).
      conversation = [...conversation, { role: 'assistant', content: data.content }];
      continue;
    }

    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return {
      text,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      stopReason: data.stop_reason,
    };
  }

  throw new Error('Anthropic API: exceeded pause_turn resume limit');
}
