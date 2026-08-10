# CLAUDE.md — Office AI Agents

> ## ⚠️ THIS FILE IS BEHIND THE CODE. READ THIS FIRST. *(flagged 2026-08-10)*
>
> **Flagged, not reconciled** — per the standing rule that a
> documentation-vs-reality divergence is reported and the owner decides which
> side changes. Rewriting this file to match nine sessions of work is a session
> of its own; what follows is the honest index of what it does not know, so a
> reader stops trusting the omissions.
>
> **Eight production modules exist that this file never mentions.** Every one is
> live, and several are the office's core loop today:
>
> | Module | What it is |
> |---|---|
> | `workers/office-context.js` | parses back-office's `BOARD.md`, `CLIENT-REQUIREMENTS.md` and (2026-08-10) `channel/to-owner/OPEN-QUESTIONS.md` into agent, meeting and report prompts. Switch `office_context_enabled`, **live ON** |
> | `workers/report-pipeline.js` | the office writes and reviews its own periodic reports, with a structural gate that refuses a draft. Switch `report_pipeline_enabled`, **live ON** |
> | `workers/improvement-loop.js` | one D1 row per unit of office work (`event_type`, `track`, `quality`, `embodiment_model`). Switch `improvement_loop_enabled`, **live ON** — 129 rows |
> | `workers/repo-write.js` | **the one place a repo write happens.** Lifted out of `agent-runner.js` 2026-08-07, because `meeting-engine.js` built its own `Authorization` header for every meeting report the office ever filed |
> | `workers/permission-guard.js` | `resolveRepoWrite()` — the single write-decision entry point, three repos, one scoped token each |
> | `workers/architect-liaison.js` | files an unattended Architect session into D1 so the office can see the night happened. Switch `architect_liaison_enabled`, **live ON** |
> | `workers/meeting-decisions.js` | meeting action items → the board's inbox. Switch `action_items_to_board_enabled`, **live ON** |
> | `workers/task-router.js` | task-type routing. Switch `routing_enabled`, **absent = OFF** — the one below that is still what this file says it is |
>
> **The two claims in this file most likely to mislead:**
> - It describes the repo as if the Q&A engine were the whole of it. The office
>   now also runs a **delegation board**, **client requirements**, an
>   **improvement loop**, a **report pipeline**, an **owner questions channel**
>   and a **meeting protocol** — all specified in `back-office-AI-agents`
>   (private), whose `CLAUDE.md` is the session-start protocol for that work and
>   whose `plans/OFFICE-SCALING-TODO.md` is the live master plan.
> - It names kill switches as shipping OFF. **That is true of the code defaults
>   and false of production**: six of the seven read back ON from live SIM_KV on
>   2026-08-10. A documented switch state is a claim about production and goes
>   stale the moment someone toggles it. Boarded as `OB-040`.
>
> **Everything below this block is still accurate about what it does cover** —
> the Q&A engine, the guides pipeline, the token economy and the Notebook-X
> history are unchanged and worth reading.

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
   flagging agent in its own voice via `queryGeminiDirect()` (Gemini
   composes the Hebrew; the Groq-routed persona path — `queryGroqRouted()`,
   renamed 2026-07-19 from the misleadingly-named `queryGemini()` — is
   English-only flavor) —
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

## Guides (owner-directed Architect task)

The office also produces high-quality ENGLISH technical guides for the
owner's Smart Archive app. This repo only produces markdown files under
`guides/` — the owner uploads them to the archive manually; nothing here
touches Google Drive, the archive app, or any external repo. This is an
**owner-directed special task for the dormant Architect** (agent 10, see
"The 11 agents" above) — the one exception to that agent's dormancy, and
still not part of the daily Q&A flow.

**Pipeline — exactly two model calls, two names on each guide:**

1. **Draft** — a writer persona chosen by domain (`workers/guide-engine.js`
   `pickWriterAgentId()`: The QA/agent 6 for firewall+vpn, The Lead QA/agent
   8 for cybersecurity+networking, The Team Lead/agent 7 for the rest) drafts
   via `agent.queryGeminiDirect()` — free tier, persona system prompt already
   wired. The prompt hard-requires English only, a closing Sources section, a
   per-section `Confidence: high|medium|low` marker, and a
   `SPLIT_RECOMMENDATION:` reply instead of an oversized (>10-page) guide.
