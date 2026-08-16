<!--
  ═══════════════════════════════════════════════════════════════════════════
  THE PUBLIC FRONT — SKELETON. Structure only; no visitor-facing copy.
  ═══════════════════════════════════════════════════════════════════════════

  Built 2026-08-16 by a supervised infrastructure session (OB-013's structure
  half). Every `<!-- PLACEHOLDER -->` below marks content the OFFICE writes,
  not this session and not any future infrastructure session. That division is
  a standing rule, not a preference: pages, copy, agent descriptions and
  portfolio content are the office's work and are dispatched to the board,
  because building the content here is how the project would avoid ever
  learning what its agents can actually produce.

  HOW CONTENT REACHES THIS DIRECTORY. Not by an agent writing here. Drafts
  accumulate in back-office `campus/shared/front-drafts/`, the QA signs off,
  the Designer curates a batch, and the batch publishes through
  `workers/front-gate.js` + the `front_publish` trigger — which writes via
  `commitFileToRepo()`, the only path that runs A10's mandatory security scan.
  See `campus/shared/front-drafts/PUBLISHING-GATE.md` (private) for the eight
  criteria.

  WHY EVERYTHING IS NESTED UNDER `front/`. So A10's scan needs ONE entry in
  `workers/security-scan.js` SCANNED_PREFIXES rather than five. An uncovered
  path does not fail loudly — `scanOutbound()` returns `{scanned: false}` and
  the write proceeds — so the number of prefixes to keep in sync is a safety
  property, not a layout choice.
-->

# The Office

<!-- PLACEHOLDER — landing overview. Owner's own framing, to be written by the
     office (the Designer, per A10): a team of AI agents that takes complex
     tasks and executes them with hierarchy, policy and office logic, and that
     reviews itself and improves autonomously. Landing does not tell the whole
     story; it promises the order it comes in. -->

## Where to go

The visitor narrative order is the owner's, and it is fixed:

| # | Section | What it answers |
|---|---|---|
| 1 | **[The agents](team/)** | Who is in the office, and each one's own logic. **This is what a visitor should meet first.** |
| 2 | **[What the office built](portfolio/)** | The deliverables, on real client projects |
| 3 | **[How it reviews itself](product/)** | The autonomy and the learning loop — the mechanism, not a claim |
|   | [The record](press/) | The evidence for all three: published reports, a disagreement, a mistake found and said so |

## The projects the office works on

| Project | Status |
|---|---|
| [Data Center](https://avivnofar.github.io/data-center/) | Live. The Claude-powered system the office asks real questions of and judges the answers |
| [Notebook-X](https://notebook-x.vercel.app) | Live. The Gemini-powered knowledge system the office tests the same way |
| Archive Alpha | Not yet open. Named here without a link until it does — owner instruction |

<!-- LINK RULE, load-bearing: Notebook-X's REPOSITORY is private and a link to
     it 404s for every visitor. Seven such links were found and fixed across
     this repo's docs; the app URL above is the correct target and the repo URL
     must never be reintroduced here. -->

---

*This directory is the office's public front. Nothing in it is written by a
human — the office drafts it, the QA reviews it, the Designer publishes it. The
sections below are live as structure; each fills in as the office produces and
signs off its content.*
