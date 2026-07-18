/**
 * Data Center — AI Agent Simulation — Agent 4: The Trainee.
 *
 * Junior IT support. Asks multiple questions per case, prefers
 * step-by-step guides/PDFs. Tracks panicLevel (0-100); at >= 80 runs the
 * TRAINEE_PANIC escalation protocol (joint session with another agent +
 * the app, generating/committing a guide if none exists).
 *
 * Status: DRAFT (Phase 1).
 */

import { AgentBase } from './agent-base.js';

export class TraineeAgent extends AgentBase {
  /**
   * @param {object} caseData
   * @param {object} [opts]
   * @param {Array<{id:string, platform?:string, category?:string}>} [opts.archiveGuides]
   *   Index of guides already present in data-center-archive/guides/, supplied
   *   by the scheduler so this agent can run guide_detection without making
   *   its own GitHub calls.
   */
  async handleCase(caseData, { archiveGuides = [] } = {}) {
    await this.startSession(caseData, 'diagnose');

    const guide = this.findGuide(caseData, archiveGuides);
    if (guide) {
      await this.triggerHappy();
    }

    // 2026-07-18 Q&A-engine rebuild: every assigned question is always
    // asked now (Step 3 — same core action for all 11 personas). Fits The
    // Trainee especially well — "asks multiple clarifying questions" is
    // her defining trait, not a probabilistic behavior.
    const questions = await this.formulateQuestions(caseData);
    const result = await this.askAssignedProject(questions, 'diagnose', { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });

    await this.updatePanic(guide, result);

    let escalation = null;
    if (this.isPanic) {
      escalation = await this.runEscalationProtocol(caseData, guide);
      await this.resolvePanic();
    }

    await this.endSession();
    return { result, guide, escalation };
  }

  /** GUIDE DETECTION: check the archive index for a relevant guide. */
  findGuide(caseData, archiveGuides) {
    return archiveGuides.find(
      (g) => g.id === caseData.id || g.category === caseData.category || g.platform === caseData.platform
    ) || null;
  }

  async formulateQuestions(caseData) {
    return this.queryGemini(
      `You're a trainee facing this case: "${caseData.title}" — ${caseData.description}. ` +
        `Ask 2-3 clarifying questions and request a detailed step-by-step guide.`
    );
  }

  /** No guide -> higher panic accumulation. Guide found / good answer / HAPPY -> panic decreases. */
  async updatePanic(guide, result) {
    if (this.isHappy) {
      return this.addPanic(-15);
    }
    if (!guide && (!result || result.quality < 0.5)) {
      return this.addPanic(25);
    }
    return this.addPanic(-5);
  }

  /**
   * ESCALATION PROTOCOL (panicLevel >= 80):
   *  1. selectAgent (QA 40% + Perfectionist 30% -> agent 1 in this roster, random 30%)
   *  2. fire 'TRAINEE_PANIC' { traineeId, selectedAgent, caseData } for the scheduler
   *  3. scheduler runs a joint session: selected agent + this trainee + the app
   *  4/5. if no guide exists for this case type, generate one via Gemini
   *  6. (scheduler) commits the guide to data-center-archive/guides/
   *  7. reset panic, mood improves
   */
  async runEscalationProtocol(caseData, existingGuide) {
    const selectedAgent = this.selectEscalationAgent();

    const event = {
      type: 'TRAINEE_PANIC',
      traineeId: this.id,
      selectedAgent,
      caseData,
      timestamp: new Date().toISOString(),
    };

    let generatedGuide = null;
    if (!existingGuide) {
      generatedGuide = await this.generateGuide(caseData);
      event.generatedGuide = generatedGuide;
    }

    await this.fileIncidentReport(
      `TRAINEE_PANIC: case ${caseData.id} ("${caseData.title}") escalated to agent ${selectedAgent}.` +
        (generatedGuide ? ` New guide generated: ${generatedGuide.path}` : ' Existing guide reused.')
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

  /**
   * Generates a bilingual step-by-step guide via Gemini. The scheduler is
   * responsible for committing the returned markdown to
   * data-center-archive/guides/<path> via the GitHub API (server-side
   * token only — see CLAUDE.md credential rules).
   */
  async generateGuide(caseData) {
    const markdown = await this.queryGemini(
      `Write a bilingual (Hebrew + English) step-by-step troubleshooting guide in Markdown for: ` +
        `"${caseData.title}" (${caseData.platform}/${caseData.category}, ${caseData.difficulty}). ` +
        `Include numbered steps with exact commands in English code blocks.`
    );
    return {
      path: `guides/${caseData.platform}/${caseData.id}.md`,
      content: markdown,
    };
  }
}
