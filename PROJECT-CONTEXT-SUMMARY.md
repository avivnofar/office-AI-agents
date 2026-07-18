# Office AI Agents — Project Context Summary

*Written 2026-07-18 for a reader with no prior context on this project —
a fresh chat, a new collaborator, or future-you six months from now. If
you've been in this repo for a while, most of this will be familiar; the
value here is in the connective tissue between decisions, not any single
fact you couldn't also find in `CLAUDE.md`.*

---

## 1. What this project actually is, right now

`office-AI-agents` runs 11 AI personas — each with a distinct name,
personality, and role (The Perfectionist, The Productive, The Trainee, The
CEO, and so on) — whose job is to **use and stress-test two production AI
systems the owner actually maintains**:

- **Claude**, embedded as the AI Search bar in
  [Data Center](https://avivnofar.github.io/data-center/), an IT/
  cybersecurity knowledge-base web app.
- **Gemini**, embedded in [Notebook-X](https://github.com/avivnofar/Notebook-X),
  a separate knowledge-notebook web app.

Each persona asks real IT/cybersecurity questions to whichever one of these
two systems its question targets, judges whether the answer actually held
up, updates its own mood based on that judgment, and — when it finds a
genuine capability gap (not just a mediocre answer, but "this tool doesn't
know X" or "no notebook covers Y") — writes a short internal note about it
in Hebrew. The office metaphor (personas, moods, standups, reports) exists
to generate realistic, *varied* usage patterns; a single flat test script
asking the same ten questions every day wouldn't surface nearly as much.

This is the project's **third major framing**. It did not start this way,
and understanding the earlier framings explains a lot of naming and
structure you'll still see in the code (a `cases` database table full of
"questions," a persona whose config still says `"case_focus"`, a Worker
still literally named `data-center-agents`).

## 2. How it got here — the three framings

### Framing 1: Netvill support-ticket simulation (original)

The project originally simulated a fictional IT support company called
"Netvill," with the 11 personas playing IT support staff, fielding a daily
pool of ~50-200 simulated support tickets for fictional clients (Northgate
Logistics, Aurora Medical Center, Heritage Bank & Trust — see git history
for `workers/crm-engine.js`'s old `CLIENT_POOL`). Tickets covered general
IT topics plus two specific telecom platforms, 1COM and MirtaPBX cloud/
on-prem PBX systems — Netvill's original core business, before
`data-center` broadened its own scope to general IT + cybersecurity.

The goal even then wasn't really "simulate Netvill" for its own sake — it
was **model training through realistic usage**: varied, persona-driven
questions would exercise Claude's AI Search bar in ways a flat test list
wouldn't, and the office's mood/report/escalation machinery existed to
make that usage varied and self-sustaining (an angry persona files an
incident report and changes behavior; a happy one asks follow-ups). The
Netvill framing was flavor text for that underlying mechanism, but it was
flavor text baked deep into the code — client names, ticket severities,
platform-specific case pools.

### Framing 2: Two-project office (2026-07-01 onward)

On 2026-07-01, the project gained a second target: Notebook-X, a knowledge-
notebook app with a live, unauthenticated REST API
(`workers/notebookx-client.js`). Initially this was wired as a
**pre-Claude-escalation reference check**: before an agent's case escalated
to Claude, it would first check whether a relevant Notebook-X notebook
(kb-linux, kb-1com) already had the answer, short-circuiting the Claude
call if so. This was a cost-saving/efficiency mechanic, not yet a parallel
target the office was itself testing.

Separately, a whole second automation path grew up around Notebook-X:
`.github/workflows/notebook-x-daily.yml`, running
`.github/scripts/notebook-x-daily.mjs` nightly, independent of the 11-agent
office simulation entirely — filling in Notebook-X's skeleton knowledge
notebooks with real content, and (this matters for what comes next) running
a battery of autonomous "housekeeping" checks against Notebook-X's own
repo, including one that could push full-file rewrites of Notebook-X's
backend Python files directly to production.

### The incident that mattered: 2026-07-11/12

That last piece — `housekeeping_codeAssessment()` — is the single most
consequential thing that happened to this project's trajectory. Its design
was structurally broken: it sent Gemini only the **first 2500 characters**
of each backend file while asking for "the FULL updated raw code," with a
4096-token output budget — mathematically impossible for a ~2000-line
file — and nothing checked the result before pushing it live. Two runs on
2026-07-11 shrank `notebook_backend.py` from 2002 lines to 79, silently
deleting dozens of functions `api_server.py` still called. Notebook-X's
production backend crashed and stayed down until the fix landed on
2026-07-12.

The 2026-07-12 fix was real and thorough: no more input truncation, output
budget sized to the input, a size-floor plausibility check before any push,
a fallback to text-only recommendations for files too large to safely
round-trip, and routing the push through the same code-write permission
gate (`checkCodeWriteAllowedForModel()`) the `frontend_code_change`
backlog-item path used.

**But it wasn't as thorough as it looked.** The 2026-07-18 rebuild's own
investigation (see part 4 below) found that `checkCodeWriteAllowedForModel()`
— the permission gate the 2026-07-12 fix said `frontend_code_change`
already went through — had actually never been wired into that code path
at all. It existed in the file, correctly implemented, matching its own
header comment's description of what it was for, and simply wasn't called
anywhere. `frontend_code_change` was gated only by `checkDiffPlausible()`,
a *post-hoc* size-floor check running *after* the push had already
happened. The permission-check gap that caused the original incident, and
the "we fixed it" narrative around the 2026-07-12 patch, didn't fully match
what the code actually did.

### Framing 3: repo hygiene, then the Q&A-engine rebuild (2026-07-18)

Two sessions happened on 2026-07-18, back to back, both driven by the same
underlying realization: **the Netvill framing had outlived its usefulness,
and "recommend-only, we promise" mechanisms kept quietly drifting toward
"actually writes things," without anyone deciding that on purpose.**

**Session A — repo cleanup.** Public-facing hygiene: consolidated scattered
report output into one `reports/<category>/<project>/<date>.md` taxonomy,
deleted several superseded planning/status docs that had drifted out of
sync with reality (some of them still referencing a deprecated Gemini model
string, `gemini-3.5-flash`, as if it were current — an error that,
tellingly, turned out to still be live in several *code* files too, not
just abandoned docs), and rewrote `README.md` to describe the project's
actual current purpose instead of its Netvill-simulation history. This
session deliberately held back a full README rewrite of the *mechanism*
description, because at that point the mechanism hadn't been rebuilt yet —
the README would have been describing an aspiration, not a reality.

**Session B — the Q&A-engine rebuild** (this document, and everything
`CLAUDE.md` now describes as current) is what made that aspiration real.
Explicit owner instructions, in order:

1. Replace the Netvill-CRM case model entirely with a Q&A model: agents ask
   real questions, targeting exactly one of the two production systems per
   question (never both, never an escalation chain between them).
2. Update mood/irritation from the answer's quality score as the *primary*
   signal — "a return to how mood was originally meant to work, before
   this got diluted by other signals" (the owner's own words — the
   quality-driven mood mechanic already existed in the code; other
   accumulated behaviors like a "compare against an external source"
   side-mechanic had crowded it, without being wrong exactly, just
   diluting).
3. Keep all 11 personas' names, personalities, and flavor text completely
   unchanged — only their task logic changes. (This document, and every
   file this rebuild touched, was written honoring that constraint.)
4. Capability-gap findings become short Hebrew internal notes — "the tool I
   work with isn't good enough here" — never a GitHub Issue, for either
   project. This is a direct, deliberate reaction to the 2026-07-11/12
   incident's shape: that incident happened via an autonomous *write*
   pathway with a permission gate that existed on paper but wasn't
   actually enforced. A reporting-only pathway with no write capability at
   all doesn't have that failure mode to guard against in the first place.
5. **No agent writes or modifies code, files, or tools of any kind** — not
   just "no auto-push of code files," the broader principle. This is what
   took the retirement past `housekeeping_codeAssessment` (the one that
   caused the incident) to the *entire* `housekeeping_*` function family,
   including two functions that were already recommend-only in actual
   behavior. `housekeeping_recommendChanges`'s own prompt text told Gemini
   "you are authorized to act... you are no longer recommend-only" even
   though its code path happened to never call a push function — the
   *intent* encoded in that prompt contradicted the new principle even
   though the *behavior* hadn't (yet) caused a second incident. Retiring it
   preemptively, rather than waiting for prompt text like that to someday
   line up with a code path that also pushes, is the whole point.
6. One shared $5/month Claude budget, not a second independent one for the
   new Q&A engine — reusing the dollar-cost-tracking mechanism that already
   existed for a different automation (the TODO.md-driven chore rotation),
   rather than adding a third, uncoordinated spending pool.
7. Conservative, documented pacing for Notebook-X's Gemini calls
   specifically, because — a genuinely uncomfortable fact this rebuild had
   to design around rather than solve — this repo cannot see how much of
   Gemini's shared free-tier quota Notebook-X's *own* backend traffic and
   its *own* weekly gap-analysis job are using at any given moment. The
   honest response to a real blind spot is conservative pacing with
   documented reasoning, not a precise-looking quota split that would be
   false confidence.

## 3. Why the code still says "case," "CRM," and "data-center-agents"

You'll notice `agent-runner.js` still opens `agent_sessions` rows, the
Worker is still deployed as `data-center-agents`, the D1 table holding
questions is still literally named `cases` (with `client_name`/`severity`/
`is_unique_client`/`requires_it_chief` columns still present but no longer
written by anything), and several persona configs still carry a
`"case_focus"` field. This is a deliberate, disclosed tradeoff, not an
oversight: renaming a live D1 table or every internal identifier across a
~2000-line Worker file, with no way to test the change against a real
Cloudflare environment in this session, was judged higher-risk than it was
worth. Instead, this rebuild changed what actually flows through those
names (a "case" is now a question with a `project`/`kb_slug`, not a
Netvill support ticket) and documented the terminology gap everywhere it
appears (`CLAUDE.md`, `database/schema.sql`, this file). If a future
session has real deploy/test access and wants to do a full rename pass,
that's a reasonable next step — just not one this session could verify.

## 4. What's built but not live

Everything described in `CLAUDE.md`'s "The Q&A engine" section exists in
code, passes `node scripts/verify-qa-engine.js` (56/56 checks — topic pool
composition, persona config completeness, gap classification, shared-budget
config, Gemini pacing behavior, all executed for real against the actual
new modules, not just asserted), and passes `node --check` on every touched
file. **None of it is deployed.** No `wrangler deploy` ran, no workflow
YAML was touched, no live schedule was enabled — this was design-and-build
only, the same graduated-trust pattern every other capability in this repo
has followed (build it, verify it statically/locally, let a human decide
when it's trusted enough to run unattended against production).

Before it CAN be deployed, a one-time manual D1 migration needs to run
against the live database (`ALTER TABLE cases ADD COLUMN project TEXT`,
etc. — noted in `database/schema.sql` and `DEPLOY.md`) — `CREATE TABLE IF
NOT EXISTS` doesn't retrofit columns onto an existing table, and this
repo's automation deliberately doesn't run schema changes against a shared
production database without an explicit human step.

## 5. What's dormant, and why that's different from "removed"

Agent 10, The Architect, is excluded from the daily Q&A flow entirely —
reserved for owner-directed special tasks only. This was already
effectively true before this rebuild (the old CRM engine's
`getActiveCaseAgents()` already excluded agent 10 from the case pool), but
this rebuild made it explicit and permanent in documentation rather than an
implicit side effect of a cost-saving special case. The Architect's
personality, clearance tier, and character description are fully preserved
in `config/agents-config.json` — "dormant" describes participation in
automation, not deletion of the character.

## 6. The honest state of things

- The Q&A engine is a real, working rebuild — verified as thoroughly as
  this session's environment allowed (see part 4).
- The Netvill/CRM framing is gone from the active code paths, though
  residual naming remains in places disclosed in part 3.
- The `housekeeping_*` incident class (autonomous writes with a permission
  gate that looks enforced but isn't) is closed for Notebook-X's
  automation specifically, by removing the write capability rather than
  hardening the gate further — a different kind of fix than 2026-07-12's,
  and arguably a more durable one.
- What hasn't happened yet: a live day has not run against this new
  engine. Everything about its real-world behavior — actual question
  quality, whether the Gemini pacing numbers hold up under real Notebook-X
  traffic, whether $5/month is actually enough or too much — is informed
  design, not observed fact. That's the next real test.
