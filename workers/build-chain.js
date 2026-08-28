/**
 * workers/build-chain.js — THE QUEUE THAT PUTS THE BUILD CHAIN ON A TICK.
 *
 * Written 2026-08-28 (Session 33, Item B). Imports nothing, same rule as
 * `admin-desk.js` and for the same reason: `scripts/verify-build-chain.js` can
 * load and CALL it rather than hand-mirroring it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT WAS MISSING, AND IT WAS NOT THE BLOCKS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Session 31 built the whole chain and ran it live: a spec, an artifact, three
 * repair rounds, two correct Architect blocks, and a verified merge capability.
 * Both `processRepairBlock()` and `processArchitectApprovalBlock()` work.
 *
 * **They were unschedulable, and not because nobody had written the cron
 * entry.** Each takes `{ slug, agentId, findingText }` as arguments. A tick has
 * no arguments. So the missing piece was never a schedule line — it was
 * somewhere for the chain to remember what it was in the middle of.
 *
 * ── WHY THE QUEUE FILLS ITSELF, WHICH IS THE ONLY REASON THIS WORKS ───────
 *
 * There is no source of blocking findings for a warehouse artifact. The review
 * desk cannot review one at all: the Worker holds no warehouse read token, so
 * `processAdminDeskBlock()` records every warehouse-located deliverable as
 * `unreadable` and draws no slot for it (session 30, item A).
 *
 * The Architect's approval is therefore both the CONSUMER and the PRODUCER of
 * findings on this path. A `block` verdict's `reasoning` IS the next repair's
 * finding — Session 31 proved that empirically, twice, with two correct blocks
 * that each named a real defect. So:
 *
 *     build_artifact ──▶ AWAITING-APPROVAL
 *                             │
 *              architect_approval draws it
 *                       ┌─────┴─────┐
 *                  approve         block
 *                       │             │  reasoning becomes `finding`
 *                    MERGED    AWAITING-REPAIR
 *                                     │
 *                            repair draws it
 *                              ┌──────┴──────┐
 *                          repaired      3rd strike
 *                              │              │
 *                    AWAITING-APPROVAL     STALLED
 *
 * The loop is closed and bounded: `repairDecision()` (admin-desk.js) refuses a
 * third attempt at the same finding, so a task that cannot converge STALLS and
 * is surfaced once, rather than spending the budget forever.
 *
 * ── THE ENTRY POINT IS STILL SUPERVISED, AND THAT IS SAID HERE, NOT HIDDEN ─
 *
 * `build_artifact` — the block that CREATES an `AWAITING-APPROVAL` row — is
 * **not on the schedule.** Session 31 gave it exactly one supervised live run,
 * and CLAUDE.md's graduated-rollout rule ("supervised run -> small unattended
 * window -> full schedule") is not satisfied by one. Putting the office's
 * first autonomous code-artifact writer on a timer is a separate owner
 * decision and this session does not take it.
 *
 * **The consequence, stated rather than discovered later: once the seeded
 * queue drains, these two blocks have no autonomous source of work.** They
 * will report an empty queue and write nothing, which is correct behaviour and
 * is exactly what Item A's daily check will then catch as a day that produced
 * nothing. That is the intended sequence, not an oversight.
 */

/* ─────────────────────────────── The states ─────────────────────────────── */

/** Waiting for the Architect's verdict. Set by a build, and by a repair. */
export const AWAITING_APPROVAL = 'AWAITING-APPROVAL';
/** The Architect blocked. `finding` holds his reasoning, verbatim. */
export const AWAITING_REPAIR = 'AWAITING-REPAIR';
/** Approved and merged to main, verified by a fresh read of main. */
export const MERGED = 'MERGED';
/**
 * Approved, but there was nothing to merge (the artifact never left main) or
 * the merge hit a conflict. A DISTINCT state from MERGED, deliberately: the
 * brief that built `mergeBranchToMain()` calls an unmerged-on-conflict
 * artifact "a fine outcome", and collapsing it into MERGED would make a
 * conflict indistinguishable from a merge nobody has to look at.
 */
export const APPROVED_UNMERGED = 'APPROVED-UNMERGED';
/** Three strikes on one finding. Surfaced to the owner; drawn no more. */
export const STALLED = 'STALLED';

export const TERMINAL_STATES = Object.freeze([MERGED, APPROVED_UNMERGED, STALLED]);

/* ──────────────────────────────── The caps ──────────────────────────────── */

