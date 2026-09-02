/**
 * workers/daily-obligation.js — A DAY THAT PRODUCES NOTHING IS A FAILURE,
 * AND IT IS REPORTED.
 *
 * Written 2026-08-28 (Session 33, Item A). Imports nothing — the rule
 * `admin-desk.js`, `owner-notify.js`, `deliverable-lifecycle.js`,
 * `task-router.js` and `permission-guard.js` all keep, and for the same
 * reason: `scripts/verify-daily-obligation.js` can then load and CALL this
 * module instead of hand-mirroring its rules, and a verifier that mirrors the
 * logic it checks proves only that somebody copied it correctly once.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The office produced its first real build artifact on 2026-08-27
 * (`warehouse tasks/dependency-audit/audit.py`, 371 lines) and produced
 * nothing on 2026-08-28. That day's standup assigned five action items at
 * 08:30 and eleven hours later there were zero interactions and zero artifact
 * writes.
 *
 * **Without a check, a quiet day looks exactly like a broken one.** Both
 * produce the same evidence: a green cron, a committed daily summary saying
 * the office met, and nobody finding out. That is this estate's single
 * most-repeated failure shape (`docs/decisions/ARCHITECTURAL-DECISIONS.md`
 * §7 lists six instances), applied to output rather than to a gate.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS, AND THE ONE PLACE THE TWO LISTS APPEAR TO COLLIDE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The owner's list, in his words, and it is NOT softened here:
 *
 *   AN ARTIFACT IS SOMETHING A PERSON CAN OPEN AND USE.
 *     - a file in the warehouse
 *     - a filed review or abstention
 *     - a completed analysis
 *     - a delivered report
 *
 *   THESE DO NOT COUNT.
 *     - a meeting transcript
 *     - a standup summary
 *     - a journal entry
 *     - a board note
 *     - a proposal in an inbox
 *
 * `campus/shared/lifecycle-inbox/` is, literally, an inbox — and "a proposal
 * in an inbox" is on the DOES NOT COUNT list. But "a filed review or
 * abstention" is on the COUNTS list, and the lifecycle inbox is the only
 * place in this estate a review is ever filed (see its own README: the office
 * decides there, the warehouse applies).
 *
 * The two resolve against each other cleanly, on the owner's own distinction:
 * **a review is finished judgement; a board proposal is a request for
 * somebody else to do work.** `campus/shared/board/inbox/` is the second and
 * does not count. `campus/shared/lifecycle-inbox/` is the first and does.
 *
 * ── THE UNCLASSIFIED PATH IS NOT AN ARTIFACT, AND IT IS NAMED ─────────────
 *
 * A path matching no rule below counts as NOT an artifact and is reported by
 * name in `unclassified`. It is never silently defaulted in either direction.
 * A default of "counts" would let any new write path silently satisfy the
 * obligation; a default of "does not count" that said nothing would let a
 * real artifact go unrecorded with no way to find out. So the list grows
 * deliberately, from a name somebody read.
 *
 * ── THE ONE ENTRY THE OWNER MAY WANT TO STRIKE, SAID HERE RATHER THAN HIDDEN
 *
 * `campus/shared/qa-instruments/` counts as *a completed analysis*, and it is
 * the weakest entry on the list: the Friday `qa_instruments` block writes it
 * from one D1 SELECT with ZERO model calls, and it writes it whether or not
 * there was anything to analyse. So **every Friday passes on it**, on output
 * produced because a block is scheduled — which is the MANUFACTURED shape
 * `admin-desk.js`'s own header is written against.
 *
 * It is counted anyway, because the file is a real cross-embodiment
 * comparison carrying real numbers and real refusals, and a person can open
 * and use it — which is the test the owner actually stated. But it rescues
 * only Fridays, and if he wants it struck, delete the one rule below marked
 * `WEAKEST`. That decision is his and it is one line.
 */

/* ─────────────────────────── The classification ─────────────────────────── */

