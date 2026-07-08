#!/usr/bin/env node
// Dry-run verification (2026-07-08 session) for the widened Israel-time
// gate in .github/workflows/archive-architect.yml's "Check if this is the
// correct Israel-time trigger and not weekend" step. Does NOT touch the
// live (currently disabled_manually) workflow, call Gemini/Resend, or
// write any file — it re-implements the exact same integer-minutes
// tolerance-window logic as a pure function and runs it against simulated
// clock readings, mirroring how scripts/verify-permissions.js mirrors
// workers/permission-guard.js.
//
// Run: node scripts/verify-architect-gate.js

const TOLERANCE_MINUTES = 90;
const TARGET_MINUTES = 15 * 60; // 15:00 Israel time

// Mirrors the workflow's bash: hour/min -> minutes since midnight, weekend
// check, then the same-day dedup guard (today's suggestion file already
// existing in the checkout).
function evaluateGate({ hour, minute, dayOfWeek, suggestionFileExists, eventName = 'schedule' }) {
  if (eventName === 'workflow_dispatch') {
    return { skip: false, reason: 'manual run — gate bypassed' };
  }

  const nowMinutes = hour * 60 + minute;
  const diff = Math.abs(nowMinutes - TARGET_MINUTES);

  if (diff > TOLERANCE_MINUTES) {
    return { skip: true, reason: `outside +/-${TOLERANCE_MINUTES}min window (diff ${diff}min)` };
  }
  if (dayOfWeek === 5 || dayOfWeek === 6) {
    return { skip: true, reason: 'weekend (Fri/Sat)' };
  }
  if (suggestionFileExists) {
    return { skip: true, reason: 'already ran today — dedup guard' };
  }
  return { skip: false, reason: 'within tolerance window, weekday, not yet run today' };
}

// dayOfWeek: 1=Sun ... 7=Sat, matching `date +%u`-with-Sunday-as-7... no —
// `%u` is ISO (1=Mon..7=Sun). The workflow checks dayOfWeek 5/6 for
// Fri/Sat, so these scenarios use the SAME `%u` numbering the workflow
// itself uses (1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun).
const scenarios = [
  // The two candidate cron slots (12:00 UTC=15:00 IDT, 13:00 UTC=16:00 IDT),
  // landing exactly on time — the old exact-hour gate's happy path.
  { label: 'on-time, 15:00 exact (Sun)', hour: 15, minute: 0, dayOfWeek: 7, suggestionFileExists: false, expectSkip: false },
  { label: 'on-time, 16:00 exact (2nd cron slot, Sun, 60min diff, within tolerance)', hour: 16, minute: 0, dayOfWeek: 7, suggestionFileExists: false, expectSkip: false },
  // IMPORTANT, not a test bug: the actual empirically-observed run times
  // from 2026-07-06/07 (17:33, 18:32, 18:45, 19:24 Israel time — see
  // TOKEN-BUDGET.md) were 2.5-4.5h late, which EXCEEDS a +/-90min
  // tolerance. A 90min window (as literally requested this session) does
  // NOT actually cover the documented delay range — this scenario proves
  // it still skips. Flagged prominently in this session's report rather
  // than silently shipping a fix that doesn't fully solve the problem.
  { label: '2.5h late (17:33, Mon) — matches an actual 07-06/07 run time; still skipped even by the new 90min-tolerance gate', hour: 17, minute: 33, dayOfWeek: 2, suggestionFileExists: false, expectSkip: true },
  { label: 'right at the new +90min edge (16:30, Tue)', hour: 16, minute: 30, dayOfWeek: 3, suggestionFileExists: false, expectSkip: false },
  { label: '1min past the new tolerance edge (16:31, Tue)', hour: 16, minute: 31, dayOfWeek: 3, suggestionFileExists: false, expectSkip: true },
  { label: 'within tolerance but Friday — weekend rule still applies', hour: 15, minute: 10, dayOfWeek: 5, suggestionFileExists: false, expectSkip: true },
  { label: 'within tolerance but Saturday — weekend rule still applies', hour: 15, minute: 10, dayOfWeek: 6, suggestionFileExists: false, expectSkip: true },
  { label: 'second delayed run same day, digest already filed — dedup guard fires', hour: 16, minute: 45, dayOfWeek: 4, suggestionFileExists: true, expectSkip: true },
  { label: 'far outside window entirely (09:00, Wed)', hour: 9, minute: 0, dayOfWeek: 4, suggestionFileExists: false, expectSkip: true },
  { label: 'manual workflow_dispatch always bypasses the gate', hour: 3, minute: 0, dayOfWeek: 6, suggestionFileExists: false, eventName: 'workflow_dispatch', expectSkip: false },
];

let pass = true;
console.log('Dry-run only — no workflow triggered, no Gemini/Resend calls, no files written.\n');
for (const s of scenarios) {
  const result = evaluateGate(s);
  const ok = result.skip === s.expectSkip;
  pass = pass && ok;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${s.label}`);
  console.log(`       -> skip=${result.skip} (${result.reason})`);
}

console.log(`\n${pass ? 'All scenarios matched expectations.' : 'MISMATCH — see FAIL lines above.'}`);
process.exit(pass ? 0 : 1);
