/**
 * workers/item-detail.js — ONE PENDING ITEM, WHOLE.
 *
 * Written 2026-08-25 (Session 22, Item A). Pure: **this module imports
 * nothing**, and it makes no network call of its own — the same rule
 * `site-data.js`, `owner-channel.js`, `owner-page.js`, `spec-builder.js`,
 * `office-policy.js` and `deliverable-lifecycle.js` keep, and for the same
 * reason: plain `node` must be able to load it so
 * `scripts/verify-item-detail.js` exercises THE REAL builders instead of a
 * hand-mirror of them. Everything here takes its inputs as arguments; the
 * fetching lives in `agent-runner.js`.
 *
 * ── THE MEASUREMENT THAT PRODUCED THIS FILE ──────────────────────────────
 *
 * `/admin`'s waiting-on-you tab showed twenty cards on 2026-08-25. This is one
 * of them, complete, as the owner saw it:
 *
 *   > Permission-flow analysis: trace every write path end to end
 *   > Blocked by another item on the board. Flow analysis before the call audit
 *   > repeats the call audit inside it and produces two documents that can
 *   > disagree.
 *
 * Two sentences. **Which** item blocks it, what the call audit is, who opened
 * this and when, what its metric says, what was already tried — none of it is
 * on the page, and all of it is in the board entry the card was built from.
 *
 * `parseBoard()` reads eleven named fields off a task block and returns them;
 * `buildPendingItems()` then uses FOUR — id, title, state and `Blocked by` —
 * and the block itself, with `Task:`, `Notes:`, `Source:`, `Metric:`,
 * `Assignee:` and everything else in it, is discarded at the parse boundary and
 * never reaches the browser at all. There is nothing to un-hide on the client;
 * the material was dropped four layers earlier. That is why this is a fetch and
 * not a CSS rule.
 *
 * ── VERBATIM. NO MODEL, NO SUMMARY, NO PARAPHRASE ────────────────────────
 *
 * The whole value of an expansion is that the owner reads **what the office
 * actually wrote**. `spec-builder.js`'s header states the reason this estate
 * keeps arriving at: a fluent paraphrase of something the office did not mean
 * is worse than no expansion at all, because a paraphrase reads exactly like
 * evidence. So the entry is sliced out of the source file by offset and handed
 * over unaltered — `entryFields()` splits it for display and changes not one
 * character of any value — and this module contains no provider client, no
 * `fetch`, and no rewriting of any kind.
 *
 * ── WHAT THE EXPANSION MAY NEVER WEAKEN ──────────────────────────────────
 *
 * The cards carry two honest sentences that were built deliberately and are
 * carried into this response WORD FOR WORD rather than re-stated:
 *
 *   * `NO_STATED_DEFAULT` — the card's own words for an item where the office
 *     never recorded what it will do on silence. Re-worded here it would become
 *     a second copy that drifts; A9's argument applied to a sentence.
 *   * `answer_note` — that an answer typed on this page does not mark a board
 *     item answered. It is passed through from the card, not composed again.
 *
 * ── AND WHAT IT MAY NEVER DO: SHIP THE BOARD ─────────────────────────────
 *
 * `BOARD.md` was 272 KB on 2026-08-25. This response carries ONE entry plus the
 * entries its blocker names — the slicing happens in the Worker, and the
 * browser is never handed the file. `lookups` reports every read that was
 * attempted so a reader can see what the answer cost and what it could not
 * reach.
 */

/* ───────────────────────────── The three sources ────────────────────────── */

/**
 * The card `id` prefixes `buildPendingItems()` mints, mapped to the file each
 * one came out of and the heading that identifies an entry in it.
 *
 * Keyed by the prefix rather than matched by a general rule for the same reason
 * `admin-gate.js`'s alias map is a Map and not a concatenation: three named
 * entries cannot address a fourth file by accident, and adding one is a line
 * somebody has to write on purpose.
 *
 * `path` values are the same constants `office-context.js` and
 * `owner-channel.js` fetch from. They are repeated rather than imported because
 * this module imports nothing; `scripts/verify-item-detail.js` asserts the
 * three strings still match the ones those modules use, so a moved file breaks
 * a check instead of a page.
 */