export const WAREHOUSE_REPO = 'warehouse-office-AI-agents';
export const BACKOFFICE_REPO = 'back-office-AI-agents';
export const PUBLIC_REPO = 'office-AI-agents';

/**
 * Ordered. FIRST MATCH WINS, and the DOES-NOT-COUNT rules are interleaved by
 * specificity rather than segregated into a second array — because the pairs
 * that matter are the ones where a narrow exclusion sits inside a broad
 * inclusion, and two arrays would hide exactly that relationship. Each rule
 * carries the owner's own category word, so the failure record can say WHY a
 * path was or was not counted rather than only that it was not.
 */
export const CLASSIFICATION_RULES = Object.freeze([
  /* ── the warehouse: "a file in the warehouse" ─────────────────────────── */
  { repo: WAREHOUSE_REPO, re: /^.+$/, artifact: true, category: 'a file in the warehouse' },

  /* ── back-office ──────────────────────────────────────────────────────── */
  // "a filed review or abstention" — and the gap / vote / approval / refusal
  // proposals filed beside it, which are the same act of finished judgement.
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/lifecycle-inbox\/[^/]+\/.+\.json$/, artifact: true, category: 'a filed review or abstention' },
  // Its README is documentation, not a filing.
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/lifecycle-inbox\//, artifact: false, category: 'inbox documentation, not a filing' },
  // The office's written answer to a target the owner named (Session 33, Item C).
  { repo: BACKOFFICE_REPO, re: /^channel\/from-office\/\d{4}-\d{2}-\d{2}-review-.+\.md$/, artifact: true, category: 'a filed review or abstention' },
  // "a completed analysis" — WEAKEST entry on this list; see the module header.
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/qa-instruments\/.+\.md$/, artifact: true, category: 'a completed analysis (WEAKEST — see module header)' },
  // "a delivered report" — Front content the Designer publishes from.
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/front-drafts\/.+$/, artifact: true, category: 'a delivered report' },
  // ── the DOES NOT COUNT list, in the owner's own words ──
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/meetings\//, artifact: false, category: 'a meeting transcript' },
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/daily\//, artifact: false, category: 'a standup summary' },
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/weekly\//, artifact: false, category: 'a standup summary (the RAW string-template weekly trio, no review)' },
  { repo: BACKOFFICE_REPO, re: /^campus\/agents\//, artifact: false, category: 'a journal entry' },
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/board\//, artifact: false, category: 'a board note / a proposal in an inbox' },
  { repo: BACKOFFICE_REPO, re: /^channel\//, artifact: false, category: 'a proposal in an inbox (channel traffic)' },
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/lifecycle\//, artifact: false, category: 'a derived index, rewritten wholesale — not authored' },
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/side-plots\//, artifact: false, category: 'office flavour, not a deliverable' },
  { repo: BACKOFFICE_REPO, re: /^campus\/shared\/promotions\//, artifact: false, category: 'a simulation-state record, not a deliverable' },

  /* ── the public repo ──────────────────────────────────────────────────── */
  // A gap digest exists only because gaps were found — no gaps, no file.
  { repo: PUBLIC_REPO, re: /^reports\/gaps\//, artifact: true, category: 'a completed analysis' },
  { repo: PUBLIC_REPO, re: /^guides\//, artifact: true, category: 'a delivered report' },
  { repo: PUBLIC_REPO, re: /^front\//, artifact: true, category: 'a delivered report' },
  { repo: PUBLIC_REPO, re: /^reports\/weekly\//, artifact: true, category: 'a delivered report' },
  { repo: PUBLIC_REPO, re: /^reports\/_drafts\/weekly-/, artifact: true, category: 'a delivered report' },
  { repo: PUBLIC_REPO, re: /^reports\/meetings\//, artifact: false, category: 'a meeting transcript' },
  { repo: PUBLIC_REPO, re: /^reports\/daily\//, artifact: false, category: 'a standup summary' },
  { repo: PUBLIC_REPO, re: /^reports\/LATEST\.md$/, artifact: false, category: 'a standup summary' },
]);

/**
 * @param {{repo: string, path: string}} write
 * @returns {{artifact: boolean, category: string, matched: boolean}}
 */
export function classifyWrite(write) {
  const repo = String(write?.repo || '');
  const path = String(write?.path || '');
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.repo === repo && rule.re.test(path)) {
      return { artifact: rule.artifact, category: rule.category, matched: true };
    }
  }
  return {
    artifact: false,
    matched: false,
    category: 'UNCLASSIFIED — matched no rule, counted as NOT an artifact, and named so the list can grow deliberately',
  };
}

/**
 * The task directory a warehouse path was written under — `tasks/<slug>/...`
 * — or `null` for anything else (including a warehouse path outside
 * `tasks/`, which this office has none of today but which must not crash a
 * slug lookup).
 *
 * @param {string} path
 * @returns {string|null}
 */
export function warehouseSlugFromPath(path) {
  const m = /^tasks\/([^/]+)\//.exec(String(path || ''));
  return m ? m[1] : null;
}

// Duplicated from `workers/build-chain.js`'s own `AWAITING_REPAIR`, not
// imported — this module's header rule ("imports nothing") is why
// `scripts/verify-daily-obligation.js` can load and CALL it rather than
// mirror it, and that rule is worth one repeated string literal.
// `scripts/verify-daily-obligation.js` asserts this equals the real export.
const AWAITING_REPAIR_STATE = 'AWAITING-REPAIR';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * SESSION 42, ITEM C (2026-09-02) — A REPAIR ROUND'S OUTPUT IS NOT A NEW
 * ARTIFACT.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `dependency-audit` (OB-103, build_chain slug `dependency-audit`) satisfied
 * this office's daily obligation on 2026-08-31 and 2026-09-01 by rewriting
 * the SAME two files — `tasks/dependency-audit/audit.py` and its
 * `notes/repair-log.json` — every day the repair loop ran a round and the
 * Architect blocked it again. `countArtifacts()`'s existing distinct-path
 * dedupe (above) already stops ONE DAY's four commits to the same file from
 * counting as four artifacts; it does nothing to stop the SAME FILE, on a
 * DIFFERENT day, from counting as a fresh one — which is exactly the shape
 * that let a five-round stalemate read as three good days in a row.
 *
 * The obligation check (`countArtifacts` here) and the build chain
 * (`build_chain` in D1, read by the caller and passed in as
 * `opts.buildChainStates`) are two mechanisms that are each correct on their
 * own — the obligation check is right to count warehouse writes, and the
 * repair loop is right to write to the warehouse — and wrong together,
 * because neither one is aware of the other. This is that awareness, added
 * in the narrowest place: a warehouse write is excluded from the count ONLY
 * when the CURRENT `build_chain` state for its task slug is `AWAITING-REPAIR`
 * — a task that has not delivered anything yet (Session 33's own build-chain
 * diagram: `block -> AWAITING-REPAIR`, and only `approve -> MERGED` or
 * `APPROVED-UNMERGED` is a finished outcome). A slug with no `build_chain`
 * row at all (every non-repair-loop warehouse write, e.g.
 * `session-40-attribution`) is unaffected — this touches ONLY the one state
 * the session names, not "the warehouse" and not "dependency-audit" by name.
 *
 * `opts.buildChainStates` is a plain object or Map of `slug -> state`,
 * supplied by the caller from a live `SELECT slug, state FROM build_chain`.
 * Passing nothing (the default) reproduces the OLD behaviour exactly — a
 * caller that has not been updated to read `build_chain` does not silently
 * start under- or over-counting.
 *
 * @param {Array<{repo: string, path: string, committed?: number}>} rows
 * @param {{buildChainStates?: Map<string,string>|Record<string,string>}} [opts]
 */
export function countArtifacts(rows = [], opts = {}) {
  const states = opts.buildChainStates;
  const stateFor = (slug) => {
    if (!states || slug === null) return undefined;
    return states instanceof Map ? states.get(slug) : states[slug];
  };

  const artifacts = [];
  const notArtifacts = [];
  const unclassified = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row || typeof row.path !== 'string' || typeof row.repo !== 'string') continue;
    if (row.committed !== undefined && row.committed !== null && Number(row.committed) !== 1) continue;
    /*
     * DISTINCT PATHS, NOT COMMITS. The build chain rewrites the same file
     * across repair rounds — `audit.py` was committed four times on
     * 2026-08-27. Three commits to one file is one artifact, and counting
     * commits would let a single stuck repair loop satisfy the obligation on
     * its own, every day, forever. That is the manufactured shape wearing a
     * real queue's clothes, which is the exact failure this file is for.
     */
    const key = `${row.repo}::${row.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (row.repo === WAREHOUSE_REPO) {
      const slug = warehouseSlugFromPath(row.path);
      if (slug !== null && stateFor(slug) === AWAITING_REPAIR_STATE) {
        notArtifacts.push({
          repo: row.repo, path: row.path,
          category: `a repair round's output — build_chain '${slug}' is AWAITING-REPAIR, so the cycle has not delivered anything yet`,
        });
        continue;
      }
    }

    const verdict = classifyWrite(row);
    const entry = { repo: row.repo, path: row.path, category: verdict.category };
    if (verdict.artifact) {
      artifacts.push(entry);
    } else {
      notArtifacts.push(entry);
      if (!verdict.matched) unclassified.push(entry);
    }
  }
  return { count: artifacts.length, artifacts, notArtifacts, unclassified };
}

