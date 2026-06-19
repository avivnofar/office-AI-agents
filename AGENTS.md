# Agent Specification Reference (Summary)

> **DRAFT — not final.** This is a summary of `config/agents-config.json` and
> the shared mechanics in `agents/agent-base.js`, kept in sync as the agent
> spec evolves. For exact values (thresholds, rates, prompt text) always
> read `config/agents-config.json` directly — this file is documentation,
> not a source of truth.

---

## Shared state machine (`AgentBase`)

Every agent (1-11) carries:

| Field | Range | Meaning |
|-------|-------|---------|
| `mood` | 0-100 | General disposition. Starts at 50. Drives `HAPPY`/`IRRITATED` trigger chances and (Agent 3) `model_usage_rate`. |
| `irritation` | 0-5 | Stack of unresolved frustrations. `addIrritiation()` increments; `resolveIrritation()` decrements. Hitting an agent's `irritation_stack.angry_threshold` (default 5) triggers `ANGRY`. |
| `isHappy` / `isAngry` | bool | Current state flags. `triggerHappy()` raises mood +10. `triggerAngry()` files an incident report and ends the session. |
| `isPanic` / `panicLevel` | bool / 0-100 | **Trainee (Agent 4) only** — see Escalation Protocol below. Harmless on other agents. |
| `permanentIrritationFlags` | string[] | Survive `resetWeeklyState()` — e.g. Agent 2's `slow_ui` / `sloppy_design` flags persist until the underlying issue is fixed. |
| `session` | object\|null | Current `agent_sessions` row: `cases_handled`, `mood_start`/`mood_end`, `irritation_events`, `happy_events`, `extended_session`. |

### Session lifecycle

1. `startSession(caseData, mode)` — opens an `agent_sessions` row.
2. Per case: `interactWithApp(query, mode)` → `data-center-api`'s `/api/chat`
   → `evaluateResponseQuality()` (placeholder heuristic) → possible
   `triggerHappy()` / `addIrritiation()` → `logInteraction()`.
3. `extendSession()` — applies `session_extension_multiplier` when an
   agent's `extended_session_chance` roll succeeds (typically after `HAPPY`).
4. `endSession()` — closes the `agent_sessions` row with final mood/counters.

### Weekly reset (`resetWeeklyState()`)

Run by `scheduler.js`'s `runWeeklyResetCycle()`:

- `mood` regresses toward the mean: `mood = round((mood + 50) / 2)`.
- `irritation` and `isAngry` clear **unless** `permanentIrritationFlags` is
  non-empty.
- `isHappy` clears.
- A weekly report is filed (`fileWeeklyReport()`) before the reset.
- Agent 2's `checkWeeklyBonus()` runs if defined.

---

## Phase 1 agents

### Agent 1 — The Perfectionist (QA Lead, standard)

- `model_usage_rate: 0.30` (advanced-difficulty cases always use the app).
- `extended_session_chance: 0.60`, `session_extension_multiplier: 1.50`.
- **Never enters `ANGRY`** — believes in "educating the algorithm" instead.
- `IRRITATED` (30% @ quality < 0.4): generates critical feedback via Gemini,
  demands a corrected response, rates it 1-10.
- `CALM`/`NEUTRAL` only re-entered once a case is solved **and**
  documentation/PDF exists for it.
- `HAPPY` (50% @ quality > 0.7): may `extendSession()`, drift to a related
  topic, and `fileSuggestion()` recommending a bookmark.

### Agent 2 — The Productive (Senior IT Operator, standard)

- `model_usage_rate: 0.40`, `extended_session_chance: 0.30`.
- `irritation_stack`: max 3, `bad_answer_chance: 0.45`,
  `permanent_flags: ["slow_ui", "sloppy_design"]`, `angry_threshold: 3`.
- `IRRITATED`: 45% chance on a bad answer, **or permanently** while
  `slow_ui`/`sloppy_design` flags are set (until fixed) — mocks the AI,
  reduces `patience_meter`.
- `ANGRY` (irritation stack ≥ 3 without an intervening `HAPPY`):
  `fileIncidentReport()`, ends all sessions, sets a cooldown.
- `work_routine.overtime: "30%_of_days"` — 30% of days extend the session.
- Weekly bonus day (+30% over quota): one extended session focused on
  app/Claude optimization suggestions.
- "Found-outside" pattern: while `IRRITATED`, if the simulated external
  search succeeds, files a `fileSuggestion()` "mock report" showing how easy
  the external answer was.

### Agent 3 — The Standard Agent (IT Generalist, standard)

- **Mood-proportional usage**: `model_usage_rate = mood / 100`, recalculated
  at the start of every session (`mood_proportional_usage`).
