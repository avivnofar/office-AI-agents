# CLAUDE.md — Data Center IT Knowledge Base
## Project Bible (Bilingual Edition)

---

## Project Overview

**Data Center** is a static single-page bilingual (Hebrew/English) IT troubleshooting reference built for sysadmins, DevOps engineers, and IT students. It delivers searchable command cards, hover tooltips, and step-by-step troubleshoot scenarios — all as a zero-dependency static HTML file deployable to any static host.

**Live site:** [avivnofar.github.io/data-center](https://avivnofar.github.io/data-center)

**Hebrew default:** The UI defaults to Hebrew with RTL layout. Language is toggled via a button and stored in `localStorage` key `dc-lang`.

---

## Current Strategy (authoritative)

This section reflects the project owner's current direction and supersedes
any conflicting framing elsewhere in this file or in `agents/README.md` /
`agents/AGENTS.md`. Nothing described here requires deleting existing work.

- **One Gemini engine, not eleven Workers.** The AI Agent Simulation's end
  goal — a full 1-year office simulation with all 11 agent personalities
  (per the project's spec document) — remains the goal. The infrastructure
  choice is a single Gemini-backed Cloudflare Worker (`agent-runner.js` /
  `data-center-agents`) that role-plays all 11 personas by reading
  `agents/config/agents-config.json`, rather than 11 independent
  Workers/Durable Objects running in parallel.
- **Existing simulation work is the data layer, not dead code.** The
  simulation runtime, `agents-config.json`, `simulation-config.json`, the
  year-tracker config, side-plot narrative config, and promotion/PIP track
  config all stay as-is — they are the spec the single engine reads from
  and acts on.
- **UI polish is the immediate priority.** Before running the full-year
  simulation, focus on making `index.html` excellent and scalable for heavy
  use: a working Claude AI Search end-to-end, fast, mobile-ready,
  Hebrew/English. See `TOKEN-BUDGET.md` for the session queue.
- **Findings flow back via GitHub Issues.** Once the UI is solid, the
  single Gemini agent exercises the live app like a real user and reports
  findings via Issues (the Gemini-Claude bridge, `claude-action` label) to
  improve the app and database.
- See `agents/STRATEGY.md` for the agents/-folder-specific version of this.

---

## Launch Decisions (authoritative)

Decisions from the 2026-06-11 launch-planning session for the AI Agent
Office Simulation. These supersede any conflicting framing in
`agents/README.md`, `agents/AGENTS.md`, or `TOKEN-BUDGET.md`.

- **Cost model**: `gemini-2.5-flash-lite` (paid) runs the entire office
  simulation (~$2-3/quarter at target volume). The Anthropic/Claude API
  (`data-center-api`) is reserved for the app's AI Search bar, senior-agent
  "hard case" escalations, and Architect/sudo-tier fixes only. Monthly
  ceiling: $5-15 total — most months should land near $0.
- **Simulation parameters**: 5-day simulated work weeks, ~30 cases/day per
  active agent, and 1 simulated month of flexible holiday per agent per
  simulated year (scheduled to fit simulation needs — can be 1+
  non-contiguous days). The first run is **one quarter**, not the full
  year — see `TOKEN-BUDGET.md`.
- **Checkpoints**: save full simulation state (D1 export/snapshot) before
  any major model, UI, or agent-behavior change, plus quarterly backups.
  Not monthly.
- **Report permission tiering**: private reports (internal agent
  discussion, mood/irritation detail) are staff(agents)+owner only. Public
  reports are business-facing external-comms framing, scrubbed of internal
  detail. Special reports (sensitive strategy/architecture) are AI staff +
  owner only — never public. Trade secrets (prompts, internal scoring,
  cost data) stay staff/owner-only.
- **Stop logic**: on error, auto-fix first (try a minimal fix, then a
  fallback, then a second fallback); only halt the simulation if truly
  unfixable or a cost cap is hit. Narrative "story events" (an agent
  quitting, a rivalry escalating, etc.) are logged as normal output and
  never halt the run.
- **Models**: `gemini-2.5-flash-lite` for the office simulation
  (`gemini-2.0-flash` is deprecated — do not reintroduce it),
  `claude-sonnet-4-6` for `data-center-api`.
- **Architecture (3 Workers)**: `data-center-api` (Claude proxy — AI
  Search/Diagnose/CLI + escalations), `data-center-agents` (Gemini office
  simulation, ONE Worker, all 11 personas via `agents-config.json`),
  `data-center-db` (shared D1 storage).
- **Token discipline**: batch config/data updates, prefer releasing changes
  at simulated-month boundaries, lean on Gemini (not Claude Code sessions)
  for heavy/bulk content generation, and stop sessions at convenient round
  moments (commit + `TOKEN-BUDGET.md` update).

---

## Folder Structure

```
data-center/
├── index.html                   # Entire app — HTML + CSS + JS in one file
├── data/
│   ├── modules.json             # Tab registry — source of truth for all modules
│   ├── linux.json               # Linux commands (42 entries)
│   ├── cmd.json                 # Windows CMD commands (25 entries)
│   ├── network.json             # Cross-platform network + VoIP/SIP tools (30 entries)
│   └── troubleshoot.json        # Step-by-step troubleshoot scenarios (18 entries)
├── flagged/                      # Source flagging system (see Rules section)
│   ├── README.md                # How the pending → approved/rejected flow works
│   ├── pending-review.md        # Candidate source URLs awaiting review
│   ├── approved-sources.md      # Specific URLs verified and in use
│   └── rejected-sources.md      # URLs rejected, with reason
├── .github/
│   ├── scripts/
│   │   ├── validate-json.js     # Schema + bilingual field validator
│   │   ├── health-check.js      # Weekly quality checks with Hebrew QA
│   │   └── check-links.js       # Daily source_url reachability check
│   └── workflows/
│       ├── validate.yml         # Runs on every push/PR
│       ├── changelog.yml        # Auto-generates CHANGELOG.md
│       ├── health.yml           # Weekly Monday 08:00 UTC + manual trigger
│       ├── link-check.yml       # Daily 06:00 UTC — checks source_url links
│       ├── monthly-review.yml   # Monthly 1st @ 08:00 UTC — flags pending sources
│       ├── agent-cases.yml      # Weekly Monday 09:00 UTC — generates agent simulation case batch
│       └── agent-reports.yml    # Weekly Tuesday 08:00 UTC — agent simulation weekly report
├── cloudflare-worker/            # AI Search backend (Cloudflare Worker, Claude API)
├── agents/                       # AI Agent Simulation (DRAFT, Phase 1) — see agents/README.md
│   ├── config/                   # simulation-config.json, agents-config.json
│   ├── workers/                  # agent-runner.js, scheduler.js, case-generator.js, gemini-client.js, state-manager.js
│   ├── agents/                   # agent-base.js + per-agent classes (agent-1..4-*.js, agent-stub.js)
│   ├── dashboard/                # standalone admin dashboard (admin-panel.html, dashboard.js)
│   ├── reports/templates/        # incident/status/weekly report markdown templates
│   ├── database/                 # D1 schema.sql + seed-cases.sql
│   ├── README.md                 # setup, architecture, env vars
│   └── AGENTS.md                 # agent specification reference (summary, not final)
├── .nojekyll                    # Prevents GitHub Pages Jekyll processing
├── CLAUDE.md                    # This file
├── ROADMAP.md                   # Phase milestones
├── CHANGELOG.md                 # Auto-generated
└── .gitignore
```

**Sibling repo:** [`data-center-archive`](https://github.com/avivnofar/data-center-archive) holds longer-form
bilingual workflow documents (rendered in the in-app "Workflows" tab) and
generated PDFs. See [Workflows Archive](#workflows-archive-data-center-archive) below.

---

## Running Locally

`init()` uses `fetch()` — opening as `file://` fails with CORS. Use:

```bash
python -m http.server 8080
# open http://localhost:8080
```

Or: `npx serve .`

---

## Bilingual Schema

All JSON files use a bilingual field naming convention:
- `field_he` — Hebrew content
- `field_en` — English content

The `t(entry, 'field')` helper in `index.html` returns the correct language based on `LANG`.

### `data/linux.json`, `data/cmd.json`, `data/network.json`, `data/1com.json`, `data/mirtapbx.json`

```jsonc
{
  "id":         string,    // REQUIRED. Unique slug, kebab-case (e.g. "netstat")
  "name":       string,    // REQUIRED. Display name in card header
  "cat":        string,    // REQUIRED. Category — see allowed values per file
  "diff":       string,    // REQUIRED. "beginner" | "intermediate" | "advanced"
  "sec":        boolean,   // REQUIRED. true if security note should be shown
  "desc_he":    string,    // REQUIRED. Hebrew description (one sentence)
  "desc_en":    string,    // REQUIRED. English description (must differ from desc_he)
  "source_url": string,    // REQUIRED. Official docs URL (approved domains only)
  "source_name":string,    // REQUIRED. Human-readable source name
  "usage": [
    {
      "cmd":    string,    // REQUIRED. The shell command — NO Hebrew characters
      "cmt_he": string,    // REQUIRED. Hebrew explanation
      "cmt_en": string     // REQUIRED. English explanation
    }
  ],
  "quick_flags": [         // OPTIONAL. Array of flag reference entries
    {
      "flag":   string,    // REQUIRED. The flag (e.g. "-n") — NO Hebrew
      "desc_he":string,    // REQUIRED. Hebrew description
      "desc_en":string     // REQUIRED. English description
    }
  ],
  "scenarios_he": [string], // REQUIRED. 2-4 Hebrew bullet points: when to use
  "scenarios_en": [string], // REQUIRED. 2-4 English bullet points: when to use
  "mistakes": [
    {
      "x_he":   string,   // REQUIRED. Hebrew — what the mistake is
      "x_en":   string,   // REQUIRED. English — what the mistake is
      "fix_he": string,   // REQUIRED. Hebrew fix (may contain inline HTML)
      "fix_en": string    // REQUIRED. English fix (may contain inline HTML)
    }
  ],
  "secnote_he": string,    // OPTIONAL. Hebrew security note (inline HTML ok)
  "secnote_en": string,    // OPTIONAL. English security note (inline HTML ok)
  "tags":       string     // REQUIRED. Space-separated search keywords
}
```

#### Allowed `cat` values

| File | Valid categories |
|------|-----------------|
| `linux.json` | `network`, `process`, `disk`, `permission`, `system`, `logs`, `user` |
| `cmd.json` | `network`, `process`, `disk`, `system`, `user` |
| `network.json` | `diagnostic`, `ports`, `routing`, `dns`, `firewall`, `voip` |
| `1com.json` | `hardware`, `config`, `ivr`, `queue`, `omnichannel`, `monitoring`, `integration` |
| `mirtapbx.json` | `architecture`, `cluster`, `sip`, `recording`, `reporting`, `integration`, `webrtc` |

### `data/troubleshoot.json`

```jsonc
{
  "id":          string,  // REQUIRED. Must start with "ts-"
  "title_he":    string,  // REQUIRED. Hebrew scenario title
  "title_en":    string,  // REQUIRED. English scenario title
  "plat":        string,  // REQUIRED. "linux" | "windows" | "network" | "cross-platform"
  "severity":    string,  // REQUIRED. "critical" | "high" | "medium" | "low"
  "desc_he":     string,  // REQUIRED. Hebrew failure mode description
  "desc_en":     string,  // REQUIRED. English failure mode description
  "steps": [
    {
      "n":       number,  // REQUIRED. Step number (1-based)
      "text_he": string,  // REQUIRED. Hebrew step description
      "text_en": string,  // REQUIRED. English step description
      "cmd":     string,  // REQUIRED. The command to run — NO Hebrew
      "note_he": string,  // REQUIRED. Hebrew explanation of expected output
      "note_en": string   // REQUIRED. English explanation of expected output
    }
  ]
}
```

### `data/modules.json`

```jsonc
{
  "id":            string,          // REQUIRED. Module slug (matches DB key)
  "label_he":      string,          // REQUIRED. Hebrew tab label
  "label_en":      string,          // REQUIRED. English tab label
  "icon":          string,          // OPTIONAL. Emoji icon for tab
  "data_file":     string,          // REQUIRED. Path to data file
  "status":        string,          // REQUIRED. "active" | "coming-soon"
  "filter_type":   string,          // REQUIRED. "command" | "troubleshoot"
  "categories_he": object,          // OPTIONAL. Map of category_key -> Hebrew label
  "categories":    [string]         // REQUIRED. List of valid category keys
}
```

---

## Rules for Adding New Content

1. **Unique IDs** — every entry across all four files must have a unique `id`. Use kebab-case. Troubleshoot IDs must start with `ts-`.

2. **No Hebrew in `cmd` fields** — all shell commands are LTR. The validator rejects Hebrew characters in `cmd`, `quick_flags[].flag`, and `steps[].cmd`.

3. **Bilingual pairs must differ** — `desc_he` must not be identical to `desc_en`. The validator will catch copy-pasted fields.

4. **Hebrew writing style** — natural professional Hebrew. Wrap English technical terms inline with `<span class="ltr-term">term</span>`. Example:
   ```
   "desc_he": "מציגה את ה-<span class=\"ltr-term\">listening sockets</span> עם ה-PID שלהם"
   ```

5. **Code blocks always LTR** — all `<code>` and `<pre>` blocks have `dir="ltr"` attribute. CSS also enforces `direction:ltr; unicode-bidi:isolate`.

6. **Inline HTML in `fix_he/fix_en` and `secnote_he/en`** — these fields render via `innerHTML`. Allowed: `<span class="ltr-term">`, `<b>`, `<code>`. No block elements.

7. **Approved `source_url` domains only:**
   - `man7.org`, `linux.die.net`, `learn.microsoft.com`, `docs.microsoft.com`
   - `ss64.com`, `linux.org`, `kernel.org`, `iana.org`, `rfc-editor.org`
   - `nmap.org`, `wireshark.org`, `ubuntu.com`, `redhat.com`, `debian.org`
   - `cloudflare.com`, `cisco.com`, `tcpdump.org`, `iperf.fr`, `software.es.net`
   - `asterisk.org`, `1com.co.il`, `mirtapbx.com`, `queuemetrics.com`
     (vendor-official docs for Netvill's 1COM / MirtaPBX PBX platforms —
     see "Source Validation (very high)" below and
     `flagged/approved-sources.md`)

8. **Blocked domains** (validator will reject):
   `stackoverflow.com`, `reddit.com`, `medium.com`, `youtube.com`, `github.com`, `geeksforgeeks.org`, `w3schools.com`, `*.blogspot.com`

9. **Security notes only when dual-use** — set `"sec": true` and populate `secnote_he/en` only for meaningfully dual-use commands.

10. **Validate before pushing:**
    ```bash
    node .github/scripts/validate-json.js
    node .github/scripts/health-check.js
    ```

11. **No build step** — do not introduce a bundler, transpiler, or package.json unless adding a build pipeline.

---

## Architecture Notes

- `DB` is a module-level object populated by `async function init()` via `Promise.all(fetch(...))`.
- Tab system is fully data-driven from `modules.json` — zero hardcoded tabs in `index.html`.
- `t(obj, key)` returns `obj.key_he` or `obj.key_en` based on `LANG` global.
- `tArr(obj, key)` same for array fields (`scenarios_he/en`).
- `renderCard()` and `renderTsCard()` generate HTML strings and set `innerHTML`. All user strings pass through `escHtml()` before insertion.
- Hover tooltip: 200ms delay, viewport-aware position calculation, hides on mouseleave.
- Language toggle: sets `LANG`, saves to `localStorage`, calls `applyLang()` + re-renders active tab.

---

## Workflows Archive (`data-center-archive`)

The **Workflows** tab (`📋`, `dataset.moduleId = 'workflows'`, built by
`buildWorkflowsTabBtn()` / `buildWorkflowsPanelShell()` / `renderWorkflowsPanel()`
in `index.html`) renders longer-form bilingual step-by-step workflow documents
that don't fit the command-card schema.

- Workflow metadata lives in the `WORKFLOWS` array in `index.html` (id, bilingual
  title/desc, `path`, `updated`).
- `ARCHIVE_RAW_BASE` points at `raw.githubusercontent.com/avivnofar/data-center-archive/master/`;
  `openWorkflow(id)` fetches `ARCHIVE_RAW_BASE + wf.path` and renders the markdown
  via `renderMarkdown()` (which supports headings, lists, code blocks, and pipe-tables).
- **Graceful fallback**: if the fetch fails (repo not yet pushed, 404, CORS), the
  panel shows a bilingual "archive not connected yet" message linking to
  `ARCHIVE_REPO_BASE + wf.path` on GitHub instead of erroring.
- The archive repo structure: `workflows/<platform>/*.md` (the docs themselves and
  `templates/` for new docs), `pdfs/` (generated PDFs, see below), `flagged/`
  (mirrors this repo's approved/blocked domain rules), `guides/` and `raw/`
  (placeholders for future short-form content).

**Keep the archive lean** — per explicit project direction, do **not** build a
large "raw materials" research database there. Only workflow markdown files and
generated PDFs belong in `data-center-archive`. Anything else worth remembering
(reference links, research notes, source candidates) belongs in Claude's own
persistent memory, not in repo files. See [Autonomous Brain Rules](#autonomous-brain-rules).

---

## PDF Export (Print-Based)

Workflow pages can be exported to PDF via the **"📄 Generate PDF"** floating
action button (`#pdf-fab`, shown/hidden by `showPdfFab()`/`hidePdfFab()`).

- `generatePdf()` simply calls `window.print()` — **no bundler, server, or
  headless-browser dependency** (consistent with the "no build step" rule).
- The active workflow's content container gets a `.print-target` class.
- A `@media print` CSS block hides everything except `.print-target`
  (topbar, tab nav, search, AI banner, workflow list, FAB, back button are all
  force-hidden), forces white background / black text, and keeps `<pre>`/`<code>`
  blocks LTR even when the page is RTL.
- Resulting PDFs are expected to be saved into `data-center-archive/pdfs/`
  (manually, or via future automation) — see that repo's `pdfs/TABLE_OF_CONTENTS.md`.

---

## Bookmark System

In AI chat responses, any URL Claude mentions gets a small "bookmark bar"
(`renderBookmarkBars()`, called from `finalizeStreamingBubble()` and
`appendMessageBubble()`) with **Save** / **Dismiss** actions.

- Saved URLs persist to `localStorage` key `dc-bookmarks`; dismissed ones to
  `dc-dismissed-bookmarks`. Both read/written via `getSavedBookmarks()` /
  `getDismissedBookmarks()`.
- **Client-side only, no credentials** — this intentionally replaces an earlier
  design that would have committed bookmarks to GitHub via a client-embedded
  write token. Never reintroduce a design that ships write credentials to the
  browser; if "save to archive" is wanted later, it must go through a
  server-side component (e.g. the Cloudflare Worker) that holds the token.

---

## Source Flagging System

`flagged/` tracks candidate documentation sources before they become a
`source_url`: `pending-review.md` → `approved-sources.md` or
`rejected-sources.md`. See `flagged/README.md` for the workflow. The
canonical approved/blocked **domain** lists remain Rules 7-8 below — `flagged/`
tracks specific **URLs**, not domains, and is not a duplicate of those rules.

---

## Source Validation (very high)

Source-validation strictness is **very high** for all AI-suggested sources —
from the app's AI Search, the self-education flow (see "AI Capabilities"
below), or agent suggestions:

- **Approved-domain allowlist (Rules 7-8) is necessary but not sufficient.**
  A URL on an approved domain from a publisher/path the system hasn't cited
  before goes into `flagged/pending-review.md` with `status:
  pending-verification` — it is never added to a `data/*.json`
  `source_url` until a human (or a Claude Code session acting on the
  human's behalf) reviews it.
- **Untrusted publishers require verification before trust.** Anything not
  already listed in `flagged/approved-sources.md` — even on an approved
  domain — must be cross-checked against at least one other approved source
  or official docs before being cited as authoritative in chat or proposed
  for `data/*.json`.
- **Recently-added sources are double-checked.** A source added to
  `flagged/approved-sources.md` in the last 30 days is re-verified (still
  live, content still matches what was cited) before being reused as the
  basis for a new knowledge-base entry.
- **Quarantine, never auto-trust.** Anything failing the above stays in
  `flagged/pending-review.md` indefinitely until reviewed — no automated
  process promotes it to `approved-sources.md`.

---

## AI Capabilities — Self-Extension & Self-Education (`data-center-api`)

`cloudflare-worker/worker.js`'s system prompt grants the app's Claude two
additional capabilities. Both are **read/suggest only** — the live Worker
never gets GitHub write access; everything routes through the
Gemini-Claude bridge (GitHub Issues, `claude-action` label) for
human/Claude-Code review.

- **Self-extending capability**: when a user request needs something the
  knowledge base doesn't support yet (a new module, a new file-type
  handler, a schema extension), Claude answers the user normally and may
  append a structured `<!-- CAPABILITY_SUGGESTION: {...} -->` block (JSON
  fields: `type`, `summary`, `proposed_change`, `affected_files`). The app
  detects this block and offers to file it as a `claude-action` GitHub
  Issue.
- **Internet search + self-education**: the worker's Claude API call
  includes the `web_search` tool so chat answers can search and cite live
  sources. When a searched source proves directly useful for a query
  matching an existing `data/*.json` category, Claude may append a
  `<!-- LEARNED_SOURCE: {...} -->` block (JSON fields: `url`,
  `proposed_field` e.g. `linux.json:netstat.source_url`, `reason`). The app
  offers to file this as a `claude-action` Issue too — it is never written
  directly to `data/*.json`, and must pass "Source Validation (very high)"
  above before merge.

---

## AI Agent Simulation (`agents/`)

`agents/` scaffolds a simulated "AI agent team" that uses the live app
(via `data-center-api`'s `/api/chat`) like real sysadmins, role-played by
Gemini 2.5 Flash-Lite. **Status: DRAFT (Phase 1 foundation)** — agents 1-4
("The Perfectionist", "The Productive", "The Standard Agent", "The Trainee")
have full mood/irritation/panic state machines; agents 5-11 have full
character specs in `agents-config.json` (status: `specified`) but run via
the generic `agent-stub.js` (no dedicated state machine yet). See
`agents/README.md` (architecture, setup, env vars) and `agents/AGENTS.md`
(per-agent behavior summary) — both still describe an older two-Worker
design and are due a rewrite (see `TOKEN-BUDGET.md`).

- **Workers**: `agent-runner.js` (admin HTTP API + agent execution) and
  `scheduler.js` (cron-driven hourly "work day" / daily "work week" cycles)
  are Cloudflare Workers backed by D1 (`agents/database/schema.sql`),
  Durable Objects (`state-manager.js`), and KV (`SIM_KV` for live
  `inspection_mode`/`paused`/`phase` overrides). None of this is deployed by
  this commit — see `agents/README.md`'s manual setup steps.
- **Admin tab**: the in-app 🔐 Admin tab (`dataset.moduleId = 'admin'`,
  `buildAdminTabBtn()`/`buildAdminPanelShell()`/`renderAdminPanel()` in
  `index.html`) is a read-only-by-default dashboard (agent status grid, live
  session feed, reports/suggestions, simulation controls, performance
  metrics). A standalone equivalent lives at `agents/dashboard/admin-panel.html`.
- **Admin auth**: the dashboard never ships a real secret. The admin types a
  token into the page once (stored in `localStorage` as `dc-admin-token`,
  sent as the `X-Admin-Token` header); `agent-runner.js` and `scheduler.js`
  validate it server-side against `env.ADMIN_TOKEN` (a Worker secret). This
  is the same pattern required by the credential rules below — never embed
  `ADMIN_TOKEN` (or `GEMINI_API_KEY`/`GITHUB_TOKEN`) in `index.html` or
  `dashboard.js`.
- **CI**: `agent-cases.yml` and `agent-reports.yml` (see Automation
  Workflows below) keep the simulation's case pool and weekly reports
  flowing once the Workers are deployed.

---

## Daily Automation & AI-Tool Coordination

Built on the 2026-06-12 daily-automation session. Defines the tactical
24-hour schedule the office simulation runs (config only — **no cron is
wired to it yet**; see "Status" at the end of this section).

### Day types (`agents/config/daily-schedule.json`)

`runWorkDayCycle()` maps `dayOfWeek` (1-7, derived from `current_day` as
before) to an Israeli work week, per the Launch Decisions' "work days
Sunday-Thursday":

| `dayOfWeek` | Day | Schedule |
|---|---|---|
| 1-5 | Sun-Thu | **Full day**: 5 case-batch triggers (08:00 30%, 09:30 20%, 11:00 20%, 13:00 20%, 14:30 10%), a tool-task window (11:30), the daily AI-experience report block (15:30), daily standup + spare time (16:00) |
| 6 | Fri | **Short day**: 2 case batches (08:00 60%, 10:00 40%), AI-experience report (10:30), weekly executive summary meeting + PDF/Excel (12:00), standup + spare time (12:00) |
| 7 | Sat | **Off**: zero case batches, zero meetings, zero Gemini/Claude calls — pure idle (token-saving) |

**Case volume is unchanged** — the existing ~50/day CRM pool
(`crm-engine.js generateAssignedDailyBatch()`) is generated once per day as
before and then *partitioned* across that day's case-batch blocks by
`case_share`, preserving each case's unique ID. Per-agent quotas in
`agents-config.json` (`cases_per_day_min/max: 30-50`) remain capacity
ceilings, not a multiplier on this pool — see `daily-schedule.json
_meta.case_volume_design_note`.

### Daily AI-experience reports & model education

At the day's `report` block, every agent who handled >=1 case today files a
short, casual **status report** on their AI Search experience
(`fileStatusReport()` — permission: private, staff/agents + owner). Up to 3
of the day's lowest-quality interactions (quality < 0.6) become **model-
education case studies** (`fileModelEducationCaseStudy()`, `reports` type
`model_education`, permission: special) and — if `GITHUB_TOKEN` is
configured — a `claude-action` + `model-education` GitHub Issue via
`fileModelEducationIssue()`. Without `GITHUB_TOKEN` the report stays queued
in D1 for a human/Claude-Code session to batch-file.

### Spare time / idle (token discipline)

When an agent has no more cases and no meeting, `runSpareTimeForAgent()`
rolls a 20% chance of one short logged "coworker chat" (1 Gemini call,
`interactions` type `coworker_chat`); the other 80% — and *always* on the
Saturday off day — the agent goes **idle**: an `interactions` row (type
`idle`) is logged with **zero** Gemini/Claude calls. This is the primary
token-discipline lever for spare time.

### AI-Tool Access Coordination (`agents/config/ai-tools.json`)

External creative tools (**NotebookLM**, **Stitch**, **Base44**, **Google AI
Studio**) have no unattended API — they are never called programmatically.
The tool-access matrix:

| Tool | Who | Mode |
|---|---|---|
| NotebookLM | Agent 6 (QA) primary; Agents 9/10 secondary | Builds the project's knowledge centers — goal: Claude AI Search answers almost exclusively from these |
| Stitch | Agents 9+10 | Joint sessions only — large/high-value tools/projects |
| Base44 | Any admin (5-11); 9/10 most often | Any, joint sessions get priority |
| Google AI Studio | Agents 9/10 | Joint or independent |

A 5-day Sun-Thu `weekly_rotation` staggers one tool-task slot/day so no two
agents compete for the same tool on the same day, with joint Stitch/Base44
sessions on Mon/Thu. Only the four listed tools are used for content/product
generation — routine cases use the regular models. Default product type is a
**lightweight app**.

### Human-in-the-loop asset pipeline (`agents/reports/asset-pipeline/`)

`board.json` tracks tool-tasks through `queued -> in-progress (human) ->
returned -> tested -> optimized -> implemented`. At each Sun-Thu
`tool_task_window`, `maybeOpenAssetTask()` checks the day's `weekly_rotation`
entry; if the assigned board item is `queued` and not yet filed, it opens an
`asset-task` + `AGENT-N` GitHub Issue (no-ops without `GITHUB_TOKEN`) linking
to a full spec under `agents/reports/asset-pipeline/issues/`. A human
executes the work in the real tool and updates the board entry; agents then
test/optimize the returned asset.

**Seeded standing projects**: `qa-knowledge-base` (NotebookLM, Agent 6),
`archives-app` (Stitch, joint Agents 6/9/10 — "archive mentality" + thin AI
brain over `data-center-archive`), `designer-tooling-suite` (Base44/Google AI
Studio, Agent 9 — free design-tool products), `architect-org-products`
(Google AI Studio, Agent 10 — org-facing products, joint with Designer for
important ones), and `crm-placeholder` (flagged for future development, not
scheduled, no owner agent).

**First completed import — `commandflow`** (stage `returned`, 2026-06-12):
CommandFlow / Terminal Academy is the **first asset to complete the
human-in-the-loop pipeline** and is the **reference pattern** for future tool
imports. It started as a Stitch + Base44 export
(`agents/assets/incoming/commandflow/code.html` + `DESIGN.md` + `screen.png`
— a static dashboard mockup with no working terminal logic) and was rebuilt
by the owner + Claude Code as:

- `tools/commandflow/` — a standalone, zero-build, vanilla HTML/CSS/JS
  "Terminal Academy" product preserving the Stitch design system
  (glassmorphism, traffic-light terminal headers, Inter + JetBrains Mono),
  registered in `data/tools.json` and linked from the main app's topbar
  (`#commandflow-link`).
- `tools/commandflow/commandflow-core.js` + `tools/commandflow/commands.json`
  — a shared, dependency-free simulation engine + command database (7
  platforms: Bash, PowerShell, Cisco, Cloud, Networking, Security, Databases)
  also loaded by the main app's **CLI Mode** (see "Future Assimilation: CLI
  Tools" below) — **same engine/data, different skin** per platform.

Pattern for future imports: human builds in Stitch/Base44 ->
owner/Claude Code produces an owned, zero-build standalone product under
`tools/<name>/` (+ in-app integration if relevant) -> register in
`data/tools.json` -> board item `returned` with a spec file under
`agents/reports/asset-pipeline/issues/<name>.md` -> agents take it through
`tested -> optimized -> implemented`. See
`agents/reports/asset-pipeline/issues/commandflow.md` for the full review
spec (Designer/Architect/QA sub-tasks) queued for AGENT-9/10/6.

### Weekly Friday executive summary

The Friday `weekly_summary` block (`generateWeeklySummary()`) generates
three files under `agents/reports/weekly/`:

- `week-NN-summary.md` — the "PDF": a ~10-section executive markdown
  (case volume, agent performance/mood, model-education findings, incidents,
  side plots, asset pipeline status, suggestions queue, cost/token estimate,
  action items). Print-ready per the existing PDF Export convention.
  Permission: **private/special**.
- `week-NN-data.csv` — the "Excel": per-agent weekly stats (cases, mood,
  irritation). Permission: **private/special**.
- `week-NN-public-summary.md` — short, business-facing excerpt. Permission:
  **public**.

It also runs the existing `weekly` meeting type.

### Product versioning

Each admin-tier agent (5-11) may own at most one "weekly project" on the
asset-pipeline board. When a board item's `history` shows it reached
`implemented` on the current day, `checkProductVersionBumps()` bumps that
product's version by **+0.01** (starting at `1.00`), recording it in both
`board.json` (`item.version`) and `year_stats.stats.product_versions[item.id]`.

### Status

**Per-block cron is live (wired 2026-06-12).** `agents/wrangler.toml` has a
single Cloudflare Cron Trigger, `*/30 5-13 * * *` (every 30 min,
05:00-13:30 UTC = 08:00-16:30 IDT). Each tick, `agent-runner.js`'s
`scheduled()` converts `event.scheduledTime` to Israel local time via
`israelTimeParts()` and calls `runScheduledBlock(env, time, dayOfWeek)`,
which is a no-op unless `daily-schedule.json` has a block at that exact
`time` for that `dayOfWeek`. A day-in-progress "cycle" (cases, batches,
agent stats, block results) persists in `SIM_KV` key `daily-cycle-state`
between ticks; the day's last block finalizes it (`finalizeScheduledDay()`)
and clears the cycle. Per-block errors (e.g. Gemini 429) are logged to
`reports` (`logScheduledError`, `agent_id=10`/"The Architect",
`severity='warning'`) and never abort the day — see `TOKEN-BUDGET.md`
"Per-block cron wired" for the failed-batch caveat.

`runWorkDayCycle()` (single-invocation, whole-day) remains available for
manual testing via `/api/agents/trigger {"type":"day"}`.

**DST CAVEAT**: `ISRAEL_UTC_OFFSET_HOURS = 3` in `agent-runner.js` assumes
IDT (UTC+3, roughly Mar-Oct). When Israel switches to IST (UTC+2, ~late
Oct) or back to IDT (~late Mar), update BOTH that constant and
`wrangler.toml`'s cron window (`*/30 5-13 * * *` → `*/30 6-14 * * *` for
IST) by 1 hour.

The simulation itself is left **paused** (`SIM_KV.paused = true`) — the
cron will fire on schedule regardless, but `runScheduledBlock` no-ops with
`{skipped: true, reason: 'paused'}` until a human/Claude-Code session
unpauses it (see `TOKEN-BUDGET.md` for the Gemini-quota timing decision
before doing so).

---

## Future Assimilation: CLI Tools

**CLI Mode now has a real simulator (2026-06-12).** The AI Search tab's CLI
Mode (`isCliModeActive()`, `#cli-controls` platform chips) is backed by
**CommandFlow** (`tools/commandflow/commandflow-core.js` +
`tools/commandflow/commands.json` — see "Human-in-the-loop asset pipeline"
above for origin). When CLI Mode is active, `sendAiMessage()` calls
`tryRunCliCommand(text)`: recognized commands for the selected platform
(`getCliPlatform()` — Bash, PowerShell, Cisco, Cloud, Networking, Security,
Databases) render instantly as a code block in the chat, **zero
`data-center-api` cost**; `clear`/`cls` clears the chat's message area
(`clearCliScreen()`); anything unmatched falls through to the existing Claude
streaming path unchanged. In-app styling stays the existing
green-on-black/`C:\>` Data Center terminal aesthetic — the standalone
`tools/commandflow/` page keeps the full Stitch "Terminal Academy" look.
Same engine + data, different skin.

**Adding platforms/commands is data-only**: edit
`tools/commandflow/commands.json` (add a platform object or commands under an
existing one) — both the standalone page and in-app CLI Mode pick it up via
the shared `CommandFlow.loadDb()`/`run()` engine, no code changes needed. See
`tools/commandflow/README.md`.

A `cli` module stub (`status: "coming-soon"`, `data_file: "data/cli.json"`)
remains in `data/modules.json` for a future **command-card knowledge module**
(bilingual reference cards for CLI tools, distinct from CommandFlow's
interactive simulator). When picked up, follow the same bilingual schema as
`data/linux.json`/`cmd.json` (Rules 1-9 above) and flip `status` to
`"active"` once `data/cli.json` exists with real entries — this is unrelated
to, and does not block, CommandFlow.

---

## Automation Workflows

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| `validate.yml` | every push/PR | Schema + bilingual field validation (`validate-json.js`) |
| `link-check.yml` | daily 06:00 UTC | Checks every `source_url` is reachable (`check-links.js`); opens/closes a `broken-link` issue |
| `health.yml` | weekly, Mon 08:00 UTC | Data quality + Hebrew QA (`health-check.js`); opens a `data-quality` issue on critical failure |
| `monthly-review.yml` | monthly, 1st @ 08:00 UTC | Opens a `source-review` issue if `flagged/pending-review.md` has unreviewed entries |
| `changelog.yml` | on push to master | Auto-generates `CHANGELOG.md` |
| `agent-cases.yml` | weekly, Mon 09:00 UTC | Generates the AI Agent Simulation's weekly case batch (`generate-agent-cases.mjs`) and commits `agents/database/cases-*.json` |
| `agent-reports.yml` | weekly, Tue 08:00 UTC | Triggers the simulation's weekly reset cycle and commits a generated report to `agents/reports/`; opens an `agent-incident` issue on critical incidents. No-ops until `AGENTS_API_BASE`/`AGENTS_SCHEDULER_BASE` repo variables and `ADMIN_TOKEN` secret are configured (see `agents/README.md`) |

All scheduled workflows also support `workflow_dispatch` for manual runs.
`validate.yml`, `link-check.yml`, `health.yml`, `monthly-review.yml`, and
`changelog.yml` require no secrets beyond the default `GITHUB_TOKEN`.
`agent-cases.yml` likewise needs nothing extra. `agent-reports.yml` requires
the agent-simulation variables/secrets above.

---

## ⚠️ Hebrew Session Reminder

When adding new entries in a Claude Code session:
1. Run `node .github/scripts/health-check.js` before committing
2. Verify `desc_he` is in Hebrew (not English copy-pasted)
3. Verify all `cmd` fields have no Hebrew characters
4. Wrap English technical terms in `<span class="ltr-term">` in Hebrew text
5. `desc_he` and `desc_en` must be meaningfully different translations

---

## Autonomous Brain Rules

When operating autonomously across sessions on this project:

1. **Memory over files for research** — when you learn reference information
   (useful links, domain notes, command details, prior decisions) that isn't a
   finished workflow doc, save it to Claude's persistent memory
   (`~/.claude/projects/.../memory/`), not as new files in this repo or in
   `data-center-archive`. Search the internet in real time for current
   information rather than stockpiling raw copies.
2. **Keep both repos lean** — `data-center-archive` holds only workflow `.md`
   files and generated PDFs. This repo holds the app, data, automation, and
   `flagged/` tracking files. Resist creating "just in case" reference dumps.
3. **Security first** — never design a feature that ships write credentials
   (GitHub tokens, API keys) to the browser. Client-side persistence
   (`localStorage`) is fine for user-local state (bookmarks, sessions,
   language); anything that needs to write to GitHub or call paid APIs goes
   through the Cloudflare Worker.
4. **No build step, ever** — solve new requirements (PDF export, etc.) within
   the static-HTML-plus-`fetch()` architecture. If a requirement seems to need
   a bundler/server, find the static-web-platform equivalent first.
5. **Validate before committing** — always run `validate-json.js` and
   `health-check.js` after touching `data/*.json`, and sanity-check
   `index.html` loads (`python -m http.server 8080`) after JS/CSS edits.
6. **Pause before pushing to `master`** — after committing locally, summarize
   what changed and what automation/workflows it affects, and wait for
   explicit confirmation before `git push`.
7. **Don't delete without instruction** — existing entries, workflow docs, and
   automation files are not removed unless the user explicitly asks.

---

## Never

- Never commit `.env` files
- Never add `source_url` from blocked domains
- Never delete existing entries without explicit instruction
- Never use `innerHTML` without `escHtml()` on user-controlled strings
- Never add `dir="rtl"` to code blocks
- Never ship GitHub write tokens or other credentials to the browser/client

---

## Infrastructure Costs

Backend: Cloudflare Workers Free Tier
- 100,000 requests/day included
- $0/month at current usage
- Upgrade trigger: only if daily requests exceed 100k
- Paid tier if needed: $5/month

Hosting: GitHub Pages — $0/month forever

`data-center-archive`: plain GitHub repo (workflow docs + PDFs) — $0/month,
no Pages/Actions billing impact

AI: Anthropic API (`data-center-api` — AI Search/Diagnose/CLI + escalations)
— pay per use (~$3-8/mo estimated at personal use volume)

AI: Gemini 2.5 Flash-Lite (`data-center-agents` — office simulation) —
pay per use, ~$2-3/quarter at target volume (~$1/mo)

Total: $0-15/month, see "Launch Decisions" cost-model ceiling — most months
should land near the low end
