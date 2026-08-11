/**
 * Data Center — AI Agent Simulation — AgentBase.
 *
 * Base class for all 11 simulated agents (agent-1..4 implement full
 * behavior in Phase 1; agent-5..11 use agent-stub.js, which extends this
 * unchanged). Encapsulates the shared state machine, session bookkeeping,
 * Gemini calls, report/suggestion filing, live-app interaction, and
 * Durable Object persistence described in AGENTS.md.
 *
 * Status: DRAFT (Phase 1 foundation) — interfaces and critical paths first,
 * heuristics (e.g. evaluateResponseQuality, getDbContext) are placeholders.
 */

import { callGemini, callCloudflareFallback } from '../workers/gemini-client.js';
import { callGroq } from '../workers/groq-client.js';
import { queryNotebookX } from '../workers/notebookx-client.js';
import { getClaudeBudgetStatus, recordClaudeSpend, getClaudeCallsToday, CLAUDE_MAX_CALLS_PER_DAY } from '../workers/model-router.js';
import { checkGeminiPacingSlot } from '../workers/gemini-pacer.js';
import { detectCapabilityGap } from '../workers/gap-reports.js';
import { recordOfficeEvent } from '../workers/improvement-loop.js';
import { getOfficeContext } from '../workers/office-context.js';
// The office's own projects, as data. office-context.js deliberately imports
// no JSON (its verifier must be able to `import` it under plain node), so the
// list is PASSED IN by callers that already load config — see that file's
// header. This site passed nothing until 2026-08-08, which meant every agent
// prompt carried the board and the client requirements and still could not
// name the projects the office works on.
import officeProjects from '../config/office-projects.json';

const MOOD_MIN = 0;
const MOOD_MAX = 100;
const IRRITATION_MAX = 5;

export class AgentBase {
  /**
   * @param {object} config - this agent's entry from agents-config.json
   * @param {object} env - Worker env (DB, GEMINI_API_KEY, SIM_CONFIG, APP_API_BASE, ...)
   * @param {object} [doStub] - Durable Object stub bound to this agent's state
   */
  constructor(config, env, doStub) {
    this.config = config;
    this.env = env;
    this.doStub = doStub;

    this.id = config.id;
    this.key = config.key;
    this.name = config.name;
    this.clearance = config.clearance;

    // 1. State machine
    this.mood = 50;
    this.irritation = 0;
    this.isHappy = false;
    this.isAngry = false;

    // Trainee-only extra state (harmless on other agents)
    this.isPanic = false;
    this.panicLevel = 0;

    // Permanent flags survive resetWeeklyState() (e.g. Agent 2's
    // "slow_ui"/"sloppy_design" irritation that persists until fixed)
    this.permanentIrritationFlags = [];

    // Durable per-agent config tweaks written by meeting-engine.js
    // (decisions.config_overrides) and agent-runner.js (rolling
    // model_usage_rate adjustments). Merged over `this.config` on load and
    // persisted alongside the rest of the state so they survive restarts.
    this.configOverrides = {};

    this.session = null;
  }

  /* ───────────────────────── 1. State machine ───────────────────────── */

  async adjustMood(delta) {
    this.mood = Math.min(MOOD_MAX, Math.max(MOOD_MIN, this.mood + delta));
    await this.saveState();
    return this.mood;
  }

  async addIrritiation() {
    this.irritation = Math.min(IRRITATION_MAX, this.irritation + 1);
    const angryThreshold = this.config.irritation_stack?.angry_threshold ?? IRRITATION_MAX;
    if (this.irritation >= angryThreshold && !this.isAngry) {
      await this.triggerAngry(`${this.name}: irritation stack reached ${this.irritation}/${IRRITATION_MAX}`);
    }
    await this.saveState();
    return this.irritation;
  }

  async resolveIrritation() {
    this.irritation = Math.max(0, this.irritation - 1);
    if (this.irritation === 0) this.isAngry = false;
    await this.saveState();
    return this.irritation;
  }

  async triggerHappy() {
    this.isHappy = true;
    await this.adjustMood(10);
    return this.config.states?.HAPPY?.effects || [];
  }

  async triggerAngry(summary = `${this.name} reached the ANGRY state`) {
    this.isAngry = true;
    await this.fileIncidentReport(summary);
    if (this.session) await this.endSession();
    await this.saveState();
  }

  /** Trainee-only: bumps panicLevel and runs the escalation protocol at >= 80. */
  async addPanic(delta) {
    this.panicLevel = Math.min(100, Math.max(0, this.panicLevel + delta));
    if (this.panicLevel >= 80 && !this.isPanic) {
      this.isPanic = true;
    }
    await this.saveState();
    return this.panicLevel;
  }

  async resolvePanic() {
    this.panicLevel = 0;
    this.isPanic = false;
    await this.saveState();
  }

  /** Weekly reset: regress mood to the mean, clear non-permanent irritation. */
  async resetWeeklyState() {
    this.mood = Math.round((this.mood + 50) / 2);
    if (this.permanentIrritationFlags.length === 0) {
      this.irritation = 0;
      this.isAngry = false;
    }
    this.isHappy = false;
    await this.saveState();
    return { mood: this.mood, irritation: this.irritation };
  }

