#!/usr/bin/env node
/**
 * scripts/verify-security-scan.js — proves the A10 pre-publication scan, and
 * MEASURES what it would cost against the corpus this repo has already
 * published.
 *
 * Run: node scripts/verify-security-scan.js
 *      node scripts/verify-security-scan.js --corpus     (full per-file listing)
 *
 * ── WHY THE MEASUREMENT IS THE POINT ─────────────────────────────────────
 *
 * An automatic refusal wired into a live cron is a real hazard: a term list
 * tuned by taste stops the daily report, and "no report today" is
 * indistinguishable from "quiet day" to everything downstream. So this script
 * does not merely assert that the scanner catches what it should. It runs the
 * scanner over EVERY already-published file in scope and prints the hits.
 *
 * A hit on already-published content is NOT automatically a bug in the list.
 * A10 says security findings are never published — so a hit is either a term
 * that is too broad, or content that should never have gone out. The script
 * reports; the reader decides. It does not fail the run on corpus hits, because
 * failing would create pressure to narrow the list until the number reached
 * zero, which is optimising the measurement instead of the rule.
 *
 * NO NETWORK. Like its sibling verifiers, it replaces globalThis.fetch with a
 * tripwire, so "made no calls" is proven rather than claimed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.fetch = () => { throw new Error('verify-security-scan.js made a network call — it must not'); };

const scan = await import('../workers/security-scan.js');

let pass = 0;
let fail = 0;
const failures = [];

function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`); }
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}

/* ═══════════════ §1 the vocabulary refuses findings ══════════════════════ */
section('§1 finding-shaped content is REFUSED');

const REFUSED_SAMPLES = [
  ['an unauthenticated endpoint reaches eight switches', 'unauthenticated'],
  ['the review found a security flaw in the guard', 'security-finding'],
  ['CVE-2024-3094 affects the build path', 'cve'],
  ['this is vulnerable to a replay', 'vulnerability'],
  ['an attacker could read the board', 'attacker'],
  ['the token was exposed in a log line', 'leaked-secret'],
  ['a hardcoded token in the meeting engine', 'hardcoded-secret'],
  ['privilege escalation from standard to sudo', 'privilege-escalation'],
  ['a prompt injection in the board text', 'injection'],
  ['it bypasses the permission guard', 'bypass'],
];
for (const [sample, expectedId] of REFUSED_SAMPLES) {
  const r = scan.scanOutbound(sample, { path: 'reports/daily/day-999-summary.md' });
  check(`REFUSED: "${sample.slice(0, 46)}"`, r.clean === false && r.hits.some((h) => h.id === expectedId),
    JSON.stringify(r.hits.map((h) => h.id)));
}

/* ═══════════ §2 the role and the process still publish ═══════════════════ */
section('§2 A10 permits the ROLE and the PROCESS — these must PASS');

const PERMITTED_SAMPLES = [
  'The Cyber Expert performed a configuration review today.',
  'The office runs a security review before every deliverable reaches the CEO.',
  'Agent 13 (The Cyber Expert, Security Specialist) attended the weekly meeting.',
  'The QA rejected the deliverable and the gaps went to a meeting.',
  'Today the office asked 14 cybersecurity questions and evaluated the answers.',
  'The firewall guide was approved and published to guides/firewall/.',
];
for (const sample of PERMITTED_SAMPLES) {
  const r = scan.scanOutbound(sample, { path: 'reports/daily/day-999-summary.md' });
  check(`PERMITTED: "${sample.slice(0, 52)}"`, r.clean === true, JSON.stringify(r.hits.map((h) => `${h.id}:${h.excerpt}`)));
}

/* ═══════════════ §3 scope is a prefix list, and NOT-SCANNED ══════════════ */
section('§3 scope — out of scope is reported as NOT SCANNED, never as clean');

check('reports/ is in scope', scan.isScannedPath('reports/daily/day-046-summary.md'));
check('guides/ is OUT of scope (educational security content, gated elsewhere)',
  !scan.isScannedPath('guides/cybersecurity/hardening.md'));
check('workers/ is out of scope (agents cannot write there at all)',
  !scan.isScannedPath('workers/agent-runner.js'));

