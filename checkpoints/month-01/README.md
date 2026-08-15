# month-01 — moved to the back office (2026-08-15)

`day-01-attempt.json` — the diagnostic snapshot of the first-ever
`runWorkDayCycle()` execution (2026-06-11, HTTP 500 after 449s on a Gemini
429) — **moved to `back-office-AI-agents` on 2026-08-15.** It is named here
and not linked, per this repo's convention for private material.

**Why it moved.** The file's own `_meta.visibility` said
`"private (staff + owner)"` while it sat tracked in the public repo. Acting
on that label rather than overriding it: the classification is **correct**,
and the reason is narrower than "it records a failure."

Under `OFFICE-POLICY.md` A10 this repo publishes its mistakes deliberately —
"we were wrong, we found it, we fixed it" is the point of the public repo,
and a day-1 crash is exactly the kind of thing that belongs in the open. The
failure narrative was never the problem. The problem is the file's
`admin_token` block, which records an `ADMIN_TOKEN` rotation and names the
key the dashboard stores it under. That is *how the defence is built* — A10's
never-published category, which covers closed and historical findings too,
because a closed finding still tells a reader where to look.

**No secret value was ever in the file** (the rotated token was handed over
out-of-band, as the file itself records). This is a boundary fix, not an
exposure response — and **no key rotation is proposed or needed**, per AD-030.

**Residual, flagged not fixed:** the file remains in this repo's git history.
Rewriting published history is not something a session does unilaterally, and
the exposure is a mechanism name, not a credential. Recorded for the owner to
decide.

The pointers to this snapshot in `TOKEN-BUDGET.md` and
`reports/weekly/week-01-report.md` name the *pre-migration* path
(`agents/checkpoints/...`, from before this repo was split out of
`data-center/agents/`) and were already stale before this move. Published
reports are corrected by appending, never by silent edit — see A15.