  /* ─────────────────────── 2. Session management ────────────────────── */

  async startSession(caseData, mode = 'search') {
    this.session = {
      id: crypto.randomUUID(),
      agent_id: this.id,
      started_at: new Date().toISOString(),
      ended_at: null,
      mode,
      cases_handled: 0,
      mood_start: this.mood,
      mood_end: null,
      irritation_events: 0,
      happy_events: 0,
      extended_session: false,
      case: caseData || null,
    };

    if (this.env.DB) {
      await this.env.DB.prepare(
        `INSERT INTO agent_sessions (id, agent_id, started_at, mode, mood_start) VALUES (?, ?, ?, ?, ?)`
      ).bind(this.session.id, this.id, this.session.started_at, mode, this.mood).run();
    }

    await this.saveState();
    return this.session;
  }

  async endSession() {
    if (!this.session) return null;

    this.session.ended_at = new Date().toISOString();
    this.session.mood_end = this.mood;

    if (this.env.DB) {
      await this.env.DB.prepare(
        `UPDATE agent_sessions
         SET ended_at = ?, mood_end = ?, cases_handled = ?, irritation_events = ?, happy_events = ?, extended_session = ?
         WHERE id = ?`
      ).bind(
        this.session.ended_at,
        this.mood,
        this.session.cases_handled,
        this.session.irritation_events,
        this.session.happy_events,
        this.session.extended_session ? 1 : 0,
        this.session.id
      ).run();
    }

    const finished = this.session;
    this.session = null;
    await this.saveState();
    return finished;
  }

  /** Applies session_extension_multiplier from agents-config.json. */
  async extendSession() {
    if (!this.session) return false;
    const multiplier = this.config.session_extension_multiplier || 1;
    this.session.extended_session = true;
    this.session.cases_handled = Math.ceil((this.session.cases_handled || 0) * multiplier) || this.session.cases_handled;
    await this.saveState();
    return true;
  }

  /* ─────────────── 3. Model calls (persona-prompted LLM access) ────────
   *
   * RENAMED 2026-07-19 (was one `queryGemini()` router): the old name read
   * as "this calls Gemini" while bare calls actually went to Groq first —
   * exactly the misreading behind that day's Hebrew gap-note bug (and the
   * latent Trainee bilingual-guide one found in the rename audit). Two
   * methods now, named for what a bare call actually hits:
   *
   *   queryGroqRouted()   — routine persona flavor (English): Groq
   *                         llama3-8b-8192 first, Cloudflare Workers AI
   *                         fallback if Groq is unavailable (no key / 429 /
   *                         error). opts.forceFallback skips straight to
   *                         the fallback (testing — /api/agents/test-gemini).
   *   queryGeminiDirect() — genuinely Gemini (gemini-3.1-flash-lite):
   *                         Hebrew/bilingual composition and any future
   *                         large-context report call. Degrades to the
   *                         Cloudflare fallback only if Gemini itself 429s.
   *
   * Both prepend the same persona context via _buildPersonaSystemPrompt().
   * There is deliberately NO `queryGemini` alias — a stale call site should
   * fail loudly, not silently pick a model.
   */

  /** Persona context shared by both model paths: personality + current state + behavioral rules + (placeholder) DB context + the office's own work. */
  async _buildPersonaSystemPrompt(prompt, systemPrompt) {
    const dbContext = await this.getDbContext(prompt);

    // THE OFFICE'S OWN WORK (added 2026-08-07, behind office_context_enabled,
    // default OFF). Until this existed, an agent's entire world was its
    // persona, its mood, and the case in front of it — the board, the client
    // requirements and the office's projects reached no prompt anywhere.
    //
    // CACHE-ONLY on this path (`allowFetch` deliberately not passed). This
    // runs on EVERY agent model call, of which there are many a day; letting
    // it refresh would spend two GitHub round-trips per LLM call to learn
    // nothing new. The meeting engine and the daily/weekly report renderers
    // run once per cycle and are the ones that refresh the cache.
    //
    // NOTE — a deviation from the survey's plan, recorded rather than done
    // quietly: this was going to be injected INTO getDbContext(), which is
    // the existing inert hook. It is a separate block instead, because
    // getDbContext()'s output is labelled "Relevant Data Center entries:" and
    // the office's own board is not a Data Center entry. Reusing the seam
    // would have cost one line and mislabelled the content for every future
    // reader. getDbContext() is left exactly as it was.
    let officeBlock = '';
    try {
      const office = await getOfficeContext(this.env, {
        shape: 'agent', agentId: this.id, agentName: this.config?.name || null, projects: officeProjects.projects,
        // A11 rank filtering (2026-08-10). `clearance` already exists on every
        // agent in agents-config.json and already routes fileSuggestion(); this
        // is the same tier driving what the agent is SHOWN. Passing the config
        // value rather than a new field means "who is an admin" stays one fact
        // in one file. An agent whose config somehow lacks it gets the
        // less-informed shape — see isAdminClearance()'s header.
        clearance: this.config?.clearance || null,
      });
      if (office?.text) officeBlock = office.text;
    } catch (err) {
      // Never let context assembly break a client answer. Track A yields to
      // nothing, least of all an office-building feature.
      console.warn(`[agent-${this.id}] office context unavailable: ${err.message}`);
    }

    const stateLine = this.isPanic
      ? `Current state: mood=${this.mood}, panic=${this.panicLevel}/100.`
      : `Current state: mood=${this.mood}, irritation=${this.irritation}/5, angry=${this.isAngry}.`;

    return [
      systemPrompt || this.config.system_prompt_additions || '',
      stateLine,
      (this.config.behavioral_rules || []).length
        ? `Behavioral rules:\n- ${this.config.behavioral_rules.join('\n- ')}`
        : '',
      dbContext ? `Relevant Data Center entries:\n${dbContext}` : '',
      officeBlock,
    ].filter(Boolean).join('\n\n');
  }

