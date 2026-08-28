/**
 * workers/owner-review.js — THE REVIEW QUEUE THE OWNER FILLS.
 *
 * Written 2026-08-28 (Session 33, Item C). Imports nothing, so
 * `scripts/verify-owner-review.js` can CALL it rather than mirror it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS PATH AND NOT ANOTHER ONE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A review is ONE COMPLETION — read, judge, write — and it is the office's
 * strongest demonstrated capability: eleven model-written reviews are already
 * filed in `campus/shared/lifecycle-inbox/`, with real verdicts, by real
 * personas, from a real queue.
 *
 * **It needs no pairing, no warehouse spec and no dispatcher, and it must not
 * acquire any.** Every one of those is a link in a chain that is currently
 * broken somewhere: 113 board tasks carry ZERO `- **Warehouse:** <slug>`
 * lines, so `dispatch.js` refuses every day by design (OB-134), and the
 * warehouse build chain has one seeded row and no autonomous producer. Routing
 * an owner's review request through any of that would make the one working
 * path depend on the broken ones.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHERE IT LIVES, AND WHY IT IS A NEW FOLDER RATHER THAN A NEW `kind:`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `channel/from-owner/README.md` sets a hard line, and it is right:
 *
 *   > **An office that builds its own instruction channel builds the pipe
 *   > that feeds it.** ... A session that finds this contract inconvenient and
 *   > rewrites it has done the one thing the split exists to prevent.
 *
 * So `from-owner/`'s contract is UNTOUCHED here: no new `kind:` word, no new
 * front-matter field, no change to what any existing file means. The
 * alternative that was considered and rejected was a hidden convention inside
 * `from-owner/` — "a slug starting with `review-` means review this" — and it
 * is strictly worse, because it changes the meaning of files the owner has
 * already written without him agreeing to it.
 *
 * `channel/to-review/` is a SIBLING: additive, owner-writes-only, one file per
 * target, editable from a phone through GitHub exactly like `from-owner/`. The
 * contract in its README is a PROPOSAL under A8 — the office may propose, only
 * the owner decides — and if he wants it folded into `from-owner/` instead,
 * that is one line of his and this module follows.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIBERAL IN WHAT IT ACCEPTS, AND THAT IS A LESSON THIS ESTATE PAID FOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `17-08-2026-build-contract-reader-tool.md` — the first real deliverable ever
 * assigned to this office — sat unread for six days because `parseOwnerMessage()`
 * accepted only `YYYY-MM-DD`. Day-month-year is what the owner writes.
 *
 * So this parser refuses almost nothing. Any `.md` file that is not the README
 * is a target. A leading date in either order is stripped to form the slug; a
 * filename with no date at all is fine and the whole name is the slug. There is
 * no header to get wrong, and every field is optional. **The office does not
 * get to refuse the client's own handwriting**, and a queue whose entry
 * requirements are strict enough to reject him is a queue that stays empty.
 */

/* ──────────────────────────────── The paths ─────────────────────────────── */

/** The owner writes here. One file per target. */
export const TO_REVIEW_DIR = 'channel/to-review';
/** The office writes here — its own side of the channel, per `channel/README.md`. */
export const FROM_OFFICE_DIR = 'channel/from-office';

/**
 * ONE per tick.
 *
 * A review is one 2200-token judgment call plus one commit. The lifecycle
 * review desk beside it draws two, and this draws one for a reason that is not
 * arithmetic: these are targets a PERSON chose and is waiting on, and two
 * shallow reviews of two of his targets in one tick is worse for him than one
 * of each on consecutive days. The queue is his, and it refills at human
 * speed.
 */
export const MAX_OWNER_REVIEWS_PER_TICK = 1;

/**
 * The default reviewer when the owner names none: the QA (Agent 6).
 *
 * A DEFAULT, never a rotation. A hidden rotation would mean the same target
 * reviewed by a different persona depending on which day it happened to be
 * drawn, and the owner would have no way to know why the answer changed. He
 * can name any reviewer with a `Reviewer:` line; if he does not, he gets the
 * office's reviewer, every time, predictably.
 */
export const DEFAULT_REVIEWER_ID = 6;

/* ─────────────────────────────── The parsing ────────────────────────────── */

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})-/;

/**
 * A file name in `channel/to-review/` -> a target.
 *
 * Returns `null` for things that are not targets (the README, a non-markdown
 * file). Everything else IS a target — see the header for why the bar is this
 * low.
 */
export function targetFromName(name) {
  const n = String(name || '').trim();
  if (!n || !/\.md$/i.test(n)) return null;
  if (/^readme\.md$/i.test(n)) return null;
  const base = n.replace(/\.md$/i, '');
  const slug = base.replace(DATE_PREFIX, '').trim() || base;
  return { name: n, slug, path: `${TO_REVIEW_DIR}/${n}` };
}

/**
 * What the office was asked to review, out of the target file's own text.
 *
 * Three OPTIONAL lines, matched case-insensitively anywhere in the file:
 *
 *   Target: <a path in back-office-AI-agents the office should read>
 *   Reviewer: <an agent id, or a name fragment like "cyber" / "qa">
 *   Lens: <a free-text question the owner wants answered>
 *
 * Everything else in the file is the material itself. A file with none of the
 * three is completely valid: its whole body is what gets reviewed, and the QA
 * reviews it. That is the common case and it must stay the easy one.
 */
