#!/usr/bin/env node
/**
 * scripts/failure-mode-walk.mjs — the mechanized subset of the failure-mode
 * checklist, and the check that audits the checklist's own coverage claims.
 *
 * ── WHY THIS FILE EXISTS, AND THE FINDING THAT PRODUCED IT ────────────────
 *
 * `back-office-AI-agents/docs/KNOWN-FAILURE-MODES.md` closes with a section
 * titled "Walking this list", whose first line reads:
 *
 *   > **Mechanized subset:** `office-AI-agents/scripts/failure-mode-walk.mjs`,
 *   > run weekly by `.github/workflows/weekly-capability-audit.yml`
 *
 * **Neither half was true.** Grepped across all three repos on 2026-08-16:
 * `failure-mode-walk` appeared in exactly one file — that sentence. No such
 * script existed, and `weekly-capability-audit.yml` never referenced one.
 *
 * That is the TWELFTH false mechanization claim in a file whose 2026-08-16
 * correction block is titled *"ELEVEN `MECHANIZED` LABELS NAMED A CHECK THAT
 * DID NOT EXIST"* — and it is the largest of the twelve, because the other
 * eleven each over-claimed one entry while this one claimed that the whole
 * mechanized subset was being walked every week. The per-entry labels were
 * corrected; the sentence asserting that something WALKS them was not
 * checked, because it sits in a closing section rather than in a coverage
 * column.
 *
 * KFM-09 is *"is any prose asserting an enforcement that does not exist?"*.
 * This is that, committed by the file that catalogues it, about itself, at the
 * one place a reader goes to find out whether any of it runs.
 *
 * So this file is deliberately BOTH things at once:
 *   1. the walker that sentence promised, and
 *   2. `labels` — a check whose entire subject is the truth of the file's own
 *      coverage claims, so the next drift is caught by machine rather than by
 *      somebody happening to grep a slug.
 *
 * ── THE FIVE CHECKS THAT WERE LABELLED AND NEVER BUILT ────────────────────
 *
 * The same correction block resolved eleven bogus slugs three ways: five were
 * real under another name, one was built, and **five named nothing at all** and
 * were relabelled `NOT MECHANIZED`. Relabelling is the honest move only when
 * building is genuinely out of reach — "the point of the file is that checks
 * run, not that labels are accurate". All five were reachable. They are here:
 *
 *   | check             | KFM    | the question it asks                       |
 *   |-------------------|--------|--------------------------------------------|
 *   | `ciescape`        | KFM-05 | can any step in a scheduled job fail it?   |
 *   | `deadexport`      | KFM-12 | is anything exported and read by nobody?   |
 *   | `deadlink`        | KFM-22 | does a visitor-facing link resolve for a
 *   |                   |        | reader who is not the owner?               |
 *   | `privateinpublic` | KFM-23 | does a file's own metadata contradict
 *   |                   |        | where it lives?                            |
 *   | `citedfile`       | KFM-25 | does a cited document exist?               |
 *
 * plus `labels` (new, 2026-08-16), described above.
 *
 * ── WHAT THIS WALKER WILL NOT DO ──────────────────────────────────────────
 *
 * **An unreachable input is `NOT_WALKED` with a reason, never a pass.** This
 * runs from two places with different reach: a laptop holding all three repos,
 * and the public repo's weekly Actions job, which holds NO credential for
 * either private repo. `labels` and `citedfile` read `KNOWN-FAILURE-MODES.md`
 * and the private repos respectively; in CI they will report `NOT_WALKED` and
 * say so. A checklist walker that reported "0 problems" because it could not
 * see the checklist would be KFM-13's shape committed by the instrument built
 * to watch for it — the same trap `growth-watch.mjs` documents.
 *
 * **A declared exception is a CHECKED claim, never a suppression list.** Two
 * checks accept declarations (`@unread-export` in source, `# swallow-ok:` /
 * `# skip-ok:` in workflow YAML). In both cases the declaration must appear in
 * the file the finding is about, must carry a non-empty reason, and is proven
 * insufficient-on-its-own by `--prove`. This is KFM-08b's rule: adding an
 * exception can never be a way to turn the tool green by itself.
 *
 * **`NOTE` findings do not fail the run.** Where the honest answer is "this is
 * a real property and the fix is a policy decision the owner owns", the walker
 * reports and boards rather than inventing a threshold (KFM-05's own lesson
 * from the other side: a gate with nothing behind it).
 *
 * Run:
 *   node scripts/failure-mode-walk.mjs              # walk, print, exit 1 on FAIL
 *   node scripts/failure-mode-walk.mjs --json       # machine-readable
 *   node scripts/failure-mode-walk.mjs --prove      # falsifying probes only
 *
 * Exit codes: 0 all walked checks passed · 1 at least one FAIL · 2 the walker
 * itself could not run. `NOT_WALKED` does not fail the run — it is reported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
const GH_ROOT = path.resolve(REPO_ROOT, '..');

export const REPOS = Object.freeze({
  public: REPO_ROOT,
  backOffice: path.join(GH_ROOT, 'back-office-AI-agents'),
  warehouse: path.join(GH_ROOT, 'warehouse-office-AI-agents'),
});

export const FAILURE_MODES_DOC = path.join(REPOS.backOffice, 'docs', 'KNOWN-FAILURE-MODES.md');

/* ── shared helpers ──────────────────────────────────────────────────────── */

const PASS = 'PASS';
const FAIL = 'FAIL';
const NOT_WALKED = 'NOT_WALKED';

