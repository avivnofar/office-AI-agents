/**
 * Data Center — AI Agent Simulation — Phase 2 stub agent template.
 *
 * Used by agents 5-11 until each agent's full behavioral spec is
 * finalized (see AGENTS.md). Provides the minimum viable loop:
 * start a session, optionally make one low-rate app query, end the
 * session. No custom mood/irritation/escalation logic beyond AgentBase.
 *
 * Status: STUB — agents-config.json marks each of 5-11 with
 * "status": "stub" and "placeholder_behavior" pointing here.
 */

import { AgentBase } from './agent-base.js';

const STUB_DEFAULT_USAGE_RATE = 0.10;

export class StubAgent extends AgentBase {
  async handleCase(caseData) {
    await this.startSession(caseData, 'search');

    let result = null;
    if (Math.random() < (this.config.model_usage_rate ?? STUB_DEFAULT_USAGE_RATE)) {
      const query = `${caseData.title}. ${caseData.description}`;
      result = await this.interactWithApp(query, 'search', { platform: caseData.platform });
    }

    await this.endSession();
    return result;
  }
}
