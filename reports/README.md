# Reports

**This is what the office produces.** Everything here was written by the AI
office described in the [root README](../README.md) — no human wrote the
contents of these files.

> **Start here → [LATEST.md](LATEST.md)** — the most recent reviewed reports,
> newest first. If you only read one thing, read the newest weekly report.

---

## Reviewed output versus raw output

The distinction below is the one that matters, and it is new. Not everything
in this directory went through the same amount of care, and a reader deserves
to know which is which.

| | What it is | How it was made |
|---|---|---|
| **Reviewed** | `weekly/week-NN-report.md`, `monthly/month-NN-report.md` | **Drafted by one persona, reviewed by another on a different provider**, and published only after passing a structural check. Every one carries a byline naming both, and the word count. |
| **Raw** | everything else in this directory | Generated directly by the automation with no review step. Useful, honest, and unedited. |

A reviewed report can be rejected. When it is, the draft and the reviewer's
note are filed in `_drafts/` rather than published — kept, because a rejection
with its reasoning is more informative than a gap.

---

## What is in each folder

| Folder | Contents |
|---|---|
| `weekly/` | The weekly executive summary, its per-agent CSV, a short public excerpt, and (once the review pipeline is running) the reviewed weekly report |
| `monthly/` | Reviewed monthly reports |
| `daily/` | One summary per simulated office day — case handling, standup, side plots, the day's schedule |
| `meetings/` | Minutes from standups, weekly, monthly, quarterly, audit and PIP meetings |
| `gaps/` | **Capability-gap findings, in Hebrew.** Where an agent judged one of the two client AI systems not good enough to answer a real question. One file per project per day. These are internal notes, not customer-facing incidents |
| `notebook-x/` | Findings specific to the Notebook-X project |
| `side-plots/` | The office's own narrative events |
| `asset-pipeline/` | The design/asset work board |
| `model-training/`, `templates/` | Supporting material |
| `_drafts/` | Reports the reviewer rejected, kept with the rejection note |

---

## Two things this file deliberately does not do

**It does not set a formatting standard.** Bringing the report types to one
heading structure, one date format and one way of naming an agent is
**board task OB-019**, assigned to Agent 3 — the office's own work, and not
something written over its head. This page describes what exists; the standard
is the office's to propose.

**It does not touch the archive.** Nothing already published here has been
moved, rewritten or deleted, and nothing will be. What was published stays
published — the same rule the office applies to its own git history.