function readText(file) {
  try {
    // Normalised for the same reason verify-permissions.js normalises: the
    // owner's git runs core.autocrlf=true, so a source-text assertion made on
    // a raw read is RED on his machine and GREEN in CI (KFM-04b).
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** Recursive file walk. Never follows symlinks — a loop would hang the walker. */
function walkFiles(dir, filter, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.wrangler') continue;
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(full, filter, out);
    else if (e.isFile() && (!filter || filter(full))) out.push(full);
  }
  return out;
}

const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/');

/** Strips /* *\/ and // comments so a source-text check cannot match prose
 *  ABOUT the code it is asserting on — KFM-04c, which this suite has already
 *  been bitten by once (verify-quality-metric §2 matched its own explanation). */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ''.padEnd(m.length - p1.length, ' '));
}

/* ══════════════════════════════════════════════════════════════════════════
   CHECK: labels — every MECHANIZED label must resolve to a real file
   ══════════════════════════════════════════════════════════════════════════

   The legend in KNOWN-FAILURE-MODES.md already states the rule this enforces:

     > `MECHANIZED` — a scripted check exists. **The label must name a real
     > FILE** — and its § where one applies — never a slug or a concept. If you
     > cannot `grep` the name and land on it, the entry is not mechanized.

   The rule was written the day eleven labels were found violating it, and
   nothing enforced it. This does.

   Resolution is deliberately generous about SPELLING and strict about
   EXISTENCE: a bare `verify-quality-metric` resolves to
   `scripts/verify-quality-metric.js`, and `gate-call-audit` resolves to
   back-office `tools/gate-call-audit/`, because both of those land a reader on
   something real. What it will not do is accept a name that resolves to
   nothing — which is the entire defect. */

const LABEL_SEARCH_DIRS = [
  { root: REPOS.public, dirs: ['scripts', 'workers', 'tools', '.github/workflows'] },
  { root: REPOS.backOffice, dirs: ['tools', 'scripts', 'docs'] },
  { root: REPOS.warehouse, dirs: ['tools', 'scripts'] },
];

const LABEL_EXTENSIONS = ['', '.js', '.mjs', '.yml', '.md'];

/** The walker's own check registry. Declared here rather than derived from
 *  `CHECKS` because `resolveLabel()` runs before those functions are defined. */
export const CHECK_IDS = Object.freeze(['labels', 'ciescape', 'deadexport', 'deadlink', 'privateinpublic', 'citedfile']);

/**
 * Pulls the candidate check names out of one heading line.
 *
 * A heading carries several kinds of backticked token and only one kind is a
 * check name. `#3` is a finding number (the legend says so), `new, 2026-08-16`
 * is a provenance note, `§7` is a section within a named file. Filtering by
 * SHAPE rather than by a list keeps this from needing maintenance every time
 * an entry is added.
 */
