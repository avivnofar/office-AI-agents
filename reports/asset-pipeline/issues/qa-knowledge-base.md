# [AGENT-6] QA Knowledge-Base Build — NotebookLM

**Board item:** `qa-knowledge-base` · **Tool:** NotebookLM · **Owner:** Agent 6 (QA) ·
**Labels (when filed as a GitHub Issue):** `asset-task`, `AGENT-6`

## Goal

Build NotebookLM notebook(s) that become the project's canonical knowledge
sources, so the Claude AI Search (`data-center-api`) can eventually answer
**almost exclusively** from these notebooks instead of ad-hoc web search.

## Spec

- **Structure**: one NotebookLM notebook per `data/modules.json` active
  module (`linux`, `cmd`, `network`, `troubleshoot`), plus one notebook for
  the Workflows archive (`data-center-archive`). Group sources within each
  notebook by the module's existing `categories`/`categories_he`.
- **Sources**: every source added to a notebook must satisfy CLAUDE.md's
  "Source Validation (very high)" section:
  - Only approved domains (CLAUDE.md Rule 7).
  - Anything not already in `flagged/approved-sources.md` goes through
    `flagged/pending-review.md` first — do not treat NotebookLM ingestion as
    a bypass of this process.
  - Sources added to `flagged/approved-sources.md` in the last 30 days get
    re-verified before reuse.
- **Output for agent testing**: export NotebookLM's notebook summary/Q&A
  output (markdown or plain text) and place it at
  `agents/reports/asset-pipeline/returned/qa-knowledge-base/<module>.md`.
  Include the notebook's share link in the board entry's `history`.

## Acceptance Criteria

1. At least one notebook exists per active module (`linux`, `cmd`,
   `network`, `troubleshoot`) with >= 5 sources each, all passing source
   validation.
2. Exported summaries are placed under
   `agents/reports/asset-pipeline/returned/qa-knowledge-base/`.
3. Agent 6 (and reviewers) can answer at least 3 sample AI-Search-style
   questions per module using only the notebook content (tested stage).
4. Any new source URLs surfaced go through `flagged/pending-review.md` —
   none are added directly to `data/*.json` `source_url` fields.

## Status

`queued` — awaiting human execution in NotebookLM (no unattended API).
