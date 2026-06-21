# Token Budget — Session Queue

Tracks the next planned Claude Code sessions for this project and their
rough scope, so each session can pick up the next item without re-deriving
priorities. See `CLAUDE.md`'s "Current Strategy (authoritative)" section and
`agents/STRATEGY.md` for the framing behind this order.

## ⏳ Next

- Verify agents 7+8 received cases after redeploy. Check D1 tomorrow morning
  (`SELECT assigned_to, COUNT(*) FROM cases WHERE assigned_to IN (6,7,8,9) GROUP BY assigned_to`
  after 2026-06-21 night's run) — the Worker was redeployed 2026-06-21 to
  ship commit `3c1e684`'s per-agent case generator (had been committed but
  not deployed since 2026-06-20). See `reports/daily/STATUS-REPORT-2026-06-21.md`.

## Queue

0. **Month-1 launch run** — STOPPED by owner request at the end of Day 1
   (2026-06-11). See "Launch attempt" section below and
   `agents/reports/week-01-report.md` for the Week 1 report covering the
   partial Day 1 data. `SIM_KV.paused = true` was set as the explicit stop
   signal. Blocked on Gemini API quota/billing — needs user action before
   retry. Resume here once unblocked.

1. **UI polish + verify AI Search end-to-end** — DONE.
   Root cause found and fixed: `cloudflare-worker/worker.js` had
   `MODEL = 'claude-sonnet-4-20250514'`, which returns a 404
   `not_found_error` from Anthropic for this account — every AI
   Search/Diagnose/CLI-mode request was failing. Updated to
   `claude-sonnet-4-6` (committed `7d4dac3`, pushed). **Manual step
   still required**: redeploy `worker.js` to the `data-center-api`
   Cloudflare Worker (dashboard → Edit Code → paste → Deploy), then
   re-verify with a live `/api/chat` call. The relationship between the
   top `#search-input` (local DB only) and the AI Search tab is
   intentional/unchanged — not revisited this session.
2. **Mobile responsiveness + design optimization** — DONE.
   Reviewed existing `@media` breakpoints (640px/768px/480px): tab-nav
   horizontal scroll, off-canvas AI sidebar, AI mode selector wrap, logo
   shrink, copy-btn touch targets, and tooltip max-width were already in
   place. Fixed `#search-input`/`#ai-input`/`#admin-token-input` being
   below 16px (iOS Safari auto-zoom on focus — `font-size: 16px` override
   at ≤768px), and brought `.tab-btn`/`.filter-btn`/`.faq-pill` up to the
   44px minimum touch target (WCAG 2.5.5 / Apple HIG) at ≤768px (commit
   `122a4d4`). Verified via Playwright screenshots at 375px/768px/1280px
   — no console errors, layout intact.
3. **Consolidate agent runtime into one Gemini engine** — DONE (commit
   `b57fc99`). `agents/workers/agent-runner.js` is already a single Worker
   that role-plays all 11 personas via `instantiateAgent()` +
   `agents/config/agents-config.json` (v0.2.0, fully specified for all 11).
   `agents/README.md` and `agents/AGENTS.md` still describe agents 5-11
   with stale placeholder names — fix when next touching that folder.
4. **Test the single Gemini agent against the live app** — DONE. See
   "Launch session progress (continued)" below.
5. **Full 1-year office simulation run** — once items 1-4 are solid.

## Outstanding blocker

RESOLVED (worker redeploy). The `data-center-api` Cloudflare Worker was
redeployed with the fixed `cloudflare-worker/worker.js` (commit `1b71238`,
`MODEL = 'claude-sonnet-4-6'`) via the Cloudflare dashboard. Live
`/api/chat` test confirms a correct streaming response — AI Search/
Diagnose/CLI mode are working end-to-end. Item 4 (test the single Gemini
agent against the live app) is now unblocked.

NEW BLOCKER (Cloudflare auth). `.env.cloudflare` still has the placeholder
`CLOUDFLARE_API_TOKEN=paste-token-here`, there is no `CLOUDFLARE_API_TOKEN`
env var, and `npx wrangler whoami` reports "not authenticated". This blocks
the Part 3 deploy/smoke-test steps below — needs either a real token pasted
into `.env.cloudflare` or an interactive `wrangler login` before next
session can proceed.

## Launch session progress (2026-06-11)

Per the project owner's "Launch Decisions" prompt (cost model, sim params,
checkpoints, report tiering, stop logic, models, architecture, token
discipline — now documented in `CLAUDE.md`'s "Launch Decisions
(authoritative)" section):

- **Part 2 — brain/capability config**: DONE, committed.
  - `cloudflare-worker/worker.js`: added `web_search_20250305` tool
    (max_uses 3) + system-prompt `CAPABILITIES` block describing
    `CAPABILITY_SUGGESTION` / `LEARNED_SOURCE` structured suggestions
    (suggest-only, human-reviewed via `claude-action` Issues).
  - `agents/config/agents-config.json`: agents 5-11 (admin tier) now have
    `can_generate_assets: true`.
  - `agents/config/asset-platforms.json`: new reference list (base64
    tooling, Stitch, Google AI Studio).
  - `agents/config/year-tracker.json`: new `asset_pipeline` section
    (`generated -> tested -> optimized -> implemented`) + `stats.total_assets_by_stage`.
  - `CLAUDE.md`: added "Launch Decisions (authoritative)", "Source
    Validation (very high)", and "AI Capabilities — Self-Extension &
    Self-Education" sections; updated agents 5-11 description (Gemini
    2.5 Flash-Lite) and Infrastructure Costs.
- **Part 1 — UI changes to `index.html`**: DONE, not yet committed.
  - 1.4 Brightness/contrast pass on `:root` ("Terminal aesthetic v2.2"):
    `--bg`, `--surface`, `--surface2`, `--surface3`, `--border`,
    `--border2`, `--text`, `--text-muted`, `--text-dim` all lifted a step;
    accents unchanged.
  - 1.1 Bigger AI chat: `#ai-tab-container` height
    `calc(100vh - 160px)` / `min-height: 560px` (was `-230px`/420px;
    mobile `-130px`/480px, was `-200px`); `#ai-input` max-height 160px
    (was 96px) with larger font/padding; `#ai-send-btn`/`#ai-lang-toggle`
    bumped to 46px.
  - 1.3 CLI Mode terminal look: `#ai-tab-container.cli-active` (toggled by
    `updateAiModeCheckboxes()` via `isCliModeActive()`) gives the chat
    area/input a black-green terminal palette, `C:\>` prompt prefixes via
    `::before`, and a green caret.
  - 1.2 Solve a Case controls: new `#diagnose-controls` block (platform +
    severity chips via `selectDiagnoseChip()`, action buttons — Start
    diagnosis / Next step / Mark resolved / Escalate / Need a guide — via
    `diagnoseAction()`), shown only when `isAiModeActive('diagnose')`. New
    bilingual `AI_STRINGS` entries added.
  - Verified: `node --check` on the extracted `<script>` block passes,
    `node .github/scripts/validate-json.js` passes (data files untouched).
    Not yet verified in a real browser — do a quick `python -m http.server
    8080` smoke check (desktop + 375px) before/after committing if possible.
