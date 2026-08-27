/**
 * workers/owner-channel.js — the two directions of the owner↔office channel,
 * as something the office can READ, and as a RECORD of having read it.
 *
 * Written 2026-08-10. Pure: **this module imports nothing**, the same rule
 * `deliverable-lifecycle.js` and `office-policy.js` keep, and for the same
 * reason — plain `node` must be able to load it so `scripts/verify-owner-channel.js`
 * exercises the real code rather than a hand-mirror of it.
 *
 * ── WHAT THIS IS THE BASE OF, AND WHAT IT DELIBERATELY IS NOT ────────────
 *
 * REQ-001 is the only requirement the OWNER marked URGENT, and it has been
 * open since 2026-08-07. It is the answer to three separate problems the
 * policy raises and cannot otherwise close: an admin objection that needs the
 * owner's ruling (A8), a deliverable waiting on his approval (A4 — *only the
 * CEO's approval reaches client-ready, and only the owner's reaches shipped*),
 * and the owner being unavailable for days at a time (A5, A8).
 *
 * **This file is the BASE. The interface is not here and must not be built
 * here.** The split is a trust boundary, not a division of labour:
 *
 *   The base is the mechanism through which the OWNER INSTRUCTS THE OFFICE.
 *   An office that builds its own instruction channel builds the pipe that
 *   feeds it. So the base is built under supervision, by a session working
 *   directly with the owner, and the presentation layer over it — the visual
 *   page, its security review — is the office's work and goes to the board.
 *
 * ── THE FAILURE THIS MODULE EXISTS TO END ────────────────────────────────
 *
 * `channel/README.md` states it, and `channel/from-brain/README.md` restates
 * it as the brain's binding condition on approving its own direction:
 *
 *   > A message the office has not read looks exactly like a message the
 *   > office has read and ignored.
 *
 * A folder of files cannot tell those apart. Neither can a `status:` line the
 * office writes about itself — that is a CLAIM, and a claim is not evidence.
 * So this module separates three states that a single field cannot:
 *
 *   UNREAD          no read record exists for this message's CONTENT
 *   READ-NOT-ACTED  a read record exists, and the message is still open
 *   ACTED           the office says what it did, and when
 *
 * **The record is the deliverable, not the reading.** That is the brain
 * channel's lesson, quoted here rather than re-derived, and it is why
 * `recordOwnerRead()` carries the content SHA. An owner who EDITS a message
 * after the office read it produces a new SHA, and the message goes back to
 * UNREAD — a stale receipt can never mask new content.
 *
 * ── WHAT A READ RECORD PROVES, STATED NARROWLY ───────────────────────────
 *
 * It proves the office's context CARRIED this message's content on this date.
 * It does not prove any individual agent attended to it, and nothing in this
 * project can prove that. Recording per model call was considered and refused:
 * it is one commit per LLM call, which is not a record, it is a denial of
 * service against the repo. Once per message SHA is the honest granularity and
 * this comment is where a later session finds out that the narrower claim was
 * chosen deliberately rather than overlooked.
 */

/* ────────────────────────────── Locations ──────────────────────────────── */

/** The owner writes here. The office NEVER writes into this directory —
 *  `channel/README.md`'s one-directory-per-direction rule, unchanged. */
export const OWNER_DIR = 'channel/from-owner';

/**
 * ── THE SECOND OWNER-SIDE DIRECTORY (2026-08-23, Session 14 ITEM B) ──────
 *
 * `channel/from-owner-issues/` holds the client's replies TRANSCRIBED OUT OF
 * GITHUB ISSUE THREADS by `agent-runner.js` `recordIssueReplies()` — one file
 * per comment, dated, carrying the Issue number, the author and the comment id.
 *
 * ── WHY IT IS A SIBLING AND NOT PART OF `from-owner/` ────────────────────
 *
 * `recordIssueReplies()` says it in its own words, and nothing here overrides
 * it: *"This writes into back-office, NOT into `channel/from-owner/`. That
 * folder is the owner's own and the office never writes there. A reply the
 * office transcribed is the OFFICE's record of what he said, and it must not be
 * mistakable for a file he wrote himself."* The separation is a provenance
 * claim, and it is right. It stays.
 *
 * ── WHAT WAS WRONG ANYWAY ────────────────────────────────────────────────
 *
 * `fetchOfficeSnapshot()` listed `OWNER_DIR` and only `OWNER_DIR`. No lister,
 * parser or prompt builder anywhere in the estate read this sibling. So on
 * 2026-08-23 the owner replied to Issue #47 — the first reply the office has
 * ever received from him, after eleven unanswered notifications — and the
 * office READ it, RECORDED it and COMMITTED it to git, and then it reached
 * exactly zero agent prompts.
 *
 * That is a FOURTH channel state, and it is worse than the three this module
 * already distinguishes. Unread, read-and-not-acted, and acted are all states
 * the office can SEE. This one is: filed, versioned, attributable, and
 * invisible. Every receipt said the message had arrived.
 *
 * ── AND WHY IT IS A SECOND CONSTANT, NOT A PREFIX MATCH ──────────────────
 *
 * A prefix match on `channel/from-owner*` would have picked this up and would
 * also pick up the next sibling anyone creates, silently, with no decision made
 * about what it contains or how it should be parsed. These are two DIFFERENT
 * FILE FORMATS — one has owner-written front matter, the other has an
 * office-written transcription header — and they must be parsed by different
 * parsers and rendered as different sections. Naming the directory is what
 * forces that choice to be made rather than defaulted.
 */
export const OWNER_ISSUE_REPLIES_DIR = 'channel/from-owner-issues';

/**
 * The read record. In the OFFICE's directory, not the owner's, and that
 * placement is the contract rather than a filing convenience: a receipt is a
 * statement the office makes about itself, and putting it in `from-owner/`
 * would have the office writing into the owner's folder to assert that it had
 * behaved. Append-only; nothing is ever removed.
 */
export const READ_LOG_PATH = 'channel/from-office/READ-LOG.md';

/** The office→owner submissions ledger (Phase 2 — see SUBMISSION_FIELDS). */
export const SUBMISSIONS_PATH = 'channel/to-owner/SUBMISSIONS.md';

/* ──────────────────────── Owner → office: messages ─────────────────────── */

/**
 * The owner-side `kind` vocabulary.
 *
 * `channel/README.md` already defines `delivery | emergency | question | reply`
 * for the channel as a whole, written when only the office→owner direction
 * existed. Those are the shapes a message from the OFFICE takes. A message from
 * the OWNER is a different act and needs its own words; `delivery` in
 * particular is meaningless in this direction.
 *
 * EXTENDED, never replaced — `emergency` and `reply` are carried through with
 * exactly their existing meanings so a reader of one README is not surprised by
 * the other. The three new ones are the acts the policy actually requires a
 * channel for:
 *
 *   instruction  do this / stop doing that. A11's "nobody can obey what they
 *                cannot see", applied to an instruction rather than a rule.
 *   decision     the ruling on an admin objection (A8) or a binding vote the
 *                office referred up. The thing OB-010 has no last hop for.
 *   approval     A4's exit. The one act that moves a deliverable past
 *                CEO-approved to shipped, and the office cannot perform it.
 */
export const OWNER_KINDS = Object.freeze([
  'instruction', 'decision', 'approval', 'emergency', 'reply',
]);

/**
 * The kind a message with NO front-matter block is read as (2026-08-23).
 *
 * ── WHY THE REFUSAL WAS REPLACED, AND WHY ONLY FOR THIS CASE ────────────
 *
 * The original reasoning — `kind` is load-bearing, so a message that cannot
 * state it must be refused rather than guessed — is sound, and the OUTCOME was
 * wrong. Both of the only two messages the owner has ever hand-written into
 * `channel/from-owner/` were refused for having no header, and one of them was
 * the first real deliverable ever assigned to this office. **A message the
 * office cannot classify must be classified conservatively, not discarded.**
 *
 * `instruction` is the conservative choice, and "conservative" here means
 * exactly one thing: it is the only kind in the vocabulary with no automated
 * consequence anywhere in this codebase.
 *
 *   emergency  sorts to the head of `classifyOwnerMessages()` and asserts the
 *              office has STOPPED and is waiting — an alert path, and the one
 *              kind a default must never reach for.
 *   approval   is A4's exit: the act that moves a deliverable past CEO-approved
 *              to shipped. Defaulting to it would let a message nobody could
 *              read ship work.
 *   decision   claims to be the ruling on an admin objection or a referred vote.
 *   reply      threads onto a prior message through `re:`, which an unheaded
 *              file cannot supply, so it would thread onto nothing.
 *   instruction  reaches every rank in full and is READ. Nothing branches on it.
 *
 * ── AND WHY THE DEFAULT IS RECORDED RATHER THAN JUST APPLIED ────────────
 *
 * A defaulted kind and a stated kind are different facts, and the whole
 * argument for refusing was that collapsing them is dangerous. So they are not
 * collapsed: `message.kindDefaulted` is `true` whenever this value was supplied
 * by the parser rather than written by the owner, and every surface that shows
 * the kind says so. Anything downstream that reads a defaulted kind as an
 * asserted one is a bug, and the flag is what makes that bug findable.
 */
