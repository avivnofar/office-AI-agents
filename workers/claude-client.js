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
 * @param {boolean} [opts.cacheSystem] - place an explicit prompt-caching
 *   breakpoint at the end of the system prompt. See CACHING below.
 * @param {string} [opts.cachePrefix] - a large STABLE block that is identical
 *   between calls, sent as the first content block of the first user message
 *   with the breakpoint on it. See CACHING below.
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, cacheWriteTokens: number, cacheReadTokens: number, stopReason: string}>}
 */

/* ══════════════════════════════════════════════════════════════════════════
 * CACHING — SESSION 34, ITEM C3. READ THE ARITHMETIC BEFORE TURNING IT ON.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Anthropic's prompt cache is a PREFIX MATCH with a 5-minute default TTL (1
 * hour at double the write price). Verified against the published pricing page
 * on 2026-08-29, for Sonnet 5 specifically:
 *
 *   base input   $2.00 / MTok
 *   5m write     $2.50 / MTok   (1.25x)
 *   1h write     $4.00 / MTok   (2x)
 *   cache hit    $0.20 / MTok   (0.1x)
 *
 * Two facts decide whether it can pay off here, and both are properties of the
 * office's schedule, not of this code:
 *
 * 1. **The minimum cacheable prefix on Sonnet 5 is 1,024 tokens.** A shorter
 *    prefix does not cache and does not error — `cache_creation_input_tokens`
 *    simply comes back 0. `ARCHITECT_APPROVAL_SYSTEM` is about five lines. A
 *    breakpoint on it alone is a no-op, silently.
 *
 * 2. **A write only pays for itself if a later call READS it.** The Architect's
 *    scheduled calls are ONE PER TICK, on ticks 30+ minutes apart, and 7 calls
 *    have been made in total across two weeks. A 5-minute entry is long dead by
 *    the next call; so is a 1-hour one at a day's spacing. On that cadence a
 *    breakpoint buys nothing and costs 1.25x on whatever it covers.
 *
 * So this is OPT-IN per call site, and deliberately not switched on for the
 * approval path. `cachePrefix` exists for the one case where the arithmetic
 * does work — a large block that is BYTE-IDENTICAL between calls made close
 * together, which is the brain audit's harvest slice (~30,000 chars, the same
 * HARVEST.md for every lens in one run). Anything volatile — the task, the
 * artifact, the review summary, a date — must stay AFTER the breakpoint, or
 * every call writes a fresh entry that nothing ever reads: a pure surcharge
 * whose signature is a `cacheWriteTokens` on every call and a `cacheReadTokens`
 * that never arrives.
 *
 * The usage fields are returned rather than discarded precisely so that
 * signature is observable. `recordClaudeSpend()` charges them at the
 * multipliers above, so a cache that misses shows up as a HIGHER recorded cost
 * — which is the honest outcome and the one worth finding out about.
 *
 * ── MEASURED ON TWO REAL ARCHITECT CALLS, 2026-08-29. IT DOES NOT PAY. ─────
 *
 * Not argued from the documentation — run. Two live `architect_spec_block`
 * calls against the deployed Worker, back to back, identical task, the only
 * difference being the breakpoint:
 *
 *   caching OFF  input 2,227  output 1,082  cache_write 0  cache_read 0  $0.015274
 *   caching ON   input 2,227  output 1,157  cache_write 0  cache_read 0  $0.016024
 *
 * `input_tokens` is IDENTICAL and `cache_creation_input_tokens` is ZERO. The
 * breakpoint did nothing at all, exactly as fact (1) above predicts:
 * `ARCHITECT_SPEC_SYSTEM` is ~771 tokens against a 1,024-token minimum. The
 * cost difference is 75 more output tokens, which is run-to-run variation and
 * not an effect of caching. (Both costs are in D1 `claude_budget_usage`, month
 * `2026-08#architect`: $0.150008/7 calls before, $0.181306/9 calls after.)
 *
 * ── AND EVEN A CACHEABLE PREFIX WOULD BARELY HELP: OUTPUT DOMINATES ────────
 *
 * The same measurement settles the bigger question. At $2/M input and $10/M
 * output, that call is:
 *
 *   input   2,227 x $2/M  = $0.004454   —  29% of the call
 *   output  1,082 x $10/M = $0.010820   —  71% of the call
 *
 * Caching only ever reduces INPUT. Perfect caching of every input token on this
 * path — impossible, since the task text varies — would still leave 71% of the
 * bill untouched. The lever on the Architect's cost is output length, not the
 * prompt.
 *
 * This also corrects the premise this work started from, which held that the
 * Architect's calls run "roughly 15,000 input tokens against ~1,200 output"
 * with a near-identical office-context block between them. Measured: 2,227
 * input, and NO Architect prompt carries an office-context block —
 * `buildArchitectSpecUserPrompt()` and `buildArchitectApprovalUserPrompt()` are
 * task text, spec, artifact and review summary, every one of them varying.
 *
 * ── SO CACHING IS BUILT, MEASURED, AND LEFT OFF ───────────────────────────
 *
 * `cacheSystem` and `cachePrefix` default false and NOTHING sets them on the
 * scheduled path. The mechanism stays because the measurement is worth being
 * able to repeat and because one candidate genuinely qualifies and has simply
 * not been tried: the brain audit's harvest slice (`sliceHarvest()`, up to
 * 30,000 chars ~ 8,300 tokens, byte-identical across the five lens calls of a
 * single run). That is the ONLY prompt in this office that clears both bars —
 * over the 1,024-token minimum, and re-read within the 5-minute TTL by calls
 * in the same run. It is named here rather than switched on, because nobody has
 * measured it and this block exists to stop the next person assuming.
 *
 * ── MEASURED 2026-08-29 (SESSION 35, ITEM E), AND THE ANSWER IS ELSEWHERE ──
 *
 * **The harvest slice is not this client's traffic.** The five lens calls it
 * names run through `adminDeskJudgment()` on the ROUTED JUDGMENT LANE — this
 * client is only the Architect's decomposition, one call per run. The slice is
 * byte-identical across five calls that never reach this file.
 *
 * So the candidate was measured where it actually runs, against Cerebras
 * `gpt-oss-120b`, and three facts settle it:
 *
 *   1. **That provider's prompt caching is ON BY DEFAULT and has no toggle.**
 *      There was never anything to switch on. The office was already getting
 *      it and simply could not see it.
 *   2. **It works, and the slice hits hard.** Two live calls, 2026-08-29, on a
 *      26,000-char slice of the real HARVEST.md:
 *        warm (a repeat of an identical prefix): input 6,632, cached **6,528**
 *        cold (one unique nonce prepended):      input 6,652, cached **0**
 *      98.4% of the input served from cache, and 0% once the prefix is broken
 *      — which is the falsifying half, not the confirming one.
 *   3. **It saves no money.** That provider charges no premium for a cached
 *      token and bills input identically either way, and this office is on its
 *      free tier. What it buys is latency and TPM headroom, not spend.
 *
 * `provider-common.js` `normalizeOpenAiChat()` now returns
 * `usage.cachedInputTokens` so that stays observable rather than being a claim
 * in a comment. **Nothing about THIS file changed** and `cacheSystem` /
 * `cachePrefix` are still off on every scheduled path — the 2026-08-29
 * measurement is about the other provider, and the arithmetic above, which says
 * a breakpoint here buys nothing at one call per tick, is untouched.
 * ═════════════════════════════════════════════════════════════════════════ */
