#!/usr/bin/env node
/**
 * scripts/capability-audit.mjs — THE RUNNER.
 *
 * Builds a SUPPLY INDEX from the real repository — which modules exist, which
 * symbols they actually export, which lanes actually resolve, which verifiers
 * actually exist — and runs `workers/capability-audit.js` against
 * `config/capability-manifest.json`.
 *
 * ── WHY THE INDEX IS BUILT HERE AND NOT IN THE WORKER ────────────────────
 *
 * A Worker has no filesystem. The audit's whole question is *does a code path
 * exist*, which can only be answered by reading the code. So the split is the
 * same one `scripts/lifecycle.mjs` already makes for the deliverable lifecycle:
 * the LOGIC is a pure module the verifier can call, the FILE ACCESS is a script.
 *
 * ── IT READS EXPORTS, NOT FILENAMES ──────────────────────────────────────
 *
 * The index records each module's actual exported symbols. That distinction is
 * the point: a reference that resolves by filename and not by symbol is the
 * worst of the three failure shapes, because a reader greps the filename, finds
 * it, and concludes the capability is there. This project put two such pointers
 * into its published brain library before anybody checked one.
 *
 * ── NO NETWORK, NO PROVIDER, NO WRITE UNLESS ASKED ───────────────────────
 *
 * Reads files and prints a report. `--out <path>` writes the findings document;
 * without it nothing is written. `--json` prints the raw audit for a caller that
 * wants to compute on it.
 *
 * Run: node scripts/capability-audit.mjs [--out <path>] [--json]
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { auditCapabilities, auditRoleClaims, renderAudit, auditFindingsToBoardItems } from '../workers/capability-audit.js';

const require = createRequire(import.meta.url);
const manifest = require('../config/capability-manifest.json');
const routingConfig = require('../config/model-routing.json');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The exported symbol names of one ES module, read from its source.
 *
 * Source-parsed rather than dynamically imported, deliberately: several worker
 * modules import JSON (`import x from '../config/y.json'`) and cannot be loaded
 * by plain `node`, and an audit that could only see the loadable half of the
 * codebase would report a gap wherever a module happened to need a config file.
 * A regex over export statements sees all of them.
 *
 * Catches: `export function f`, `export const c`, `export class C`,
 * `export async function f`, `export { a, b as c }`, `export default`, and the
 * METHODS of an exported class as `ClassName#method`.
 *
 * ── WHY CLASS METHODS ARE INDEXED, AND WHY QUALIFIED ─────────────────────
 *
 * Half this office's per-agent capabilities are methods on `AgentBase`, not
 * module-level exports — `askAssignedProject`, `evaluateResponseQuality`,
 * `queryGeminiDirect`. The first run of this audit reported all of them
 * UNSUPPLIED, which was a FALSE POSITIVE and worth more than a quiet fix: a
 * false gap in a gap-finding tool is corrosive, because the cheapest way to make
 * it go away is to loosen the check.
 *
 * They are indexed CLASS-QUALIFIED (`AgentBase#askAssignedProject`) rather than
 * as bare names. An unqualified method index would match any method anywhere in
 * the file, which turns the symbol check — the whole point of resolving by symbol
 * rather than by filename — back into "something in this file is called that".
 */
