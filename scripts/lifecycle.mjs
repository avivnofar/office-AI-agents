#!/usr/bin/env node
/**
 * scripts/lifecycle.mjs — THE ONE WRITER of a deliverable's lifecycle.
 *
 * Written 2026-08-10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A LOCAL CLI AND NOT A WORKER PATH
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The lifecycle record lives in `warehouse-office-AI-agents/tasks/<slug>/
 * STATE.json`, because the owner's decision of 2026-08-10 is that **work in
 * progress lives in the warehouse — all of it**, and a record that lives away
 * from its artifact goes stale the moment the artifact moves.
 *
 * **The live Worker cannot write there, and this session did not make it able
 * to.** `WAREHOUSE_REPO_TOKEN` is mapped in `config/project-permissions.json`
 * and deliberately unset — two independent locks, the code rule and the absent
 * token. Nothing in this file or in `workers/deliverable-lifecycle.js` names
 * that secret; `scripts/verify-lifecycle.js` §11 asserts both.
 *
 * So the division is:
 *
 *   THE OFFICE PROPOSES, IN BACK-OFFICE.   THIS TOOL APPLIES, IN THE WAREHOUSE.
 *
 * The Worker writes reviews, gaps, votes, recommendations and CEO decisions
 * into `back-office-AI-agents/campus/shared/lifecycle-inbox/<slug>/` — the same
 * inbox shape MEETING-PROTOCOL.md §3 already uses for meeting action items,
 * through the same `resolveRepoWrite()` path with `BACKOFFICE_REPO_TOKEN`. This
 * tool drains that inbox into the record and, IN THE SAME RUN, rewrites the
 * board's `- **Stage:**` line.
 *
 * That is not a workaround for a missing credential. It is the discipline
 * `Dispatched:` already has: two parties may propose, exactly one applies, and
 * every application is a git commit a person can read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BOARD LINE IS REWRITTEN UNCONDITIONALLY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `writeStageLine()` rewrites the line on EVERY run, from the record it just
 * wrote, whether or not it thinks the line changed. That is deliberate and it
 * is the only reconciliation point the projection has: nothing inside the
 * Worker can detect a disagreement between board and warehouse, because
 * detecting it needs a warehouse read the Worker cannot make. An
 * only-if-changed rewrite would let a drift introduced by a hand edit survive
 * indefinitely; an unconditional one bounds its life to a single run of this
 * tool.
 *
 * Zero dependencies beyond the lifecycle module. Node 18+.
 *
 * ── COMMANDS ─────────────────────────────────────────────────────────────
 *
 *   init     --slug <s> [--task OB-NNN] [--type T] [--touches a,b]
 *              Create the lifecycle record on an existing warehouse task.
 *              Refuses if one already exists — a second init would erase a
 *              review history.
 *
 *   status   --slug <s> | --all
 *              Read-only. What stage, what round, what it is waiting on, and
 *              what the office owes. Makes no writes.
 *
 *   advance  --slug <s> --to <STAGE> [--meeting <id>] [--reason <text>]
 *              Apply a transition. Refuses through canAdvance() and PRINTS
 *              THE REFUSAL — a refusal here is the useful output, not an
 *              error to be worked around.
 *
 *   ingest   --slug <s> [--inbox <dir>]
 *              Drain the back-office lifecycle inbox into the record.
 *
 *   refusal  --slug <s> --who <w> --declined <d> --line <character line>
 *            [--source <where the line lives>]
 *              Record one refusal, at the moment it happens. The character
 *              line is mandatory and cannot be supplied later.
 *
 *   regen    (no --slug)
 *              Added 2026-08-14. Mutates NO lifecycle state at all — just
 *              rewrites IN-FLIGHT.md from every record found under every
 *              known root, right now. Exists so the projection can be
 *              resynced (or a fix to writeInFlight() proven) without a real
 *              transition, ingest, or refusal as the trigger.
 *
 * Every writing command also rewrites the board Stage line unless
 * `--no-board` is passed (which exists for a dry run, not for normal use).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  STAGES, IN_FLIGHT_STAGES, LOCATIONS, DEFAULT_LOCATION, newRecord, canAdvance, applyTransition, nextAction,
  renderStageLine, reviewerCoverage, openGaps, unclassifiedGaps, renderInFlightFile,
  bindingGapsAwaitingVote, convergenceFinding, tallyVote, recordRefusal,
  renderRefusal, detectRefusals, resumeBrief, assertPhaseCompletable,
  checkRecordAttribution, checkSignoffAttribution,
  openShift, closeShift,
} from '../workers/deliverable-lifecycle.js';
import { checkAttribution } from '../workers/meeting-attendance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
/** The three repos are siblings in the owner's checkout. Every one of these is
 *  overridable on the command line, and an unresolvable path is a REFUSAL with
 *  the path named — never a silent skip that reports success over nothing. */
