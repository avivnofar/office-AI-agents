/**
 * Data Center — AI Agent Simulation — Agent 2: The Productive.
 *
 * Senior IT Operator. Values speed above everything. Stacks irritation on
 * bad/slow answers; 3 stacked irritations -> ANGRY (files an incident
 * report, ends all sessions, cools down). 30% of work days extend into
 * overtime; sustained +30% productivity schedules a bonus optimization day.
 *
 * Status: DRAFT (Phase 1).
 */

import { AgentBase } from './agent-base.js';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 simulated "hour" (= 1 work day, see TIME_SCALE)

export class ProductiveAgent extends AgentBase {
  constructor(config, env, doStub) {
    super(config, env, doStub);
    this.cooldownUntil = 0;
  }

  async handleCase(caseData) {
    if (this.isAngry) {
      if (Date.now() < this.cooldownUntil) return null; // still cooling down
      // cooldown elapsed: come back to NEUTRAL
      this.isAngry = false;
      this.irritation = 0;
      await this.saveState();
    }

    await this.startSession(caseData, 'search');

    // 2026-07-18 Q&A-engine rebuild: every assigned question is always
    // asked now (Step 3 — same core action for all 11 personas).
    const query = await this.formulateQuery(caseData);
    const result = await this.askAssignedProject(query, 'search', { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });

    if (typeof result.quality === 'number' && result.quality < 0.4 && Math.random() < (this.config.irritation_stack?.bad_answer_chance ?? 0.45)) {
      await this.addIrritiation();
      if (this.session) this.session.irritation_events += 1;
      await this.foundOutsidePattern(caseData, result);
    }

    if (this.isAngry) {
      // triggerAngry() already called endSession() via AgentBase
      this.cooldownUntil = Date.now() + (this.config.cooldown_ms || DEFAULT_COOLDOWN_MS);
      return result;
    }

    if (this.isHappy) {
      await this.briefClaude(caseData, result);
    }

    await this.maybeOvertime();
    await this.endSession();
    return result;
  }

  async formulateQuery(caseData) {
    return `${caseData.title}. Give me the short, fast, accurate fix. ${caseData.description}`;
  }

  /**
   * Permanent irritation flag (e.g. "slow_ui", "sloppy_design") — does
   * NOT clear on resetWeeklyState() until the underlying issue is fixed.
   */
  async flagPermanentIssue(flagName, content) {
    if (this.permanentIrritationFlags.includes(flagName)) return;
    this.permanentIrritationFlags.push(flagName);
    await this.addIrritiation();
    await this.fileIncidentReport(`Permanent issue flagged by ${this.name}: ${flagName}\n${content}`);
    await this.saveState();
  }

  /**
   * FOUND-OUTSIDE PATTERN: when irritated and the agent "finds" the
   * answer via an external-search simulation, generate a mock report
   * showing how easy the external answer was and file it as a suggestion.
   */
  async foundOutsidePattern(caseData, result) {
    const mockReport = await this.queryGemini(
      `You found the answer to "${caseData.title}" via an external search in seconds. The Data Center app gave: """${result?.response || ''}""". ` +
        `Write a short mock report contrasting how easy the external answer was vs. the app's response.`
    );
    return this.fileSuggestion(mockReport);
  }

  /** HAPPY effect: detailed briefing, resource pinpointing, optimization + PDF suggestions. */
  async briefClaude(caseData, result) {
    const briefing = await this.queryGemini(
      `Give Claude (the Data Center assistant) a detailed briefing on case "${caseData.title}". ` +
        `Pinpoint what was useful in this response: """${result?.response || ''}""". ` +
        `Suggest one concrete optimization and one PDF documentation idea.`
    );
    return this.fileSuggestion(briefing);
  }

  /** 30% of work days extend the session and handle extra cases. */
  async maybeOvertime() {
    if (Math.random() < (this.config.work_routine?.overtime === '30%_of_days' ? 0.30 : 0)) {
      await this.extendSession();
      return true;
    }
    return false;
  }

  /**
   * Called by the scheduler at week-end. If weekly productivity is +30%
   * above target, schedule a bonus day (one extended optimization session).
   */
  async checkWeeklyBonus(weeklyCasesHandled, weeklyTarget) {
    if (weeklyCasesHandled >= weeklyTarget * 1.30) {
      await this.fileSuggestion(
        `Bonus day scheduled for ${this.name}: weekly productivity ${weeklyCasesHandled} cases is +30% above target ${weeklyTarget}.`
      );
      return true;
    }
    return false;
  }
}