/* ─────────────────── Which block could have produced one ────────────────── */

/**
 * The block types whose OUTPUT is on the COUNTS list above.
 *
 * This is a claim about the code, and it is checked against the code rather
 * than trusted: `scripts/verify-daily-obligation.js` asserts every name here
 * appears as a `block.type ===` branch in `agent-runner.js`'s block loop, so
 * a block renamed or removed makes the verifier fail instead of silently
 * turning this list into a fiction. That is the `gate-wiring-verification`
 * lesson applied to a list rather than to a gate.
 */
export const ARTIFACT_CAPABLE_BLOCKS = Object.freeze([
  'admin_desk',         // reviews -> lifecycle-inbox; owner-review -> channel/from-office
  'repair',             // a repaired artifact -> the warehouse
  'architect_approval', // an approved merge -> the warehouse
  'report',             // gap digests -> reports/gaps/
  'guide_draft',        // guides/
  'guide_review',       // guides/
  'guide_verify',       // guides/
  'qa_instruments',     // campus/shared/qa-instruments/
  // SESSION 35, ITEM D (2026-08-29): `weekly_summary` was split into three
  // Friday blocks because it measured 53.25 weighted subrequests against a
  // usable 47. Both halves that still write an artifact are named here — the
  // template trio moved nowhere, and the reviewed draft moved to the new
  // `weekly_report` block. `weekly_meeting` is deliberately absent: it runs a
  // meeting, and no `meeting` block is on this list.
  'weekly_summary',     // campus/shared/weekly/* (the template trio)
  'weekly_report',      // reports/_drafts/weekly-*
]);

