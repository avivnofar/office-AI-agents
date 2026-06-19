# Office AI Agents

Autonomous AI agent simulation engine. 11 agents simulate a full IT office
work year, training and optimizing AI models and applications.

## Current projects

- **data-center**: IT knowledge base ([avivnofar.github.io/data-center](https://avivnofar.github.io/data-center))

The agents currently work exclusively on `data-center`, but this engine is
designed to be project-agnostic — future projects can be added without
changing the core simulation logic.

## Architecture

- **Runtime**: Cloudflare Workers (`data-center-agents` Worker, `workers/agent-runner.js`)
- **Agent models**: Groq `llama3-8b-8192` (primary, free — routine per-case work for all agents)
- **Fallback**: Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`) — case routing/classification, and same-session fallback when Groq is unavailable or Gemini hits a 429
- **Reports**: Google Gemini 2.5 Flash-Lite (`GEMINI_API_KEY`) — monthly/quarterly/semi-yearly/yearly report synthesis only
- **App search**: Claude (`claude-sonnet-4-6`) — reserved for `data-center-api`'s AI Search bar and hard escalations, capped at 5 calls/day across all agents
- **Storage**: Cloudflare D1 (`data-center-db`), KV (`SIM_KV`), Durable Objects (`AgentStateDO`)
- **Time**: per-block cron (`*/30 5-13 * * *` UTC) drives the simulated work day; 5 simulated work days (Sun-Thu) = 1 simulated week

## Token economy

See `config/token-economy.json` for the full distributed-model map.

- **Groq**: primary for all routine agent case work (free, ~14,400 req/day)
- **Cloudflare Workers AI**: routing/classification + fallback (free, ~10,000 req/day)
- **Gemini 2.5 Flash-Lite**: monthly/quarterly/semi-yearly/yearly report synthesis only (~1,500 req/day)
- **Google AI Studio** (`GOOGLE_AI_API_KEY`): reserved for human-in-the-loop creative tool sessions (Agents 9/10), not called programmatically
- **Claude API**: max 5 calls/day total — expensive, reserved for app search and root-level escalations

## Companion repo

[`avivnofar/data-center`](https://github.com/avivnofar/data-center) — the
app this office simulation works on. This repo holds only the agent
simulation engine; `data-center` holds the app, data, and UI.

## Key files

- `workers/agent-runner.js` — admin HTTP API + agent execution + cron entrypoint
- `workers/scheduler.js`, `workers/meeting-engine.js`, `workers/crm-engine.js`, `workers/case-generator.js` — simulation cycle logic
- `workers/groq-client.js`, `workers/gemini-client.js` — model clients
- `agents/agent-base.js` + `agents/agent-1..4-*.js` — Phase 1 agent state machines; `agents/agent-stub.js` drives agents 5-11
- `config/agents-config.json` — all 11 agent specs (personality, behavior, clearance)
- `config/*.json` — simulation, scheduling, relationships, promotions, side-plots, token-economy config
- `database/schema.sql` — D1 schema
- `dashboard/admin-panel.html` — standalone admin dashboard
- `reports/` — generated daily/weekly/meeting reports + the asset pipeline board
- `wrangler.toml` — Worker config (bindings, cron, secrets reference)
- `AGENTS.md` — per-agent behavior spec summary
- `STRATEGY.md`, `PENDING-WORK.md`, `DEPLOY.md` — planning/ops docs
- `TOKEN-BUDGET.md` — session/cost discipline log (shared with GitHub Actions in both this repo and `data-center`)
- `CLAUDE-datacenter-ref.md` — a copy of `data-center/CLAUDE.md` for context when agents work on that app
