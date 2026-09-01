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
/*
 * `--liveness` (OB-130, 2026-08-17) — the mode GitHub Actions runs.
 *
 * It asks `checkWorkerLiveness()` alone: did the Worker write to the PUBLIC
 * repo today? That is the only half of this file answerable with the default
 * `GITHUB_TOKEN`, and the remedy for OB-130 requires no new secret. It also
 * skips the branch table, which needs three local checkouts a runner does not
 * have — a table of three "no checkout" errors every night is noise that
 * teaches the reader to skim, which is the failure this file's own header names.
 */
const onlyLiveness = args.includes('--liveness');
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

/**
 * SESSION 41, ITEM D (2026-09-01) — the UTC instant of Israel midnight-to-
 * midnight for an Israel-local calendar date string.
 *
 * `checkReports()` and `checkWorkerLiveness()` both built their GitHub API
 * `since`/`until` window as `${dateStr}T00:00:00Z` / `T23:59:59Z` — treating
 * an ISRAEL-local date string as a UTC date, off by ISRAEL_UTC_OFFSET_HOURS
 * in both directions. Harmless most of the time (Israel office hours,
 * 08:00-18:00 = 05:00-15:00 UTC, sit safely inside the wrong window too) —
 * but GitHub Actions' `schedule` trigger is not exact, and a run delayed
 * past Israel midnight computes `dateStr` as the NEW Israel day (which has
 * barely started, or has not started at all in UTC terms) and then queries
 * a window that can be almost entirely in the future. `external-check.yml`
 * failed this way on 2026-08-28, 2026-08-30 and 2026-08-31 — each run's own
 * printed header read "2026-09-01 (Israel)" while the run itself executed
 * on 2026-08-31 in UTC, and the query it built (`since=2026-09-01T00:00Z`)
 * had not started yet. `all.length` (total commits in that impossible
 * window) was correctly 0 every time — the check was not wrong about what
 * it found, it was asking about a window that could not contain anything.
 */
