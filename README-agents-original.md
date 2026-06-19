# Data Center — AI Agent Simulation

> **Status: pre-launch.** Agents 1-4 ("The Perfectionist", "The Productive",
> "The Standard Agent", "The Trainee") have full behavioral state machines.
> Agents 5-11 (admin tier) have full character specs in
> `config/agents-config.json` (v0.2.0, `status: "specified"`) — personality,
> purpose, case focus, and `states` triggers — but currently run via the
> generic `agent-stub.js` (no dedicated state-machine class yet). See
> `AGENTS.md` for the full per-agent reference and `STRATEGY.md` /
> `CLAUDE.md`'s "Launch Decisions" for the launch plan.

---

## Overview

Each simulated agent is a small state machine (mood, irritation, optional
panic) that:

1. Receives IT support **cases**, generated and assigned by `crm-engine.js`
   (or pre-generated via `case-generator.js` /
   `.github/scripts/generate-agent-cases.mjs`).
2. Decides whether to solve a case independently or query the live app
   (`interactWithApp()` → `data-center-api` Worker's `/api/chat`).
3. Asks **Gemini 2.5 Flash-Lite** to role-play the decision/response
   in-character, using its `character`/`states`/`system_prompt_additions`
   from `config/agents-config.json`.
4. Updates mood/irritation/panic based on a (placeholder) response-quality
   heuristic, and may transition to `HAPPY`, `IRRITATED`, `ANGRY`, or (Agent 4
   only) `PANIC`.
5. Files **reports** (incident/status/weekly) and **suggestions** to D1, and
   participates in `meeting-engine.js` meetings (daily standup, audits, PIP
   sessions, quarterly/yearly reviews per `year-tracker.json` milestones).
6. Persists its full state to a per-agent **Durable Object** between runs.

A single Cloudflare Worker, `agent-runner.js` (deployed as
`data-center-agents`), drives all of this: its own `scheduled()` handler runs
the cron-driven "work day" / "work week" cycles (once cron triggers are added
— see "Setup" below), and it exposes the admin HTTP API used by the in-app
🔐 Admin tab and the standalone `dashboard/admin-panel.html`.

---

## Architecture

```
agents/
├── config/
│   ├── simulation-config.json   # time scale, work day quotas, Gemini settings, active agents, permission tiers
│   ├── agents-config.json       # per-agent personality, state machine, quotas (v0.2.0 — all 11 agents specified)
│   ├── relationships.json       # meeting attendee defaults, rivalries, etc.
│   ├── side-plots.json          # narrative side-plot config
│   ├── promotion-config.json    # promotion/PIP track config
│   ├── year-tracker.json        # 1-year simulation milestones + asset_pipeline seed
│   └── asset-platforms.json     # reference list for admin-tier can_generate_assets agents
├── workers/
│   ├── agent-runner.js          # THE Worker: instantiateAgent/runAgentSession, work-day/week cycles, scheduled(), admin HTTP API
│   ├── crm-engine.js            # case generation/assignment by case_focus/clearance
│   ├── meeting-engine.js        # standups, audits, PIP sessions, quarterly/yearly reviews
│   ├── gemini-client.js         # queryGemini() — Gemini 2.5 Flash-Lite REST wrapper
│   ├── state-manager.js         # AgentStateDO (Durable Object) — per-agent persisted state
│   ├── case-generator.js        # CASE_POOL + generateCaseBatch() (used by .github/scripts/generate-agent-cases.mjs)
│   └── scheduler.js             # LEGACY — superseded by agent-runner.js's scheduled()/`/api/agents/trigger`; not deployed, kept pending cleanup
├── agents/
│   ├── agent-base.js            # AgentBase — shared state machine, sessions, reports, app interaction, DO persistence
│   ├── agent-1-perfectionist.js # Phase 1
│   ├── agent-2-productive.js    # Phase 1
│   ├── agent-3-standard.js      # Phase 1
│   ├── agent-4-trainee.js       # Phase 1
│   └── agent-stub.js            # generic runner for agents 5-11 (admin tier, "specified" but no dedicated class yet)
├── dashboard/
│   ├── admin-panel.html         # standalone admin dashboard
│   └── dashboard.js             # shared dashboard logic (DCAdmin)
├── reports/templates/           # markdown templates: incident, status, weekly
├── database/
│   ├── schema.sql                # D1 schema (agents, agent_sessions, cases, interactions, reports, suggestions, weekly_analytics, meetings, side_plots, promotions, year_stats)
│   └── seed-cases.sql            # seed agents + starter case batch
├── wrangler.toml                  # data-center-agents Worker config (D1/KV/DO bindings; see deploy.md)
├── deploy.md                      # deploy quick-reference
├── package.json                  # { "type": "module" } — scopes ESM for Workers + .github/scripts/*.mjs
├── README.md                      # this file
├── AGENTS.md                      # agent specification reference (summary)
└── STRATEGY.md                    # agents/-folder framing of CLAUDE.md's "Current Strategy"
```

The in-app **Admin tab** (`index.html`, `dataset.moduleId = 'admin'`) is a
read-only client for `agent-runner.js`'s HTTP API — it does not duplicate any
simulation logic. The standalone `dashboard/admin-panel.html` is the same
idea as a non-bundled page, useful for testing the API independently of
GitHub Pages.

---

## Agent roster

### Agents 1-4 — full behavioral state machines

| # | Name | Role | Clearance | Key trait |
|---|------|------|-----------|-----------|
| 1 | The Perfectionist | QA Lead | standard | Never gets angry; "educates the algorithm"; only calms down once a case is solved *and* documented. |
| 2 | The Productive | Senior IT Operator | standard | Irritation stack (max 3) → `ANGRY` + incident report + cooldown; 30% overtime days; bonus days when +30% over quota. |
| 3 | The Standard Agent | IT Generalist | standard | `model_usage_rate = mood / 100`, recalculated every session; files balanced status reports. |
| 4 | The Trainee | Junior IT Support | standard | Tracks `panicLevel` (0-100); at ≥80 fires `TRAINEE_PANIC`, escalating to a senior agent for a joint session and an auto-generated guide. |

### Agents 5-11 — admin tier, fully specified (running via `agent-stub.js`)

| # | Name | Role | Clearance | Purpose |
|---|------|------|-----------|---------|
| 5 | The IT Chief | Senior IT Admin | sudo | Hard cases (network/firewall/app-layer/client escalations); raises `quarterly_demand`. |
| 6 | The QA | Quality Assurance | sudo | Agent audits + model optimization. |
| 7 | The Team Lead | Agent Coach & Team Manager | sudo | Agent productivity/development; PIP authority over agents 1-4; runs the weekly meeting. |
| 8 | The Lead QA | Chief Quality Officer | sudo | Project-wide audits (agents, models, workflows, technologies). |
| 9 | The Designer | UI/UX Specialist | specialist | Design audits of the repo + Claude app; quarterly UI updates. |
| 10 | The Architect | Project Mastermind | root | Root-level changes, hard escalations, versioned releases. |
| 11 | The CEO | Founder & Chief Executive | root | Leads every meeting; final decision authority (`vote_weight: 2`, veto). |

`config/simulation-config.json`'s `SIMULATION.active_agents` / `stub_agents`
controls which agent IDs use a dedicated `agent-N-*.js` class vs. the generic
`agent-stub.js`; `PERMISSIONS` mirrors each agent's `clearance` for
`fileSuggestion()` routing. See `AGENTS.md` for full detail.

---

## Setup

`agents/wrangler.toml` already declares the single `data-center-agents`
Worker and its D1 (`DB`), KV (`SIM_KV`), and Durable Object (`AGENT_STATE`)
bindings — see `deploy.md` for the step-by-step deploy. Remaining manual
steps:

1. **Secrets** (from `agents/`):
   ```bash
   npx wrangler secret put GEMINI_API_KEY   # required — Gemini 2.5 Flash-Lite
   npx wrangler secret put ADMIN_TOKEN      # required — validates X-Admin-Token
   npx wrangler secret put GITHUB_TOKEN     # optional — gates report/guide commits to GitHub
   ```
   `ADMIN_TOKEN` is **never** embedded in `index.html` or `dashboard.js` — the
   admin types it into the dashboard once, it's stored in `localStorage`, and
   sent as the `X-Admin-Token` header on every `/api/agents/*` request. See
   CLAUDE.md's credential rules.

2. **D1 schema** — apply once per environment:
   ```bash
   npx wrangler d1 execute data-center-db --file=agents/database/schema.sql --remote
   npx wrangler d1 execute data-center-db --file=agents/database/seed-cases.sql --remote
   ```

3. **Deploy**:
   ```bash
   cd agents && npx wrangler deploy
   ```

4. **Cron Triggers** — NOT added yet, by design. `agent-runner.js`'s
   `scheduled()` handler implements the work-day/work-week cycles, but
   `wrangler.toml` intentionally has no `[triggers]` block until the project
   is ready for the quarter-run (see `CLAUDE.md`'s "Launch Decisions" and
   `TOKEN-BUDGET.md`). Until then, use `/api/agents/trigger` for manual runs.

5. **Test the admin dashboard** — open the in-app 🔐 Admin tab (or
   `agents/dashboard/admin-panel.html`), enter the `ADMIN_TOKEN` value, and
   confirm the agent status grid loads from `/api/agents/status`.

### Environment variables / bindings summary

| Name | Type | Purpose |
|------|------|---------|
| `GEMINI_API_KEY` | secret | Gemini 2.5 Flash-Lite API key for in-character role-play |
| `ADMIN_TOKEN` | secret | Validates `X-Admin-Token` on `/api/agents/*` and `/api/simulation` |
| `GITHUB_TOKEN` | secret (optional) | Commits trainee guides to `data-center-archive/guides/`; no-ops without it |
| `DB` | D1 binding | `agents`, `agent_sessions`, `cases`, `interactions`, `reports`, `suggestions`, `weekly_analytics`, `meetings`, `side_plots`, `promotions`, `year_stats` |
| `AGENT_STATE` | Durable Object binding | `AgentStateDO` — per-agent persisted state |
| `SIM_KV` | KV binding | Live simulation overrides (`inspection_mode`, `paused`, `phase`) |

### CI variables/secrets for `.github/workflows/agent-*.yml`

| Name | Type | Purpose |
|------|------|---------|
| `vars.AGENTS_API_BASE` | repo variable | Base URL of the deployed `data-center-agents` Worker |
| `secrets.ADMIN_TOKEN` | repo secret | Same value as the Worker's `ADMIN_TOKEN` secret |

`agent-cases.yml` (weekly case batch) needs none of these — it only runs
`case-generator.js` locally and commits the result. `agent-reports.yml`
(weekly report) no-ops with a step-summary notice until both are set.

---

## Local development

```bash
# Validate config/data as usual
node .github/scripts/validate-json.js
node .github/scripts/health-check.js

# Generate a one-off case batch (writes agents/database/cases-<year>-w<week>.json)
node .github/scripts/generate-agent-cases.mjs

# Run the Worker locally (from agents/)
npx wrangler dev
```

---

## Known gaps / TODO

- `evaluateResponseQuality()` and `getDbContext()` in `agent-base.js` are
  placeholders (length-based heuristic / empty string).
- Agents 5-11 have full `character`/`states` specs in `agents-config.json`
  but no dedicated `agent-N-*.js` state-machine class — they run via
  `agent-stub.js`'s `AgentBase` defaults.
- `commitGuideToArchive()` (trainee guide auto-commit) no-ops without
  `GITHUB_TOKEN`.
- `weekly_analytics` columns `irritation_count`, `happy_count`,
  `overtime_days`, `suggestions_filed` are not yet populated by
  `runWeeklyResetCycle()` — `agent-reports.yml`'s generated summary shows
  `—` for these until a future iteration computes them from
  `agent_sessions`/`interactions`.
- Acknowledging reports from the Admin tab (`adminAcknowledge()` in
  `index.html`) is currently client-side only — a
  `POST /api/agents/reports/:id/ack` endpoint is needed to persist it.
- `workers/scheduler.js` is legacy (superseded by `agent-runner.js`'s
  `scheduled()` + `/api/agents/trigger`) — not imported or deployed; remove
  once confirmed unneeded.
