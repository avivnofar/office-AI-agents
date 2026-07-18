/**
 * Data Center — AI Agent Simulation — generic driver for agents 5-9 and 11
 * (Agent 10/The Architect is dormant, excluded from this flow entirely —
 * see workers/qa-engine.js getActiveQaAgents()). Each of these agents has a
 * full character/behavioral spec in config/agents-config.json but shares
 * this same core loop: start a session, ask its assigned question,
 * end the session. Per Step 3 of the 2026-07-18 Q&A-engine rebuild — "all
 * 11 personas do the same core action (ask, evaluate, maybe flag)" — every
 * assigned question is always asked; there is no probabilistic
 * "whether to ask" gate anymore (that belonged to the retired Netvill-CRM
 * case model, where a case could be solved without consulting the app).
 */

import { AgentBase } from './agent-base.js';

export class StubAgent extends AgentBase {
  async handleCase(caseData) {
    await this.startSession(caseData, 'search');

    const query = `${caseData.title}. ${caseData.description}`;
    const result = await this.askAssignedProject(query, 'search', { project: caseData.project, kbSlug: caseData.kb_slug, caseId: caseData.id });

    await this.endSession();
    return result;
  }
}
