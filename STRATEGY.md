# Agents — Current Strategy

> Supersedes the "agents 5-11 are placeholder stubs pending a finalized
> spec" framing in `README.md` / `AGENTS.md` *as infrastructure guidance* —
> the 11 personalities themselves are not parked, only the
> one-Worker-per-agent implementation approach is.

## Current

One Gemini agent, running in a single Cloudflare Worker
(`data-center-agents`, `workers/agent-runner.js`), role-plays **all 11**
personalities defined in `config/agents-config.json` — not 11 separate
Workers or Durable Objects.

The full 1-year office simulation (per the project's spec document) remains
the end goal. Everything already built — `agents-config.json`,
`simulation-config.json`, the year-tracker, side-plot, and promotion/PIP
track configs, `agent-runner.js`'s simulation runtime, and the admin
dashboard — stays in place as the **data layer / spec** that the single
engine reads from and acts on. Nothing here is deleted or reverted.

## Sequencing

1. **UI polish** (current priority) — `index.html` should be excellent,
   fast, mobile-ready, bilingual, with a working Claude AI Search
   end-to-end, before the full-year run starts.
2. **Consolidate the agent runtime** into the single Gemini engine
   described above (re-architecture, not new feature work —
   `agent-runner.js` already has most of the pieces).
3. **Test** the single Gemini agent against the live app (generates cases,
   calls `/api/chat`, behaves per `agents-config.json`).
4. **Run the full 1-year simulation.**

See `TOKEN-BUDGET.md` for the session-by-session queue and `CLAUDE.md`'s
"Current Strategy (authoritative)" section for the project-wide framing.

## Do not (for now)

- Do not stand up additional per-agent Workers or Durable Objects.
- Do not build a separate behavioral engine for agents 5-11 — they're
  covered by the same single-engine, config-driven approach as agents 1-4.
