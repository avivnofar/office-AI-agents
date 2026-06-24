# Claude API Spike Investigation
**Date:** June 24, 2026

## Observed Spike Pattern
- Hours reported by owner (Anthropic console): 6:00, 8:00, 9:00, 10:00 IL
- API keys affected: unclear from the console alone which key — investigation below narrows it to **Key 1 ("the model" / data-center-api)**, not Key 2 (GitHub automation).

## D1 Evidence

Claude calls logged by the office simulation (`interactions` table,
`model_source = 'claude'`, written by `agents/agent-base.js`'s
`interactWithApp()`), hour is **UTC** (the column is `new Date().toISOString()`):

| Hour (UTC) | Hour (IL, UTC+3) | Calls | Agents |
|---|---|---|---|
| 05 | 08:00 | 22 | 3 |
| 06 | 09:00 | 10 | 2 |
| 08 | 11:00 | 12 | 2 |
| 10 | 13:00 | 22 | 2 |
| 11 | 14:00 | 6 | 1 |

Per-day breakdown (2026-06-18 → 06-24) shows the same UTC hours every work
day: 05, 06, 08, 10, 11 — converting to IL: **08:00, 09:00(-09:30), 11:00,
13:00, 14:00(-14:30)**. This lines up almost exactly with
`config/daily-schedule.json`'s `full_day_schedule.blocks` case-batch times
(08:00, 09:30, 11:00, 13:00, 14:30 IL) and with `wrangler.toml`'s Cron
Trigger window (`*/30 5-13 * * *` UTC = 08:00-16:30 IDT). Daily totals
(e.g. 18 calls on 06-24, 16 on 06-23) stay well under the 30/day
`claude_daily_cap`.

**Conclusion: the office simulation's own Claude usage is fully accounted
for, on-schedule, and under cap.** None of its rows fall at 06:00 or 10:00
IL — the Cloudflare Worker cron does not even start running until 08:00
IDT (05:00 UTC), so the simulation cannot be the source of a 06:00 IL call
by construction.

## Root Cause Analysis

### Cap enforcement (Task 2) — not the bug
Read `agents/agent-base.js` `interactWithApp()` (lines ~353-474):
- **Cap value**: `claude_daily_cap: 30` (`config/token-economy.json`).
- **Check location**: per-call, before every single Claude call — both a
  global check (`COUNT(*) FROM interactions WHERE model_source='claude'
  AND DATE(timestamp)=DATE('now')`) and a per-agent soft cap
  (`floor(model_usage_rate * 30)`). If either is hit, the call is routed to
  Groq instead and logged with `model_source: 'groq'`.
- **Storage**: D1 (`env.DB`), which is durable and shared across every
  Worker instance/isolate — **not in-memory, not per-instance**.
- **Multi-instance risk**: case processing in `workers/agent-runner.js`
  (`processCaseBatch()`) is a sequential `for...of` loop with `await` at
  every step — there is no `Promise.all`/parallel fan-out across agents or
  cases within a scheduled block, so there's no read-then-write race on the
  cap count either. There is, in principle, no file at
  `workers/agent-base.js` — the real file is `agents/agent-base.js`; the
  investigation prompt's path was slightly off but the logic was found and
  reviewed.

**The hypothesized "in-memory cap resets per Worker instance" bug does not
exist in this codebase.** The cap is shared, durable, checked before every
call, and the daily totals in D1 confirm it's holding (≤22/hour, ≤~25/day
observed, never near 30 in a way that suggests double-counting).

### GitHub Actions triggers (Task 3) — clean
`.github/workflows/scheduled-claude.yml` has exactly one trigger:
```yaml
on:
  schedule:
    - cron: '30 23 * * 0-4'   # 23:30 UTC = 02:30 IL, Sun-Thu
  workflow_dispatch: { ... }
```
No `push`, `pull_request`, or `workflow_run` triggers. Other workflow files
in this repo (`agent-cases.yml`: Mon 09:00 UTC, `agent-reports.yml`: Tue
08:00 UTC) are both weekly, not daily, and don't touch the Claude key.
**No unexpected triggers found.** (Could not cross-check actual Action run
history — `gh` CLI is not installed in this environment — so a rogue manual
`workflow_dispatch` firing can't be fully ruled out, but the cron
configuration itself is clean.)

### data-center-api visibility (Task 4) — the real gap
`cloudflare-worker/worker.js` (data-center repo) has:
- Rate limit: 20 requests/minute/IP, **in-memory** (`ipRequests` Map),
  explicitly documented in-file as resetting whenever the Worker isolate
  restarts ("acceptable for a soft per-IP limit on the free tier").
- **No D1 binding, no logging of any kind** — every call this Worker makes
  to Claude (from real visitors to avivnofar.github.io *and* from office
  agents via the `APP_API` service binding) is invisible after the fact.
  The `interactions` table only captures the agent-originated half of that
  traffic; real-user traffic leaves no trace anywhere queryable.

### Ranked likely causes
1. **Most likely**: real human traffic to the AI Search bar at
   avivnofar.github.io (or a bot/crawler hitting it) at 06:00 and 10:00 IL —
   hours with zero matching D1 rows and outside every known scheduled
   trigger window. This traffic is completely unlogged today, so it can't
   be confirmed or refuted with current data — only inferred by elimination.
2. **Second**: a manual `workflow_dispatch` run of `scheduled-claude.yml`
   (can't be ruled out without `gh`/Action run history access).
3. **Ruled out**: office-simulation cron calls (D1 hours don't match;
   cron doesn't run before 08:00 IDT) and a per-instance in-memory cap bug
   (cap is D1-backed, shared, sequential, and currently well under quota).

## Cap Enforcement Status
**Working as designed.** No fix needed here — the 30-call daily cap is
durable (D1), checked before every call, and observed totals stay under it
every day in the sampled range.

## Recommendations
1. **Do not apply the KV-based cap rewrite** that was proposed going in —
   it would be a fix for a bug that this investigation did not find. The
   cap is already correctly shared/durable.
2. **Add minimal logging to `data-center-api`** (data-center repo,
   `cloudflare-worker/worker.js`) — at minimum a D1 row or `console.log`
   per `/api/chat` call with timestamp, so future spikes can be attributed
   to real-user traffic vs. agent traffic vs. something else. This is the
   actual visibility gap behind this investigation's "unclear root cause"
   conclusion, and it lives in the data-center repo, not here.
3. If `gh` CLI becomes available, audit `scheduled-claude.yml`'s Action run
   history for any manual `workflow_dispatch` runs around 06:00/10:00 IL on
   2026-06-2x to close out possibility #2 above.

No code changes were made in this repo — the suspected root cause (cap
enforcement) was investigated and found to be correctly implemented, and
the actual gap is observability in a different Worker/repo.
