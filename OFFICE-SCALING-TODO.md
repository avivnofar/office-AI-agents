# OFFICE-SCALING-TODO.md — Master Plan: "The Office as a Product"

> Written 2026-08-04 by the Architect chat, from planning sessions with the
> owner. This is a MULTI-SESSION plan — expect 4-7 strong-model sessions
> (Claude Code or equivalent) to execute. Each phase ends with a
> verification gate; nothing advances to the next phase without the owner
> seeing evidence the previous one runs clean. Follow this repo's standing
> pattern: build → verify → owner reviews → owner explicitly approves.
>
> Language note: this file is in English because it will be pasted into
> build sessions; all agent-facing Hebrew content is specified where
> relevant.

---

## The vision (context for every session that picks this up)

The sellable product is NOT the agents or personas — it is the **office
logic itself**: an encoded organizational structure (hierarchy, two-axis
quality control, documented improvement loop, single push gate, budget and
quota management) that can be applied to any agent team and any task set.
Existing projects (data-center, Notebook-X) are the office's first
"clients"; the public front repo is the portfolio. End goal: an autonomous
AI office that accepts complex tasks, decomposes them, self-audits, and
improves daily — exportable/sellable as a product.

## Standing constraints (apply to EVERY phase, no exceptions)

1. **Anthropic budget**: $4.50/month soft-stop, $5 hard ceiling, shared
   budget in D1 `claude_budget_usage`. Anthropic API is used ONLY by the
   Architect and for genuine data-center Q&A — never for office
   flavor/persona chatter.
2. **Free tiers only** for all other providers. Gemini pacing rules
   (`workers/gemini-pacer.js`) stay in force.
3. **Code-write policy (UPDATED by this plan — see Phase 0)**: agents may
   write code ONLY inside the Warehouse repo. Live projects (data-center,
   Notebook-X, office-AI-agents infra) are Architect-only, per-change,
   owner-authorized. Connecting a Warehouse-built feature to a live
   project is ALWAYS an explicit owner decision.
4. **Architect authority**: the Architect reviews, fixes, and optimizes
   all agent-written code, and is the ONLY entity that pushes code to
   live projects — each such push individually owner-authorized.
5. **Graduated rollout** for anything new that runs on a schedule:
   supervised run → small unattended window → full schedule.
6. **Preserve decision history**: never overwrite historical spec files;
   new specs get new names. Permission changes go into
   `config/project-permissions.json` with date + reasoning.

## The two mission tracks (and how they coexist)

- **Track A — existing client work** (KEEP RUNNING, do not regress):
  the daily Q&A engine against data-center and Notebook-X. Its quotas and
  budget come first; office-building work yields to it on contention.
- **Track B — office-building** (the new primary internal mission):
  perfecting the office model itself — improvement loop, campus,
  warehouse, front. Runs on the free-tier headroom LEFT OVER after
  Track A's needs, measured, never assumed.

Optimization rule between tracks: Track B workloads are scheduled into
the daily-schedule blocks Track A doesn't saturate, and every Track B
model call is tagged (`track: "office"`) in logs so quota consumption per
track is separable and reviewable. First contention report goes to the
owner before any quota rebalancing.

---

## Phase 0 — Decisions & permission documentation (1 short session)

Prerequisites for everything else. No code beyond config edits.

- [ ] 0.1 Update `config/project-permissions.json` (dated, reasoned,
      following the existing `_meta` convention):
      - Add `office-warehouse` project key: `push: true` for agents,
        `code_write: true` **scoped to this repo only** — the single
        deliberate exception to `automated_code_write: false`, which
        stays `false` globally.
      - Add `office-campus` key: `push: true`, `code_write: false`
        (text/markdown/assets only).
      - Add front repo key (name TBD, see open questions): `push: false`
        for all agents except the publishing gate (Designer flow, Phase 6).
      - Document the Architect's new STANDING role: reviewer/optimizer of
        Warehouse code (standing), pusher to live projects (per-change,
        owner-authorized — unchanged).
- [ ] 0.2 Owner decisions to capture in writing (see open-questions table
      in the planning chat): repo names, front = new repo vs existing,
      TODO file location, pilot task list.
- [ ] 0.3 Verify guard wiring: extend `workers/permission-guard.js` tests
      (or add a small verifier script) proving the new keys behave as
      specified — including that a code-file write aimed anywhere but the
      Warehouse is still denied. **This is the lesson of 2026-07-11/12:
      gates must be wired and TESTED, not just defined.**

**Gate 0**: owner reviews the permissions diff + verifier output.

---

## Phase 1 — The improvement loop (core of the product; 1-2 sessions)