  /**
   * The assembled persona system prompt, WITHOUT making a model call.
   *
   * Added 2026-08-09 for the report pipeline's context-fit guard. That guard
   * was sizing the review request against REPORT_REVIEW_SYSTEM, which is not
   * what goes over the wire — `_buildPersonaSystemPrompt()` appends the state
   * line, the behavioral rules, the DB context and the office-context block
   * before either provider sees it, and the difference measured ~1,000 tokens
   * against an 8,192-token total ceiling.
   *
   * A caller that must size a request has no way to measure what is actually
   * sent unless it can build it, so it can. Pass the result straight back in
   * as `opts.assembledSystemPrompt` to avoid assembling it twice — the second
   * assembly would re-run getDbContext() and cost real subrequests to produce
   * the same string.
   */
  async buildAssembledSystemPrompt(prompt, systemPrompt) {
    return this._buildPersonaSystemPrompt(prompt, systemPrompt);
  }

  /** Routine persona-flavor calls: Groq first, Cloudflare Workers AI fallback. NOT Gemini — see section comment. */
  async queryGroqRouted(prompt, systemPrompt, opts = {}) {
    // opts.assembledSystemPrompt: a prompt this caller ALREADY assembled via
    // buildAssembledSystemPrompt(), reused rather than rebuilt. Absent for
    // every pre-existing caller, so their behaviour is byte-unchanged.
    const fullSystemPrompt = opts.assembledSystemPrompt
      ?? await this._buildPersonaSystemPrompt(prompt, systemPrompt);

    if (opts.forceFallback) {
      const result = await callCloudflareFallback({
        ai: this.env.AI,
        prompt,
        systemPrompt: fullSystemPrompt,
        temperature: 0.8,
        maxTokens: 1024,
      });
      this.lastModelSource = result.source;
      return result.text;
    }

    // opts.maxTokens added 2026-08-08 for the report pipeline's review call,
    // which must emit a whole report and not a case-sized answer. It DEFAULTS
    // to the pre-existing 512, so every existing caller is byte-unchanged.
    // The reason it had to be explicit: neither groq-client.js nor
    // gemini-client.js surfaces a finish reason, so a response cut off at the
    // ceiling is indistinguishable from a short one at the call site — the
    // pipeline detects it structurally instead (report-pipeline.js sentinel).
    const outTokens = opts.maxTokens ?? 512;
    const groqResult = await callGroq({
      apiKey: this.env.GROQ_API_KEY,
      prompt,
      systemPrompt: fullSystemPrompt,
      temperature: 0.8,
      maxTokens: outTokens,
      agentId: this.id,
    });
    if (groqResult) {
      this.lastModelSource = groqResult.source;
      return groqResult.text;
    }

    console.warn(`[agent-${this.id}] Groq unavailable — used cloudflare-fallback (@cf/meta/llama-3.1-8b-instruct-fp8)`);
    const cfResult = await callCloudflareFallback({
      ai: this.env.AI,
      prompt,
      systemPrompt: fullSystemPrompt,
      temperature: 0.8,
      maxTokens: outTokens,
    });
    this.lastModelSource = cfResult.source;
    return cfResult.text;
  }

  /**
   * Genuinely-Gemini calls (gemini-3.1-flash-lite): Hebrew/bilingual
   * composition (gap notes, Trainee guides) and any future large-context
   * report synthesis (opts.reportType is only a log label now — no caller
   * currently passes it; meeting-engine.js calls callGemini() itself).
   */
  async queryGeminiDirect(prompt, systemPrompt, opts = {}) {
    const fullSystemPrompt = await this._buildPersonaSystemPrompt(prompt, systemPrompt);

    const simConfig = this.env.SIM_CONFIG?.GEMINI || {};
    const result = await callGemini({
      apiKey: this.env.GEMINI_API_KEY,
      model: simConfig.model || 'gemini-3.1-flash-lite', // gemini-3.5-flash is deprecated — never reintroduce it, see CLAUDE.md
      endpoint: simConfig.api_endpoint || 'https://generativelanguage.googleapis.com/v1beta/models',
      temperature: simConfig.temperature ?? 0.8,
      // opts.maxTokens added 2026-08-08 — see queryGroqRouted(). Defaults to
      // the pre-existing expression, so no existing caller changes.
      maxTokens: opts.maxTokens ?? Math.max(simConfig.max_tokens ?? 1024, 2048),
      prompt,
      systemPrompt: fullSystemPrompt,
      ai: this.env.AI,
    });
    this.lastModelSource = result.source;
    if (result.source === 'cloudflare-fallback') {
      console.warn(`[agent-${this.id}] Gemini quota exhausted${opts.reportType ? ` (${opts.reportType})` : ''} — used cloudflare-fallback (@cf/meta/llama-3.1-8b-instruct-fp8)`);
    }
    return result.text;
  }