2. **Review/finalize** — the Architect reviews via a **direct Anthropic API
   call** (`workers/claude-client.js`, `POST api.anthropic.com/v1/messages`,
   model `claude-sonnet-5` — deliberately NOT routed through
   data-center-api's `/api/chat`, which is sized for short chat answers with
   its own model/prompt/output-token limit, not a rewritten 3-5 page guide).
   Claude is final authority, not a rubber stamp: fact-checks end to end with
   EXTRA skepticism on sections Gemini marked high-confidence, rewrites
   freely, and marks anything it can't verify `UNVERIFIED` in the published
   text rather than guessing. No Groq anywhere in this pipeline; a
   Gemini-self-QA pass was considered and rejected (Gemini checking Gemini
   finds nothing).

**Topic selection** (`selectGuideTopic()`, runs in the `guide_draft` block):
today's capability-gap reports (`reports` rows, `type='gap_hebrew'`, joined
back to the original `cases` row for platform/category) first, mapped to a
domain via `mapPlatformToDomain()`; falls back to `guides/TOPICS.md` in file
order when no gap is eligible. An **ABSOLUTE ZERO blocklist**
(`BLOCKLIST_KEYWORDS`: 1COM, MirtaPBX, Netvill, voip/sip/pbx/cloud-telephony)
is checked against both sources — the owner left that work behind
permanently, no exceptions. A rejected prior draft for the same topic
becomes an "improve this draft per its rejection note" revision task instead
of a fresh write. `guides/TOPICS.md` is stale-by-design (the owner will
rarely update it) — Windows guides in particular ONLY ever come from that
file, since neither Notebook-X nor data-center's question pool covers
Windows.

**Review outcomes**: APPROVE commits `guides/<domain>/<slug>.md` (domains:
`networking`, `firewall`, `windows`, `ai`, `linux`, `cloud`, `cybersecurity`)
via the same guarded `commitFileToRepo()` gap digests already use, and
queues any `UNVERIFIED` sections into `guides/_verification-queue.md`.
REVISE sends specific fixes back to the writer for **one revision round**,
then re-reviews (a second failure is treated as REJECT — no further
rounds). REJECT commits the draft + rejection note to
`guides/_drafts/<slug>.md` instead. **Never escalates to the owner** — this
is fire-and-forget, same posture as gap digests.

**Weekly verification** (Saturday 08:00 Israel, `guide_verify` block): pulls
1-2 items off `guides/_verification-queue.md` and runs one Claude call per
item **with the `web_search` server tool** for fresh grounding, updating the
guide and clearing the queue entry on success. **This makes Saturday no
longer a zero-API-calls day** — Saturday is still zero Q&A/simulation
activity (no case batches, no meetings, no routine Gemini/Claude asks), just
not zero Claude calls overall; see `config/daily-schedule.json`'s
`saturday_schedule` and `guides_program`.

**Budget**: a SECOND, independent Claude sub-budget alongside the Q&A
engine's — same D1 `claude_budget_usage` table, same
`workers/model-router.js` functions, distinguished by an explicit
`component: 'qa' | 'guides'` option (default `'qa'`, so every pre-existing
caller is untouched) and a distinct month key (`'YYYY-MM#guides'` vs
`'YYYY-MM'`). `config/token-economy.json`'s `guides_claude_budget` gives it
its own $4.50/mo soft-stop — total Anthropic spend is now effectively
$10/month combined with the Q&A engine's unchanged $4.50. Fail-by-skip on
exhaustion, logged; occasional skipped guide days are expected and
accepted (owner-approved cost model: ~$0.06-0.085/guide per review pass,
~1 guide/day, expected $2.50-3.50/month, all-revisions worst case ~$5.30
which DOES exceed the soft-stop by design).

**Schedule blocks** (`config/daily-schedule.json`, riding the existing
cron): Sun-Thu `guide_draft` 16:00 (after `report`, so today's gap digests
already exist) + `guide_review` 16:30; Friday `guide_draft` 10:30 (after the
Friday `report`) + `guide_review` 12:00; Saturday `guide_verify` 08:00.
**Self-healing**: given the ~2.4% tick-miss rate, `guide_review` first
checks D1 for today's draft and generates it in the same tick if missing
(one Gemini + one Claude call in one invocation, well within Cloudflare's
subrequest limit) — a missed review tick carries the draft to the next
day's review instead of silently dropping it.

