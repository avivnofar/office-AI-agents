/**
 * Data Center — AI Agent Simulation — Durable Objects state manager.
 *
 * One Durable Object instance per agent (binding name: AGENT_STATE,
 * id derived from agents-config.json `durable_object_id`). AgentBase
 * reads/writes its full state snapshot here via fetch().
 *
 * Routes:
 *   GET  /state  -> returns the last saved snapshot (or null)
 *   PUT  /state  -> replaces the snapshot (body = JSON state object)
 *   POST /reset  -> clears all stored state for this agent
 *
 * Status: DRAFT (Phase 1 foundation).
 */

export class AgentStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/state') {
      const data = (await this.state.storage.get('agentState')) || null;
      return Response.json(data);
    }

    if (request.method === 'PUT' && url.pathname === '/state') {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      await this.state.storage.put('agentState', body);
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