function exportedSymbols(src) {
  const symbols = new Set();
  const decl = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = decl.exec(src)) !== null) symbols.add(m[1]);

  const list = /^export\s*\{([^}]*)\}/gm;
  while ((m = list.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) symbols.add(name);
    }
  }
  if (/^export\s+default\b/m.test(src)) symbols.add('default');

  // Methods of each exported class, from its `export class X {` line to the next
  // line that closes a block at column 0. Two-space indentation is this repo's
  // universal style for class members, so it is used as the member anchor rather
  // than attempting to balance braces.
  const classRe = /^export\s+class\s+([A-Za-z_$][\w$]*)[^{]*\{/gm;
  while ((m = classRe.exec(src)) !== null) {
    const className = m[1];
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/^\}/m);
    const body = end === -1 ? rest : rest.slice(0, end);
    const memberRe = /^ {2}(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(/gm;
    let mm;
    while ((mm = memberRe.exec(body)) !== null) symbols.add(`${className}#${mm[1]}`);
  }

  return [...symbols];
}

/** Walks the directories the manifest can reference. Kept to a named list
 *  rather than the whole repo: an index built from everything would silently
 *  start resolving references into `checkpoints/` or `reports/`. */
const CODE_DIRS = ['workers', 'agents', 'scripts'];

async function buildSupplyIndex() {
  const modules = {};
  for (const dir of CODE_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      if (!/\.(js|mjs)$/.test(file)) continue;
      const rel = `${dir}/${file}`;
      modules[rel] = exportedSymbols(readFileSync(path.join(abs, file), 'utf8'));
    }
  }

  /*
   * LANES ARE RESOLVED, NOT LISTED.
   *
   * A lane's presence in the config is not the same fact as a lane being
   * ROUTABLE — a lane can name a provider that is not in the registry, or a
   * provider of the wrong kind, and resolveLane() refuses it. The manifest's
   * `image-generation-draft` row would resolve on a config read alone even if the
   * lane pointed at a chat provider, which is exactly the "looks fine from
   * outside" failure this whole audit is about. So the index calls the resolver.
   *
   * Imported here rather than at the top because workers/task-router.js is
   * loadable by plain node (it imports no JSON) and this keeps the reason next
   * to the call.
   */
  const { resolveLane } = await import('../workers/task-router.js');
  const lanes = {};
  for (const [laneName, lane] of Object.entries(routingConfig.lanes || {})) {
    if (lane.mode === 'roles') {
      for (const role of Object.keys(lane.roles || {})) {
        const r = resolveLane(routingConfig, laneName, { role });
        lanes[`lanes.${laneName}.roles.${role}`] = r.routable === true;
      }
    }
    lanes[`lanes.${laneName}`] = resolveLane(routingConfig, laneName).routable === true;
  }

  const verifiers = Object.keys(modules).filter((m) => m.startsWith('scripts/'));

  return { modules, lanes, verifiers };
}

const supplyIndex = await buildSupplyIndex();
const audit = auditCapabilities(manifest, supplyIndex);
const roleClaims = auditRoleClaims(audit, manifest, manifest.output_kind_producers);

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const today = new Date().toISOString().slice(0, 10);

if (args.includes('--findings')) {
  // 2026-08-11 (Phase 5) — the weekly capability audit becomes recurring
  // work. This prints the exact body `.github/workflows/
  // weekly-capability-audit.yml` POSTs to the deployed Worker's
  // `{"type":"capability_audit_findings"}` admin trigger, which normalizes
  // and writes them to the board inbox via the SAME path meeting action
  // items already use. See workers/capability-audit.js's
  // auditFindingsToBoardItems() for the shaping rule.
  console.log(JSON.stringify({ type: 'capability_audit_findings', items: auditFindingsToBoardItems(audit) }));
} else if (args.includes('--json')) {
  console.log(JSON.stringify({ audit, roleClaims }, null, 2));
} else {
  const doc = renderAudit(audit, roleClaims, { date: today });
  console.log(doc);
}