const SIBLINGS = path.join(REPO_ROOT, '..');
const DEFAULTS = {
  tasksDir: path.join(SIBLINGS, 'warehouse-office-AI-agents', 'tasks'),
  // ── ADDED 2026-08-14 (audit finding, this session's own root cause) ────
  // verifier-count-ledger and repo-size-hygiene-check shipped OUT of the
  // warehouse into back-office-AI-agents `tools/` this same day. A
  // deliverable's directory can now live under either root, so every
  // function below that used to take a single `tasksDir` now searches BOTH
  // — see ROOTS_OF(ctx) and resolveRoot().
  toolsDir: path.join(SIBLINGS, 'back-office-AI-agents', 'tools'),
  board: path.join(SIBLINGS, 'back-office-AI-agents', 'campus', 'shared', 'board', 'BOARD.md'),
  inbox: path.join(SIBLINGS, 'back-office-AI-agents', 'campus', 'shared', 'lifecycle-inbox'),
  inFlight: path.join(SIBLINGS, 'back-office-AI-agents', 'campus', 'shared', 'lifecycle', 'IN-FLIGHT.md'),
  // This repo's own roster. Not a sibling — agents-config.json lives beside
  // the module the gate is in, so this default resolves on any checkout of
  // office-AI-agents alone.
  agentsConfig: path.join(REPO_ROOT, 'config', 'agents-config.json'),
};

/** The roster as `[{id, name}]`. Returns `[]` on ANY failure — read, parse or
 *  shape — and `main()` refuses on an empty result rather than proceeding with
 *  a gate that cannot check existence. */
function readRoster(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return (Array.isArray(j?.agents) ? j.agents : [])
      .filter((a) => Number.isInteger(a?.id))
      .map((a) => ({ id: a.id, name: a.name }));
  } catch { return []; }
}

/** LOCATIONS is the SAME map renderStageLine()/parseStageValue() read — a
 *  location added there needs one more entry in ROOT_DIR_KEYS (which ctx
 *  field holds its resolved absolute path) to become a root this tool
 *  searches too; scripts/verify-lifecycle.js asserts every LOCATIONS key
 *  has one, so a forgotten entry is a failing check, not a silent gap. */
const ROOT_DIR_KEYS = { warehouse: 'tasksDir', 'back-office-tools': 'toolsDir' };
function rootsOf(ctx) {
  return Object.keys(LOCATIONS).map((location) => ({ location, dir: ctx[ROOT_DIR_KEYS[location]] }));
}

/* ────────────────────────────── arg parsing ────────────────────────────── */

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
function flag(argv, name) { return argv.includes(`--${name}`); }

/* ───────────────────────────── record storage ──────────────────────────── */

function statePathFor(tasksDir, slug) { return path.join(tasksDir, slug, 'STATE.json'); }
function specPathFor(tasksDir, slug) { return path.join(tasksDir, slug, 'SPEC.md'); }

/** Reads the phase list with run-controller.js's own grammar, so the two tools
 *  cannot disagree about what a phase is. */
function readPhases(specPath) {
  if (!existsSync(specPath)) return [];
  const lines = readFileSync(specPath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Phases\s*$/i.test(l.trim()));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    const m = lines[i].match(/^\s*\d+\.\s*\[(\w[\w-]*)\]\s*(.+?)\s*$/);
    if (m) out.push({ id: m[1], title: m[2] });
  }
  return out;
}

/**
 * Searches EVERY known root (rootsOf(ctx), driven by LOCATIONS) for
 * `<slug>/STATE.json`, not just one hardcoded `tasksDir` — fixed 2026-08-14.
 * Previously this took a single `tasksDir` and every caller passed
 * `ctx.tasksDir`, so a deliverable whose directory had moved to
 * back-office-AI-agents `tools/` (verifier-count-ledger,
 * repo-size-hygiene-check) was invisible to every command, including
 * `writeInFlight()`'s wholesale rewrite — which is exactly how its section
 * of IN-FLIGHT.md got silently dropped and had to be manually re-spliced in
 * (see that file's own 2026-08-14 finding note).
 *
 * The FIRST root a slug's STATE.json is found under is the resolved,
 * structural answer to "where does this deliverable actually live" — more
 * trustworthy than a `location` field the record might carry (or, for
 * every record created before this fix, does NOT carry at all). Returned as
 * `dir`/`location` so a caller can both open SPEC.md correctly and stamp
 * the record's own `location` field from ground truth rather than guessing.
 */
function readState(ctx, slug) {
  const tried = [];
  for (const root of rootsOf(ctx)) {
    const p = statePathFor(root.dir, slug);
    tried.push(p);
    if (!existsSync(p)) continue;
    try {
      return { ok: true, path: p, dir: root.dir, location: root.location, state: JSON.parse(readFileSync(p, 'utf8')) };
    } catch (e) {
      // Same posture as run-controller.js: refuse rather than reset. A corrupt
      // state file silently replaced with an empty one erases a review history.
      return { ok: false, reason: `STATE.json in ${slug} (${root.location}) is unreadable: ${e.message}. REFUSING — a reset here would erase the review history.` };
    }
  }
  return { ok: false, reason: `no STATE.json for "${slug}" under any known root — this task has never been dispatched or built. Tried: ${tried.join(', ')}` };
}

