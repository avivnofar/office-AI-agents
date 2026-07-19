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
   * Full interaction flow per AGENTS.md §Agent 1 (updated 2026-07-18 —
   * every assigned question is now always asked, see the note in
   * handleCase() below):
   *  1. receive question
   *  2. formulate query, askAssignedProject()
   *  3. evaluate quality (handled inside askAssignedProject via evaluateResponseQuality)
   *  4/5. HAPPY / IRRITATED transitions (handled inside askAssignedProject)
   *  6. if irritated: critical feedback + demand correction + rating
   *  7. CALM only when solved AND docs/PDF exist
   *  8. if happy: 60% extend + drift to related topic + bookmark suggestion
   */
  async handleCase(caseData) {
    await this.startSession(caseData, caseData.difficulty === 'advanced' ? 'diagnose' : 'search');

    // 2026-07-18 Q&A-engine rebuild: every assigned question is now always
    // asked (Step 3 — all 11 personas share the same core action). The old
    // shouldUseApp() probability gate belonged to the retired case model,
    // where a "case" could be solved without consulting the app at all —
    // that alternative doesn't exist for a question whose entire point IS
    // asking one of the two production AI systems.
    const mode = caseData.difficulty === 'advanced' ? 'diagnose' : 'search';
    const query = await this.formulateQuery(caseData);
    let result = await this.askAssignedProject(query, mode, { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });

    if (this.irritation > 0) {
      await this.demandCorrection(caseData, result);
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

  async formulateQuery(caseData) {
    return `Case: ${caseData.title} (${caseData.platform}/${caseData.category}, ${caseData.difficulty}). ${caseData.description}`;
  }

  /** Step 7: critical feedback, demand a corrected response, rate it 1-10. */
  async demandCorrection(caseData, result) {
    const critique = await this.queryGroqRouted(
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
    const followUp = await this.queryGroqRouted(
      `Given the case "${caseData.title}" (${caseData.category}), what's one related topic you'd want to explore next? Reply with a short search query only.`
    );
    if (!followUp) return null;
    return this.askAssignedProject(followUp, 'search', { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });
  }
}
