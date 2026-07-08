#!/usr/bin/env node
// Cross-project health check (DESIGN, 2026-07-08) — reads
// config/health-check-manifest.json and verifies each automation's actual
// output landed (a file's last commit, a JSON endpoint's real field, a
// log line's real status) rather than trusting any workflow's own exit
// code. Motivated by this month's repeated pattern: a workflow can be
// green while its real step was skipped (Weekly Report's missing
// AGENTS_API_BASE), crashed before writing anything (Weekly Case Batch's
// stale import), or ran correctly but failed to report (Notebook-X's
// missing issues:write).
//
// NOT wired into any schedule — run manually:
//   node scripts/cross-project-health-check.mjs
// (or via .github/workflows/cross-project-health-check.yml's
// workflow_dispatch, which exists but has no `schedule:` trigger).
//
// Shells out to `gh` (already authenticated in this environment / on any
// GitHub Actions runner) rather than hand-rolling REST auth. Local runs
// use the operator's own `gh auth` session; a future live run against
// private repos (Notebook-X, local-archive-galil-elion) needs a
// read-scoped GH_TOKEN for those repos — see the manifest's auth_note.
// This script never writes anywhere — read-only checks only.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'config', 'health-check-manifest.json'), 'utf8')
);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function renderTemplate(template, now) {
  const isoYear = now.getUTCFullYear();
  const isoWeek = isoWeekNumber(now);
  return template
    .replaceAll('{{isoYear}}', String(isoYear))
    .replaceAll('{{isoWeekPadded}}', String(isoWeek).padStart(2, '0'))
    .replaceAll('{{today}}', now.toISOString().slice(0, 10));
}

/** Resolves a gatingWorkflow's enabled/disabled state. Returns null (no gate) if check has none. */
function resolveGate(gatingWorkflow) {
  if (!gatingWorkflow) return null;
  try {
    const out = gh(['api', `repos/${gatingWorkflow.repo}/actions/workflows`, '-q', '.workflows[] | "\\(.name)|\\(.state)"']);
    const line = out.split('\n').find((l) => l.startsWith(`${gatingWorkflow.name}|`));
    if (!line) return { enabled: null, reason: `workflow "${gatingWorkflow.name}" not found in ${gatingWorkflow.repo}` };
    const state = line.split('|')[1];
    return { enabled: state === 'active', state };
  } catch (err) {
    return { enabled: null, reason: `could not query ${gatingWorkflow.repo} workflows (${err.message.split('\n')[0]})` };
  }
}

function ageHours(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 3_600_000;
}