export function labelCandidatesFrom(headingLine) {
  // "NOT MECHANIZED" is an honest label and is not a claim to check.
  const withoutNot = headingLine.replace(/NOT MECHANIZED/g, 'HONESTLY-UNMECHANIZED');
  if (!/\bMECHANIZED\b/.test(withoutNot)) return [];
  const out = [];
  for (const m of withoutNot.matchAll(/`([^`]+)`/g)) {
    const tok = m[1].trim();
    if (tok.startsWith('#')) continue;                  // a finding number
    if (tok.startsWith('§')) continue;                  // a section reference
    if (!/^[A-Za-z0-9._/-]+$/.test(tok)) continue;      // prose, dates, notes
    out.push(tok);
  }
  return out;
}

/**
 * Where a label name lands, or null. Returns a repo-relative display path.
 *
 * Searches one level BELOW each listed directory as well as inside it, because
 * the office's tools are packaged as `tools/<tool>/<file>.js` — a first draft
 * of this resolver looked only at `tools/<name>` and reported KFM-08b's
 * perfectly good `verify-gate-call-audit` label as unresolvable. That was the
 * CHECK being wrong about a correct label, which is the failure mode worth
 * naming here: the fix belonged in the resolver, not in the entry.
 */
export function resolveLabel(name) {
  // A check REGISTERED IN THIS FILE is a real, greppable thing and resolves —
  // `MECHANIZED (`failure-mode-walk.mjs` — check `citedfile`)` lands a reader
  // on something. The list is the walker's own registry rather than a
  // free-text allowance, so an unregistered slug still fails: that is the
  // difference between this and the eleven names that resolved to nothing.
  if (CHECK_IDS.includes(name)) return `office-AI-agents/scripts/failure-mode-walk.mjs#${name}`;
  for (const { root } of LABEL_SEARCH_DIRS) {
    // A label may name a repo-relative PATH outright, which is the clearest
    // form and the one the legend actually asks for.
    if (exists(root) && name.includes('/') && exists(path.join(root, name))) {
      return `${path.basename(root)}/${name}`;
    }
  }
  for (const { root, dirs } of LABEL_SEARCH_DIRS) {
    if (!exists(root)) continue;
    for (const d of dirs) {
      for (const ext of LABEL_EXTENSIONS) {
        const p = path.join(root, d, name + ext);
        if (exists(p)) return `${path.basename(root)}/${rel(root, p)}`;
      }
      let subs = [];
      try {
        subs = fs.readdirSync(path.join(root, d), { withFileTypes: true })
          .filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { /* directory absent in this repo */ }
      for (const sub of subs) {
        for (const ext of LABEL_EXTENSIONS) {
          const p = path.join(root, d, sub, name + ext);
          if (exists(p)) return `${path.basename(root)}/${rel(root, p)}`;
        }
      }
    }
  }
  return null;
}

function checkLabels() {
  const doc = readText(FAILURE_MODES_DOC);
  if (doc === null) {
    return {
      id: 'labels', kfm: 'the file itself', status: NOT_WALKED,
      reason: `${FAILURE_MODES_DOC} is not readable from here (the private back-office repo is not checked out, or this is CI, which holds no credential for it). The coverage claims were NOT checked this run.`,
      findings: [],
    };
  }
  const findings = [];
  let claims = 0;
  doc.split('\n').forEach((line, i) => {
    if (!/^#{3}\s/.test(line)) return;
    for (const name of labelCandidatesFrom(line)) {
      claims += 1;
      const landed = resolveLabel(name);
      if (!landed) {
        const entry = (line.match(/^#{3}\s+(KFM-[0-9a-z]+|CTL-[0-9]+)/) || [, '?'])[1];
        findings.push({
          severity: FAIL,
          where: `KNOWN-FAILURE-MODES.md:${i + 1}`,
          what: `${entry} is labelled MECHANIZED naming \`${name}\`, which resolves to no file in any of the three repos.`,
        });
      }
    }
  });
  return {
    id: 'labels', kfm: 'the file itself',
    status: findings.length ? FAIL : PASS,
    reason: `${claims} MECHANIZED name(s) checked; ${findings.length} resolve to nothing.`,
    findings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CHECK: ciescape (KFM-05) — can any step in a scheduled job actually fail it?
   ══════════════════════════════════════════════════════════════════════════

   KFM-05's generalized form is *"is there any input to this job for which it
   reports failure?"*, which is not decidable by reading. What IS decidable,
   and is the shape of both the original instance and its fix, is:

     (a) does the workflow contain any step that can fail the run at all, once
         setup actions are set aside — a job whose only fallible step is
         `actions/checkout` is a green light wired to nothing, and counting
         checkout would make this check vacuous, which is how a check comes to
         mean nothing; and

     (b) is any exit code SWALLOWED — `|| true`, or `set +e` with `$?` captured
         into an output — and then never re-raised? The 2026-08-15 fix was
         exactly this: capture `gate_exit`, re-raise it in a final step placed
         after the board post. Swallowing so the post happens and never looking
         again are two different decisions and only the first was intended.

   A `|| true` that is genuinely correct declares itself with `# swallow-ok:
   <reason>` on the preceding line. The reason must be non-empty, must be in
   the workflow the finding is about, and does not by itself make the check
   green — `--prove` demonstrates the check still refuses a bare one.

   WHAT THIS DOES NOT COVER, stated rather than implied: a job every one of
   whose fallible steps is guarded by the same `if:` — under the input that
   makes that condition false, the job is green and did nothing. That is real
   and it is HALF OF THE ORIGINAL INSTANCE ("the whole job no-ops with a skip
   notice if AGENTS_API_BASE/ADMIN_TOKEN are unset"). It is reported as `NOTE`
   rather than FAIL because the remedy — should an unconfigured job go red? —
   is a policy decision that belongs to the owner, and inventing the answer
   here would be a gate with nothing behind it. */

const SETUP_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/setup-python', 'actions/cache'];

/** Splits a workflow's `steps:` blocks into step records. Line-based on
 *  purpose: this suite carries no YAML dependency, and the shape being read
 *  (a list of mappings under `steps:`) is stable enough to parse by indent. */
export function parseWorkflowSteps(yaml) {
  const lines = yaml.split('\n');
  const steps = [];
  let inSteps = false;
  let stepIndent = null;
  let cur = null;
  const push = () => { if (cur) steps.push(cur); cur = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*steps:\s*$/.test(line)) { push(); inSteps = true; stepIndent = null; continue; }
    if (!inSteps) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (line.trim() && !/^\s*#/.test(line) && stepIndent !== null && indent < stepIndent) {
      push(); inSteps = false; continue;                 // dedented out of steps:
    }
    const isNewStep = /^\s*- /.test(line);
    if (isNewStep) {
      if (stepIndent === null) stepIndent = indent;
      if (indent === stepIndent) { push(); cur = { startLine: i + 1, lines: [] }; }
    }
    if (cur) cur.lines.push(line);
  }
  push();
  return steps.map((s) => {
    const body = s.lines.join('\n');
    return {
      startLine: s.startLine,
      name: (body.match(/-?\s*name:\s*(.+)/) || [, ''])[1].trim(),
      uses: (body.match(/uses:\s*(\S+)/) || [, null])[1],
      hasIf: /\n?\s*if:\s*\S/.test(body),
      ifExpr: (body.match(/if:\s*(.+)/) || [, ''])[1].trim(),
      continueOnError: /continue-on-error:\s*true/.test(body),
      run: /(^|\n)\s*run:/.test(body) ? body.slice(body.search(/(^|\n)\s*run:/)) : null,
      body,
    };
  });
}

/** Can this step, on its own, make the run go red? */
export function stepCanFail(step) {
  if (step.continueOnError) return false;
  if (step.uses) return !SETUP_ACTIONS.some((a) => step.uses.startsWith(a));
  if (!step.run) return false;
  const cmds = step.run
    .replace(/^\s*run:\s*\|?\s*/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (cmds.some((c) => /(^|\s)exit\s+1(\s|$)/.test(c))) return true;
  if (cmds.some((c) => /^set \+e$/.test(c))) return false;
  if (!cmds.length) return false;
  return !cmds.every((c) => /\|\|\s*true\s*$/.test(c));
}

export function analyseWorkflow(name, yaml) {
  const findings = [];
  const steps = parseWorkflowSteps(yaml);
  const lines = yaml.split('\n');

  // (a) is anything here able to go red at all?
  const fallible = steps.filter(stepCanFail);
  if (!fallible.length) {
    findings.push({
      severity: FAIL, where: name,
      what: 'no step in this workflow can fail the run (setup actions aside) — a green light wired to nothing.',
    });
  }

  // (b) swallowed exit codes with no re-raise and no declared waiver
  const captured = new Set();
  for (const m of yaml.matchAll(/(\w+)=\$\?/g)) captured.add(m[1]);
  const reRaised = new Set();
  for (const s of steps) {
    if (!/(^|\s)exit\s+1(\s|$)/.test(s.body)) continue;
    for (const m of s.ifExpr.matchAll(/outputs\.(\w+)/g)) reRaised.add(m[1]);
  }
  for (const v of captured) {
    if (!reRaised.has(v)) {
      findings.push({
        severity: FAIL, where: name,
        what: `exit code captured as \`${v}=$?\` and never re-raised by a step that exits 1 on it — the code is measured and discarded.`,
      });
    }
  }
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;                      // a comment ABOUT `|| true`
    if (!/\|\|\s*true\s*$/.test(line)) return;
    // Scan the whole contiguous comment block above, not only the line
    // immediately before: a reason worth reading is usually several lines
    // long, and requiring it to sit on one line would push people toward a
    // short reason chosen to satisfy the checker.
    let block = '';
    for (let k = i - 1; k >= 0 && /^\s*(#|$)/.test(lines[k]); k--) block = lines[k] + '\n' + block;
    const waiver = block.match(/#\s*swallow-ok:\s*(\S.*)$/m);
    if (waiver && waiver[1].trim().length >= 10) return;
    findings.push({
      severity: FAIL, where: `${name}:${i + 1}`,
      what: waiver
        ? 'carries a `# swallow-ok:` waiver with no substantive reason.'
        : 'discards an exit code with `|| true` and no `# swallow-ok: <reason>` declaring why.',
    });
  });

  // (c) reported, not failed — see this section's header
  const guardExprs = new Set(fallible.map((s) => s.ifExpr).filter(Boolean));
  if (fallible.length && fallible.every((s) => s.hasIf) && !/#\s*skip-ok:\s*\S/.test(yaml)) {
    findings.push({
      severity: 'NOTE', where: name,
      what: `every step that can fail is behind an \`if:\` (${guardExprs.size} distinct condition(s)) — there is an input for which this job is green and did nothing.`,
    });
  }
  return findings;
}

function checkCiEscape() {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const files = walkFiles(dir, (f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (!files.length) {
    return { id: 'ciescape', kfm: 'KFM-05', status: NOT_WALKED, reason: `no workflows found under ${rel(REPO_ROOT, dir)}`, findings: [] };
  }
  const findings = [];
  for (const f of files) findings.push(...analyseWorkflow(rel(REPO_ROOT, f), readText(f) ?? ''));
  const fails = findings.filter((x) => x.severity === FAIL);
  return {
    id: 'ciescape', kfm: 'KFM-05',
    status: fails.length ? FAIL : PASS,
    reason: `${files.length} workflow(s) walked; ${fails.length} blocking, ${findings.length - fails.length} noted.`,
    findings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CHECK: deadexport (KFM-12) — is anything exported and called by nobody?
   ══════════════════════════════════════════════════════════════════════════

   "Not urgent, but it accumulates and it makes KFM-08 harder to read."

   An unread export is not automatically a defect — a back-compat alias kept
   through a rename, a migration statement run once by hand, a constant defined
   with its siblings ahead of its consumer are all legitimate. So the check
   requires each one to SAY it, in the file it lives in, with an
   `@unread-export <reason>` tag in the doc comment above it.

   That is KFM-08b's rule applied here: a "known exception" mechanism must be
   verified against the thing it excuses. The tag is not a suppression list in
   a side file that nobody reading the export would see; it is a sentence next
   to the export, and `--prove` shows an empty one does not satisfy the check.

   IMPORTANT about what "read" means here. The scan counts mentions of the
   SYMBOL. An export whose VALUE is duplicated as a literal at its use site
   reads as unread — and that is the correct answer, not a false positive: a
   constant nobody imports is a constant that can drift from the literal beside
   it, which is the accumulation this entry is about. */

const EXPORT_SCAN_DIRS = ['workers', 'agents', 'scripts', '.github/scripts'];

export function findExportSites(root) {
  const sites = [];
  for (const d of ['workers']) {
    for (const f of walkFiles(path.join(root, d), (p) => p.endsWith('.js'))) {
      const src = readText(f);
      if (src === null) continue;
      src.split('\n').forEach((line, i) => {
        const m = line.match(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/);
        if (m) sites.push({ file: f, line: i + 1, name: m[1] });
      });
    }
  }
  return sites;
}

/** The declaration must sit in the comment block immediately above the export
 *  — not merely somewhere in the file, which would let one tag excuse the lot. */
export function unreadExportWaiver(src, exportLine) {
  const lines = src.split('\n');
  const start = Math.max(0, exportLine - 1 - 30);
  const window = lines.slice(start, exportLine - 1);
  // Stop at the previous export so a tag cannot be borrowed from a neighbour.
  let from = 0;
  window.forEach((l, i) => { if (/^export\s/.test(l)) from = i + 1; });
  const text = window.slice(from).join('\n');
  const m = text.match(/@unread-export\s+(\S.*)/);
  if (!m) return null;
  const reason = m[1].trim();
  return reason.length >= 12 ? reason : '';
}

function checkDeadExport() {
  const sites = findExportSites(REPO_ROOT);
  if (!sites.length) {
    return { id: 'deadexport', kfm: 'KFM-12', status: NOT_WALKED, reason: 'no exports found to scan', findings: [] };
  }
  // One pass over every consumer file, comments stripped.
  const haystack = EXPORT_SCAN_DIRS
    .flatMap((d) => walkFiles(path.join(REPO_ROOT, d), (p) => /\.(js|mjs)$/.test(p)))
    .map((f) => stripComments(readText(f) ?? ''))
    .join('\n');

  const findings = [];
  let unread = 0;
  for (const s of sites) {
    const hits = (haystack.match(new RegExp(`\\b${s.name}\\b`, 'g')) || []).length;
    if (hits > 1) continue;                              // read somewhere
    unread += 1;
    const waiver = unreadExportWaiver(readText(s.file) ?? '', s.line);
    if (waiver) continue;
    findings.push({
      severity: FAIL,
      where: `${rel(REPO_ROOT, s.file)}:${s.line}`,
      what: waiver === ''
        ? `\`${s.name}\` carries an \`@unread-export\` tag with no substantive reason.`
        : `\`${s.name}\` is exported and read by nothing, and does not declare why (\`@unread-export <reason>\`).`,
    });
  }
  return {
    id: 'deadexport', kfm: 'KFM-12',
    status: findings.length ? FAIL : PASS,
    reason: `${sites.length} exports scanned; ${unread} read by nothing, ${unread - findings.length} of those declared.`,
    findings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CHECK: deadlink (KFM-22) — does a visitor-facing link resolve for a stranger?
   ══════════════════════════════════════════════════════════════════════════

   "Check as an anonymous visitor, not while authenticated. A private repo
   returns 404 to the public exactly as a deleted one does."

   This makes NO network call, deliberately, and that is a stronger check here
   rather than a weaker one. The original instance was seven links to
   `github.com/avivnofar/Notebook-X` — a repo that is PRIVATE, which the audit
   read as deleted. A fetch from the owner's machine or from an authenticated
   CI job cannot tell those apart either. What CAN tell them apart is the
   office's own declaration of which repos are private:
   `config/office-projects.json` carries `visibility` per project, and it is
   maintained as data for exactly this sort of question.

   So: a link from the public repo to a repo the office itself declares
   private is a FAIL, with no network and no ambiguity. A repo-relative link
   whose target is missing is likewise a FAIL. External links to third parties
   are out of scope and say so — an unreachable third-party host is not this
   office's finding to make. */

const VISITOR_FACING = [
  'README.md', 'CLAUDE.md', 'PROJECT-CONTEXT-SUMMARY.md', 'AGENTS.md',
  'DEPLOY.md', 'TOKEN-BUDGET.md', 'PENDING-WORK.md',
];

export function privateRepoNames(root) {
  const raw = readText(path.join(root, 'config', 'office-projects.json'));
  if (raw === null) return null;
  try {
    const cfg = JSON.parse(raw);
    return (cfg.projects || []).filter((p) => p.visibility === 'private').map((p) => p.repo);
  } catch { return null; }
}

function checkDeadLink() {
  const priv = privateRepoNames(REPO_ROOT);
  if (priv === null) {
    return { id: 'deadlink', kfm: 'KFM-22', status: NOT_WALKED, reason: 'config/office-projects.json is missing or unparseable, so which repos are private is unknown — and guessing is what this check exists to avoid.', findings: [] };
  }
  const docs = [
    ...VISITOR_FACING.map((f) => path.join(REPO_ROOT, f)).filter(exists),
    ...walkFiles(path.join(REPO_ROOT, 'front'), (p) => p.endsWith('.md')),
  ];
  const findings = [];
  let links = 0;
  for (const file of docs) {
    const src = readText(file) ?? '';
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        links += 1;
        const gh = target.match(/^https?:\/\/github\.com\/avivnofar\/([A-Za-z0-9._-]+)/);
        if (gh) {
          if (priv.includes(gh[1])) {
            findings.push({
              severity: FAIL, where: `${rel(REPO_ROOT, file)}:${i + 1}`,
              what: `links to github.com/avivnofar/${gh[1]}, which config/office-projects.json declares private — a stranger gets a 404 indistinguishable from a deleted repo.`,
            });
          }
          continue;
        }
        if (/^(https?:|mailto:|#)/.test(target)) continue;   // third party / anchor
        const clean = target.split('#')[0];
        if (!clean) continue;
        const abs = clean.startsWith('/')
          ? path.join(REPO_ROOT, clean.slice(1))
          : path.resolve(path.dirname(file), clean);
        if (!exists(abs)) {
          findings.push({
            severity: FAIL, where: `${rel(REPO_ROOT, file)}:${i + 1}`,
            what: `repo-relative link \`${target}\` resolves to nothing in this repo.`,
          });
        }
      }
    });
  }
  return {
    id: 'deadlink', kfm: 'KFM-22',
    status: findings.length ? FAIL : PASS,
    reason: `${links} link(s) across ${docs.length} visitor-facing document(s); private repos per office-projects.json: ${priv.join(', ') || 'none'}.`,
    findings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CHECK: privateinpublic (KFM-23) — does a file's metadata contradict where
   it lives?
   ══════════════════════════════════════════════════════════════════════════

   "A file labelling itself private in a public repo is a boundary violation
   regardless of whether its content turns out to be sensitive."

   The distinction that makes this mechanizable without judgement is
   STRUCTURAL, not semantic: a file DESCRIBING something private is fine, a
   file DECLARING ITSELF private is not. `config/office-projects.json` carries
   four `"visibility": "private"` values — each inside an element of a
   `projects` array, describing another repo. The instance that produced this
   entry carried its value at `_meta.visibility`, the document's own metadata
   block.

   So: a classification key is a self-declaration when it sits at the JSON
   root or inside a root-level `_meta`/`meta` object, or in a markdown file's
   opening block. Anywhere inside an array, it is describing an item. No
   guessing about what the words mean. */

const CLASSIFICATION_KEYS = ['visibility', 'classification'];
const PRIVATE_WORDS = /(private|internal[- ]only|confidential|staff)/i;
const MD_HEADER_LINES = 15;

export function jsonSelfDeclaration(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of CLASSIFICATION_KEYS) {
    if (typeof obj[k] === 'string' && PRIVATE_WORDS.test(obj[k])) return { at: k, value: obj[k] };
  }
  for (const metaKey of ['_meta', 'meta']) {
    const m = obj[metaKey];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const k of CLASSIFICATION_KEYS) {
      if (typeof m[k] === 'string' && PRIVATE_WORDS.test(m[k])) return { at: `${metaKey}.${k}`, value: m[k] };
    }
  }
  return null;
}

export function markdownSelfDeclaration(src) {
  const head = src.split('\n').slice(0, MD_HEADER_LINES);
  for (let i = 0; i < head.length; i++) {
    const m = head[i].match(/^\**\s*(Classification|Visibility)\s*:?\**\s*:?\s*(.+)$/i);
    if (m && PRIVATE_WORDS.test(m[2])) return { at: `line ${i + 1}`, value: m[2].trim() };
  }
  return null;
}

function checkPrivateInPublic() {
  const files = walkFiles(REPO_ROOT, (p) => /\.(json|md)$/.test(p));
  const findings = [];
  for (const f of files) {
    const src = readText(f);
    if (src === null) continue;
    let hit = null;
    if (f.endsWith('.json')) {
      try { hit = jsonSelfDeclaration(JSON.parse(src)); } catch { continue; }
    } else {
      hit = markdownSelfDeclaration(src);
    }
    if (hit) {
      findings.push({
        severity: FAIL, where: `${rel(REPO_ROOT, f)} (${hit.at})`,
        what: `declares itself "${hit.value}" while living in the PUBLIC repo.`,
      });
    }
  }
  return {
    id: 'privateinpublic', kfm: 'KFM-23',
    status: findings.length ? FAIL : PASS,
    reason: `${files.length} json/md file(s) scanned for a self-declared classification.`,
    findings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CHECK: citedfile (KFM-25) — does a cited document exist?
   ══════════════════════════════════════════════════════════════════════════

   "A document referenced by several others is not thereby real."

   The instance is `WAREHOUSE-PRODUCT-AUDIT-2026-08-14.md`, named by at least
   six files across two repos and existing in none of them. **The multiplicity
   is the signal, and it is what makes this check possible at all.** A naive
   "every .md name mentioned must exist" scan returns hundreds of rows — guide
   examples, files belonging to other projects, historical names from before a
   rename — and a check that cries wolf teaches the reader that red means
   nothing (KFM-04b, KFM-04c). Measured before writing this: 515 distinct .md
   names are mentioned across the repos and well over a hundred resolve
   nowhere, almost all of them legitimately.

   What is NOT legitimate, and is exactly the defect, is several documents
   independently citing one name as an authority that no repo holds. So the
   threshold is: cited by CITE_THRESHOLD or more distinct files, and existing
   in none of the three repos.

   Names are matched on BASENAME across all three repos, because a citation
   like `plans/OFFICE-SCALING-TODO.md` is answered by the file wherever it
   actually lives — the question is "does this document exist", not "is this
   path correct". */

export const CITE_THRESHOLD = 3;

/** Names that are patterns rather than documents — a generic filename cited by
 *  many files means many DIFFERENT files, not one missing one. */
const GENERIC_DOC_NAMES = new Set([
  'README.md', 'CLAUDE.md', 'AGENTS.md', 'TODO.md', 'CHANGELOG.md', 'LICENSE.md',
  'INDEX.md', 'NOTES.md', 'SKILL.md', 'LATEST.md', 'PATCH.md', 'MAINTENANCE.md',
]);

/**
 * ── THE THREE NOISE CLASSES, AND WHY EACH EXCLUSION IS STRUCTURAL ──────────
 *
 * The unfiltered first run of this check produced 44 rows. Reading them
 * settled that only a handful were the defect KFM-25 describes; the rest fell
 * into three classes that share a property — **they are not citations of an
 * office document at all** — and each is excluded on a structural test rather
 * than on a judgement about the individual name. This is written out because
 * an exclusion list nobody can audit is where a check goes to die (KFM-08b),
 * and because the alternative — shipping 44 rows — is how a reader learns that
 * red means nothing (KFM-04b).
 *
 * 1. **Vendored bundles and cross-project history.** `assets/incoming/` is
 *    declared in CLAUDE.md as raw human-in-the-loop tool exports awaiting
 *    integration; its internal cross-links point inside a bundle that was
 *    never fully imported. `reports/notebook-x/` is a historical record of
 *    work on ANOTHER repo, and `NOTEBOOK_X_SESSION_*.md` living in Notebook-X
 *    rather than here is correct, not missing. Excluded by CITING PATH.
 *
 * 2. **Filename templates.** `day-NNN-summary.md`, `week-NN-report.md`,
 *    `YYYY-MM-DD-builder.md`, `promotion-results-year-N.md` are naming
 *    CONVENTIONS being described. A document that describes a convention is
 *    not citing a document. Excluded by the placeholder tokens themselves.
 *
 * 3. **Convention fragments.** `summary.md` and `architect.md` are the tails
 *    of `day-003-summary.md` and `2026-08-14-1244-architect.md`. Excluded when
 *    the cited name is a suffix of a real file's basename — which is the
 *    machine-checkable form of "a file of this convention exists".
 *
 * What survives is a name several documents cite as an authority, that no repo
 * holds, and that is not explained by any of the above.
 */
const CITE_SKIP_PATHS = [
  /\/assets\/incoming\//,        // vendored bundles awaiting integration
  /\/reports\/notebook-x\//,     // historical record of work on another repo
  /\/checkpoints\//,             // point-in-time snapshots
  /\/docs\/reference\//,         // a copy of ANOTHER repo's file cites that repo's docs
  /\/docs\/cited-but-absent\//,  // the register itself names what it registers
];
const TEMPLATE_TOKENS = /(NNN|NN\b|YYYY|MM-DD|year-N|-N\.md$|TEMPLATE)/;

/**
 * The cited-but-absent register: `back-office/docs/cited-but-absent/<name>`.
 *
 * A document that genuinely is not there may be ACCOUNTED FOR rather than
 * fixed — a lost audit cannot be recreated, and a file that a mechanism has
 * simply not written yet is not a defect at all. But "accounted for" has to
 * be a claim the check can test, or the register becomes the place findings
 * go to be hidden (KFM-08b). So an entry must exist under the cited name, say
 * which of the two facts it is, and be substantive.
 *
 * @returns {'LOST'|'NOT YET'|null}
 */
export function citedAbsentRegistration(name) {
  if (name.toLowerCase() === 'readme.md') return null;   // the register's own index
  const p = path.join(REPOS.backOffice, 'docs', 'cited-but-absent', name);
  const text = readText(p);
  if (text === null || text.trim().length < 400) return null;
  // The status must be DECLARED on its own line, not merely mentioned. The
  // register's README names both words while registering nothing.
  const m = text.match(/^\W*Status:\W*(LOST|NOT YET)\b/mi);
  return m ? m[1].toUpperCase() : null;
}

function checkCitedFile() {
  const roots = Object.entries(REPOS).filter(([, r]) => exists(r));
  // Existence is asked of the office's whole DECLARED universe, not only the
  // three repos it writes to. `config/office-projects.json` names the client
  // projects, and `aviv-brain` is the owner's knowledge repo — a document
  // citing `CLAUDE-md-template.md` or `approved-sources.md` is citing
  // something real that simply lives in a repo this office never writes to.
  // Read-only, and deliberately so: the brain is never written by any session.
  const universe = [...new Set([
    ...roots.map(([, r]) => r),
    ...[...(privateRepoNames(REPO_ROOT) || []), 'aviv-brain']
      .map((r) => path.join(GH_ROOT, r)).filter(exists),
  ])];
  if (roots.length < 2) {
    return { id: 'citedfile', kfm: 'KFM-25', status: NOT_WALKED, reason: 'fewer than two of the three repos are reachable from here, so "exists nowhere" cannot be established (CI holds no credential for the private repos).', findings: [] };
  }
  const existing = new Set();
  const officeRoots = new Set(roots.map(([, r]) => r));
  const mdFiles = [];
  for (const root of universe) {
    for (const f of walkFiles(root, () => true)) {
      // The register is NOT the document. A file in `docs/cited-but-absent/`
      // carries the cited NAME on purpose, so a reader following a citation
      // lands on the truth — but letting it satisfy the existence test would
      // make the register self-approving, and an exception mechanism that
      // cannot be refused is a place to hide things (KFM-08b).
      if (/[\\/]docs[\\/]cited-but-absent[\\/]/.test(f)) continue;
      existing.add(path.basename(f).toLowerCase());
      if (!officeRoots.has(root)) continue;              // cite FROM the three only
      const posix = f.replace(/\\/g, '/');
      if (f.endsWith('.md') && !CITE_SKIP_PATHS.some((re) => re.test(posix))) mdFiles.push([root, f]);
    }
  }
  const existingNames = [...existing];
  /** name -> Set of citing files */
  const cites = new Map();
  for (const [root, f] of mdFiles) {
    const src = readText(f);
    if (src === null) continue;
    const seen = new Set();
    // The leading `_` matters: `guides/_verification-queue.md` matched from
    // the `v` without it, and the check then reported a file that exists
    // under a name it had itself truncated.
    for (const m of src.matchAll(/([A-Za-z0-9_][A-Za-z0-9_.-]*\.md)\b/g)) seen.add(m[1]);
    for (const name of seen) {
      if (!cites.has(name)) cites.set(name, new Set());
      cites.get(name).add(`${path.basename(root)}/${rel(root, f)}`);
    }
  }
  const findings = [];
  let registered = 0;
  for (const [name, citers] of cites) {
    if (GENERIC_DOC_NAMES.has(name)) continue;
    if (existing.has(name.toLowerCase())) continue;
    if (citers.size < CITE_THRESHOLD) continue;
    if (TEMPLATE_TOKENS.test(name)) continue;                          // class 2
    const lower = name.toLowerCase();
    if (existingNames.some((b) => b !== lower && b.endsWith(`-${lower}`))) continue;  // class 3
    const reg = citedAbsentRegistration(name);
    if (reg) registered += 1;
    findings.push({
      severity: reg ? 'NOTE' : FAIL, where: `${citers.size} files`,
      what: reg
        ? `\`${name}\` is cited by ${citers.size} documents and exists nowhere — registered as ${reg} in docs/cited-but-absent/.`
        : `\`${name}\` is cited by ${citers.size} documents and exists nowhere in the office's declared universe — e.g. ${[...citers].slice(0, 3).join(', ')}.`,
    });
  }
  return {
    id: 'citedfile', kfm: 'KFM-25',
    status: findings.some((f) => f.severity === FAIL) ? FAIL : PASS,
    reason: `${cites.size} distinct .md names cited across ${mdFiles.length} documents in ${roots.length} office repo(s); existence checked against ${universe.length} repo(s); threshold ${CITE_THRESHOLD} citers; ${registered} registered in docs/cited-but-absent/.`,
    findings,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Falsifying probes — every check must be shown able to say NO
   ══════════════════════════════════════════════════════════════════════════

   A check that has never been observed refusing is a check nobody has reason
   to believe. Each probe feeds a deliberately broken input to the same
   function the real walk uses, and asserts refusal — and, where a declared
   exception exists, asserts that the declaration alone does not buy silence. */

function probes() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

  ok('labels: a MECHANIZED label naming nothing is refused',
    labelCandidatesFrom('### KFM-99 — a question? `#1` · MECHANIZED (`no-such-check-anywhere`)').length === 1
    && resolveLabel('no-such-check-anywhere') === null);
  ok('labels: a real file still resolves',
    resolveLabel('verify-routing') !== null, resolveLabel('verify-routing'));
  ok('labels: a REGISTERED check id resolves',
    resolveLabel('citedfile') !== null);
  ok('labels: an UNREGISTERED slug of the same shape does not',
    resolveLabel('countdrop') === null && resolveLabel('boardcount') === null);
  ok('labels: NOT MECHANIZED is not read as a claim',
    labelCandidatesFrom('### KFM-05 — q? `#4` · **NOT MECHANIZED — the name below was never built**').length === 0);

  const bareSwallow = 'jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n      - name: a\n        run: node x.mjs || true\n';
  ok('ciescape: a bare `|| true` is refused',
    analyseWorkflow('probe', bareSwallow).some((f) => f.severity === FAIL));
  const waived = 'jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n      - name: a\n        # swallow-ok: rendered for the log only; the same command is gated above\n        run: node x.mjs || true\n      - name: b\n        run: node y.mjs\n';
  ok('ciescape: a substantive `# swallow-ok:` is accepted',
    !analyseWorkflow('probe', waived).some((f) => f.severity === FAIL));
  const emptyWaiver = 'jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n      - name: a\n        # swallow-ok: ok\n        run: node x.mjs || true\n';
  ok('ciescape: an empty `# swallow-ok:` does NOT buy silence',
    analyseWorkflow('probe', emptyWaiver).some((f) => f.severity === FAIL));
  const setupOnly = 'jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n';
  ok('ciescape: checkout alone does not count as a step that can fail',
    analyseWorkflow('probe', setupOnly).some((f) => f.severity === FAIL && /green light/.test(f.what)));
  const captured = 'jobs:\n  j:\n    steps:\n      - name: a\n        id: a\n        run: |\n          set +e\n          node x.mjs\n          echo "e=$?" >> "$GITHUB_OUTPUT"\n';
  ok('ciescape: a captured exit code never re-raised is refused',
    analyseWorkflow('probe', captured).some((f) => f.severity === FAIL && /never re-raised/.test(f.what)));

  const src = '/**\n * @unread-export back-compat alias kept through the 2026-07 rename\n */\nexport const X = 1;\n';
  ok('deadexport: a substantive @unread-export is accepted',
    unreadExportWaiver(src, 4) !== null && unreadExportWaiver(src, 4) !== '');
  ok('deadexport: an empty @unread-export does NOT buy silence',
    unreadExportWaiver('/** @unread-export tbd */\nexport const X = 1;\n', 2) === '');
  ok('deadexport: a neighbour\'s tag cannot be borrowed',
    unreadExportWaiver('/**\n * @unread-export a real reason for the first one\n */\nexport const A = 1;\nexport const B = 2;\n', 5) === null);
  ok('deadexport: a comment mentioning a symbol does not count as reading it',
    !/\bZZZ\b/.test(stripComments('// mentions ZZZ in prose only\nconst q = 1;')));

  ok('privateinpublic: a self-declared _meta classification is refused',
    jsonSelfDeclaration({ _meta: { visibility: 'private (staff + owner)' } }) !== null);
  ok('privateinpublic: a root classification is refused',
    jsonSelfDeclaration({ classification: 'private' }) !== null);
  ok('privateinpublic: describing ANOTHER repo as private is not a self-declaration',
    jsonSelfDeclaration({ projects: [{ repo: 'Notebook-X', visibility: 'private' }] }) === null);
  ok('citedfile: a substantive register entry accounts for a missing document',
    citedAbsentRegistration('WAREHOUSE-PRODUCT-AUDIT-2026-08-14.md') === 'LOST');
  ok('citedfile: a NOT YET entry is distinguished from a LOST one',
    citedAbsentRegistration('READ-LOG.md') === 'NOT YET');
  ok('citedfile: a name with no register entry is not accounted for',
    citedAbsentRegistration('NO-SUCH-REGISTERED-DOCUMENT.md') === null);
  ok('citedfile: the register README is not itself a registration',
    citedAbsentRegistration('README.md') === null);

  ok('privateinpublic: a markdown header classification is refused',
    markdownSelfDeclaration('# Doc\n\n**Classification:** private (back office).\n') !== null);
  ok('privateinpublic: a public markdown header passes',
    markdownSelfDeclaration('# Doc\n\n**Classification:** public.\n') === null);

  const failed = results.filter((r) => !r.pass);
  return { results, failed };
}

/* ── the walk ────────────────────────────────────────────────────────────── */

export const CHECKS = Object.freeze([checkLabels, checkCiEscape, checkDeadExport, checkDeadLink, checkPrivateInPublic, checkCitedFile]);

export function walk() {
  return CHECKS.map((fn) => fn());
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--prove')) {
    const { results, failed } = probes();
    for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
    console.log(`\n${results.length - failed.length}/${results.length} probes passed.`);
    process.exit(failed.length ? 1 : 0);
  }

  const walked = walk();
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ walked }, null, 2));
  } else {
    console.log('# Failure-mode walk\n');
    console.log('The mechanized subset of KNOWN-FAILURE-MODES.md. NOT_WALKED means an');
    console.log('input was unreachable from here and is reported, never counted as a pass.\n');
    for (const r of walked) {
      console.log(`## ${r.id} (${r.kfm}) — ${r.status}`);
      console.log(`${r.reason}\n`);
      for (const f of r.findings) console.log(`- **${f.severity}** ${f.where} — ${f.what}`);
      if (r.findings.length) console.log('');
    }
    const fails = walked.filter((r) => r.status === FAIL);
    const skipped = walked.filter((r) => r.status === NOT_WALKED);
    console.log(`---\n\n${walked.length - fails.length - skipped.length} passed · ${fails.length} failed · ${skipped.length} not walked.`);
  }
  process.exit(walked.some((r) => r.status === FAIL) ? 1 : 0);
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] || '').toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch { return false; }
})();
if (invokedDirectly) main();
