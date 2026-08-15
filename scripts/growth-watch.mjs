#!/usr/bin/env node
/**
 * scripts/growth-watch.mjs — the trend nobody was reading.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `docs/KNOWN-FAILURE-MODES.md` KFM-20 asks, of every store that only grows:
 * *is there a cap, a retirement path, or **at minimum a trend someone
 * reads**?* The 2026-08-15 audit found five instances (#12, #18, #19, #20,
 * #24) and, crucially, a sixth fact about them:
 *
 *   > "A repo/campus size-hygiene mechanism has been identified as needed and
 *   > left unbuilt across at least seven consecutive sweeps — nobody, human or
 *   > agent, is currently watching any of the unbounded-growth items below
 *   > trend over time." (#12)
 *
 * Seven sweeps identified the need. This is the thing itself, and it is
 * deliberately the SMALLEST honest version: **it caps nothing and retires
 * nothing.** It measures, records the measurement with a date, and reports the
 * change since last time. Caps are policy decisions that belong to the owner;
 * a trend is a fact, and the fact is what has been missing.
 *
 * There IS already a size tool — back-office `tools/repo-size-hygiene-check/`
 * — and it is NOT this. It measures a repo's bytes on disk against a 2GB/4GB
 * threshold. None of #18/#19/#20 is a disk-space problem: a journal with no
 * cap, an insert-only database and a verify suite nothing retires from all
 * become problems at kilobyte scale, by making a context window, a query or a
 * test run unaffordable long before a disk notices. Different question,
 * different instrument. (That tool's own README records `R7 — nothing calls
 * this`, which is the same defect one layer over.)
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * **An unreachable store is recorded as unreachable, never as zero.** This
 * runs from two places with different reach: a local machine that has all
 * three repos checked out, and the public repo's weekly GitHub Actions job,
 * which holds NO credential for either private repo (checked 2026-08-15 and
 * recorded in KNOWN-FAILURE-MODES' closing section). A ledger that wrote 0 for
 * what it could not see would show back-office journals shrinking to nothing
 * every Sunday — KFM-13's exact shape, in the instrument built to watch for
 * that class of problem.
 *
 * Every row therefore carries `reachable` and, when false, `reason`; and every
 * delta is computed only against the most recent prior run that actually
 * measured THAT metric.
 *
 * Run:
 *   node scripts/growth-watch.mjs                 # measure, print, append
 *   node scripts/growth-watch.mjs --json          # machine-readable
 *   node scripts/growth-watch.mjs --no-append     # measure and print only
 *   node scripts/growth-watch.mjs --now=<ISO>     # injectable clock, for tests
 *
 * Exit codes: 0 measured · 2 could not write the ledger. It does not fail on
 * growth — there is no threshold yet to fail against, and inventing one before
 * a single trend exists would be a number with nothing behind it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
const GH_ROOT = path.resolve(REPO_ROOT, '..');

/** Where the trend lives. One JSON object per line, appended, never rewritten. */
export const LEDGER_PATH = path.join(REPO_ROOT, 'reports', 'growth', 'LEDGER.jsonl');

/**
 * The stores being watched, and the audit finding each one comes from. Declared
 * as data so adding one is an edit here rather than a new code path — and so
 * `metrics.length` is a number the report can state about its own coverage.
 */
export const WATCHED = Object.freeze([
  { key: 'verify_suite_files',   finding: '#20', unit: 'files',  what: 'scripts/verify-*.js — grows weekly, nothing has ever been retired' },
  { key: 'verify_suite_lines',   finding: '#20', unit: 'lines',  what: 'total lines across the verify suite' },
  { key: 'verify_suite_checks',  finding: '#20', unit: 'checks', what: 'total assertions across the verify suite' },
  { key: 'token_budget_lines',   finding: '#24', unit: 'lines',  what: 'TOKEN-BUDGET.md at the public repo root' },
  { key: 'reports_files',        finding: '#19', unit: 'files',  what: 'reports/ — the published archive, insert-only by design' },
  { key: 'reports_bytes',        finding: '#19', unit: 'bytes',  what: 'reports/ total size' },
  { key: 'journal_bytes_total',  finding: '#18', unit: 'bytes',  what: 'back-office campus/agents/*/journal.md — documented as having NO size cap' },
  { key: 'journal_files',        finding: '#18', unit: 'files',  what: 'how many agent journals exist' },
  { key: 'board_bytes',          finding: '#19', unit: 'bytes',  what: 'back-office BOARD.md — one file, every task the office has ever had' },
  { key: 'd1_reports_rows',      finding: '#19', unit: 'rows',   what: 'D1 reports table — insert-only; grep "DELETE FROM" repo-wide returns zero' },
  { key: 'd1_interactions_rows', finding: '#19', unit: 'rows',   what: 'D1 interactions table — insert-only' },
]);

/* ── measurement helpers ─────────────────────────────────────────────────── */

const ok = (value) => ({ reachable: true, value, reason: null });
const unreachable = (reason) => ({ reachable: false, value: null, reason });

function readTextIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Recursive file walk. Never follows symlinks — a loop would hang the watcher. */
function walkFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

/**
 * Counts assertions in a verify script. Matches the call forms this suite
 * actually uses, and is deliberately approximate: the number's JOB is to move
 * or not move, not to be exact, and an approximate number that is computed the
 * same way every week is a usable trend. Stated here so nobody later reads it
 * as a precise count of tests.
 */
export function countChecks(text) {
  if (!text) return 0;
  return (text.match(/^\s*(await\s+)?(check|checkTrue|checkFalse|checkEq)\s*\(/gm) || []).length;
}

/* ── the measurements ────────────────────────────────────────────────────── */

export function measureVerifySuite(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, 'scripts');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^verify-.*\.js$/.test(f));
  } catch (e) {
    const u = unreachable(`scripts/ unreadable: ${e.message}`);
    return { verify_suite_files: u, verify_suite_lines: u, verify_suite_checks: u };
  }
  let lines = 0; let checks = 0;
  for (const f of files) {
    const text = readTextIfPresent(path.join(dir, f));
    lines += countLines(text);
    checks += countChecks(text);
  }
  return {
    verify_suite_files: ok(files.length),
    verify_suite_lines: ok(lines),
    verify_suite_checks: ok(checks),
  };
}

export function measureRootDocs(repoRoot = REPO_ROOT) {
  const text = readTextIfPresent(path.join(repoRoot, 'TOKEN-BUDGET.md'));
  return {
    token_budget_lines: text === null ? unreachable('TOKEN-BUDGET.md not present') : ok(countLines(text)),
  };
}

export function measureReportsArchive(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, 'reports');
  if (!fs.existsSync(dir)) {
    const u = unreachable('reports/ not present');
    return { reports_files: u, reports_bytes: u };
  }
  const files = walkFiles(dir);
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(f).size; } catch { /* counted below as a file we could not size */ }
  }
  return { reports_files: ok(files.length), reports_bytes: ok(bytes) };
}

/**
 * back-office. THE ONE MOST LIKELY TO BE UNREACHABLE — it is a private repo and
 * the weekly CI job holds no credential for it, so this returns `reachable:
 * false` there every week, on purpose and visibly.
 */
export function measureBackOffice(ghRoot = GH_ROOT) {
  const campus = path.join(ghRoot, 'back-office-AI-agents', 'campus', 'agents');
  const board = path.join(ghRoot, 'back-office-AI-agents', 'campus', 'shared', 'board', 'BOARD.md');

  const out = {};
  if (!fs.existsSync(campus)) {
    const u = unreachable('back-office-AI-agents is not checked out here (private repo; the weekly CI job has no credential for it)');
    out.journal_bytes_total = u;
    out.journal_files = u;
  } else {
    let bytes = 0; let n = 0;
    for (const entry of fs.readdirSync(campus, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const j = path.join(campus, entry.name, 'journal.md');
      try { bytes += fs.statSync(j).size; n += 1; } catch { /* this agent has no journal yet */ }
    }
    out.journal_bytes_total = ok(bytes);
    out.journal_files = ok(n);
  }

  try {
    out.board_bytes = ok(fs.statSync(board).size);
  } catch {
    out.board_bytes = unreachable('BOARD.md not readable from here (private repo)');
  }
  return out;
}

/**
 * D1 row counts, via the Worker's admin API. Needs a base URL and token; with
 * neither, both rows are `reachable: false` and say which is missing. Never
 * writes anything.
 */
export async function measureD1({ base, token, fetchImpl = globalThis.fetch } = {}) {
  if (!base || !token) {
    const u = unreachable(`no ${!base ? 'AGENTS_API_BASE' : 'ADMIN_TOKEN'} — D1 row counts not read`);
    return { d1_reports_rows: u, d1_interactions_rows: u };
  }
  try {
    const res = await fetchImpl(`${base}/api/agents/trigger`, {
      method: 'POST',
      headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'growth_counts' }),
    });
    if (!res.ok) {
      const u = unreachable(`growth_counts returned HTTP ${res.status}`);
      return { d1_reports_rows: u, d1_interactions_rows: u };
    }
    const body = await res.json();
    const c = body?.result?.counts || {};
    return {
      d1_reports_rows: typeof c.reports === 'number' ? ok(c.reports) : unreachable('reports count absent from the response'),
      d1_interactions_rows: typeof c.interactions === 'number' ? ok(c.interactions) : unreachable('interactions count absent from the response'),
    };
  } catch (e) {
    const u = unreachable(`could not reach the Worker: ${String(e?.message || e).slice(0, 120)}`);
    return { d1_reports_rows: u, d1_interactions_rows: u };
  }
}

/* ── the ledger and the trend ────────────────────────────────────────────── */