/** Last commit touching `path` in `repo`, or null if the path has never been committed. */
function lastCommitForPath(repo, filePath) {
  try {
    const out = gh(['api', `repos/${repo}/commits`, '-X', 'GET', '-f', `path=${filePath}`, '-f', 'per_page=1', '-q', '.[0].commit.committer.date']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

function fileExistsAtHead(repo, filePath) {
  try {
    gh(['api', `repos/${repo}/contents/${filePath}`, '-q', '.sha']);
    return true;
  } catch {
    return false;
  }
}

function runCheck(check, now) {
  const gate = resolveGate(check.gatingWorkflow);
  if (gate && gate.enabled === false) {
    return { id: check.id, status: 'SKIPPED', detail: `gating workflow "${check.gatingWorkflow.name}" is ${gate.state} — not evaluated` };
  }
  if (gate && gate.enabled === null) {
    return { id: check.id, status: 'UNKNOWN', detail: gate.reason };
  }

  switch (check.type) {
    case 'github_file_freshness': {
      const filePath = renderTemplate(check.pathTemplate, now);
      const exists = fileExistsAtHead(check.repo, filePath);
      if (!exists) return { id: check.id, status: 'FAIL', detail: `${check.repo}/${filePath} does not exist` };
      const commitDate = lastCommitForPath(check.repo, filePath);
      if (!commitDate) return { id: check.id, status: 'FAIL', detail: `${filePath} exists but has no commit history (unexpected)` };
      const age = ageHours(commitDate);
      if (age > check.maxAgeHours) {
        return { id: check.id, status: 'FAIL', detail: `${filePath} last touched ${age.toFixed(1)}h ago (max ${check.maxAgeHours}h) — commit ${commitDate}` };
      }
      return { id: check.id, status: 'PASS', detail: `${filePath} last touched ${age.toFixed(1)}h ago (commit ${commitDate})` };
    }

    case 'token_budget_log_line': {
      const content = gh(['api', `repos/${check.repo}/contents/${check.path}`, '-q', '.content']);
      const text = Buffer.from(content, 'base64').toString('utf8');
      const lines = text.split('\n').filter((l) => l.startsWith(check.linePrefix) && l.includes(check.lineMarker));
      if (!lines.length) return { id: check.id, status: 'FAIL', detail: `no "${check.lineMarker}" line found in ${check.path}` };
      const last = lines[lines.length - 1];
      const dateMatch = last.match(/\[([^\]]+)\]/);
      if (!dateMatch) return { id: check.id, status: 'FAIL', detail: `could not parse a date out of the last log line: "${last}"` };
      const age = ageHours(dateMatch[1].replace(' UTC', 'Z').replace(' ', 'T'));
      const statusOk = last.includes(check.requireStatus);
      if (age > check.maxAgeHours) {
        return { id: check.id, status: 'FAIL', detail: `last "${check.lineMarker}" line is ${age.toFixed(1)}h old (max ${check.maxAgeHours}h): "${last.trim()}"` };
      }
      if (!statusOk) {
        return { id: check.id, status: 'FAIL', detail: `last "${check.lineMarker}" line doesn't say "${check.requireStatus}": "${last.trim()}"` };
      }
      return { id: check.id, status: 'PASS', detail: `"${last.trim()}"` };
    }

    case 'http_endpoint_check': {
      let json;
      try {
        const out = execFileSync('curl', ['-sS', check.url], { encoding: 'utf8' });
        json = JSON.parse(out);
      } catch (err) {
        return { id: check.id, status: 'FAIL', detail: `could not reach/parse ${check.url}: ${err.message.split('\n')[0]}` };
      }
      const failures = [];
      for (const a of check.assertions) {
        const actual = json[a.jsonPath];
        const ok = a.op === '>=' ? actual >= a.value : a.op === '==' ? actual === a.value : false;
        if (!ok) failures.push(`${a.jsonPath} ${a.op} ${a.value} (actual: ${JSON.stringify(actual)})`);
      }
      if (failures.length) return { id: check.id, status: 'FAIL', detail: failures.join('; ') };
      return { id: check.id, status: 'PASS', detail: `response: ${JSON.stringify(json)}` };
    }

    case 'workflow_run_recency': {
      try {
        const out = gh(['run', 'list', '--repo', check.repo, '--workflow', check.workflowName, '--limit', '1', '--json', 'conclusion,createdAt']);
        const runs = JSON.parse(out);
        if (!runs.length) return { id: check.id, status: 'FAIL', detail: 'no runs found at all' };
        const [run] = runs;
        const age = ageHours(run.createdAt);
        if (age > check.maxAgeHours) return { id: check.id, status: 'FAIL', detail: `last run ${age.toFixed(1)}h ago (max ${check.maxAgeHours}h), conclusion=${run.conclusion}` };
        if (run.conclusion !== 'success') return { id: check.id, status: 'FAIL', detail: `last run ${age.toFixed(1)}h ago but conclusion=${run.conclusion}` };
        return { id: check.id, status: 'PASS', detail: `last run ${age.toFixed(1)}h ago, conclusion=success (weakest check type — run recency only, not real output; see manifest note)` };
      } catch (err) {
        return { id: check.id, status: 'UNKNOWN', detail: `could not list runs: ${err.message.split('\n')[0]}` };
      }
    }

    default:
      return { id: check.id, status: 'UNKNOWN', detail: `unrecognized check type "${check.type}"` };
  }
}

const now = new Date();
console.log(`Cross-project health check — dry run, ${now.toISOString()}\n(read-only: no files written, no issues filed, no workflows triggered)\n`);

let anyFail = false;
for (const check of manifest.checks) {
  const result = runCheck(check, now);
  if (result.status === 'FAIL') anyFail = true;
  console.log(`[${result.status}] ${check.id} — ${check.label}`);
  console.log(`       ${result.detail}\n`);
}

console.log(`Excluded from this manifest: ${Object.keys(manifest.not_included).join(', ')}`);
console.log(anyFail ? '\nAt least one real FAIL (not SKIPPED/UNKNOWN) — would file a digest issue if wired live.' : '\nNo FAILs.');
