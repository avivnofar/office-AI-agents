# CLAUDE.md — Office AI Agents

## What this repo is

A standalone AI agent office simulation engine, migrated out of
`data-center/agents/` (2026-06-19) into its own repo so the simulation can
work on multiple target projects over time. Today it works exclusively on
`data-center` (the IT knowledge base). See `README.md` for the high-level
architecture and `CLAUDE-datacenter-ref.md` for full context on the app the
agents currently work on.

## Architecture

- **Worker**: `data-center-agents` (`workers/agent-runner.js`, entry point
  per `wrangler.toml`'s `main`). Re-exports `AgentStateDO` from
  `workers/state-manager.js` for the Durable Object binding.
- **Bindings**: `DB` (D1 `data-center-db`), `AGENT_STATE` (Durable Object),
  `SIM_KV` (KV, live simulation overrides), `APP_API` (service binding to
  `data-center-api`, since Workers can't `fetch()` another Worker's
  `*.workers.dev` URL directly — error 1042), `AI` (Cloudflare Workers AI,
  account-scoped, no extra credentials).
- **Cron**: `*/30 5-13 * * *` UTC (= 08:00-16:30 IDT), drives
  `scheduled()` -> `runScheduledBlock()`, a no-op unless
  `config/daily-schedule.json` has a block at that exact time/day. State
  for an in-progress simulated day persists in `SIM_KV` (`daily-cycle-state`)
  between ticks.
- **GitHub Actions**: `.github/workflows/scheduled-claude.yml` runs a
  nightly direct-Anthropic-API session (`.github/scripts/run-claude-session.js`
  + `commit-and-log.sh`) — a separate automation path from the Worker's own
  cron, used for autonomous maintenance tasks against this repo.
  `.github/workflows/notebook-x-daily.yml` is a third, independent
  automation path — it targets a different project entirely
  (`avivnofar/Notebook-X`, not `data-center`). See "Connection to
  `Notebook-X`" below before touching it.

## The 11 agents (`config/agents-config.json`, `AGENTS.md`)

Phase 1 (dedicated state machines, `agents/agent-N-*.js`):

| # | Name | Role |
|---|------|------|
| 1 | The Perfectionist | QA Lead (standard) |
| 2 | The Productive | Senior IT Operator (standard) |
| 3 | The Standard Agent | IT Generalist (standard) |
| 4 | The Trainee | Junior IT Support (standard) — has the `TRAINEE_PANIC` escalation protocol |

Admin tier (specified in config, currently run via the generic
`agents/agent-stub.js`):

| # | Name | Role | Clearance |
|---|------|------|-----------|
| 5 | The IT Chief | Senior IT Admin | sudo |
| 6 | The QA | Quality Assurance | sudo |
| 7 | The Team Lead | Agent Coach & Team Manager | sudo |
| 8 | The Lead QA | Chief Quality Officer | sudo |
| 9 | The Designer | UI/UX Specialist | specialist |
| 10 | The Architect | Project Mastermind | root |
| 11 | The CEO | Founder & Chief Executive | root |

Each agent has a shared `mood`/`irritation`/`isPanic` state machine
(`agents/agent-base.js`), durable per-agent overrides in its
`AgentStateDO`, and a `clearance` tier that routes `fileSuggestion()` calls
(`standard` < `specialist` < `sudo` < `root`).

## Token economy (`config/token-economy.json`)

- **Groq `llama3-8b-8192`** — primary model for all routine per-case agent
  work (`workers/groq-client.js callGroq()`). Free tier, ~14,400 req/day,
  resets 00:00 UTC.
- **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct-fp8`) — case
  routing/classification, and the same-session fallback when Groq is down
  or Gemini 429s. Free, ~10,000 req/day, account-scoped `AI` binding.
- **Gemini 2.5 Flash-Lite** (`GEMINI_API_KEY`) — reserved for
  monthly/quarterly/semi-yearly/yearly report synthesis only
  (`workers/meeting-engine.js`). ~1,500 req/day, resets 11:00 Israel time.
  `gemini-3.5-flash` is deprecated — never reintroduce it.
- **Google AI Studio** (`GOOGLE_AI_API_KEY`) — optional, reserved for
  human-in-the-loop creative-tool sessions (Agents 9/10 building design
  assets), never called programmatically by the Worker.
- **Claude** (`claude-sonnet-4-6`) — capped at 5 calls/day total across all
  agents. Reserved for `data-center-api`'s AI Search bar, hard-case
  escalations, and Agent 10 (Architect)'s root-level changes (Architect
  never calls a model for routine cases — see `processCaseBatch()`'s
  Agent-10 special case in `agent-runner.js`).

## How to deploy the Worker

```bash
npx wrangler login   # or set CLOUDFLARE_API_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GITHUB_TOKEN       # optional
npx wrangler secret put GOOGLE_AI_API_KEY  # optional
npx wrangler deploy
```

See `DEPLOY.md` for the full walkthrough (including the dashboard
multi-file-editor fallback) and how to verify the deploy via
`/api/agents/status`.

## How to run a simulation day manually

```bash
curl -X POST https://data-center-agents.avivnofar.workers.dev/api/agents/trigger \
  -H "X-Admin-Token: <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"day"}'
```

Other trigger types: `meeting` (`{"meetingType": "..."}`), `inspection`
(`{"active": true|false}`), `week_reset`. See `agent-runner.js`'s
`/api/agents/trigger` handler for the full switch.

## Connection to `data-center`

[`avivnofar/data-center`](https://github.com/avivnofar/data-center) is the
app this office simulation works on — its `index.html` 🔐 Admin tab is the
read-only dashboard for this Worker's data (status, session feed, reports,
suggestions). The two repos are deliberately separate: this repo is
project-agnostic infrastructure; `data-center` is the current target
project. The Worker writes reports/issues back to **this** repo
(`REPO_NAME` in `agent-runner.js`/`meeting-engine.js` is
`office-AI-agents`), not to `data-center`.

`TOKEN-BUDGET.md` is duplicated in both repos (GitHub Actions in both need
it); `CLAUDE-datacenter-ref.md` is a point-in-time copy of
`data-center/CLAUDE.md` kept here for context — it will drift, so cross-check
the live file in `data-center` for anything load-bearing.

## Connection to `Notebook-X`

[`avivnofar/Notebook-X`](https://github.com/avivnofar/Notebook-X) is a
**second, separate** target project this repo automates against — not part
of the 11-agent office simulation above, and not documented anywhere else in
this file until now. `.github/workflows/notebook-x-daily.yml` runs
`.github/scripts/notebook-x-daily.mjs` daily (22:00 UTC = 01:00 IDT) and on
`workflow_dispatch`, using `NOTEBOOK_X_REPO_TOKEN` to read/write directly
into Notebook-X's repo. It does two distinct things:

1. **`frontend_code_change`** (`config/notebook-x-progress.json` backlog
   items) — small, targeted edits to `index.html`, gated by
   `checkCodeWriteAllowedForModel()` (mirrors `workers/permission-guard.js`)
   and `checkDiffPlausible()` (rejects implausibly small/no-op diffs).
2. **`housekeeping_codeAssessment()`** — a nightly Gemini review of
   Notebook-X's core backend files (`notebook_backend.py`, `api_server.py`,
   `github_storage.py`), which may push a full-file rewrite directly to
   `main` if it decides a fix is needed.

### Incident: 2026-07-11/12 — `housekeeping_codeAssessment` gutted `notebook_backend.py`

The pre-2026-07-12 version of `housekeeping_codeAssessment()` sent Gemini
only the first 2500 characters of each core file while asking it to return
"the FULL updated raw code," with `maxTokens: 4096` — structurally
impossible for a ~2000-line file, and nothing checked the result before
pushing. Two runs (15:46 and 18:10 UTC on 2026-07-11) shrank
`notebook_backend.py` from 2002 lines to 79, deleting `verify_github_connection()`
and dozens of other functions `api_server.py` still called — production
crashed with `AttributeError` and stayed down until the 2026-07-12 fix.
Fixed in `notebook-x-daily.mjs` (2026-07-12): no truncation on input, output
token budget sized to input, a `checkFullFileRewritePlausible()` size-floor
guard (rejects a proposed rewrite that shrank >40% vs. the original) before
any push, files over `MAX_SAFE_FULL_REWRITE_CHARS` get a text-only
recommendation instead of an auto-push, and the push now goes through the
same `checkCodeWriteAllowedForModel()` gate `frontend_code_change` uses. See
the comment block above `housekeeping_codeAssessment()` in
`notebook-x-daily.mjs` for the full writeup.

**Rule for any future change to this script (human or agent):** an
autonomous full-file rewrite of a real source file is only safe if the model
saw the *entire* file (never a truncated excerpt) and the result passes an
automated plausibility check *before* it is pushed — a large, confident-looking
diff is not evidence of correctness. If a file is too large to safely
round-trip in one completion, do not truncate-and-push; fall back to a
text-only recommendation for a human to apply, the same way
`housekeeping_unifyDeleteObsolete()` and `housekeeping_recommendChanges()`
already do. This applies regardless of which model's `code_write` permission
in `config/project-permissions.json` is currently `true` — a standing
write permission is not a substitute for input completeness and an output
plausibility check.

## Key files

- `workers/agent-runner.js` — Worker entry point: HTTP admin API, cron
  `scheduled()` handler, `runWorkDayCycle()`/`runWeeklyResetCycle()`
- `workers/scheduler.js` — per-block schedule helpers
- `workers/meeting-engine.js` — standup/monthly/quarterly/PIP/audit meetings,
  report generation and GitHub commit
- `workers/crm-engine.js` — daily case pool generation/assignment
- `workers/case-generator.js` — case content generation
- `workers/groq-client.js` / `workers/gemini-client.js` — model clients
- `workers/state-manager.js` — `AgentStateDO` Durable Object
- `agents/agent-base.js` — shared agent state machine
- `agents/agent-1..4-*.js` — Phase 1 dedicated agent classes
- `agents/agent-stub.js` — generic driver for agents 5-11
- `config/agents-config.json` — all 11 agents' full specs
- `config/simulation-config.json`, `daily-schedule.json`, `ai-tools.json`,
  `relationships.json`, `promotion-config.json`, `side-plots.json`,
  `year-tracker.json`, `token-economy.json` — simulation parameters
- `database/schema.sql` — D1 schema
- `dashboard/admin-panel.html` + `dashboard.js` — standalone admin UI
- `reports/` — generated daily/weekly/meeting reports, asset-pipeline board
- `checkpoints/` — saved simulation-state snapshots before major changes
- `assets/incoming/` — raw human-in-the-loop tool exports awaiting integration
- `wrangler.toml` — Worker bindings, cron, secrets reference
- `AGENTS.md` / `STRATEGY.md` / `PENDING-WORK.md` / `DEPLOY.md` — spec,
  strategy, open work, and deploy reference docs
