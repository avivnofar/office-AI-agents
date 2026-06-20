/**
 * Data Center — AI Agent Simulation — weekly case batch generator.
 *
 * Run by .github/workflows/agent-cases.yml every Monday. Generates a
 * 200-300 case batch (2x in inspection mode) for the upcoming simulated
 * work week and writes it to agents/database/cases-<year>-w<week>.json.
 *
 * Status: DRAFT (Phase 1 foundation).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateCaseBatch } from '../../agents/workers/case-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const simulationConfig = require('../../agents/config/simulation-config.json');

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

const cases = generateCaseBatch(count, { weekNumber: week, year });

const outDir = path.join(repoRoot, 'agents', 'database');
const outPath = path.join(outDir, `cases-${year}-w${pad(week, 2)}.json`);

await mkdir(outDir, { recursive: true });
await writeFile(outPath, JSON.stringify({ week_start: now.toISOString(), year, week, inspection, count: cases.length, cases }, null, 2) + '\n', 'utf8');

console.log(`Generated ${cases.length} cases for ${year}-W${pad(week, 2)} -> ${path.relative(repoRoot, outPath)}`);