  /**
   * Placeholder for "top 3 relevant entries from data-center DB".
   * Phase 2: query a precomputed index over data/*.json by keyword overlap.
   */
  async getDbContext(_query) {
    return '';
  }

  /* ─────────────────────── 4. Report generation ─────────────────────── */

  async fileIncidentReport(summary) {
    return this._fileReport('incident', `Incident — ${this.name}`, summary, 'critical');
  }

  async fileStatusReport(content) {
    return this._fileReport('status', `Status report — ${this.name}`, content, 'info');
  }

  async fileWeeklyReport(content) {
    return this._fileReport('weekly', `Weekly report — ${this.name}`, content, 'info');
  }

  /**
   * Files a Hebrew capability-gap finding (2026-07-18 Q&A-engine rebuild —
   * replaces the old English model_education_case_study + GitHub-Issue
   * digest entirely; see workers/gap-reports.js). Queued in `reports`
   * (type='gap_hebrew', project set) for the daily digest
   * (agent-runner.js fileGapDigests()) to batch into
   * reports/gaps/<project>/<date>.md — never a GitHub Issue.
   */
  async fileGapReport(project, caseId, hebrewContent) {
    const id = crypto.randomUUID();
    if (this.env.DB) {
      await this.env.DB.prepare(
        `INSERT INTO reports (id, agent_id, type, title, content, severity, project)
         VALUES (?, ?, 'gap_hebrew', ?, ?, 'info', ?)`
      ).bind(id, this.id, caseId || this.name, hebrewContent, project).run();
    }
    return id;
  }

  /**
   * @param {string} content
   * @param {boolean} [isRoot] - escalate to "root" permission_level regardless of clearance
   */
  async fileSuggestion(content, isRoot = false) {
    const id = crypto.randomUUID();
    const permission_level = isRoot ? 'root' : this.clearance;

    if (this.env.DB) {
      await this.env.DB.prepare(
        `INSERT INTO suggestions (id, agent_id, permission_level, title, content, auto_apply, status)
         VALUES (?, ?, ?, ?, ?, 0, 'pending')`
      ).bind(id, this.id, permission_level, `Suggestion from ${this.name}`, content).run();
    }

    return id;
  }

