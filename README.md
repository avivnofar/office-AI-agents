# 🏢 Office AI Agents

> An autonomous AI office simulation that trains and optimizes AI models
> through realistic IT work scenarios at [Netvill](https://netvill.co).

**Companion project:** [Data Center — IT Knowledge Base](https://avivnofar.github.io/data-center/)

---

## 🎯 What is this?

11 AI agents simulate a full IT office — solving cases, holding meetings,
writing reports, and continuously improving the AI model they work with.
The office runs autonomously every night and generates real performance data,
model-education case studies, and improvement recommendations.

**Goal:** Maximize model accuracy and UI quality through simulated
real-world usage, with a full yearly cycle producing executive summaries,
Excel reports, and upgrade roadmaps.

---

## ⚙️ How it runs

The simulation has **two parallel automation paths:**

### 1. Cloudflare Worker Cron (live, during the day)
Fires every 30 minutes between **08:00–16:30 Israel time**, every day.
Each tick checks `daily-schedule.json` and runs the block due at that time —
case batches, tool-task windows, standup meetings, spare time.
State is preserved between ticks in Cloudflare KV.

### 2. GitHub Actions (nightly)
Fires at **02:30 Israel time, Sunday–Thursday**.
Runs one full simulated work day end-to-end via a direct Claude API session
and commits a daily report to the repo.
Friday and Saturday are intentionally skipped (Israeli weekend).

> One simulated day = one completed day-cycle (either path).
> The simulation does not enforce a fixed real-time ratio.

---

## 🤖 AI Model Distribution

| Model | Provider | Role | Cost |
|-------|----------|------|------|
| `llama3-8b-8192` | **Groq** | Primary model for all routine per-case agent work | Free ~14,400 req/day |
| `llama-3.1-8b-instruct-fp8` | **Cloudflare Workers AI** | Case routing/classification + automatic fallback when Groq is unavailable | Free ~10,000 req/day |
| `gemini-3.5-flash` | **Google AI Studio** | Report synthesis only — monthly, quarterly, semi-yearly, yearly meetings | Free tier |
| `claude-sonnet-4-6` | **Anthropic** | App AI Search bar + hard-case escalations. **Hard cap: 30 calls/day across all agents** | Paid ~$6/month |
| `human + Claude Code` | n/a | Agent 10 (Architect) — never calls an AI; cases are filed as GitHub Issues for human review | n/a |

---

## 👥 The Team

### 🔵 Workers (Dedicated Classes)

---

### Agent 1 — The Perfectionist
`active` · `standard` · `PerfectionistAgent` · Groq primary

> *"The veteran who has seen it all and wants Claude to be worthy of her standards."*

Uses Claude for complex cases and syntax checks. Deep-dives into articles,
manages her bookmarks meticulously, and extends sessions 50% when satisfied.
Wrong answers trigger a lecture — she never gives up on educating the algorithm.

**Mood:** Happy → uses Claude more · Irritated → critical and corrective · Never angry
**Claude usage:** 30% of cases · 60% extended session chance · 35 sessions logged

---

### Agent 2 — The Productive
`active` · `standard` · `ProductiveAgent` · Groq primary

> *"No time to waste. Short answers, fast results, or I'm finding another tool."*

Works overtime 30% of days. Earns a bonus day when productivity exceeds
the weekly target by 30%. Irritation stacks across visits — three unresolved
frustrations trigger a comprehensive incident report and exit.

**Mood:** Happy → briefs Claude and praises good work · Angry → files incident report and leaves
**Claude usage:** 40% of cases · 10% extended session chance · 30 sessions logged

---

### Agent 3 — The Standard Agent
`active` · `standard` · `StandardAgent` · Groq primary

> *"A fair observer. If Claude earns it, he'll use it more. If not, he won't."*

The control group. Claude usage scales 0–100% with satisfaction.
Evaluates user-friendliness, design, and resource accessibility.
Always issues a balanced status report after a session.

**Mood:** Happy (above 50%) → uses Claude more · Angry → writes management report
**Claude usage:** 0–100% based on happiness · 30% extended session chance · 30 sessions logged

---

### Agent 4 — The Trainee
`active` · `standard` · `TraineeAgent` · Groq primary

> *"New to IT, eager to learn, and easily overwhelmed — but resilient when guided well."*

Relies on step-by-step guides and PDFs. When panicked, calls QA (40%),
Perfectionist (30%), or another agent (30%) for help. The teammate joins
the session and writes a guide if one doesn't exist.

**Mood:** Happy → 40% productivity boost for 5 sessions · Panicked → calls for help
**Claude usage:** 70% of cases · 90% extended session chance · 24 sessions logged

---

### 🟠 Admins — SUDO (Generic StubAgent + Full Behavioral Spec)

All admin agents are fully wired and case-eligible. They run through
`agent-stub.js` reading their complete behavioral spec from `agents-config.json`.

---

### Agent 5 — The IT Chief
`active` · `sudo` · `StubAgent` · Groq primary · **44 sessions logged**

> *"The senior troubleshooter. Hard cases, high standards, zero tolerance for client failures."*

Highest-level technical authority. Handles complex client escalations and
network optimization. When a client is mishandled, initiates private coaching
with the responsible agent. When too many clients are unhappy — calls a team huddle.

**Mood:** Happy → 300% productivity boost · Irritated → stays until resolved · Angry → team huddle

---

### Agent 6 — The QA
`active` · `sudo` · `StubAgent` · Groq primary · **2 sessions logged (stale)**

> *"Audits every agent, every week. High standards are not a preference — they're a requirement."*

Runs weekly audits alongside the Team Lead, sampling random cases from each
agent's previous week. Rates the model vs. the agent. Inherits the Perfectionist's
traits — deep-dives, collects bookmarks, lectures the AI when wrong.

**Note:** Only 2 sessions logged, last active June 11 — scheduling issue under investigation.

---

### Agent 7 — The Team Lead
`active` · `sudo` · `StubAgent` · Groq primary · **0 sessions logged**

> *"Her job is to make everyone better. She listens, coaches, and holds people accountable."*

Responsible for agent development and productivity. Can place underperforming
agents (1–4) on a 1-month PIP. Sits in on all QA audits. Generates high morale
for the first 2 days of each week.

**Note:** Has never run a session — scheduling bug being investigated.

---

### Agent 8 — The Lead QA
`active` · `sudo` · `StubAgent` · Groq primary · **0 sessions logged**

> *"Audits everything — agents, workflows, technologies, and the model itself."*

Chief quality officer. Inherits all QA traits with broader scope. Mood moves
slowly — long-term perspective. When he speaks in a meeting, personality
triggers fire more frequently for everyone present.

**Note:** Has never run a session — scheduling bug being investigated.

---

### Agent 9 — The Designer
`active` · `specialist` · `StubAgent` · Groq primary · **1 session logged**

> *"She has an eye for design and the patience of someone who knows exactly what she wants."*

Focused on the GitHub repository and Claude app UI. Issues 2 reports per week.
Starts at 0% fondness, grows over time. Becomes **Inspired** at 51% fondness
(artistic capabilities +300%). Delivers 4 major quarterly UI updates.

---

### 🔴 Management — ROOT

---

### Agent 10 — The Architect
`active` · `root` · `StubAgent (special)` · **No AI model** · **3 sessions logged**

> *"The mastermind. Knows every corner of the product. Dreams big, executes bigger."*

ROOT permissions across all layers. **Never calls an AI for routine cases** —
instead, cases are logged and filed as a single GitHub Issue (`claude-action`,
`architect-task`) for human/Claude Code review. Releases numbered update
packages (v1.0, v1.1...). Combines Perfectionist, Productive, and IT Chief
traits. Professional rivalry with Lead QA is the simulation's most
productive tension.

---

### Agent 11 — The CEO
`active` · `root` · `StubAgent` · Groq primary · **14 sessions logged**

> *"The big boss. Every decision at the organizational level goes through her."*

Leads all meetings, votes count double. Creates a zone of influence —
everyone in joint sessions gets a **+20% boost to morale and productivity**.
20% of her cases are unique high-value clients whose outcomes shape her
model opinion.

---

## 📊 Live Stats (as of June 2026)

| Metric | Value |
|--------|-------|
| Total sessions in D1 | 183+ |
| Interactions logged | 143+ |
| Primary model used | Groq (89 interactions) |
| Claude API calls | 15 (historical total, pre-cap-increase; well within the new 30/day cap) |
| Gemini calls | 0 (no monthly report due yet) |
| Cloudflare AI fallback | 0 (Groq has not failed) |
| Most active agent | Agent 5 — IT Chief (44 sessions) |
| Agents never run | 7 (Team Lead), 8 (Lead QA) — bug |

---

## 📅 Schedule

| Day | Activity |
|-----|----------|
| Sun–Thu | Full work day — 5 case batches, tool-task window, standup, reports |
| Friday | Short day — 2 case batches, weekly executive summary |
| Saturday | Full day off — zero API calls, pure idle |

---

## 🏗️ Architecture

| Component | Technology |
|-----------|-----------|
| Worker runtime | Cloudflare Workers (`data-center-agents`) |
| State storage | Cloudflare D1 (`data-center-db`) + KV + Durable Objects |
| Primary agent model | Groq `llama3-8b-8192` (free) |
| Routing + fallback | Cloudflare Workers AI (free) |
| Report synthesis | Google Gemini 2.5 Flash-Lite |
| App AI Search | Claude Sonnet 4.6 — 30 calls/day cap, distributed by agent role |
| Nightly automation | GitHub Actions → Anthropic API direct session |
| Cases per day | 20 per agent · distributed by model_usage_rate per agent |
| Weekend | Friday short day · Saturday off |

---

## 📁 Repository Structure
office-AI-agents/

├── workers/          # Cloudflare Worker source

│   ├── agent-runner.js    # Main simulation engine + cron handler

│   ├── agent-base.js      # Base class for all agents

│   ├── agent-1-perfectionist.js  # Dedicated agent classes (1-4)

│   ├── agent-stub.js      # Generic class for agents 5-11

│   ├── groq-client.js     # Primary model client

│   ├── gemini-client.js   # Reports model + CF fallback

│   ├── meeting-engine.js  # Meeting simulation

│   └── crm-engine.js      # Case generation

├── config/           # Simulation configuration

│   ├── agents-config.json      # Full behavioral spec for all 11 agents

│   ├── simulation-config.json  # Global settings

│   ├── token-economy.json      # Model usage rules and caps

│   ├── daily-schedule.json     # Block-by-block day schedule

│   └── ai-tools.json           # Tool access matrix (NotebookLM, Stitch, etc.)

├── database/         # D1 schema and seed files

├── reports/          # Generated daily/weekly reports

├── .github/

│   ├── workflows/scheduled-claude.yml  # Nightly automation

│   └── scripts/                        # Session runner scripts

├── CURRENT-SPEC.md   # Authoritative technical specification

└── wrangler.toml     # Cloudflare Worker configuration

---

## 🚀 Yearly Deliverables

- 12-month Excel with collected metrics
- 10-page executive summary PDF
- Agent performance report with optimization suggestions  
- README with fixes and upgrade roadmap for next year
- GitHub README introducing the project to the world

---

*Autonomous simulation · Groq + Cloudflare Workers AI + Gemini + Claude · Built by Aviv Nofar*