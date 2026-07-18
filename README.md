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

Two automation paths (a third was retired 2026-07-18), each targeting a
different surface — the Worker cron is live, the nightly Action is
currently manually disabled:

### 1. Cloudflare Worker cron (live — the Q&A engine's schedule)
Fires every 30 minutes, **02:00–16:30 Israel time** (`*/30 0-13,23 * * *`
UTC), every day — covering the owner's 02:00–16:30 activity window. Each
tick checks `config/daily-schedule.json` and runs whatever block is due —
question batches (spread across six slots through the day so asks trickle
out rather than burst, with Notebook-X calls additionally paced ~20s apart
by `gemini-pacer.js`), a daily report, a standup, spare time — against
both [Data Center](https://avivnofar.github.io/data-center/) (Claude) and
[Notebook-X](https://github.com/avivnofar/Notebook-X) (Gemini). State
persists between ticks in Cloudflare KV.

Live since **2026-07-19** — the first activation of the Q&A engine. The
first three days ramp volume through a self-expiring graduated-rollout
throttle: 12 questions on day 0, 40 on day 1, 100 on day 2, then automatic
step-up to normal budget-driven volume with no manual change needed.

### 2. GitHub Actions — nightly maintenance session (`scheduled-claude.yml`, currently disabled)
When enabled, fires at **02:30 Israel time, Sunday–Thursday**. Runs a single direct
Anthropic API session that reviews the repo's own state and commits its
output (reports and doc updates — code-file writes are blocked by default)
back to this repo. A separate path from the Worker cron above: this one
maintains the simulation's own repo, while the Worker runs the office day
itself. Friday and Saturday are skipped (Israeli weekend).

### 3. ~~GitHub Actions — Notebook-X daily~~ (retired 2026-07-18)
The former nightly Notebook-X content-fill automation
(`notebook-x-daily.yml` + `notebook-x-daily.mjs`) was deleted 2026-07-18 —
superseded by the Q&A engine, which now covers
[Notebook-X](https://github.com/avivnofar/Notebook-X) through the personas'
own read-only question path. See `CLAUDE.md`'s "Connection to Notebook-X"
for the history (including the production incident that shaped the standing
no-automated-writes rule).

---

## 🤖 AI Model Distribution

| Model | Provider | Role | Cost |
|-------|----------|------|------|
| `llama3-8b-8192` | **Groq** | Primary model for all routine per-question agent work | Free, ~14,400 req/day |
| `llama-3.1-8b-instruct-fp8` | **Cloudflare Workers AI** | Question routing/classification + same-session fallback when Groq or Gemini is unavailable | Free, account-scoped |
| **Gemini 3.1 Flash-Lite** | Google AI Studio | Report synthesis (monthly/quarterly/yearly meetings) **and** direct Notebook-X question-asking (paced ~1 call/20s from this automation — Gemini's free-tier quota is shared with Notebook-X's own traffic) | Free tier, ~1,500 req/day |
| **Google AI Studio** (interactive) | Google | Reserved for human-in-the-loop creative-tool sessions (Agents 9/10 building design assets) — never called programmatically | n/a |
| `claude-sonnet-4-6` | **Anthropic** | Data Center's AI Search bar. **Shared $4.50/month soft-stop budget** across the Q&A engine (10 active personas) and the chore-automation economy — a per-month dollar cap tracked in D1 and checked in software before every call, deliberately below the account's own $5/month spend ceiling (the hard backstop) — not a per-day call count | Paid, low volume |

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
| Data Center AI Search | Claude Sonnet 4.6 — $4.50/month shared soft-stop (under the account's $5/month ceiling), dollar-tracked not call-counted |
| Nightly office automation | GitHub Actions → direct Anthropic API session |
| Notebook-X coverage | Q&A engine (`_askNotebookX()`, read-only, Gemini-paced) — the nightly `notebook-x-daily.mjs` automation was retired 2026-07-18 |

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
│   ├── model-router.js     # Shared $4.50/mo Claude budget tracking
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
│   ├── workflows/            # scheduled-claude.yml, ...
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
  separate target project, covered since 2026-07-18 through the persona
  simulation's own Q&A path (read-only Gemini questions against its
  notebooks; the former nightly GitHub Actions automation is retired).

Both are deliberately separate repos from this one: this repo is
project-agnostic simulation/testing infrastructure, not either product
itself.

---

*Built by Aviv Nofar · Groq + Cloudflare Workers AI + Gemini + Claude.*
