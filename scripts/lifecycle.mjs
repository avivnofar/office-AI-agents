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
 * Every writing command also rewrites the board Stage line unless
 * `--no-board` is passed (which exists for a dry run, not for normal use).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  STAGES, IN_FLIGHT_STAGES, newRecord, canAdvance, applyTransition, nextAction,
  renderStageLine, reviewerCoverage, openGaps, unclassifiedGaps, renderInFlightFile,
  bindingGapsAwaitingVote, convergenceFinding, tallyVote, recordRefusal,
  renderRefusal, detectRefusals, resumeBrief, assertPhaseCompletable,
} from '../workers/deliverable-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
/** The three repos are siblings in the owner's checkout. Every one of these is
 *  overridable on the command line, and an unresolvable path is a REFUSAL with
 *  the path named — never a silent skip that reports success over nothing. */
const SIBLINGS = path.join(REPO_ROOT, '..');
const DEFAULTS = {
  tasksDir: path.join(SIBLINGS, 'warehouse-office-AI-agents', 'tasks'),
  board: path.join(SIBLINGS, 'back-office-AI-agents', 'campus', 'shared', 'board', 'BOARD.md'),
  inbox: path.join(SIBLINGS, 'back-office-AI-agents', 'campus', 'shared', 'lifecycle-inbox'),
  inFlight: path.join(SIBLINGS, 'back-office-AI-agents', 'campus', 'shared', 'lifecycle', 'IN-FLIGHT.md'),
};

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

function readState(tasksDir, slug) {
  const p = statePathFor(tasksDir, slug);
  if (!existsSync(p)) return { ok: false, reason: `no STATE.json at ${p} — this task has never been dispatched or built` };
  try {
    return { ok: true, path: p, state: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    // Same posture as run-controller.js: refuse rather than reset. A corrupt
    // state file silently replaced with an empty one erases a review history.
    return { ok: false, reason: `STATE.json in ${slug} is unreadable: ${e.message}. REFUSING — a reset here would erase the review history.` };
  }
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

/* ──────────────────────────────── commands ─────────────────────────────── */

function cmdInit(argv, ctx) {
  const slug = arg(argv, 'slug');
  if (!slug) return refuse('--slug is required');
  const st = readState(ctx.tasksDir, slug);
  if (!st.ok) return refuse(st.reason);
  if (st.state.lifecycle) return refuse(`${slug} already has a lifecycle record (stage ${st.state.lifecycle.stage}, round ${st.state.lifecycle.round}). Re-initialising would erase its review history.`);

  const touches = (arg(argv, 'touches') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const made = newRecord({
    slug,
    boardTask: arg(argv, 'task'),
    type: arg(argv, 'type', 'warehouse-build'),
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
    ? readdirSync(ctx.tasksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [arg(argv, 'slug')].filter(Boolean);
  if (!slugs.length) return refuse('--slug <s> or --all');

  const rows = [];
  for (const slug of slugs) {
    const st = readState(ctx.tasksDir, slug);
    if (!st.ok) { rows.push({ slug, error: st.reason }); continue; }
    const r = st.state.lifecycle;
    if (!r) {
      const phases = readPhases(specPathFor(ctx.tasksDir, slug));
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

  const st = readState(ctx.tasksDir, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);

  const phases = readPhases(specPathFor(ctx.tasksDir, slug));
  const verdict = canAdvance(r, to, {
    phases,
    completed: st.state.completed || [],
    meetingId: arg(argv, 'meeting'),
    reason: arg(argv, 'reason'),
    roundIncremented: true,
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
  const st = readState(ctx.tasksDir, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);

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
        r.reviews.push({ agent_id: item.agent_id, round: item.round ?? r.round, kind: item.review_kind, verdict: item.verdict || null, text: item.text || null, at: item.at || null, path: item.path || null });
        applied.push({ file: f, kind: 'review', agent: item.agent_id });
        break;
      }
      case 'gap': {
        if (!item.id) { refused.push({ file: f, why: 'a gap must carry an id' }); break; }
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
        const t = tallyVote(item, {});
        if (!t.ok) { refused.push({ file: f, why: t.reason }); break; }
        r.votes.push({ ...item, tally: t.tally, outcome: t.outcome, resolution: t.resolution });
        applied.push({ file: f, kind: 'vote', outcome: t.outcome });
        break;
      }
      case 'recommendation': {
        if (!String(item.text || '').trim()) { refused.push({ file: f, why: 'a recommendation with no text is an approval request wearing its name' }); break; }
        r.recommendation = { text: item.text, by: item.by ?? null, at: item.at || null };
        applied.push({ file: f, kind: 'recommendation' });
        break;
      }
      case 'approval': {
        if (!['approve', 'return'].includes(item.decision)) { refused.push({ file: f, why: 'decision must be approve|return' }); break; }
        r.approval = { by: item.by, decision: item.decision, reason: item.reason || null, at: item.at || null };
        applied.push({ file: f, kind: 'approval', decision: item.decision });
        break;
      }
      case 'refusal': {
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
  const st = readState(ctx.tasksDir, slug);
  if (!st.ok) return refuse(st.reason);
  const r = st.state.lifecycle;
  if (!r) return refuse(`${slug} has no lifecycle record — run \`init\` first`);

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
 * every warehouse record — not from the one record that just changed.
 *
 * Wholesale is the point: a deliverable that reached CLIENT-READY has to
 * DISAPPEAR from this file, and an incremental writer would leave a tail of
 * finished work that every meeting keeps reading as in flight. It is also the
 * only reconciliation the projection has, for the same reason the board line's
 * rewrite is unconditional.
 */
function writeInFlight(ctx) {
  if (ctx.noBoard) return { skipped: 'projection disabled with --no-board' };
  const dir = path.dirname(ctx.inFlight);
  const records = [];
  for (const d of readdirSync(ctx.tasksDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const st = readState(ctx.tasksDir, d.name);
    if (st.ok && st.state.lifecycle) records.push(st.state.lifecycle);
  }
  const text = renderInFlightFile(records, { at: ctx.now });
  if (!ctx.dry) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ctx.inFlight, text);
  }
  return { path: ctx.inFlight, in_flight: records.filter((r) => IN_FLIGHT_STAGES.includes(r.stage)).length, total_records: records.length, written: !ctx.dry };
}

/* ──────────────────────────────── driver ───────────────────────────────── */

function refuse(reason) { return { refused: true, reason }; }

function main(argv) {
  const cmd = argv[0];
  const ctx = {
    tasksDir: arg(argv, 'tasks-dir', DEFAULTS.tasksDir),
    board: arg(argv, 'board', DEFAULTS.board),
    inbox: arg(argv, 'inbox', DEFAULTS.inbox),
    inFlight: arg(argv, 'in-flight', DEFAULTS.inFlight),
    now: arg(argv, 'now', new Date().toISOString()),
    dry: flag(argv, 'dry-run'),
    noBoard: flag(argv, 'no-board'),
  };

  const commands = { init: cmdInit, status: cmdStatus, advance: cmdAdvance, ingest: cmdIngest, refusal: cmdRefusal };
  if (!commands[cmd]) {
    console.error('usage: lifecycle.mjs <init|status|advance|ingest|refusal> [--slug s] [options]');
    return 2;
  }
  if (!existsSync(ctx.tasksDir)) {
    console.log(JSON.stringify(refuse(`tasks dir not found: ${ctx.tasksDir} — pass --tasks-dir`), null, 2));
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
