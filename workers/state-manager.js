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

import { runCaseBatchInDO, CASE_DO_PATH } from './case-batch-do.js';

/**
 * Issues cheap real subrequests until the runtime refuses, and reports how
 * many landed. Shared by the Worker side and the Durable Object side so the
 * two ceilings are measured by the SAME loop against the SAME binding — a
 * comparison between two different loops would measure the loops.
 *
 * Never throws: the refusal is the result, not an error.
 */
export async function probeSubrequestCeiling(env, max = 400, kind = 'd1') {
  const ops = {
    d1: env?.DB ? () => env.DB.prepare('SELECT 1 AS ok').first() : null,
    kv: env?.SIM_KV ? () => env.SIM_KV.get('simulation-state') : null,
    // A Durable Object stub fetch, made FROM wherever this runs. This is the
    // one that matters: a 30-case tick made 87 of them.
    // An external fetch, which is what Cloudflare's "subrequests" limit is
    // actually about. Target is Cloudflare's own trace endpoint: tiny, cached
    // at the edge, no auth, and not somebody else's service to hammer.
    fetch: () => fetch('https://cloudflare.com/cdn-cgi/trace'),
    do: env?.AGENT_STATE
      ? (() => {
        const stub = env.AGENT_STATE.get(env.AGENT_STATE.idFromName('subrequest-probe'));
        return () => stub.fetch('https://agent-state/state');
      })()
      : null,
  };
  const op = ops[kind];
  if (!op) return { kind, completed: 0, stopped: `no_binding_for_${kind}`, max };
  let completed = 0;
  try {
    for (let i = 0; i < max; i++) {
      await op();
      completed += 1;
    }
    return { kind, completed, stopped: 'reached_max_without_refusal', max };
  } catch (err) {
    return { kind, completed, stopped: String(err?.message || err).slice(0, 160), max };
  }
}

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

    /**
     * ── HOW MANY SUBREQUESTS DOES A DURABLE OBJECT ACTUALLY GET? ───────────
     *
     * OB-074's premise was that a Durable Object gets "roughly 150"
     * subrequests against a Worker's 50. That figure came from documentation,
     * and this project has been burned three times by trusting a documented
     * platform fact (two retired model IDs and a provider that returned 410
     * while its own body called the outage temporary). Cloudflare's own
     * limits page does not state a Durable-Object-specific subrequest number
     * at all — checked 2026-08-16.
     *
     * So it is measured instead of quoted. This route issues the cheapest
     * possible real subrequest (`SELECT 1` against D1) in a loop until the
     * runtime refuses, and reports how many landed. The Worker side runs the
     * identical loop against the identical binding, so the two numbers are
     * comparable and the difference is the headroom — whatever it turns out
     * to be.
     *
     * Read-only and bounded: `SELECT 1` writes nothing, and `max` is capped
     * so a wrong answer cannot spin. Admin-gated at the Worker end, the same
     * posture as `routing_status` and `image_catalog`.
     */
    if (request.method === 'POST' && url.pathname === '/subrequest-probe') {
      let max = 400;
      let kind = 'd1';
      try {
        const b = await request.json();
        if (Number.isFinite(b?.max)) max = Math.min(2000, Math.max(1, b.max));
        if (typeof b?.kind === 'string') kind = b.kind;
      } catch { /* defaults */ }
      // A Durable Object fetching its own stub would block on its own
      // single-threaded lock. Refused explicitly rather than left to hang.
      if (kind === 'do') {
        return Response.json({ where: 'durable_object', kind, completed: 0, stopped: 'refused: a DO cannot call its own stub' });
      }
      const r = await probeSubrequestCeiling(this.env, max, kind);
      return Response.json({ where: 'durable_object', ...r });
    }

    /**
     * The case engine, running inside the Durable Object (OB-074).
     *
     * UNREACHABLE IN PRODUCTION UNTIL SOMEONE FLIPS A SWITCH. The only caller
     * is `runCaseBatchBlock()` in agent-runner.js, and it is gated on
     * `case_do_enabled` in SIM_KV, which is absent — so this route exists, is
     * reachable, and is called by nothing. See case-batch-do.js's header for
     * the measured headroom this buys and for the honest note that the
     * office does not currently need it.
     */
    if (request.method === 'POST' && url.pathname === CASE_DO_PATH) {
      let payload;
      try { payload = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      const out = await runCaseBatchInDO(this.env, payload);
      return Response.json(out);
    }

    return new Response('Not found', { status: 404 });
  }
}