export const ITEM_SOURCES = Object.freeze({
  board: Object.freeze({
    prefix: 'board-',
    idPattern: /^OB-\d{3}$/,
    path: 'campus/shared/board/BOARD.md',
    what: 'the office\'s task board',
  }),
  question: Object.freeze({
    prefix: 'question-',
    idPattern: /^Q-\d{3}$/,
    path: 'channel/to-owner/OPEN-QUESTIONS.md',
    what: 'the questions the office has asked you',
  }),
  submission: Object.freeze({
    prefix: 'submission-',
    idPattern: /^S-\d{3}$/,
    path: 'channel/to-owner/SUBMISSIONS.md',
    what: 'the ledger of work submitted for your decision',
  }),
});

/** The repository all three live in. Named in the response so the owner is
 *  never asked which of three repos a sentence came from. */
export const ITEM_REPO = 'back-office-AI-agents';

/**
 * The card's own words for "the office never recorded a default here".
 *
 * Copied from `office-site-page.js`'s `renderPendingItem()` deliberately and
 * asserted equal by `scripts/verify-item-detail.js`. A2 asks for these words;
 * writing a second sentence that means the same thing is how two sentences
 * start disagreeing.
 */
export const NO_STATED_DEFAULT =
  'there is no stated default here — silence is not a decision the office knows how to act on.';

/* ───────────────────────────── Reading an id ────────────────────────────── */

/**
 * `board-ob-003` → `{ kind: 'board', itemId: 'OB-003' }`.
 *
 * REFUSES rather than guesses, the posture every parser in this estate keeps.
 * The id arrives from a query string, so it is caller-controlled in the only
 * sense that matters: it must not be able to name a file. It is validated
 * against a fixed pattern per source and THE PATH IS NEVER BUILT FROM IT —
 * `ITEM_SOURCES[kind].path` is a constant.
 */
export function parseItemRef(rawId) {
  const id = String(rawId || '').trim();
  if (!id) return { ok: false, reason: 'no item id was given' };
  if (id.length > 64) return { ok: false, reason: 'that item id is too long to be one of the office\'s' };

  for (const [kind, src] of Object.entries(ITEM_SOURCES)) {
    if (!id.startsWith(src.prefix)) continue;
    const itemId = id.slice(src.prefix.length).toUpperCase();
    if (!src.idPattern.test(itemId)) {
      return { ok: false, reason: `"${id}" starts like a ${kind} item but "${itemId}" is not a ${kind} identifier` };
    }
    return { ok: true, id, kind, itemId, source: src };
  }
  return {
    ok: false,
    reason: `"${id}" is not one of the office's pending-item ids — they begin ${Object.values(ITEM_SOURCES).map((s) => s.prefix).join(', ')}`,
  };
}

/* ──────────────────────────── Slicing one entry ─────────────────────────── */

/**
 * The heading that opens an entry, for one item. Anchored on the identifier and
 * followed by the em-dash separator, so `OB-003` cannot match inside a longer
 * identifier.
 */
function headingRe(itemId) {
  return new RegExp(`^### ${itemId} — (.+)$`, 'm');
}

/**
 * One entry, sliced out of its source file by offset and returned unaltered.
 *
 * The end of an entry is the next `### ` heading or the end of the file, which
 * is the same boundary `parseBoard()`, `parseOpenQuestions()` and
 * `parseSubmissions()` all use. Trailing whitespace is trimmed and nothing else
 * is touched.
 *
 * SUBMISSIONS.md documents its own format inside a fenced block containing a
 * live-looking `### S-000` heading, and `parseSubmissions()` blanks fenced
 * blocks before scanning for exactly that reason. The same blanking happens
 * here, with the same replace-don't-delete trick, so every offset still points
 * into the ORIGINAL string and what is returned is the real file's bytes.
 */
export function extractEntry(markdown, itemId) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { found: false, reason: 'the source file was empty or could not be read' };
  }
  const scannable = markdown.replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '));
  const m = headingRe(itemId).exec(scannable);
  if (!m) {
    return { found: false, reason: `no "### ${itemId} — …" heading in the file — the entry has been renamed, removed, or was never there` };
  }
  const start = m.index;
  const after = scannable.slice(start + m[0].length);
  const nextRel = /^### /m.exec(after);
  const end = nextRel ? start + m[0].length + nextRel.index : markdown.length;
  return {
    found: true,
    reason: null,
    heading: m[1].trim(),
    verbatim: markdown.slice(start, end).replace(/\s+$/, ''),
  };
}

