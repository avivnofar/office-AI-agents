#!/usr/bin/env node
// Manual dry-run verification (Step 7, 2026-07-08 session) for the
// cross-project chore rotation + Notebook-X model-role override. No
// network calls, no model calls — mirrors workers/chore-runner.js
// getRotatedProject() and workers/model-router.js selectModelForChoreTask()
// (same JSON-import-under-plain-node constraint as scripts/verify-permissions.js
// — these are small pure functions duplicated here on purpose, not drifted).
//
// Run: node scripts/verify-chore-rotation.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const choreSchedule = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'chore-schedule.json'), 'utf8'));
const tokenEconomy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'token-economy.json'), 'utf8'));

function getRotatedProject(date) {
  const projects = choreSchedule.project_rotation.projects;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000);
  return projects[dayOfYear % projects.length];
}

function selectModelForChoreTask({ projectKey, taskType, requiresHighQuality = false, overBudget = false }) {
  if (projectKey === 'notebook-x') {
    if (taskType === 'easy') return { model: 'groq', reason: 'Notebook-X override: easy sub-task.' };
    if (requiresHighQuality && !overBudget) return { model: 'claude', reason: 'Notebook-X override: quality demands Claude (shared $4.50/mo cap).' };
    if (requiresHighQuality && overBudget) return { model: 'gemini', reason: 'Notebook-X override wanted Claude but cap exhausted — Gemini fallback.' };
    return { model: 'gemini', reason: 'Notebook-X override: Gemini is default writer.' };
  }
  if (taskType === 'easy') return { model: 'groq', reason: 'General economy: Groq handles easy work.' };
  if ((taskType === 'code' || taskType === 'approval') && !overBudget) return { model: 'claude', reason: 'General economy: Claude scoped to code/approvals.' };
  if ((taskType === 'code' || taskType === 'approval') && overBudget) return { model: 'gemini', reason: 'General economy wanted Claude but cap exhausted — Gemini fallback.' };
  return { model: 'gemini', reason: 'General economy: Gemini is expanded-role default writer.' };
}

console.log('Dry-run only — no network/model calls made.\n');

console.log('-- Project rotation (7-day sample) --');
const base = new Date('2026-07-08T00:00:00Z');
for (let i = 0; i < 7; i++) {
  const d = new Date(base.getTime() + i * 86_400_000);
  console.log(`  ${d.toISOString().slice(0, 10)}: ${getRotatedProject(d)}`);
}

console.log('\n-- Notebook-X model-role override --');
const nbScenarios = [
  { projectKey: 'notebook-x', taskType: 'easy', expect: 'groq' },
  { projectKey: 'notebook-x', taskType: 'content', expect: 'gemini' },
  { projectKey: 'notebook-x', taskType: 'content', requiresHighQuality: true, expect: 'claude' },
  { projectKey: 'notebook-x', taskType: 'content', requiresHighQuality: true, overBudget: true, expect: 'gemini' },
];
let pass = true;
for (const s of nbScenarios) {
  const { model, reason } = selectModelForChoreTask(s);
  const ok = model === s.expect;
  pass = pass && ok;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] taskType=${s.taskType}${s.requiresHighQuality ? ' requiresHighQuality' : ''}${s.overBudget ? ' overBudget' : ''} -> ${model} (${reason})`);
}

console.log('\n-- General economy (non-Notebook-X) --');
const genScenarios = [
  { projectKey: 'data-center', taskType: 'easy', expect: 'groq' },
  { projectKey: 'data-center', taskType: 'content', expect: 'gemini' },
  { projectKey: 'data-center', taskType: 'code', expect: 'claude' },
  { projectKey: 'archive-alpha', taskType: 'approval', overBudget: true, expect: 'gemini' },
];
for (const s of genScenarios) {
  const { model, reason } = selectModelForChoreTask(s);
  const ok = model === s.expect;
  pass = pass && ok;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${s.projectKey} taskType=${s.taskType}${s.overBudget ? ' overBudget' : ''} -> ${model} (${reason})`);
}

console.log(`\nClaude chore-automation cap: $${tokenEconomy.chore_automation.claude_budget_usd_per_month}/mo (separate from the office-simulation's ${tokenEconomy.claude_daily_cap}-calls/day cap).`);
console.log(`\n${pass ? 'All scenarios matched expectations.' : 'MISMATCH — see FAIL lines above.'}`);
process.exit(pass ? 0 : 1);
