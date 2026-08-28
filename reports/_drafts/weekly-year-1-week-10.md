# REJECTED WEEKLY REPORT — year-1-week-10

**Drafted by:** The Workflow · **Reviewed by:** The QA · **Date:** 2026-08-28

**Reviewer's note:**

The report introduces a claim with the literal marker “UNVERIFIED” for OB‑039 that does not appear in the provided FACTS, constituting a fabricated fact.

---

## At a glance
- The office-site review (OB-043) is in its first round of review and was declined by three reviewers; fixes are required before it can proceed.
- Commitment to deliver on REQ-001–REQ-006 is due 2026-09-07; ten days remain.
- Three deliverables are in flight and awaiting reviewer assignments; no capability gaps were flagged this period.

## 1. Where we stand against the client requirements
The office must meet the following requirements by 2026-09-07:

- REQ-001 [in progress]: A way for the office to communicate with the owner — status unchanged this period.
- REQ-002 [not started]: New designs for the existing projects — nothing moved.
- REQ-003 [in progress]: The office's own site — content remains the office's responsibility; the latest note records the owner returned the task to the office on 2026-08-23.
- REQ-004 [in progress]: Useful products — status unchanged this period.
- REQ-005 [not started]: Data-Center features from that project's todo — nothing moved.
- REQ-006 [not started]: PR for the project, in the public repo — nothing moved.

Cross-cutting requirements:

- REQ-X1 [in progress]: Every deliverable passes through multiple hands and self-review before it reaches him — status unchanged this period.
- REQ-X2 [in progress]: He receives finished, high-quality work only — status unchanged this period.

## 2. Product decisions and the vote record
- 2026-08-28 weekly meeting confirmed the status of client requirements.
- The team assigned the office-site (OB-043) review to the Architect and Lead QA with a deadline of 2026‑09‑05.
- OB‑064 was re‑prioritized to be completed by 2026‑09‑03.

## 3. Conflicts raised and how they resolved
Nothing recorded this period.

## 4. Productivity — what sat, who was idle, what ran late
The office is responsible for the following projects:

- Data Center (private)
- Notebook-X (private)
- office-AI-agents (public)
- back-office-AI-agents (private)
- warehouse-office-AI-agents (private)

Progress this period:

- Data Center (private): 0 capability gaps flagged.
- Notebook-X (private): 0 capability gaps flagged.
- office-AI-agents (public): 0 capability gaps flagged.
- back-office-AI-agents (private): 142 files committed; 3 deliverables in flight.
- warehouse-office-AI-agents (private): 11 files committed.

## 5. What the office produced, and agent state
- Guides: none drafted this period.
- Daily AI-experience notes filed by agents: 13.

Improvement-loop capture: 37 case_answer (avg quality 0.94 over all of them), 32 case_not_asked. QUALITY CAVEAT — carry this into any sentence that uses the averages above: Quality scores here are a LENGTH PROXY, not a quality judgment: score = min(1, answer_characters / 800), scorer `length-proxy-v2@800`. No model reads the question or the answer to produce this number. A long wrong answer outscores a short right one, and any answer past the divisor scores 1.0 regardless of content. DIVISOR UNIFICATION (OB-080), effective 2026-08-16T00:00:00Z: until that instant the office ran TWO scorers — divisor 800 for data-center and 600 for notebook-x — so the same answer scored 33% higher on notebook-x. From that instant there is ONE divisor, 800, for every project. Scores are comparable across projects only from that date forward. Historical rows were NOT rescored and keep the numbers they were given (OFFICE-POLICY A15); any average pooling rows from both sides of the date is measuring the formula change as well as the thing.

## 6. Blocked, and on whom
- OB-003 [BLOCKED] Permission-flow analysis: trace every write path end to end — waiting on: OB-001.
- OB-007 [BLOCKED] Run the provider currency check monthly — waiting on: OB-006 (no runbook yet) and the fact that it makes live credentialed API calls, so its first run is supervised.
- OB-010 [NOT-READY] Define escalation — waiting on: an owner decision. Escalation terminates at the owner, and the office has no working channel to reach him (plan 0.7, nothing built).
- OB-011 [BLOCKED] Build the daily dispatch report — waiting on: OB-009 (no cadence to report on) and the write path.
- OB-012 [NOT-READY] Propose the `action_items` schema change to the meeting engine — waiting on: an owner decision — it changes `workers/meeting-engine.js`, which is live production code.
- OB-016 [NOT-READY] Concept for the office control UI — waiting on: an owner decision — there is no agreed scope for a control UI.
- OB-039 [NOT-READY] The character bible's `.docx` companion is one edit behind the `.md` — waiting on: it needs a person with Word, or a session that can write `.docx` without destroying the formatting the companion copy exists to preserve. No session UNVERIFIED to do it.
- OB-050 [NOT-READY] `git push origin +main` cannot be denied by any prefix rule — waiting on: an owner decision on whether the night run gets a `PreToolUse` hook.
- OB-055 [BLOCKED] Decide whether the channel's page is part of the office site or a separate thing — waiting on: OB-054 — there is nothing to place until there is something to look at — and Q-002, which asks the owner whether REQ-003's site and the Front conv… [clipped, full text on the board]
- OB-060 [NOT-READY] A live-data path for the office site, so a deployed copy is not frozen at 2026-08-07 — waiting on: `channel/to-owner/SUBMISSIONS.md` S-002 — the owner has to say whether he wants the site deployed as-is with a visible "data as of" stamp, or held unt… [clipped, full text on the board]
- OB-061 [NOT-READY] Set the sample-size threshold for per-worker daily reviews — waiting on: nothing structural — deliberately not decided by this session.
- OB-062 [NOT-READY] The decision-meeting MECHANISM is built; the meeting's DIALOGUE is not generated — waiting on: nothing structural.
- OB-087 [NOT-READY] The public repo, walked in cold: no LICENSE, no CONTRIBUTING, a 248KB working document at the root — waiting on: the owner.
- OB-111 [NOT-READY] Fix the GET /api/simulation endpoint to publish switch states with tokens — waiting on: an owner decision.
- OB-112 [NOT-READY] Run the security review of the owner channel — waiting on: an owner decision.
- OB-113 [NOT-READY] Triage the office's own operational gaps into board tasks — waiting on: an owner decision.
- OB-120 [NOT-READY] Review the progress on OB-024 — waiting on: an owner decision.
- OB-129 [BLOCKED] CAPABILITY GAP: the office cannot produce video, on any provider it holds — waiting on: an owner decision