export const DEFAULT_OWNER_KIND = 'instruction';

/**
 * `status:` — what the OFFICE has done about the message. The owner writes
 * `open` (or omits it, which means the same) and never touches it again.
 *
 * `acted` is the only terminal value the office may write, and writing it
 * requires an `Acted:` line — see parseOwnerMessage(). A status flip with
 * nothing behind it is exactly the claim-without-evidence this module is built
 * to make impossible, so the parser REFUSES it rather than believing it.
 */
export const OWNER_STATUSES = Object.freeze(['open', 'acted', 'closed']);

/**
 * The filename shape: date first, so a plain `ls` sorts chronologically.
 *
 * ── TWO SHAPES ARE ACCEPTED AT THE DOOR, ONE IS STORED (2026-08-23) ──────
 *
 * `YYYY-MM-DD-<slug>.md` was the only accepted form until this date, and it
 * refused the first real client-shaped deliverable the owner ever assigned:
 * `17-08-2026-build-contract-reader-tool.md`, delivered 2026-08-17, sat unread
 * for six days because it is written day-month-year — which is the standard
 * date format in Israel and the one the owner uses and will keep using.
 *
 * **The office does not get to refuse the client's own handwriting.** So both
 * shapes are accepted, and the disambiguation rule is fixed rather than
 * improvised:
 *
 *   first component is 4 digits   ->  YYYY-MM-DD
 *   last component is 4 digits    ->  DD-MM-YYYY
 *   both would read               ->  DD-MM-YYYY, the owner's convention wins
 *   neither                       ->  refused, exactly as before
 *
 * The DD-MM-YYYY pattern is therefore tried FIRST — that ordering IS the
 * third rule, not an accident of how the code fell out.
 *
 * **Only what is accepted changed. What is STORED did not.** Every name is
 * normalised to `YYYY-MM-DD` before it becomes `message.date`/`message.id`, so
 * directory ordering, `readKey()`, reply threading and every read record
 * written before today keep meaning exactly what they meant.
 *
 * Range checking (is `99` a month?) is deliberately NOT added here: the
 * previous regex did not do it either, and tightening what the channel refuses
 * in the same change that loosens it would make a regression impossible to
 * attribute. An out-of-range component normalises and reads as a nonsense date,
 * which is visible, rather than making the client's message disappear.
 */
const OWNER_FILE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9][a-z0-9-]*)\.md$/;
const OWNER_FILE_DMY_RE = /^(\d{2})-(\d{2})-(\d{4})-([a-z0-9][a-z0-9-]*)\.md$/;

/**
 * Reads an owner message filename into a normalised `YYYY-MM-DD` date and a
 * slug. Exported so `scripts/verify-owner-channel.js` can assert the
 * disambiguation rule directly rather than inferring it from a parsed message.
 *
 * @returns {{ok: true, date: string, slug: string, written: string}
 *          | {ok: false}}
 */
export function parseOwnerFilename(filename) {
  const name = String(filename || '').trim();

  // DD-MM-YYYY FIRST. Where both shapes could read a name the owner's
  // convention wins, and trying it first is how that rule is enforced.
  const dmy = OWNER_FILE_DMY_RE.exec(name);
  if (dmy) {
    const [, dd, mm, yyyy, slug] = dmy;
    return { ok: true, date: `${yyyy}-${mm}-${dd}`, slug, written: 'DD-MM-YYYY' };
  }

  const iso = OWNER_FILE_ISO_RE.exec(name);
  if (iso) {
    const [, yyyy, mm, dd, slug] = iso;
    return { ok: true, date: `${yyyy}-${mm}-${dd}`, slug, written: 'YYYY-MM-DD' };
  }

  return { ok: false };
}

/** One `key: value` line from the YAML-ish front matter block. */
function frontField(front, key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'mi').exec(front);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * Parses one owner message file.
 *
 * REFUSES, does not guess — `office-context.js`'s parser posture, applied here
 * for a sharper reason than usual. A malformed BOARD task that silently
 * defaulted would misreport the office's own workload. A malformed OWNER
 * message that silently defaulted would misreport an INSTRUCTION, and the
 * office would act on a reconstruction of what the client said. There is no
 * safe default for that, so there is no default.
 *
 * @param {string} text      the file's contents
 * @param {string} filename  basename, e.g. "2026-08-10-ship-the-site.md"
 * @param {string} [sha]     the git blob SHA from the Contents API listing
 * @returns {{ok: true, message: object} | {ok: false, reason: string}}
 */
