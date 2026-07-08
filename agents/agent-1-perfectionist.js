/**
 * Data Center — AI Agent Simulation — Agent 1: The Perfectionist.
 *
 * Quality Assurance Lead. Veteran IT professional, thorough and critical.
 * Uses the app for syntax checks and complex (advanced) cases. Never gets
 * angry — instead "educates the algorithm" when irritated, and only
 * settles into CALM once a case is solved AND documentation exists.
 *
 * Status: DRAFT (Phase 1).
 */

import { AgentBase } from './agent-base.js';

export class PerfectionistAgent extends AgentBase {
  /**
   * Full interaction flow per AGENTS.md §Agent 1:
   *  1. receive case
   *  2. evaluate difficulty -> use app if complex / 30% baseline otherwise
   *  3. formulate query, interactWithApp()
   *  4. evaluate quality (handled inside interactWithApp via evaluateResponseQuality)
   *  5/6. HAPPY / IRRITATED transitions (handled inside interactWithApp)
   *  7. if irritated: critical feedback + demand correction + rating
   *  8. CALM only when solved AND docs/PDF exist
   *  9. if happy: 60% extend + drift to related topic + bookmark suggestion
   */
  async handleCase(caseData) {
    await this.startSession(caseData, caseData.difficulty === 'advanced' ? 'diagnose' : 'search');

    let result = null;

    if (this.shouldUseApp(caseData)) {
      const mode = caseData.difficulty === 'advanced' ? 'diagnose' : 'search';
      const query = await this.formulateQuery(caseData);
      result = await this.interactWithApp(query, mode, { platform: caseData.platform });

      if (this.irritation > 0) {
        await this.demandCorrection(caseData, result);
      }
    }

    if (this.caseSolvedWithDocs(caseData, result)) {
      await this.resolveIrritation();
    }

    if (this.isHappy) {
      await this.fileSuggestion(
        `Bookmark recommendation from ${this.name} for case ${caseData.id} ("${caseData.title}"): ${(result?.response || '').slice(0, 200)}`
      );
      if (Math.random() < (this.config.extended_session_chance ?? 0.60)) {
        await this.extendSession();
        await this.driftToRelatedTopic(caseData);
      }
    }

    await this.endSession();
    return result;
  }

  /** 30% baseline (higher while HAPPY); advanced-difficulty cases always use the app. */
  shouldUseApp(caseData) {
    if (caseData.difficulty === 'advanced') return true;
    const baseRate = this.config.model_usage_rate ?? 0.30;
    const rate = this.isHappy ? Math.min(1, baseRate + 0.20) : baseRate;
    return Math.random() < rate;
  }

  async formulateQuery(caseData) {
    return `Case: ${caseData.title} (${caseData.platform}/${caseData.category}, ${caseData.difficulty}). ${caseData.description}`;
  }

  /** Step 7: critical feedback, demand a corrected response, rate it 1-10. */
  async demandCorrection(caseData, result) {
    const critique = await this.queryGemini(
      `As The Perfectionist, critique this response to case "${caseData.title}":\n"""${result?.response || ''}"""\n` +
        `Lecture the assistant on its shortcomings, demand a corrected response, and rate the original 1-10.`
    );
    await this.fileIncidentReport(`Perfectionist critique for case ${caseData.id}:\n${critique}`);
    return critique;
  }

  /** CALM exit condition: case solved AND docs/PDF available. */
  caseSolvedWithDocs(caseData, result) {
    if (!result || !result.ok) return false;
    return /https?:\/\//.test(result.response || '') || /\.pdf/i.test(result.response || '');
  }

  /** Step 9: drift to a related topic and issue a follow-up query. */
  async driftToRelatedTopic(caseData) {
    const followUp = await this.queryGemini(
      `Given the case "${caseData.title}" (${caseData.category}), what's one related topic you'd want to explore next? Reply with a short search query only.`
    );
    if (!followUp) return null;
    return this.interactWithApp(followUp, 'search', { platform: caseData.platform });
  }
}