export async function callClaudeMessages({
  apiKey,
  model = CLAUDE_MODEL,
  system,
  messages,
  maxTokens = 4096,
  effort = 'medium',
  webSearch = false,
  disableThinking = false,
  cacheSystem = false,
  cachePrefix = null,
}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  let conversation = messages.map((m) => ({ ...m }));
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;

  // A stable prefix goes in FRONT of the first user turn's own text, with the
  // breakpoint on it — the "shared prefix, varying suffix" placement. Putting
  // it after would cache the varying part too and never read it back.
  if (cachePrefix) {
    const first = conversation[0];
    const tail = typeof first?.content === 'string'
      ? [{ type: 'text', text: first.content }]
      : (first?.content || []);
    conversation = [
      {
        role: 'user',
        content: [
          { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
          ...tail,
        ],
      },
      ...conversation.slice(1),
    ];
  }

  for (let resumeCount = 0; resumeCount <= MAX_PAUSE_TURN_RESUMES; resumeCount += 1) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: conversation,
      output_config: { effort },
    };
    if (system) {
      // Block form only when a breakpoint is wanted — a plain string is the
      // shape every existing caller sends and is left byte-identical, so this
      // change cannot invalidate anything that was already being cached.
      body.system = cacheSystem
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
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
    // `input_tokens` is the UNCACHED REMAINDER, not the prompt size. These two
    // are the rest of it, and they are billed — at 1.25x and 0.1x. Collected
    // unconditionally, including when no breakpoint was asked for: the
    // web_search server tool inserts a cache write of its own after tool
    // results, which is expected behaviour and would otherwise be spend this
    // office paid for and never recorded.
    totalCacheWriteTokens += data.usage?.cache_creation_input_tokens ?? 0;
    totalCacheReadTokens += data.usage?.cache_read_input_tokens ?? 0;

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
      cacheWriteTokens: totalCacheWriteTokens,
      cacheReadTokens: totalCacheReadTokens,
      stopReason: data.stop_reason,
    };
  }

  throw new Error('Anthropic API: exceeded pause_turn resume limit');
}
