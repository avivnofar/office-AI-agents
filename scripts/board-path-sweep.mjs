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
let pending = null;
const flush = () => { if (pending && pending.delivered) rows.push(pending); pending = null; };
for (const line of lines) {
  const heading = /^###\s+(OB-\d+)\s*—/.exec(line);
  if (heading) { flush(); currentId = heading[1];
    pending = { id: currentId, delivered: null, state: null, retired: false }; continue; }
  if (!pending) continue;
  const st = /^-\s+\*\*State:\*\*\s*(.+)$/.exec(line);
  if (st) { pending.state = st[1].trim(); continue; }
  if (/^-\s+\*\*Notes:\*\*/.test(line) && /\bRETIRED\b/.test(line)) { pending.retired = true; continue; }
  const metric = /^-\s+\*\*Metric:\*\*\s*(.+)$/.exec(line);
  if (!metric) continue;
  const delivered = /·\s*delivered\s*=\s*(.+)$/.exec(metric[1]);
  if (!delivered) continue;
  pending.delivered = delivered[1].trim();
}
flush();

let pathShaped = 0;
let prose = 0;
const failures = [];
const acknowledged = [];
const advisory = [];

for (const row of rows) {
  const verdict = deliveredRootCheck(row.delivered);
  if (!verdict.applies) { prose += 1; continue; }
  pathShaped += 1;
  if (!verdict.ok) {
    /* ACKNOWLEDGED IS NOT FIXED, AND IS NOT A PASS EITHER.
       A retired entry keeps its bad path ON PURPOSE - the wrong record stays in
       the record and no file is created to satisfy it. So this check would fail
       on OB-163..OB-170 forever, and a run that is red every time teaches the
       reader that red means nothing (KFM-04b) - the very failure this repo's
       citedfile check documents avoiding. An entry that is BOTH NOT-READY AND
       carries RETIRED in its Notes is reported in its own section and does not
       fail the run. It is still PRINTED every time, because a defect that stops
       being visible has been deleted rather than retired.
       THE TRADE, STATED: this is keyed on prose in a Notes line, so a board edit
       could silence a live defect by writing the word. It also requires
       NOT-READY, and a board edit is a governed act - but it is a weaker
       mechanism than the root test, and that should be known, not assumed away. */
    if (row.retired && row.state === 'NOT-READY') {
      acknowledged.push({ ...row, candidate: verdict.candidate, root: verdict.root });
      continue;
    }
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
  console.log('## PASS — every LIVE path-shaped `delivered` on the board has a real root.\n');
}

console.log(`## ACKNOWLEDGED — retired, still wrong, reported every run: ${acknowledged.length}\n`);
if (acknowledged.length) {
  for (const a of acknowledged) {
    console.log(`- ${a.id} — \`${a.candidate}\` — root \`${a.root}/\` exists in no repository.`
      + ' NOT-READY and recorded as RETIRED, so it does not fail the run —'
      + ' the wrong record is kept on purpose and no file was created to satisfy it.');
  }
} else {
  console.log('_none_');
}
console.log('');

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