/**
 * Every `- **Label:** value` line in an entry, in file order, verbatim.
 *
 * A value may run onto following lines — `Notes:` routinely does — so a field
 * runs until the next field, or the end of the block. This is a SPLIT, not a
 * parse: no value is normalised, no label is renamed, and a label this estate
 * has never seen before is returned exactly like one it has. That is the
 * difference between this and `parseBoard()`, which reads eleven names it knows
 * and drops everything else.
 */
export function entryFields(block) {
  const src = String(block || '');
  const re = /^- \*\*(.+?):\*\*[ \t]*/gm;
  const hits = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    hits.push({ label: m[1].trim(), from: m.index, valueFrom: m.index + m[0].length });
  }
  return hits.map((hit, i) => ({
    label: hit.label,
    value: src.slice(hit.valueFrom, i + 1 < hits.length ? hits[i + 1].from : src.length).replace(/\s+$/, ''),
  }));
}

/** One field's value by label, or null. Case-insensitive on the label only. */
export function fieldValue(fields, label) {
  const want = String(label || '').toLowerCase();
  const hit = (fields || []).find((f) => String(f.label).toLowerCase() === want);
  return hit ? hit.value : null;
}

/* ───────────────────────── Resolving the blocker ────────────────────────── */

/**
 * Every office identifier named in a piece of text, in order, deduplicated.
 *
 * Deliberately WIDER than `owner-channel.js`'s `itemIdsInText()`, which matches
 * `S-NNN` and `Q-NNN` only because its job is deciding whether the owner acted
 * on a ledger entry. This one's job is finding what a card means by "another
 * item on the board", so `OB-NNN` is the one it must not miss.
 */
