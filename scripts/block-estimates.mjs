#!/usr/bin/env node
/**
 * SESSION 34, ITEM A — the acceptance test for the derived estimates.
 *
 * Prints, for every scheduled block: its OLD constant, what it has actually
 * measured in `block_admissions`, and the estimate the derivation now gives
 * it. This is the table that answers "did the number move, and toward what".
 *
 * ── WHY IT TAKES A FILE AND NOT A DATABASE ─────────────────────────────────
 *
 * Every verifier in `scripts/` proves it made no network call rather than
 * claiming it. This one keeps that property: it reads an EXPORT of
 * `block_admissions`, so it can be re-run, diffed and checked into a report
 * without a live credential, and the same export can be replayed months later
 * against a changed derivation to see what the change would have done.
 *
 * Refresh the export with:
 *
 *   npx wrangler d1 execute data-center-db --remote --json --command \
 *     "SELECT block, decision, group_concat(actual) vals FROM block_admissions
 *       WHERE actual IS NOT NULL AND created_at >= datetime('now','-30 days')
 *       GROUP BY block, decision"
 *
 * and write the rows into `scripts/data/block-admissions-export.json` in the
 * shape `[{block, decision, vals: "1,2,3"}]`.
 *
 *   node scripts/block-estimates.mjs [path-to-export.json]
 *
 * A non-zero exit means a derived estimate exceeds the usable budget — which
 * is a real finding about that block, not a failure of this script. It is an
 * exit code so it cannot be read past.
 */

import { readFileSync } from 'node:fs';
import {
  deriveBlockEstimates, BLOCK_COST, USABLE_MAX, ESTIMATE_MARGIN,
  ESTIMATE_PERCENTILE, MIN_MEASURED_RUNS, SUBREQUEST_CEILING,
  TICK_TAIL_RESERVE, TICK_TAIL_RESERVE_NO_CASES, CASE_FLOOR_FRACTION,
} from '../workers/subrequest-budget.js';

const path = process.argv[2] || new URL('./data/block-admissions-export.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let raw;
try {
  raw = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`Could not read the admissions export at ${path}: ${err.message}`);
  console.error('See this file\'s header for the query that produces it.');
  process.exit(2);
}

/* Expand the grouped export back into one row per admission. */
const rows = [];
for (const g of raw) {
  for (const v of String(g.vals).split(',')) {
    const actual = Number(v);
    if (Number.isFinite(actual)) rows.push({ block: g.block, decision: g.decision, actual });
  }
}

const { estimates, detail, unmeasured } = deriveBlockEstimates(rows);

const usableNoCases = SUBREQUEST_CEILING - TICK_TAIL_RESERVE_NO_CASES;
const usableWithCases = SUBREQUEST_CEILING - TICK_TAIL_RESERVE;
const otherCeilingWithCases = usableWithCases - Math.round(usableWithCases * CASE_FLOOR_FRACTION);

console.log('');
console.log('BLOCK COST ESTIMATES — derived vs declared');
console.log('==========================================');
console.log(`source          : ${path}`);
console.log(`admissions      : ${rows.length} rows`);
console.log(`statistic       : p${Math.round(ESTIMATE_PERCENTILE * 100)} nearest-rank + ${ESTIMATE_MARGIN}, capped at usable ${USABLE_MAX}`);
console.log(`derived when    : >= ${MIN_MEASURED_RUNS} runs with non-zero measured spend`);
console.log(`usable budget   : ${usableNoCases} on a tick with no cases due, ${otherCeilingWithCases} for non-case work when cases are`);
console.log('');

const pad = (v, n) => String(v).padEnd(n);
const rpad = (v, n) => String(v).padStart(n);

console.log(`${pad('block', 20)}${rpad('OLD', 6)}${rpad('runs', 6)}${rpad('worst', 8)}${rpad('p90', 8)}${rpad('NEW', 6)}  note`);
console.log('-'.repeat(84));

let overCeiling = 0;
for (const name of Object.keys(detail).sort()) {
  const d = detail[name];
  const isNew = d.source === 'measured';
  let note = '';
  if (!isNew) {
    note = 'UNMEASURED — kept its constant';
  } else if (d.estimate > USABLE_MAX) {
    note = `!! exceeds usable ${USABLE_MAX} — the CEILING is the problem, not the estimate`;
    overCeiling += 1;
  } else if (d.estimate < d.constant) {
    note = `${(d.constant / Math.max(1, d.estimate)).toFixed(1)}x over-estimated`;
  } else if (d.estimate > d.constant) {
    note = `was ${(d.constant / d.estimate * 100).toFixed(0)}% of what it really costs — UNDER-estimated`;
  } else {
    note = 'unchanged';
  }
  console.log(
    pad(name, 20) + rpad(d.constant, 6) + rpad(d.runs, 6) +
    rpad(d.max ?? '-', 8) + rpad(d.p90 ?? '-', 8) + rpad(d.estimate, 6) + '  ' + note
  );
}

console.log('');
console.log(`derived from measurement : ${Object.keys(estimates).length}`);
console.log(`left on their constants  : ${unmeasured.length}  (${unmeasured.join(', ') || 'none'})`);

if (overCeiling) {
  console.log('');
  console.log(`FINDING: ${overCeiling} block(s) cost more than the whole usable budget on real`);
  console.log('measurement. Correcting the estimate cannot fix that — the block does not fit');
  console.log('in one Cloudflare invocation and needs splitting, not a bigger number. It runs');
  console.log("as 'oversize' meanwhile, which is deliberate: see admitBlock().");
}
process.exit(overCeiling ? 1 : 0);