/**
 * ONE REPAIR PER TICK, and the number comes from Session 31's measurements
 * rather than from caution.
 *
 * A repair is one Cerebras `build_artifact`-lane call producing a COMPLETE
 * file — Session 31 measured that lane's real output at up to 371 lines and
 * set its `max_tokens` from that measurement. Two in one invocation would be
 * two whole-file generations plus four GitHub commits against Cloudflare's
 * 50-subrequest ceiling, which is the incident OB-074 exists because of.
 *
 * It is also the right number for a reason that is not about subrequests: a
 * repair addresses ONE named finding, and the next finding is not known until
 * the Architect has looked at the repaired file. Two repairs per tick would
 * mean the second one repairing against a finding raised before the first one
 * landed. The chain is inherently one-round-at-a-time.
 */
export const MAX_REPAIRS_PER_TICK = 1;

/**
 * ONE APPROVAL PER TICK, and this one is a MONEY ceiling as much as a
 * subrequest one.
 *
 * Every approval is a direct Anthropic call on the `component:'architect'`
 * sub-budget, which is $1.00/month — the smallest of the three Claude
 * sub-budgets. Session 31 spent 6 Anthropic calls in a single supervised
 * session and stopped deliberately with 2 of its 12 remaining.
 *
 * At one per weekday that is ~22 approvals a month, which the sub-budget can
 * carry. At two it is ~44, and the budget is the thing that would run out
 * first — silently, mid-month, refusing every approval for the remainder while
 * the repair loop kept queueing work for it. That failure mode is why the
 * ceiling is 1 and not 2.
 */
export const MAX_APPROVALS_PER_TICK = 1;

/* ─────────────────────────────── The table ──────────────────────────────── */

/**
 * Lazily created, deliberately NOT in `database/schema.sql` — `repo_writes`,
 * `owner_notifications`, `block_admissions` and `daily_obligation` all took
 * the same decision for the same reason.
 *
 * Keyed on `slug`, not on a generated id: a warehouse task directory has ONE
 * position in the chain at a time. Two rows for one slug would mean a repair
 * and an approval could be drawn for the same file in the same day, each
 * unaware of the other — and the second would overwrite the first's commit.
 *
 * `finding` is stored as the Architect's reasoning VERBATIM, not summarised.
 * `admin-desk.js` `fingerprintFinding()` hashes the normalised text to decide
 * the three-strike count, so a paraphrase here would break strike detection
 * across rounds — the same finding would fingerprint differently each time and
 * the loop would never stop.
 */