- **Part 3 — deploy + smoke test**: BLOCKED, see "NEW BLOCKER" above. Not
  started — no D1 check, no secrets check, no `wrangler deploy`, no smoke
  test yet.

**Next session**: (1) get Cloudflare auth working (user provides a real
`CLOUDFLARE_API_TOKEN` or runs `wrangler login`), (2) run Part 3 exactly per
`OFFICE-PROJECT-BRIEF.txt` section 5 — D1 schema check/apply, confirm
`GEMINI_API_KEY`/`ADMIN_TOKEN` secrets on `data-center-agents` (ask user for
values, don't invent), `npx wrangler deploy` from `agents/`, smoke test
`/api/agents/status` (expect 11 agents, no 500s) — **no cron triggers, no
simulation start**, (3) once deploy is verified: item 4 above (single-agent
test against the live app), then the full quarter launch.

### Docs cleanup while Part 3 is blocked

While blocked on Cloudflare auth, fixed the staleness CLAUDE.md flagged in
`agents/README.md`/`agents/AGENTS.md` (old two-Worker design, wrong agent
5-11 names): both now describe the consolidated `agent-runner.js` Worker
and the correct agents-config.json v0.2.0 roster (IT Chief, QA, Team Lead,
Lead QA, Designer, Architect, CEO). Also fixed `agent-reports.yml` /
`generate-weekly-report.mjs`, which still pointed at a `/run/week` endpoint
on a separate `AGENTS_SCHEDULER_BASE` scheduler Worker that no longer
exists — now call `agent-runner.js`'s `/api/agents/trigger
{"type":"week_reset"}`. And aligned `simulation-config.json`'s
`PERMISSIONS` block with each agent's actual `clearance`. Two commits, not
yet pushed — pending review per the pause-before-push rule.

## Launch session progress (continued, 2026-06-11)

Cloudflare auth blocker RESOLVED (`wrangler whoami` now authenticated). Steps
0-5 of `OFFICE-PROJECT-BRIEF.txt` section 5 are now done:

- **Step 1 (D1 schema/seed)**: schema tables already existed; `agents` and
  `cases` tables were empty. Applied `agents/database/seed-cases.sql`
  (11 agents + 12 sample cases) — first time, safe (was empty).
- **Step 2 (secrets)**: `GEMINI_API_KEY` and `ADMIN_TOKEN` were already set
  on `data-center-agents` from an earlier deploy. Rotated `ADMIN_TOKEN` to a
  new value (given to the user out-of-band for the in-app Admin tab's
  `dc-admin-token`; not stored in this repo).
- **Step 3 (deploy)**: Worker was already deployed (2026-06-11T14:01 UTC).
- **Step 4 (smoke test)**: `GET /api/agents/status` with `X-Admin-Token`
  returns `200` with all 11 agents (ids 1-11), correct names from
  `agents-config.json` v0.2.0, mood/irritation/status fields present.
- **Step 5 (single-agent test)**: ran `POST /api/agents/run` for agent 3
  (Standard Agent, Phase 1 dedicated class) and agent 6 (QA, Phase 2
  `agent-stub.js`), each against a real seeded case.
  - **Found and fixed a real bug**: the first attempt for both agents
    returned `{"ok":false, "response":"error code: 1042"}` —
    Cloudflare blocks a Worker from `fetch()`-ing another Worker's
    `*.workers.dev` URL directly. `interactWithApp()` in
    `agents/agents/agent-base.js` was calling
    `https://data-center-api.avivnofar.workers.dev/api/chat` via plain
    `fetch()`. Fixed by adding a service binding (`agents/wrangler.toml`:
    `[[services]] binding = "APP_API" service = "data-center-api"`) and
    updating `interactWithApp()` to use `env.APP_API.fetch()` when present
    (falls back to plain `fetch()` for local dev). Redeployed
    `data-center-agents` (version `84f6c805`).
  - After the fix, both agents got real Claude responses (`ok:true,
    quality:1`) via the live app, and `agent_sessions`/`interactions` rows
    were written correctly to D1. Agent 3 also filed a Gemini-generated
    status report (`reports` table).
  - **Open question still unresolved** (per `AGENTS.md`): agent 6's run
    confirms `agent-stub.js` mechanically works (session/interaction
    recording, config-driven app-usage rate, real app responses) for a
    Phase-2 "specified" agent, but it doesn't produce the
    persona-specific Gemini reports/state transitions that Phase-1 agents
    (1-4) do. Whether that's "good enough" for launch or needs Phase-1-style
    state machines for 5-11 is still an open decision.
- Test runs left 4 rows in `agent_sessions`/`interactions` (2 from the
  pre-fix 1042 failures, 2 from the post-fix successes) and 1 row in
  `reports` — harmless test data, not cleaned up.

**Not yet done**: Step 6 (index.html `AGENTS_SCHEDULER_BASE` cleanup — grep
usages first, per the brief), Step 7 (cron triggers — needs explicit user
sign-off, starts real recurring cost), Step 8 (doc/code gaps:
`evaluateResponseQuality()`/`getDbContext()` placeholders, missing
`weekly_analytics` population, no `POST /api/agents/reports/:id/ack`
endpoint).

## Pre-launch readiness check (2026-06-11, no simulation run)

Per request, audited readiness for the office simulation WITHOUT triggering
`runWorkDayCycle`/`runWeeklyResetCycle` (those make ~50 Gemini calls +
many Claude calls per simulated day — explicitly not run this session).

- **Step 6 done**: `AGENTS_SCHEDULER_BASE` in `index.html` CONFIG was
  confirmed dead (grep showed only `AGENTS_API_BASE` is used at lines
  3263/3272/3375) — removed the unused key.
- **Static checks, all clean**: `node --check` on every file in
  `agents/workers/*.js` and `agents/agents/*.js` (no syntax errors);
  module resolution already proven by the successful `wrangler deploy`
  (esbuild would fail on missing imports/exports); SQL column names in
  `meeting-engine.js` cross-checked against `schema.sql` — all match.
- **CRM case generation is safe to run**: `crm-engine.js` IDs
  (`crm-<year>-w<week>-d<day>-<n>`) can't collide with seeded `case-XXXX`
  rows, and `persistCrmCases()` uses `INSERT OR IGNORE`.
- **Empty `year_stats`/`SIM_KV` are handled gracefully**: `getYearState()`
  seeds from `year-tracker.json` if no row exists; `getSimulationState()`
  defaults to `paused: false` if `SIM_KV` is empty (current actual state).
- **`GITHUB_TOKEN` absence is a clean no-op** everywhere it's checked
  (`agent-runner.js`, `meeting-engine.js`, `scheduler.js`).
- **Flagged, not fixed (design question, not a bug)**: `simulation-config.json`
  `TIME_SCALE.real_hours_per_work_week: 24` ("24h = 1 work week of 5 days")
  doesn't match the actual cron design in `agent-runner.js`'s `scheduled()` —
  hourly cron = 1 simulated day, daily cron = reset cycle covering the last
  24h via `getWeeklyCasesHandled()`'s hardcoded 24h lookback (i.e. ~24
  simulated days per "weekly" reset, not 5). `TIME_SCALE` isn't read by any
  code (only referenced in a comment), so this is harmless today but worth
  reconciling — pick the real intended cadence — before finalizing the
  cron strings in Step 7.

