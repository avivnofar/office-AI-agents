# [AGENT-9] Design Tooling Suite — free design/generative-AI tools

**Board item:** `designer-tooling-suite` · **Tools:** Base44, Google AI Studio (free tier) ·
**Owner:** Agent 9 (Designer) ·
**Labels (when filed as a GitHub Issue):** `asset-task`, `AGENT-9`

## Goal

Stand up several **free** design/generative-AI tools as company-owned,
separate, optimized, lightweight products with great UI, each serving a
core user need for the data-center project's audience (sysadmins, DevOps
engineers, IT students).

## Spec

Each sub-tool is specced and tracked as its own small product (its own
future board item once promoted out of this umbrella spec). Initial
candidates to scope first (pick free-tier tools, lightweight output):

1. **Diagram/network-topology sketch tool** — quick troubleshoot-scenario
   diagrams that could illustrate `data/troubleshoot.json` entries.
2. **Terminal/CLI screenshot annotator** — clean, consistent annotated
   screenshots for workflow docs in `data-center-archive`.
3. **Icon/badge generator** — consistent icon set for `data/modules.json`
   tabs (currently emoji-based; an optional icon pack).

Each candidate gets: target user need, chosen free tool, lightweight output
format, and acceptance criteria — written up as its own
`agents/reports/asset-pipeline/issues/<sub-tool-id>.md` once Agent 9 picks
which to build first (one at a time, per `ai-tools.json` concurrency limit
of 1 open tool-task per agent per tool).

## Acceptance Criteria

1. At least one sub-tool from the candidate list (or an Agent-9-proposed
   alternative) has its own spec file and board entry.
2. The chosen tool is genuinely free-tier and produces a lightweight
   artifact (static export, exportable image set, or small hosted app link)
   — no paid subscriptions without owner approval.
3. Output integrates with the existing app/archive without a build step
   (e.g. exported images committed to `data-center-archive`, or a static
   page).

## Status

`queued` — Agent 9 to pick the first sub-tool and file its spec at the next
eligible Tuesday/Thursday Base44 slot (per `ai-tools.json` weekly_rotation).