/**
 * Which block types are CAPABLE ON PAPER but switched OFF right now.
 *
 * Every one of these blocks self-gates on a `SIM_KV simulation-state` flag and
 * returns a logged no-op when its flag is not `true`. A block that cannot run
 * did not "fail to produce" anything, and naming it would send the owner to
 * look at a block whose behaviour today is correct.
 *
 * Measured live 2026-08-28: `guides_enabled: false`. So on a Sun-Thu schedule
 * the naive answer to "the last block that could have produced one" is
 * `guide_review@16:00` — a gated no-op that has produced nothing for weeks and
 * is not where anybody should be looking. With this applied the answer is
 * `report@16:00`, which is a block that actually ran.
 *
 * @param {object} sim - the parsed `simulation-state` KV value
 * @returns {Set<string>}
 */
export function switchedOffBlockTypes(sim) {
  const off = new Set();
  const on = (flag) => sim?.[flag] === true;   // `=== true`, the shape every gate in this estate uses
  if (!on('guides_enabled')) { off.add('guide_draft'); off.add('guide_review'); off.add('guide_verify'); }
  if (!on('office_context_enabled')) { off.add('admin_desk'); off.add('repair'); off.add('architect_approval'); }
  if (!on('improvement_loop_enabled')) off.add('qa_instruments');
  return off;
}

