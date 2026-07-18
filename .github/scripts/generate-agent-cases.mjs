/**
 * Data Center — AI Agent Simulation — weekly question batch generator.
 *
 * Run by .github/workflows/agent-cases.yml every Monday. Generates a
 * 200-300 question batch (2x in inspection mode) as a static preview
 * artifact and writes it to database/cases-<year>-w<week>.json. Not
 * consumed by the live daily flow (workers/agent-runner.js generates its
 * own day-by-day via qa-engine.js/computeDailyQuestionVolume()) — this is
 * an informational weekly snapshot only.
 *
 * Status: DRAFT (Phase 1 foundation).
 *
 * Path note (2026-07-08 fix): this repo was migrated out of
 * data-center/agents/ on 2026-06-19 (see CLAUDE.md "What this repo is"),
 * flattening agents/workers/ -> workers/, agents/config/ -> config/,
 * agents/database/ -> database/. This script's imports/output path had
 * been left pointing at the old agents/-prefixed layout ever since,
 * crashing every scheduled run with ERR_MODULE_NOT_FOUND — see
 * TOKEN-BUDGET.md's 2026-07-08 sessions for the diagnosis and this fix.
 *
 * 2026-07-18 Q&A-engine rebuild: workers/case-generator.js (Netvill-CRM
 * CASE_POOL) is deleted — this script now draws from the new
 * workers/qa-engine.js/qa-topics.js pool instead. Cases previously carried
 * client_name/severity/etc; questions now carry project/kb_slug (see
 * database/schema.sql's 2026-07-18 migration note).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateAssignedDailyBatch } from '../../workers/qa-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const simulationConfig = require('../../config/simulation-config.json');

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

const now = new Date();
const week = isoWeekNumber(now);
const year = now.getFullYear();

const inspection = !!simulationConfig.SIMULATION?.inspection_mode;
const min = 200;
const max = 300;
const baseCount = min + Math.floor(Math.random() * (max - min + 1));
const count = inspection ? baseCount * 2 : baseCount;

const cases = generateAssignedDailyBatch(1, { maxTotalQuestions: count, weekNumber: week, year });

const outDir = path.join(repoRoot, 'database');
const outPath = path.join(outDir, `cases-${year}-w${pad(week, 2)}.json`);

await mkdir(outDir, { recursive: true });
await writeFile(outPath, JSON.stringify({ week_start: now.toISOString(), year, week, inspection, count: cases.length, cases }, null, 2) + '\n', 'utf8');

console.log(`Generated ${cases.length} cases for ${year}-W${pad(week, 2)} -> ${path.relative(repoRoot, outPath)}`);
