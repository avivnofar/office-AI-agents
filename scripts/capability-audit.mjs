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

import { auditCapabilities, auditRoleClaims, renderAudit } from '../workers/capability-audit.js';

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

if (args.includes('--json')) {
  console.log(JSON.stringify({ audit, roleClaims }, null, 2));
} else {
  const doc = renderAudit(audit, roleClaims, { date: today });
  console.log(doc);
}

if (outIdx !== -1 && args[outIdx + 1]) {
  writeFileSync(args[outIdx + 1], renderAudit(audit, roleClaims, { date: today }), 'utf8');
  console.error(`\n[capability-audit] findings written to ${args[outIdx + 1]}`);
}

// Exit code carries the headline so a caller can gate on it. NON-ZERO when an
// agent that is not dormant cannot work at all — the Designer's old state, which
// is the one condition this tool exists to make impossible to miss. A merely
// UNSUPPLIED capability is not an error: several are deliberate and recorded.
process.exit(audit.counts.agentsWhoCannotWork > 0 ? 1 : 0);