export function readLedger(ledgerPath = LEDGER_PATH) {
  const text = readTextIfPresent(ledgerPath);
  if (text === null) return [];
  return text.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * The change since the last run that actually MEASURED this metric.
 *
 * "Since the last run" would be wrong and quietly so: the CI job cannot see
 * back-office, so most entries have `journal_bytes_total` unreachable, and
 * comparing against the immediately-previous entry would report "no data"
 * forever while a perfectly good measurement sat two rows up. Comparing
 * per-metric is the whole reason the ledger stores reachability per metric
 * rather than per run.
 */
export function trendFor(key, entries, current) {
  const prior = [...entries].reverse().find((e) => e?.metrics?.[key]?.reachable === true);
  if (!current?.reachable) {
    return { key, status: 'not_measured', reason: current?.reason || 'unknown', value: null, delta: null, perDay: null };
  }
  if (!prior) {
    return { key, status: 'baseline', value: current.value, delta: null, perDay: null, since: null };
  }
  const before = prior.metrics[key].value;
  const days = (Date.parse(current._at) - Date.parse(prior.at)) / 86_400_000;
  return {
    key,
    status: 'trend',
    value: current.value,
    delta: current.value - before,
    perDay: days > 0 ? Math.round(((current.value - before) / days) * 100) / 100 : null,
    since: prior.at,
    sinceValue: before,
  };
}

export async function collect({ now, base, token, fetchImpl, repoRoot = REPO_ROOT, ghRoot = GH_ROOT } = {}) {
  const at = now || new Date().toISOString();
  const metrics = {
    ...measureVerifySuite(repoRoot),
    ...measureRootDocs(repoRoot),
    ...measureReportsArchive(repoRoot),
    ...measureBackOffice(ghRoot),
    ...(await measureD1({ base, token, fetchImpl })),
  };
  return { at, metrics };
}

export function buildReport(entry, entries) {
  const trends = WATCHED.map((w) => {
    const cur = entry.metrics[w.key];
    return { ...w, ...trendFor(w.key, entries, { ...cur, _at: entry.at }) };
  });
  const measured = trends.filter((t) => t.status !== 'not_measured').length;
  return {
    at: entry.at,
    watched: WATCHED.length,
    measured,
    // KFM-03: the coverage of the measurement is stated with the measurement.
    // "9 of 11 watched stores measured" and "11 of 11" are different reports
    // and must not look the same.
    coverageNote: measured === WATCHED.length
      ? `All ${WATCHED.length} watched stores were measured on this run.`
      : `${measured} of ${WATCHED.length} watched stores were measured; the rest are listed as not_measured WITH A REASON and are NOT recorded as zero.`,
    trends,
  };
}

export function renderReport(report) {
  const lines = [
    `## Growth watch — ${report.at.slice(0, 10)}`,
    '',
    report.coverageNote,
    '',
    '| Store | Finding | Now | Change | Per day | Since |',
    '|---|---|---|---|---|---|',
  ];
  for (const t of report.trends) {
    if (t.status === 'not_measured') {
      lines.push(`| ${t.key} | ${t.finding} | — | not measured | — | ${t.reason} |`);
    } else if (t.status === 'baseline') {
      lines.push(`| ${t.key} | ${t.finding} | ${t.value} ${t.unit} | **baseline** | — | first measurement |`);
    } else {
      const sign = t.delta > 0 ? '+' : '';
      lines.push(`| ${t.key} | ${t.finding} | ${t.value} ${t.unit} | ${sign}${t.delta} | ${sign}${t.perDay} | ${t.since.slice(0, 10)} (was ${t.sinceValue}) |`);
    }
  }
  lines.push('');
  lines.push('> This watcher **caps nothing and retires nothing.** KFM-20 asks for a cap,');
  lines.push('> a retirement path, *or at minimum a trend someone reads*; a cap is a policy');
  lines.push('> decision that belongs to the owner, and the trend is the part that was');
  lines.push('> missing. A store growing is not by itself a finding — a store growing that');
  lines.push('> nobody had a number for was.');
  lines.push('');
  lines.push('> A store shown as `not measured` is **not** a store of size zero. The weekly');
  lines.push('> CI job holds no credential for either private repo, so back-office metrics');
  lines.push('> are legitimately unreadable there and are compared against the last run that');
  lines.push('> could read them, never against a fabricated zero.');
  return lines.join('\n');
}

export function appendLedger(entry, ledgerPath = LEDGER_PATH) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

export async function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const noAppend = argv.includes('--no-append');
  const nowArg = (argv.find((a) => a.startsWith('--now=')) || '').slice(6) || null;

  const entries = readLedger();
  const entry = await collect({
    now: nowArg,
    base: process.env.AGENTS_API_BASE || null,
    token: process.env.ADMIN_TOKEN || null,
  });
  const report = buildReport(entry, entries);

  if (!noAppend) {
    try { appendLedger(entry); } catch (e) {
      console.error(`growth-watch: could not append the ledger: ${e.message}`);
      process.exitCode = 2;
      return report;
    }
  }
  console.log(asJson ? JSON.stringify({ entry, report }, null, 2) : renderReport(report));
  return report;
}

const invokedDirectly = (() => {
  try {
    const p = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return p && p === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedDirectly) await main();
