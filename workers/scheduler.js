/**
 * Data Center — AI Agent Simulation — scheduler Worker.
 *
 * STATUS: not wired to anything — no other file imports this module, and
 * wrangler.toml's `main` points at agent-runner.js, which has its own
 * scheduled() handler. Confirmed dead/superseded before the 2026-07-18
 * Q&A-engine rebuild; left in place (not deleted — out of this session's
 * explicit scope) but its import updated so it doesn't reference the
 * deleted workers/case-generator.js.
 *
 * Drives the simulated time cycle via Cron Triggers (configure in this
 * Worker's wrangler.toml — see README.md):
 *   "0 *\/1 * * *"  -> runWorkDayCycle()   (every hour = 1 simulated work day)
 *   "0 0 * * *"     -> runWeeklyResetCycle() (every 24h = 1 simulated work week)
 *
 * Also exposes /run/day and /run/week for manual `workflow_dispatch`-style
 * testing without waiting for the cron.
 *
 * Status: DRAFT (Phase 1 foundation) — GitHub commit steps (weekly report,
 * trainee guides) are stubbed pending a server-side GITHUB_TOKEN binding.
 */

import simulationConfig from '../config/simulation-config.json';
import agentsConfig from '../config/agents-config.json';
import { generateAssignedDailyBatch } from './qa-engine.js';
import { instantiateAgent } from './agent-runner.js';

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 */1 * * *') {
      ctx.waitUntil(runWorkDayCycle(env));
    } else if (event.cron === '0 0 * * *') {
      ctx.waitUntil(runWeeklyResetCycle(env));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual /run/day and /run/week triggers can kick off Gemini API calls
    // and must not be left open to the public internet. Require the same
    // X-Admin-Token used by the agent-runner admin API (env.ADMIN_TOKEN,
    // a Worker secret — never shipped to the browser).
    if ((url.pathname === '/run/day' || url.pathname === '/run/week') && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    if (url.pathname === '/run/day' && request.method === 'POST') {
      const summary = await runWorkDayCycle(env);
      return Response.json({ ok: true, summary });
    }
    if (url.pathname === '/run/week' && request.method === 'POST') {
      const summary = await runWeeklyResetCycle(env);
      return Response.json({ ok: true, summary });
    }
    return new Response('Not found', { status: 404 });
  },
};

/**
 * HOURLY (WORK DAY) CYCLE:
 *  1. read phase + active_agents from simulation-config.json
 *  2. generate a case batch per active agent (30-50, x2 in inspection mode)
 *  3-5. run each active agent against its batch, logging interactions to D1
 *  6-9. handle TRAINEE_PANIC escalations synchronously
 *  10. write a daily summary row
 */
async function runWorkDayCycle(env) {
  const sim = simulationConfig.SIMULATION;
  const work = simulationConfig.WORK_DAY;

  // SIM_KV holds live overrides written via the Admin tab's Simulation
  // Controls panel (POST /api/simulation on agent-runner.js). Falls back
  // to the static simulation-config.json defaults if unset.
  const override = env.SIM_KV ? await env.SIM_KV.get('simulation-state', 'json') : null;
  if (override?.paused) {
    return { date: new Date().toISOString(), skipped: true, reason: 'simulation paused' };
  }

  const inspection = override?.inspection_mode ?? sim.inspection_mode;
  const multiplier = inspection ? work.inspection_mode_multiplier : 1;

  const summary = { date: new Date().toISOString(), inspection, agents: [] };

  for (const agentId of sim.active_agents) {
    const agent = instantiateAgent(agentId, env);
    await agent.loadState();

    if (agent.isAngry) {
      summary.agents.push({ agentId, skipped: true, reason: 'cooldown' });
      continue;
    }

    if (inspection) {
      // INSPECTION MODE: all agents use the app at maximum rate.
      agent.config = { ...agent.config, model_usage_rate: 1.0 };
    }

    const target = randomBetween(work.cases_per_day_min, work.cases_per_day_max);
    const count = Math.round(target * multiplier);

    const cases = generateAssignedDailyBatch(1, {
      maxTotalQuestions: count,
      weekNumber: isoWeekNumber(new Date()),
      year: new Date().getFullYear(),
    });

    await persistCases(env, cases, agentId);

    let handled = 0;
    let escalations = 0;

    for (const c of cases) {
      const outcome = await agent.handleCase(c, { archiveGuides: [] });
      handled += 1;

      if (outcome?.escalation?.type === 'TRAINEE_PANIC') {
        await handleTraineePanic(env, outcome.escalation);
        escalations += 1;
      }

      if (agent.isAngry) break; // ANGRY -> stop processing for the day, cooldown set in agent
    }

    summary.agents.push({
      agentId,
      target,
      handled,
      escalations,
      mood: agent.mood,
      irritation: agent.irritation,
      isAngry: agent.isAngry,
      isPanic: agent.isPanic,
    });
  }

  return summary;
}