**Verdict**: code is ready for a manual `runWorkDayCycle` test (or Step 7
cron) from an infra/correctness standpoint. The cron-cadence question above
and the agent-stub.js "good enough for 5-11" open question (Step 5) are the
two remaining product decisions before Step 7.

## Launch attempt — Month 1, Day 1 (2026-06-11)

Per the project owner's launch prompt, ran preflight (all green: D1 schema
complete, `data-center-agents` deployed at version `84f6c805` with the
service-binding fix, `GEMINI_API_KEY`/`ADMIN_TOKEN` secrets present, models
correct). **`ADMIN_TOKEN` was rotated** this session (new value given to the
user directly in chat — update `dc-admin-token` in the dashboard).

Triggered `POST /api/agents/trigger {"type":"day"}` as a smoke test (this
code path — `runWorkDayCycle()` — had never run end-to-end before). Result:
**HTTP 500 after 449s** — `Gemini API error (429): "You exceeded your
current quota, please check your plan and billing details"`.

- **Root cause**: `GEMINI_API_KEY`'s Google AI Studio project hit a 429
  quota/billing limit on `gemini-2.5-flash-lite` partway through day 1's
  case loop (47 of 50 cases processed). `gemini-client.js` has no
  retry/backoff, so the first 429 became a 500. CLAUDE.md assumes a "paid"
  Gemini tier — this key appears to be on free-tier limits, or the daily
  free quota was already partly used by prior testing sessions.
- **Cost**: negligible. Gemini calls cost $0 (free tier). 26 real Claude
  (`data-center-api`) calls succeeded (25 search + 1 diagnose) — estimated
  ~$0.10-0.50 total. Nowhere near the $5 cap.
- **Partial D1 state for day 1** (crm-2026-w01-d1-001..050): 50 cases
  persisted, 47 `agent_sessions`, 26 `interactions`, 10 status reports
  (agent 3). `year_stats` has 0 rows — day 1 never officially completed.
  Full diagnostic snapshot: `agents/checkpoints/month-01/day-01-attempt.json`.
- **Before retrying day 1**: (1) resolve the Gemini quota/billing issue —
  check https://aistudio.google.com billing for this key's project; (2)
  decide whether to clean up the 47 partial day-1 sessions/interactions/
  reports (crm-2026-w01-d1-*) before a clean retry, since `runWorkDayCycle`
  has no "already processed today" guard and would reprocess all 50 cases
  on a second attempt; (3) consider adding retry/backoff to
  `gemini-client.js` before the next attempt (not done this session — no
  behavior changes during the run, per CLAUDE.md).

**Per the HARD RULES** ("HALT only if unfixable after retries, or cost cap
hit"), this halted the run — the quota/billing issue is unfixable from
within this session. Days 2-20 and month-end were not attempted.

**Owner instruction (same session)**: stop the experiment at the end of
Day 1 and write a report on the first week/period. Done — set
`SIM_KV.paused = true` via `POST /api/simulation`, wrote
`agents/reports/week-01-report.md` (public/private/special tiers covering
the 47/50-case partial Day 1), and removed the temporary `agents/_day1_*.json`
scratch files used to gather the report data.

## Daily automation + AI-tool coordination build (2026-06-12)

Per the project owner's "autonomous architect" prompt (build the DAILY
AUTOMATION + SCHEDULING SYSTEM, config + wiring only, no cron, no live
run this session). Preflight was green (CLAUDE.md Current Strategy +
Launch Decisions read, `agents/config/*.json` reviewed, `git log` clean
on Week-1-stop commit `1c14a12`).

- **Part 1 — `agents/config/daily-schedule.json`** (NEW): tactical 24h
  cycle. Work 08:00-16:00, overtime 16:00-18:00. Day-type mapping
  (1=Sun..5=Thu full work days with 5 case-batches at 0.30/0.20/0.20/0.20/0.10
  share, daily standup, tool-task window, AI-experience report, spare time;
  6=Fri short day with 2 batches + weekly summary meeting at 12:00; 7=Sat
  off, `force_idle:true`, zero API calls). `model_education_program`
  (quality threshold 0.6, max 3 case studies/day) and
  `weekly_summary_program` (3 Friday outputs: summary.md, data.csv,
  public-summary.md) defined. `_meta.case_volume_design_note` documents
  the existing ~50/day CRM pool being *partitioned* by `case_share`, not
  multiplied.
- **Part 2 — `agents/config/ai-tools.json`** (NEW): tool-access matrix.
  NotebookLM (primary: Agent 6/QA), Stitch (Agents 9+10, joint-only),
  Base44 (all admins, preferred 9/10), Google AI Studio (Agents 9+10).
  `weekly_rotation` Sun-Thu maps each day to one tool + agent(s) + session
  mode, staggered to avoid conflicts/token exhaustion.
- **Part 3 — asset pipeline seeded** (NEW): `agents/reports/asset-pipeline/board.json`
  + 4 spec files in `agents/reports/asset-pipeline/issues/`:
  `qa-knowledge-base.md` (Agent 6 NotebookLM DB build — goal: app answers
  almost exclusively from QA-built knowledge bases, very-high source
  scrutiny applies), `archives-app.md` (joint 6+9+10, "archive mentality"
  + thin AI brain, reuses data-center-archive concepts), `designer-tooling-suite.md`
  (Agent 9, free design tools), `architect-org-products.md` (Agent 10,
  org-facing products, joint w/ Designer for important ones). CRM flagged
  as `not_scheduled:true` placeholder in board.json. CLI tools: added
  `data/modules.json` "coming-soon" stub (`id:"cli"`) + CLAUDE.md "Future
  Assimilation: CLI Tools" section — not built.