**Files**: `workers/guide-engine.js` (pipeline logic — topic selection,
blocklist, prompt building, decision parsing, D1 `guide_pipeline` reads/
writes; no GitHub commits of its own, mirroring `workers/gap-reports.js`'s
split), `workers/claude-client.js` (direct Anthropic Messages API call +
real-usage spend recording), `guides/TOPICS.md`, `guides/_verification-queue.md`,
`scripts/verify-guide-engine.js` (dry-run verifier, keeps
`scripts/verify-qa-engine.js` green alongside it). The three block handlers
(`processGuideDraftBlock`/`processGuideReviewBlock`/`processGuideVerifyBlock`)
and the actual `commitFileToRepo()` calls live in `workers/agent-runner.js`.

**Permissions — nothing loosens**: `automated_code_write: false` stays as-is.
Guides are markdown content, gated the same way gap digests are
(`checkCodeWriteAllowed()` already treats `.md` as content, not code); the
Architect's review is an API call, not a repo-code write.

**Kill switch (`guides_enabled`, added 2026-08-02)**: all three guide block
handlers check a `guides_enabled` flag in SIM_KV's `simulation-state` at the
top and are logged no-ops while it's absent/false — so deploying the feature
does NOT start the pipeline; the cron's guide blocks stay inert until the
flag is explicitly flipped. Toggle without redeploy:
`POST /api/agents/trigger {"type":"guides_toggle","enabled":true|false}`.
For supervised testing, `{"type":"guide_block","block":"draft"|"review"|"verify"}`
runs ONE guide handler directly with the gate bypassed — deliberately NOT via
`{"type":"block"}`, which at 16:00/16:30 would also fire the report/standup
blocks and (on the day's last block) finalize + clear the LIVE day cycle.
Draft→review as two separate `guide_block` calls still exercises the real
cross-invocation handoff (guide state lives in D1 `guide_pipeline`).

**Before enabling these blocks live**, run one supervised end-to-end guide
cycle manually via `{"type":"guide_block","block":"draft"}` then
`{"type":"guide_block","block":"review"}` and read the resulting guide file
in full before flipping `guides_enabled` on.

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
- **Guides Claude budget** (`guides_claude_budget` in token-economy.json):
  a SECOND, independent $4.50/month soft-stop for the Guides pipeline (see
  "Guides" above) — same D1 table and `model-router.js` functions as the
  shared budget above, distinguished by `component: 'guides'` vs the
  default `'qa'`. Covers `workers/claude-client.js`'s direct Anthropic
  calls (model `claude-sonnet-5`) only; never drawn down by, or draining,
  the Q&A engine's own $4.50/mo.
- **Google AI Studio** (`GOOGLE_AI_API_KEY`) — optional, reserved for
  human-in-the-loop creative-tool sessions (Agents 9/10 building design
  assets), never called programmatically by the Worker.

### Task-type routing (added 2026-08-05) — **SHIPPED OFF**

Free-tier providers and a routing table that picks a provider by **what kind
of work a task is**, never by which agent is doing it — a persona's voice
lives in its prompts and character files, never in which key answered.

| Task type (lane) | Primary | Backup |
|---|---|---|
| Judgment / quality (QA, Lead QA, Team Lead reviews) | Cerebras | Mistral |
| Long-document processing (daily report batches) | Cerebras | Mistral |
| Hebrew composition (gap notes, summaries) | Gemini 3.1 Flash-Lite | Mistral |
| Routine volume (drafts, worker chatter) | Groq | Cloudflare Workers AI |
| Classification / routing decisions | Cloudflare Workers AI | Groq |
| Conversations & office events | **controlled random** across all non-Anthropic providers, embodiment logged | n/a |
| Embeddings / semantic search | Cohere | **none — fail, don't degrade** |
| Architect | Anthropic — **never routed, never shuffled** | n/a |

**GitHub Models was removed on 2026-08-06.** It held the judgment lane until
the supervised test's Step 1 found the service returns HTTP 410 — **fully
retired on 2026-07-30**, permanently, for all customers. Its 410 body still
claims a "temporary ... brownout"; that text is stale and outlived the
service. Do not re-add the provider on the strength of the word "temporary".
The `GITHUB_MODELS_TOKEN` secret is dead and should be deleted from the
Worker — **not** `GITHUB_TOKEN`, which is a different secret carrying repo
write scope and is still required.

> ⚠️ **Concentration risk, accepted knowingly.** Cerebras is now primary on
> **both** judgment and long-document, and both degrade to the **same**
> backup (Mistral). One Cerebras outage takes out two lanes and lands them
> together on one free tier. The intended diversification if it ever bites is
> **OpenRouter** as a third chat provider — deliberately not added now.

Secrets: `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`. *(The
scaling plan's item 3.1 predates the one-scoped-token-per-target decision and
suggested reusing the existing GitHub PAT for inference — do not re-implement
that fallback thinking it was an oversight; the provider it applied to no
longer exists in any case.)*

**Real free-tier numbers, measured 2026-08-06** (they were all `null` before
— nothing had ever been checked against a live API):

| Provider | Verified model | Rate | Per-request input |
|---|---|---|---|
| Cerebras | `gpt-oss-120b` | 1,000 req/min | **131,000 tokens** (measured) |
| Mistral | `mistral-small-latest` | 50 req/min | unknown |
| Cohere | `embed-multilingual-v3.0` | 100 req/min, **1,000 calls/month** | unknown |

Cerebras' previous model ID, `llama-3.3-70b`, **did not exist** — the third
model this project has had retired out from under it. Neither Cerebras nor
Mistral publishes a real *daily* ceiling, so `requests_per_day` stays `null`
for both and the 20s wall-clock pacing keeps applying; Cerebras' 1,440,000
daily header is just its per-minute limit × 1,440 and must not be copied into
the config. Cohere is the one provider on a **monthly** period, and its key
is a **trial** key, not a free production tier.

**Files**: `workers/task-router.js` (lane resolution, provider registry,
embodiment assignment, per-provider quota counters — imports no JSON so
`scripts/verify-routing.js` can load and *call* it), `workers/model-router.js`
(binds it to the real config and re-exports; everything above its
task-routing section is the pre-existing budget router, unchanged),
`config/model-routing.json` (the lane table as **data** — changing a lane is
a config edit, not a code edit), `config/token-economy.json`'s `providers`
block (free-tier limits), the three `workers/*-client.js` modules, and
`scripts/verify-providers.js` / `scripts/verify-routing.js`.

**Kill switch (`routing_enabled`)**: absent or false — the shipped default —
means every routed call is refused with `routing_disabled`, no provider is
contacted, and no counter or D1 table is touched. Same shape as
`guides_enabled`. Toggle without redeploy: `POST /api/agents/trigger
{"type":"routing_toggle","enabled":true|false}`. Read-back:
`{"type":"routing_status"}` (flag + resolved lanes + today's per-provider
counters, no model calls). Supervised per-lane test with the gate bypassed:
`{"type":"routing_test","lane":"judgment", ...}` — one lane per call, the
same pattern `guide_block` uses.

**No existing caller was rewired.** The daily Q&A engine, the meeting engine
and the Guides pipeline all use exactly the providers they used before.
Routing has no production caller yet; its first one is the improvement loop's
judgment-lane reviews (scaling-plan Phase 1). So flipping the switch on does
not, by itself, change any current behaviour.

**Anthropic is unreachable from routing**, enforced two independent ways: the
`architect` lane is marked non-routable and names no provider, and
`PROVIDER_REGISTRY` imports no Anthropic client, so a lane naming one fails
closed as `unknown_provider`. `verify-routing.js` proves both by pointing a
lane at Anthropic on purpose and asserting the refusal. The two pre-existing
Anthropic paths (`_askDataCenter()` via the `APP_API` binding, and
`claude-client.js` for Guides) never went through this router and are
untouched.

**The overtime rule.** Every provider here is on its free tier and stays
there. A call that would exceed a free tier is refused and logged as
`overtime_required`; the lane degrades to its backup, or skips. **There is no
automatic escalation to a paid tier, for any provider, ever** — paid usage
requires the owner's explicit, per-instance approval at the time. Providers
are refused at **60%** of a known daily cap (`soft_stop_fraction`), which is
deliberate headroom serving the scaling plan's Gate 3.

**A null limit means UNKNOWN, never unlimited.** Four providers' free-tier
numbers were not established against a live API, so they are `null` with a
note rather than a plausible invention. A provider with no known cap cannot
be count-limited, so it is limited by **wall clock** instead — a 20s minimum
spacing per provider, the same mechanism and floor as `gemini-pacer.js`.
Filling a real number into `config/token-economy.json` switches that provider
to the count check automatically, with no code change. Establishing those
numbers is step 2 of the supervised test.

**Before enabling**: run
`back-office-AI-agents/docs/procedures/ROUTING-SUPERVISED-TEST.md` end to
end. It starts by verifying that the four default model IDs still exist —
none were checked against a live catalog, and this repo has been burned twice
by a silently retired model.

## How to deploy the Worker

```bash
npx wrangler login   # or set CLOUDFLARE_API_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GITHUB_TOKEN       # optional
npx wrangler secret put GOOGLE_AI_API_KEY  # optional
npx wrangler secret put ANTHROPIC_API_KEY  # required for the Guides pipeline (see "Guides" above)
# Task-type routing (see "Task-type routing" above). Unset = that provider
# fails closed with a logged message naming the missing secret.
# GITHUB_MODELS_TOKEN is NO LONGER SET — the provider was retired 2026-07-30.
# If it is still on the Worker from an earlier setup, delete it:
#   npx wrangler secret delete GITHUB_MODELS_TOKEN
# Do NOT delete GITHUB_TOKEN above — different secret, still required.
npx wrangler secret put CEREBRAS_API_KEY
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret put COHERE_API_KEY
npx wrangler deploy
```

See `DEPLOY.md` for the full walkthrough and how to verify the deploy via
`/api/agents/status`. **Before deploying the 2026-07-18 Q&A-engine rebuild
specifically**, run the manual D1 migration noted in `database/schema.sql`
(`ALTER TABLE cases ADD COLUMN project TEXT`, etc. — `CREATE TABLE IF NOT
EXISTS` alone will not retrofit these columns onto the live database).

## How to run a simulation day manually

**`{"type":"day"}` is NON-FUNCTIONAL for a full simulated day** (confirmed
live 2026-07-19): a whole day in one Worker invocation exceeds Cloudflare's
per-invocation subrequest limit (every D1/DO/model/service-binding call
counts) and dies mid-run with "Too many subrequests". The per-block cron
design is exactly why production is unaffected — each 30-min tick is its own
invocation. The switch case still exists but don't use it for a full day.

The correct manual equivalent is running the day **block-by-block** through
the real scheduled path (`runScheduledBlock()`, KV cycle persisted between
invocations — identical mechanics to cron):

```bash
# One scheduled block (repeat per block time; dayOfWeek 1=Sun..7=Sat).
# Full-day walk (Sun-Thu): 02:00 04:30 07:00 09:30 12:00 15:00 16:00 16:30
# — the last block triggers the day finalize (summary, side plots, commit).
curl -X POST https://data-center-agents.avivnofar.workers.dev/api/agents/trigger \
  -H "X-Admin-Token: <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"type":"block","israelTime":"02:00","dayOfWeek":1}'
```

Other trigger types: `meeting` (`{"meetingType": "..."}`), `inspection`
(`{"active": true|false}`), `week_reset` (weekly reset — ALSO files weekly
reports and runs weekly/audit meetings, i.e. real model calls),
`state_reset` (2026-07-19 — clean mood/state zero for all agents, or
`{"agentId": N}` for one, INCLUDING `permanentIrritationFlags`, with NO
meetings/reports/model calls — prefer this for plain state cleanup),
`state_set` (`{"agentId": N, "state": {...}}`, whitelisted per-agent
override for supervised testing), `sync_agents` (re-sync D1 agents identity
rows from agents-config.json). See `agent-runner.js`'s
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
it). `CLAUDE-datacenter-ref.md` — a point-in-time copy of
`data-center/CLAUDE.md` — **moved 2026-08-05 to
`back-office-AI-agents/docs/reference/CLAUDE-datacenter-ref.md`** (private);
this repo keeps a one-line pointer stub at that path. It will drift, so
cross-check the live file in `data-center` for anything load-bearing.