export function referencedItemIds(text) {
  const out = [];
  const re = /\b(OB-\d{3}|Q-\d{3}|S-\d{3})\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Which source file an identifier lives in, from its own shape. */
export function kindOfItemId(itemId) {
  for (const [kind, src] of Object.entries(ITEM_SOURCES)) {
    if (src.idPattern.test(String(itemId || '').toUpperCase())) return kind;
  }
  return null;
}

/**
 * The `Blocked by:` line, resolved.
 *
 * A card that says *"blocked by another item"* is useless without which item
 * and what that item says, so every identifier the line names is looked up in
 * the file it belongs to and returned WITH ITS OWN ENTRY IN FULL. A blocker
 * whose entry cannot be found is reported as unresolved with the reason —
 * never dropped, because a silently missing blocker reads as "nothing blocks
 * this".
 *
 * A `Blocked by:` line that names no identifier at all is a real and common
 * shape (`**an owner decision.** The standup did not settle this…`). It is
 * returned verbatim as `stated` with `names_no_item: true`, so the expansion
 * says what the board says instead of implying a lookup failed.
 *
 * @param {string|null} statedValue the raw `Blocked by:` value, or null
 * @param {object} filesByKind `{ board: '<markdown>', question: …, submission: … }`
 */
export function resolveBlockers(statedValue, filesByKind = {}) {
  const stated = statedValue == null ? null : String(statedValue).replace(/\s+$/, '');
  const ids = referencedItemIds(stated);
  const resolved = [];
  const unresolved = [];

  for (const id of ids) {
    const kind = kindOfItemId(id);
    const markdown = kind ? filesByKind[kind] : null;
    if (!kind) {
      unresolved.push({ item_id: id, reason: `"${id}" is not an identifier from any file the office reads for this page` });
      continue;
    }
    if (typeof markdown !== 'string') {
      unresolved.push({ item_id: id, reason: `${ITEM_SOURCES[kind].path} was not read on this request, so ${id} could not be looked up` });
      continue;
    }
    const entry = extractEntry(markdown, id);
    if (!entry.found) {
      unresolved.push({ item_id: id, reason: `${id}: ${entry.reason}` });
      continue;
    }
    const fields = entryFields(entry.verbatim);
    resolved.push({
      item_id: id,
      kind,
      file: ITEM_SOURCES[kind].path,
      title: entry.heading,
      state: fieldValue(fields, 'State'),
      verbatim: entry.verbatim,
      fields,
    });
  }

  return {
    stated,
    names_no_item: !!stated && ids.length === 0,
    resolved,
    unresolved,
  };
}

/* ──────────────────── When it first appeared, from git ──────────────────── */

/**
 * How many file-content probes the origin search may make.
 *
 * The search is a binary search over the commits that touched the source file,
 * so nine probes cover 512 commits. It is a CAP AND IT IS REPORTED: a search
 * that does not converge returns the window it narrowed to and says the budget
 * ran out, rather than returning the nearest bound as though it were the
 * answer. `admin-desk.js`'s rule applies — a desk that draws 2 of 21 and says
 * "2" is the same lie as a truncated list.
 */
export const MAX_ORIGIN_PROBES = 9;

/**
 * The commit that put this entry into the file, by binary search on presence.
 *
 * ── WHY GIT AND NOT THE DATE WRITTEN IN THE ENTRY ────────────────────────
 *
 * A2's instruction, and it is a rule this estate learned by being wrong: a task
 * here is dated by whatever wrote it rather than by when it entered the record.
 * `renderBoardTask()` stamps `Notes:` with the meeting's date; a session that
 * hand-edits a task can put any date in it; `OB-081` reached IN-PROGRESS on
 * 2026-08-16 carrying no start record at all. Git is the only witness that was
 * not written by the thing being asked about.
 *
 * ── WHY BINARY SEARCH IS SOUND HERE ──────────────────────────────────────
 *
 * Presence is monotone along path-filtered history: an entry, once added, stays
 * — the board's own rule is that a task is marked DONE, never deleted. If that
 * were ever violated the search would find the most recent addition, which is
 * still a true statement about the entry and is reported as what it is.
 *
 * `commits` is newest-first, exactly as the GitHub commits API returns them, so
 * index 0 is HEAD and the last index is the oldest commit that touched the
 * path. The answer is the LARGEST index at which the entry is still present.
 *
 * @param {Array<{sha: string, date: string, message: string}>} commits newest first
 * @param {(sha: string) => Promise<{ok: boolean, present?: boolean, reason?: string}>} probe
 *   injected — this module makes no network call. The caller fetches the file
 *   at a ref and answers whether the entry is in it.
 * @param {object} [opts]
 * @param {number} [opts.max] probe budget, default MAX_ORIGIN_PROBES
 * @param {boolean} [opts.complete] true when `commits` is the WHOLE history of
 *   the path. False means the listing was capped, and an entry present in the
 *   oldest commit listed is reported as `at-or-before` rather than `exact`.
 */
export async function findFirstAppearance(commits, probe, opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : MAX_ORIGIN_PROBES;
  const complete = opts.complete !== false;
  const list = Array.isArray(commits) ? commits : [];
  if (!list.length) {
    return { ok: false, precision: 'none', reason: 'git listed no commits touching this file', probes: 0 };
  }

  let probes = 0;
  const ask = async (i) => {
    probes += 1;
    return probe(list[i].sha);
  };

  // The oldest commit listed. If the entry is already there the search is over
  // in one probe — and whether that is the answer or merely a bound depends on
  // whether this listing is the whole history.
  const oldest = list.length - 1;
  const atOldest = await ask(oldest);
  if (!atOldest.ok) {
    return { ok: false, precision: 'none', reason: atOldest.reason || 'the file could not be read at that commit', probes };
  }
  if (atOldest.present) {
    return {
      ok: true,
      precision: complete ? 'exact' : 'at-or-before',
      commit: list[oldest],
      probes,
      reason: complete
        ? 'the entry is in the oldest commit that ever touched this file, so it was there when the file was created'
        : `the commit listing was capped at ${list.length}, and the entry is already present at the oldest one listed — it appeared on or before this commit`,
    };
  }

  // Present at HEAD? If not, the entry is not in the file's current state and
  // there is nothing to date. Reported, not guessed at.
  const atHead = await ask(0);
  if (!atHead.ok) {
    return { ok: false, precision: 'none', reason: atHead.reason || 'the file could not be read at HEAD', probes };
  }
  if (!atHead.present) {
    return { ok: false, precision: 'none', reason: 'the entry is not in the file at HEAD, so git has no first appearance to report', probes };
  }

  // Invariant: present at `lo`, absent at `hi`. The answer is `lo` once they
  // are adjacent — the oldest commit that still has it.
  let lo = 0;
  let hi = oldest;
  while (hi - lo > 1) {
    if (probes >= max) {
      return {
        ok: true,
        precision: 'window',
        window: { newest: list[lo], oldest: list[hi] },
        probes,
        reason: `the search budget of ${max} file reads ran out; the entry first appeared somewhere in this window and this lookup did not narrow it further`,
      };
    }
    const mid = Math.floor((lo + hi) / 2);
    const r = await ask(mid);
    if (!r.ok) {
      return {
        ok: true,
        precision: 'window',
        window: { newest: list[lo], oldest: list[hi] },
        probes,
        reason: `a file read failed mid-search (${r.reason || 'no reason given'}); the entry first appeared somewhere in this window`,
      };
    }
    if (r.present) lo = mid; else hi = mid;
  }

  return { ok: true, precision: 'exact', commit: list[lo], probes, reason: null };
}

/* ──────────────────────────── The whole answer ──────────────────────────── */

/**
 * Which of an entry's fields, if any, says what happens when the owner says
 * nothing — and when none does, the CARD'S OWN SENTENCE rather than a new one.
 *
 * The three sources spell it differently and all three spellings are read,
 * because a default that exists and is not found reads identically to one that
 * was never written, and this whole page exists to keep those two apart.
 */
export function statedDefault(fields) {
  for (const label of ['If no answer comes', 'Fallback', 'If nothing is said']) {
    const v = fieldValue(fields, label);
    if (v && v.trim()) return { stated: true, label, text: v.trim(), words: null };
  }
  return { stated: false, label: null, text: null, words: NO_STATED_DEFAULT };
}

/**
 * Assembles the response for one item from material that has already been read.
 *
 * Every read the caller attempted is reported in `lookups`, whether it worked
 * or not. A5's requirement, and it is the one that keeps this endpoint honest:
 * an expansion that could not find its source must say WHICH lookup failed, and
 * must never render as an empty panel that reads like "there was nothing more".
 *
 * @param {object} input
 * @param {object} input.ref        parseItemRef()'s result
 * @param {object|null} input.card  the item as `buildPendingItems()` built it,
 *   so the expansion can carry the card's own honest sentences rather than
 *   composing second copies of them
 * @param {object} input.files      `{ board, question, submission }` markdown or null
 * @param {object|null} input.origin findFirstAppearance()'s result
 * @param {Array} input.lookups     `{ what, ok, reason }` per read attempted
 */
export function buildItemDetail({ ref, card = null, files = {}, origin = null, lookups = [] } = {}) {
  const src = ref.source;
  const markdown = files[ref.kind];
  const entry = typeof markdown === 'string'
    ? extractEntry(markdown, ref.itemId)
    : { found: false, reason: `${src.path} could not be read on this request — see lookups` };

  const fields = entry.found ? entryFields(entry.verbatim) : [];
  const blockedByField = entry.found ? fieldValue(fields, 'Blocked by') : null;
  // The card's `detail` is the office's own "Blocked by: …" sentence; it is the
  // fallback when the entry itself could not be sliced, so a failed slice still
  // resolves whatever the card already knew rather than showing nothing.
  const blockerSource = blockedByField != null ? blockedByField
    : (card && typeof card.detail === 'string' ? card.detail.replace(/^Blocked by:\s*/i, '') : null);

  return {
    ok: true,
    id: ref.id,
    item_id: ref.itemId,
    kind: ref.kind,
    title: entry.found ? entry.heading : (card?.title || null),

    source: {
      repo: ITEM_REPO,
      file: src.path,
      what: src.what,
      found: entry.found,
      reason: entry.reason || null,
    },

    // Verbatim. See the file header: no model, no summary, no paraphrase.
    entry: {
      verbatim: entry.found ? entry.verbatim : null,
      fields,
      // Named so a reader can tell "the office wrote no fields" from "the entry
      // was not found at all" without comparing two nulls.
      field_count: fields.length,
    },

    blocker: resolveBlockers(blockerSource, files),

    origin: origin || {
      ok: false,
      precision: 'none',
      reason: 'the first-appearance lookup was not run for this request',
      probes: 0,
    },

    default: statedDefault(fields),

    // Carried from the card, never re-composed. See the header.
    answer_note: card?.answer_note || null,
    answer_stops_the_asking: card ? !!card.answer_stops_the_asking : null,

    lookups: Array.isArray(lookups) ? lookups : [],
  };
}
