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

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acknowledged BOOLEAN DEFAULT FALSE,
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

-- Chore-automation Claude budget (config/token-economy.json chore_automation,
-- workers/model-router.js) — a SEPARATE $4.50/month soft cap from the
-- office-simulation's per-day case-escalation cap (interactions.model_source).
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

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_cases_assigned ON cases(assigned_to);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_reports_agent ON reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_side_plots_status ON side_plots(status);
CREATE INDEX IF NOT EXISTS idx_promotions_agent ON promotions(agent_id);
CREATE INDEX IF NOT EXISTS idx_year_stats_recorded ON year_stats(recorded_at);
