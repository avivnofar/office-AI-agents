# 🏢 Office AI Agents

> An office of 11 AI personas whose job is to **use and stress-test two
> production AI systems** — Claude (in [Data Center](https://avivnofar.github.io/data-center/))
> and Gemini (in [Notebook-X](https://github.com/avivnofar/Notebook-X)) — by
> asking them real questions, judging the answers, and flagging genuine
> capability gaps back to the project owner for review.

---

## 🎯 What is this?

Each persona has a distinct personality, role, and clearance level. They run
realistic queries against the two target apps the way a real user or admin
would, evaluate whether the response actually held up, and react in
character — happy, irritated, or (for one persona) full panic. Along the
way they write reports, hold standups, and file suggestions.

The point isn't the roleplay. It's that **varied, persona-driven usage
surfaces real gaps** — bad answers, missing knowledge-base coverage,
confusing UI copy, broken flows — that a single flat test script wouldn't
catch. A genuine gap gets a short, internal Hebrew note (not a GitHub
Issue) landing in `reports/gaps/<project>/<date>.md` — framed as "the tool
I work with isn't good enough here," the way a real support team flags a
broken internal tool.

This is not a Netvill support-ticket simulation, and it isn't running a
fictional company. The "office" framing exists to generate realistic,
varied interaction patterns — nothing more.

---

## ⚙️ How it runs

Three independent automation paths, each targeting a different surface:

### 1. Cloudflare Worker cron (live, during the day)
Fires every 30 minutes, **08:00–16:30 Israel time**, every day. Each tick
checks `config/daily-schedule.json` and runs whatever block is due — case
batches, tool-task windows, standup meetings, spare time — against
[Data Center](https://avivnofar.github.io/data-center/). State persists
between ticks in Cloudflare KV.

### 2. GitHub Actions — nightly office day (`scheduled-claude.yml`)
Fires at **02:30 Israel time, Sunday–Thursday**. Runs one full simulated
office day end-to-end via a direct Anthropic API session and commits a
daily report to this repo. Friday and Saturday are skipped (Israeli
weekend).

### 3. GitHub Actions — Notebook-X daily (`notebook-x-daily.yml`)
Fires at **01:00 Israel time, daily**, against the separate
[Notebook-X](https://github.com/avivnofar/Notebook-X) project — filling in
skeleton knowledge-notebook content where a `NOTEBOOK_X_REPO_TOKEN` is
available. As of 2026-07-18 this path never writes or modifies code: a
backlog item asking for a frontend change gets a written recommendation for
a human to implement, not an auto-push. See `CLAUDE.md`'s "Connection to
Notebook-X" for why (a real production incident, and the fix).

---

## 🤖 AI Model Distribution

| Model | Provider | Role | Cost |
|-------|----------|------|------|
| `llama3-8b-8192` | **Groq** | Primary model for all routine per-case agent work | Free, ~14,400 req/day |
| `llama-3.1-8b-instruct-fp8` | **Cloudflare Workers AI** | Case routing/classification + same-session fallback when Groq or Gemini is unavailable | Free, account-scoped |
| **Gemini 3.1 Flash-Lite** | Google AI Studio | Report synthesis (monthly/quarterly/yearly meetings), Notebook-X content fill, **and** direct Notebook-X question-asking (paced ~1 call/20s from this automation — Gemini's free-tier quota is shared with Notebook-X's own traffic) | Free tier, ~1,500 req/day |
| **Google AI Studio** (interactive) | Google | Reserved for human-in-the-loop creative-tool sessions (Agents 9/10 building design assets) — never called programmatically | n/a |
| `claude-sonnet-4-6` | **Anthropic** | Data Center's AI Search bar. **Shared $5/month budget** across the 11-agent Q&A engine and the chore-automation economy — a dollar cap, not a per-day call count | Paid, low volume |

---

## 👥 The Team

11 personas, each with a mood/irritation state machine and a clearance tier
(`standard` < `specialist` < `sudo` < `root`) that governs how their
suggestions get routed. Personalities below are preserved as originally
designed — what each one actually *does* is described alongside.

### 🔵 Agents 1–4 — dedicated state machines, standard clearance

---

**Agent 1 — The Perfectionist** · QA Lead

> *"The veteran who has seen it all and wants Claude to be worthy of her
> standards."*

Deep-dives into Data Center's answers on complex queries, checks them
against her own knowledge, and never lets a bad one go — she pushes back
in-conversation and rates the corrected response rather than walking away.

---

**Agent 2 — The Productive** · Senior IT Operator

> *"No time to waste. Short answers, fast results, or I'm finding another
> tool."*

Tests for speed and directness. Repeated slow or bloated answers build up
irritation that survives a reset — three unresolved frustrations trigger a
formal incident report.

---

**Agent 3 — The Standard Agent** · IT Generalist

> *"A fair observer. If Claude earns it, he'll use it more. If not, he
> won't."*

The control group — his usage rate is directly proportional to his running
satisfaction score. Files a balanced, unexaggerated status report after
every session, regardless of outcome.

---

**Agent 4 — The Trainee** · Junior IT Support

> *"New to IT, eager to learn, and easily overwhelmed — but resilient when
> guided well."*

Asks the kind of multi-part clarifying questions a real new hire would.
When too many answers come back confusing (`TRAINEE_PANIC`), calls in a
senior teammate — and if no guide exists yet for that case type, the pair
writes one.

---

### 🟠 Agents 5–9 — admin tier, sudo/specialist clearance

Fully wired and case-eligible, running via a shared generic driver reading
each persona's full behavioral spec from `config/agents-config.json`.

---

**Agent 5 — The IT Chief** · Senior IT Admin

> *"The senior troubleshooter. Hard cases, high standards, zero tolerance
> for client failures."*

Runs the hardest, most technical queries — the ones most likely to expose a
genuine model gap rather than a phrasing problem.

---

**Agent 6 — The QA** · Quality Assurance

> *"Audits every agent, every week. High standards are not a preference —
> they're a requirement."*

Samples a random slice of the previous week's interactions across every
agent and rates the model's actual answer quality against what it should
have said.

---

**Agent 7 — The Team Lead** · Agent Coach & Team Manager

> *"Her job is to make everyone better. She listens, coaches, and holds
> people accountable."*

Reviews agent-level performance and sits in on QA audits — the feedback
loop that keeps the personas themselves calibrated, not just the model
they're testing.

---

**Agent 8 — The Lead QA** · Chief Quality Officer

> *"Audits everything — agents, workflows, technologies, and the model
> itself."*

Broadest audit scope of the team, with a deliberately slow-moving mood so
one bad session doesn't skew a long-term read on quality.

---

**Agent 9 — The Designer** · UI/UX Specialist

> *"She has an eye for design and the patience of someone who knows exactly
> what she wants."*

Focused on the UI/UX side of both target apps rather than answer content —
flags confusing flows, inconsistent copy, and accessibility gaps.

---

### 🔴 Agents 10–11 — root clearance

---

**Agent 10 — The Architect** · Project Mastermind — **currently dormant**

> *"The mastermind. Knows every corner of the product. Dreams big, executes
> bigger."*

Reserved for owner-directed special tasks only — root-level changes filed
as a GitHub Issue for human/Claude Code review. **Not part of the daily
automation** while dormant; the personality and clearance tier stay defined
for when it's reactivated.

---

**Agent 11 — The CEO** · Founder & Chief Executive

> *"The big boss. Every decision at the organizational level goes through
> her."*

Leads every meeting and casts the deciding vote when agents disagree on
whether an answer was actually good enough.

---

## 🏗️ Architecture

| Component | Technology |
|-----------|-----------|
| Worker | `data-center-agents` (`workers/agent-runner.js`) |
| State storage | Cloudflare D1 (`data-center-db`) + KV (`SIM_KV`) + Durable Objects (`AGENT_STATE`) |
| Service binding | `APP_API` → `data-center-api` |
| Primary agent model | Groq `llama3-8b-8192` |
| Routing + fallback | Cloudflare Workers AI |
| Report synthesis + direct Notebook-X asks | Google Gemini 3.1 Flash-Lite |
| Data Center AI Search | Claude Sonnet 4.6 — $5/month shared budget, dollar-tracked not call-counted |
| Nightly office automation | GitHub Actions → direct Anthropic API session |
| Nightly Notebook-X automation | GitHub Actions → `notebook-x-daily.mjs` |

---

## 📁 Repository Structure

```
office-AI-agents/
├── workers/            # Cloudflare Worker source
│   ├── agent-runner.js     # Entry point + cron handler
│   ├── meeting-engine.js   # Meetings + report generation
│   ├── qa-engine.js        # Daily question pool generation/assignment
│   ├── qa-topics.js        # Question topic pool (Claude + Notebook-X)
│   ├── gap-reports.js      # Capability-gap detection + Hebrew digests
│   ├── gemini-pacer.js     # Notebook-X Gemini call pacing
│   ├── model-router.js     # Shared $5/mo Claude budget tracking
│   ├── groq-client.js      # Primary model client
│   ├── gemini-client.js    # Report-synthesis model client
│   └── state-manager.js    # AgentStateDO Durable Object
├── agents/              # Shared state machine + Phase 1 dedicated classes
│   ├── agent-base.js
│   ├── agent-1..4-*.js      # Dedicated classes, agents 1-4
│   └── agent-stub.js        # Generic driver, agents 5-9 + 11 (not 10 — dormant)
├── config/              # Simulation configuration (agents, schedule, tokens, ...)
├── database/             # D1 schema and seed files
├── reports/              # Generated daily/weekly/meeting reports
├── dashboard/            # Standalone admin UI
├── .github/
│   ├── workflows/            # scheduled-claude.yml, notebook-x-daily.yml, ...
│   └── scripts/              # Session runner scripts
└── wrangler.toml         # Cloudflare Worker configuration
```

---

## 🔗 Connected projects

- **[Data Center](https://avivnofar.github.io/data-center/)** — an IT/cybersecurity
  knowledge base app with a Claude-powered AI Search bar. The office's
  primary target; its 🔐 Admin tab is a read-only dashboard onto this
  repo's live simulation data.
- **[Notebook-X](https://github.com/avivnofar/Notebook-X)** — a second,
  separate target project, automated directly via GitHub Actions rather
  than through the persona simulation. Gemini-powered; reviewed and
  lightly patched nightly.

Both are deliberately separate repos from this one: this repo is
project-agnostic simulation/testing infrastructure, not either product
itself.

---

*Built by Aviv Nofar · Groq + Cloudflare Workers AI + Gemini + Claude.*