/**
 * The LAST block in today's schedule that could have produced an artifact.
 *
 * "Which block was the last that could have produced one and did not" is the
 * only diagnostic the owner asked for, and it is deliberately the only one:
 * it points at where to look without pretending to know why.
 *
 * `opts.disabled` removes the blocks that are switched off — see
 * `switchedOffBlockTypes()`. When EVERY artifact-capable block on the day is
 * switched off, this returns `null` and the notice says the day's schedule had
 * nothing that could have produced one, which is a true and useful fact: it
 * means the failure is a configuration, not a block that misbehaved.
 *
 * @param {{blocks: Array<{time: string, type: string}>}} schedule
 * @param {{disabled?: Set<string>|Array<string>}} [opts]
 * @returns {{time: string, type: string}|null}
 */
export function lastArtifactCapableBlock(schedule, opts = {}) {
  const disabled = opts.disabled instanceof Set ? opts.disabled : new Set(opts.disabled || []);
  const blocks = schedule?.blocks || [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const type = blocks[i]?.type;
    if (ARTIFACT_CAPABLE_BLOCKS.includes(type) && !disabled.has(type)) {
      return { time: blocks[i].time, type };
    }
  }
  return null;
}

/* ─────────────────────────────── The record ─────────────────────────────── */

/**
 * Lazily created, deliberately NOT in `database/schema.sql` — `repo_writes`,
 * `owner_notifications` and `block_admissions` all took the same decision for
 * the same reason: a table this small does not earn a migration.
 *
 * `date` is the PRIMARY KEY, so a re-run for a day REPLACES that day's row
 * rather than appending a second verdict for it. A day has one answer.
 *
 * `notified` is stored SEPARATELY from `artifact_count`, because "produced
 * nothing" and "produced nothing and the owner was told" are different facts,
 * and the second one is the one that can fail.
 *
 * ── `checked` AND `skip_reason`, ADDED SESSION 39 (2026-08-30) ────────────
 *
 * The rest day was the first tick this check ever reached on its own schedule
 * (Saturday 2026-08-29, 08:00 Israel — `block_admissions` has the row) and it
 * wrote NOTHING: `runDailyObligationCheck()` returned on `isOffDay` before it
 * touched D1. So the FIRST scheduled firing of a mechanism built to end
 * "silence and absence look identical" produced a silence indistinguishable
 * from the Worker never having run.
 *
 * A rest day is not a met obligation and it is not a failed one. Both of the
 * existing columns are the wrong place to say so — `met = 1` would claim an
 * artifact that does not exist, `met = 0` would raise an alarm A13 exists to
 * suppress. So the fact gets its own column:
 *
 *   `checked = 1` — the obligation was evaluated. `met` means what it says.
 *   `checked = 0` — the obligation was NOT evaluated. `skip_reason` says why,
 *                   `met` is still the truthful count-derived verdict, and
 *                   NOBODY IS NOTIFIED.
 *
 * The alarm query is therefore `WHERE checked = 1 AND met = 0`, and it is
 * written down here because a column whose meaning lives only in a session
 * report is a column the next reader will get wrong.
 */