- **Part 4 — `agents/workers/agent-runner.js` wiring**: `runWorkDayCycle`
  now reads `daily-schedule.json`/`ai-tools.json` via `getDaySchedule()`,
  partitions cases via `partitionCasesByShare()`, runs each batch through
  `processCaseBatch()` (logs low-quality interactions for model-education
  case studies), then iterates the day's schedule blocks: tool-task window
  -> `maybeOpenAssetTask()`, report block -> `runDailyAiExperienceReports()`,
  spare time -> `runSpareTimeForAgent()` (20% coworker-interaction / 80%
  idle, Saturday always idle/zero calls), Friday weekly_summary ->
  `generateWeeklySummary()` + `checkProductVersionBumps()` (+0.01 per
  shipped weekly product, tracked in `year-tracker.json` `stats.product_versions`).
  `commitFileToRepo` now sha-aware (create+update); new `fileGitHubIssue`/
  `fileAssetTaskIssue`/`fileModelEducationIssue`/`fetchAssetBoard` helpers
  — all no-op cleanly without `GITHUB_TOKEN` (confirmed absent this
  session), queuing to D1 `reports`/board.json instead. `agent-base.js`
  gained `fileModelEducationCaseStudy()`. `renderDailySummary()` gained a
  "## Daily Schedule" section via new `renderScheduleSection()`.
  Validated: `node --check` clean on both files, all touched JSON files
  parse, `validate-json.js` passes (11 modules, 27/15/12/10 entries).
- **Part 5 — docs**: CLAUDE.md gained "## Daily Automation & AI-Tool
  Coordination" (schedule, tool matrix, asset pipeline, weekly summary,
  version-bump rule, status note) and "## Future Assimilation: CLI Tools".

**No cron added.** `SIM_KV.paused` stays `true` from the Week-1 stop as of
the build itself; see the launch attempt below for what happened after.

## Launch attempt — schedule-driven day, take 2 (2026-06-11, ~23:08 UTC)

With explicit owner sign-off, generated a fresh `ADMIN_TOKEN`
(`wrangler secret put ADMIN_TOKEN --name data-center-agents` — new value
given to the owner directly in chat, update `dc-admin-token`), confirmed
`/api/agents/status` healthy (11 agents), unpaused via `POST
/api/simulation {"paused": false}`, then triggered `POST
/api/agents/trigger {"type":"day"}`.

- **Result: HTTP 500 after ~146s** — same `Gemini API error (429):
  "You exceeded your current quota..."` as the 2026-06-11 Month-1 Day-1
  attempt (see above), but failing **3x faster** (146s vs 449s) and
  **before any new D1 writes** — `cases` count unchanged (62), `reports`
  unchanged (10 status rows, latest timestamp 21:56 UTC — *before* this
  run), `year_stats` still empty.
- **Root cause confirmed**: this is the *same* exhausted daily quota from
  the 2026-06-11 ~21:55-21:58 UTC attempt, not a new/separate issue. Google
  AI Studio free-tier daily quotas reset at midnight Pacific Time
  (~08:00 UTC / ~11:00 Israel time) — at 23:08 UTC June 11 that reset had
  **not yet happened**, so the key was still exhausted from ~1h10m earlier.
  This run hit the limit on essentially its first Gemini call, hence the
  much faster failure.
- **Immediately re-paused** (`SIM_KV.paused = true`) — no further calls
  attempted. Cost: effectively $0 (the 429 fires before any Claude
  `data-center-api` calls in the case-batch loop).

**Per HARD RULES / Launch Decisions stop logic** ("halt only if unfixable
after retries, or cost cap hit"): this is unfixable from within a session —
it requires either (a) waiting past the daily quota reset (~08:00 UTC /
~11:00 Israel time) before retrying, or (b) the owner checking/upgrading
billing for this `GEMINI_API_KEY` project at
https://aistudio.google.com (CLAUDE.md assumes a "paid" tier; this key's
behavior — hard daily cap, fast exhaustion — looks like free tier).

**Next session**: (1) confirm it's past the quota reset window, (2) retry
`POST /api/agents/trigger {"type":"day"}` (unpause first) — if it again
fails near-instantly with 429, the key is not on the paid tier the cost
model assumes and needs an owner-side billing fix before any further
attempts; (3) separately, consider adding retry/backoff + request-rate
limiting to `gemini-client.js` (flagged twice now, still not implemented —
no behavior changes were made *during* either run, per the rules, but this
is a between-runs code fix candidate for a future session).

## Per-block cron wired (2026-06-12)

Per owner request ("set the automation to start tomorrow morning at
8:00-17:00 israel time") and two explicit architecture choices —
**"Multiple crons across 08:00-17:00 IST"** and **"Schedule the cron for
11:00 IST instead (Recommended)"** (the latter for the *quota-reset* angle,
see below) — re-architected `agent-runner.js` from a single
`runWorkDayCycle()` call per cron tick to a per-block dispatcher driven by
`agents/config/daily-schedule.json`:

- **New `israelTimeParts(date)`**: converts `event.scheduledTime` (UTC) to
  `{ time: "HH:MM", dayOfWeek }` Israel local time. `ISRAEL_UTC_OFFSET_HOURS
  = 3` (IDT). **DST CAVEAT**: when Israel switches to IST (UTC+2, ~late Oct)
  or back to IDT (~late Mar), this constant AND `wrangler.toml`'s cron
  window must both be updated by 1 hour — flagged in both files.
- **New `runScheduledBlock(env, israelTime, dayOfWeek)`**: looks up
  `daily-schedule.json`'s blocks for `dayOfWeek`; no-ops if nothing is due
  at `israelTime`. On the day's first due block, generates+persists the
  day's CRM cases and partitions them into `case_batch` blocks (mirrors the
  old `runWorkDayCycle` setup). Persists a day-in-progress "cycle" to
  `SIM_KV` key `daily-cycle-state` between ticks. On the day's last due
  block, calls `finalizeScheduledDay()` (mirrors the old `runWorkDayCycle`
  tail: agent summary, side plots, year-stats, daily report commit) and
  clears the cycle.
- **New `logScheduledError(env, {...})`**: per-block try/catch — any error
  (e.g. Gemini 429) is logged as a `reports` row (`type='incident'`,
  `agent_id=10` "The Architect", `severity='warning'`) and the tick moves
  on. A failed `case_batch` block's cases are simply not processed that day
  (logged, not retried) — acceptable for now per the "contained, non-cascading"
  stop-logic reading; flagged as a known limitation.
- **`agents/config/daily-schedule.json`**: `saturday_schedule`'s single
  block moved from `"00:00"` to `"08:00"` — the new cron window
  (05:00-13:30 UTC = 08:00-16:30 IDT) never covers midnight, so the
  Saturday idle block needed to land inside the window (it's both the
  first and last block, so it still inits+finalizes in one tick).
  `_meta.cron_status` updated to "WIRED".
- **`agents/wrangler.toml`**: added `[triggers]\ncrons =
  ["*/30 5-13 * * *"]` — every 30 min, 05:00-13:30 UTC = 08:00-16:30 IDT,
  covering every block time in `full_day_schedule`/`friday_schedule`
  (08:00-16:00 IDT) and the relocated Saturday block (08:00 IDT) with a
  single cron entry (avoids per-block cron-count concerns).
