#!/usr/bin/env node
/**
 * scripts/report-watchdog.mjs — THE EXTERNAL CHECK (policy A16).
 *
 * Built 2026-08-10.
 *
 *   > A16. Watching the watchers
 *   > The Workflow catches stalled work, idle agents and missed metric lines.
 *   > **He cannot catch a failure that stops him from running.**
 *   > **An external check is therefore required**: something outside the Worker
 *   > that asks "was a report written today?" and says so if not. The midnight
 *   > run is a natural home — it runs from a different machine, by a different
 *   > mechanism.
 *
 * ── WHY IT IS A LOCAL SCRIPT AND NOT A WORKER ROUTE ──────────────────────
 *
 * Because a Worker route would be inside the thing being watched. Every health
 * signal this office has — `/api/agents/status`, `office_context_status`,
 * `routing_status`, the improvement loop's own capture — runs in the same
 * Worker on the same cron. If the Worker stops being invoked, all of them stop
 * answering, and nothing anywhere notices. That is the exact failure A16 names,
 * and it cannot be fixed by adding a ninth endpoint to the thing that is down.
 *
 * So: different machine (the owner's), different mechanism (the midnight run's
 * Windows Task Scheduler slot), different network path (GitHub's API rather
 * than the Worker's).
 *
 * ── THE ENTRY POINT IS THE DELIVERABLE ───────────────────────────────────
 *
 * The midnight run's wrapper and scheduler entry belong to the Architect chat
 * and are not edited here. What this session provides is a clearly-named entry
 * point with a stable contract, plus the one line of prose in
 * `back-office-AI-agents campus/agents/10-the-architect/automation/
 * instructions_architect.txt` §9 that tells the run to call it. If that run
 * never calls it, this file is §7.2 again — a mechanism with no caller — and
 * the honest thing is that the wiring is one line of someone else's file away,
 * stated rather than assumed done.
 *
 * ── EXIT CODES: 2 IS NOT A PASS ──────────────────────────────────────────
 *
 *   0  the office reported today (or today is Saturday, the rest day)
 *   1  IT DID NOT — say so loudly
 *   2  the check could not be performed (offline, API refused)
 *
 * 2 exists so "nothing was written" and "I could not tell" never collapse into
 * one answer. Collapsing them is how a monitor comes to report health it never
 * measured — this project's most-repeated defect shape, and it would be
 * grotesque to reproduce it inside the check built to catch it.
 *
 * Usage:
 *   node scripts/report-watchdog.mjs              human-readable, both sections
 *   node scripts/report-watchdog.mjs --json       machine-readable object
 *   node scripts/report-watchdog.mjs --branches   the open-branch table only
 *   node scripts/report-watchdog.mjs --reports    the report check only
 *   node scripts/report-watchdog.mjs --date=YYYY-MM-DD   check a specific day
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GH_ROOT = path.resolve(ROOT, '..');

const OWNER = 'avivnofar';
const PUBLIC_REPO = 'office-AI-agents';

// ── FIXED 2026-08-14 (audit א.5) ────────────────────────────────────────
// This watchdog checked `reports/daily` in the PUBLIC repo. Stage 2 of 0.4
// (2026-08-11) moved daily summaries to `campus/shared/daily` in the
// PRIVATE back-office repo, and this file was never touched -- so it has
// printed a false "did not report" every non-Saturday since, exactly the
// failure mode its own header warns about: "a watchdog whose first output
// is a false alarm is a watchdog the owner learns to skim."
const BACKOFFICE_REPO = 'back-office-AI-agents';
const DAILY_SUMMARY_PATH = 'campus/shared/daily';

/**
 * The three repos, and the local checkout each is expected at. Named here
 * rather than discovered, so a repo that has gone missing from the machine is a
 * REPORTED absence instead of a shorter table nobody notices.
 */