export const DAILY_OBLIGATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS daily_obligation (
  date TEXT PRIMARY KEY,
  day_of_week INTEGER,
  artifact_count INTEGER NOT NULL,
  met INTEGER NOT NULL,
  artifacts TEXT,
  last_capable_block TEXT,
  notified INTEGER DEFAULT 0,
  notify_detail TEXT,
  source TEXT,
  checked INTEGER NOT NULL DEFAULT 1,
  skip_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * The two columns above, for a table that ALREADY EXISTS.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against the live table, so the
 * declaration above reaches a fresh D1 and nothing else. These do the rest.
 * Each is run on its own and its "duplicate column name" error is swallowed by
 * the caller — SQLite has no `ADD COLUMN IF NOT EXISTS`, and the alternative
 * (a probe of `pragma_table_info` first) is two round trips to learn something
 * the ALTER itself reports.
 *
 * `NOT NULL DEFAULT 1` on `checked` is the correct backfill for every row
 * already in the table: all seven were evaluated. It is not a convenience —
 * defaulting them to 0 would retroactively claim the 2026-08-26 failure was
 * never checked, which is the opposite of what happened.
 */
export const DAILY_OBLIGATION_MIGRATIONS = Object.freeze([
  'ALTER TABLE daily_obligation ADD COLUMN checked INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE daily_obligation ADD COLUMN skip_reason TEXT',
]);

/**
 * Why a day was not evaluated, or `null` when it was.
 *
 * Pure, and exported, so `scripts/verify-daily-obligation.js` exercises the
 * REAL rule rather than a transcription of it — the same reason every other
 * decision in this module is a pure function.
 *
 * @param {{isOffDay?: boolean}} opts
 * @returns {string|null}
 */
export function skipReasonFor({ isOffDay } = {}) {
  if (isOffDay) {
    return 'REST DAY — OFFICE-POLICY.md A13. The office writes nothing by design on a Saturday, '
      + 'so the obligation does not apply and the owner is NOT notified. The row exists so that '
      + '"the rest day skipped it" and "the check never ran" stop being the same observation.';
  }
  return null;
}

/* ───────────────────────────── The notification ─────────────────────────── */

export const OBLIGATION_ISSUE_LABEL = 'owner-channel';

/**
 * The title and body, and there is NOTHING ELSE IN THEM.
 *
 * The owner's instruction, verbatim: *"The message says only: no artifact was
 * produced today, and which block was the last that could have produced one
 * and did not. Nothing else — no summary, no encouragement, no plan."*
 *
 * So this renders two sentences and a sequence line, and the sequence line is
 * not decoration: it is `owner-notify.js`'s mechanism 2, the thing that makes
 * a LOST message visible in the message that did arrive. Without it a dropped
 * failure notice is indistinguishable from a day that succeeded — which would
 * give this file the exact failure mode it exists to end.
 *
 * `previous` is rendered only when it exists, and an unreadable sequence says
 * so. A guessed number would manufacture gaps that mean nothing and the owner
 * would learn to ignore them; `nextSequence()`'s own header makes that
 * argument at length and this reuses it rather than restating it.
 */
export function buildObligationIssue({ date, seq, previous, sequenceReason, lastCapableBlock }) {
  const n = seq === null || seq === undefined ? '?' : seq;
  const title = `[Office #${n}] No artifact was produced today (${date})`;

  const lines = [];
  lines.push(`No artifact was produced on ${date}.`);
  lines.push('');
  lines.push(
    lastCapableBlock
      ? `The last block that could have produced one and did not: \`${lastCapableBlock.type}\`, ${lastCapableBlock.time} Israel time.`
      : 'No block on this day\'s schedule could have produced one. That is a SCHEDULE fact, not an output fact.'
  );
  lines.push('');
  lines.push('---');
  if (seq === null || seq === undefined) {
    lines.push(`_Sequence number UNAVAILABLE${sequenceReason ? ` (${sequenceReason})` : ''} — this notice cannot tell you whether one before it went missing._`);
  } else if (previous) {
    lines.push(`_Notification #${n}. The one before it was #${previous.seq}, sent ${previous.sentAt}. If you never saw that one, it was lost._`);
  } else {
    lines.push(`_Notification #${n}. There is no earlier one on record._`);
  }

  return { title, body: lines.join('\n') };
}