The two-axis daily loop: every agent interaction produces a report →
**QA (Agent 6)** reviews with the worker for WORK QUALITY → **Team Lead
(Agent 7)** reviews with the worker for the WORKER MODEL (personality,
behavior patterns, context) → conclusions written to character files →
character files feed the agent the next day. Plus cross-agent report
comparisons.

- [ ] 1.1 Report capture: ensure every Q&A interaction and office event
      writes a structured per-agent daily report row (D1) — reuse the
      existing reports pipeline, add fields: `embodiment_model` (which
      provider/model played the persona), `track`, `event_type`.
- [ ] 1.2 QA review job (daily): QA agent reads yesterday's reports per
      worker, produces a short quality assessment + 1-3 concrete
      improvement notes. Strong-model routing (see Phase 3).
- [ ] 1.3 Team Lead review job (daily): same input, different axis —
      persona consistency, behavioral drift, context gaps. Output:
      proposed character-file amendments.
- [ ] 1.4 Character files (live in Campus, Phase 2; until Campus exists,
      stage under `agent-output/character-files/`):
      - Two-part structure per agent: `journal.md` (agent's own free
        writing, append-only) and `active-context.md` (ONLY
        QA/Team-Lead-approved content — this is what feeds prompts).
      - Hard size cap on `active-context.md` (suggest 8KB); oldest
        approved entries roll off into the journal.
- [ ] 1.5 Cross-agent comparison (weekly): Lead QA (Agent 8) compares
      report quality across agents AND across embodiment models —
      surfacing "persona X is more consistent on model Y" type findings.
- [ ] 1.6 Owner audit hook: a weekly digest email/file listing all
      character-file changes that week, for human sampling (owner
      decision on cadence — see open questions).
- [ ] 1.7 Verifier: `scripts/verify-improvement-loop.js` — dry-run checks
      of report schema, review-job wiring, size caps, and that
      `active-context.md` only ever receives approved content.

**Gate 1**: one full supervised day of the loop; owner reviews the actual
character-file diffs it produced before it runs unattended.

---

## Phase 2 — Campus repo (1 session)

One repo, `office-campus` (name pending owner approval): per-agent
folders, full autonomy inside your own folder, text/assets only.

- [ ] 2.1 Create repo + skeleton: `agents/<agent-slug>/` (journal.md,
      active-context.md, notes/), `shared/meetings/`, `shared/comparisons/`,
      `README.md` explaining the campus concept.
- [ ] 2.2 Scoped token: fine-grained PAT limited to `office-campus` only,
      stored as a new secret; wire through permission-guard with the
      `office-campus` key from Phase 0.
- [ ] 2.3 Migrate Phase-1 staged character files into the campus.
- [ ] 2.4 Meeting/event records: office meetings write their minutes to
      `shared/meetings/<date>-<type>.md`, including the embodiment map
      (which model played whom).
- [ ] 2.5 Size hygiene: repo-size check in the daily flow; warn at 2GB,
      hard-stop agent writes at 4GB (GitHub soft limit ~5GB).

**Gate 2**: owner reviews the campus skeleton + one real day of writes.

---

## Phase 3 — Model routing by task type + new keys (1-2 sessions)

Extend `workers/model-router.js` from budget-routing to a task-type
routing table. The persona's "voice" lives in prompts/character files,
NOT in key assignment.

Routing table (initial):

| Task type | Primary | Backup |
|---|---|---|
| Judgment/quality (QA, Lead QA, Team Lead reviews) | GitHub Models (flagship) | Cerebras (Llama 70B) |
| Hebrew composition (summaries, gap notes, emails) | Gemini 3.1 Flash-Lite | GitHub Models |
| Routine volume (drafts, worker chatter) | Groq | Cloudflare Workers AI |
| Classification/routing | Cloudflare Workers AI | Groq |
| Conversations & office events | **CONTROLLED RANDOM** across all non-Anthropic providers, embodiment logged | n/a |
| Architect work | Anthropic (per-change) | none — Architect never randomized |

- [ ] 3.1 Add keys as Worker secrets: `GITHUB_MODELS_TOKEN` (can reuse
      existing GitHub PAT if scopes allow — verify), `CEREBRAS_API_KEY`,
      plus ONE of `MISTRAL_API_KEY` / `OPENROUTER_API_KEY` (owner picks).
      Target total: 6-7 providers. Do NOT create multiple accounts per
      provider (TOS risk) — diversity comes from routing, not key farming.
- [ ] 3.2 Client modules: `workers/github-models-client.js`,
      `workers/cerebras-client.js`, (+ chosen third) — mirror the
      existing groq-client shape, each with its own rate-limit
      awareness and quota logging.
- [ ] 3.3 Routing table implementation in `model-router.js` +
      `config/token-economy.json` entries (free-tier limits, reset
      times, per-minute caps where relevant).