function israelDayBoundsUtc(dateStr) {
  const offsetMs = ISRAEL_UTC_OFFSET_HOURS * 3600 * 1000;
  const since = new Date(Date.parse(`${dateStr}T00:00:00Z`) - offsetMs).toISOString();
  const until = new Date(Date.parse(`${dateStr}T23:59:59Z`) - offsetMs).toISOString();
  return { since, until };
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
async function checkReports(dateStr, { exec = execFileSync } = {}) {
  const result = { date: dateStr, method: null, daily: null, ok: false, detail: null };

  // `until` added 2026-08-17 for the same reason as in checkWorkerLiveness()
  // below: unbounded `since` made every past-date check count later days too.
  const { since, until } = israelDayBoundsUtc(dateStr);
  const apiPath = `repos/${OWNER}/${BACKOFFICE_REPO}/commits?path=${DAILY_SUMMARY_PATH}&since=${since}&until=${until}&per_page=20`;
  try {
    const raw = exec('gh', ['api', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

/* ────────────────────── The liveness check (OB-130) ───────────────────── */

/**
 * Commit-message prefixes the LIVE WORKER writes, and nothing else does.
 *
 * `commitFileToRepo()` is the one place a repo write happens (repo-write.js),
 * and every autonomous caller of it prefixes its message this way: gap digests,
 * guide drafts and approvals, weekly and daily reports, the asset board, the
 * QA instruments file, and the admin desk's lifecycle proposals. A human
 * session's commits do not — they are written in prose.
 *
 * This is the seam that makes the check possible with NO credential: a
 * session's commit and the Worker's commit are both authored by the owner's
 * GitHub identity and cannot be told apart by author, but they can be told
 * apart by message.
 */
const WORKER_COMMIT_PREFIXES = Object.freeze(['chore(agents):', 'chore(office):', 'office:', 'designer:']);

export function isWorkerCommit(message) {
  const first = String(message || '').split('\n')[0].trim();
  return WORKER_COMMIT_PREFIXES.some((p) => first.startsWith(p));
}

/**
 * ── IS THE WORKER STILL RUNNING AT ALL? ──────────────────────────────────
 *
 * A16's question is "was a report written today?", and `checkReports()` above
 * answers it against `campus/shared/daily` in the PRIVATE back-office repo.
 * That is the better question and it is the one that cannot run from GitHub
 * Actions: a workflow in the public repo has a `GITHUB_TOKEN` scoped to the
 * public repo, and reading a second private repo would need a new cross-repo
 * secret — which the remedy for `OB-130` explicitly rules out.
 *
 * So this is the narrower question that CAN be asked with no credential at all:
 * **did the live Worker write anything to this public repo today?** It is a
 * weaker signal than the daily summary and it is labelled as one everywhere it
 * appears. What it is not is a guess: the Worker has committed to this repo on
 * every non-Saturday since 2026-08-06 (measured over that window: 1-14 commits
 * a day, zero on the one Saturday), so a work day with none is a real alarm.
 *
 * **Why this is still an EXTERNAL check** — it satisfies A16 on all three
 * counts that matter. Different machine (a GitHub runner, not Cloudflare's
 * edge), different mechanism (Actions cron, not the Worker's own cron),
 * different network path. Nothing about it runs inside the thing being watched,
 * which is the entire property `/api/agents/status` lacks.
 *
 * Exit-code discipline is `checkReports()`'s, unchanged: `ok: null` means the
 * check could not be performed and is NEVER a pass.
 */
export async function checkWorkerLiveness(dateStr, { exec = execFileSync, repo = PUBLIC_REPO } = {}) {
  const result = { date: dateStr, method: null, commits: null, ok: false, detail: null, signal: 'weak' };
  // BOUNDED AT BOTH ENDS. `since` alone counts every commit AFTER that date,
  // which is right for "today" and wrong for every other value of --date: a
  // 2026-08-15 check was reporting 5 commits, all of them from later days.
  // That made the one path this watchdog can be TESTED on report a pass it had
  // not measured — the defect the file's own exit-code discipline is about.
  const { since, until } = israelDayBoundsUtc(dateStr);
  const apiPath = `repos/${OWNER}/${repo}/commits?since=${since}&until=${until}&per_page=100`;
  try {
    const raw = exec('gh', ['api', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const all = JSON.parse(raw);
    if (!Array.isArray(all)) throw new Error('the commits API did not return a list');
    const worker = all.filter((c) => isWorkerCommit(c?.commit?.message));
    result.method = 'github-api';
    result.commits = worker.length;
    result.ok = worker.length > 0;
    result.detail = result.ok
      ? `${worker.length} Worker commit(s) to ${repo} since ${dateStr}T00:00Z — most recent "${worker[0]?.commit?.message?.split('\n')[0]}"`
      : `NO Worker commit reached ${repo} since ${dateStr}T00:00Z (${all.length} commit(s) total, none of them the Worker's). `
        + 'The cron may not be firing, or every write it attempted failed.';
    return result;
  } catch (err) {
    const ghDetail = String(err.stderr || err.message || err).trim().split('\n')[0];
    return {
      ...result,
      method: 'unreachable',
      ok: null,
      detail: `Could not read ${repo} via \`gh api\` (${ghDetail}). The check WAS NOT PERFORMED — this is not a pass.`,
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
function checkBranches({ exec = execFileSync, repos = REPOS, existsSync = fs.existsSync } = {}) {
  const out = [];
  for (const repo of repos) {
    if (!existsSync(path.join(repo.dir, '.git'))) {
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
        defaultBranch = exec('git', ['-C', repo.dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, '');
      } catch { /* reported below, never guessed */ }

      const raw = exec('git', [
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

/*
 * ── WHY THIS IS A FUNCTION AND NOT TOP-LEVEL CODE (2026-08-16, OB-078) ─────
 *
 * Everything below used to run at module scope. That made this file
 * IMPORT-EXECUTES: a Node verifier that so much as `import`ed it would shell
 * out to git, call GitHub, print a report and set an exit code. So the three
 * gates in it — `isRestDay`, `checkReports`, `checkBranches` — could not be
 * exercised by any test, and the gate-call audit recorded all three as
 * UNPROVEN.
 *
 * **That is the finding worth carrying, not the fix.** They were not UNPROVEN
 * because nobody bothered to write tests. They were unprovable because of a
 * property of the module, and no amount of discipline about writing tests
 * changes a module that cannot be loaded. Same shape as the two files whose
 * bare JSON imports were fixed on 2026-08-16: an architecture problem wearing
 * the costume of a habit problem.
 *
 * The behaviour when RUN is unchanged, deliberately — this is the office's A16
 * external check and the midnight run acts on its exit code. The guard below
 * compares `process.argv[1]` against this module's own path, so running it is
 * exactly what it was and importing it is now free.
 */
export async function main() {

const dateStr = dateArg || israelDateStr();
/*
 * The rest-day exemption is derived from `dateStr`, not from "no --date was
 * given". Before 2026-08-17 it read `!dateArg && isRestDay()`, so
 * `--date=2026-08-15` (a Saturday) was checked as though it were a work day and
 * would have alarmed. A watchdog that answers a different question when you
 * name the day is a watchdog nobody can test against a past date.
 */
const restDay = isRestDay(new Date(`${dateStr}T00:00:00Z`));

const liveness = (onlyBranches || onlyReports) ? null : await checkWorkerLiveness(dateStr);
const reports = (onlyBranches || onlyLiveness) ? null : await checkReports(dateStr);
const branches = (onlyReports || onlyLiveness) ? null : checkBranches();
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
  // The heartbeat this run is judging on. `--liveness` judges on the public
  // repo (the only question a GitHub runner can ask without a new secret);
  // every other invocation judges on the daily summary, exactly as before.
  const heartbeat = onlyLiveness ? liveness : reports;
  if (restDay) code = 0;
  else if (heartbeat.ok === null) code = 2;
  else if (heartbeat.ok === false) code = 1;
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
  console.log(JSON.stringify({ date: dateStr, restDay, liveness, reports, branches, branchVerdict: verdict, exitCode: code }, null, 2));
  finish(code);
} else {

console.log(`\nA16 EXTERNAL CHECK — ${dateStr} (Israel)${restDay ? '  [SATURDAY — rest day per policy A13]' : ''}`);
console.log('='.repeat(72));

if (liveness) {
  console.log('\nDID THE LIVE WORKER WRITE ANYTHING TODAY?');
  console.log(`  (public-repo signal — ${liveness.signal.toUpperCase()}er than the daily summary, and labelled so)`);
  if (restDay) {
    console.log('  REST DAY — A13 makes Saturday a day with no automated writing.');
    console.log(`  (for information: ${liveness.detail})`);
  } else if (liveness.ok === true) {
    console.log(`  YES — ${liveness.detail}`);
  } else if (liveness.ok === false) {
    console.log('  *** NO. THE WORKER WROTE NOTHING TO THE PUBLIC REPO TODAY. ***');
    console.log(`  ${liveness.detail}`);
    console.log('  A16: the Workflow cannot report a failure that stops him running.');
    console.log('  Report it. DO NOT try to fix the Worker from here — A1 forbids it.');
  } else {
    console.log('  *** COULD NOT CHECK. This is not a pass. ***');
    console.log(`  ${liveness.detail}`);
  }
}

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

}

/**
 * The gates, exported so they can be exercised. Nothing about them changed;
 * they were simply unreachable from outside a run.
 */
export { isRestDay, israelDateStr, israelNow, israelDayBoundsUtc, checkReports, checkBranches, branchVerdict };

/*
 * RUN ONLY WHEN RUN. `import.meta.url` against `process.argv[1]` — resolved
 * through `realpath` because Windows hands back a drive-letter case and a path
 * separator that do not always match `fileURLToPath()`, and a guard that
 * silently never fires would turn this watchdog into a file that does nothing.
 */
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return entry && entry === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedDirectly) await main();