const oos = scan.scanOutbound('an attacker exploits an unauthenticated endpoint', { path: 'guides/cybersecurity/x.md' });
check('an out-of-scope path returns scanned:false, not a clean verdict', oos.scanned === false && oos.hits.length === 0);
const ins = scan.scanOutbound('nothing sensitive here', { path: 'reports/weekly/week-99-report.md' });
check('an in-scope clean file returns scanned:true AND clean:true', ins.scanned === true && ins.clean === true);

check('with no path given, the text is scanned (the caller opted in explicitly)',
  scan.scanOutbound('an attacker').clean === false);

/* ═══════════════ §4 the refusal line names the rule ══════════════════════ */
section('§4 the refusal is legible and does not reprint the sentence');

const dirty = scan.scanOutbound('the review found a security flaw and an attacker could reach it', { path: 'reports/x.md' });
const line = scan.renderScanRefusal('reports/x.md', dirty.hits);
check('the refusal names the path', line.includes('reports/x.md'));
check('the refusal states the rule, not just the match', /never published/.test(line));
check('the refusal names where the content belongs', /back-office-AI-agents/.test(line));
check('excerpts are bounded, not whole lines', dirty.hits.every((h) => h.excerpt.length <= 120));

/* ═══════════════ §5 wiring — the scan is ON the write path ═══════════════ */
section('§5 wiring — repo-write.js is the chokepoint and it calls the scan');

const repoWriteSrc = fs.readFileSync(path.join(ROOT, 'workers/repo-write.js'), 'utf8');
check('repo-write.js imports the scanner', /from '\.\/security-scan\.js'/.test(repoWriteSrc));
check('commitFileToRepo REFUSES rather than warns (A10: automatic, never judgment)',
  /security_scan_refused/.test(repoWriteSrc));
check('the scan runs BEFORE the PUT, not after it',
  repoWriteSrc.indexOf('scanOutbound(') < repoWriteSrc.indexOf("method: 'PUT'"));
check('the scan is scoped to the PUBLIC repo (back-office IS where findings live)',
  /repoName === REPO_NAME[\s\S]{0,400}scanOutbound\(/.test(repoWriteSrc));

/* ═══════════════ §6 THE MEASUREMENT — the already-published corpus ═══════ */
section('§6 MEASUREMENT — running the scan over everything already published');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const corpus = walk(path.join(ROOT, 'reports'));
let dirtyFiles = 0;
let totalHits = 0;
const byTerm = {};
const worst = [];
for (const file of corpus) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const r = scan.scanOutbound(fs.readFileSync(file, 'utf8'), { path: rel, max: 200 });
  if (!r.scanned || r.clean) continue;
  dirtyFiles += 1;
  totalHits += r.hits.length;
  for (const h of r.hits) byTerm[h.id] = (byTerm[h.id] || 0) + 1;
  worst.push({ rel, n: r.hits.length, ids: [...new Set(r.hits.map((h) => h.id))] });
}

console.log(`  corpus scanned:      ${corpus.length} published markdown files under reports/`);
console.log(`  files that would be REFUSED today: ${dirtyFiles}`);
console.log(`  total term hits:     ${totalHits}`);
console.log(`  by term:             ${Object.entries(byTerm).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ') || '(none)'}`);
if (worst.length) {
  console.log('\n  A hit here is NOT automatically a bug in the list. Per A10 it is either');
  console.log('  a term that is too broad, or content that should never have been published.');
  console.log('  This section REPORTS; it does not fail the run — see the header.\n');
  for (const w of worst.sort((a, b) => b.n - a.n).slice(0, process.argv.includes('--corpus') ? 999 : 12)) {
    console.log(`    ${String(w.n).padStart(4)}  ${w.rel}  [${w.ids.join(', ')}]`);
  }
  if (!process.argv.includes('--corpus') && worst.length > 12) {
    console.log(`    … ${worst.length - 12} more files. Re-run with --corpus for the full listing.`);
  }
}

/* ═══════════════════════════════ summary ════════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n  FAILED:');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${'═'.repeat(72)}\n`);
process.exit(fail ? 1 : 0);
