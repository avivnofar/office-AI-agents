# [AGENT-9] [AGENT-10] [AGENT-6] Archives App — joint QA + Architect + Designer

**Board item:** `archives-app` · **Tool:** Stitch (joint), Base44 (iteration) ·
**Owners:** Agent 6 (QA), Agent 9 (Designer), Agent 10 (Architect) ·
**Labels (when filed as a GitHub Issue):** `asset-task`, `AGENT-9`, `AGENT-10`, `AGENT-6`

## Goal

A lightweight "Archives" application with an **archive mentality**: thin
storage, crop-to-essential content, a table of contents per directory, and a
small AI-agent "brain" inside for retrieval/summarization. Reuses the
`data-center-archive` repo's structure and conventions (`workflows/`,
`pdfs/`, `flagged/`, `guides/`, `raw/`) but presents them through a real UI
instead of raw file browsing.

## Spec

- **Joint Stitch session** (Agent 9 + Agent 10): generate the initial
  app shell/UI — a directory-tree view of `data-center-archive` with a TOC
  per directory (derived from each directory's existing `TABLE_OF_CONTENTS.md`
  where present, or generated from filenames otherwise).
- **Brain**: a thin retrieval layer that, given a user question, finds the
  most relevant archive document(s) and returns a cropped, essential
  summary — not a full-document dump. This can call `data-center-api`'s
  existing `/api/chat` for the summarization step (no new backend).
- **Crop-to-essential**: list views show title + 1-2 line summary only;
  full content is one click away. No raw directory dumps in the primary UI.
- **Iteration in Base44**: once the Stitch shell exists, refine UI/UX details
  (mobile layout, Hebrew/English toggle consistent with the main app's
  `dc-lang` convention) in Base44.
- **Lightweight**: this is explicitly a *lightweight* product — no new
  hosting/backend beyond what the existing Workers + static hosting provide.

## Acceptance Criteria

1. A Stitch-generated UI shell exists showing a per-directory TOC for at
   least `workflows/` and `pdfs/`.
2. The "brain" returns a cropped (not full-dump) answer for at least 3 test
   queries against archive content.
3. UI supports Hebrew/English toggle consistent with the main app.
4. No write credentials are embedded client-side (same rule as the main
   app's bookmark system) — any write-back goes through a Worker.

## Status

`queued` — awaiting joint human execution in Stitch (no unattended API).
