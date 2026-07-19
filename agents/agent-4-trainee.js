/**
 * Data Center — AI Agent Simulation — Agent 4: The Trainee.
 *
 * Junior IT support. Asks multiple questions per case, prefers
 * step-by-step guides/PDFs. Tracks panicLevel (0-100); at >= 80 runs the
 * TRAINEE_PANIC escalation protocol (joint session with another agent +
 * the app).
 *
 * Status: DRAFT (Phase 1).
 */

import { AgentBase } from './agent-base.js';

export class TraineeAgent extends AgentBase {
  async handleCase(caseData) {
    await this.startSession(caseData, 'diagnose');

    // 2026-07-18 Q&A-engine rebuild: every assigned question is always
    // asked now (Step 3 — same core action for all 11 personas). Fits The
    // Trainee especially well — "asks multiple clarifying questions" is
    // her defining trait, not a probabilistic behavior.
    const questions = await this.formulateQuestions(caseData);
    const result = await this.askAssignedProject(questions, 'diagnose', { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });

    await this.updatePanic(result);

    let escalation = null;
    if (this.isPanic) {
      escalation = await this.runEscalationProtocol(caseData);
      await this.resolvePanic();
    }

    await this.endSession();
    return { result, escalation };
  }

  async formulateQuestions(caseData) {
    return this.queryGroqRouted(
      `You're a trainee facing this case: "${caseData.title}" — ${caseData.description}. ` +
        `Ask 2-3 clarifying questions and request a detailed step-by-step guide.`
    );
  }

  /** Good answer / HAPPY -> panic decreases. Weak/no answer -> panic accumulates. */
  async updatePanic(result) {
    if (this.isHappy) {
      return this.addPanic(-15);
    }
    if (!result || result.quality < 0.5) {
      return this.addPanic(25);
    }
    return this.addPanic(-5);
  }

  /**
   * ESCALATION PROTOCOL (panicLevel >= 80):
   *  1. selectAgent (QA 40% + Perfectionist 30% -> agent 1 in this roster, random 30%)
   *  2. fire 'TRAINEE_PANIC' { traineeId, selectedAgent, caseData } for the scheduler
   *  3. scheduler runs a joint session: selected agent + this trainee + the app
   *  4. reset panic, mood improves
   */
  async runEscalationProtocol(caseData) {
    const selectedAgent = this.selectEscalationAgent();

    const event = {
      type: 'TRAINEE_PANIC',
      traineeId: this.id,
      selectedAgent,
      caseData,
      timestamp: new Date().toISOString(),
    };

    await this.fileIncidentReport(
      `TRAINEE_PANIC: case ${caseData.id} ("${caseData.title}") escalated to agent ${selectedAgent}.`
    );

    await this.adjustMood(15);
    return event;
  }

  /**
   * QA (40%) and "Perfectionist" (30%) both map to Agent 1 ("The
   * Perfectionist", QA Lead) in this roster, so 70% combined routes to
   * agent 1; the remaining 30% picks a random other active/stub agent.
   */
  selectEscalationAgent() {
    if (Math.random() < 0.70) return 1;
    const pool = [2, 3, 5, 6, 7, 8, 9, 10, 11];
    return pool[Math.floor(Math.random() * pool.length)];
  }
}