- **Deployed** via `wrangler deploy` — cron confirmed active
  (`schedule: */30 5-13 * * *`). Simulation was **left paused**
  (`SIM_KV.paused = true`, confirmed before deploy) — the cron will fire on
  schedule starting tomorrow morning but `runScheduledBlock` returns
  `{skipped: true, reason: 'paused'}` for every tick until unpaused.

**Open item re: "11:00 IST" quota-reset choice** — `full_day_schedule`'s
first block is still `08:00` (case_batch, 30% share). With the cron live,
the 08:00 IDT tick *will* fire and attempt that batch even if the Gemini
quota hasn't reset yet (~11:00 IST per the take-2 attempt above). Per-block
error containment means a 429 there is logged and contained (doesn't crash
the day), but that batch's cases won't be processed. **Next session,
before unpausing**: either (a) accept this — the 09:30/11:00+ batches will
likely succeed once quota resets, only the 08:00 batch (30% of the day) is
at risk on day 1; or (b) reorder/shrink the 08:00 block's `case_share`
temporarily for the first live day. Decide with the owner before flipping
`paused: false`.

## CommandFlow / Terminal Academy import (2026-06-12)

Per the owner's "autonomous architect" prompt: imported the externally-built
(Stitch + Base44) "Terminal Academy" export
(`agents/assets/incoming/commandflow/code.html` + `DESIGN.md` + `screen.png`
— moved here from a misplaced `agents/agents/assets/...` path) as the
**first completed human-in-the-loop asset-pipeline product**, end to end.
No Gemini/Claude API calls made this session (build-only, per the cost-guard
note in the prompt).