/**
 * Joint session: the escalated agent also works the trainee's case.
 * If a guide was generated, commit it to data-center-archive/guides/
 * (Phase 2 — requires a server-side GITHUB_TOKEN secret; never exposed
 * to the frontend, per CLAUDE.md credential rules).
 */
async function handleTraineePanic(env, event) {
  const helper = instantiateAgent(event.selectedAgent, env);
  await helper.loadState();
  await helper.handleCase(event.caseData, { archiveGuides: [] });

  if (event.generatedGuide) {
    await commitGuideToArchive(env, event.generatedGuide);
  }
}

/**
 * Phase 2 stub: commits `guide.path`/`guide.content` to
 * data-center-archive/guides/ via the GitHub Contents API using
 * env.GITHUB_TOKEN. No-ops if the secret isn't configured yet.
 */
async function commitGuideToArchive(env, guide) {
  if (!env.GITHUB_TOKEN) return { committed: false, reason: 'GITHUB_TOKEN not configured' };

  const url = `https://api.github.com/repos/avivnofar/data-center-archive/contents/${guide.path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      message: `docs: auto-generated guide for ${guide.path} [skip ci]`,
      content: btoa(unescape(encodeURIComponent(guide.content))),
    }),
  });
  return { committed: res.ok, status: res.status };
}

/**
 * WEEKLY RESET CYCLE:
 *  1-2. weekly report + partial mood reset for every agent
 *  3. preserve permanent irritation flags
 *  4. Agent 2 bonus-day check
 *  5-7. aggregate report (Phase 2: commit to GitHub)
 *  8. (case counters reset implicitly — next cycle generates a fresh batch)
 */
async function runWeeklyResetCycle(env) {
  const summary = { week_start: new Date().toISOString(), agents: [] };

  for (const config of agentsConfig.agents) {
    const agent = instantiateAgent(config.id, env);
    await agent.loadState();

    const moodBefore = agent.mood;
    const weeklyCases = await getWeeklyCasesHandled(env, config.id);

    await agent.fileWeeklyReport(
      `Weekly report for ${agent.name}: ${weeklyCases} cases handled, ` +
        `mood ${moodBefore} -> regressing to mean, irritation ${agent.irritation}/5.`
    );

    if (typeof agent.checkWeeklyBonus === 'function') {
      const target = simulationConfig.WORK_DAY.cases_per_day_min * 5; // 5-day work week
      await agent.checkWeeklyBonus(weeklyCases, target);
    }

    await agent.resetWeeklyState();

    summary.agents.push({ agentId: config.id, weeklyCases, moodBefore, moodAfter: agent.mood });
  }

  await writeWeeklyAnalytics(env, summary);
  return summary;
}

async function persistCases(env, cases, assignedTo) {
  if (!env.DB || cases.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO cases (id, title, platform, difficulty, category, description, assigned_to, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
  );
  await env.DB.batch(cases.map((c) => stmt.bind(c.id, c.title, c.platform, c.difficulty, c.category, c.description, assignedTo)));
}

async function getWeeklyCasesHandled(env, agentId) {
  if (!env.DB) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cases_handled), 0) AS total FROM agent_sessions WHERE agent_id = ? AND started_at >= ?`
  ).bind(agentId, since).first();
  return row?.total || 0;
}

async function writeWeeklyAnalytics(env, summary) {
  if (!env.DB) return;
  const stmt = env.DB.prepare(
    `INSERT INTO weekly_analytics (id, week_start, agent_id, total_cases, cases_solved, avg_mood)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(
    summary.agents.map((a) =>
      stmt.bind(crypto.randomUUID(), summary.week_start, a.agentId, a.weeklyCases, a.weeklyCases, a.moodAfter)
    )
  );
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}
