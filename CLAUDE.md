# CLAUDE.md — Office AI Agents

## What this repo is

An office of 11 AI personas that use and stress-test two production AI
systems — Claude (embedded in [Data Center](https://avivnofar.github.io/data-center/))
and Gemini (embedded in [Notebook-X](https://github.com/avivnofar/Notebook-X))
— by asking them real IT/cybersecurity questions, evaluating the answers,
and flagging genuine capability gaps back to the owner for review. This repo
was migrated out of `data-center/agents/` (2026-06-19) into its own repo so
the simulation could work on multiple target projects over time; as of
2026-07-01 it also automates against Notebook-X, not just Data Center.

**This is not a Netvill support-ticket simulation.** That framing (fictional
clients, severity/escalation routing, a flat CRM case pool) was retired
2026-07-18 in the Q&A-engine rebuild described below — see "The Q&A engine"
and "Incident: 2026-07-11/12" for the full history of how this repo got
here. See `README.md` for the public-facing summary and
`PROJECT-CONTEXT-SUMMARY.md` for a complete narrative history written for a
reader with no prior context.

## Architecture

- **Worker**: `data-center-agents` (`workers/agent-runner.js`, entry point
  per `wrangler.toml`'s `main`). Re-exports `AgentStateDO` from
  `workers/state-manager.js` for the Durable Object binding.
- **Bindings**: `DB` (D1 `data-center-db`), `AGENT_STATE` (Durable Object),
  `SIM_KV` (KV, live simulation overrides + Gemini-pacing timestamp), `APP_API`
  (service binding to `data-center-api`, since Workers can't `fetch()`
  another Worker's `*.workers.dev` URL directly — error 1042), `AI`
  (Cloudflare Workers AI, account-scoped, no extra credentials).
- **Cron**: `*/30 0-13,23 * * *` UTC (= 02:00-16:30 IDT), drives
  `scheduled()` -> `runScheduledBlock()`, a no-op unless
  `config/daily-schedule.json` has a block at that exact time/day. State
  for an in-progress simulated day persists in `SIM_KV` (`daily-cycle-state`)
  between ticks. **LIVE since 2026-07-18** (first activation of the Q&A
  engine — later session than the rebuild itself, which was design-and-build
  only): first run Sunday 2026-07-19 starting 02:00 Israel, volume ramped by
  `config/token-economy.json`'s TEMPORARY `graduated_rollout_throttle`
  (12 → 40 → 100 questions for the first three days, then automatic
  step-up to normal budget-driven volume). See TOKEN-BUDGET.md's
  2026-07-18 activation entry. **DST caveat**: the cron window is written
  for IDT (UTC+3); when Israel switches to IST (UTC+2, late Oct) or back
  (late Mar), update BOTH `wrangler.toml`'s cron expression and
  `ISRAEL_UTC_OFFSET_HOURS` in `workers/agent-runner.js` together.
- **GitHub Actions**: `.github/workflows/scheduled-claude.yml` runs a
  nightly direct-Anthropic-API session (`.github/scripts/run-claude-session.js`
  + `commit-and-log.sh`) — a separate automation path from the Worker's own
  cron, used for autonomous maintenance tasks against this repo (workflow
  currently `disabled_manually` in GitHub Actions; the definition is kept
  current for when it's re-enabled).
  `.github/workflows/notebook-x-daily.yml` — formerly a third, independent
  automation path targeting `avivnofar/Notebook-X` — was **deleted
  2026-07-18** along with its script, superseded by the Q&A engine's
  Notebook-X question path. See "Connection to `Notebook-X`" below.

## The 11 agents (`config/agents-config.json`, `AGENTS.md`)

Phase 1 (dedicated state machines, `agents/agent-N-*.js`):

| # | Name | Role |
|---|------|------|
| 1 | The Perfectionist | QA Lead (standard) |
| 2 | The Productive | Senior IT Operator (standard) |
| 3 | The Standard Agent | IT Generalist (standard) |
| 4 | The Trainee | Junior IT Support (standard) — has the `TRAINEE_PANIC` escalation protocol |

Admin tier (specified in config, run via the generic `agents/agent-stub.js`
except #10):

| # | Name | Role | Clearance |
|---|------|------|-----------|
| 5 | The IT Chief | Senior IT Admin | sudo |
| 6 | The QA | Quality Assurance | sudo |
| 7 | The Team Lead | Agent Coach & Team Manager | sudo |
| 8 | The Lead QA | Chief Quality Officer | sudo |
| 9 | The Designer | UI/UX Specialist | specialist |
| 10 | The Architect | Project Mastermind | root — **dormant** |
| 11 | The CEO | Founder & Chief Executive | root |

**Agent 10 (The Architect) is dormant** — reserved for owner-directed
special tasks only, not part of the daily automation. `workers/qa-engine.js`'s
`getActiveQaAgents()` excludes it entirely from question generation (it was
already excluded from the old CRM case pool the same way, before this
rebuild). Its personality/character in `agents-config.json` is preserved
for when it's reactivated — this rebuild only touched task logic, never the
persona flavor text (explicit instruction, all 11 agents).

Every agent has a shared `mood`/`irritation`/`isPanic` state machine
(`agents/agent-base.js`), durable per-agent overrides in its
`AgentStateDO`, a `clearance` tier that routes `fileSuggestion()` calls
(`standard` < `specialist` < `sudo` < `root`), and (as of 2026-07-18) three
Q&A-engine fields: `topic_affinity` (array — which topics this persona
gravitates toward), `escalation_threshold` (0-1 — how sensitive this persona
is to flagging a borderline-quality answer as a capability gap; QA/Lead QA
run high, Standard/Trainee run low), and `followup_depth` (0-2 — how many
sharper follow-up questions this persona asks on an unclear answer before
giving up).

## The Q&A engine (2026-07-18 rebuild)

Replaces the retired Netvill-CRM case model entirely. Core loop, identical
for all 10 active personas (Step 3 of the rebuild — same core action, style
differs):

1. **Generate** — `workers/qa-topics.js` holds the topic pool: general
   IT/cybersecurity questions (cloud, AI, networking protocols, Linux/
   Windows, firewalls — weighted highest, `project: 'data-center'`) plus
   questions targeting a specific Notebook-X notebook (`project:
   'notebook-x'`, `kbSlug` set — covers `kb-linux`, `kb-1com`,
   `kb-voip-sip`, `kb-mirtapbx`, `kb-cloud-devops` at core weight, plus
   `kb-cybersecurity`/`kb-firewall`/`kb-networking`/`kb-vpn`, discovered live
   in `config/notebook-x-progress.json` (since deleted; see "Connection to
   `Notebook-X`") as skeleton-quality notebooks —
   good gap-flagging targets, not out of scope). VoIP/PBX-specific topics
   stay in the pool at lower weight (no deletions, per instruction).
   `workers/qa-engine.js`'s `generateAssignedDailyBatch()` assigns each
   question to exactly ONE project and one agent (biased by that agent's
   `topic_affinity`) — an agent can and does work both projects across
   different questions in the same day, just never both from one question.
2. **Ask** — `agents/agent-base.js`'s `askAssignedProject()` dispatches to
   `_askDataCenter()` (Claude via `data-center-api`'s `/api/chat`) or
   `_askNotebookX()` (Gemini via `workers/notebookx-client.js`
   `queryNotebookX()`, paced by `workers/gemini-pacer.js`). No escalation
   between the two — that dual-path "check notebook-x, fall through to
   Claude" behavior belonged to the old case model and is gone.
3. **Evaluate** — `evaluateResponseQuality()` (unchanged length-based
   placeholder heuristic, reused not rebuilt, per instruction) scores the
   answer 0-1.
4. **Mood** — updates PRIMARILY from that quality score
   (`_applyQualityMood()`: quality > 0.7 -> maybe HAPPY, quality < 0.4 ->
   maybe IRRITATED) — the original design vision, no longer diluted by
   other signals.
5. **Follow-up** — if the answer lands in an unclear band (quality
   0.3-0.65), the agent asks up to `followup_depth` sharper follow-ups on
   the same topic before moving on.
6. **Maybe flag** — `workers/gap-reports.js`'s `detectCapabilityGap()`
   classifies the result: HARD gaps (Notebook-X returned no answer at all,
   or the Claude request itself failed) always get flagged, any persona.
   SOFT candidates (a real but weak answer) only get flagged if quality is
   below THIS agent's own `escalation_threshold`. A flagged gap gets a
   short (2-4 line) **Hebrew** internal office note, composed by the
   flagging agent in its own voice via the existing `queryGemini()` path —
   framed as "the tool I work with isn't good enough here, flagging it for
   the tool to be fixed," not a customer-facing incident. Once per day,
   `workers/agent-runner.js`'s `fileGapDigests()` batches today's findings
   into ONE file per project: `reports/gaps/<project>/<date>.md`. **Never a
   GitHub Issue, for either project** — explicit requirement.

**Volume** is not a fixed daily quota. `workers/agent-runner.js`'s
`computeDailyQuestionVolume()` checks the shared Claude budget (below) once
per day and picks a reduced total if it's exhausted — the actual spend cap
is always enforced per-call at ask time, this just avoids generating
questions nobody will get a real answer to. That total is spread across the
day via the existing `case_batch` blocks in `config/daily-schedule.json`.

## Token economy (`config/token-economy.json`)

- **Groq `llama3-8b-8192`** — primary model for all routine per-case agent
  work (`workers/groq-client.js callGroq()`). Free tier, ~14,400 req/day,
  resets 00:00 UTC.
- **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct-fp8`) — case
  routing/classification, and the same-session fallback when Groq is down
  or Gemini 429s. Free, ~10,000 req/day, account-scoped `AI` binding.
- **Gemini 3.1 Flash-Lite** (`GEMINI_API_KEY`) — report synthesis
  (monthly/quarterly/semi-yearly/yearly, `workers/meeting-engine.js`) AND,
  as of 2026-07-18, direct Notebook-X asks (`agent-base.js
  _askNotebookX()`). **Both `gemini-3.5-flash` (the original retired model)
  and `gemini-2.5-flash` (retired AFTER that — live-tested 404 on
  2026-07-09, see `TOKEN-BUDGET.md`'s "Notebook-X token verification +
  Gemini model retirement fix" entry) are deprecated — never reintroduce
  either.** `gemini-3.1-flash-lite` is the current, live-verified
  (`GET /v1beta/models`, HTTP 200) replacement this project has actually
  standardized on. The 2026-07-09 fix already covered every file below
  once; by 2026-07-18 several had silently regressed back to
  `gemini-3.5-flash` (cause not established — re-fixed, not just found for
  the first time) and one (`agents/architect_agent.py`) had never been
  swept in the 2026-07-18 pass at all until a second check caught it:
  `config/agents-config.json` (×11), `config/simulation-config.json`,
  `config/token-economy.json`, `agents/agent-base.js`,
  `workers/meeting-engine.js`, `workers/gemini-client.js`,
  `.github/scripts/notebook-x-daily.mjs`, `agents/architect_agent.py`.
  **Gemini pacing**: `workers/gemini-pacer.js` enforces a minimum 20s
  spacing between this automation's own Notebook-X calls specifically
  because Gemini's free-tier quota is shared with two consumers this repo
  cannot observe in real time — Notebook-X's own backend traffic and its
  weekly gap-analysis job. See that file's header comment for the full
  reasoning; a paced-out call is skipped, not blocked-and-retried.
- **Shared Claude budget** (`shared_claude_budget` in token-economy.json):
  **$4.50/month soft-stop** — deliberate headroom under the account's own
  $5/month spend ceiling, which is the hard backstop (two distinct
  mechanisms; the soft-stop was briefly 5.00 on 2026-07-18 and restored to
  4.50 the same day) — tracked via `workers/model-router.js`'s
  `getClaudeBudgetStatus()`/`recordClaudeSpend()` against a single D1
  `claude_budget_usage` table. As of 2026-07-18 this is genuinely shared —
  both the 11-agent Q&A engine's Claude asks (`agent-base.js
  _askDataCenter()`) and the TODO.md-driven chore automation
  (`workers/chore-runner.js`) draw from and record against the SAME month
  row, not two separate budgets. The old per-day CALL-COUNT cap
  (`claude_daily_cap: 30`) is retired — replaced by this per-month DOLLAR
  cap, checked per-call.
- **Google AI Studio** (`GOOGLE_AI_API_KEY`) — optional, reserved for
  human-in-the-loop creative-tool sessions (Agents 9/10 building design
  assets), never called programmatically by the Worker.

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

See `DEPLOY.md` for the full walkthrough and how to verify the deploy via
`/api/agents/status`. **Before deploying the 2026-07-18 Q&A-engine rebuild
specifically**, run the manual D1 migration noted in `database/schema.sql`
(`ALTER TABLE cases ADD COLUMN project TEXT`, etc. — `CREATE TABLE IF NOT
EXISTS` alone will not retrofit these columns onto the live database).

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

Dry-run verification (no network/D1/KV/model calls) for the Q&A-engine
rebuild specifically: `node scripts/verify-qa-engine.js`.

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
**second, separate** target project this repo automates against. Today the
only automation touching it is the Q&A engine's Notebook-X question path
(`agent-base.js _askNotebookX()` → `workers/notebookx-client.js`, read-only
asks, paced by `workers/gemini-pacer.js`).

**`.github/workflows/notebook-x-daily.yml` and
`.github/scripts/notebook-x-daily.mjs` were deleted 2026-07-18** (same day
as, but a later session than, the Q&A-engine rebuild) — the nightly
content-fill/backlog automation they ran is superseded by the Q&A engine.
The history below is preserved because it explains the standing
no-automated-writes rule, which outlives the deleted script.

**As of 2026-07-18 (rebuild session, earlier that day), that script never
wrote or modified code, files, or tools of any kind.** That's the explicit
rule the rebuild session introduced — reserved for Claude Code working
directly with the owner, or a future owner-directed special task to the
dormant Architect persona. Two things changed to satisfy it:

1. **The `housekeeping_*` function family is retired entirely** —
   `housekeeping_unifyDeleteObsolete`, `housekeeping_recommendChanges`,
   `housekeeping_uiCheck`, `housekeeping_codeAssessment` are all removed
   from `notebook-x-daily.mjs`, not just `housekeeping_codeAssessment` (the
   one that actually pushed full-file AUTO-FIX overwrites to
   `avivnofar/Notebook-X` with no `checkCodeWriteAllowedForModel()` gate at
   all — a real gap between documented intent and actual wiring, found
   during this rebuild's investigation). `housekeeping_recommendChanges`'s
   own prompt told the model "you are authorized to act... no longer
   recommend-only" even though its code path happened to stay inert (no
   push call) — retired anyway, per the explicit "all of it, not just the
   code-writing one" instruction. `housekeeping_uiCheck` was read-only and
   retired too, same reason. `reviewReadySection()` — a separate,
   non-`housekeeping_`-prefixed function — is unaffected.
2. **`frontend_code_change` backlog items are now recommendation-only.**
   The old path fetched the target file, asked Gemini for a full rewrite
   via `<summary>`/`<updated_code>` tags, and pushed it straight to
   `avivnofar/Notebook-X`, gated only by `checkDiffPlausible()` AFTER the
   push (a post-hoc diff-size floor, not a pre-hoc write-permission gate).
   It now asks Gemini for a short recommendation instead, writes that to
   the daily log, and leaves the backlog item `flagged_for_review` for a
   human/Claude-Code session to actually implement.

### `config/notebook-x-progress.json` (deleted 2026-07-18)

Was a manually maintained completed/pending list mirroring TODO.md's
Notebook-X section, consumed one item per day in list order by
`.github/scripts/notebook-x-daily.mjs`. When that script was deleted
(2026-07-18), this file became dead data with no runtime reader; the owner
approved deleting it the same day. Its history (item statuses, completion
notes, the `pushed-unmerged` incident trail) lives on in git history and
TOKEN-BUDGET.md's 2026-07-09..07-16 entries.
**`TODO.md` was deleted from this
repo's root** in the 2026-07-18 repo-cleanup session (confirmed
intentional). `workers/chore-runner.js`'s `fetchTodoSection()` fetches it
via a raw GitHub URL and now degrades to a permanent no-op (`ranTask:
false`) rather than crashing — effectively dormant until `TODO.md` exists
again or that path is rewired to read something else. This does not affect
`config/notebook-x-progress.json` itself (manually maintained, not derived
from `TODO.md` at runtime).

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
same `checkCodeWriteAllowedForModel()` gate `frontend_code_change` uses.

**This incident is why the 2026-07-18 rebuild retired the whole mechanism
rather than trusting the 2026-07-12 guardrails to hold indefinitely** — the
investigation for that rebuild found `checkCodeWriteAllowedForModel()` was
never actually wired into `frontend_code_change` despite existing
specifically for that purpose, meaning the 2026-07-12 fix's stated
guardrails were incomplete in practice. See `PROJECT-CONTEXT-SUMMARY.md`
for the full narrative connecting this incident to the rebuild.

**Rule for any future change to Notebook-X automation (human or agent):**
this automation does not write or modify code, files, or tools of any kind.
If a future session wants to reintroduce autonomous writes, that is a
deliberate, explicit decision requiring the same standard the retired
mechanism failed to meet: the model must see the *entire* file (never a
truncated excerpt), the result must pass an automated plausibility check
*before* it is pushed, and the code-write permission gate
(`checkCodeWriteAllowedForModel()`) must actually be wired into the call
site, not merely defined nearby.

## Key files

- `workers/agent-runner.js` — Worker entry point: HTTP admin API, cron
  `scheduled()` handler, `runWorkDayCycle()`/`runWeeklyResetCycle()`,
  `computeDailyQuestionVolume()`, `fileGapDigests()`
- `workers/qa-engine.js` — Q&A question generation/assignment (2026-07-18,
  replaces the retired `crm-engine.js`)
- `workers/qa-topics.js` — the question topic pool (2026-07-18, replaces
  the retired `case-generator.js`)
- `workers/gap-reports.js` — capability-gap classification + Hebrew digest
  rendering (2026-07-18, new)
- `workers/gemini-pacer.js` — Notebook-X Gemini call pacing (2026-07-18, new)
- `workers/model-router.js` — shared $4.50/mo Claude budget tracking (D1
  `claude_budget_usage`) + chore-automation model routing
- `workers/scheduler.js` — dead/unwired (confirmed 2026-07-18 — nothing
  imports it, `wrangler.toml`'s `main` points at `agent-runner.js`); kept,
  not deleted, out of scope this session, import updated so it doesn't
  reference deleted files
- `workers/meeting-engine.js` — standup/monthly/quarterly/PIP/audit meetings,
  report generation and GitHub commit
- `workers/case-generator.js`, `workers/crm-engine.js` — **deleted
  2026-07-18** (Netvill-CRM case model, superseded by qa-topics.js/qa-engine.js)
- `workers/groq-client.js` / `workers/gemini-client.js` — model clients
- `workers/state-manager.js` — `AgentStateDO` Durable Object
- `agents/agent-base.js` — shared agent state machine + `askAssignedProject()`
  ask-and-evaluate flow (2026-07-18)
- `agents/agent-1..4-*.js` — Phase 1 dedicated agent classes
- `agents/agent-stub.js` — generic driver for agents 5-9, 11 (not 10 — dormant)
- `config/agents-config.json` — all 11 agents' full specs, incl.
  `topic_affinity`/`escalation_threshold`/`followup_depth` (2026-07-18)
- `config/simulation-config.json`, `daily-schedule.json`, `ai-tools.json`,
  `relationships.json`, `promotion-config.json`, `side-plots.json`,
  `year-tracker.json`, `token-economy.json` — simulation parameters
- `database/schema.sql` — D1 schema, incl. the 2026-07-18 manual-migration
  note for `cases.project`/`cases.kb_slug`/`reports.project`
- `dashboard/admin-panel.html` + `dashboard.js` — standalone admin UI
- `reports/` — generated daily/weekly/meeting/gap reports, asset-pipeline board
- `checkpoints/` — saved simulation-state snapshots before major changes
- `assets/incoming/` — raw human-in-the-loop tool exports awaiting integration
- `scripts/verify-qa-engine.js` — dry-run verification for the Q&A-engine
  rebuild (2026-07-18, new)
- `wrangler.toml` — Worker bindings, cron, secrets reference
- `AGENTS.md` / `PENDING-WORK.md` / `DEPLOY.md` — spec, open work, and
  deploy reference docs (`STRATEGY.md` was deleted in the 2026-07-16
  repo-cleanup session — superseded by this file)
- `PROJECT-CONTEXT-SUMMARY.md` — complete narrative history for a reader
  with no prior context (2026-07-18, new)
