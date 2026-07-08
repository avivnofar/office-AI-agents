#!/usr/bin/env node
// Manual dry-run verification (Step 7, 2026-07-08 session) for the
// push/pull permission model. Does NOT push, pull, or call any model —
// it only exercises the same decision logic workers/permission-guard.js
// applies at every GitHub write call site (commitFileToRepo()), reading
// config/project-permissions.json directly since this is a plain Node
// script (permission-guard.js's `import x from '*.json'` needs Cloudflare
// Workers/esbuild's JSON loader, which plain `node` doesn't provide
// without an import attribute Node requires but esbuild doesn't need —
// see the 2026-07-08 TOKEN-BUDGET.md entry for why these stay separate).
//
// Run: node scripts/verify-permissions.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_NAME = 'office-AI-agents';

const permissions = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'config', 'project-permissions.json'), 'utf8')
);

// Mirrors workers/permission-guard.js canPushToProject()/resolveWriteTarget().
function canPushToProject(projectKey) {
  return permissions[projectKey]?.push === true;
}
function resolveWriteTarget({ projectKey, targetRepoName, path: filePath }) {
  if (canPushToProject(projectKey)) {
    return { repoName: targetRepoName, path: filePath, redirected: false };
  }
  return {
    repoName: REPO_NAME,
    path: `agent-output/${projectKey}/${filePath}`,
    redirected: true,
    reason: `push:false for project "${projectKey}"`,
  };
}

// Mirrors workers/permission-guard.js resolveIssueTarget() (2026-07-08
// session: extended the guard to cover Issue creation, not just file
// commits — see TOKEN-BUDGET.md).
function resolveIssueTarget({ projectKey, targetRepoName, title }) {
  if (canPushToProject(projectKey)) {
    return { repoName: targetRepoName, title, redirected: false };
  }
  return {
    repoName: REPO_NAME,
    title: `[redirected from ${projectKey}] ${title}`,
    redirected: true,
    reason: `push:false for project "${projectKey}"`,
  };
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
