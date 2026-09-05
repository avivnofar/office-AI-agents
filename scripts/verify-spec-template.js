#!/usr/bin/env node
/**
 * scripts/verify-spec-template.js — RUN BOTH DOWNSTREAM READERS AGAINST EVERY
 * WAREHOUSE SPEC, AND PRINT THE TABLE.
 *
 * Written 2026-09-05 (session 43, Item A4).
 *
 * ── THE DEFECT THIS EXISTS TO CATCH, MEASURED BEFORE IT WAS FIXED ─────────
 *
 * A spec is read by two programs that live in two different repositories and
 * were written against two different templates:
 *
 *   dispatch.js readPhases()                 needs `## Phases`
 *     (back-office-AI-agents/campus/agents/10-the-architect/automation/)
 *   office-context.js readSpecTargetPath()   needs `## Where it lives`
 *     (this repo, workers/)
 *
 * Counted 2026-09-05 across all five warehouse specs: THREE carried the first,
 * TWO carried the second, and NONE carried both. Neither reader could see that,
 * because each only ever asked its own question. A paired task could therefore
 * be dispatched and dead-end at the build, or be buildable and undispatchable,
 * and nothing in the estate would report either — the failure was invisible to
 * every part of it except a person reading five files side by side.
 *
 * So this verifier asks BOTH questions of EVERY spec and prints a 5x2 table.
 * The table is the deliverable: a count is a claim, a table is evidence.
 *
 * ── WHY IT REIMPLEMENTS readPhases() RATHER THAN IMPORTING IT ─────────────
 *
 * `dispatch.js` is in a different repository and this repo cannot import it —
 * the same wall `workers/spec-builder.js` `PHASE_LINE_RE` hits, and it is
 * handled the same way: the regex is restated character for character and
 * `scripts/verify-spec-builder.js` asserts the two agree against shared
 * fixtures. This file goes one step further and asserts, per spec, that the
 * restated grammar and `spec-builder.js`'s exported one give the SAME phase
 * count — so a drift between them fails here, on real files, not only on
 * fixtures.
 *
 * ── AND WHY A MISSING WAREHOUSE IS REPORTED, NEVER SWALLOWED ──────────────
 *
 * The warehouse is a third private repo and is not checked out everywhere this
 * script might run. An unreachable warehouse prints an UNREACHABLE banner and
 * exits 0, because "this runner cannot see the specs" is a different fact from
 * "the specs are fine" and must not be able to masquerade as it. It exits 1
 * only when it actually read a spec and that spec failed a reader.
 *
 * Reads only. No network, no D1, no KV, no model call.
 *
 *   node scripts/verify-spec-template.js
 *   node scripts/verify-spec-template.js --tasks-dir <path-to>/tasks
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSpecTargetPath } from '../workers/office-context.js';
import { PHASE_LINE_RE } from '../workers/spec-builder.js';

const here = dirname(fileURLToPath(import.meta.url));
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const tasksDir = argOf('tasks-dir')
  || join(here, '..', '..', 'warehouse-office-AI-agents', 'tasks');

/* `dispatch.js readPhases()`, restated. Do not "tidy" this — see the header. */
function readPhases(txt) {
  const lines = String(txt).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Phases\s*$/i.test(l.trim()));
  if (start === -1) return null; // null = NO SECTION, [] = section with nothing readable
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const m = lines[i].match(/^\s*\d+\.\s*\[(\w[\w-]*)\]\s*(.+?)\s*$/);
    if (m) out.push({ id: m[1], title: m[2] });
  }
  return out;
}

if (!existsSync(tasksDir)) {
  console.log('\nspec-template: WAREHOUSE UNREACHABLE\n');
  console.log(`  ${tasksDir} does not exist on this machine.`);
  console.log('  This is NOT "the specs are fine" — nothing was read and nothing was checked.');
  console.log('  Pass --tasks-dir <path> to point at a warehouse checkout.\n');
  process.exit(0);
}

const slugs = readdirSync(tasksDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(tasksDir, d.name, 'SPEC.md')))
  .map((d) => d.name)
  .sort();

if (!slugs.length) {
  console.log(`\nspec-template: ${tasksDir} holds no task directory with a SPEC.md — nothing checked.\n`);
  process.exit(0);
}

const rows = [];
const fails = [];
for (const slug of slugs) {
  const txt = readFileSync(join(tasksDir, slug, 'SPEC.md'), 'utf8');

  const phases = readPhases(txt);
  const phasesOk = Array.isArray(phases) && phases.length > 0;
  const phasesNote = phases === null ? 'no "## Phases" section'
    : phases.length === 0 ? 'section present, 0 lines parse — dispatch reads this as no_phases'
      : `${phases.length} phase(s): ${phases.map((p) => p.id).join(', ')}`;

  const target = readSpecTargetPath(txt, slug);
  const targetNote = target.ok
    ? (target.targetPaths ? `${target.targetPaths.length} path(s): ${target.targetPaths.join(', ')}` : target.targetPath)
    : target.reason;

  rows.push({ slug, phasesOk, phasesNote, targetOk: target.ok, targetNote });

  if (!phasesOk) fails.push(`${slug}: dispatch.js readPhases() — ${phasesNote}`);
  if (!target.ok) fails.push(`${slug}: office-context.js readSpecTargetPath() — ${target.reason}`);

  /* The two grammars must agree on this real file, not only on fixtures. */
  if (Array.isArray(phases)) {
    const mine = String(txt).split(/\r?\n/).filter((l) => PHASE_LINE_RE.test(l)).length;
    const section = phases.length;
    if (mine < section) {
      fails.push(`${slug}: spec-builder.js PHASE_LINE_RE matched ${mine} lines where dispatch.js read ${section} `
        + '— the two grammars have drifted and a spec will pass one reader and fail the other');
    }
  }
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const w = Math.max(24, ...rows.map((r) => r.slug.length));
console.log(`\nBOTH READERS, EVERY SPEC — ${tasksDir}\n`);
console.log(`  ${pad('spec', w)}  ## Phases            ## Where it lives`);
console.log(`  ${'-'.repeat(w)}  -------------------  -----------------`);
for (const r of rows) {
  console.log(`  ${pad(r.slug, w)}  ${pad(r.phasesOk ? 'PASS' : 'FAIL', 19)}  ${r.targetOk ? 'PASS' : 'FAIL'}`);
}
console.log('');
for (const r of rows) {
  console.log(`  ${r.slug}`);
  console.log(`      phases : ${r.phasesNote}`);
  console.log(`      target : ${r.targetNote}`);
}

const cells = rows.length * 2;
const passed = rows.reduce((n, r) => n + (r.phasesOk ? 1 : 0) + (r.targetOk ? 1 : 0), 0);
console.log(`\nspec-template: ${passed}/${cells} cells pass across ${rows.length} spec(s)`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  x ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  every spec carries both sections, and both readers can read it.\n');
process.exit(0);