## The three-repo split (2026-08-05)

This repo is no longer the only one. The office runs across three: this one
(`office-AI-agents`, public — the operational base **and** the public face,
where the live Worker writes its reports and guides),
`back-office-AI-agents` (private — the brain: plans, specs, session
handoffs, reference snapshots, and the campus of per-agent character files),
and `warehouse-office-AI-agents` (private — the workshop, the only place
agents may write code). **Internal planning now lives in back-office**; its
`CLAUDE.md` is the session-start protocol for that work, and
`back-office-AI-agents/plans/OFFICE-SCALING-TODO.md` is the live master plan
(this repo's `OFFICE-SCALING-TODO.md` is a pointer stub). Permissions for
all three are in `config/project-permissions.json`
(`_meta.code_write_warehouse_2026-08`) — note the warehouse code-write
exception is **documented but not yet wired** into
`workers/permission-guard.js`, which currently fails closed on both new
keys. **The office's root documents are private and live in back-office
only** — the character bible (`AGENTS-CHARACTER-CORE-v2.md`, plus the
formatting-preserved `.docx` it was transcribed from), the owner's original
Word document, and the living spec tables `PROJECT-SPEC-TABLES.md`. None of
them exist in this repo, deliberately; the bible carries a `private`
classification in its own header. Anything in this repo that needs them
names them, and names the repo they live in — it does not link a path here.

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
- `workers/model-router.js` — component-aware ('qa'|'guides') Claude budget
  tracking (D1 `claude_budget_usage`) + chore-automation model routing, and
  (2026-08-05) the binding layer for task-type routing
- `workers/task-router.js` — task-type routing: lane resolution, provider
  registry, controlled-random embodiment, per-provider quota counters (D1
  `provider_usage`, created lazily — deliberately NOT in `database/schema.sql`).
  Imports no JSON so its verifier can call it (new, ships OFF)
- `workers/cerebras-client.js` / `mistral-client.js` / `cohere-client.js` —
  the three free-tier provider clients; `provider-common.js` holds their
  shared token estimate and rate-limit header parsing (new).
  `github-models-client.js` was **deleted 2026-08-06** — provider retired
- `config/model-routing.json` — the lane table as data (new)
- `workers/guide-engine.js` — Guides pipeline logic: topic selection,
  ABSOLUTE ZERO blocklist, draft/review/verify prompt building, decision
  parsing, D1 `guide_pipeline` reads/writes (new)
- `workers/claude-client.js` — direct Anthropic Messages API client
  (model `claude-sonnet-5`), used only by the Guides pipeline (new)
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
  note for `cases.project`/`cases.kb_slug`/`reports.project`, and the
  brand-new `guide_pipeline` table (no manual migration needed — `CREATE
  TABLE IF NOT EXISTS` deploys cleanly since it's a new table, not an ALTER
  on an existing one)
- `dashboard/admin-panel.html` + `dashboard.js` — standalone admin UI
- `reports/` — generated daily/weekly/meeting/gap reports, asset-pipeline board
- `guides/` — approved guides (`<domain>/<slug>.md`), `_drafts/` (rejected
  drafts + rejection notes), `_verification-queue.md`, `TOPICS.md` (fallback
  topic list) — see "Guides" above
- `checkpoints/` — saved simulation-state snapshots before major changes
- `assets/incoming/` — raw human-in-the-loop tool exports awaiting integration
- `scripts/verify-qa-engine.js` — dry-run verification for the Q&A-engine
  rebuild (2026-07-18, new)
- `scripts/verify-providers.js` / `scripts/verify-routing.js` — dry-run
  verification for the provider clients and the routing table; both replace
  `globalThis.fetch` with a tripwire that throws, so "no network calls" is
  proven rather than claimed (new)
- `scripts/verify-guide-engine.js` — dry-run verification for the Guides
  pipeline (new)
- **The 2026-08-10 additions**, listed here because the flagged block at the top
  of this file explains why the rest of them are not:
  - `workers/office-context.js` `parseOpenQuestions()` — the office→owner
    questions channel, plus the `Dispatched:` and `Offered:` board fields.
    **Neither new board field is a state**, and neither moves a state count.
  - `workers/repo-write.js` `recordRepoWrite()` + `REPO_WRITE_TABLE_SQL` — the
    `repo_writes` table, created **lazily** and deliberately NOT in
    `database/schema.sql`, the same call `task-router.js`'s
    `PROVIDER_USAGE_TABLE_SQL` made. It records which **repository** received a
    write, which is the axis the report pipeline's consistency check was missing
    when week-07 published *"office-AI-agents: Nothing moved"* against 61
    commits. It runs after the PUT, cannot throw, and does not appear in
    `commitFileToRepo()`'s return value — a lost measurement must never cost a
    write.
  - `workers/improvement-loop.js` `case_not_asked` — an ask that never reached a
    provider is no longer written as a `case_answer`. Read
    `NOT_ASKED_EVENT`'s block for the decision, including why the 86 rows
    written before 2026-08-10 are **not** relabelled.
  - `scripts/verify-office-bureaucracy.js` §10 and
    `scripts/verify-report-pipeline.js` §12 — the proofs. §12 asserts that
    week-07's own false sentence passes without the repo axis and is refused
    with it, by the same unchanged check.
- `wrangler.toml` — Worker bindings, cron, secrets reference
- `AGENTS.md` / `PENDING-WORK.md` / `DEPLOY.md` — spec, open work, and
  deploy reference docs (`STRATEGY.md` was deleted in the 2026-07-16
  repo-cleanup session — superseded by this file)
- `PROJECT-CONTEXT-SUMMARY.md` — complete narrative history for a reader
  with no prior context (2026-07-18, new)
