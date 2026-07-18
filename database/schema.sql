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

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_cases_assigned ON cases(assigned_to);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_reports_agent ON reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_side_plots_status ON side_plots(status);
CREATE INDEX IF NOT EXISTS idx_promotions_agent ON promotions(agent_id);
CREATE INDEX IF NOT EXISTS idx_year_stats_recorded ON year_stats(recorded_at);
