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
import { resolveWriteTarget as resolveWriteTargetReal, resolveIssueTarget as resolveIssueTargetReal } from '../workers/permission-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_NAME = 'office-AI-agents';

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
  { projectKey: 'data-center', targetRepoName: 'data-center-archive', path: 'guides/ssh-troubleshoot.md', expectRedirected: true },
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

console.log(`\n${pass ? 'All scenarios matched expectations.' : 'MISMATCH — see FAIL lines above.'}`);
process.exit(pass ? 0 : 1);
