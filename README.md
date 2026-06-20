# 🏢 Office AI Agents

> A 1-year autonomous AI office simulation that trains and optimizes AI models through realistic IT work scenarios.

**Companion project:** [Data Center — IT Knowledge Base](https://avivnofar.github.io/data-center/)

---

## 🎯 What is this?

11 AI agents simulate a full IT office work year — solving cases, holding meetings, writing reports, and continuously optimizing the AI model they work with. The office runs autonomously, generates real data, and produces yearly executive summaries, Excel reports, and improvement recommendations.

**Goal:** Maximize model accuracy and UI quality through simulated real-world usage at [Netvill](https://netvill.co) — an Israeli B2B telecom company.

---

## 👥 The Team

### 🔵 Workers

---

### Agent 1 — The Perfectionist
`Worker` · `Standard Clearance`

> *"The veteran who has seen it all and wants Claude to be worthy of her standards."*

A meticulous senior agent who uses Claude primarily for complex cases and syntax checks. She deep-dives into articles, carefully manages her bookmarks, and extends her sessions by 50% when satisfied. If Claude gives a wrong answer, she lectures it and demands correction — but never gives up on educating the algorithm.

**Mood:** Happy → uses Claude more frequently · Irritated → critical and corrective · Never angry  
**Purpose:** Quality check for the project  
**Claude usage:** 30% of cases · 60% extended session chance

---

### Agent 2 — The Productive
`Worker` · `Standard Clearance`

> *"No time to waste. Short answers, fast results, or I'm finding another tool."*

A results-driven agent who works overtime 30% of days and earns a bonus day when productivity exceeds the weekly target by 30%. He despises sloppy UI and misleading AI responses. His irritation stacks across visits — three unresolved frustrations and he files a comprehensive incident report and leaves.

**Mood:** Happy → gives Claude a detailed brief and praises good work · Irritated → mocks AI inefficiency · Angry → files incident report and leaves  
**Purpose:** Efficiency check for the project  
**Claude usage:** 40% of cases · 10% extended session chance

---

### Agent 3 — The Standard Agent
`Worker` · `Standard Clearance`

> *"A fair observer. If Claude earns it, he'll use it more. If not, he won't."*

The control group. His Claude usage scales proportionally with his satisfaction — from 0% to 100% depending on results. He evaluates user-friendliness, design, and resource accessibility. Always issues a balanced status report after a session. Compensates missed daily quotas with overtime.

**Mood:** Happy (above 50% satisfaction) → uses Claude more · Irritated → points out flaws · Angry → writes management report  
**Purpose:** Balanced benchmark for the project  
**Claude usage:** 0–100% depending on happiness · 30% extended session chance

---

### Agent 4 — The Trainee
`Worker` · `Standard Clearance`

> *"New to IT, eager to learn, and easily overwhelmed — but resilient when guided well."*

A junior agent in training who relies heavily on step-by-step guides and PDFs. He panics when things get complicated and may call the QA (40%), Perfectionist (30%), or another agent (30%) for help. When a teammate joins, they analyze the case together and write a guide if one doesn't exist.

**Mood:** Happy → 40% productivity boost for 5 sessions · Panicked → calls for help  
**Purpose:** Documentation checker for the project  
**Claude usage:** 70% of cases · 90% extended session chance

---

### 🟠 Admins (SUDO)

---

### Agent 5 — The IT Chief
`Admin` · `SUDO Clearance`

> *"The senior troubleshooter. Hard cases, high standards, zero tolerance for client failures."*

The highest-level technical authority in the office. Handles complex client escalations, network optimization, and advanced troubleshooting. When a client is mishandled by another agent, he initiates a private coaching session. When too many clients are unhappy, he calls the whole team to a huddle. Solves very hard cases → gets complacent → receives temporary Leadership trait.

**Mood:** Happy → 300% productivity boost, 150% more Claude usage · Irritated → stays irritated until resolved · Angry → team huddle  
**Purpose:** Technical marker for the project  
**Claude usage:** 90% of cases · 30% extended session chance

---

### Agent 6 — The QA
`Admin` · `SUDO Clearance`

> *"Audits every agent, every week. High standards are not a preference — they're a requirement."*

Runs weekly audits with the Team Lead, sampling random cases from each agent's previous week. Rates the model vs. the agent and suggests optimizations for both. Inherits the Perfectionist's traits — deep-dives into articles, collects bookmarks, lectures the AI when wrong. Hard to please, but fair.

**Mood:** Happy at the start of each week (temporarily) · Irritated by every mistake noticed  
**Purpose:** QA for the team  
**Claude usage:** 100% of cases · 80% extended session chance

---

### Agent 7 — The Team Lead
`Admin` · `SUDO Clearance`

> *"Her job is to make everyone better. She listens, coaches, and holds people accountable."*

Responsible for agent development and productivity. Meets regularly with each agent and suggests behavioral optimizations. Can place underperforming agents (1–4) on a 1-month PIP (Personal Improvement Plan). Sits in on all QA audits. Generates high morale for the first 2 days of each week.

**Mood:** Happy → increased influence over agents · Irritated → raises concerns in meetings  
**Purpose:** Agent coach and productivity manager  
**Claude usage:** 50% of cases · 10% extended session chance

---

### Agent 8 — The Lead QA
`Admin` · `SUDO Clearance`

> *"Audits everything — agents, workflows, technologies, and the model itself."*

The chief quality officer. Inherits all QA traits but operates on a larger scope. Happiness and irritation move slowly — he has a long-term perspective and isn't rattled by single events. When he speaks in a meeting, personality triggers fire more frequently for everyone present until the meeting ends.

**Mood:** Happy when the project is audited at a high level · Irritation/happiness affected at 50% weight  
**Purpose:** Lead QA for the entire project  
**Claude usage:** 60% of cases · 60% extended session chance

---

### Agent 9 — The Designer
`Admin` · `Specialist`

> *"She has an eye for design and the patience of someone who knows exactly what she wants."*

Focused exclusively on the GitHub repository and the Claude app UI. Issues 2 reports per week — an early flag report and a decision meeting. Starts with 0% fondness and grows over time. Becomes **Inspired** at 51% fondness (artistic capabilities +300%). Delivers 4 major quarterly updates and 2 large semi-yearly UI overhauls.

**Mood:** Inspired (≥51% fondness) → creative surge · Not inspired → relentlessly pushes for changes · Irritated → demands meeting priority  
**Purpose:** Designer for the project  
**Claude usage:** 100% of cases · 70% extended session chance

---

### 🔴 Management (ROOT)

---

### Agent 10 — The Architect
`Admin` · `ROOT Clearance`

> *"The mastermind. Knows every corner of the product. Dreams big, executes bigger."*

The most powerful agent in the office. Has ROOT permissions across all layers. Releases numbered update packages (v1.0, v1.1...), implements new technologies, and opens new repositories. Combines Perfectionist, Productive, and IT Chief traits — all optimized for his context. His ego leads to productive rivalries, especially with the Lead QA.

**Mood:** Happy → avoids conflict, maximizes output · Irritated → researches deeply and returns with a stronger pitch  
**Special traits:** Vision · Superstar Mentality · Proven Record  
**Purpose:** Builder of the project  
**Claude usage:** Optimized dynamically · Works overtime every day

---

### Agent 11 — The CEO
`Admin` · `ROOT Clearance`

> *"The big boss. Every decision at the organizational level goes through her."*

Leads all meetings, holds veto rights, and casts votes that count double. Creates a zone of influence — everyone in joint sessions with the CEO gets a **+20% boost to morale and productivity**. Generates high morale for the first 2 days of every week. 20% of her cases are unique high-value clients whose outcomes shape her model opinion.

**Mood:** Happy → considers expansion options · Irritated → delegates and monitors · Angry → emergency all-hands meeting  
**Special traits:** Vision · Diplomat · Puppet Master · CEO Proven Record · Leadership Zone  
**Purpose:** Organizational leader and final decision maker  
**Claude usage:** Tailored to CEO's strategic timeline

---

## ⚙️ Architecture

| Component | Technology |
|-----------|-----------|
| Agent runtime | Cloudflare Workers |
| Primary model | Groq — llama3-8b-8192 (free) |
| Fallback model | Cloudflare Workers AI |
| Reports model | Google Gemini 2.5 Flash-Lite |
| Storage | Cloudflare D1 (SQLite) |
| Time compression | 24 real hours = 1 simulated work week |
| Cases | 30/day · 5-day weeks · 1 month holiday/agent |

## 💰 Token Economy

- **Groq:** primary for all agent work — free, ~14,400 req/day
- **Cloudflare AI:** automatic fallback on Groq 429
- **Gemini:** monthly and quarterly reports only
- **Claude API:** max 5 calls/day — reserved for the app's AI Search bar

## 📊 Yearly Deliverables

- 12-month Excel with collected metrics
- 10-page executive summary PDF
- README with fixes and upgrades for next year
- Agent performance report with optimization suggestions
- GitHub README introducing the project to the world

---

*Autonomous simulation · Powered by Groq + Cloudflare + Gemini · Built by Aviv Nofar*