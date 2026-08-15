#!/usr/bin/env node
// Manual dry-run verification (Step 7, 2026-07-08 session) for the
// push/pull permission model. Does NOT push, pull, or call any model —
// it exercises the ACTUAL decision logic in workers/permission-guard.js
// (resolveWriteTarget()/resolveIssueTarget()), imported directly rather
// than mirrored.
//
// Until 2026-07-12 this file carried its own hand-copied mirror of that
// logic, because permission-guard.js's own `import x from '*.json'` needed
// an import assertion plain `node` rejects
// (ERR_IMPORT_ASSERTION_TYPE_MISSING) that esbuild/Workers doesn't need —
// see the 2026-07-08 TOKEN-BUDGET.md entry. permission-guard.js no longer
// imports the JSON itself (its functions take `permissions` as a
// parameter instead — see its own file header), so it has no JSON import
// left to trip that error, and this script can import the real functions.
// This script still loads config/project-permissions.json itself, the
// same way it always did — that half was never the problem.
//
// Run: node scripts/verify-permissions.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveWriteTarget as resolveWriteTargetReal,
  resolveIssueTarget as resolveIssueTargetReal,
  resolveRepoWrite as resolveRepoWriteReal,
} from '../workers/permission-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_NAME = 'office-AI-agents';
const BACKOFFICE_REPO_NAME = 'back-office-AI-agents';
const WAREHOUSE_REPO_NAME = 'warehouse-office-AI-agents';

// Mirrors workers/agent-runner.js L83-120. Kept as literals rather than
// imported because agent-runner.js pulls in the whole Worker (Durable
// Objects, JSON imports, the lot) and this script must stay runnable under
// plain `node` with no network — the same reason the rest of this file
// re-declares REPO_NAME instead of importing it.
const REPO_TO_PROJECT_KEY = {
  [REPO_NAME]: 'office-agents',
  [BACKOFFICE_REPO_NAME]: 'back-office',
  [WAREHOUSE_REPO_NAME]: 'warehouse',
};
const REPO_TO_TOKEN_SECRET = {
  [REPO_NAME]: 'GITHUB_TOKEN',
  [BACKOFFICE_REPO_NAME]: 'BACKOFFICE_REPO_TOKEN',
  [WAREHOUSE_REPO_NAME]: 'WAREHOUSE_REPO_TOKEN',
};

// Secret NAMES only — this script never sees or needs a token value.
// Mirrors the Worker's real secret list as of 2026-08-06: GITHUB_TOKEN and
// BACKOFFICE_REPO_TOKEN are set; WAREHOUSE_REPO_TOKEN is deliberately not.
const SECRETS_PRESENT = {
  GITHUB_TOKEN: true,
  BACKOFFICE_REPO_TOKEN: true,
  WAREHOUSE_REPO_TOKEN: false,
};

const permissions = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'config', 'project-permissions.json'), 'utf8')
);

// Thin adapters: this script's scenario objects only carry the fields the
// tests below care about (no `body` for issues, etc.) — these just supply
// ownRepoName and forward everything else to the real functions.
function resolveWriteTarget({ projectKey, targetRepoName, path: filePath }) {
  return resolveWriteTargetReal(permissions, { projectKey, ownRepoName: REPO_NAME, targetRepoName, path: filePath });
}
function resolveIssueTarget({ projectKey, targetRepoName, title }) {
  return resolveIssueTargetReal(permissions, { projectKey, ownRepoName: REPO_NAME, targetRepoName, title, body: '' });
}