function writeState(statePath, state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/* ───────────────────── the board Stage: line (projection) ──────────────── */

/**
 * Rewrites `- **Stage:** …` inside one task block. UNCONDITIONAL — see the
 * header. Inserted directly after `State:` (and after `Dispatched:` if present)
 * so the three hold/marker lines sit together and a person reading the block
 * sees them as one group.
 */
function writeStageLine(boardText, taskId, record) {
  const lines = boardText.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^###\\s+${taskId}\\s+—`).test(l));
  if (start === -1) return { ok: false, reason: `${taskId} is not on the board` };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^###\s|^##\s/.test(lines[i])) { end = i; break; }
  }

  const wanted = renderStageLine(record);
  const existing = lines.slice(start, end).findIndex((l) => /^\s*-\s*\*\*Stage:\*\*/.test(l));
  if (existing !== -1) {
    lines[start + existing] = wanted;
    return { ok: true, action: 'replaced', line: wanted, text: lines.join('\n') };
  }

  const anchorRe = /^\s*-\s*\*\*(Dispatched|State):\*\*/;
  let anchor = -1;
  for (let i = start; i < end; i += 1) if (anchorRe.test(lines[i])) anchor = i;
  if (anchor === -1) return { ok: false, reason: `${taskId} has no State: or Dispatched: line to anchor Stage: after` };
  lines.splice(anchor + 1, 0, wanted);
  return { ok: true, action: 'inserted', line: wanted, text: lines.join('\n') };
}

/**
 * Every slug across EVERY known root, deduped and sorted — fixed 2026-08-14,
 * same root cause as readState(). A root directory that does not exist on
 * this checkout (e.g. no `tools/` yet) contributes zero entries rather than
 * refusing the whole command; `writeInFlight()` still names it explicitly
 * so a missing root reads as "0 from here" and not as silent success.
 */
function allSlugs(ctx) {
  const slugs = new Set();
  for (const root of rootsOf(ctx)) {
    if (!existsSync(root.dir)) continue;
    for (const d of readdirSync(root.dir, { withFileTypes: true })) {
      if (d.isDirectory()) slugs.add(d.name);
    }
  }
  return [...slugs].sort();
}

/* ──────────────────────────────── commands ─────────────────────────────── */