- [ ] 3.4 Controlled-random conversation routing: per meeting/event,
      shuffle persona→provider assignment, LOG the embodiment map to the
      report row (1.1) and the meeting record (2.4). This is a
      measurement instrument, not a fallback.
- [ ] 3.5 Quota dashboards: extend the existing admin status endpoint
      with per-provider daily usage counters.
- [ ] 3.6 Verifier: routing dry-run proving each task type resolves to
      the right provider and Anthropic is unreachable from any office
      (Track B) code path.

**Gate 3**: 48h of live routing logs reviewed; no provider over 60% of
its free-tier daily quota.

---

## Phase 4 — Warehouse repo + build capability (1-2 sessions)

`office-deliverables` (name pending): where agents BUILD. Code allowed
HERE ONLY. Heavy artifacts live here, not in the campus.

- [ ] 4.1 Create repo + scoped PAT + permission-guard key (from 0.1).
- [ ] 4.2 Task intake convention: owner assigns a build task (a
      markdown spec in `tasks/<task-slug>/SPEC.md`); agents decompose,
      plan, and build under that folder.
- [ ] 4.3 Build workflow: worker agents produce → QA reviews →
      **Architect reviews/fixes/optimizes ALL code** (standing role) →
      output marked `ready-for-owner`. Nothing leaves the Warehouse
      without the owner; connecting anything to a live project is a
      separate owner decision + Architect per-change push.
- [ ] 4.4 Heavy-artifact hygiene: same 2GB/4GB size checks; if builds
      routinely exceed this, evaluate Git LFS or per-task release
      artifacts (owner decision — see open questions).
- [ ] 4.5 Pilot: ONE small end-to-end build task (owner picks from the
      pilot list) run through the full intake→build→QA→Architect→ready
      chain, supervised.

**Gate 4**: pilot task delivered and reviewed by owner.

---

## Phase 5 — Designer creative tooling (0.5 session)

- [ ] 5.1 Wire image generation for the Designer (Agent 9) via EXISTING
      keys first: Cloudflare Workers AI image models + Gemini image
      capability. No Canva for now (paid/complex API) — revisit only if
      quality proves insufficient for the front.
- [ ] 5.2 Assets save to campus `agents/the-designer/assets/` (small) or
      Warehouse (heavy); each asset gets a one-line provenance note
      (model, prompt date).

**Gate 5**: three sample assets reviewed by owner.

---

## Phase 6 — The Front (public showcase repo; 1 session + ongoing)

The office's public face: the agents present themselves, their work, and
the office's client projects to the world. IMPORTANT + URGENT per owner.

- [ ] 6.1 Owner decision needed first: new dedicated repo vs. rework of
      `office-AI-agents`'s public presentation (see open questions).
      Architect's recommendation will follow that decision.
- [ ] 6.2 Structure (Architect to finalize once 6.1 is decided; initial
      proposal): landing README (what the office is, in EN + HE),
      `team/` (one page per agent, written by that agent, edited by
      Designer), `portfolio/` (per client project: what the office does
      for it, sample reports), `press/` (weekly "life at the office"
      posts from meeting minutes), `product/` (the office-logic pitch —
      what a customer would buy).
- [ ] 6.3 Publishing gate: NO direct agent pushes. Content accumulates
      in campus `shared/front-drafts/`; the Designer curates and
      publishes in a daily/weekly batch after QA sign-off. Wire this as
      the only push path for the front key.
- [ ] 6.4 First publication wave: team pages for all 11 agents + one
      portfolio page per client project.

**Gate 6**: owner reviews the live front before the publishing schedule
is enabled.

---

## Phase 7 — Scale-up (ongoing, only after Gates 1-6)

- [ ] 7.1 Increase office-work volume to measured free-tier headroom
      (per-provider, from Phase 3 dashboards), graduated: +25% steps,
      48h observation each.
- [ ] 7.2 Invent + measure 2-3 recurring VALUE tasks for the existing
      10 agents (owner-approved list) before ANY new agents are added.
- [ ] 7.3 New agents: only once existing agents have measurable valuable
      output; each new agent = config entry + campus folder + routing
      coverage, no new repos.
- [ ] 7.4 Quarterly: revisit the "office as sellable product" packaging —
      what of the office logic is genuinely reusable/exportable, and
      what would a demo for an outside customer look like.

---

## Session hygiene (every executing session)

- Read `CLAUDE.md`, `config/project-permissions.json`, and this file
  first. Reality wins over documentation — flag divergences.
- Bring back evidence (API read-backs, D1 queries, diff stats), not
  "done".
- Cron/schedules stay paused during intervention; re-enable only after
  supervised verification, with owner go-ahead.
- Update this file's checkboxes + a short dated log line at the bottom
  after each session.

## Session log

- 2026-08-04 — plan written (Architect chat). No execution yet.