export function parseOwnerMessage(text, filename, sha = null) {
  const nameMatch = parseOwnerFilename(filename);
  if (!nameMatch.ok) {
    return {
      ok: false,
      reason: `${filename}: filename is not YYYY-MM-DD-<slug>.md or DD-MM-YYYY-<slug>.md — the date prefix is what orders the directory and the slug is what threads a reply to it. The slug must be lower-case letters, digits and hyphens only, and the file must end .md`,
    };
  }
  const { date: fileDate, slug } = nameMatch;

  const src = String(text || '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);

  /*
   * ── NO FRONT MATTER IS NO LONGER FATAL (2026-08-23) ─────────────────────
   *
   * It used to be. It refused both of the owner's only two hand-written
   * messages, including the contract-analyst task — see DEFAULT_OWNER_KIND for
   * the full reasoning and for why `instruction` is the conservative landing
   * place rather than an arbitrary one.
   *
   * The whole file becomes the body, and `kindDefaulted` records that the kind
   * below is the parser's and not the owner's.
   *
   * **A message that DOES have a front-matter block is handled exactly as
   * before** — an absent or unrecognised `kind` inside a header the owner
   * actually wrote is still refused, because there he did state something and
   * the office reading past it would be overriding him rather than covering for
   * a habit he never had.
   */
  const hasFrontMatter = !!fm;
  const front = hasFrontMatter ? fm[1] : '';
  const bodyRaw = hasFrontMatter ? fm[2] : src;

  let kind = DEFAULT_OWNER_KIND;
  const kindDefaulted = !hasFrontMatter;
  if (hasFrontMatter) {
    kind = (frontField(front, 'kind') || '').toLowerCase();
    if (!OWNER_KINDS.includes(kind)) {
      return {
        ok: false,
        reason: `${filename}: kind "${kind || 'absent'}" is not one of ${OWNER_KINDS.join(' | ')} — refused rather than defaulted, because the default would decide how urgently the office treats the client's own words`,
      };
    }
  }

  // `status:` absent means `open`. That is the ONLY defaulted field in this
  // parser and it is safe in exactly one direction: an absent status reads as
  // "the office has not acted", which understates the office and never the
  // owner. The inverse default would let a missing line look like completed work.
  const statusRaw = (frontField(front, 'status') || 'open').toLowerCase();
  if (!OWNER_STATUSES.includes(statusRaw)) {
    return { ok: false, reason: `${filename}: status "${statusRaw}" is not one of ${OWNER_STATUSES.join(' | ')}` };
  }

  const body = String(bodyRaw || '').trim();
  if (!body) {
    return { ok: false, reason: `${filename}: header parsed but the body is empty — there is no instruction to read` };
  }

  // `Acted:` is the evidence behind a `status: acted` claim. Required, and the
  // requirement is the whole point: the office may not mark its own homework
  // with a one-word field. The line names what was done and where it landed.
  const acted = /^-?\s*\*{0,2}Acted:\*{0,2}\s*(.+)$/mi.exec(body);
  if (statusRaw === 'acted' && !acted) {
    return {
      ok: false,
      reason: `${filename}: status is "acted" with no "Acted:" line saying what was done — a status flip with nothing behind it is a claim, and this channel does not accept claims as evidence`,
    };
  }

  const titleMatch = /^#\s+(.+)$/m.exec(body);

  return {
    ok: true,
    message: {
      id: `${fileDate}-${slug}`,
      path: `${OWNER_DIR}/${filename}`,
      filename,
      date: frontField(front, 'date') || fileDate,
      slug,
      kind,
      // TRUE means the office chose this kind, not the owner. Never collapse
      // the two — see DEFAULT_OWNER_KIND.
      kindDefaulted,
      status: statusRaw,
      re: frontField(front, 're') || 'new',
      // `to:` (2026-08-11, Phase 3) — OPTIONAL, unvalidated free text (an
      // agent id, a name, a role slug — whatever the owner writes). Absent
      // means GENERAL: the message reaches every rank in full, unchanged
      // from before this field existed. Present means ADDRESSED: only the
      // matching agent sees it in full — see messageAddressesAgent() below.
      // Not in OWNER_KINDS/OWNER_STATUSES-style enum on purpose — the owner
      // should never get a REFUSED message because he wrote "Designer"
      // instead of "9".
      to: frontField(front, 'to') || null,
      title: titleMatch ? titleMatch[1].trim() : slug.replace(/-/g, ' '),
      body,
      acted: acted ? acted[1].trim() : null,
      sha: sha || null,
    },
  };
}

/**
 * Does an owner message's `to:` field address THIS agent?
 *
 * Pure string match — this module imports no agent config (its whole-file
 * rule), so it does not resolve "designer" to 9 itself. The caller (which
 * already knows its own identity — agent-base.js has `this.id` and
 * `this.config.name`) supplies whatever it wants matched against: an id
 * number, a name, a key. Both sides are normalized the same way (lower-
 * cased, a leading "the " stripped) so `to: designer`, `to: Designer`,
 * `to: "The Designer"` and `to: 9` all match agent 9 if the caller passes
 * `[9, 'The Designer']` as candidates.
 *
 * No `to:` at all means GENERAL — reaches everyone, always true.
 */
export function messageAddressesAgent(to, candidates = []) {
  if (!to) return true;
  const norm = String(to).trim().toLowerCase().replace(/^the\s+/, '');
  return candidates.some((c) => {
    if (c === null || c === undefined || c === '') return false;
    return String(c).trim().toLowerCase().replace(/^the\s+/, '') === norm;
  });
}

/* ─────────────────────────── The read record ───────────────────────────── */

/**
 * The identity a read record is keyed on: the message AND the content it had.
 *
 * NOT the message id alone. The owner edits from a phone, and a message he
 * corrects after the office read it is new information wearing an old name. A
 * key that ignored content would let the first read receipt cover every later
 * version, which is the same "read and ignored looks like read" failure one
 * level down — and it would fail silently, in the direction that flatters the
 * office.
 *
 * The SHA is truncated to 12 because these are rendered into prompts and a
 * 40-character hash per message is budget spent on nothing; 12 hex characters
 * is not a collision anyone in this project will meet.
 */
export function readKey(message) {
  const sha = String(message?.sha || '').slice(0, 12);
  return sha ? `${message.id}@${sha}` : `${message.id}@NO-SHA`;
}

const READ_LOG_ROW_RE = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/gm;

/**
 * Parses `channel/from-office/READ-LOG.md`'s table into read records.
 *
 * Absence is NOT a parse failure — an office that has never been written to has
 * an empty log, and reporting that as an error would put a permanent complaint
 * into every prompt for as long as the owner had said nothing. Same rule the
 * questions channel already keeps in `office-context.js`.
 */
export function parseReadLog(markdown) {
  const src = String(markdown || '');
  const records = [];
  const byKey = new Map();
  let m;
  READ_LOG_ROW_RE.lastIndex = 0;
  while ((m = READ_LOG_ROW_RE.exec(src)) !== null) {
    const [, readAt, key, cycle, note] = m;
    if (/^-+$/.test(readAt) || /^read/i.test(readAt)) continue; // header / separator rows
    const rec = { readAt: readAt.trim(), key: key.trim(), cycle: cycle.trim(), note: note.trim() };
    records.push(rec);
    if (!byKey.has(rec.key)) byKey.set(rec.key, rec);
  }
  return { ok: true, records, byKey };
}

/**
 * Renders the read log. WHOLE FILE, from all records — the log is append-only
 * in MEANING, and this function is given every prior record plus the new ones.
 *
 * Rewriting rather than appending is a deliberate trade with a stated reason:
 * the GitHub Contents API has no append, so an "append" is a read-modify-write
 * either way. Doing it explicitly means the caller holds every row it is about
 * to publish and a dropped row is a visible diff, instead of an append that
 * silently truncated.
 */
export function renderReadLog(records) {
  const rows = records
    .slice()
    .sort((a, b) => String(a.readAt).localeCompare(String(b.readAt)))
    .map((r) => `| ${r.readAt} | \`${r.key}\` | ${r.cycle || '—'} | ${r.note || '—'} |`);

  return `# READ LOG — what the office has actually read from the owner

**Classification:** private · **Direction:** a statement the office makes about itself
**Written by:** \`office-AI-agents/workers/owner-channel.js\` \`renderReadLog()\`, from the
daily \`owner_channel\` block. **Append-only. Nothing here is ever removed.**

> **This file is the deliverable, not the folder of messages.**
> \`channel/from-brain/README.md\` states the rule this inherits, in the brain's
> own words when it approved its direction of the channel: *treat the record as
> the deliverable, not the copy.* A directory of owner messages cannot tell an
> unread message from one read and ignored. A dated row naming the message AND
> THE CONTENT SHA IT CARRIED can.

**What a row proves, stated narrowly:** the office's context carried that
message's content on that date. It does **not** prove any individual agent
attended to it, and nothing in this project can prove that. The narrower claim
was chosen deliberately — see \`owner-channel.js\`'s header for why per-model-call
recording was refused.

**The key is \`<message-id>@<sha12>\`.** If the owner edits a message after the
office read it, the SHA changes and the message returns to UNREAD. A stale
receipt can never mask new content.

| Read at (UTC) | Message key | Cycle | Note |
|---|---|---|---|
${rows.length ? rows.join('\n') : '| — | `none-yet` | — | no owner message has been read yet |'}

*(${rows.length} record${rows.length === 1 ? '' : 's'}.)*
`;
}

/**
 * D1 mirror of the read log.
 *
 * Created LAZILY and deliberately NOT in `database/schema.sql` — the same call
 * `repo-write.js` REPO_WRITE_TABLE_SQL and `task-router.js`
 * PROVIDER_USAGE_TABLE_SQL made, for the same reason.
 *
 * WHY BOTH A FILE AND A TABLE, since two sources of truth is the defect this
 * project keeps finding: they answer different questions and neither can answer
 * the other's. The FILE is what the owner reads — he opens the repo on his
 * phone, and a D1 table is invisible to him. The TABLE is what the daily report
 * queries, and it survives a repo write that failed. **The file is
 * authoritative** where they disagree, because it is the one both parties can
 * see; the table is a cache of it and says so here so nobody later treats a
 * missing row as proof of a missing read.
 */
export const OWNER_READS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS owner_channel_reads (
  id TEXT PRIMARY KEY,
  message_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sha TEXT,
  kind TEXT,
  cycle TEXT,
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * Records one read. Cannot throw — `recordRepoWrite()`'s posture, quoted here
 * because the reasoning transfers exactly: *a failed record is a lost
 * measurement; a failed write is lost work, and the two are not comparable.*
 * A broken recorder must never stop the office reading its mail.
 */
export async function recordOwnerRead(env, { message, cycle = null, note = null }) {
  try {
    if (!env?.DB) return { recorded: false, reason: 'no_db_binding' };
    await env.DB.prepare(OWNER_READS_TABLE_SQL).run();
    await env.DB.prepare(
      `INSERT INTO owner_channel_reads (id, message_key, message_id, sha, kind, cycle, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), readKey(message), message.id, message.sha || null,
      message.kind || null, cycle, note
    ).run();
    return { recorded: true };
  } catch (err) {
    console.warn(`[owner-channel] could not record the read of ${message?.id}, continuing: ${err?.message || err}`);
    return { recorded: false, reason: 'record_error' };
  }
}

/* ───────────────────────── Classification & render ─────────────────────── */

/**
 * Splits owner messages into the three states a single `status:` field cannot.
 *
 * @param {Array}  messages  from parseOwnerMessage()
 * @param {object} readLog   from parseReadLog()
 */
export function classifyOwnerMessages(messages, readLog) {
  const byKey = readLog?.byKey || new Map();
  const unread = [];
  const readNotActed = [];
  const acted = [];

  for (const msg of messages) {
    const record = byKey.get(readKey(msg)) || null;
    const decorated = { ...msg, readAt: record?.readAt || null };
    if (msg.status === 'acted' || msg.status === 'closed') acted.push(decorated);
    else if (!record) unread.push(decorated);
    else readNotActed.push(decorated);
  }

  // Unactioned = everything the office still owes something on, newest first.
  // An emergency sorts ahead of everything regardless of date: `channel/README.md`
  // says an emergency means the office has STOPPED and is waiting, and a stopped
  // office reading about it third is the ordering that makes the field useless.
  const unactioned = [...unread, ...readNotActed].sort((a, b) => {
    if ((a.kind === 'emergency') !== (b.kind === 'emergency')) return a.kind === 'emergency' ? -1 : 1;
    return String(b.date).localeCompare(String(a.date));
  });

  return {
    unactioned,
    unread,
    readNotActed,
    acted,
    counts: {
      total: messages.length,
      unactioned: unactioned.length,
      unread: unread.length,
      readNotActed: readNotActed.length,
      acted: acted.length,
      emergency: unactioned.filter((m) => m.kind === 'emergency').length,
    },
  };
}

/**
 * How much of a message body reaches a prompt.
 *
 * The `agent` shape is spent on EVERY model call, of which there are ~150 a
 * day. A 2,000-character instruction rendered there is 2,000 characters × 150,
 * and `office-context.js`'s whole standard-rank budget is 380 tokens. So the
 * agent shapes get the instruction's opening and an explicit pointer; meetings
 * and reports — one call each, and the report makes no model call at all — get
 * the message whole.
 *
 * The marker is NOT optional. `office-context.js` firstSentence()'s rule
 * applies with more force here than where it was written: an abridged
 * instruction that does not say it is abridged reads as the whole instruction,
 * and the office would then act on a fragment of what the client asked for.
 */
function bodyForShape(message, shape) {
  const stripped = message.body.replace(/^#\s+.+$/m, '').trim();
  if (shape !== 'agent') return stripped;
  const firstPara = stripped.split(/\r?\n\s*\r?\n/)[0].trim();
  const abridged = firstPara.length < stripped.length;
  return abridged
    ? `${firstPara}\n[ABRIDGED — this is the opening of the instruction, not all of it. Full text: back-office ${message.path}]`
    : firstPara;
}

/**
 * The office-context sections for the owner→office direction.
 *
 * ── WHY THESE SIT AT THE VERY TOP, ABOVE THE BOARD ──────────────────────
 *
 * *An owner message outranks the board.* If he writes something it is not one
 * input among many. The board's own README reserves the `Urgency` field to the
 * owner alone — *"see the README's note on why that field is his alone"* — and
 * an owner message IS that field arriving directly rather than through a task.
 * So it renders at `headline` priority, which `fitToBudget()` drops last and
 * never trims, and the text says the precedence out loud rather than relying on
 * position to imply it.
 *
 * ── AND WHY EVERY RANK SEES IT, INCLUDING STANDARD AGENTS ───────────────
 *
 * A11 withholds the office-wide recitations from regular agents. It does not
 * withhold instructions: *"Everyone sees the client requirements and this
 * policy. Nobody can obey what they cannot see."* An owner message is the same
 * class of thing as a client requirement — it is the client saying what he
 * wants — so it is in STANDARD_SECTIONS. Rank filtering decides who sees the
 * office's own chatter, never who sees the client's instructions.
 *
 * `candidates` (2026-08-11, Phase 3) — identifiers for the agent THIS call is
 * building context for (e.g. `[9, 'The Designer']`), used to scope ADDRESSED
 * messages. Only meaningful for the `agent` shape: meetings and reports are
 * a multi-agent/owner-facing forum, not one persona's prompt, so they still
 * see every message regardless of addressee — scoping is about who a single
 * agent's prompt reaches, not about hiding office state from a meeting.
 *
 * @returns {Array} sections in `office-context.js`'s shape
 */
export function ownerMessageSections(classified, { shape = 'agent', candidates = [], malformed = [] } = {}) {
  const sections = [];
  const c = classified.counts;
  const refused = (Array.isArray(malformed) ? malformed : []).filter(Boolean);

  /*
   * ── A REFUSED MESSAGE IS A THIRD STATE, AND IT USED TO BE INVISIBLE ─────
   *
   * The line below always promised that *"the owner has written nothing"* and
   * *"the channel could not be read"* would never look alike. It kept that
   * promise for a whole-channel read failure — which lands in
   * `office-context.js`'s `errors` — and broke it for the case that actually
   * happened: ONE file that parses `ok: false`. A refused message never enters
   * `classified`, so `c.total` stayed 0 and this section rendered the literal
   * sentence **"none. The owner has not written to the office."**
   *
   * That is what it said, in every prompt, from 2026-08-12 to 2026-08-17, while
   * `channel/from-owner/2026-08-12-short-slug.md` — seven numbered items,
   * including a direct instruction and the answer to `Q-001` — sat on disk
   * refused for having no front-matter block. The refusal itself is right
   * (`kind` is load-bearing and must not be guessed). Recording it ONLY as a
   * `console.warn` in a Worker log was the defect.
   *
   * So it is rendered here, at headline priority, ahead of everything: the
   * office cannot read what the client wrote, and that is the loudest fact the
   * channel can produce — louder than any message it CAN read, because a
   * message it can read is at least being worked.
   */
  if (refused.length) {
    sections.push({
      label: 'owner-messages-unreadable',
      priority: 0,
      header: `⚠️ THE OWNER WROTE ${refused.length} MESSAGE(S) THE OFFICE CANNOT READ — his words are NOT below.`,
      // The guidance rides as a trailing ITEM, not as `text`: renderSection()
      // drops `text` whenever `items` is present, so a section that set both
      // would silently lose the half that says what to do about it.
      items: [
        ...refused.map((r) => `- ${r}`),
        '- Do not treat the channel as quiet. A refused message is the client talking and the office not listening.'
          + ' An agent may NOT fix it: `channel/from-owner/README.md` reserves changes in that folder to the owner,'
          + ' taken with a supervised session. Escalate it as an owner-facing item naming WHICH file and WHAT its header is missing.',
      ],
    });
  }

  // The count line renders even at zero. "The owner has written nothing" and
  // "the channel could not be read" are different facts and must not look
  // alike — this project's most-repeated defect shape, and the second fact
  // lands in office-context.js's `errors` section instead.
  sections.push({
    label: 'owner-messages-count',
    priority: 0, // PRIORITY.headline — office-context.js owns the enum; this is its value.
    text: c.total === 0
      ? `OWNER MESSAGES (back-office channel/from-owner/): none readable.${refused.length
        ? ` ${refused.length} message(s) were REFUSED and are named above — this is NOT an empty channel.`
        : ' The owner has not written to the office.'}`
      : `OWNER MESSAGES (back-office channel/from-owner/): ${c.total} on record — `
        + `${c.unactioned} still needing action (${c.unread} never read by the office, ${c.readNotActed} read and not yet acted on), `
        + `${c.acted} acted on and closed.`
        + (c.emergency ? ` ${c.emergency} of them are marked EMERGENCY — the office is expected to have STOPPED and be waiting.` : ''),
  });

  if (!classified.unactioned.length) return sections;

  // Addressed vs general — ONLY scoped for the `agent` shape. An addressed
  // message not meant for this agent drops out of the full-text list and
  // collapses into a count, the exact pattern `acted` messages already use
  // above: never silently dropped (the count is the receipt it happened),
  // never rendered as if it were this agent's business.
  const visible = shape === 'agent'
    ? classified.unactioned.filter((m) => messageAddressesAgent(m.to, candidates))
    : classified.unactioned;
  const elsewhere = classified.unactioned.length - visible.length;

  if (!visible.length) {
    if (elsewhere) {
      sections.push({
        label: 'owner-messages-addressed-elsewhere',
        priority: 0,
        text: `${elsewhere} owner message(s) awaiting action are addressed to (an)other agent(s) — not shown here.`,
      });
    }
    return sections;
  }

  sections.push({
    label: 'owner-messages',
    priority: 0,
    header: 'THE OWNER HAS WRITTEN TO THE OFFICE — this OUTRANKS the delegation board.'
      + ' Urgency is the client\'s to assign and nobody else\'s; a message here is that urgency arriving directly'
      + ' instead of through a board task. Do what it says before you pick up board work'
      + (elsewhere ? ` (${elsewhere} more addressed to (an)other agent(s), not shown here).` : ''),
    items: visible.map((m) => {
      const state = m.readAt
        ? `READ ${m.readAt} AND NOT YET ACTED ON`
        : 'NOT YET READ BY THE OFFICE';
      const addressee = m.to ? ` — ADDRESSED TO: ${m.to}` : ' — general, for everyone';
      // A DEFAULTED kind is marked here and nowhere else is it allowed to look
      // stated. The owner wrote no header on this message; `instruction` is the
      // office's conservative reading of it, and an agent acting on the kind
      // rather than on the words is acting on our guess.
      const kindShown = m.kindDefaulted
        ? `${m.kind.toUpperCase()} — KIND NOT STATED BY THE OWNER, DEFAULTED BY THE OFFICE`
        : m.kind.toUpperCase();
      return `- [${kindShown}] ${m.id} (${m.date}) — ${m.title} — ${state}${addressee}\n`
        + `  ${bodyForShape(m, shape).replace(/\n/g, '\n  ')}`;
    }),
  });

  return sections;
}

/* ───────────── Owner → office: replies transcribed from Issues ─────────── */

/**
 * Parses one file out of `channel/from-owner-issues/`.
 *
 * ── A DIFFERENT FORMAT, PARSED BY A DIFFERENT PARSER, DELIBERATELY ───────
 *
 * `parseOwnerMessage()` above refuses a file with no front-matter block, and
 * that refusal is correct for a file THE OWNER wrote: `kind` is load-bearing and
 * must not be guessed. It would be nonsense here. These files are written by
 * `agent-runner.js` `recordIssueReplies()` in a fixed shape the office controls
 * end to end — a `- **Field:** value` header block, a provenance note, a `---`
 * rule, then the client's words verbatim. There is no front matter because the
 * owner never wrote one; he typed into a comment box.
 *
 * So the two never share a parser. Reusing `parseOwnerMessage()` here would have
 * refused every reply for lacking a header the client had no way to supply,
 * which is exactly the failure the 2026-08-23 `DEFAULT_OWNER_KIND` change was
 * made to stop repeating.
 *
 * ── EVERY FIELD IS OPTIONAL EXCEPT THE BODY ──────────────────────────────
 *
 * This parser is DELIBERATELY permissive where `parseOwnerMessage()` is strict,
 * and the asymmetry is the point rather than an inconsistency. A refusal there
 * protects against acting on a guess about what the OWNER meant. Here the only
 * thing that could be lost is the office's own bookkeeping — an Issue number, a
 * comment id — and losing the client's words over a missing bookkeeping line
 * would be the office refusing to read him because its own transcription was
 * imperfect. The body is what matters; everything else degrades to `null` and
 * says so where it renders.
 *
 * @returns {{ok: true, reply: object} | {ok: false, reason: string}}
 */
export function parseIssueReply(text, filename, sha = null) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, reason: `${filename}: file is empty` };

  const field = (label) => {
    const m = new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s*(.+)$`, 'mi').exec(raw);
    return m ? m[1].trim() : null;
  };

  // The body is everything after the FIRST horizontal rule on its own line.
  // Anchored on the rule rather than on a line count, because the header block
  // gains fields over time and a count would silently start eating the message.
  const split = raw.split(/\r?\n---\r?\n/);
  const body = (split.length > 1 ? split.slice(1).join('\n---\n') : raw).trim();
  if (!body) return { ok: false, reason: `${filename}: no body after the '---' rule` };

  const issueRaw = field('Issue');
  const issueNumber = issueRaw ? ((/#(\d+)/.exec(issueRaw) || [])[1] || null) : null;
  // The Issue TITLE is what says which notification he was answering.
  const issueTitle = issueRaw ? (issueRaw.split('—').slice(1).join('—').trim() || null) : null;
  const written = field('Written');
  const date = (written || String(filename).slice(0, 10) || '').slice(0, 10) || null;

  return {
    ok: true,
    reply: {
      id: String(filename).replace(/\.md$/i, ''),
      path: `${OWNER_ISSUE_REPLIES_DIR}/${filename}`,
      sha,
      issueNumber,
      issueTitle,
      author: field('Author'),
      written,
      date,
      commentId: field('Comment id'),
      body,
    },
  };
}

/**
 * The body as a given shape sees it.
 *
 * Deliberately NOT `bodyForShape()`'s first-paragraph abridgement. That exists
 * because an owner MESSAGE file is a structured document with a title and
 * numbered items, where the opening paragraph genuinely carries the instruction.
 * An Issue comment is typically two sentences with no structure at all, and
 * taking its first paragraph can drop the operative half — the 2026-08-23
 * reply's second clause is *"and if you can't, tell me what you need"*, which is
 * precisely the part that tells the office what to do when it is stuck.
 *
 * So the whole comment rides in every shape, with a character cap as the only
 * limit, and the cap SAYS SO when it bites. These are short by construction; if
 * one is ever long enough to reach the cap, being told is better than a silent
 * trim of the client's words.
 */
function issueReplyBodyForShape(reply, shape) {
  const body = String(reply.body || '').trim();
  const CAP = shape === 'agent' ? 1200 : 4000;
  if (body.length <= CAP) return body;
  return `${body.slice(0, CAP)}\n[TRUNCATED at ${CAP} characters — this is NOT all of what the client wrote. Full text: back-office ${reply.path}]`;
}

/**
 * Whitespace-collapsed body text. THE ONLY NORMALISATION APPLIED, deliberately.
 *
 * Not casing, not punctuation, not wording. Two replies that differ in any of
 * those are TWO REPLIES and both are shown. The rule below has to be applicable
 * by hand by someone reading the two files, and every extra normalisation step
 * is another way for it to silence something the client said twice on purpose.
 */
function normaliseReplyBody(body) {
  return String(body || '').replace(/\s+/g, ' ').trim();
}

/**
 * Collapses replies that are THE SAME MESSAGE POSTED TO SEVERAL ISSUES.
 *
 * ── THE RULE, IN ONE SENTENCE ────────────────────────────────────────────
 *
 *   Two issue replies are the same message when their bodies are identical
 *   after collapsing runs of whitespace, AND they name the same author, AND
 *   they carry the same date — in which case the office shows the earliest one
 *   and records the other Issue numbers on it.
 *
 * All three conjuncts are required. Same body, different author is two people
 * agreeing. Same body a week later is the client saying it AGAIN because
 * nothing happened the first time — the single most important thing a reply can
 * mean, and it must never be folded into the original.
 *
 * ── WHY THE HEADER IS NOT PART OF THE COMPARISON ─────────────────────────
 *
 * It already cannot be. parseIssueReply() takes `body` as everything after the
 * first `---` rule, and the four lines that differ between copies — the title,
 * the `Issue:` line, `Written:` and `Comment id:` — all sit above it. So this
 * compares exactly what the client wrote and nothing the office stamped on.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * NOT a cap, and not a budget mechanism. Nothing here drops a message to save
 * tokens; it removes copies of text already present verbatim elsewhere in the
 * same prompt, and every distinct thing the client said still appears in full.
 * The saving is a consequence, never the criterion — see the 2026-08-23 finding
 * that fitToBudget() had been silently trimming `owner-messages` for two weeks,
 * which is the defect this channel exists to not repeat.
 *
 * MEASURED, 2026-08-27: five files in `channel/from-owner-issues/` (Issues
 * 37/38/39/40/47, comments 5408107654..5408110004, written 09:10:11Z through
 * 09:10:21Z) carry byte-identical bodies — one md5 across all five, differing
 * only in those four header lines. They are five REAL GitHub comments, not a
 * writer defect: `recordIssueReplies()` files one file per comment and is
 * idempotent by an explicit read. The client posted the same closing text to
 * five threads because the office had asked him the same question in five
 * notifications — which his own reply says in as many words.
 *
 * @param {Array} replies - parsed replies from parseIssueReply()
 * @returns {{kept: Array, collapsed: number}} `kept` preserves first-seen order;
 *   a survivor that absorbed copies carries `alsoPostedTo`.
 */
export function collapseDuplicateIssueReplies(replies) {
  const list = Array.isArray(replies) ? replies : [];
  const groups = new Map();

  for (const r of list) {
    /*
     * A null author or a null date does NOT match another null. An
     * unattributed reply is not evidence of sameness, and the office's own
     * transcriber records both fields — so a missing one is a defect worth
     * seeing twice, never a licence to merge two of the client's messages.
     */
    const key = (r.author && r.date)
      ? ['dup', normaliseReplyBody(r.body), r.author, r.date].join(' :: ')
      : ['solo', r.id].join(' :: ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const kept = [];
  let collapsed = 0;

  for (const group of groups.values()) {
    // Earliest first, by the timestamp the client's own comment carries.
    // `written` is ISO, so a lexical compare is a chronological one; `id`
    // breaks a tie so the survivor is deterministic rather than dependent on
    // the order the directory happened to list.
    const ordered = group.slice().sort((a, b) =>
      String(a.written || '').localeCompare(String(b.written || ''))
      || String(a.id || '').localeCompare(String(b.id || '')));

    const survivor = ordered[0];
    const others = ordered.slice(1);
    collapsed += others.length;

    kept.push(others.length
      ? { ...survivor, alsoPostedTo: others.map((o) => ({ issueNumber: o.issueNumber, commentId: o.commentId, path: o.path })) }
      : survivor);
  }

  return { kept, collapsed };
}

/**
 * The office-context sections for the client's Issue replies.
 *
 * ── A SEPARATE SECTION, NOT A MERGE INTO `owner-messages` ────────────────
 *
 * These could have been folded into `classifyOwnerMessages()` and rendered as
 * one undifferentiated list of "things the client said". They are not, and the
 * reason is the same provenance claim that keeps the two directories apart: one
 * is a file the client wrote, the other is the OFFICE's transcription of a
 * comment he left. An agent reading a merged list could not tell which it was
 * holding, and the office would be presenting its own transcript as the client's
 * handwriting.
 *
 * ── WHAT THIS SECTION DOES NOT CLAIM ─────────────────────────────────────
 *
 * NO read/acted state. `READ-LOG.md` keys on a message id and a content SHA from
 * `channel/from-owner/`, and an Issue reply has neither in that vocabulary, so
 * there is no honest way to say one of these has been acted on yet. Every reply
 * therefore renders as OUTSTANDING until something exists that can say
 * otherwise. That is the conservative direction, and it is stated here rather
 * than left looking like an oversight: an answered reply that still reads as
 * outstanding costs an agent one re-read; an unanswered one that reads as closed
 * is the failure this whole item exists to fix, committed a second time.
 *
 * Renders at headline priority in EVERY shape and for every rank, for the same
 * A11 reason `ownerMessageSections()` gives: *nobody can obey what they cannot
 * see*, and this is the client saying what he wants.
 *
 * @returns {Array} sections in `office-context.js`'s shape
 */
export function issueReplySections(replies, { shape = 'agent', malformed = [] } = {}) {
  const sections = [];
  const list = Array.isArray(replies) ? replies : [];
  const refused = (Array.isArray(malformed) ? malformed : []).filter(Boolean);

  if (refused.length) {
    sections.push({
      label: 'owner-issue-replies-unreadable',
      priority: 0,
      header: `⚠️ THE CLIENT REPLIED ${refused.length} TIME(S) AND THE OFFICE CANNOT READ ITS OWN TRANSCRIPT — his words are NOT below.`,
      items: [
        ...refused.map((r) => `- ${r}`),
        '- THIS ONE IS THE OFFICE\'S TO FIX. Unlike `channel/from-owner/`, these files are written by'
          + ' `agent-runner.js` recordIssueReplies() — so a malformed one is a defect in our own writer,'
          + ' not in the client\'s formatting, and no rule reserves it to him.',
      ],
    });
  }

  // Renders at ZERO, exactly as the owner-message count does. "He has not
  // replied" and "the reply directory could not be read" are different facts and
  // must not look alike; the second lands in office-context.js's errors section.
  // The same text posted to several Issues is shown once, with the other Issue
  // numbers named on the copy that is shown. See collapseDuplicateIssueReplies().
  const { kept, collapsed } = collapseDuplicateIssueReplies(list);

  sections.push({
    label: 'owner-issue-replies-count',
    priority: 0,
    text: list.length === 0
      ? `CLIENT REPLIES ON GITHUB ISSUES (back-office ${OWNER_ISSUE_REPLIES_DIR}/): none on record.${refused.length ? ` ${refused.length} were REFUSED and are named above — this is NOT an empty channel.` : ''}`
      : `CLIENT REPLIES ON GITHUB ISSUES (back-office ${OWNER_ISSUE_REPLIES_DIR}/): ${list.length} on record`
        + (collapsed
          ? `, ${kept.length} distinct. ${collapsed} of them are the SAME TEXT he posted to more than one Issue; each is shown ONCE, and the copy that is shown names every Issue it went to. NOTHING IS OMITTED — every distinct thing he said is below, in full.`
          : '.')
        + ' These are the office\'s TRANSCRIPTIONS of what he wrote in an Issue thread — his words, but NOT files he wrote himself.'
        + ' They carry NO read/acted state, so treat every one as OUTSTANDING until the work it asks for is done.',
  });

  if (!list.length) return sections;

  // Newest first. A client reply is the most recent thing he has said, and if a
  // budget squeeze ever trims this list the oldest is the right one to lose.
  const ordered = kept.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  sections.push({
    label: 'owner-issue-replies',
    priority: 0,
    header: 'THE CLIENT HAS REPLIED — this OUTRANKS the delegation board, exactly as a message in his own folder does.'
      + ' He answered where he was reading, which is the whole reason the office started filing his replies itself.'
      + ' Do what it says before you pick up board work.',
    items: ordered.map((r) => {
      const where = r.issueNumber
        ? `Issue #${r.issueNumber}${r.issueTitle ? ` — ${r.issueTitle}` : ''}`
        : 'ISSUE NUMBER NOT RECORDED BY THE OFFICE\'S OWN TRANSCRIBER';
      const who = r.author ? `by ${r.author}` : 'AUTHOR NOT RECORDED';
      /*
       * A COLLAPSED COPY IS RECORDED, NEVER VANISHED.
       *
       * Two readers have to be served by this line and they need opposite
       * things. The CLIENT must be able to see that his reply reached all five
       * threads, so he is not told the office lost four of them. An AGENT must
       * not conclude he said this once when he said it five times to five
       * different notifications — repetition is emphasis, and a dedup that
       * hides the count has edited his meaning while preserving his words.
       */
      const alsoLine = Array.isArray(r.alsoPostedTo) && r.alsoPostedTo.length
        ? `  HE POSTED THIS SAME TEXT, WORD FOR WORD, TO ${r.alsoPostedTo.length + 1} ISSUES: `
          + `#${r.issueNumber || '?'} (shown here) and ${r.alsoPostedTo.map((o) => `#${o.issueNumber || '?'}`).join(', ')}. `
          + 'One copy is shown because the text is identical; the others are on record at back-office '
          + `${OWNER_ISSUE_REPLIES_DIR}/. DO NOT READ THIS AS SAID ONCE — he answered every one of those threads.\n`
        : '';
      return '- [CLIENT REPLY — transcribed by the office from a GitHub Issue thread, NOT a file he wrote] '
        + `${r.date || 'DATE NOT RECORDED'} — ${where} — ${who}`
        + ' — NO READ/ACTED STATE EXISTS FOR THESE; TREAT AS OUTSTANDING\n'
        + alsoLine
        + `  ${issueReplyBodyForShape(r, shape).replace(/\n/g, '\n  ')}`;
    }),
  });

  return sections;
}

/* ─────────────────── Office → owner: submissions & ageing ──────────────── */

/**
 * ── THE AGE LADDER ───────────────────────────────────────────────────────
 *
 * OFFICE-POLICY A8, and this is the clause the ladder implements literally:
 *
 *   > **A question is never a stall.** The agent continues with everything not
 *   > blocked by the answer, and **keeps surfacing the question until it is
 *   > answered**. [...] **A question asked once and forgotten is the graveyard
 *   > this rule exists to prevent.**
 *
 * An entry that is asked once and then renders identically forever IS forgotten,
 * whatever the file says. The visibility has to change or "keeps surfacing" is a
 * sentence in a document rather than a behaviour. So an unanswered entry climbs:
 *
 *   FRESH      0–2 days   normal visibility, sits with its peers
 *   STANDING   3–6 days   named in every substantive meeting's agenda item
 *   OVERDUE    7–13 days  rises to headline priority — survives every budget
 *                         trim — and is named in the daily report
 *   ESCALATED  14+ days   maximum visibility, carried in every owner
 *                         notification, AND the fallback is TAKEN
 *
 * ── WHY THE TOP RUNG TAKES THE FALLBACK AND DOES NOT CLOSE THE ENTRY ────
 *
 * Because those are two different acts and collapsing them loses the honest
 * one. Taking the fallback is what `If no answer comes:` promised and it is how
 * the office keeps moving — A8 again, *a question is never a stall*. Closing
 * the entry would be the office answering its own question and then recording
 * the answer as settled, which is exactly `CLIENT-REQUIREMENTS.md`'s named
 * failure: *a documented guess that the next session reads as a decision.*
 *
 * So the entry stays OPEN, keeps climbing, and keeps appearing — and the
 * deliverable it shaped says which assumption it was built on. The owner can
 * still answer on day 40 and the office will still be asking.
 *
 * ⚖️ **The numbers are reasoned, not measured** — the same honesty
 * `OFFICE-POLICY.md` applies to A3's own numbers. Nothing here has run for 14
 * days yet. Re-check with the policy on 2026-08-24.
 */
export const AGE_LADDER = Object.freeze([
  { rung: 'FRESH', minDays: 0, headline: false, inNotification: false, takeFallback: false },
  { rung: 'STANDING', minDays: 3, headline: false, inNotification: false, takeFallback: false },
  { rung: 'OVERDUE', minDays: 7, headline: true, inNotification: true, takeFallback: false },
  { rung: 'ESCALATED', minDays: 14, headline: true, inNotification: true, takeFallback: true },
]);

/** Whole days between two `YYYY-MM-DD` strings. Negative clamps to 0 — a future
 *  date is a typo, and a typo must never buy an entry a lower rung. */
export function daysBetween(fromDate, toDate) {
  const a = Date.parse(`${String(fromDate).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * The rung an entry has climbed to.
 *
 * An UNPARSEABLE date returns the TOP rung, not the bottom one. That is
 * deliberate and it is the only safe direction: an entry whose age cannot be
 * established is an entry nobody can say has been answered recently, and the
 * failure that matters here is an entry going quiet. Failing loud costs one
 * noisy line; failing quiet costs the thing A8 forbids.
 */
export function escalationFor(entryDate, today) {
  const days = daysBetween(entryDate, today);
  if (days === null) {
    return { ...AGE_LADDER[AGE_LADDER.length - 1], days: null, unparseableDate: true };
  }
  let found = AGE_LADDER[0];
  for (const rung of AGE_LADDER) if (days >= rung.minDays) found = rung;
  return { ...found, days, unparseableDate: false };
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * A REPLY STOPS THE REPEAT (2026-08-24)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS BROKEN ───────────────────────────────────────────────────────
 *
 * The office notified daily on every submission whose entry carried no
 * decision marker, and "carried no marker" was the ONLY question it asked.
 * The owner replied to Issue #47 on 2026-08-23 — a real answer, in the place
 * the Issue itself tells him to answer: *"Just reply to this issue."* The
 * office read it, recorded it, and committed it to
 * `channel/from-owner-issues/`. Then it sent him the same item again the next
 * day, because a comment does not fill a `Decision:` field.
 *
 * Eleven notifications, one reply, and the reply changed nothing. A channel
 * that repeats itself after being answered teaches the person on the other end
 * that answering does not work, which is the one failure this channel cannot
 * survive.
 *
 * ── THE NEW PREDICATE ─────────────────────────────────────────────────────
 *
 * Not "has this been decided" but **"has the owner done anything about this
 * since the office last raised it."** Three kinds of owner activity count, and
 * the office ALREADY READS ALL THREE — this is a new question asked of
 * existing readers, not a new reader:
 *
 *   1. the `Decision:` field filled / the heading marked  (`parseSubmissions`)
 *   2. a comment HE wrote on the item's Issue  (`fetchOwnerIssueComments`,
 *      which already filters to his own login and already returns dates)
 *   3. a file he wrote into `channel/from-owner/` naming the item
 *      (`parseOwnerMessage`)
 *
 * ── WHY IT STILL COMES BACK, ONCE (D3) ────────────────────────────────────
 *
 * A replied item must not become permanently invisible: he may have replied
 * with something that was not a decision, and the entry's `Decision:` field is
 * still empty, so the office still cannot record what he chose.
 *
 * So it is raised exactly ONCE more, on the day it crosses
 * `RERAISE_AFTER_DAYS`, and never again. The re-raise says what is MISSING —
 * the field is empty — and says nothing about whether his reply answered the
 * question. **The office does not judge his reply.** It cannot, and a machine
 * ruling on whether a person's sentence counted as an answer is a worse defect
 * than the repetition this fixes.
 *
 * Deliberately STATELESS: the single re-raise is a function of the reply's date
 * and today's, so no new table, column or flag has to stay true for it. The
 * cost is that a missed tick on exactly that day (~2.4% tick-miss rate) skips
 * the re-raise rather than deferring it. That is the safe direction — the
 * failure is one fewer message to a person who has already answered, and the
 * entry stays open, stays in the repo, and stays on the meeting agenda.
 */
export const RERAISE_AFTER_DAYS = 7;

/**
 * The office item ids a piece of text names.
 *
 * Used against an Issue BODY, which renders each item under its own
 * `### S-002 — ...` heading, and against a file the owner wrote. `S`/`Q` only:
 * a board `OB-NNN` is the office's own work and is not a thing he is being
 * asked to decide here.
 *
 * The boundaries matter — without them `S-2` matches inside `S-20`, and one
 * item's reply would silence another's.
 */
export function itemIdsInText(text) {
  const ids = new Set();
  for (const m of String(text || '').matchAll(/(^|[^A-Za-z0-9-])([SQ]-\d{3})(?![A-Za-z0-9-])/g)) {
    ids.add(m[2]);
  }
  return [...ids].sort();
}

/**
 * Has the owner acted on THIS item, and is today the one day it may be raised
 * again anyway?
 *
 * @param {string} itemId                    e.g. `S-002`
 * @param {Array<{itemId:string,at:string,source:string}>} ownerActivity
 * @param {string} today                     YYYY-MM-DD
 * @returns {{replied:boolean, at:string|null, source:string|null,
 *            days:number|null, reRaise:boolean, dateUnreadable:boolean}}
 */
export function classifyOwnerReply(itemId, ownerActivity = [], today) {
  const mine = (ownerActivity || [])
    .filter((a) => a && a.at && String(a.itemId) === String(itemId));
  if (!mine.length) {
    return { replied: false, at: null, source: null, days: null, reRaise: false, dateUnreadable: false };
  }

  // Latest wins. ISO-8601 and YYYY-MM-DD both sort correctly as strings, and
  // both are what the two sources actually produce.
  mine.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const latest = mine[mine.length - 1];
  const days = daysBetween(String(latest.at).slice(0, 10), today);

  // AN UNREADABLE DATE DOES NOT SILENCE AN ITEM. The office cannot establish
  // that he acted after it last asked, so it keeps asking — the same direction
  // the age ladder takes an unreadable date, and the safe one for a channel
  // whose characteristic failure is going quiet.
  if (days === null) {
    return { replied: false, at: latest.at, source: latest.source || null, days: null, reRaise: false, dateUnreadable: true };
  }

  return {
    replied: true,
    at: latest.at,
    source: latest.source || null,
    days,
    reRaise: days === RERAISE_AFTER_DAYS,
    dateUnreadable: false,
  };
}

/**
 * A submission's required fields.
 *
 * OFFICE-POLICY A8: *"The owner receives finished work, not questions. The
 * office does everything it can first, then submits a result with a
 * recommendation — the way one works with a real client."*
 *
 * That sentence is the whole difference between this file and
 * `OPEN-QUESTIONS.md`, and the field list is where it is enforced rather than
 * hoped for. A submission that has a `Decision needed:` and no `What we did:`
 * is a question wearing a submission's clothes, and the parser refuses it.
 *
 * `If no answer comes:` is carried over from the questions contract unchanged
 * and for the reason OB-023's own notes give: *it is the field that makes the
 * whole channel safe to leave unattended.* A submission with no fallback is a
 * stall dressed as a submission — the same sentence, one direction over.
 */
export const SUBMISSION_FIELDS = Object.freeze([
  'What we did', 'What we recommend', 'Decision needed', 'If no answer comes',
]);

const SUBMISSION_MARKERS = Object.freeze(['APPROVED', 'REJECTED', 'ANSWERED', 'WITHDRAWN']);

function submissionField(block, field) {
  const m = new RegExp(`^- \\*\\*${field}:\\*\\*\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n### |\\n---|$)`, 'm').exec(block);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

/**
 * Parses `channel/to-owner/SUBMISSIONS.md`.
 *
 * Same posture as `parseOpenQuestions()` — refuse, do not guess — and the
 * counts are DERIVED, never read from the file's own hand-maintained
 * "**Counts:**" line. If the two disagree the human line is the stale one.
 *
 * @param {string} markdown
 * @param {string} today  `YYYY-MM-DD`, passed in — this module makes no clock
 *                        call, so the verifier can pin a date and assert a rung.
 */
export function parseSubmissions(markdown, today) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, reason: 'submissions markdown was empty or not a string' };
  }

  /*
   * ── FENCED CODE BLOCKS ARE STRIPPED FIRST, AND THIS IS NOT COSMETIC ────
   *
   * `SUBMISSIONS.md` documents its own format by SHOWING one — a fenced
   * ```markdown block containing `### S-000 — …`, plus a worked example of a
   * decided heading. Without this strip, the contract's own illustration parses
   * as two live submissions: the office would report work awaiting the client's
   * decision that nobody ever submitted, and `S-000` would sit in a notification
   * to him.
   *
   * Caught by scripts/verify-owner-channel.js §9, which asserts the shipped file
   * parses to ZERO entries. That check exists precisely because "the ledger is
   * empty" is a claim a reader would otherwise have to take on trust.
   *
   * Replaced with blank lines rather than deleted, so every `index` below still
   * points at the right offset in the ORIGINAL string.
   */
  const scannable = markdown.replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '));

  const headingRe = /^### (S-\d{3}) — (.+)$/gm;
  const starts = [];
  let m;
  while ((m = headingRe.exec(scannable)) !== null) {
    starts.push({ id: m[1], heading: m[2].trim(), index: m.index });
  }
  // An empty submissions file is healthy — the office has nothing awaiting a
  // decision. Not a parse failure, exactly as an empty questions file is not.
  if (!starts.length) {
    return { ok: true, submissions: [], counts: { total: 0, open: 0, closed: 0, escalated: 0 }, malformed: [] };
  }

  const submissions = [];
  const malformed = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : markdown.length;
    const block = markdown.slice(starts[i].index, end);

    const fields = {};
    const missing = [];
    for (const f of SUBMISSION_FIELDS) {
      const v = submissionField(block, f);
      if (!v) missing.push(f);
      fields[f] = v;
    }
    if (missing.length) {
      malformed.push(
        `${starts[i].id}: missing ${missing.map((f) => `"${f}"`).join(', ')} — `
        + 'A8 requires a submission to be finished work with a recommendation, and every entry to say what happens on silence; '
        + 'an entry without those is a question wearing a submission\'s clothes'
      );
      continue;
    }

    const marker = SUBMISSION_MARKERS.find((k) => new RegExp(`—\\s*${k}\\s*$`).test(starts[i].heading)) || null;
    const date = (/^- \*\*Date:\*\*\s*(.+)$/m.exec(block) || [])[1]?.trim() || null;
    const open = marker === null;
    const escalation = open ? escalationFor(date, today) : null;

    submissions.push({
      id: starts[i].id,
      title: starts[i].heading.replace(/—\s*(?:APPROVED|REJECTED|ANSWERED|WITHDRAWN)\s*$/, '').replace(/~~/g, '').trim(),
      marker,
      open,
      date,
      submittedBy: (/^- \*\*Submitted by:\*\*\s*(.+)$/m.exec(block) || [])[1]?.trim() || null,
      did: fields['What we did'],
      recommend: fields['What we recommend'],
      decision: fields['Decision needed'],
      fallback: fields['If no answer comes'],
      escalation,
    });
  }

  if (!submissions.length) {
    return { ok: false, reason: `found ${starts.length} submission heading(s) but none was readable — ${malformed.join('; ')}` };
  }

  const open = submissions.filter((s) => s.open);
  return {
    ok: true,
    submissions,
    counts: {
      total: submissions.length,
      open: open.length,
      closed: submissions.length - open.length,
      escalated: open.filter((s) => s.escalation?.rung === 'ESCALATED').length,
      overdue: open.filter((s) => s.escalation?.headline).length,
    },
    malformed,
  };
}

/**
 * Applies the ladder to OPEN-QUESTIONS entries too.
 *
 * The questions channel predates the ladder and has the identical problem —
 * `Q-001` through `Q-004` were opened 2026-08-10 and would otherwise render the
 * same on day 1 and day 40. Rather than build a second ageing mechanism beside
 * this one (two mechanisms that must agree is the drift this project keeps
 * finding), `office-context.js` calls this and gets the same rungs.
 *
 * Takes the already-parsed question objects rather than the markdown: the
 * questions parser is `office-context.js`'s and stays there, so this module
 * does not become a second place questions are understood.
 */
export function ageQuestions(questions, today) {
  return questions.map((q) => (q.open
    ? { ...q, escalation: escalationFor(q.date, today) }
    : { ...q, escalation: null }));
}

/**
 * The same ladder, applied to owner-channel GitHub Issues (#36, #37, ... —
 * `[Office #N]`). Phase 1.2 of the 2026-08-11 audit-and-fix session found
 * the exact gap this closes: #37 was opened awaiting a decision and nothing
 * ever checked whether it got one — the ball was in the owner's court and
 * there was no read-back. `escalationFor()` already takes any `YYYY-MM-DD`
 * date, so an Issue's `created_at` ages exactly like a question or a
 * submission does; this is the SAME mechanism, not a second one.
 *
 * "Has a reply" is comment activity, OR the owner closing it himself.
 * `buildIssueBody()` (owner-notify.js) tells the owner directly that
 * closing the Issue "changes nothing" — the office never treats a closure
 * as an action taken on its own initiative, and it never closes an
 * owner-channel Issue itself (the session hard rule this file's caller
 * observes). So any closed owner-channel Issue was closed BY HIM, and that
 * is real reply signal even though the documented reply path is the repo,
 * not the tracker — a comment or a close are both lower-friction than
 * editing markdown and are exactly the kind of reply that would otherwise
 * go unread.
 *
 * `issues` is raw GitHub issue data already fetched by the caller:
 * `{ number, title, createdAt, state, comments }` — this module stays pure
 * (imports nothing) so the network call lives in agent-runner.js, same
 * split every other GitHub-touching function in this file uses.
 */
export function classifyOwnerIssueReadback(issues, today) {
  return (issues || []).map((it) => {
    const hasReply = (Number(it.comments) || 0) > 0 || it.state === 'closed';
    const createdDate = String(it.createdAt || '').slice(0, 10);
    return {
      number: it.number,
      title: it.title,
      state: it.state,
      comments: Number(it.comments) || 0,
      hasReply,
      escalation: hasReply ? null : escalationFor(createdDate, today),
    };
  });
}

/**
 * The office-context sections for the office→owner direction.
 *
 * Two sections and not one, because a submission and a question are different
 * acts: a submission is finished work awaiting a decision, and a question is
 * something the office could not establish. A meeting handed one blob treats
 * them the same and then wonders why the owner is being asked things instead of
 * shown things.
 */
export function submissionSections(parsed, { shape = 'agent' } = {}) {
  const sections = [];
  if (!parsed) return sections;
  const open = parsed.submissions.filter((s) => s.open);

  sections.push({
    label: 'submissions-count',
    /*
     * `headline`, and it was MEASURED into that slot rather than reasoned into
     * it — the same finding `deliverables-count` records one file over.
     *
     * At `status` the fitter dropped this line from EVERY agent shape, admin and
     * standard alike, at every budget up to 800. It is pushed after the
     * questions sections and the drop loop takes the later index among equal
     * priorities, so it was always the one to go. The effect was that an admin —
     * the rank that WRITES submissions under A8 — was never told how many were
     * already open, which is the single fact this line exists to carry and the
     * whole anti-duplication argument for having it.
     *
     * One line, dropped last, never trimmed. The alternative was raising the
     * per-call agent budget by ~300 tokens to buy the same line, which is
     * 45,000 extra input tokens a day for a sentence.
     */
    priority: 0, // PRIORITY.headline
    text: `Submissions awaiting the client's decision (back-office ${SUBMISSIONS_PATH}): `
      + `${open.length} open, ${parsed.counts.closed} decided.`
      + (parsed.counts.escalated ? ` ${parsed.counts.escalated} have gone 14+ days unanswered — their fallbacks have been TAKEN and they are STILL OPEN and still being asked.` : '')
      + ' A submission is finished work with a recommendation, never a question — read A8 before opening one.',
  });

  if (!open.length) return sections;

  // Escalated and overdue entries ride at `headline`, which is dropped last and
  // never trimmed. That IS the re-surfacing: the older an entry gets the harder
  // it is for the budget fitter to make it disappear. An entry that goes quiet
  // because the board grew is the graveyard A8 names.
  const risen = open.filter((s) => s.escalation?.headline);
  const calm = open.filter((s) => !s.escalation?.headline);

  if (risen.length) {
    sections.push({
      label: 'submissions-overdue',
      priority: 0,
      header: 'UNANSWERED AND RISING — the client has not decided these and they do not go quiet',
      items: risen.map((s) => `- ${s.id} [${s.escalation.rung}${s.escalation.unparseableDate ? ', DATE UNREADABLE — rung forced to the top because an entry whose age cannot be established must never look fresh' : `, ${s.escalation.days} days`}] ${s.title}`
        + ` — decision needed: ${s.decision}`
        + ` — ${s.escalation.takeFallback ? 'FALLBACK TAKEN' : 'on silence'}: ${s.fallback}`),
    });
  }
  if (calm.length && shape !== 'agent') {
    sections.push({
      label: 'submissions-open',
      priority: 1,
      header: 'Submitted to the client, awaiting a decision',
      items: calm.map((s) => `- ${s.id} [${s.escalation.rung}, ${s.escalation.days} days] ${s.title} — recommended: ${s.recommend}`),
    });
  }

  return sections;
}
