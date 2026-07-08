/**
 * Data Center — AI Agent Simulation — Agent 3: The Standard Agent.
 *
 * Balanced IT generalist. App usage rate scales directly with mood
 * (mood=0 -> never uses app, mood=100 -> always uses app), recalculated
 * every session. Files a balanced status report after every session where
 * the UI worked correctly. A critical error is a 100% irritation trigger.
 *
 * Status: DRAFT (Phase 1).
 */

import { AgentBase } from './agent-base.js';

export class StandardAgent extends AgentBase {
  async handleCase(caseData) {
    await this.startSession(caseData, 'search');

    // Recalculate model_usage_rate = mood / 100 at the start of the session.
    const usageRate = this.mood / 100;
    let result = null;

    if (Math.random() < usageRate) {
      const query = await this.formulateQuery(caseData);
      result = await this.interactWithApp(query, 'search', { platform: caseData.platform });

      if (!result.ok) {
        // Critical error detected -> 100% irritation trigger.
        await this.addIrritiation();
        if (this.session) this.session.irritation_events += 1;
      }
    }

    const uiOk = !result || result.ok;
    if (uiOk) {
      await this.fileSessionStatusReport(caseData, result);
    }

    await this.endSession();
    return result;
  }

  async formulateQuery(caseData) {
    return `${caseData.title} (${caseData.platform}/${caseData.category}). ${caseData.description}`;
  }

  /**
   * STATUS REPORT GENERATION (100% chance after a session where the UI
   * worked correctly): ui_score, resource_access_score, response_quality_score,
   * user_friendliness_score, overall happiness, specific observations.
   */
  async fileSessionStatusReport(caseData, result) {
    const reportText = await this.queryGemini(
      `Write a balanced, professional status report for case "${caseData.title}". Cover, each on its own line:\n` +
        `- ui_score (1-10)\n- resource_access_score (1-10)\n- response_quality_score (1-10)\n` +
        `- user_friendliness_score (1-10)\n- overall_happiness_level\n- specific_observations\n` +
        `App response${result ? '' : ' (app was not used this session)'}: """${result?.response || ''}"""`
    );
    return this.fileStatusReport(reportText);
  }
}