- **Standalone product** — new `tools/commandflow/`: `index.html` (full
  Stitch "Terminal Academy" design — glassmorphism, traffic-light terminal
  headers, Inter + JetBrains Mono, sidebar platform nav), shared
  `commandflow-core.js` engine (`CommandFlow.loadDb/run/...`, dependency-free,
  smoke-tested via node), `commands.json` (7 platforms: Bash, PowerShell,
  Cisco, Cloud, Networking, Security, Databases; ~10-17 commands each,
  generic `help`/`clear`/`cls`), and `README.md`. Registered in new
  `data/tools.json` (outside `validate-json.js`'s scope — confirmed safe) and
  linked from the main app's topbar (`#commandflow-link`).
- **CLI Mode integration** — `index.html`: `#cli-controls` platform-chip row
  (7 chips, bilingual via new `AI_STRINGS.cliPlatform*` keys), loads
  `tools/commandflow/commandflow-core.js` via a new `<script src>` tag.
  `sendAiMessage()` now calls `tryRunCliCommand(text)` when
  `isCliModeActive()`: recognized commands render as a code block in chat
  (zero `data-center-api` cost), `clear`/`cls` clears the chat via
  `clearCliScreen()`, anything unmatched falls through to the existing Claude
  streaming path unchanged. In-app styling stays the existing
  green-on-black/`C:\>` aesthetic — standalone keeps the full Stitch look
  (same engine/data, different skin, per owner decision). Verified
  `node -e "new Function(...)"` on the extracted `<script>` block — no syntax
  errors. **Not verified in a real browser this session** (no
  Playwright/devtools tool available) — do a quick `python -m http.server
  8080` smoke check (AI Search tab -> CLI Mode -> try `ls`, `help`, `clear`,
  an unknown command) before/after pushing if possible.
- **Asset pipeline** — `agents/reports/asset-pipeline/board.json`: new
  `commandflow` item, stage `returned`, owners `[9, 10, 6]`
  (Designer/Architect/QA), with `origin` recording the Stitch+Base44 source
  and `agents/assets/incoming/commandflow/` path. New spec file
  `agents/reports/asset-pipeline/issues/commandflow.md` with full
  Designer/Architect/QA review tasks + acceptance criteria (design review of
  in-app CLI styling, architecture/optimization assessment, cross-platform QA
  + NotebookLM-shared-source recommendation).
- **CLAUDE.md** — "Human-in-the-loop asset pipeline" section gained a
  "First completed import — `commandflow`" subsection documenting it as the
  **reference pattern** for future tool imports. "Future Assimilation: CLI
  Tools" section rewritten: CLI Mode now describes the live CommandFlow
  integration; the `data/cli.json` "coming-soon" module stub is now
  explicitly scoped as a *separate*, unrelated future bilingual command-card
  module (doesn't block or relate to CommandFlow).
- **GitHub Issues not filed** — `gh` CLI is unavailable in this environment
  (`GITHUB_TOKEN`-based filing is the simulation's job, not this session's).
  The board item (stage `returned`) + `commandflow.md` spec file are the
  queue; a future session (with `gh` or once the simulation runs a
  `tool_task_window`) should file the 3 `asset-task` + `claude-action` +
  `AGENT-9`/`AGENT-10`/`AGENT-6` issues from `commandflow.md`.

**Commits**: separate commits for `tools/commandflow/` + `data/tools.json`,
`index.html` (CLI Mode integration + topbar link), `agents/reports/asset-pipeline/`
(board.json + commandflow.md), and `CLAUDE.md` + this file. **Paused before
push** per the Autonomous Brain Rules — awaiting owner review.

**Next session**: resume queue item 0/5 — continue the office simulation
(quota-reset retry / unpause decision per "Per-block cron wired" above), and
optionally pick up the CommandFlow review tasks in `commandflow.md` once
agents are running again.

## AI Search hardening session (2026-06-13)

Autonomous session focused on making the AI Search bar reliable before the
owner starts a new job. Six-part plan, Parts 1-3 + 5-6 completed, Part 4
cleanly skipped.

- **Part 1 (app health check)** — sent the 10 required IT-troubleshooting
  queries directly to `data-center-api` (mode=search, en, no db_context).
  **All 10 scored 5/5** — `claude-sonnet-4-6` streaming correctly,
  `CONFIG.WORKER_URL` confirmed correct. No `data/*.json` fixes were
  triggered (no score <4).
- **Part 2 (database expansion)** — added 38 new bilingual entries:
  `linux.json` +15 (42 total: nice-renice, pgrep-pstree, vmstat, awk, sed,
  tail, dmesg, fail2ban, auditd-ausearch, who-w, lsblk, fdisk, smartctl,
  ncdu, iotop), `cmd.json` +10 (25 total: nbtstat, net-start-stop, fsutil,
  auditpol, pathping, systeminfo, driverquery, gpresult, whoami,
  test-netconnection), `network.json` +8 (20 total: tshark, ufw,
  windows-firewall, telnet, ethtool, getent, nmcli, host), `troubleshoot.json`
  +5 (15 total: ts-vpn-internal, ts-web-unreachable, ts-high-memory,
  ts-ad-login, ts-ssl-cert). `validate-json.js` and `health-check.js` both
  pass clean (102 total entries across the 4 files).
- **Part 3 (system prompt optimization)** — `cloudflare-worker/worker.js`
  `systemPrompt()`: added a "LOCAL DATABASE QUICK REFERENCE" block so Claude
  cites DB commands even with empty `db_context`; SEARCH mode now always
  ends with "Relevant commands to check:" + `RELATED_COMMANDS:`; DIAGNOSE
  mode is now "one question + one command + what output did you get?" per
  turn; Hebrew mode gets an explicit 2-4-paragraph conciseness instruction.
  Also bumped `MAX_TOKENS` 1024 → 1536 and added a "compact chat UI, avoid
  heavy markdown" instruction — at 1024 the new "Relevant commands to
  check:" closing line was frequently truncated mid-sentence on verbose
  answers. Redeployed via `npx wrangler deploy worker.js --name
  data-center-api --compatibility-date 2024-01-01` (no `wrangler.toml` in
  `cloudflare-worker/` — deploy with an explicit entry file + compat date).
  Re-tested the SSH query post-deploy: compact answer, correctly ends with
  `Relevant commands to check: journalctl, systemctl, ss` +
  `RELATED_COMMANDS: journalctl, systemctl, ss`.
- **Part 4 (office day-2 simulation) — SKIPPED.** `wrangler secret list
  --name data-center-agents` confirms `ADMIN_TOKEN`/`GEMINI_API_KEY` are
  configured, but this session has no way to read the `ADMIN_TOKEN` value
  (by design — see CLAUDE.md "Admin auth"), so it cannot call
  `/api/agents/run`/`/api/agents/trigger` even to test Gemini quota. Zero
  Gemini/Claude-simulation calls made, cost $0. See
  `agents/reports/model-training/day-02-2026-06-13.md`. Simulation remains
  paused (`SIM_KV.paused = true`, unchanged from 2026-06-12).

**Next session**: (1) if the owner wants the office simulation resumed,
provide the current `dc-admin-token` so a session can check
`/api/agents/status` and quota health before unpausing; (2) otherwise,
continue UI/AI-quality polish — current AI Search quality is high (10/10 on
the test set) so this is now lower priority than before.

## Distributed AI architecture + automation session (2026-06-13)

Autonomous architect session. RTL/Hebrew audit found nothing actionable
(existing convention is consistent project-wide). Committed two pending
changes (`46a9923` radio-style AI mode selector + the prior CF Workers AI
fallback commit `9a9d3b7`), then implemented the distributed-AI fix for the
recurring Gemini 429 problem and wired up scheduled automation.

- **Distributed AI architecture** (`agents/config/token-economy.json` v0.2.0)
  — routine per-case agent work (agents 1-4, 5-9, 11) now runs on **Groq**
  (`llama3-8b-8192`, `agents/workers/groq-client.js` `callGroq()`, free tier
  ~14,400 req/day) instead of Gemini. **Cloudflare Workers AI**
  (`@cf/meta/llama-3.1-8b-instruct-fp8`, account-scoped `AI` binding) does
  lightweight case routing/classification (`callCFRouter()`, called once per
  case in `processCaseBatch()`) and is the same-session fallback when Groq is
  unavailable or **Gemini 2.5 Flash-Lite** returns 429. Gemini stays reserved
  for monthly/quarterly/semi_yearly/yearly report synthesis
  (`meeting-engine.js` `runMeeting()`, routed via
  `report_models_by_meeting_type`) — all other meeting types (daily standup,
  weekly, emergency huddle, audits, coaching, PIP) now use Groq too. The
  app's AI Search bar is unaffected (`data-center-api`, `claude-sonnet-4-6`).
  **Agent 10 (The Architect)** never calls an AI model for routine cases
  (`architect_model: "human+claude-code"`) — `processArchitectCaseBatch()`
  logs sessions for mood/state bookkeeping only and files each batch of
  root-level escalations as a single `claude-action` + `architect-task`
  GitHub Issue for human/Claude-Code review.
  - **Note on `token-economy.json` `report_model`**: set to
    `"google/gemini-2.5-flash-lite"`, not the originally-specified
    `"google/gemini-1.5-flash"` — CLAUDE.md's "Launch Decisions" pins
    `gemini-2.5-flash-lite` project-wide and `gemini-1.5-flash` does not
    appear anywhere else in the codebase.
  - `agents/database/schema.sql`: `interactions` table gained an additive
    `model_source TEXT` column (`agent-base.js` `logInteraction()` now
    records `groq` / `gemini` / `cloudflare-fallback` / `cloudflare-router` /
    `claude` per interaction). **Existing D1 databases need this column
    added** (`ALTER TABLE interactions ADD COLUMN model_source TEXT;`) before
    the new code paths run against them — schema.sql alone does not migrate
    a live D1 instance.
  - `agents/wrangler.toml` secrets comment block updated: `GROQ_API_KEY`
    (required) and `GOOGLE_AI_API_KEY` (optional, reserved for report
    tooling) added alongside `GEMINI_API_KEY`/`ADMIN_TOKEN`/`GITHUB_TOKEN`.
- **GitHub Actions automation** — new `.github/workflows/scheduled-claude.yml`
  runs on 3 UTC schedules (23:30, 04:30, 18:30, Sun-Thu only) plus
  `workflow_dispatch`, calling the Anthropic API directly (`claude-sonnet-4-6`,
  not the Claude Code CLI) with `ANTHROPIC_API_KEY`/`GROQ_API_KEY`/
  `GOOGLE_AI_API_KEY` from repo secrets, parses a JSON `{files, commit_message,
  summary}` response, writes the files, commits, `git pull --rebase` +
  `git push origin master`, and appends a one-line session log to this file.
  One fix vs. the original spec: added explicit `SESSION_TYPE`/`TASK` env
  vars to the "Run Claude task" step (sourced from the "Determine session
  type and task" step's outputs) — without them `process.env.TASK` would
  always be undefined and every run would fall back to the default prompt.
  **⚠️ This workflow auto-pushes to `master` 3x/day once the three secrets
  exist in GitHub Actions** — the in-prompt "$5 Claude API cap" is an
  instruction to the model, not an enforced limit. Recommend the owner set a
  real Anthropic usage cap/alert before (or shortly after) adding
  `ANTHROPIC_API_KEY` to repo secrets.
- **Day 3/4 office rules** (`agents/config/simulation-config.json`) — added
  `day_3_rules` (max case resolution via app usage emphasis,
  `collaboration_agents_case_share: 0.20` for agents 6/7/8, Architect/Designer
  planning-only after cases complete, `new_features: "BLOCKED"`) and
  `day_4_rules` (same pattern). Simulation itself remains paused
  (`SIM_KV.paused = true`) — these rules take effect once unpaused.
- **Next automated session times** (once `scheduled-claude.yml` secrets are
  configured): 23:30 UTC (office Day 3 night session), 04:30 UTC (office Day
  3/4 morning continuation), 18:30 UTC (daily maintenance — next
  `TOKEN-BUDGET.md` queue item).

**Commits**: separate commits for (1) the workflow file, (2) the
distributed-AI files (`agents/workers/groq-client.js`,
`agents/workers/gemini-client.js`, `agents/workers/meeting-engine.js`,
`agents/workers/agent-runner.js`, `agents/agents/agent-base.js`,
`agents/config/token-economy.json`, `agents/database/schema.sql`,
`agents/wrangler.toml`), and (3) `agents/config/simulation-config.json` +
this file. **Paused before push** per the Autonomous Brain Rules — awaiting
owner review, especially of the recurring-billing implications of Task 2.

**Next session**: (1) confirm `GROQ_API_KEY`/`GOOGLE_AI_API_KEY` Worker
secrets were set on `data-center-agents` (Task 4, this session) and rotate
both keys (they were pasted into chat); (2) if/when `master` is pushed, run
`ALTER TABLE interactions ADD COLUMN model_source TEXT;` against the live D1
`data-center-db`; (3) decide whether to add the three secrets to GitHub
Actions to activate `scheduled-claude.yml`, with a real Anthropic spend cap
in place first.

## Daily automation fixes + Netvill VoIP/SIP expansion (2026-06-14)

Follow-up session addressing the failed 11:47 UTC auto-session above and
applying the day's maintenance scope.

**Automation fixes (Task 0)**:
- Removed junk files `run_claude.js` and `claude_error.txt` (tracked
  artifacts from the failed run) and the untracked scratch file
  `AUTOMATION-STATUS.md`.
- Extracted the inline Anthropic-API call into
  `.github/scripts/run-claude-session.js`, which now writes
  `claude_error.txt` on any non-200 response or JSON-parse failure (not just
  silently failing).
- Added `.github/scripts/commit-and-log.sh`, a shared commit/log step that
  only writes "completed" to this file when `claude_result.json` actually
  exists; otherwise it logs `failed: auth_error` / `failed: api_error` /
  `failed: no output` honestly.
- Rewrote `.github/workflows/scheduled-claude.yml` into three explicit jobs —
  `night-office` (cron `30 23 * * 0-4`), `morning-office` (cron
  `30 4 * * 0-4`), and `maintenance` (cron `30 18 * * 0-4`, reads the
  `## ⏳ Next` item above via grep) — replacing the old wall-clock-hour
  session-type guess. All three also support `workflow_dispatch` with a
  `session_type` choice for manual runs.
- Replaced the misleading `- ... Auto-session: maintenance — completed` line
  for the 11:47 UTC run (above) with an honest `FAILED (authentication_error
  ...)` note.
- **GitHub Actions `ANTHROPIC_API_KEY`**: `gh` CLI is not available in this
  environment, so the secret could not be verified or the workflow
  re-triggered directly — needs a manual check (Settings → Secrets →
  Actions) before the next scheduled run at 23:30 UTC.

**RTL/LTR + chat UI (Tasks 1-2)**: see `index.html` — Claude response bubbles
now get an explicit `dir="rtl"`/`dir="ltr"` (driven by `LANG`, not just
`unicode-bidi: plaintext`), a new `wrapInlineTechTerms()` pass wraps
un-backticked CLI flags/paths in `<span dir="ltr">` inside Hebrew text, and
the AI tab now uses ~80vh height, a default-collapsed sidebar, a 52px input
bar, and a `conversation-active` class that hides the FAQ pills/mode selector
once a chat has messages. Verified via a Node `new Function()` syntax check
of every inline `<script>` block — **not yet tested in a live browser**, see
the `## ⏳ Next` item above.

**Netvill VoIP/SIP scope (Task 3)**: added a "Netvill context" paragraph to
`cloudflare-worker/worker.js`'s system prompt (B2B telecom hardware company,
VoIP/SIP/PoE/1COM focus, AD/Windows-domain out of scope) and updated its
"LOCAL DATABASE QUICK REFERENCE" block. Added a new `voip` category to
`data/network.json` (`modules.json`, `validate-json.js`, `health-check.js`,
and `CLAUDE.md`'s category table all updated) plus `asterisk.org` to the
approved-domain allowlist in both validator scripts and `CLAUDE.md`. Added 10
new `network.json` entries (`sip-registration-troubleshoot`,
`rtp-port-range`, `sip-nat-traversal`, `vlan-voice`, `qos-dscp-voip`,
`poe-troubleshoot`, `sip-options-keepalive`, `asterisk-cli-basics`,
`freepbx-troubleshoot`, `1com-sip-trunk`) and 3 new `troubleshoot.json`
entries (`ts-sip-not-registering`, `ts-voip-one-way-audio`,
`ts-poe-intercom-no-power`), sourced from `docs.asterisk.org` and
`rfc-editor.org` (RFC 3261/3550/3621/4594) plus `kernel.org` — `cisco.com`
URLs were avoided after two guessed pages returned 403 via fetch. Both
`validate-json.js` and `health-check.js` pass with 115 total entries.

**Worker redeploy (Task 4)**: see commit/push summary for deployment status.

## Notes

- Each session should aim to stay within roughly 5,500 tokens of work
  before committing and pausing for review.
- Per `CLAUDE.md`'s Autonomous Brain Rules: commit locally, summarize what
  changed, and wait for explicit confirmation before `git push` to
  `master`.

- [2026-06-14 11:47 UTC] Auto-session: maintenance — FAILED (authentication_error:
  invalid ANTHROPIC_API_KEY GitHub Actions secret; zero Claude calls made, no
  real changes produced). Side effects (junk files, this log line) cleaned up
  in the 2026-06-14 follow-up session — see "Daily automation fixes" below.

- [2026-06-14 22:49 UTC] Auto-session: maintenance — failed: api_error

- [2026-06-15 18:05 UTC] Auto-session: office_day_night — failed: api_error

- [2026-06-15 19:12 UTC] Auto-session: office_day_morning — failed: api_error

- [2026-06-16 00:19 UTC] Auto-session: maintenance — failed: api_error

## Autonomous simulation fix session (2026-06-16)

Full diagnostic and unblock of the office simulation. All 5 tasks completed.

**SIMULATION STATUS after this session:**
- Paused flag: UNPAUSED (`SIM_KV.paused = false` — simulation is live)
- Agent Worker: REDEPLOYED (version `2a6319c5`, 2026-06-16)
- Cases in D1: 62 (from prior runs) + new daily batches generated by cron
- Root causes fixed: (1) `SIM_KV.paused = true` → unpaused via wrangler KV; (2) stale worker → redeployed with all recent changes

**Task 1 — Automation reduced to once-daily:**
- `.github/workflows/scheduled-claude.yml`: removed `morning-office` and `maintenance` jobs; kept only `night-office` (cron `30 23 * * 0-4`, 02:30 Israel time) + `workflow_dispatch` for manual runs. Eliminates 2 of 3 daily auto-sessions — from 3x to 1x per night.

**Task 2 — Simulation unblocked:**
- Diagnosis: `SIM_KV "simulation-state"` confirmed `paused: true` (set since the 2026-06-12 quota-reset attempt); D1 healthy (62 cases, 60 sessions, 11 agents); Worker deployed but stale (last 2026-06-13).
- Fix: unpaused via `wrangler kv key put` + redeployed Worker with all code changes.
- Trigger test: skipped — `ADMIN_TOKEN` is not accessible in a Claude Code session (Worker secret by design). Simulation will run automatically on the next cron tick (05:00 UTC, 08:00 Israel time). The cron fires daily Sun-Thu per `agents/wrangler.toml` `*/30 5-13 * * *`.

**Task 3 — 1COM + MirtaPBX cases added:**
- `agents/workers/case-generator.js`: +10 1COM cases (cloud PBX: extension registration, one-way RTP, IVR, queue, omnichannel, recording, CRM integration, auto-attendant, portal login, hardware) + 8 MirtaPBX cases (on-premise: SIP trunk, cluster sync, Google Drive recordings, CDR, tenant routing, WebRTC, queue integration, node offline).
- `agents/workers/crm-engine.js`: added `PLATFORM_WEIGHTS` (1com 30%, mirtapbx 20%, general 50%) + `selectCaseTemplate()` function; `generateDailyCaseBatch()` now uses weighted platform selection. `requiresItChief` extended to include high-severity VoIP cases.
- `agents/config/simulation-config.json`: added `case_distribution` block documenting the 30/20/50 split.

**Task 4 — Token economy enforced:**
- `agents/config/token-economy.json`: `claude_api` daily limit 50 → 5; added `claude_daily_cap: 5`, `groq_primary: true`, `cf_ai_fallback: true`, `run_until_quota_exhausted: true`.
- `agents/agents/agent-base.js`: `interactWithApp()` now checks `SELECT COUNT(*) FROM interactions WHERE model_source = 'claude' AND DATE(timestamp) = DATE('now')` before calling the app. If `>= 5`: uses Groq fallback (logs as `model_source: 'groq'`, does NOT count against the cap), warns in logs, returns a simulated quality score. The cap is global across ALL agents for the calendar day.

**Task 5 — Test:**
- Deployment verified via `GET /api/simulation` → `{"paused": false, ...}` confirmed.
- Full trigger test (`POST /api/agents/trigger {"type":"day"}`) requires `ADMIN_TOKEN` (Worker secret — not accessible in this session). Simulation is READY and will auto-run on cron.

**Next session**: Confirm the first automated simulation day ran (check D1 `SELECT COUNT(*) FROM agent_sessions ORDER BY started_at DESC LIMIT 5`) and review `agents/reports/daily/day-001-summary.md` once committed by the Worker.

- [2026-06-16 ~15:55 UTC] Autonomous session: simulation-fix — completed

- [2026-06-16 18:17 UTC] Auto-session: office_day_night — failed: api_error

- [2026-06-17 13:03 UTC] Auto-session: office_day_night — failed: api_error

- [2026-06-18 12:32 UTC] Auto-session: office_day_night — failed: api_error

## Automation + UI fix session (2026-06-18)

Autonomous session. RTL audit: no issues (all AI_STRINGS via textContent, browser BiDi handles English terms). D1 confirms simulation ran today.

**Task 1 — Automation fix:**
- `.github/scripts/run-claude-session.js`: replaced full TOKEN-BUDGET.md read with last-50-lines slice (`budgetLines.slice(-50).join('\n')`). CLAUDE.md reduced from 3000 to 2000 chars. Added `totalInput > 8000` guard with console.error. Total input to API now ~2–3KB instead of ~30KB.

**Task 2 — Daily simulation report (D1 query results):**
- Created `agents/reports/daily/README-2026-06-18.md` from live D1 data.
- 47 sessions today across agents 1–5, 10, 11. Agents 6–9 absent. 39 interactions (34 Groq + 5 Claude — cap hit exactly). 15 reports (8 status, 4 incident, 3 model_education).

**Task 3 — AI mode selector always visible:**
- Removed `#ai-mode-radiogroup.conversation-active { display: none; }` from CSS (was hiding mode buttons after first message). Removed corresponding JS toggle. Mode selector now stays visible throughout conversation.
- FAQ pills still auto-hide on conversation (intentional — they're replaced by chat context).

**Task 4 — GITHUB_TOKEN verified:**
- `wrangler secret list --name data-center-agents` confirms GITHUB_TOKEN is set.
- `agent-runner.js` line 1597 already calls `commitFileToRepo` for `agents/reports/daily/day-NNN-summary.md` at end of each simulated day. No code change needed.

- [2026-06-18] Autonomous session: automation-ui-fix — completed

## Multi-task fix session (2026-06-18)

Autonomous session. Preflight clean. RTL audit: no issues.

**Task 1 — Agents 6-9 scheduling fixed:**
- Root cause: `assignCase()` in `crm-engine.js` never routed to agents 6-9.
- Fix: Added 20% admin share (5% each) for agents 6, 7, 8, 9 in `assignCase()`.
- Fix: `ensureAgentInstances(includeAll=true)` in `agent-runner.js` now instantiates
  all 11 agents for report/spare-time blocks, not just case-assigned agents.
- Expected: all 11 agents appear in D1 `agent_sessions` over a week.

**Task 2 — Image/screenshot analysis:**
- `cloudflare-worker/worker.js`: accepts `images[]` (base64 + media_type, max 3),
  injects them as vision content blocks into the Anthropic API call, adds
  image-analysis instruction to system prompt. Redeployed as version `38b028f0`.
- `index.html`: `📎` attach button, Ctrl+V paste, thumbnail strip with × removal,
  bilingual "📷 תמונה מצורפת" indicator, clears on send. `pendingImages[]` state.
  `streamFromWorker()` accepts `images` param.

**Task 3 — Three AI modes:**
- Already fixed in session 9f96e18 (2026-06-18). Confirmed: buttons exist in HTML,
  populated by `applyAiLang()`, mode selector always visible.

**Task 4 — Automation:**
- `run-claude-session.js`: TOKEN-BUDGET.md truncation already in place.
- `TOKEN-BUDGET.md`: `## ⏳ Next` marker present.
- `scheduled-claude.yml`: single cron `30 23 * * 0-4` confirmed. TASK updated to
  "all 11 agents process their cases using Groq, Claude capped at 5 calls."

- [2026-06-18] Autonomous session: multi-task-fix — completed
