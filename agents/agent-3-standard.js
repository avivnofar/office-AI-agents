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

    // 2026-07-18 Q&A-engine rebuild: every assigned question is always
    // asked now (Step 3 — same core action for all 11 personas). mood/100
    // no longer gates WHETHER to ask (that alternative doesn't exist for a
    // question), but stays this agent's defining trait elsewhere (HAPPY
    // threshold at mood > 50, balanced status-report tone).
    const query = await this.formulateQuery(caseData);
    const result = await this.askAssignedProject(query, 'search', { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });

    if (!result.ok) {
      // Critical error detected -> 100% irritation trigger.
      await this.addIrritiation();
      if (this.session) this.session.irritation_events += 1;
    }

    if (result.ok) {
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
    const reportText = await this.queryGroqRouted(
      `Write a balanced, professional status report for case "${caseData.title}". Cover, each on its own line:\n` +
        `- ui_score (1-10)\n- resource_access_score (1-10)\n- response_quality_score (1-10)\n` +
        `- user_friendliness_score (1-10)\n- overall_happiness_level\n- specific_observations\n` +
        `App response${result ? '' : ' (app was not used this session)'}: """${result?.response || ''}"""`
    );
    return this.fileStatusReport(reportText);
  }
}