const writeScenarios = [
  { projectKey: 'archive-galil-elion', targetRepoName: 'local-archive-galil-elion', path: 'docs/architect-suggestions/2026-07-08.md', expectRedirected: true },
  { projectKey: 'notebook-x', targetRepoName: 'notebook-x', path: 'notebooks/kb-docker.json', expectRedirected: false },
  { projectKey: 'data-center', targetRepoName: 'data-center', path: 'reports/example.md', expectRedirected: true },
  { projectKey: 'archive-alpha', targetRepoName: 'archive-alpha', path: 'reports/2026-07-08.md', expectRedirected: true },
  // Self-write via the config path (2026-07-08 config-driven-self-write
  // session): office-AI-agents' own repo is no longer hardcode-exempt in
  // workers/agent-runner.js — REPO_TO_PROJECT_KEY now maps it to the
  // "office-agents" key too, so this scenario exercises the SAME
  // canPushToProject("office-agents") check every other project goes
  // through, not a bypass. Must stay expectRedirected:false as long as
  // "office-agents".push stays true — see project-permissions.json's
  // office_agents_push_true_is_load_bearing note.
  { projectKey: 'office-agents', targetRepoName: 'office-AI-agents', path: 'reports/model-education/data-center/2026-07-08.md', expectRedirected: false },
];

const issueScenarios = [
  { projectKey: 'data-center', targetRepoName: 'data-center', title: '[Model Education] Case crm-2026-w03-d2-001 — quality 0.10', expectRedirected: true },
  { projectKey: 'notebook-x', targetRepoName: 'notebook-x', title: 'Some notebook-x issue', expectRedirected: false },
];

let pass = true;
console.log('Dry-run only — no GitHub API calls made.\n');
console.log('-- File-commit redirects (commitFileToRepo / resolveWriteTarget) --');
for (const s of writeScenarios) {
  const result = resolveWriteTarget(s);
  const ok = result.redirected === s.expectRedirected;
  pass = pass && ok;
  const verdict = ok ? 'PASS' : 'FAIL';
  console.log(`[${verdict}] ${s.projectKey} -> ${s.targetRepoName}/${s.path}`);
  if (result.redirected) {
    console.log(`       BLOCKED, redirected to: ${result.repoName}/${result.path} (${result.reason})`);
  } else {
    console.log(`       ALLOWED, writes directly to: ${result.repoName}/${result.path}`);
  }
}

