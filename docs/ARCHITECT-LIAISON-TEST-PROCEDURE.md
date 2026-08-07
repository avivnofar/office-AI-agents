# Architect-liaison — written test procedure

**Built:** 2026-08-07, phase-2 Architect-automation build session (back-office
repo, campus/agents/10-the-architect). **Status: SHIPPED OFF.** This build
session did not enable the flag, did not deploy this code, and did not run
`wrangler deploy`. Everything below is for the owner to run, at whatever
point deployment and enabling are separately decided.

**What this feature is**, in one line: when turned on, the office recognises
the Architect's (Agent 10) headless midnight Claude Code run in
`back-office-AI-agents` as a real session, filing a summary into this
Worker's own D1 `reports` table so agent context and the meeting engine can
see it happened. Full design: `workers/architect-liaison.js`'s header
comment and `back-office-AI-agents/campus/agents/10-the-architect/automation/SESSION-RECORD-CONTRACT.md`.

**Why this doc exists.** "Prove inertness with a read-back, not an
assertion. An HTTP 200 proves nothing." This is that read-back, written down
so the owner can run it independently rather than trust this session's own
report of having run it.

---

## Step 1 — run the automated proof (no deploy, no network, no cost)

```
cd office-AI-agents
node scripts/verify-architect-liaison-inert.js
```

**Expected: `31 passed, 0 failed`, exit code `0`.** This checks, against the
actual source files (not a transcription of them):

1. The flag defaults to disabled under every KV shape it might be in,
   including simply absent — which is what a freshly-deployed, never-toggled
   Worker actually has.
2. `config/simulation-config.json`'s static defaults never set the flag true.
3. **The call site in `workers/agent-runner.js` is what gates entry** — the
   dispatch is a ternary on `architectLiaisonEnabled(sim)`, and there is
   exactly one real call to `processArchitectLiaisonBlock(env)` in the whole
   file (not two, which would mean a second, ungated path exists).
4. `config/daily-schedule.json` carries the new block (so the feature is
   real, not vaporware) and its own doc block says `SHIPPED OFF` in-line.
5. Calling the module directly with the flag's real effect absent (no
   `BACKOFFICE_REPO_TOKEN`) makes **zero** network calls — `fetch` is a
   tripwire in this test file that throws if invoked without an explicit
   mock, so "made no GitHub call" is proven, not claimed.
6. With the flag's effect simulated ON (mocked fetch + D1), the real
   fetch-parse-file pipeline produces exactly one correctly-shaped D1 row,
   idempotently.

If this does not print `31 passed, 0 failed`, do not trust anything below
this line until it does — the rest of this procedure only tests the flag's
value, not whether the code behind it is correct.

## Step 2 — read the flag's actual value in this Worker's KV

This step needs the code deployed (`wrangler deploy`, not part of this
build session) and the Worker reachable.

```
curl -s -X POST https://<worker-url>/api/agents/trigger \
  -H 'Content-Type: application/json' \
  -d '{"type":"architect_liaison_status"}'
```

Expected response before anyone has ever called the toggle:

```json
{
  "architectLiaisonEnabled": false,
  "rawFlagValue": null,
  "note": "This reads simulation-state only. ..."
}
```

`rawFlagValue: null` (or the key simply absent from the returned object,
depending on how your client renders `undefined`) is the proof that nothing
in this build session — not the code, not this test procedure, not the
deploy itself — ever called the toggle. If you see `true` here and did not
call the toggle yourself, that is a real incident: something else wrote to
this Worker's `SIM_KV` `simulation-state` key, and the next place to look is
whatever else has write access to that namespace.

**This endpoint makes no GitHub API call and files no report.** It is safe
to call at any time, including before you have configured
`BACKOFFICE_REPO_TOKEN`, and calling it does not itself prove the call site
in `agent-runner.js` is never entered — that is what Step 1's static check
is for. This step only proves what the flag's live value is.

## Step 3 (optional, for later — not part of proving today's inertness) — the actual enable

Do not do this as part of verifying today's build. Recorded here only so a
future session does not have to rediscover the shape:

```
curl -s -X POST https://<worker-url>/api/agents/trigger \
  -H 'Content-Type: application/json' \
  -d '{"type":"architect_liaison_toggle","enabled":true}'
```

Before doing this for real, also set the `BACKOFFICE_REPO_TOKEN` secret if
it is not already configured for the campus write path (see back-office's
`CLAUDE.md`, the 2026-08-06 guard-correction section, for what that secret
is for and why it must not be substituted with `GITHUB_TOKEN`). This module
reuses that same write-scoped secret for GET-only reads, a known scope
mismatch recorded in `workers/architect-liaison.js`'s own header — accepted
for this build, not fixed.

## Known open item, flagged not resolved by this build

The office's simulated work hours and the Worker's cron window were
mismatched before 2026-08-06 and were retimed that day — see
`config/daily-schedule.json`'s `_office_hours_retime_2026_08_06` block. This
feature's block sits at 08:00 Israel, the retimed window's own first tick,
specifically to avoid reintroducing that mismatch. Whether an 8-hour gap
between the Architect's 00:00 run and this 08:00 read is the right lag, too
long, or fine, is **not decided by this build** — see
`config/daily-schedule.json`'s `architect_liaison_program.known_mismatch_flagged_not_fixed`
for the fuller note.