function cmdInit(argv, ctx) {
  const slug = arg(argv, 'slug');
  if (!slug) return refuse('--slug is required');
  const st = readState(ctx, slug);
  if (!st.ok) return refuse(st.reason);
  if (st.state.lifecycle) return refuse(`${slug} already has a lifecycle record (stage ${st.state.lifecycle.stage}, round ${st.state.lifecycle.round}). Re-initialising would erase its review history.`);

  const touches = (arg(argv, 'touches') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const made = newRecord({
    slug,
    boardTask: arg(argv, 'task'),
    type: arg(argv, 'type', 'warehouse-build'),
    // The root readState() actually found this slug's STATE.json under is
    // the structural ground truth for where it lives — not a --location
    // flag the caller would have to remember and could get wrong.
    location: st.location,
    touches,
    at: ctx.now,
  });
  if (!made.ok) return refuse(made.reason);

  // The build phases already completed are carried in, not re-derived: they are
  // the record of what the Architect's runs actually did, and STATE.json's
  // `completed` has been their home since 2026-08-07.
  made.record.build_completed = st.state.completed || [];

  st.state.lifecycle = made.record;
  if (!ctx.dry) writeState(st.path, st.state);

  const out = { command: 'init', slug, stage: made.record.stage, reviewer_set: made.record.reviewer_set, warnings: made.warnings, build_completed: made.record.build_completed, written: !ctx.dry };
  Object.assign(out, project(ctx, made.record));
  return out;
}

function cmdStatus(argv, ctx) {
  const slugs = flag(argv, 'all')
    ? allSlugs(ctx)
    : [arg(argv, 'slug')].filter(Boolean);
  if (!slugs.length) return refuse('--slug <s> or --all');

  const rows = [];
  for (const slug of slugs) {
    const st = readState(ctx, slug);
    if (!st.ok) { rows.push({ slug, error: st.reason }); continue; }
    const r = st.state.lifecycle;
    if (!r) {
      const phases = readPhases(specPathFor(st.dir, slug));
      const built = (st.state.completed || []).length;
      rows.push({
        slug,
        lifecycle: null,
        // Named rather than skipped: a built deliverable with no lifecycle
        // record is the exact condition this whole session exists to end, and
        // reporting it as "no data" would hide it.
        note: phases.length && built >= phases.length
          ? `BUILD-COMPLETE AND UNREVIEWED — ${built}/${phases.length} phases built and no lifecycle record exists. Nothing has reviewed this.`
          : `no lifecycle record (${built}/${phases.length || '?'} phases built)`,
      });
      continue;
    }
    const na = nextAction(r);
    rows.push({
      slug,
      stage: r.stage,
      round: r.round,
      board_task: r.board_task,
      waiting_on: na.holder,
      next: na.say,
      open_gaps: openGaps(r).length,
      unclassified_gaps: unclassifiedGaps(r).length,
      awaiting_vote: bindingGapsAwaitingVote(r).length,
      coverage_missing: reviewerCoverage(r).missing.map((m) => m.agentId),
      refusals_recorded: (r.refusals || []).length,
      refusals_unrecorded: detectRefusals(r).missing.length,
      convergence: convergenceFinding(r),
      resume: resumeBrief(r),
    });
  }
  return { command: 'status', rows };
}

function cmdAdvance(argv, ctx) {
  const slug = arg(argv, 'slug');
  const to = arg(argv, 'to');
  if (!slug || !to) return refuse('--slug <s> --to <STAGE>');
  if (!STAGES.includes(to)) return refuse(`--to must be one of ${STAGES.join(', ')}`);

  const st = readState(ctx, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);
  // Backfills `location` from ground truth on every write, not just init() —
  // fixed 2026-08-14. Every record created before this session's fix (both
  // shipped tools included) carries no `location` field at all; without this,
  // the BOARD's Stage: line (rendered from THIS `r`, not from writeInFlight()'s
  // own re-stamped copy) would keep rendering the wrong path until the record
  // happened to pass back through `init` again, which never naturally recurs.
  if (r.location !== st.location) r.location = st.location;

  // THE LIFECYCLE SIGN-OFF (OB-075, 2026-08-15). `--by` records who moved the
  // stage and was read by NOTHING until now — two live records carry
  // "10 (Architect, this session)", which is an assertion about an agent, and
  // two carry "supervised lifecycle session", which is not. Only the first
  // kind is checkable and only the first kind is checked; refusing the second
  // would push honest prose out of the field in favour of a plausible id.
  const signoff = checkSignoffAttribution(r, arg(argv, 'by'), { roster: ctx.roster });
  if (!signoff.ok) {
    return { command: 'advance', slug, from: r.stage, to, refused: true, code: 'attribution_refused', reason: signoff.reason };
  }

  const phases = readPhases(specPathFor(st.dir, slug));
  const verdict = canAdvance(r, to, {
    phases,
    completed: st.state.completed || [],
    meetingId: arg(argv, 'meeting'),
    reason: arg(argv, 'reason'),
    roundIncremented: true,
    roster: ctx.roster,
  });

  // A refusal is the useful output here, not a failure. It names which rule
  // answered — the project's own "two mechanisms agreeing by accident is not a
  // guard" rule applied to its own gate.
  if (!verdict.ok) return { command: 'advance', slug, from: r.stage, to, refused: true, code: verdict.code, reason: verdict.reason };

  const next = applyTransition(r, to, { at: ctx.now, by: arg(argv, 'by'), note: arg(argv, 'note'), meetingId: arg(argv, 'meeting') });
  if (to === 'WITHDRAWN') next.withdrawn_reason = arg(argv, 'reason');
  st.state.lifecycle = next;
  if (!ctx.dry) writeState(st.path, st.state);

  const out = { command: 'advance', slug, from: r.stage, to, round: next.round, written: !ctx.dry, next: nextAction(next).say };
  Object.assign(out, project(ctx, next));
  return out;
}

/**
 * OB-077 (2026-08-16) — **the shift writer, which did not exist.**
 *
 * `openShift()` and `closeShift()` were written with `canAdvance()` already
 * reading `record.shift` in three places, and with `assertPhaseCompletable()`
 * wired to validate it — and **nothing anywhere could produce one.** Every live
 * record carried `shift: null`, so all three consumers were reading a field no
 * code path wrote, and `verify-lifecycle.js` was the only caller of either
 * builder. That is KFM-26 in its purest form: the guard, the validator and the
 * schema were all built; the writer was the step that did not happen.
 *
 * It is WIRED rather than retired because the thing it records is policy, not
 * convenience. OFFICE-POLICY.md **A5** says a task is not expected to finish in
 * one sitting, that a shift *ends* rather than being cut off, and that the
 * agent "writes what it completed and where it stopped" — **never a partial
 * write that looks finished.** Retiring the builders would have deleted the
 * only mechanism that records A5, leaving a policy with no artifact.
 *
 * It goes HERE and nowhere else for the reason CTL-02 states: `lifecycle.mjs`
 * is THE ONE WRITER of a lifecycle record. The Worker cannot write `STATE.json`
 * at all (`WAREHOUSE_REPO_TOKEN` is deliberately unset), and adding a second
 * writer to carry shifts would trade a missing feature for the failure mode
 * that entry exists to celebrate not having.
 *
 * The refusals live in `closeShift()` and are NOT duplicated here — a SUSPENDED
 * close with no `next`, or a COMPLETED close carrying `incomplete_artifacts`,
 * is refused by the builder and reported by this command.
 *
 *   lifecycle.mjs shift --slug s --open  --phase interface [--agent 4]
 *   lifecycle.mjs shift --slug s --close --status SUSPENDED --next "..." \
 *                       --stopped-because overtime_required [--done a,b] \
 *                       [--artifacts x.js] [--incomplete-artifacts y.js]
 *   lifecycle.mjs shift --slug s --close --status COMPLETED --artifacts a.js
 */
function cmdShift(argv, ctx) {
  const slug = arg(argv, 'slug');
  if (!slug) return refuse('--slug is required');
  const opening = flag(argv, 'open');
  const closing = flag(argv, 'close');
  if (opening === closing) return refuse('pass exactly one of --open or --close');

  const st = readState(ctx, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);
  if (r.location !== st.location) r.location = st.location;

  const list = (name) => {
    const v = arg(argv, name);
    return v == null ? null : String(v).split(',').map((s) => s.trim()).filter(Boolean);
  };

  if (opening) {
    // Refused rather than silently replaced: an OPEN or SUSPENDED shift that
    // is overwritten takes `next` and `incomplete_artifacts` with it, and
    // those are precisely what the resuming shift needs. A5 — resume means
    // resume, and it cannot resume from a record that was written over.
    if (r.shift && r.shift.status !== 'COMPLETED') {
      return {
        command: 'shift', slug, refused: true, code: 'shift_already_open',
        reason: `the shift on phase "${r.shift.phase}" is ${r.shift.status} and was never closed — close it before opening another, or its "next" and half-written artifacts are lost, which is the partial-that-looks-finished failure A5 exists to prevent`,
      };
    }
    const agentRaw = arg(argv, 'agent');
    const agentId = agentRaw == null ? null : Number(agentRaw);
    // The same standard every other claim on this record is held to (OB-075):
    // a shift asserts that an agent did work, so a named agent must exist.
    if (agentId != null && !ctx.roster.some((a) => a.id === agentId)) {
      return {
        command: 'shift', slug, refused: true, code: 'attribution_refused',
        reason: `--agent ${agentRaw} is not on the roster — a shift naming an agent that does not run is the fabricated-participation shape OB-075 gated`,
      };
    }
    const opened = openShift({ phase: arg(argv, 'phase'), agentId, at: ctx.now, note: arg(argv, 'note') });
    if (!opened.ok) return { command: 'shift', slug, refused: true, code: 'open_refused', reason: opened.reason };
    r.shift = opened.shift;
    st.state.lifecycle = r;
    if (!ctx.dry) writeState(st.path, st.state);
    return { command: 'shift', slug, opened: true, phase: r.shift.phase, agent_id: r.shift.agent_id, written: !ctx.dry };
  }

  if (!r.shift) return refuse(`${slug} has no open shift to close`);
  if (r.shift.status === 'COMPLETED') return refuse(`the shift on "${r.shift.phase}" is already COMPLETED`);
  const closed = closeShift(r.shift, {
    status: arg(argv, 'status'),
    stoppedBecause: arg(argv, 'stopped-because'),
    next: arg(argv, 'next'),
    done: list('done'),
    artifacts: list('artifacts'),
    incompleteArtifacts: list('incomplete-artifacts'),
    at: ctx.now,
  });
  if (!closed.ok) return { command: 'shift', slug, refused: true, code: 'close_refused', reason: closed.reason };
  r.shift = closed.shift;
  st.state.lifecycle = r;
  if (!ctx.dry) writeState(st.path, st.state);
  return {
    command: 'shift', slug, closed: true, status: r.shift.status, phase: r.shift.phase,
    written: !ctx.dry, next: nextAction(r).say,
  };
}

/**
 * Drains the back-office lifecycle inbox.
 *
 * Inbox files are JSON, one proposal per file, named
 * `<date>-<kind>-<stamp>.json`. JSON rather than markdown for exactly one
 * reason: the meeting action-item inbox is markdown because A PERSON triages it
 * and allocates board ids by hand; these are applied mechanically by this tool
 * and a markdown parser standing between the office and its own record would be
 * a second grammar to keep in step with no human reading it.
 *
 * A file this tool cannot read is REPORTED AND LEFT IN PLACE, never deleted and
 * never partially applied — the board's own refuse-don't-guess posture.
 */
function cmdIngest(argv, ctx) {
  const slug = arg(argv, 'slug');
  if (!slug) return refuse('--slug is required');
  const st = readState(ctx, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);
  // Backfills `location` from ground truth on every write, not just init() —
  // fixed 2026-08-14. Every record created before this session's fix (both
  // shipped tools included) carries no `location` field at all; without this,
  // the BOARD's Stage: line (rendered from THIS `r`, not from writeInFlight()'s
  // own re-stamped copy) would keep rendering the wrong path until the record
  // happened to pass back through `init` again, which never naturally recurs.
  if (r.location !== st.location) r.location = st.location;

  const dir = path.join(ctx.inbox, slug);
  if (!existsSync(dir)) return { command: 'ingest', slug, applied: 0, note: `no inbox at ${dir} — the office has proposed nothing for this deliverable` };

  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const applied = [];
  const refused = [];

  for (const f of files) {
    let item;
    try { item = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { refused.push({ file: f, why: `unreadable JSON: ${e.message} — left in place` }); continue; }

    if (item.applied === true) continue;

    switch (item.kind) {
      case 'review': {
        if (!Number.isInteger(item.agent_id)) { refused.push({ file: f, why: 'no integer agent_id — REFUSED, never guessed' }); break; }
        if (!['review', 'comment', 'abstain'].includes(item.review_kind)) { refused.push({ file: f, why: `review_kind must be review|comment|abstain, got "${item.review_kind}"` }); break; }
        const att = checkRecordAttribution(r, { role: 'review', named: [item.agent_id], roster: ctx.roster });
        if (!att.ok) { refused.push({ file: f, why: `ATTRIBUTION REFUSED — ${att.reason}` }); break; }
        r.reviews.push({ agent_id: item.agent_id, round: item.round ?? r.round, kind: item.review_kind, verdict: item.verdict || null, text: item.text || null, at: item.at || null, path: item.path || null });
        applied.push({ file: f, kind: 'review', agent: item.agent_id });
        break;
      }
      case 'gap': {
        if (!item.id) { refused.push({ file: f, why: 'a gap must carry an id' }); break; }
        // `raised_by` is OPTIONAL and gated only when present. A gap may come
        // from the owner, a tool run or an audit, none of which is an agent —
        // an unattributed gap is anonymous, not falsely attributed, and those
        // are different defects with different remedies.
        if (item.raised_by != null) {
          const attG = checkRecordAttribution(r, { role: 'review', named: [item.raised_by], roster: ctx.roster });
          if (!attG.ok) { refused.push({ file: f, why: `ATTRIBUTION REFUSED — ${attG.reason}` }); break; }
        }
        r.gaps.push({ id: item.id, title: item.title || item.text || null, class: item.class || null, raised_by: item.raised_by ?? null, status: 'open', at: item.at || null });
        applied.push({ file: f, kind: 'gap', id: item.id });
        break;
      }
      case 'gap_resolution': {
        const g = r.gaps.find((x) => x.id === item.id);
        if (!g) { refused.push({ file: f, why: `gap ${item.id} is not on the record` }); break; }
        if (!['resolved', 'dismissed'].includes(item.status)) { refused.push({ file: f, why: 'status must be resolved|dismissed' }); break; }
        if (item.status === 'dismissed' && !String(item.decision || '').trim()) { refused.push({ file: f, why: 'a dismissal must carry the decision that dismissed it — moving past a gap is not deciding it' }); break; }
        g.status = item.status; g.decision = item.decision || null; g.closed_at = item.at || null;
        applied.push({ file: f, kind: 'gap_resolution', id: item.id, status: item.status });
        break;
      }
      case 'vote': {
        // MANDATORY here, optional in tallyVote() — see that function's fifth
        // refusal. A vote proposal that does not say who was in the room cannot
        // be checked against who was in the room, and passing it because the
        // evidence is missing is how "not checked" becomes "checked and fine".
        // Zero votes exist on any record, so this requirement breaks nothing.
        if (!Array.isArray(item.attendees) || !item.attendees.length) {
          refused.push({ file: f, why: 'a vote must carry `attendees` — the ids actually in the room. §4.3 casts a vote AT a meeting, and an admin who was not there did not vote. REFUSED, never tallied on roster membership alone' });
          break;
        }
        const t = tallyVote(item, { attendees: item.attendees });
        if (!t.ok) { refused.push({ file: f, why: t.reason }); break; }
        const attV = checkAttribution(item.attendees, item.attendees, ctx.roster);
        if (attV.unknown.length) { refused.push({ file: f, why: `ATTRIBUTION REFUSED — the attendee list names agent(s) ${attV.unknown.join(', ')} who are not on the roster` }); break; }
        r.votes.push({ ...item, tally: t.tally, outcome: t.outcome, resolution: t.resolution });
        applied.push({ file: f, kind: 'vote', outcome: t.outcome });
        break;
      }
      case 'recommendation': {
        if (!String(item.text || '').trim()) { refused.push({ file: f, why: 'a recommendation with no text is an approval request wearing its name' }); break; }
        // `by` becomes REQUIRED (OB-075). It was `item.by ?? null` and nothing
        // downstream read it, so an unsigned recommendation could carry a
        // deliverable to the CEO with nobody's name on it. No record holds a
        // recommendation today, so requiring it costs nothing and closes it
        // while latent.
        if (!Number.isInteger(item.by)) { refused.push({ file: f, why: 'a recommendation must name the agent making it (`by`, an integer id) — the CEO answers a recommendation, and one nobody signed cannot be reviewed later' }); break; }
        const attR = checkRecordAttribution(r, { role: 'recommendation', named: [item.by], roster: ctx.roster });
        if (!attR.ok) { refused.push({ file: f, why: `ATTRIBUTION REFUSED — ${attR.reason}` }); break; }
        r.recommendation = { text: item.text, by: item.by, at: item.at || null };
        applied.push({ file: f, kind: 'recommendation' });
        break;
      }
      case 'approval': {
        if (!['approve', 'return'].includes(item.decision)) { refused.push({ file: f, why: 'decision must be approve|return' }); break; }
        // THE HIGHEST-CONSEQUENCE CHECK IN THIS FILE. An approval is the one
        // artifact here that can send work to a client, and `item.by` was
        // copied in unchecked — the CLIENT-READY guard's comparison happened
        // later, at the transition, on a value this loop had already trusted.
        if (!Number.isInteger(item.by)) { refused.push({ file: f, why: 'an approval must name the approving agent (`by`, an integer id) — REFUSED, never guessed' }); break; }
        const attA = checkRecordAttribution(r, { role: 'approval', named: [item.by], roster: ctx.roster });
        if (!attA.ok) { refused.push({ file: f, why: `ATTRIBUTION REFUSED — ${attA.reason}` }); break; }
        r.approval = { by: item.by, decision: item.decision, reason: item.reason || null, at: item.at || null };
        applied.push({ file: f, kind: 'approval', decision: item.decision });
        break;
      }
      case 'refusal': {
        // B5's own words: "<who> declined <what>". `who` is prose, so this
        // refuses only a claim it can actually read — see
        // checkSignoffAttribution(); "the supervised session" names no agent
        // and passes, "Agent 4" on a deliverable Agent 4 never touched does not.
        const attF = checkSignoffAttribution(r, item.who, { roster: ctx.roster, role: 'review' });
        if (!attF.ok) { refused.push({ file: f, why: `ATTRIBUTION REFUSED — ${attF.reason}` }); break; }
        const rec = recordRefusal({ who: item.who, declined: item.declined, characterLine: item.character_line, source: item.source, at: item.at });
        if (!rec.ok) { refused.push({ file: f, why: rec.reason }); break; }
        r.refusals.push({ ...rec.refusal, moment: item.moment || null });
        applied.push({ file: f, kind: 'refusal', line: renderRefusal(rec.refusal) });
        break;
      }
      default:
        refused.push({ file: f, why: `unknown kind "${item.kind}"` });
    }

    if (applied.some((a) => a.file === f) && !ctx.dry) {
      item.applied = true;
      item.applied_at = ctx.now;
      writeFileSync(path.join(dir, f), `${JSON.stringify(item, null, 2)}\n`);
    }
  }

  st.state.lifecycle = r;
  if (!ctx.dry) writeState(st.path, st.state);

  const out = { command: 'ingest', slug, applied, refused, stage: r.stage, next: nextAction(r).say, written: !ctx.dry };
  Object.assign(out, project(ctx, r));
  return out;
}

function cmdRefusal(argv, ctx) {
  const slug = arg(argv, 'slug');
  if (!slug) return refuse('--slug is required');
  const st = readState(ctx, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);
  // Backfills `location` from ground truth on every write, not just init() —
  // fixed 2026-08-14. Every record created before this session's fix (both
  // shipped tools included) carries no `location` field at all; without this,
  // the BOARD's Stage: line (rendered from THIS `r`, not from writeInFlight()'s
  // own re-stamped copy) would keep rendering the wrong path until the record
  // happened to pass back through `init` again, which never naturally recurs.
  if (r.location !== st.location) r.location = st.location;

  // Same gate as the inbox's `refusal` kind — one mechanism, both doors.
  const attF = checkSignoffAttribution(r, arg(argv, 'who'), { roster: ctx.roster, role: 'review' });
  if (!attF.ok) return refuse(`ATTRIBUTION REFUSED — ${attF.reason}`);

  const rec = recordRefusal({
    who: arg(argv, 'who'),
    declined: arg(argv, 'declined'),
    characterLine: arg(argv, 'line'),
    source: arg(argv, 'source'),
    at: ctx.now,
  });
  if (!rec.ok) return refuse(rec.reason);

  r.refusals.push({ ...rec.refusal, moment: arg(argv, 'moment') });
  st.state.lifecycle = r;
  if (!ctx.dry) writeState(st.path, st.state);
  return { command: 'refusal', slug, line: renderRefusal(rec.refusal), written: !ctx.dry };
}

/**
 * No `--slug`, mutates no lifecycle state — resyncs BOTH projections (board
 * Stage: lines and IN-FLIGHT.md) from every root, right now. See the
 * header's "regen" entry.
 *
 * Rewrites every record's board Stage: line the same way project() does for
 * one record after a real command — the missing half `regen` shipped without
 * at first: IN-FLIGHT.md alone does not touch BOARD.md, and BOARD.md's own
 * Stage: line for OB-018 is the documented stale case (`warehouse
 * \`tasks/verifier-count-ledger/\`` — see that task's own 2026-08-14 Notes:
 * line) this command exists to actually correct, not just describe.
 */
function cmdRegen(argv, ctx) {
  const boardResults = [];
  for (const root of rootsOf(ctx)) {
    if (!existsSync(root.dir)) continue;
    for (const d of readdirSync(root.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const st = readState(ctx, d.name);
      if (!st.ok || !st.state.lifecycle) continue;
      const r = st.state.lifecycle;
      const locationChanged = r.location !== st.location;
      if (locationChanged) r.location = st.location;
      // The record's own STATE.json is rewritten whenever `location` was
      // backfilled, EVEN for a record with no board_task (repo-size-hygiene-
      // check has none) — so a LATER run sees the same ground truth this run
      // just derived, not the same absence again. Kept independent of the
      // board-task branch below on purpose: a record without a board task
      // still deserves its own state written correctly.
      if (locationChanged && !ctx.dry) writeState(st.path, st.state);
      if (!r.board_task) continue;
      const res = maybeWriteBoard(ctx, r);
      boardResults.push({ slug: d.name, board_task: r.board_task, ...res });
    }
  }
  return { command: 'regen', board: boardResults, inFlight: writeInFlight(ctx) };
}

/* ─────────────────────────────── the board ─────────────────────────────── */

/**
 * THE TWO PROJECTIONS, WRITTEN IN ONE ACT.
 *
 * There is no code path in this tool that writes one and not the other, which
 * is what makes two derived views of one record safe rather than the drift this
 * project has been burned by six times. Both are unconditional.
 */
function project(ctx, record) {
  return { board: maybeWriteBoard(ctx, record), inFlight: writeInFlight(ctx) };
}

function maybeWriteBoard(ctx, record) {
  if (ctx.noBoard) return { skipped: 'board write disabled with --no-board' };
  if (!record.board_task) return { skipped: 'this deliverable has no board task — nothing to project onto' };
  if (!existsSync(ctx.board)) return { skipped: `board not found at ${ctx.board}` };
  const text = readFileSync(ctx.board, 'utf8');
  const res = writeStageLine(text, record.board_task, record);
  if (!res.ok) return { skipped: res.reason };
  if (!ctx.dry) writeFileSync(ctx.board, res.text);
  return { action: res.action, line: res.line, written: !ctx.dry };
}

/**
 * Rewrites `back-office/campus/shared/lifecycle/IN-FLIGHT.md` WHOLESALE from
 * every record found under EVERY known root — not from the one record that
 * just changed, and not from one hardcoded `tasksDir` (fixed 2026-08-14).
 *
 * Previously this walked ONE `--tasks-dir` only. verifier-count-ledger and
 * repo-size-hygiene-check shipped OUT of the warehouse into back-office
 * `tools/` the same day this was found, so the ONE run of this tool that
 * regenerated the file after that move silently dropped their section —
 * no code path here ever saw them, because their directory was never under
 * `tasksDir` to begin with. See this file's own IN-FLIGHT.md finding note
 * (2026-08-14) for the hand-splice that covered for it before this fix.
 *
 * Wholesale is still the point: a deliverable that reached CLIENT-READY has
 * to DISAPPEAR from this file, and an incremental writer would leave a tail
 * of finished work that every meeting keeps reading as in flight. Now
 * "wholesale" correctly means every root, not every directory under one of
 * them.
 *
 * Each record's `location` is stamped from the root it was ACTUALLY found
 * under (readState()'s structural answer), overwriting whatever the stored
 * record says — including every record written before this fix, which
 * carries no `location` field at all and would otherwise render (via
 * renderStageLine()'s default) as `warehouse`, wrong for the two tools.
 */
function writeInFlight(ctx) {
  if (ctx.noBoard) return { skipped: 'projection disabled with --no-board' };
  const dir = path.dirname(ctx.inFlight);
  const records = [];
  const rootsScanned = [];
  for (const root of rootsOf(ctx)) {
    if (!existsSync(root.dir)) { rootsScanned.push({ ...root, found: false, note: 'directory does not exist on this checkout' }); continue; }
    let count = 0;
    for (const d of readdirSync(root.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const st = readState(ctx, d.name);
      if (st.ok && st.state.lifecycle) { records.push({ ...st.state.lifecycle, location: st.location }); count += 1; }
    }
    rootsScanned.push({ ...root, found: true, records: count });
  }
  const text = renderInFlightFile(records, { at: ctx.now });
  if (!ctx.dry) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ctx.inFlight, text);
  }
  return {
    path: ctx.inFlight,
    in_flight: records.filter((r) => IN_FLIGHT_STAGES.includes(r.stage)).length,
    total_records: records.length,
    roots_scanned: rootsScanned,
    written: !ctx.dry,
  };
}

/* ──────────────────────────────── driver ───────────────────────────────── */

function refuse(reason) { return { refused: true, reason }; }

function main(argv) {
  const cmd = argv[0];
  const ctx = {
    tasksDir: arg(argv, 'tasks-dir', DEFAULTS.tasksDir),
    // --tools-dir, added 2026-08-14 alongside the multi-root fix — the
    // second root a slug's STATE.json may now live under.
    toolsDir: arg(argv, 'tools-dir', DEFAULTS.toolsDir),
    board: arg(argv, 'board', DEFAULTS.board),
    inbox: arg(argv, 'inbox', DEFAULTS.inbox),
    inFlight: arg(argv, 'in-flight', DEFAULTS.inFlight),
    now: arg(argv, 'now', new Date().toISOString()),
    dry: flag(argv, 'dry-run'),
    noBoard: flag(argv, 'no-board'),
    // THE ROSTER, read here and passed down (OB-075, 2026-08-15).
    // deliverable-lifecycle.js may not import JSON — see its header — so the
    // caller that already reads files does it. An unreadable roster is a
    // REFUSAL, never an empty array: an empty roster silently turns the
    // "does this agent exist at all" half of the attribution gate off, and a
    // gate that disables itself when its input is missing is the fail-open
    // shape this project found on 2026-08-06.
    roster: readRoster(arg(argv, 'agents-config', DEFAULTS.agentsConfig)),
  };
  if (!ctx.roster.length) {
    console.log(JSON.stringify(refuse(`could not read the agent roster from ${arg(argv, 'agents-config', DEFAULTS.agentsConfig)} — the attribution gate cannot run without it, and running without it would pass every claim. Pass --agents-config <path>.`), null, 2));
    return 4;
  }

  const commands = { init: cmdInit, status: cmdStatus, advance: cmdAdvance, ingest: cmdIngest, refusal: cmdRefusal, regen: cmdRegen, shift: cmdShift };
  if (!commands[cmd]) {
    console.error('usage: lifecycle.mjs <init|status|advance|ingest|refusal|regen|shift> [--slug s] [options]');
    return 2;
  }
  // At least ONE root must exist to search at all — refusing here rather
  // than per-command keeps every command's own error message about the
  // SLUG, not the filesystem. A single missing root (e.g. no `tools/`
  // checked out yet) is NOT refused here; rootsOf()'s callers already treat
  // a missing individual root as "0 entries from it", reported rather than
  // silent (see writeInFlight()'s roots_scanned).
  const existingRoots = rootsOf(ctx).filter((r) => existsSync(r.dir));
  if (!existingRoots.length) {
    const tried = rootsOf(ctx).map((r) => `${r.location}: ${r.dir}`).join(', ');
    console.log(JSON.stringify(refuse(`no known root exists on this checkout. Tried — ${tried}. Pass --tasks-dir / --tools-dir.`), null, 2));
    return 3;
  }

  const out = commands[cmd](argv, ctx);
  console.log(JSON.stringify(out, null, 2));
  // `=== true` and not truthy — cmdIngest()'s `refused` field is an ARRAY of
  // per-file refusals (empty on full success), a different shape than the
  // boolean `{refused: true, reason}` refuse() returns for init/advance/
  // refusal. A bare truthy check treated `refused: []` as a failure, so a
  // fully successful ingest (found live, 2026-08-11: 2 applied, 0 refused)
  // still exited 3 — silently misreporting success as failure to anything
  // reading the exit code rather than the JSON body.
  return out?.refused === true ? 3 : 0;
}

process.exit(main(process.argv.slice(2)));