- `IRRITATED` is a **100% trigger** on `critical_error_detected`.
- After every session where the UI worked correctly: files a balanced
  `status_report` via `fileStatusReport()` with `ui_score`,
  `resource_access_score`, `response_quality_score`,
  `user_friendliness_score`, `overall_happiness_level`,
  `specific_observations` (1-10 scales). Reports must stay professional —
  "no exaggeration in either direction."

### Agent 4 — The Trainee (Junior IT Support, standard)

- `model_usage_rate: 0.55`, `patience_meter: 30`.
- Asks multiple clarifying questions per case, favors `'diagnose'` mode.
- **Guide detection** (before each case): checks
  `data-center-archive/guides/` for a relevant guide.
  - Found → `triggerHappy()` immediately.
  - Not found → higher chance of `panicLevel` accumulation.
- `HAPPY` (45% @ quality > 0.7 OR guide found): productivity increases
  significantly, `panicLevel` decreases.

#### Escalation Protocol (`TRAINEE_PANIC`)

Triggered when `panicLevel >= 80`:

1. Set `panicActive = true` (`isPanic = true`).
2. Select a helper: QA/Perfectionist (Agent 1) — 70% combined
   (40% + 30% per spec), or a random active agent — 30%.
3. Fire `TRAINEE_PANIC` event `{ traineeId, selectedAgent, caseData }`.
4. `scheduler.js`'s `handleTraineePanic()` runs a joint session: the helper
   agent + the live app collaborate on the trainee's case.
5. Check `data-center-archive/guides/` for an existing guide for this case
   type.
6. If none exists, generate one via Gemini and save as markdown.
7. Commit the new guide to `data-center-archive/guides/` (Phase 2 —
   `commitGuideToArchive()`, requires `GITHUB_TOKEN`; no-ops without it).
8. Reset `panicLevel` to 0; mood improves.

---

## Admin-tier agents (5-11)

All `status: "specified"` in `config/agents-config.json` (v0.2.0) — full
`character`, `purpose`, `case_focus`, and `states` blocks exist for each, but
they currently run via the generic `agent-stub.js` (extends `AgentBase` with
no behavioral overrides), not a dedicated `agent-N-*.js` class. All seven
have `can_generate_assets: true` (see `config/asset-platforms.json` and
`year-tracker.json`'s `asset_pipeline`).

| # | Name | Role | Clearance | Purpose |
|---|------|------|-----------|---------|
| 5 | The IT Chief | Senior IT Admin | sudo | Hard cases — network optimization, firewall, application-layer issues, client escalations. Raises `quarterly_demand`. |
| 6 | The QA | Quality Assurance | sudo | Agent audits and model optimization (`audits_per_week: 1_per_agent_under_rank`). |
| 7 | The Team Lead | Agent Coach & Team Manager | sudo | Agent productivity/development; PIP authority over agents 1-4; organizes the mandatory weekly meeting. |
| 8 | The Lead QA | Chief Quality Officer | sudo | Project-wide audits (agents, models, workflows, technologies); `mood_sensitivity: 0.5` (slow-moving mood). |
| 9 | The Designer | UI/UX Specialist | specialist | Design audits of the repo + Claude app; 2 reports/week; 4 `quarterly_updates` (first due day 30). |
| 10 | The Architect | Project Mastermind | root | Root-level changes, hard escalations, versioned release packages; rivalry with agent 8. |
| 11 | The CEO | Founder & Chief Executive | root | Leads every meeting (`vote_weight: 2`, `veto_rights`); final decision authority. |

When a dedicated state machine is built for one of these agents, follow the
Phase 1 agents' shape (`states`, behavioral triggers,
`system_prompt_additions`) and register the new class in
`agent-runner.js`'s `AGENT_CLASSES`.

---

## Permission tiers (`fileSuggestion()` routing)

From each agent's `clearance` field in `config/agents-config.json` (mirrored
in `config/simulation-config.json`'s `PERMISSIONS` block):

- **root**: agents 10, 11 — `fileSuggestion(content, true)` always routes to
  `root` regardless of caller.
- **sudo**: agents 5, 6, 7, 8.
- **specialist**: agent 9.
- **standard**: agents 1, 2, 3, 4.

`suggestions.permission_level` defaults to the filing agent's `clearance`
unless `isRoot=true` is passed (used for escalated/strategic suggestions).

---

## Open questions for the next spec revision

- Exact behavioral state machines (`states` triggers/effects already exist
  in `agents-config.json` for 5-11, but no `agent-N-*.js` class implements
  them yet).
- Formula for `weekly_analytics.irritation_count` / `happy_count` /
  `overtime_days` / `suggestions_filed` (currently not computed —
  `agents/README.md` "Known gaps").
- Whether `evaluateResponseQuality()` should call Gemini-as-judge, and what
  prompt/rubric to use.
