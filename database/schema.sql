-- Data Center — AI Agent Simulation — Cloudflare D1 schema
-- Status: DRAFT (Phase 1 foundations). Agents 5-11 are stubs; their rows
-- exist in `agents` so foreign keys resolve, but no sessions/cases are
-- generated for them until Phase 2.

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  clearance TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  mode TEXT NOT NULL,
  cases_handled INTEGER DEFAULT 0,
  mood_start INTEGER,
  mood_end INTEGER,
  irritation_events INTEGER DEFAULT 0,
  happy_events INTEGER DEFAULT 0,
  extended_session BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- "cases" keeps its original table/column name for backward compatibility
-- (avoids a table rename against a live D1 instance) but as of the 2026-07-18
-- Q&A-engine rebuild holds QUESTIONS, not Netvill-CRM support tickets — see
-- workers/qa-engine.js. client_name/severity/is_unique_client/requires_it_chief
-- are retired Netvill-CRM columns: left in place (NOT dropped, to avoid a
-- destructive migration) but no longer populated by any code path. project/
-- kb_slug are the new columns the Q&A engine actually writes.
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  assigned_to INTEGER,
  status TEXT DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolution_time_minutes INTEGER,
  client_name TEXT,
  severity TEXT,
  is_unique_client BOOLEAN DEFAULT FALSE,
  requires_it_chief BOOLEAN DEFAULT FALSE,
  project TEXT,
  kb_slug TEXT,
  FOREIGN KEY (assigned_to) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  type TEXT NOT NULL,
  query TEXT,
  response_summary TEXT,
  mood_before INTEGER,
  mood_after INTEGER,
  irritation_change INTEGER DEFAULT 0,
  state_change TEXT,
  model_source TEXT,
  tool_used TEXT,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);

