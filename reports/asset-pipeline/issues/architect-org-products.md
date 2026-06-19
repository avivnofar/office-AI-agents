# [AGENT-10] Architect Org Products

**Board item:** `architect-org-products` · **Tools:** Stitch, Base44, Google AI Studio (any, joint with Designer for important projects) ·
**Owner:** Agent 10 (Architect), joint with Agent 9 (Designer) for important projects ·
**Labels (when filed as a GitHub Issue):** `asset-task`, `AGENT-10`

## Goal

Build quality, org-facing products that improve how the data-center project
runs internally — using whichever of the four approved tools fits best, and
pairing with the Designer (joint Stitch/Base44/Google AI Studio sessions per
`ai-tools.json`) on important projects.

## Spec

Initial product candidates to scope first (lightweight by default):

1. **Internal status dashboard** — a small, separate app summarizing
   simulation health (agent moods, case throughput, incident counts) for
   quick admin review, complementing (not replacing) the in-app 🔐 Admin
   tab and `agents/dashboard/admin-panel.html`.
2. **Asset-pipeline board viewer** — a small read-only viewer for
   `agents/reports/asset-pipeline/board.json` so non-technical reviewers can
   see tool-task status without reading raw JSON.
3. **Architecture diagram tool** — an up-to-date visual of the 3-Worker
   architecture (`data-center-api`, `data-center-agents`, `data-center-db`)
   for onboarding/reference, generated via Google AI Studio or Stitch.

Architect picks the first candidate (or proposes an alternative), writes its
own `agents/reports/asset-pipeline/issues/<product-id>.md` spec, and a board
entry. Joint sessions with Designer (Stitch/Base44, Mon/Thu per
`ai-tools.json` weekly_rotation) take priority for "important" projects —
Architect flags which candidate qualifies as important.

## Acceptance Criteria

1. At least one candidate has its own spec file and board entry.
2. Output is lightweight (static page, small hosted app, or exportable
   diagram) and requires no new backend beyond the existing 3 Workers.
3. If joint with Designer, the session is booked on a `weekly_rotation` slot
   marked `"session": "joint"` in `ai-tools.json` to avoid tool conflicts.

## Status

`queued` — Architect to pick the first candidate and file its spec at the
next eligible Wednesday Google AI Studio slot, or a Mon/Thu joint slot if
paired with the Designer.
