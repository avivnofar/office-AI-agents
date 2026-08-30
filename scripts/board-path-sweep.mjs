#!/usr/bin/env node
/**
 * scripts/board-path-sweep.mjs — does every `delivered = <path>` on the board
 * name a place this estate has?
 *
 * ── WHY A SWEEP AS WELL AS A GATE ─────────────────────────────────────────
 *
 * `normalizeActionItems()` in `workers/meeting-decisions.js` now refuses an
 * action item whose `delivered` path has an unknown root. That gate protects
 * everything that arrives from TODAY ONWARD and, by definition, protects
 * nothing already on the board — every existing entry got there before it
 * existed. `OB-163`..`OB-170` are eight of those.
 *
 * So the gate and the sweep are the same test at two moments, and neither
 * replaces the other. They share one implementation, imported from
 * `meeting-decisions.js`, so they cannot drift into disagreeing about what a
 * valid path is — this repo has been caught by two mechanisms agreeing by
 * coincidence rather than by construction, and one predicate with two callers
 * is the version that cannot.
 *
 * ── WHAT THE EXISTING CHECK COULD NOT DO, AND THIS DOES ───────────────────
 *
 * `citedfile` (KFM-25) in `failure-mode-walk.mjs` caught exactly one of the
 * eight, for two structural reasons this sweep does not share:
 *
 *   * **It sees only `.md` names.** This sweep reads EVERY extension —
 *     `.json`, `.log`, `repo/updates_commit` with no extension at all.
 *   * **It needs `CITE_THRESHOLD = 3` citing documents.** So it could only
 *     fire after the defect had already propagated to a third file, which for
 *     `agent4.md` was the board itself. **This sweep has NO threshold**: one
 *     board entry with a bad root is one finding.
 *
 * ── EXIT CODES ────────────────────────────────────────────────────────────
 *
 *   0  every path-shaped `delivered` on the board has a real root
 *   1  at least one does not — the run FAILS, on purpose
 *   2  the board could not be read (NOT the same as "the board is clean")
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  deliveredRootCheck, deliveredPathCandidate, ESTATE_ROOTS, REPO_NAMES,
} from '../workers/meeting-decisions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GH_ROOT = path.resolve(here, '..', '..');
const REPOS = ['back-office-AI-agents', 'office-AI-agents', 'warehouse-office-AI-agents']
  .map((r) => path.join(GH_ROOT, r));
const BOARD = path.join(GH_ROOT, 'back-office-AI-agents', 'campus', 'shared', 'board', 'BOARD.md');

/**
 * ADVISORY ONLY — the parent-directory test, computed and reported, never
 * failing the run.
 *
 * It was specified alongside the root test and measured against the real board
 * before being demoted, and the measurement is why it is not blocking:
 *
 *   * it catches NOTHING the root test does not, among the eight known-bad
 *     entries; and
 *   * it produces a FALSE POSITIVE on a legitimate task —
 *     `campus/agents/05-the-it-chief/proposals/owner-channel.md`, where
 *     `proposals/` does not exist because the proposal has not been written.
 *     A new subdirectory is created BY the work, so requiring the parent to
 *     pre-exist refuses the kind of task the board is for.
 *
 * It is still COMPUTED and PRINTED, because a guard removed without its
 * evidence is a guard someone re-adds next quarter. Turning it blocking is one
 * line, and the line should be an owner's, not a session's.
 */
function parentExists(candidate) {
  let rest = candidate.replace(/^\.\//, '');
  for (const repo of REPO_NAMES) {
    if (rest.startsWith(`${repo}/`)) { rest = rest.slice(repo.length + 1); break; }
  }
  const parent = path.posix.dirname(rest.replace(/\/+$/, ''));
  if (!parent || parent === '.') return true; // a root-level artifact has no parent to check
  return REPOS.some((r) => existsSync(path.join(r, parent)));
}

if (!existsSync(BOARD)) {
  console.error(`BOARD.md not found at ${BOARD} — the board could not be READ, which is not the same as the board being clean.`);
  process.exit(2);
}

const text = readFileSync(BOARD, 'utf8');
const lines = text.split(/\r?\n/);

/* Walk the file keeping the last `### OB-NNN` heading, so a finding names the
 * task rather than a line number nobody can act on. */
let currentId = null;
const rows = [];
for (const line of lines) {
  const heading = /^###\s+(OB-\d+)\s*—/.exec(line);
  if (heading) { currentId = heading[1]; continue; }
  const metric = /^-\s+\*\*Metric:\*\*\s*(.+)$/.exec(line);
  if (!metric) continue;
  const delivered = /·\s*delivered\s*=\s*(.+)$/.exec(metric[1]);
  if (!delivered) continue;
  rows.push({ id: currentId || '(no heading seen)', delivered: delivered[1].trim() });
}

let pathShaped = 0;
let prose = 0;
const failures = [];
const advisory = [];

for (const row of rows) {
  const verdict = deliveredRootCheck(row.delivered);
  if (!verdict.applies) { prose += 1; continue; }
  pathShaped += 1;
  if (!verdict.ok) {
    failures.push({ ...row, candidate: verdict.candidate, root: verdict.root });
    continue;
  }
  if (!parentExists(verdict.candidate)) {
    advisory.push({ ...row, candidate: verdict.candidate });
  }
}

console.log('# Board path sweep\n');
console.log(`Board entries with a \`delivered =\` clause: **${rows.length}**`);
console.log(`  path-shaped (this check applies): ${pathShaped}`);
console.log(`  prose (a sentence is a valid deliverable; NOT tested): ${prose}\n`);
console.log(`Known roots (derived): ${ESTATE_ROOTS.join(' ')}\n`);

if (failures.length) {
  console.log(`## FAIL — ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} name a root that does not exist\n`);
  for (const f of failures) {
    console.log(`- **${f.id}** — \`${f.candidate}\` — top-level \`${f.root}/\` exists in no repository.`);
  }
  console.log('');
} else {
  console.log('## PASS — every path-shaped `delivered` on the board has a real root.\n');
}

console.log(`## ADVISORY (never fails the run) — parent directory absent: ${advisory.length}\n`);
if (advisory.length) {
  for (const a of advisory) {
    console.log(`- ${a.id} — \`${a.candidate}\` — the containing directory does not exist yet.`
      + ' This is NOT a defect on its own: a new subdirectory is created by the work. Reported so the demoted test stays visible.');
  }
} else {
  console.log('_none_');
}
console.log('');

process.exit(failures.length ? 1 : 0);