  async _fileReport(type, title, content, severity) {
    const id = crypto.randomUUID();

    if (this.env.DB) {
      await this.env.DB.prepare(
        `INSERT INTO reports (id, agent_id, type, title, content, severity)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, this.id, type, title, content, severity).run();
    }

    return id;
  }

  /* ───────────────────── 5. Ask-and-evaluate (Q&A engine) ────────────── */

  /**
   * Asks this agent's assigned question to whichever ONE production AI
   * system it targets — Claude via data-center (project: 'data-center') or
   * Gemini via a specific Notebook-X notebook (project: 'notebook-x',
   * kbSlug required). Replaces the old interactWithApp() dual-path
   * escalation logic (check notebook-x, fall through to Claude) — that
   * behavior belonged to the retired Netvill-CRM case model. Every question
   * from workers/qa-engine.js already targets exactly one project at
   * generation time; this method does not choose or escalate between them.
   *
   * @param {string} query
   * @param {'search'|'diagnose'} [mode]
   * @param {object} opts
   * @param {'data-center'|'notebook-x'} opts.project
   * @param {string} [opts.kbSlug] - required when project is 'notebook-x'
   * @param {string} [opts.caseId] - for gap-report attribution
   */
  async askAssignedProject(query, mode = 'search', opts = {}) {
    const ask = (q) => (opts.project === 'notebook-x'
      ? this._askNotebookX(q, mode, opts.kbSlug, opts.caseId)
      : this._askDataCenter(q, mode, opts.caseId));

    let result = await ask(query);

    // Step 3 (2026-07-18 rebuild): "how deep their follow-up goes on a
    // partial/unclear answer" — persona-tunable via `followup_depth`
    // (config/agents-config.json), applied uniformly here rather than
    // per-persona-class so all 11 personas get it without bespoke wiring.
    // Only fires on an UNCLEAR answer band (0.3-0.65) — a clearly bad
    // answer (< 0.3) is a gap-report candidate, not a follow-up candidate;
    // a clearly good one (>= 0.65) doesn't need chasing.
    const followupDepth = typeof this.config.followup_depth === 'number' ? this.config.followup_depth : 0;
    let depth = 0;
    let lastQuery = query;
    while (
      depth < followupDepth &&
      !result.skipped &&
      typeof result.quality === 'number' &&
      result.quality >= 0.3 && result.quality < 0.65
    ) {
      let followUpQuery;
      try {
        followUpQuery = await this.queryGroqRouted(
          `The last answer to "${lastQuery}" was unclear or only partially useful (quality ${result.quality.toFixed(2)}/1.0): """${(result.response || '').slice(0, 300)}""". ` +
          `Ask ONE short, sharper follow-up question to get a clearer answer on the same topic. Reply with only the follow-up question, nothing else.`
        );
      } catch {
        break;
      }
      if (!followUpQuery) break;
      depth += 1;
      lastQuery = followUpQuery;
      result = await ask(followUpQuery);
    }

    // ── IMPROVEMENT-LOOP CAPTURE (plan 1.1), added 2026-08-06 ──────────────
    // PURELY ADDITIVE AND GATED OFF. This is the only line of this method that
    // is new, it runs AFTER every decision above has already been made, it
    // reads `result` and never mutates it, and nothing branches on what it
    // returns. recordOfficeEvent() cannot throw and no-ops entirely while
    // SIM_KV `improvement_loop_enabled` is off or absent — the shipped
    // default. With the flag off this method behaves exactly as it did
    // before; scripts/verify-improvement-loop.js proves that rather than
    // asserting it.
    //
    // WHY IT IS HERE and not inside ask(): one row per unit of WORK, not per
    // model call. A case that needed three follow-ups to reach 0.7 is one
    // case with a story, and splitting it into four rows would make the QA's
    // per-worker quality average meaningless — the early low scores are the
    // process, not the outcome. `followup_depth` carries the story instead.
    //
    // `result.source` is what ACTUALLY answered, including after a lane
    // degraded to its backup — not the provider that was asked for. **This
    // was aspirational until 2026-08-10**: neither _askDataCenter() nor
    // _askNotebookX() actually set `.source` before that date, so this line
    // silently fell through to `lastModelSource` (a follow-up-question
    // artifact, not the answer's provider) — see the "source ADDED
    // 2026-08-10" notes on both functions above for the measured effect and
    // the fix.
    // ── THE ASK THAT NEVER HAPPENED IS A DIFFERENT EVENT (2026-08-10) ──────
    //
    // This line used to write EVERY outcome as `case_answer`, including the ones
    // where no provider was ever contacted. Measured on 2026-08-10: 86 of 129
    // rows, all `skipped: true`, all notebook-x, all `quality IS NULL` — the
    // Gemini pacer denying two thirds of Notebook-X asks, each denial recorded as
    // a row that looks like a unit of work and contains no measurement.
    //
    // The null was honest; the EVENT TYPE was not. `case_not_asked` splits them
    // on the one axis every consumer of this table already groups by, so a query
    // for `case_answer` returns scored asks and nothing else without a single
    // consumer being edited. See improvement-loop.js's NOT_ASKED_EVENT block for
    // the full decision, including why the 86 existing rows are left alone.
    //
    // `skipped` STAYS in the content JSON. It is the discriminator for every row
    // written before this change, and removing it would make the historical rows
    // unclassifiable — the pre-2026-08-10 archive is read by
    // `content LIKE '%"skipped":true%'` and that has to keep working.
    const notAsked = result?.skipped === true;
    await recordOfficeEvent(this.env, {
      agentId: this.id,
      eventType: notAsked ? 'case_not_asked' : 'case_answer',
      track: 'client',
      // Nothing answered, so there is no embodiment to record. Writing the
      // agent's LAST provider here would attribute a call that did not happen to
      // a provider that did not make it — and the Lead QA's cross-embodiment
      // comparison (1.5) would then average a real provider against silence.
      embodimentModel: notAsked ? null : (result?.source || this.lastModelSource || null),
      quality: typeof result?.quality === 'number' && !notAsked ? result.quality : null,
      project: opts.project || null,
      title: `${notAsked ? 'case_not_asked' : 'case_answer'} — ${opts.caseId || this.name}`,
      content: JSON.stringify({
        mode,
        followup_depth: depth,
        skipped: notAsked,
        // WHY it was not asked. `callGroq()`'s lesson applied one layer up: a
        // path that discards the reason converts every upstream cause into the
        // same symptom, and then only the response body could have told them
        // apart. Pacing, an exhausted Claude budget and the daily call cap need
        // completely different responses and looked identical in this table.
        not_asked_reason: notAsked ? (result?.reason || 'unstated') : null,
        kb_slug: opts.kbSlug || null,
      }),
    });

    return result;
  }

  /** Back-compat name during the transition — same behavior as askAssignedProject(). */
  async interactWithApp(query, mode = 'search', opts = {}) {
    return this.askAssignedProject(query, mode, opts);
  }

  /**
   * Applies the ORIGINAL design vision (Step 2, 2026-07-18 rebuild): mood
   * and irritation update PRIMARILY from the response-quality score, not a
   * secondary signal alongside others. Shared by both ask paths so Claude
   * and Gemini answers are judged by the same mood-effect rule.
   */
  async _applyQualityMood(quality) {
    let stateChange = null;
    if (quality > 0.7) {
      // 2026-07-19 (anger-deadlock fix, part 2): de-escalation is the
      // deterministic counterpart of the bad-answer branch below — a
      // genuinely good answer always releases one irritation stack, and
      // snaps an ANGRY agent back below its anger threshold. Without this,
      // nothing in the generic quality path ever DECREASED irritation
      // (only agent 1's class called resolveIrritation()), so an angry
      // agent could ask again post-fix but stayed flagged ANGRY until the
      // weekly reset — not the approved same-day recovery. HAPPY itself
      // stays chance-gated as before.
      await this.resolveIrritation();
      if (this.isAngry) {
        const angryThreshold = this.config.irritation_stack?.angry_threshold ?? IRRITATION_MAX;
        this.irritation = Math.min(this.irritation, Math.max(0, angryThreshold - 1));
        this.isAngry = false;
        await this.saveState();
      }
      if (Math.random() < (this.config.states?.HAPPY?.trigger_chance ?? 0.5)) {
        await this.triggerHappy();
        if (this.session) this.session.happy_events += 1;
        stateChange = 'HAPPY';
      }
    } else if (quality < 0.4 && Math.random() < (this.config.states?.IRRITATED?.trigger_chance ?? 0.3)) {
      await this.addIrritiation();
      if (this.session) this.session.irritation_events += 1;
      stateChange = 'IRRITATED';
    }
    return stateChange;
  }

  /**
   * Ask Notebook-X's Gemini backend for a specific kbSlug. Paced by
   * workers/gemini-pacer.js (shared free-tier quota, see that module's
   * header comment for why) — a paced-out call is skipped this tick, not
   * blocked-and-retried, and consumes no mood/gap effect.
   */
  async _askNotebookX(query, mode, kbSlug, caseId) {
    const moodBefore = this.mood;

    const pacing = await checkGeminiPacingSlot(this.env);
    if (!pacing.allowed) {
      await this.logInteraction({
        type: `qa_${mode}`,
        query,
        response_summary: '(skipped: Gemini pacing slot not yet available — see workers/gemini-pacer.js)',
        mood_before: moodBefore,
        mood_after: this.mood,
        irritation_change: 0,
        state_change: null,
        model_source: null,
        tool_used: 'notebook-x-paced-skip',
      });
      return { ok: false, skipped: true, reason: 'gemini_pacing', quality: undefined };
    }

    const nbResult = kbSlug ? await queryNotebookX({ kbSlug, question: query }) : null;
    const notebookAnswerFound = !!nbResult;
    const responseText = nbResult?.text || '';
    const quality = notebookAnswerFound ? Math.min(1, responseText.length / 600) : 0;

    if (this.session) this.session.cases_handled += 1;
    const stateChange = await this._applyQualityMood(quality);

    await this.logInteraction({
      type: `qa_${mode}`,
      query,
      response_summary: notebookAnswerFound ? responseText.slice(0, 500) : '(no answer — notebook does not cover this)',
      mood_before: moodBefore,
      mood_after: this.mood,
      irritation_change: stateChange === 'IRRITATED' ? 1 : 0,
      state_change: stateChange,
      model_source: null,
      tool_used: 'notebook-x',
    });

    const gap = detectCapabilityGap({ project: 'notebook-x', quality, notebookAnswerFound });
    await this.flagCapabilityGap({ project: 'notebook-x', gap, quality, query, responseText, kbSlug, caseId });

    // `source` ADDED 2026-08-10 — see the "cross-embodiment-comparison" fix
    // note on _askDataCenter() below for why. Gemini answered (or, when no
    // notebook covers the topic, Gemini still answered — `notebookAnswerFound`
    // is about COVERAGE, not about which provider was asked); there is no
    // fallback path here to record a substitution for.
    return { ok: notebookAnswerFound, quality, response: responseText, tool_used: 'notebook-x', source: 'gemini' };
  }

  /**
   * Ask Claude via data-center-api's /api/chat. Draws from the SAME shared
   * $5/month Claude budget as the chore-automation economy (config/
   * token-economy.json shared_claude_budget, workers/model-router.js
   * claude_budget_usage D1 table) — not a separate cap. If the shared
   * budget is exhausted for this month, the ask is skipped (no fallback
   * model substitutes for Claude here — asking Groq a Claude-bound question
   * would misattribute the answer to the wrong system this office is meant
   * to be stress-testing).
   */
  async _askDataCenter(query, mode, caseId) {
    const moodBefore = this.mood;

    const budget = await getClaudeBudgetStatus(this.env);
    if (budget.overBudget) {
      await this.logInteraction({
        type: `qa_${mode}`,
        query,
        response_summary: `(skipped: shared Claude budget exhausted — $${budget.spentUsd.toFixed(2)}/$${budget.capUsd}/mo)`,
        mood_before: moodBefore,
        mood_after: this.mood,
        irritation_change: 0,
        state_change: null,
        model_source: null,
        tool_used: 'claude-budget-skip',
      });
      return { ok: false, skipped: true, reason: 'claude_budget_exhausted', quality: undefined };
    }

    // 2026-07-19 (owner-approved rebalance): per-day CALL cap backstop under
    // the monthly dollar cap — counts every model_source='claude'
    // interactions row today, so follow-up asks count too. The generation
    // side already limits data-center-targeted QUESTIONS to the same number
    // (qa-engine.js); this catches follow-ups and any other overflow.
    if (CLAUDE_MAX_CALLS_PER_DAY > 0) {
      const callsToday = await getClaudeCallsToday(this.env);
      if (callsToday >= CLAUDE_MAX_CALLS_PER_DAY) {
        await this.logInteraction({
          type: `qa_${mode}`,
          query,
          response_summary: `(skipped: daily Claude call cap reached — ${callsToday}/${CLAUDE_MAX_CALLS_PER_DAY} today)`,
          mood_before: moodBefore,
          mood_after: this.mood,
          irritation_change: 0,
          state_change: null,
          model_source: null,
          tool_used: 'claude-daily-cap-skip',
        });
        return { ok: false, skipped: true, reason: 'claude_daily_call_cap', quality: undefined };
      }
    }

    const base = this.env.APP_API_BASE || 'https://data-center-api.avivnofar.workers.dev';
    const requestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.env.APP_ORIGIN || 'https://avivnofar.github.io',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        mode: mode === 'diagnose' ? 'diagnose' : 'search',
        language: 'en',
        db_context: '',
      }),
    };

    let ok = true;
    let responseText = '';
    try {
      // Cloudflare blocks a Worker from fetch()-ing another Worker's
      // *.workers.dev URL directly (error 1042) — use the APP_API service
      // binding when available, falling back to a plain fetch for local dev.
      const res = this.env.APP_API
        ? await this.env.APP_API.fetch(`${base}/api/chat`, requestInit)
        : await fetch(`${base}/api/chat`, requestInit);
      ok = res.ok;
      responseText = await res.text();
    } catch (err) {
      ok = false;
      responseText = String(err);
    }

    // Estimated cost recorded against the SHARED budget regardless of
    // outcome (a failed call still consumed request tokens on Claude's
    // side) — rough ~4-chars/token estimate, matching this repo's existing
    // token-estimation convention elsewhere.
    await recordClaudeSpend(this.env, {
      inputTokens: Math.ceil(query.length / 4),
      outputTokens: Math.ceil(responseText.length / 4),
    });

    const quality = await this.evaluateResponseQuality(query, responseText, ok);
    if (this.session) this.session.cases_handled += 1;
    const stateChange = await this._applyQualityMood(quality);

    await this.logInteraction({
      type: `qa_${mode}`,
      query,
      response_summary: responseText.slice(0, 500),
      mood_before: moodBefore,
      mood_after: this.mood,
      irritation_change: stateChange === 'IRRITATED' ? 1 : 0,
      state_change: stateChange,
      model_source: 'claude',
    });

    const gap = detectCapabilityGap({ project: 'data-center', ok, quality });
    await this.flagCapabilityGap({ project: 'data-center', gap, quality, query, responseText, caseId });

    // `source` ADDED 2026-08-10, found while building the Lead QA's
    // cross-embodiment comparison (plan 1.5 / capability-audit's
    // `cross-embodiment-comparison`).
    //
    // Neither this function nor _askNotebookX() ever set `.source` on their
    // return value. askAssignedProject()'s capture line reads
    // `result?.source || this.lastModelSource`, so with `.source` always
    // undefined it fell through to `lastModelSource` — a field only ever set
    // by queryGroqRouted()/queryGeminiDirect(), i.e. by a FOLLOW-UP-QUESTION
    // generation call, not by the scored answer itself. On agents that never
    // needed a follow-up this tick, `lastModelSource` was stale or null from
    // whatever this agent instance last did. Measured 2026-08-10: of 58
    // case_answer rows, 35 carried embodiment_model=NULL and the 23 non-null
    // ones were the provider that phrased a follow-up QUESTION, never the
    // provider that produced the scored ANSWER — so the comparison this field
    // exists for had never once compared the right thing.
    //
    // This function only reaches here via a real Claude call (the two skip
    // paths above return early with their own `skipped: true` result and
    // never fall through) — there is no fallback provider for data-center
    // (see this function's header: "no fallback model substitutes for Claude
    // here"), so the source is unconditionally 'claude'.
    //
    // Go-forward fix only, per A15: existing rows are not rewritten, and any
    // pre-2026-08-10 embodiment_model value is not reliable evidence of what
    // actually answered.
    return { ok, quality, response: responseText, source: 'claude' };
  }

  /**
   * Placeholder quality heuristic (0.0-1.0), UNCHANGED by the 2026-07-18
   * rebuild — explicitly reused rather than rebuilt, per that session's
   * Step 2 instruction ("reuse the EXISTING model-education quality-scoring
   * logic"). Phase 2: replace with a Gemini-as-judge call comparing the
   * response against the question.
   */
  async evaluateResponseQuality(_query, responseText, ok) {
    if (!ok || !responseText) return 0;
    return Math.min(1, responseText.length / 800);
  }

  /**
   * Step 3/4 (2026-07-18 rebuild): decides whether to file a Hebrew
   * capability-gap report, and if so, has the agent compose it in its own
   * voice via queryGeminiDirect() (Gemini composes the Hebrew — not the
   * rebuilt). HARD gaps (kind:'hard' — no notebook coverage, or the Claude
   * request itself failed) are always flagged, regardless of persona. SOFT
   * candidates (kind:'soft' — a real but weak answer) are only flagged if
   * this agent's own `escalation_threshold` (config/agents-config.json)
   * says it's worth it — QA/Lead QA run higher thresholds (flag more
   * borderline cases), Standard runs a lower one (flag only clear misses).
   * Report tone (CEO one-liner, Designer notes presentation/delivery) comes
   * from this.config.system_prompt_additions, already threaded through
   * the model call the same way every other in-character call in this class
   * gets it — no separate tone mechanism needed.
   */
  async flagCapabilityGap({ project, gap, quality, query, responseText, kbSlug, caseId }) {
    if (!gap || !gap.kind) return null;

    if (gap.kind === 'soft') {
      const threshold = typeof this.config.escalation_threshold === 'number' ? this.config.escalation_threshold : 0.2;
      if (quality >= threshold) return null;
    }
    // kind === 'hard' always proceeds.

    const whatHappened = gap.reason === 'no_notebook_coverage'
      ? `Notebook-X's ${kbSlug || 'assigned'} notebook returned no answer at all for this question.`
      : gap.reason === 'request_failed'
        ? `The request to data-center's Claude-powered AI Search failed outright.`
        : `The answer came back but scored ${quality.toFixed(2)}/1.0 — weak, not just imperfect.`;

    let hebrewText;
    try {
      // queryGeminiDirect: Hebrew composition goes to Gemini (2026-07-19
      // routing fix) — the Groq-routed path's Hebrew is not usably fluent.
      hebrewText = await this.queryGeminiDirect(
        `בעברית בלבד, 2-4 שורות קצרות, בגוף ראשון ובסגנון האופי שלך: תעד פער יכולת אמיתי שגילית עכשיו ` +
        `בכלי שאתה עובד איתו (${project === 'notebook-x' ? 'Notebook-X' : 'Claude ב-data-center'}). ` +
        `זו הערה פנימית של המשרד, לא דוח תקרית ללקוח — הטון הוא "הכלי שאני עובד איתו לא מספיק טוב פה, מסמן את זה לתיקון", ` +
        `לא תלונה כלפי חוץ. השאלה שנשאלה: "${query}". מה קרה: ${whatHappened} ` +
        `כלול: מה חסר/שגוי, איפה (הנושא/ה-notebook), ומה זה מלמד. קצר ולעניין, בלי כותרות.`
      );
    } catch (err) {
      hebrewText = `[שגיאה בניסוח הדוח: ${err.message}] ${whatHappened} שאלה: ${query}`;
    }

    return this.fileGapReport(project, caseId, hebrewText);
  }

  async logInteraction({ type, query, response_summary, mood_before, mood_after, irritation_change, state_change, model_source, tool_used }) {
    if (!this.env.DB || !this.session) return null;

    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO interactions
         (id, session_id, agent_id, timestamp, type, query, response_summary, mood_before, mood_after, irritation_change, state_change, model_source, tool_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      this.session.id,
      this.id,
      new Date().toISOString(),
      type,
      query || null,
      response_summary || null,
      mood_before ?? this.session.mood_start,
      mood_after ?? this.mood,
      irritation_change || 0,
      state_change || null,
      model_source || this.lastModelSource || null,
      tool_used || null
    ).run();

    return id;
  }

  /* ───────────────────── 6. Durable Object persistence ───────────────── */

  /** Serializes the full agent state to its Durable Object. */
  async saveState() {
    if (!this.doStub) return null;

    const snapshot = {
      id: this.id,
      key: this.key,
      name: this.name,
      mood: this.mood,
      irritation: this.irritation,
      isHappy: this.isHappy,
      isAngry: this.isAngry,
      isPanic: this.isPanic,
      panicLevel: this.panicLevel,
      permanentIrritationFlags: this.permanentIrritationFlags,
      configOverrides: this.configOverrides,
      session: this.session,
      updated_at: new Date().toISOString(),
    };

    await this.doStub.fetch('https://agent-state/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });

    return snapshot;
  }

  /** Restores state from this agent's Durable Object, if any was saved. */
  async loadState() {
    if (!this.doStub) return null;

    const res = await this.doStub.fetch('https://agent-state/state');
    const data = await res.json().catch(() => null);
    if (data) {
      this.mood = data.mood ?? this.mood;
      this.irritation = data.irritation ?? this.irritation;
      this.isHappy = data.isHappy ?? this.isHappy;
      this.isAngry = data.isAngry ?? this.isAngry;
      this.isPanic = data.isPanic ?? this.isPanic;
      this.panicLevel = data.panicLevel ?? this.panicLevel;
      this.permanentIrritationFlags = data.permanentIrritationFlags ?? this.permanentIrritationFlags;
      this.session = data.session ?? this.session;

      // Merge durable config overrides (set by meeting-engine.js decisions
      // or agent-runner.js's rolling model_usage_rate adjustments) over the
      // static agents-config.json entry for this session.
      this.configOverrides = data.configOverrides ?? this.configOverrides;
      if (Object.keys(this.configOverrides).length) {
        this.config = { ...this.config, ...this.configOverrides };
      }
    }
    return data;
  }
}
