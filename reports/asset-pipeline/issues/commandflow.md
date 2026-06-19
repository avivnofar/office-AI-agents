# CommandFlow / Terminal Academy — design, architecture & QA review

**Board item:** `commandflow` · **Tool origin:** Stitch + Base44 (owner-built import) ·
**Owners:** Agent 9 (Designer), Agent 10 (Architect), Agent 6 (QA) ·
**Labels (when filed as GitHub Issues):** `asset-task`, `claude-action`, plus
`AGENT-9` / `AGENT-10` / `AGENT-6` per sub-task below.

## Background

CommandFlow is the **first real asset to complete the human-in-the-loop
pipeline**: it started as a Stitch + Base44 export ("Terminal Academy" —
`agents/assets/incoming/commandflow/code.html` + `DESIGN.md` + `screen.png`,
a static Executive-Summary dashboard mockup with no working terminal logic),
and was rebuilt by the owner + Claude Code as:

- `tools/commandflow/` — a standalone, zero-build, vanilla HTML/CSS/JS page
  preserving the Stitch "Terminal Academy" design system (glassmorphism,
  traffic-light terminal headers, Inter + JetBrains Mono, dark palette from
  `DESIGN.md`). Sidebar platform nav (Bash, PowerShell, Cisco, Cloud,
  Networking, Security, Databases) + an interactive terminal per platform.
- `tools/commandflow/commandflow-core.js` — shared, dependency-free
  simulation engine (`CommandFlow` global): loads `commands.json`, matches
  typed input to a command, returns simulated output, handles generic
  `help`/`clear`/`cls`.
- `tools/commandflow/commands.json` — the command database (7 platforms,
  ~10-17 commands each).
- The main app's **CLI Mode** (AI Search tab) now loads the same
  `commandflow-core.js` + `commands.json` and runs recognized commands
  locally (instant, zero API cost), falling through to Claude
  (`data-center-api`) for anything unmatched. In-app styling stays the
  existing green-on-black terminal look — **same engine/data, different
  skin** from the standalone page.
- Registered in `data/tools.json` and linked from the main app's topbar
  (`#commandflow-link`, opens `tools/commandflow/index.html` in a new tab).

This spec is the **reference pattern** for future imported tools: human
builds in Stitch/Base44 -> owner/Claude Code produces an owned, zero-build
standalone product + (if relevant) an in-app integration -> board item
`returned` -> agents take it through `tested -> optimized -> implemented`.

## [AGENT-9] Designer — review design + decide final in-app CLI styling

**Goal:** Review `tools/commandflow/index.html` against `DESIGN.md` and
`agents/assets/incoming/commandflow/screen.png`, and decide the final
look for the **in-app CLI Mode** terminal (in `index.html`'s AI Search tab).

**Tasks:**
1. Confirm the standalone page (`tools/commandflow/index.html`) faithfully
   reflects the "Terminal Academy" design tokens (colors, type, spacing,
   traffic-light terminal chrome, glassmorphism) from `DESIGN.md`. Note any
   visual drift and whether it's worth fixing.
2. Decide: should in-app CLI Mode (`#cli-controls` + chat-based terminal in
   `index.html`) **stay** with the existing green-on-black/`C:\>` Data
   Center terminal aesthetic, or adopt elements of the Terminal Academy look
   (e.g. traffic-light header, JetBrains Mono for output)? Owner's default
   per Launch Decisions is "keep both styles distinct" — only propose a
   change if there's a clear UX win, and keep it CSS-only (no new JS
   dependencies).
3. If a change is proposed, write it up as CSS-only edits to `index.html`'s
   `#cli-controls`/`.cli-chip`/chat-bubble styles (do not touch
   `tools/commandflow/index.html`'s standalone styling without a separate
   sign-off, since that page's identity is intentionally the full Stitch
   design).

**Acceptance criteria:**
- A short written decision (file as a `reports` entry, permission
  `private`, type `model_education` or a new `design_review` type) on
  whether in-app CLI styling changes, with rationale.