export const BUILD_CHAIN_TABLE_SQL = `CREATE TABLE IF NOT EXISTS build_chain (
  slug TEXT PRIMARY KEY,
  task_id TEXT,
  agent_id INTEGER,
  state TEXT NOT NULL,
  finding TEXT,
  rounds INTEGER DEFAULT 0,
  last_detail TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/* ──────────────────────────────── The draws ─────────────────────────────── */

/**
 * The repair queue: rows at `AWAITING-REPAIR` that carry a finding to repair
 * against, oldest first.
 *
 * **A row with no finding text is SKIPPED, never repaired against nothing.**
 * `processRepairBlock()` requires `findingText` and would refuse anyway, but
 * refusing here means the reason is reported as a skip rather than surfacing
 * as a generic argument error one layer down. An empty finding on an
 * AWAITING-REPAIR row is a defect in whatever wrote it, and it should look
 * like one.
 *
 * @param {Array<object>} rows - build_chain rows
 * @param {{max?: number}} [opts]
 * @returns {{draw: Array<object>, deferred: Array<object>, skipped: Array<object>}}
 */
export function repairQueue(rows = [], opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_REPAIRS_PER_TICK;
  const draw = [];
  const deferred = [];
  const skipped = [];
  for (const row of rows || []) {
    if (!row || row.state !== AWAITING_REPAIR) continue;
    if (!row.slug) { skipped.push({ slug: null, why: 'row carries no slug' }); continue; }
    if (!String(row.finding || '').trim()) {
      skipped.push({ slug: row.slug, why: 'AWAITING-REPAIR with no finding text — nothing to repair against, and repairing against nothing is how a build gets rewritten for no reason' });
      continue;
    }
    // `Number(null)` is 0 and `Number.isInteger(0)` is true, so a null agent
    // id passed a plain isInteger check and reached the repair as "Agent 0".
    // Caught by verify-build-chain.js §2 before this ever ran.
    const agentId = Number(row.agent_id);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      skipped.push({ slug: row.slug, why: 'no usable agent id recorded — the repair would have no persona answerable for it' });
      continue;
    }
    (draw.length < max ? draw : deferred).push(row);
  }
  return { draw, deferred, skipped };
}

/**
 * The approval queue: rows at `AWAITING-APPROVAL`, oldest first.
 *
 * No finding is required here — an approval is the Architect looking at the
 * artifact against its own spec, which is exactly what he can do with nothing
 * else in hand.
 */
export function approvalQueue(rows = [], opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_APPROVALS_PER_TICK;
  const draw = [];
  const deferred = [];
  const skipped = [];
  for (const row of rows || []) {
    if (!row || row.state !== AWAITING_APPROVAL) continue;
    if (!row.slug) { skipped.push({ slug: null, why: 'row carries no slug' }); continue; }
    (draw.length < max ? draw : deferred).push(row);
  }
  return { draw, deferred, skipped };
}

/**
 * The next state after an approval attempt, from `processArchitectApprovalBlock()`'s
 * own return shape. Pure, so the state machine can be exercised without a
 * model call — which is the only way the transitions get tested at all, given
 * that every real one costs money.
 *
 * A result that is NOT `ok` leaves the row exactly where it was. That is
 * deliberate and it is the opposite of the tempting default: a failed
 * Anthropic call, an exhausted budget or an unreadable spec says NOTHING about
 * the artifact, and moving the row on a transport failure would silently
 * convert "we could not ask" into "he did not object".
 */
export function nextStateAfterApproval(result) {
  if (!result?.ok) return { state: null, reason: `approval did not complete (${result?.reason || 'no reason given'}) — the row stays where it was` };
  if (result.verdict === 'block') {
    return { state: AWAITING_REPAIR, finding: String(result.reasoning || '').trim(), reason: 'the Architect blocked; his reasoning is the next repair finding' };
  }
  if (result.verdict === 'approve' && result.merged) {
    return { state: MERGED, finding: null, reason: `merged${result.verifiedOnMain ? ' and verified by a fresh read of main' : ' — BUT NOT VERIFIED on main, which is a weaker fact and is recorded as one'}` };
  }
  if (result.verdict === 'approve') {
    return { state: APPROVED_UNMERGED, finding: null, reason: result.mergeReason || result.conflict ? `approved, not merged: ${result.mergeReason || 'conflict'}` : 'approved, nothing to merge' };
  }
  return { state: null, reason: `unrecognised verdict ${JSON.stringify(result.verdict)} — the row stays where it was` };
}

/** The next state after a repair attempt, from `processRepairBlock()`'s return shape. */
export function nextStateAfterRepair(result) {
  if (!result?.ok) return { state: null, reason: `repair did not complete (${result?.reason || 'no reason given'}) — the row stays where it was` };
  if (result.action === 'stop_surface_to_owner') {
    return { state: STALLED, finding: null, reason: `three strikes on finding ${result.fingerprint} — surfaced to the owner, drawn no more` };
  }
  if (result.action === 'repaired') {
    // The finding is CLEARED on a successful repair, and that is load-bearing:
    // whether it was actually fixed is the Architect's call, not the repairer's.
    // Leaving it set would hand the next approval a finding it has already
    // been repaired against, and the Architect would be judging the fix
    // against a complaint the fix was written from.
    return { state: AWAITING_APPROVAL, finding: null, reason: `repaired on branch ${result.branch}, round ${result.strikeCount}` };
  }
  return { state: null, reason: `unrecognised repair action ${JSON.stringify(result.action)} — the row stays where it was` };
}

/**
 * One line per desk, the same shape `admin-desk.js` `deskSummary()` produces
 * and for the same reason: a desk that drew nothing says so HERE and writes
 * nothing anywhere.
 */
export function chainSummary(results = []) {
  return (results || []).map((r) => {
    if (!r) return '- (a build-chain desk returned nothing at all — that is a defect, not an empty queue)';
    if (r.produced > 0) return `- **${r.desk}**: ${r.produced} of ${r.queued} drawn — ${r.detail || 'no detail recorded'}.`;
    if (r.queued === 0) return `- **${r.desk}**: queue empty — nothing written, nothing recorded.`;
    return `- **${r.desk}**: ${r.queued} queued and 0 produced — ${r.reason || 'no reason given, which is itself a defect'}.`;
  });
}