const REPOS = [
  { name: 'office-AI-agents', dir: path.join(GH_ROOT, 'office-AI-agents') },
  { name: 'back-office-AI-agents', dir: path.join(GH_ROOT, 'back-office-AI-agents') },
  { name: 'warehouse-office-AI-agents', dir: path.join(GH_ROOT, 'warehouse-office-AI-agents') },
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const onlyBranches = args.includes('--branches');
const onlyReports = args.includes('--reports');
const dateArg = (args.find((a) => a.startsWith('--date=')) || '').slice(7);

/* ─────────────────────────── Saturday is a rest day ───────────────────── */

/**
 * A13: *"Saturday is a rest day. Not for token saving ... but as a safety
 * floor."* So no report on a Saturday is CORRECT, and a watchdog that shouted
 * about it every week would be trained out of within a month. This is the one
 * place the check is allowed to expect silence, and it is a rule from the
 * policy rather than a convenience.
 *
 * Israel time, because that is what the office's schedule and its cron window
 * are written in (`ISRAEL_UTC_OFFSET_HOURS` in workers/agent-runner.js). Using
 * the host's local zone would put the rest day on the wrong date for anyone
 * running this from elsewhere.
 */
const ISRAEL_UTC_OFFSET_HOURS = 3;

function israelNow(now = new Date()) {
  return new Date(now.getTime() + ISRAEL_UTC_OFFSET_HOURS * 3600 * 1000);
}
function israelDateStr(now = new Date()) {
  return israelNow(now).toISOString().slice(0, 10);
}
function isRestDay(now = new Date()) {
  return israelNow(now).getUTCDay() === 6; // Saturday
}

/* ──────────────────────────── The report check ────────────────────────── */

/**
 * Was a report written today?
 *
 * PREFERS the GitHub API, because the published repo is where a report actually
 * lands and the local working tree can be days stale — a watchdog that reads a
 * stale checkout answers a question nobody asked. Falls back to the local tree
 * ONLY to say so explicitly, never to report a pass on its own.
 *
 * back-office-AI-agents is PRIVATE (unlike the public repo this check used to
 * read), so the plain unauthenticated `fetch()` the old code used cannot read
 * it at all — every call would return 404, indistinguishable from "no commit
 * found" without a token. Shelling out to the `gh` CLI (already used by `git`
 * calls elsewhere in this file, same execFileSync + argument-array pattern —
 * never a shell string) reuses whatever credential is already authenticated
 * on this machine (`gh auth status`) rather than this script managing its own
 * token — one fewer secret that can silently expire.
 */
async function checkReports(dateStr) {
  const result = { date: dateStr, method: null, daily: null, ok: false, detail: null };

  const apiPath = `repos/${OWNER}/${BACKOFFICE_REPO}/commits?path=${DAILY_SUMMARY_PATH}&since=${dateStr}T00:00:00Z&per_page=20`;
  try {
    const raw = execFileSync('gh', ['api', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commits = JSON.parse(raw);
    result.method = 'github-api';
    result.daily = Array.isArray(commits) ? commits.length : 0;
    result.ok = result.daily > 0;
    result.detail = result.ok
      ? `${result.daily} commit(s) touching ${DAILY_SUMMARY_PATH} since ${dateStr}T00:00Z — most recent "${commits[0]?.commit?.message?.split('\n')[0] ?? '?'}"`
      : `NO commit touched ${DAILY_SUMMARY_PATH} since ${dateStr}T00:00Z. The office did not report today.`;
    return result;
  } catch (err) {
    // Either `gh` failed to reach the API (offline, not authenticated) or the
    // API itself returned a non-2xx status (gh exits non-zero either way, and
    // includes the HTTP status in its stderr when it is an API-level failure
    // rather than a connection failure) — both collapse to "the check could
    // not be performed", never a pass. Say what the local tree shows AND say
    // it is not the answer.
    const dir = path.join(GH_ROOT, BACKOFFICE_REPO, ...DAILY_SUMMARY_PATH.split('/'));
    const local = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    let newest = null;
    for (const f of local) {
      const st = fs.statSync(path.join(dir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { f, mtimeMs: st.mtimeMs };
    }
    const ghDetail = String(err.stderr || err.message || err).trim().split('\n')[0];
    return {
      ...result,
      method: 'offline',
      ok: null,
      detail: `Could not read ${BACKOFFICE_REPO} via \`gh api\` (${ghDetail}). The check WAS NOT PERFORMED. `
        + `For information only, the LOCAL checkout's newest ${DAILY_SUMMARY_PATH} file is `
        + `${newest ? `${newest.f} (mtime ${new Date(newest.mtimeMs).toISOString()})` : 'none'} — a local tree can be days stale and is not evidence either way.`,
    };
  }
}

/* ──────────────────────────── The branch check ────────────────────────── */

/**
 * Open branches and their age, across all three repos — policy A7's evidence.
 *
 * Reads REMOTE-tracking refs, not local ones. A local branch that was never
 * pushed is the run's own scratch and is nobody else's problem; a pushed branch
 * is a thing the owner has to deal with, which is what A7's backlog rule is
 * about. Age is from the branch tip's committer date, which is what "how long
 * has this been sitting there" means.
 *
 * `git` is invoked with execFileSync and an argument array — never a shell
 * string — so a branch name containing shell metacharacters is data, not code.
 */
function checkBranches() {
  const out = [];
  for (const repo of REPOS) {
    if (!fs.existsSync(path.join(repo.dir, '.git'))) {
      out.push({ repo: repo.name, error: `no checkout at ${repo.dir} — cannot report its branches, and an unreported repo is not a clean one` });
      continue;
    }
    try {
      /*
       * THE DEFAULT BRANCH IS RESOLVED, NEVER ASSUMED. The first version of
       * this file hardcoded `master` for all three, and the first live run
       * reported back-office and warehouse as A7 VIOLATIONS with two active
       * branches each — because both use `main`, and their default branch was
       * being counted as a stray. A watchdog whose first output is a false
       * alarm is a watchdog the owner learns to skim.
       *
       * `origin/HEAD` is set by clone and is the repo's own answer. If it is
       * missing (a bare fetch, a repo cloned before the symref existed), that
       * is REPORTED rather than defaulted — a guessed default branch is how the
       * false alarm happened.
       */
      let defaultBranch = null;
      try {
        defaultBranch = execFileSync('git', ['-C', repo.dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, '');
      } catch { /* reported below, never guessed */ }

      const raw = execFileSync('git', [
        '-C', repo.dir, 'for-each-ref',
        '--format=%(refname:short)\t%(committerdate:unix)\t%(authorname)',
        'refs/remotes/origin',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

      const nowSec = Math.floor(Date.now() / 1000);
      const branches = raw.split('\n').filter(Boolean).map((line) => {
        const [ref, ts, author] = line.split('\t');
        const short = ref.replace(/^origin\//, '');
        return { branch: short, ageDays: Math.floor((nowSec - Number(ts)) / 86400), author: author || 'unknown' };
      }).filter((b) => (
        // `refs/remotes/origin/HEAD` renders as the bare string "origin" under
        // %(refname:short) — it is a symref, not a branch, and it was being
        // counted as one.
        b.branch !== 'origin' && b.branch !== 'HEAD' && b.branch !== defaultBranch
      ));

      out.push({
        repo: repo.name,
        defaultBranch,
        active: branches.length,
        branches: branches.sort((a, b) => b.ageDays - a.ageDays),
        ...(defaultBranch ? {} : { warning: 'origin/HEAD is not set, so the default branch could not be resolved — every remote branch below is listed, including the default one. Run `git remote set-head origin -a`.' }),
      });
    } catch (err) {
      out.push({ repo: repo.name, error: `git for-each-ref failed: ${err.message}` });
    }
  }
  return out;
}

/**
 * A7's verdict, stated rather than left for a reader to work out: one active
 * branch per project is the limit, so two or more is a VIOLATION already in
 * progress and a new one may not be opened on top of it.
 */
function branchVerdict(rows) {
  const violations = rows.filter((r) => !r.error && r.active > 1);
  const withOne = rows.filter((r) => !r.error && r.active === 1);
  const errored = rows.filter((r) => r.error);
  return {
    violation: violations.length > 0,
    violations: violations.map((r) => `${r.repo}: ${r.active} active branches (A7 allows one)`),
    blockedFromNew: [...violations, ...withOne].map((r) => r.repo),
    unreadable: errored.map((r) => `${r.repo}: ${r.error}`),
  };
}

/* ──────────────────────────────── Main ────────────────────────────────── */

const dateStr = dateArg || israelDateStr();
const restDay = !dateArg && isRestDay();

const reports = onlyBranches ? null : await checkReports(dateStr);
const branches = onlyReports ? null : checkBranches();
const verdict = branches ? branchVerdict(branches) : null;

/*
 * EXIT CODE. A16 asks one question — "was a report written today?" — so that is
 * what decides 0 vs 1. The branch table is carried by the same run because it
 * is the same audience at the same moment, but a branch backlog is a FINDING
 * for the owner, not a failure of the office's heartbeat, and conflating them
 * would make the heartbeat alarm fire for a reason it does not describe.
 */
let code = 0;
if (!onlyBranches) {
  if (restDay) code = 0;
  else if (reports.ok === null) code = 2;
  else if (reports.ok === false) code = 1;
}

/**
 * `process.exitCode` and NOT `process.exit()`.
 *
 * Found by running it: `process.exit()` while `fetch`'s keep-alive socket is
 * still open aborts Node on Windows with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c`
 * and an exit code of **-1073740791**, AFTER printing a correct `exit 0`.
 *
 * That is the worst possible shape for this particular script: the output says
 * the office reported, the exit code says the check crashed, and §9 of the
 * night run's instructions tells the run to act on the EXIT CODE. Every healthy
 * night would have been filed as a failed check.
 *
 * `exitCode` plus `unref()`ing the keep-alive below lets the loop drain and the
 * process exit with the code it actually means.
 */
function finish(code) {
  process.exitCode = code;
}

if (asJson) {
  console.log(JSON.stringify({ date: dateStr, restDay, reports, branches, branchVerdict: verdict, exitCode: code }, null, 2));
  finish(code);
} else {

console.log(`\nA16 EXTERNAL CHECK — ${dateStr} (Israel)${restDay ? '  [SATURDAY — rest day per policy A13]' : ''}`);
console.log('='.repeat(72));

if (reports) {
  console.log('\nDID THE OFFICE REPORT TODAY?');
  if (restDay) {
    console.log('  REST DAY — A13 makes Saturday a day with no automated writing.');
    console.log('  Silence today is correct and is NOT a failure.');
    console.log(`  (for information: ${reports.detail})`);
  } else if (reports.ok === true) {
    console.log(`  YES — ${reports.detail}`);
  } else if (reports.ok === false) {
    console.log('  *** NO. THE OFFICE DID NOT REPORT TODAY. ***');
    console.log(`  ${reports.detail}`);
    console.log('  This is what A16 exists to catch: the Workflow cannot report');
    console.log('  a failure that stops him running. Put this in tonight\'s run file');
    console.log('  and DO NOT try to fix the Worker — A1 forbids it. Reporting is the job.');
  } else {
    console.log('  *** COULD NOT CHECK. This is not a pass. ***');
    console.log(`  ${reports.detail}`);
  }
}

if (branches) {
  console.log('\nOPEN BRANCHES (policy A7 — one active branch per project)');
  for (const row of branches) {
    if (row.error) { console.log(`  ${row.repo.padEnd(28)} ERROR: ${row.error}`); continue; }
    if (row.warning) console.log(`  ${row.repo.padEnd(28)} WARNING: ${row.warning}`);
    if (!row.active) { console.log(`  ${row.repo.padEnd(28)} none (default ${row.defaultBranch || '?'}) — a new branch may be opened here`); continue; }
    console.log(`  ${row.repo.padEnd(28)} ${row.active} active (default ${row.defaultBranch || '?'})`);
    for (const b of row.branches) {
      console.log(`      ${String(b.ageDays).padStart(4)}d  ${b.branch}  (${b.author})`);
    }
  }
  if (verdict.violation) {
    console.log('\n  *** A7 VIOLATION: more than one active branch in a project. ***');
    for (const v of verdict.violations) console.log(`      ${v}`);
  }
  if (verdict.blockedFromNew.length) {
    console.log(`\n  NO NEW BRANCH may be opened in: ${verdict.blockedFromNew.join(', ')}`);
    console.log('  Continue the existing one. A new branch is permitted only after the');
    console.log('  previous is merged, or explicitly abandoned by the owner.');
  }
  if (verdict.unreadable.length) {
    console.log('\n  UNREADABLE (an unreported repo is not a clean one):');
    for (const u of verdict.unreadable) console.log(`      ${u}`);
  }
}

console.log(`\nexit ${code}  (0 reported / 1 DID NOT REPORT / 2 could not check)\n`);
finish(code);

}
