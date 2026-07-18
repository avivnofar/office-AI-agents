/**
 * Data Center — AI Agent Simulation — weekly report generator.
 *
 * Run by .github/workflows/agent-reports.yml after the workflow triggers
 * the agent-runner Worker's weekly reset cycle
 * (POST /api/agents/trigger {"type":"week_reset"}) and pulls
 * incidents/suggestions/status from the same Worker's admin API.
 *
 * Reads JSON dumps written by the workflow's curl steps:
 *   $WEEKLY_SUMMARY_FILE - { ok, type, result: { week_start, agents: [...] } } from /api/agents/trigger
 *   $INCIDENTS_FILE      - rows from /api/agents/reports?type=incident
 *   $SUGGESTIONS_FILE    - rows from /api/agents/suggestions
 *   $STATUS_FILE         - rows from /api/agents/status (for id -> name)
 *
 * Fills reports/templates/weekly-report-template.md and writes
 * reports/weekly/<year>-w<week>-weekly-summary.md.
 *
 * Path note (2026-07-18 fix): this repo was migrated out of
 * data-center/agents/ on 2026-06-19, flattening agents/config/ -> config/
 * and agents/reports/ -> reports/. This script's import, template, and
 * output paths had been left on the old agents/-prefixed layout ever
 * since — the same stale-path bug class fixed in generate-agent-cases.mjs
 * on 2026-07-08 (that script has since been retired entirely).
 *
 * Status: DRAFT (Phase 1 foundation) — per-agent irritation/happy/overtime
 * counters and suggestion totals are not yet tracked by the weekly reset
 * summary, so those columns show "—" until a future iteration adds them.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const agentsConfig = require('../../config/agents-config.json');

async function readJson(envVar, fallback) {
  const file = process.env[envVar];
  if (!file) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function nameForAgent(id, statusRows) {
  const fromStatus = statusRows.find((s) => s.id === id);
  if (fromStatus) return fromStatus.name;
  const fromConfig = agentsConfig.agents.find((a) => a.id === id);
  return fromConfig ? fromConfig.name : `Agent ${id}`;
}

const weeklyResult = await readJson('WEEKLY_SUMMARY_FILE', null);
const incidents = await readJson('INCIDENTS_FILE', []);
const suggestions = await readJson('SUGGESTIONS_FILE', []);
const status = await readJson('STATUS_FILE', []);

const summary = weeklyResult?.result;
if (!summary?.agents) {
  console.log('No weekly summary available — skipping report generation.');
  process.exit(0);
}
const now = new Date(summary.week_start || Date.now());
const week = isoWeekNumber(now);
const year = now.getUTCFullYear();

const suggestionsByAgent = new Map();
for (const s of suggestions) {
  suggestionsByAgent.set(s.agent_id, (suggestionsByAgent.get(s.agent_id) || 0) + 1);
}

const agentRows = (summary.agents || []).map((a) => {
  const name = nameForAgent(a.agentId, status);
  const filed = suggestionsByAgent.get(a.agentId) || 0;
  return `| ${name} | ${a.weeklyCases} | ${a.moodAfter} | — | — | — | ${filed} |`;
}).join('\n');

const incidentRows = incidents.length
  ? incidents.map((i) => `- **${nameForAgent(i.agent_id, status)}** (${i.severity || 'unknown'}): ${i.title} — ${i.created_at}`).join('\n')
  : '_No incidents this week._';

function suggestionRows(level) {
  const rows = suggestions.filter((s) => s.permission_level === level);
  return rows.length
    ? rows.map((s) => `- ${s.title} (${nameForAgent(s.agent_id, status)})`).join('\n')
    : '_None._';
}

// Normalize CRLF -> LF before the {{#each}} block regexes below: they anchor
// on `{{/each}}\n`, which silently no-ops on a CRLF checkout (e.g. Windows
// autocrlf working copies — found by this fix's own local dry run).
const template = (await readFile(path.join(repoRoot, 'reports', 'templates', 'weekly-report-template.md'), 'utf8')).replace(/\r\n/g, '\n');

const report = template
  .replace('{{week_start}}', now.toISOString().slice(0, 10))
  .replace(/\{\{#each agents\}\}[\s\S]*?\{\{\/each\}\}\n/, `${agentRows}\n`)
  .replace(/\{\{#each incidents\}\}[\s\S]*?\{\{\/each\}\}\n/, `${incidentRows}\n`)
  .replace(/### Root\n\n\{\{#each suggestions_root\}\}[\s\S]*?\{\{\/each\}\}\n/, `### Root\n\n${suggestionRows('root')}\n`)
  .replace(/### Sudo\n\n\{\{#each suggestions_sudo\}\}[\s\S]*?\{\{\/each\}\}\n/, `### Sudo\n\n${suggestionRows('sudo')}\n`)
  .replace(/### Standard\n\n\{\{#each suggestions_standard\}\}[\s\S]*?\{\{\/each\}\}\n/, `### Standard\n\n${suggestionRows('standard')}\n`)
  .replace('{{notes}}', '_Auto-generated by agent-reports.yml. Irritation/happy/overtime counters are not yet tracked — see AGENTS.md._');

const outDir = path.join(repoRoot, 'reports', 'weekly');
const outPath = path.join(outDir, `${year}-w${pad(week, 2)}-weekly-summary.md`);
await mkdir(outDir, { recursive: true });
await writeFile(outPath, report, 'utf8');

console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