- If "yes, change it": a concrete CSS diff proposal (can be filed as a
  follow-up `asset-task` issue for a Claude Code session to implement) —
  do not edit `index.html` directly from the simulation.

## [AGENT-10] Architect — assess architecture & plan optimized integration

**Goal:** Assess whether `tools/commandflow/` + the CLI Mode integration in
`index.html` are architecturally sound and lightweight, and plan any
follow-up optimization.

**Tasks:**
1. Review `tools/commandflow/commandflow-core.js` and `commands.json` for:
   correctness of the lookup logic (full-line vs. first-token), the
   `help`/`clear`/`cls` generic handling, and whether the `_meta` block in
   `commands.json` is being used / needed.
2. Review the CLI Mode wiring in `index.html` (`getCliPlatform`,
   `selectCliPlatform`, `tryRunCliCommand`, `clearCliScreen`, and the
   `sendAiMessage()` short-circuit for CLI mode) for correctness, and
   confirm it doesn't regress AI Search / Solve a Case modes.
3. Confirm zero-build / no-new-dependency constraints are met (no
   bundler, no Tailwind CDN, no package.json).
4. Identify any "optimize" opportunities for the `tested -> optimized`
   stage transition — e.g. caching strategy for `commands.json` (currently
   cached in-memory per page load via `dbCache`), additional platforms/
   commands worth adding, or making `commands.json` shared via a single
   fetch path instead of two relative paths
   (`./commands.json` for standalone, `tools/commandflow/commands.json`
   for in-app).
5. Pair with Agent 9 if any proposed change touches both architecture and
   design (per Launch Decisions joint-session guidance).

**Acceptance criteria:**
- Written assessment (private `reports` entry) confirming the integration
  is sound, or listing concrete issues with file/line references.
- A short "optimize" plan (even if "no changes needed yet") to inform the
  `tested -> optimized` board transition.

## [AGENT-6] QA — test CommandFlow across platforms

**Goal:** Functionally test the CommandFlow simulator (both standalone and
in-app CLI Mode) across all 7 platforms, and consider whether a
NotebookLM-backed command database could become the shared source of truth
for both the simulator and Claude AI Search's CLI-mode answers.

**Tasks:**
1. For each platform in `tools/commandflow/commands.json` (`bash`,
   `powershell`, `cisco`, `cloud`, `networking`, `security`, `databases`):
   - Run every listed command via the standalone page
     (`tools/commandflow/index.html`) and verify the output looks
     realistic/accurate for that platform.
   - Run `help`, `clear`/`cls`, and at least one deliberately-unknown
     command per platform; verify the generic handling and the
     platform-specific "unknown command" message format.
2. Repeat a sample of the above via in-app **CLI Mode** (AI Search tab,
   `#cli-controls` platform chips) — confirm recognized commands render
   instantly as a code block in the chat without calling
   `data-center-api`, and that an unrecognized command correctly falls
   through to Claude.
3. File `data-quality`-style issues (private `reports`, or
   `claude-action` GitHub Issues if `GITHUB_TOKEN` configured) for any
   inaccurate/misleading simulated output, with the platform + command +
   suggested corrected output.
4. Write up a short recommendation on the NotebookLM-backed command
   database idea: would centralizing command reference data in QA's
   `qa-knowledge-base` NotebookLM notebook (board item `qa-knowledge-base`)
   let both `commands.json` and Claude AI Search's CLI answers draw from
   one source? Scope as a future `asset-task` if promising — do not
   implement during testing.

**Acceptance criteria:**
- Per-platform pass/fail notes for all listed commands across both
  standalone and in-app CLI Mode.
- Any inaccuracy findings filed as issues with concrete fix suggestions.
- A written recommendation (adopt / not yet / needs more info) on the
  NotebookLM-shared-source idea.

## Status

`returned` — standalone product + CLI Mode integration committed to repo
(2026-06-12). Awaiting Agent 9 / Agent 10 / Agent 6 review per the above to
advance to `tested`.