export function parseTargetFile(text) {
  const body = String(text || '');
  const line = (label) => {
    const m = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im').exec(body);
    return m ? m[1].replace(/\*\*/g, '').trim() : null;
  };
  const rawReviewer = line('Reviewer');
  let reviewerId = null;
  if (rawReviewer) {
    const digits = /(\d{1,2})/.exec(rawReviewer);
    if (digits) {
      const n = Number(digits[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 13) reviewerId = n;
    }
  }
  const titleMatch = /^#\s+(.+)$/m.exec(body);
  return {
    targetPath: line('Target'),
    // NOT DEFAULTED HERE. `null` means the owner did not say, and the caller
    // applies DEFAULT_REVIEWER_ID — so a file whose `Reviewer:` line the parser
    // could not read is distinguishable from one that had no line at all, and
    // the review says which.
    reviewerId,
    reviewerRaw: rawReviewer,
    lens: line('Lens'),
    title: titleMatch ? titleMatch[1].trim() : null,
    body,
  };
}

/**
 * Has this target already been answered?
 *
 * The filed review's name is `<date>-review-<slug>.md` in `from-office/`, so a
 * DIRECTORY LISTING answers it — no ingest, no index to keep in step, and the
 * obligation clears the instant the review commits.
 *
 * That is deliberately stronger than `own-review`, which clears only when
 * `scripts/lifecycle.mjs` next runs and can therefore keep telling an agent it
 * owes a review it filed days ago. Item C asks for an obligation that clears
 * "the same way own-review clears today"; this clears the same way and sooner.
 */
export function filedSlugs(fromOfficeEntries = []) {
  const out = new Set();
  for (const e of fromOfficeEntries || []) {
    const m = /^\d{4}-\d{2}-\d{2}-review-(.+)\.md$/i.exec(e?.name || '');
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * The draw.
 *
 * @param {Array<{name: string}>} toReviewEntries - listing of `channel/to-review/`
 * @param {object} [opts]
 * @param {Set<string>|Array<string>} [opts.filed] - slugs already answered
 * @param {boolean} [opts.queueReadable] - false when the listing FAILED, which
 *   is not the same fact as an empty folder and must not be drawn from
 * @param {number} [opts.max]
 * @returns {{draw: Array<object>, deferred: Array<object>, skipped: Array<object>, queued: number}}
 */
export function reviewDraw(toReviewEntries = [], opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_OWNER_REVIEWS_PER_TICK;
  const filed = opts.filed instanceof Set ? opts.filed : new Set(opts.filed || []);
  const draw = [];
  const deferred = [];
  const skipped = [];

  for (const entry of toReviewEntries || []) {
    const target = targetFromName(entry?.name);
    if (!target) {
      if (entry?.name && !/^readme\.md$/i.test(entry.name)) {
        skipped.push({ name: entry.name, why: 'not a markdown file — the office reads `.md` here and says so rather than guessing at a format' });
      }
      continue;
    }
    if (filed.has(target.slug)) {
      skipped.push({ name: entry.name, slug: target.slug, why: 'a review of this target is already filed in channel/from-office/ — the obligation cleared when it committed' });
      continue;
    }
    (draw.length < max ? draw : deferred).push(target);
  }
  return { draw, deferred, skipped, queued: draw.length + deferred.length };
}

/* ─────────────────────────────── The output ─────────────────────────────── */

/** `channel/from-office/<today>-review-<slug>.md` — where he already reads. */
export function reviewFilePath(today, slug) {
  return `${FROM_OFFICE_DIR}/${today}-review-${slug}.md`;
}

/**
 * The filed review.
 *
 * Carries the `channel/README.md` header the office's own side of the channel
 * already uses (`from`, `date`, `kind`, `re`, `status`), so this file is
 * readable by the contract that exists rather than being a second shape that
 * only looks like one. `kind: delivery` — the parent contract's word for
 * finished work, which is exactly what a completed review is.
 *
 * ── WHAT THE REVIEWER WAS GIVEN IS STATED IN THE FILE ITSELF ─────────────
 *
 * On 2026-08-17 the first live admin-desk review said it had *"Ran the script
 * against three local test repositories"* and *"Executed each of the supported
 * CLI flags"*. It had been handed one markdown file and had run nothing. The
 * prompt was fixed the same day; this footer is the other half — a reader of
 * the review can see what was in front of it without having to trust the
 * review's own account of that.
 */
export function renderReviewFile({ today, slug, title, reviewerId, reviewerName, reviewerRole, lens, targetPath, sourceNote, verdict, text, provider, defaultedReviewer }) {
  const lines = [];
  lines.push('---');
  lines.push('from: office');
  lines.push(`date: ${today}`);
  lines.push('kind: delivery');
  lines.push(`re: ${slug}`);
  lines.push('status: open');
  lines.push('---');
  lines.push('');
  lines.push(`# Review: ${title || slug}`);
  lines.push('');
  lines.push(`**Reviewed by:** Agent ${reviewerId} — ${reviewerName || 'unnamed'}${reviewerRole ? ` (${reviewerRole})` : ''}`
    + (defaultedReviewer ? ' · _you named no reviewer, so this is the office\'s default (the QA)_' : ' · _you named this reviewer_'));
  lines.push(`**Verdict:** ${verdict || 'NONE RECORDED — the reviewer did not end with a verdict line, and that is reported rather than guessed at'}`);
  lines.push(`**You asked on:** \`${TO_REVIEW_DIR}/\` · **Filed:** ${today}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(String(text || '').trim());
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## What the reviewer was actually given');
  lines.push('');
  lines.push(sourceNote || 'the text of your own request file, and nothing else');
  if (targetPath) lines.push(`\nNamed target: \`${targetPath}\``);
  if (lens) lines.push(`\nYour question, put to the reviewer verbatim: ${lens}`);
  lines.push('');
  lines.push(`_Produced autonomously by the \`admin_desk\` owner-review desk, provider ${provider || 'unrecorded'}._`);
  lines.push('_It ran nothing and executed nothing. Everything above is judgement over the text named here._');
  lines.push('');
  return lines.join('\n');
}