if (outIdx !== -1 && args[outIdx + 1]) {
  writeFileSync(args[outIdx + 1], renderAudit(audit, roleClaims, { date: today }), 'utf8');
  console.error(`\n[capability-audit] findings written to ${args[outIdx + 1]}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE GATE — rewired 2026-08-15 (audit finding #4 / KFM-04).
 *
 * It used to be exactly this line:
 *
 *     process.exit(audit.counts.agentsWhoCannotWork > 0 ? 1 : 0);
 *
 * `agentsWhoCannotWork` derives from `canWork`
 * (workers/capability-audit.js:218), which is
 * `mine.some((c) => c.verdict === 'SUPPLIED')` — ONE supplied capability of
 * ANY kind flips it true. So an agent that can send a chat message but cannot
 * produce a single one of its role's declared outputs counted as working, and
 * the weekly job stayed green.
 *
 * That is not a hypothetical. It was true of Agent 9 at the moment this was
 * written: canWork=yes, roleVerdict=PARTLY_SUPPLIED, and she cannot produce
 * `front_publication` — the Designer, "absolute gatekeeper of the Front",
 * with no gate to operate. The sharper metric, `roleVerdict`, was computed on
 * the line above and never consulted. Classic KFM-26: the right thing built,
 * and the number that gates CI not using it.
 *
 * ── THE THREE SEVERITIES, KEPT APART (KFM-06) ────────────────────────────
 *
 * A single merged "problems" count would be true and useless. They fail
 * differently because their remedies differ:
 *
 *   CANNOT_PRODUCE_ITS_OWN_OUTPUT  the role is decorative. Always fails.
 *   NO_OUTPUT_KINDS_DECLARED       the audit COULD NOT CHECK this role. That
 *                                  is not the same as checking it and finding
 *                                  it fine (KFM-13), so it fails rather than
 *                                  passing quietly.
 *   PARTLY_SUPPLIED                some outputs blocked. Fails UNLESS every
 *                                  blocking capability's manifest entry names
 *                                  a board task — see below.
 *
 * ── WHY "BOARDED" IS THE ONLY WAY TO ACKNOWLEDGE A GAP ───────────────────
 *
 * Failing forever on a known, boarded, BLOCKED item would make this job
 * permanently red, and a permanently red gate is ignored — which is KFM-04
 * again from the other side. But an acknowledgement mechanism is a place to
 * hide things, so acknowledgement is a CLAIM THIS SCRIPT CHECKS: the only way
 * to acknowledge a blocked output is for the blocking capability's own
 * manifest entry to name an `OB-NNN`. Today `front-publishing-gate` says
 * "Board OB-014", so the Designer is reported loudly and does not fail the
 * run; a NEW unproducible output that nobody boarded fails immediately.
 * Same discipline the gate-call audit's RETIRED verdict got the same day:
 * you may declare something known, and the declaration is verified.
 * ═══════════════════════════════════════════════════════════════════════ */

const BOARD_REF = /\bOB-\d{3}\b/;
const reasonById = new Map(audit.capabilities.map((c) => [c.id, `${c.reason || ''} ${c.means?.why || ''}`]));

const live = roleClaims.filter((r) => !r.dormant);
const cannotProduce = live.filter((r) => r.roleVerdict === 'CANNOT_PRODUCE_ITS_OWN_OUTPUT');
const undeclared = live.filter((r) => r.roleVerdict === 'NO_OUTPUT_KINDS_DECLARED');

const partial = live.filter((r) => r.roleVerdict === 'PARTLY_SUPPLIED');
const blockersOf = (r) => [...new Set(r.kinds.filter((k) => !k.producible && !k.unmapped).flatMap((k) => k.blockedBy))];
const acknowledged = partial.filter((r) => {
  const b = blockersOf(r);
  return b.length > 0 && b.every((cid) => BOARD_REF.test(reasonById.get(cid) || ''));
});
const unacknowledged = partial.filter((r) => !acknowledged.includes(r));

const say = (s) => console.error(s);
say('\n[capability-audit] GATE — measured on roleVerdict (can the role produce its own declared output?),');
say('                   not on canWork (does it have any supplied capability at all).');

for (const r of cannotProduce) say(`  FAIL  Agent ${r.id} (${r.name}) CANNOT PRODUCE ITS OWN OUTPUT — declared kinds: ${r.kinds.map((k) => k.kind).join(', ')}`);
for (const r of undeclared) say(`  FAIL  Agent ${r.id} (${r.name}) declares NO output kinds — this role could not be checked at all, which is not the same as checking it and finding it fine`);
for (const r of unacknowledged) say(`  FAIL  Agent ${r.id} (${r.name}) cannot produce ${r.unproducibleKinds.join(', ')} — blocked by ${blockersOf(r).join(', ')}, and no blocking capability names a board task. Board it or fix it.`);
for (const r of acknowledged) say(`  KNOWN Agent ${r.id} (${r.name}) cannot produce ${r.unproducibleKinds.join(', ')} — blocked by ${blockersOf(r).join(', ')}, boarded. Reported, not failed.`);
if (audit.counts.agentsWhoCannotWork > 0) say(`  FAIL  ${audit.counts.agentsWhoCannotWork} non-dormant agent(s) have ZERO supplied capabilities (the old check, kept — it catches a role with no declared output kinds AND nothing supplied)`);

const failures = cannotProduce.length + undeclared.length + unacknowledged.length + audit.counts.agentsWhoCannotWork;
say(failures
  ? `\n[capability-audit] ${failures} blocking finding(s). Exiting 1.`
  : `\n[capability-audit] no blocking findings (${acknowledged.length} known-and-boarded gap(s) reported above). Exiting 0.`);

process.exit(failures > 0 ? 1 : 0);