-- `project` added 2026-07-18 (Q&A-engine rebuild) so gap-flagging reports
-- (type='gap_hebrew', see workers/gap-reports.js) can be grouped into the
-- right reports/gaps/<project>/<date>.md file without parsing `title`.
-- NULL for every report type that predates this and doesn't need it.
-- IMPROVEMENT-LOOP CAPTURE COLUMNS added 2026-08-06 (plan item 1.1):
-- event_type, embodiment_model, track, quality. Written by
-- workers/improvement-loop.js recordOfficeEvent(), gated on SIM_KV
-- `improvement_loop_enabled` (default OFF). See the MANUAL MIGRATION block at
-- the bottom of this file — these four are ALTER TABLE on the live database.
--
-- ── `type` VERSUS `event_type` — THE RULE, so the two do not drift ────────
--   `type`       = WHAT KIND OF DOCUMENT this row is. Pre-existing values:
--                  status, incident, gap_hebrew, weekly, day, disabled.
--                  Rows from the improvement loop all carry 'office_event',
--                  so any pre-existing consumer filtering on the old values
--                  sees nothing new.
--   `event_type` = WHAT THE OFFICE DID. case_answer, qa_review,
--                  team_lead_review, lead_qa_weekly, meeting, guide_review.
-- Two different axes, deliberately not merged (owner decision 2026-08-06):
-- overloading `type` would make "yesterday's QA reviews" the same query shape
-- as "incident reports", and plan items 1.2-1.5 all query BY EVENT.
--
-- `track` is 'client' (the Q&A engine — Track A) or 'office' (office-building
-- — Track B). It is the ONLY thing that makes per-track quota consumption
-- separable, which the plan requires BEFORE any rebalancing is proposed. A row
-- with no track is REFUSED by recordOfficeEvent() rather than defaulted: a
-- guessed track silently misattributes the measurement the decision rests on.
--
-- `embodiment_model` is the provider that ACTUALLY SERVED the call, including
-- after a lane degraded to its backup — never the provider that was asked for.
-- Writing the configured primary would make the Lead QA's cross-embodiment
-- comparison (1.5) measure the routing table instead of reality.
--
-- `quality` is REAL in [0,1], or NULL where no score exists. NULL means "no
-- score here", never zero. Until 2026-08-06 this value was computed on every
-- answer and DISCARDED — it appeared in no INSERT anywhere in the repo, so the
-- improvement loop had been specified against data nobody was collecting.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acknowledged BOOLEAN DEFAULT FALSE,
  project TEXT,
  event_type TEXT,
  embodiment_model TEXT,
  track TEXT,
  quality REAL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  permission_level TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  auto_apply BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS weekly_analytics (
  id TEXT PRIMARY KEY,
  week_start TIMESTAMP NOT NULL,
  agent_id INTEGER NOT NULL,
  total_cases INTEGER DEFAULT 0,
  cases_solved INTEGER DEFAULT 0,
  avg_mood REAL,
  irritation_count INTEGER DEFAULT 0,
  happy_count INTEGER DEFAULT 0,
  overtime_days INTEGER DEFAULT 0,
  suggestions_filed INTEGER DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Office simulation: meetings (meeting-engine.js), side plots
-- (side-plots.json), promotions/PIP track (promotion-config.json), and
-- year-tracker.json's running stats (agent-runner.js getYearState/persistYearState).

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  attendees TEXT NOT NULL,
  transcript TEXT,
  decisions TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS side_plots (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agents TEXT NOT NULL,
  start_day INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  current_stage INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  log TEXT DEFAULT '',
  report_path TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  track TEXT NOT NULL,
  status TEXT DEFAULT 'recorded',
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS year_stats (
  id TEXT PRIMARY KEY,
  simulation_start TEXT,
  current_day INTEGER DEFAULT 0,
  current_week INTEGER DEFAULT 0,
  current_month INTEGER DEFAULT 0,
  current_quarter INTEGER DEFAULT 0,
  stats TEXT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Shared Claude budget (config/token-economy.json shared_claude_budget /
-- chore_automation, workers/model-router.js) — since 2026-07-18 a single
-- $4.50/month software soft-stop shared by the office Q&A engine and the
-- chore automation, deliberately below the account's own $5/month spend
-- ceiling (the hard backstop — two distinct mechanisms). The old separate
-- per-day case-escalation call cap is retired.
CREATE TABLE IF NOT EXISTS claude_budget_usage (
  month TEXT PRIMARY KEY,
  spent_usd REAL DEFAULT 0,
  call_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Guides pipeline state (Gemini draft -> Architect/Claude review -> commit).
-- Brand-new table (no live-D1 migration needed, unlike cases/reports above).
-- `status`: 'drafted' -> 'reviewing' -> 'approved' | 'rejected' (one revision
-- round max, see workers/guide-engine.js). `source` records where the topic
-- came from ('gap:<report_id>' or 'topics_md:<slug>') for traceability.
CREATE TABLE IF NOT EXISTS guide_pipeline (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  topic TEXT NOT NULL,
  domain TEXT NOT NULL,
  slug TEXT NOT NULL,
  source TEXT,
  writer_agent_id INTEGER,
  status TEXT DEFAULT 'drafted',
  draft_content TEXT,
  review_notes TEXT,
  revision_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_guide_pipeline_slug ON guide_pipeline(slug);
CREATE INDEX IF NOT EXISTS idx_guide_pipeline_date ON guide_pipeline(date);

-- Per-provider free-tier call counters for task-type routing
-- (config/model-routing.json, workers/task-router.js). The routing analogue of
-- claude_budget_usage above: that one counts DOLLARS per month against a spend
-- ceiling, this one counts CALLS per period against a free-tier allowance.
--
-- DECLARED HERE 2026-08-06 (plan item 1.8). Until then this table lived ONLY
-- as PROVIDER_USAGE_TABLE_SQL in workers/task-router.js, created lazily on
-- first routed call — a knowing break from the claude_budget_usage precedent
-- of living in both places. It is declared now, in the session that gives the
-- table its first real writer, so the declaration and the first write are
-- verified together rather than a table being declared that nothing uses.
--
-- ⚠️ THIS DECLARATION WILL NOT RETROFIT A LIVE TABLE. Same trap as the
-- 2026-07-18 ALTER TABLE note at the bottom of this file: `CREATE TABLE IF
-- NOT EXISTS` is a no-op against a database where the table already exists,
-- and this table is created LAZILY by code. If routing has ever run against a
-- given D1 instance, that instance's provider_usage was built by
-- task-router.js and this statement will silently do nothing to it. Should the
-- two ever diverge, they must be cross-checked BY HAND — there is no migration
-- path here and SQLite/D1 has no "ADD COLUMN IF NOT EXISTS".
-- As of 2026-08-06 the table does NOT exist in production (verified: routing
-- has never been enabled, so nothing has ever routed), which is precisely why
-- declaring it now is cheap and declaring it later would not be.
--
-- Kept character-for-character identical to PROVIDER_USAGE_TABLE_SQL
-- (workers/task-router.js L408-417). Two copies of one fact, on purpose: the
-- Worker cannot read this file at runtime, and a fresh-database rebuild cannot
-- read the Worker. Change one, change the other.
--
-- `period_key` is the composite '<provider>#<bucket>' — the same shape as
-- claude_budget_usage's month key. `day` holds the BUCKET LABEL, not
-- necessarily a calendar date: 'YYYY-MM-DD' for a daily allowance,
-- 'YYYY-MM' for a monthly one (Cohere's 1,000/month trial key is the only
-- monthly provider today). One column serves both because the composite
-- primary key already keeps the two families from colliding, and because
-- adding a second column to a lazily-created table is exactly the migration
-- this design avoids.
--
-- `call_count` vs `confirmed_count`: calls are recorded AFTER the fact on
-- evidence, and the split records whether the provider's own response
-- confirmed the call happened. An unconfirmed call still counts against the
-- allowance — the conservative direction.
CREATE TABLE IF NOT EXISTS provider_usage (
  period_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  call_count INTEGER DEFAULT 0,
  confirmed_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- General agent-conduct rule: max 1 pull (external repo checkout/fetch) per
-- day, repo-wide, regardless of config/project-permissions.json push state.
-- See workers/permission-guard.js checkAndRecordPull().
CREATE TABLE IF NOT EXISTS pull_log (
  date TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  last_pulled_at TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────
-- MANUAL MIGRATION — 2026-07-18 Q&A-engine rebuild.
-- `CREATE TABLE IF NOT EXISTS` above only affects a FRESH database — it will
-- NOT retrofit these columns onto the live production D1 instance, which
-- already has `cases`/`reports` tables from before this rebuild. Whoever
-- deploys this change must run the two ALTER TABLE statements below once,
-- by hand, against the live `data-center-db` D1 database (e.g. via
-- `wrangler d1 execute data-center-db --command "..."` — see DEPLOY.md).
-- Not run automatically by this repo: a schema change against a shared
-- production database is exactly the kind of action that needs an explicit,
-- deliberate step, not a silent side effect of a code deploy.
-- SQLite/D1 has no "ADD COLUMN IF NOT EXISTS" — if a column already exists
-- (e.g. this migration already ran), the ALTER will error; that's expected
-- and safe to ignore.
--
-- ALTER TABLE cases ADD COLUMN project TEXT;
-- ALTER TABLE cases ADD COLUMN kb_slug TEXT;
-- ALTER TABLE reports ADD COLUMN project TEXT;
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- MANUAL MIGRATION — 2026-08-06 improvement-loop capture (plan item 1.1).
--
-- Same trap as the 2026-07-18 block above, and the same reason: `reports`
-- already exists on the live D1 instance, so the CREATE TABLE IF NOT EXISTS
-- near the top of this file is a NO-OP against it and will not add these four
-- columns. Run them once, by hand, against `data-center-db`:
--
--   npx wrangler d1 execute data-center-db --remote \
--     --command "ALTER TABLE reports ADD COLUMN event_type TEXT"
--   npx wrangler d1 execute data-center-db --remote \
--     --command "ALTER TABLE reports ADD COLUMN embodiment_model TEXT"
--   npx wrangler d1 execute data-center-db --remote \
--     --command "ALTER TABLE reports ADD COLUMN track TEXT"
--   npx wrangler d1 execute data-center-db --remote \
--     --command "ALTER TABLE reports ADD COLUMN quality REAL"
--
-- ORDER RELATIVE TO DEPLOY, AND WHAT BREAKS IF IT IS WRONG:
--
--   Either order is SAFE, because the capture write is gated OFF by default
--   and nothing reads these columns until the flag is flipped. What is NOT
--   safe is flipping `improvement_loop_enabled` before running these.
--
--   · Deploy first, migrate later  — fine. recordOfficeEvent() is inert while
--     the flag is off, so the INSERT naming these columns is never executed.
--   · Migrate first, deploy later  — also fine. Four unused nullable columns
--     sit on the table; every existing INSERT names its columns explicitly,
--     so none of them break.
--   · Flip the flag before migrating — THIS IS THE ONE THAT BREAKS. The
--     INSERT would reference columns that do not exist and fail. It fails
--     SAFELY (recordOfficeEvent() catches, warns, returns capture_error, and
--     the client answer is unaffected) but every row is silently lost, and
--     "the loop is on and capturing nothing" looks identical to "the office
--     had a quiet day". The `improvement_loop_status` trigger exists to make
--     that distinction visible: it reports `captureColumnsPresent: false`
--     rather than an empty result set.
--
-- SQLite/D1 has no "ADD COLUMN IF NOT EXISTS" — if a column already exists
-- the ALTER errors, which is expected and safe to ignore.
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_cases_assigned ON cases(assigned_to);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_reports_agent ON reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_side_plots_status ON side_plots(status);
CREATE INDEX IF NOT EXISTS idx_promotions_agent ON promotions(agent_id);
CREATE INDEX IF NOT EXISTS idx_year_stats_recorded ON year_stats(recorded_at);