console.log('\n-- Issue-creation redirects (fileGitHubIssue / resolveIssueTarget) --');
for (const s of issueScenarios) {
  const result = resolveIssueTarget(s);
  const ok = result.redirected === s.expectRedirected;
  pass = pass && ok;
  const verdict = ok ? 'PASS' : 'FAIL';
  console.log(`[${verdict}] ${s.projectKey} -> ${s.targetRepoName} Issue: "${s.title}"`);
  if (result.redirected) {
    console.log(`       BLOCKED, redirected to: ${result.repoName} ("${result.title}") (${result.reason})`);
  } else {
    console.log(`       ALLOWED, opens directly in: ${result.repoName}`);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * REPO-WRITE RESOLUTION (resolveRepoWrite) — added 2026-08-06, plan item 0.3.
 *
 * This block exists because of a FAIL-OPEN defect, and it is written the way
 * gate-wiring-verification says to write it: several of these scenarios FAIL
 * against the pre-2026-08-06 code, so the table demonstrably catches the bug
 * rather than describing the fix.
 *
 * What the old code did (agent-runner.js, before this change):
 *
 *     const projectKey = REPO_TO_PROJECT_KEY[repoName];
 *     if (projectKey) { ...resolveWriteTarget()... }   // no else
 *     if (!env.GITHUB_TOKEN) return ...;               // one hardcoded token
 *     // ...write proceeds to repoName
 *
 * Scenarios marked FAILS-OLD below, and why:
 *   · unmapped repo        — old: `if (projectKey)` false, check SKIPPED, the
 *                            write went through. new: DENIED.
 *   · back-office markdown — old: unmapped, so unchecked AND paid for with
 *                            GITHUB_TOKEN (a public-repo credential). new:
 *                            allowed, via BACKOFFICE_REPO_TOKEN.
 *   · warehouse code file  — old: blanket code-write denial; the documented
 *                            code_write:true exception was read by nothing.
 *                            new: passes the code rule, then DENIED on the
 *                            missing token — two independent locks.
 * ─────────────────────────────────────────────────────────────────────────── */

function resolveRepoWrite({ targetRepoName, path: filePath, explicitCodeTask = false }) {
  return resolveRepoWriteReal(permissions, {
    repoToProjectKey: REPO_TO_PROJECT_KEY,
    repoToTokenSecret: REPO_TO_TOKEN_SECRET,
    ownRepoName: REPO_NAME,
    targetRepoName,
    path: filePath,
    explicitCodeTask,
    secretsPresent: SECRETS_PRESENT,
  });
}

const repoWriteScenarios = [
  // ── The fail-open case. An unmapped repo name must be DENIED, not skipped.
  {
    label: 'unmapped repo name (the fail-open hole)',
    failsOld: true,
    args: { targetRepoName: 'some-other-repo', path: 'notes.md' },
    expect: { allowed: false, blocked: 'unmapped_repo' },
  },
  {
    // NOT marked FAILS-OLD, and the reason is worth keeping. The old code
    // denied this too — but on the FILE EXTENSION, via the blanket code-write
    // rule, having never looked at the repo at all. Same verdict, different
    // mechanism, entirely by coincidence of shape: change the path to .md and
    // the old code wrote it to an arbitrary repo. Two mechanisms agreeing by
    // accident is not a guard, and this scenario pins which one is answering.
    label: 'unmapped repo, code file — must be denied on the REPO, not the extension',
    args: { targetRepoName: 'aviv-brain', path: 'skills/thing.js' },
    expect: { allowed: false, blocked: 'unmapped_repo' },
  },

  // ── back-office: markdown allowed, code denied (code_write:false).
  {
    label: 'back-office markdown (the campus write path)',
    failsOld: true,
    args: { targetRepoName: BACKOFFICE_REPO_NAME, path: 'campus/agents/06-the-qa/active-context.md' },
    expect: { allowed: true, blocked: undefined, tokenSecret: 'BACKOFFICE_REPO_TOKEN', redirected: false },
  },
  {
    label: 'back-office CODE file — code_write:false',
    args: { targetRepoName: BACKOFFICE_REPO_NAME, path: 'campus/tools/helper.js' },
    expect: { allowed: false, blocked: 'code_write_guard' },
  },

  // ── warehouse: the single code_write:true exception, now actually read.
  {
    label: 'warehouse CODE file — code_write:true passes the code rule...',
    failsOld: true,
    args: { targetRepoName: WAREHOUSE_REPO_NAME, path: 'tasks/pilot/src/index.js' },
    // ...and is then stopped by the SECOND lock: no WAREHOUSE_REPO_TOKEN.
    expect: { allowed: false, blocked: 'token_not_configured' },
  },

  // ── public repo: existing behaviour must be BIT-FOR-BIT unchanged.
  {
    label: 'public repo markdown (all 17 live call sites look like this)',
    args: { targetRepoName: REPO_NAME, path: 'reports/daily/day-042-summary.md' },
    expect: { allowed: true, blocked: undefined, tokenSecret: 'GITHUB_TOKEN', redirected: false },
  },
  {
    label: 'public repo CODE file — still blanket-denied',
    args: { targetRepoName: REPO_NAME, path: 'workers/thing.js' },
    expect: { allowed: false, blocked: 'code_write_guard' },
  },
  {
    label: 'public repo CODE file WITH explicitCodeTask — still the one pass',
    args: { targetRepoName: REPO_NAME, path: 'workers/thing.js', explicitCodeTask: true },
    expect: { allowed: true, blocked: undefined, tokenSecret: 'GITHUB_TOKEN' },
  },

  // ── The token must never be borrowed from another target.
  {
    label: 'no repo resolves to a token it does not own',
    args: { targetRepoName: BACKOFFICE_REPO_NAME, path: 'campus/shared/meetings/2026-08-06.md' },
    expect: { allowed: true, tokenSecret: 'BACKOFFICE_REPO_TOKEN' },
  },
];

console.log('\n-- Repo-write resolution (commitFileToRepo / resolveRepoWrite) --');
for (const s of repoWriteScenarios) {
  const r = resolveRepoWrite(s.args);
  const checks = Object.entries(s.expect).map(([k, v]) => [k, r[k], v, r[k] === v]);
  const ok = checks.every(([, , , good]) => good);
  pass = pass && ok;
  const tag = s.failsOld ? '  [FAILS-OLD]' : '';
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${s.label}${tag}`);
  console.log(`       ${s.args.targetRepoName}/${s.args.path}`);
  if (r.allowed) {
    console.log(`       ALLOWED -> ${r.repoName}/${r.path}  key=${r.projectKey}  token=${r.tokenSecret}${r.redirected ? '  (REDIRECTED)' : ''}`);
  } else {
    console.log(`       DENIED  blocked=${r.blocked}`);
  }
  for (const [k, got, want, good] of checks) {
    if (!good) console.log(`         MISMATCH ${k}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}

// A structural assertion rather than a scenario: every repo the office can
// name must have BOTH a permissions key and a token secret. A repo with a
// key but no secret would deny at step 4 (safe but confusing); a repo with a
// secret but no key would deny at step 1. Neither should exist by accident.
console.log('\n-- Map completeness (every mapped repo has a key AND a secret) --');
const mappedRepos = new Set([...Object.keys(REPO_TO_PROJECT_KEY), ...Object.keys(REPO_TO_TOKEN_SECRET)]);
for (const repo of mappedRepos) {
  const key = REPO_TO_PROJECT_KEY[repo];
  const secret = REPO_TO_TOKEN_SECRET[repo];
  const inPerms = key ? Object.prototype.hasOwnProperty.call(permissions, key) : false;
  const ok = !!key && !!secret && inPerms;
  pass = pass && ok;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${repo.padEnd(28)} key=${key ?? '(none)'} secret=${secret ?? '(none)'} inPermissionsJson=${inPerms}`);
}

/* ───────────────────────────────────────────────────────────────────────────
 * PUBLISHING SPLIT (plan 0.4) — CALL-SITE REGRESSION CHECK, stage 1/5:
 * meeting reports, moved 2026-08-11.
 *
 * resolveRepoWrite() itself can't tell "a meeting report" from any other
 * markdown write — both office-AI-agents and back-office-AI-agents are
 * legitimate targets at the guard level (see the repo-write scenarios
 * above), so a scenario table alone proves only that BOTH remain reachable,
 * not which one meeting-engine.js actually calls. This reads the real
 * source of commitMeetingReport() and asserts it targets
 * BACKOFFICE_REPO_NAME, not REPO_NAME. Before this session's edit this
 * check would have FAILED both assertions — the function passed REPO_NAME
 * and wrote to `reports/meetings/<type>-<stamp>.md` in the public repo.
 * ─────────────────────────────────────────────────────────────────────────── */

console.log('\n-- Publishing-split call-site check (0.4 stage 1: meeting reports) --');
{
  // Normalised for the same reason as stages 3/4 below. This one PASSES today
  // only because meeting-engine.js happens to sit in the working tree with LF;
  // one `git checkout` under core.autocrlf=true and it fails identically. A
  // latent instance of the same defect is still the defect.
  const meetingEngineSrc = fs.readFileSync(path.join(REPO_ROOT, 'workers', 'meeting-engine.js'), 'utf8').replace(/\r\n/g, '\n');
  const fnMatch = meetingEngineSrc.match(/async function commitMeetingReport\([\s\S]*?\n}\n/);
  const fnBody = fnMatch ? fnMatch[0] : '';
  const callSiteChecks = [
    ['commitMeetingReport() found in workers/meeting-engine.js', !!fnMatch],
    ['targets BACKOFFICE_REPO_NAME', /\bBACKOFFICE_REPO_NAME\b/.test(fnBody)],
    ['does NOT target REPO_NAME (the pre-2026-08-11 public-repo call)', !/\bREPO_NAME\b/.test(fnBody)],
    ['path uses campus/shared/meetings/ (DOC-POLICY.md 2.4 convention)', /campus\/shared\/meetings\//.test(fnBody)],
  ];
  for (const [label, ok] of callSiteChecks) {
    pass = pass && ok;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * PUBLISHING SPLIT (plan 0.4) — CALL-SITE REGRESSION CHECK, stage 2/5:
 * daily summaries, moved 2026-08-11.
 *
 * TWO call sites write `day-NNN-summary.md`: the live per-block cron path
 * (finalizeScheduledDay()) and the documented-non-functional {"type":"day"}
 * whole-day path (runWorkDayCycle()) — see CLAUDE.md's "How to run a
 * simulation day manually". Dead code that still names the wrong repo is a
 * live bug the day someone repairs the other path, so both are checked, not
 * just the one cron actually calls. Before this session's edit both call
 * sites passed REPO_NAME and wrote to `reports/daily/` in the public repo.
 * ─────────────────────────────────────────────────────────────────────────── */

console.log('\n-- Publishing-split call-site check (0.4 stage 2: daily summaries) --');
{
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'workers', 'agent-runner.js'), 'utf8');
  const dayWriteRe = /commitFileToRepo\(\s*\n\s*env,\s*(\w+),\s*`([^`]*day-\$\{pad\(nextDay, 3\)\}-summary\.md)`/g;
  const matches = [...runnerSrc.matchAll(dayWriteRe)];
  const callSiteChecks = [
    ['both day-summary call sites found (finalizeScheduledDay + runWorkDayCycle)', matches.length === 2],
    ['every call site targets BACKOFFICE_REPO_NAME', matches.every((m) => m[1] === 'BACKOFFICE_REPO_NAME')],
    ['no call site targets bare REPO_NAME (the pre-2026-08-11 public-repo call)', !matches.some((m) => m[1] === 'REPO_NAME')],
    ['every call site uses campus/shared/daily/ (parallels stage 1\'s campus/shared/meetings/)', matches.every((m) => m[2].startsWith('campus/shared/daily/'))],
    ['no call site still targets reports/daily/ (the old public path)', !matches.some((m) => m[2].startsWith('reports/daily/'))],
  ];
  for (const [label, ok] of callSiteChecks) {
    pass = pass && ok;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * PUBLISHING SPLIT (plan 0.4) — CALL-SITE REGRESSION CHECK, stage 3/5: the
 * weekly RAW trio, moved 2026-08-11. This is generateWeeklySummary()'s three
 * commitFileToRepo() calls — distinct from the REVIEWED
 * `reports/weekly/week-NN-report.md` (workers/report-pipeline.js), which
 * stays public and is untouched by this check. Before this session's edit
 * all three call sites passed REPO_NAME and wrote to `reports/weekly/` in
 * the public repo, including `-public-summary.md` despite its name — the
 * file is raw/unreviewed regardless, per DOC-POLICY.md.
 * ─────────────────────────────────────────────────────────────────────────── */

console.log('\n-- Publishing-split call-site check (0.4 stage 3: weekly raw trio) --');
{
  // NORMALISED, 2026-08-15. This read the file raw and matched `\n}\n`, which
  // is a LINE-ENDING dependency, not a permissions rule: `core.autocrlf=true`
  // (the owner's own setting) checks agent-runner.js out with CRLF, so this
  // block failed on the machine a person actually runs it on while passing in
  // CI on Linux. A verifier that is red for an environmental reason is worse
  // than no verifier — it teaches the reader that red means nothing.
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'workers', 'agent-runner.js'), 'utf8').replace(/\r\n/g, '\n');
  const fnMatch = runnerSrc.match(/async function generateWeeklySummary\([\s\S]*?\n}\n/);
  const fnBody = fnMatch ? fnMatch[0] : '';
  const weeklyWriteRe = /commitFileToRepo\(env, (\w+), `\$\{base\}\/(week-\$\{pad\(weekNumber, 2\)\}-[\w.-]+)`/g;
  const matches = [...fnBody.matchAll(weeklyWriteRe)];
  const callSiteChecks = [
    ['generateWeeklySummary() found in workers/agent-runner.js', !!fnMatch],
    ['all three writes found (summary.md, data.csv, public-summary.md)', matches.length === 3],
    ['every call site targets BACKOFFICE_REPO_NAME', matches.every((m) => m[1] === 'BACKOFFICE_REPO_NAME')],
    ['no call site targets bare REPO_NAME (the pre-2026-08-11 public-repo call)', !matches.some((m) => m[1] === 'REPO_NAME')],
    ["base uses campus/shared/weekly/ (parallels stage 1/2's campus/shared/)", /const base = 'campus\/shared\/weekly'/.test(fnBody)],
    ['no call site still targets reports/weekly/ (the old public path)', !/reports\/weekly/.test(fnBody)],
  ];
  for (const [label, ok] of callSiteChecks) {
    pass = pass && ok;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * PUBLISHING SPLIT (plan 0.4) — CALL-SITE REGRESSION CHECK, stage 4/5: side
 * plots, moved 2026-08-11. advanceSidePlots()'s single resolve-time commit —
 * config/side-plots.json's output_path templates were moved in the same
 * edit, and this checks the actual commit call, not the config alone (a
 * config-only check can't tell whether the call site still hardcodes the
 * old repo/prefix).
 * ─────────────────────────────────────────────────────────────────────────── */

console.log('\n-- Publishing-split call-site check (0.4 stage 4: side plots) --');
{
  // Normalised for the same reason as stage 3 above — CRLF checkout.
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'workers', 'agent-runner.js'), 'utf8').replace(/\r\n/g, '\n');
  const fnMatch = runnerSrc.match(/async function advanceSidePlots\([\s\S]*?\n}\n/);
  const fnBody = fnMatch ? fnMatch[0] : '';
  const sideCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'side-plots.json'), 'utf8'));
  const outputPaths = Object.values(sideCfg.side_plot_types).map((t) => t.output_path);
  const callSiteChecks = [
    ['advanceSidePlots() found in workers/agent-runner.js', !!fnMatch],
    ['resolve-time commit targets BACKOFFICE_REPO_NAME', /commitFileToRepo\(env, BACKOFFICE_REPO_NAME,/.test(fnBody)],
    ['does NOT target REPO_NAME (the pre-2026-08-11 public-repo call)', !/commitFileToRepo\(env, REPO_NAME,/.test(fnBody)],
    ['legacy reports/side-plots/ report_path values are normalized at commit time', /reports\/side-plots\//.test(fnBody) && /campus\/shared\/side-plots\//.test(fnBody)],
    ['config/side-plots.json: every output_path uses campus/shared/side-plots/', outputPaths.length > 0 && outputPaths.every((p) => p.startsWith('campus/shared/side-plots/'))],
    ['config/side-plots.json: output_dir uses campus/shared/side-plots/', sideCfg._meta.output_dir === 'campus/shared/side-plots/'],
  ];
  for (const [label, ok] of callSiteChecks) {
    pass = pass && ok;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * PUBLISHING SPLIT (plan 0.4) — CALL-SITE REGRESSION CHECK, stage 5/5:
 * promotions, moved 2026-08-11. Two call sites (finalizeScheduledDay() +
 * runWorkDayCycle()), same "both, dead code included" reasoning as stage 2.
 * ─────────────────────────────────────────────────────────────────────────── */

console.log('\n-- Publishing-split call-site check (0.4 stage 5: promotions) --');
{
  const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, 'workers', 'agent-runner.js'), 'utf8');
  const promoWriteRe = /commitFileToRepo\(\s*\n\s*env,\s*(\w+),\s*`([^`]*promotion-results-year-\$\{yearNumber\}\.md)`/g;
  const matches = [...runnerSrc.matchAll(promoWriteRe)];
  const callSiteChecks = [
    ['both promotion-results call sites found (finalizeScheduledDay + runWorkDayCycle)', matches.length === 2],
    ['every call site targets BACKOFFICE_REPO_NAME', matches.every((m) => m[1] === 'BACKOFFICE_REPO_NAME')],
    ['no call site targets bare REPO_NAME (the pre-2026-08-11 public-repo call)', !matches.some((m) => m[1] === 'REPO_NAME')],
    ['every call site uses campus/shared/promotions/', matches.every((m) => m[2].startsWith('campus/shared/promotions/'))],
  ];
  for (const [label, ok] of callSiteChecks) {
    pass = pass && ok;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  }
}

console.log(`\n${pass ? 'All scenarios matched expectations.' : 'MISMATCH — see FAIL lines above.'}`);
process.exit(pass ? 0 : 1);
