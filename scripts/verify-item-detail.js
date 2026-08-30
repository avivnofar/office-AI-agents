#!/usr/bin/env node
/**
 * scripts/verify-item-detail.js — does the expansion actually show the whole
 * item, and does it stay honest when it cannot?
 *
 * Written 2026-08-25 (Session 22, Item A). Run: node scripts/verify-item-detail.js
 *
 * ── THE STANDARD THIS IS WRITTEN TO ──────────────────────────────────────
 *
 *   > A test that describes a fix is not a test that catches a bug.
 *
 * The bug this endpoint exists to fix is a card that says a decision is needed
 * without saying enough to make it. So the central check is not "the response
 * has an `entry` key" — it is that the response for the REAL live shape of
 * OB-003 **names its blocker by identifier and carries that blocker's own
 * entry**, and that removing the blocker from the source file turns that into a
 * reported failure rather than a quiet absence.
 *
 * ── AND THE SECOND ONE, WHICH IS THE ONE THAT WOULD ACTUALLY BITE ────────
 *
 * §7 of ARCHITECTURAL-DECISIONS.md records six occurrences of one shape in this
 * estate: *the guard exists, and the calling path never reaches it.* So this
 * file also READS `agent-runner.js` and `admin-gate.js` and asserts that the
 * route is registered in the alias map, that it is inside `/api/admin` so the
 * shared prefix gate authenticates it, and that the handler contains no
 * authentication check of its own.
 *
 * NO NETWORK. `globalThis.fetch` is replaced with a tripwire that throws, so
 * "this module makes no network call" is proven rather than claimed — and the
 * git search is driven by an injected fake probe, which is the whole reason
 * `findFirstAppearance()` takes one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ITEM_SOURCES, ITEM_REPO, NO_STATED_DEFAULT, MAX_ORIGIN_PROBES,
  parseItemRef, extractEntry, entryFields, fieldValue,
  referencedItemIds, kindOfItemId, resolveBlockers,
  findFirstAppearance, statedDefault, buildItemDetail,
} from '../workers/item-detail.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

globalThis.fetch = () => { throw new Error('verify-item-detail.js: a network call was attempted — this module must make none'); };

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) { console.log(`\n${title}`); }

/* ════════════════════ Fixtures — the live shapes, not tidy ones ═══════════ */

/**
 * OB-003 and OB-001 as the live board carried them on 2026-08-25, plus one task
 * whose `Blocked by:` names no identifier at all (the shape
 * `renderBoardTask()` writes for an undecided action item) and one whose
 * `Notes:` runs onto a second line.
 */
const BOARD = `# THE OFFICE BOARD

### OB-001 — Audit every model call site

- **Assignee:** Agent 5 — The IT Chief
- **State:** READY
- **Metric:** 3 office-days from dispatch · delivered = one document listing every call site
- **Blocked by:** nothing
- **Task:** list every place the office calls a model, and which key answers.

### OB-003 — Permission-flow analysis: trace every write path end to end

- **Assignee:** Agent 5 — The IT Chief
- **State:** BLOCKED
- **Metric:** 4 office-days from dispatch · delivered = one flow document
- **Blocked by:** OB-001. Flow analysis before the call audit repeats the call audit inside it and produces two documents that can disagree.
- **Source:** meeting 2026-08-08 (standup)
- **Task:** trace every write path end to end, from the decision to the commit.
- **Notes:** *(2026-08-08, opened by the standup)* the earlier attempt
  stopped at permission-guard.js and never reached the call sites.

### OB-012 — Propose the action_items schema change

- **Assignee:** Agent 12 — The Workflow
- **State:** NOT-READY
- **Metric:** 2 office-days from dispatch · delivered = a proposal
- **Blocked by:** **an owner decision.** The standup did not settle this. Open question: whether the schema may change at all.
`;

const QUESTIONS = `# OPEN QUESTIONS

### Q-001 — Which repository may the office write code into?

- **Asked by:** Agent 11 — The CEO
- **Date:** 2026-08-10
- **Blocking:** OB-050
- **What I need:** one of the three repos named
- **If no answer comes:** the office keeps writing nowhere and reports the block weekly.
- **Answer:** —
`;

const SUBMISSIONS = `# SUBMISSIONS

The format, shown rather than described:

\`\`\`markdown
### S-000 — The example

- **What we did:** nothing, this is the format
- **What we recommend:** nothing
- **Decision needed:** nothing
- **If no answer comes:** nothing
\`\`\`

### S-001 — The office site, live data path

- **Date:** 2026-08-20
- **Submitted by:** Agent 9 — The Designer
- **What we did:** built the live data endpoint
- **What we recommend:** deploy it
- **Decision needed:** whether to deploy
- **If no answer comes:** the office deploys it after 14 days.
`;

const FILES = { board: BOARD, question: QUESTIONS, submission: SUBMISSIONS };

/* ═════════════════════════ §1 reading an id ══════════════════════════════ */

section('§1 the id is validated, and never becomes a path');

check('a board card id resolves', (() => {
  const r = parseItemRef('board-ob-003');
  return r.ok && r.kind === 'board' && r.itemId === 'OB-003' && r.source.path === ITEM_SOURCES.board.path;
})());
check('a question card id resolves', (() => {
  const r = parseItemRef('question-q-001');
  return r.ok && r.kind === 'question' && r.itemId === 'Q-001';
})());
check('a submission card id resolves', (() => {
  const r = parseItemRef('submission-s-001');
  return r.ok && r.kind === 'submission' && r.itemId === 'S-001';
})());

/*
 * THE CHECK THAT MATTERS. The id arrives from a query string. If it could ever
 * reach a file path, the endpoint would be a read-any-file-in-back-office
 * surface with an admin gate in front of it.
 */
const HOSTILE = [
  'board-../../etc/passwd', 'board-%2e%2e%2fBOARD.md', 'board-ob-003/../../x',
  'board-OB-3', 'board-', 'question-ob-003', 'submission-q-001',
  '../campus/shared/board/BOARD.md', '', null, undefined,
  'board-' + 'a'.repeat(200),
];
check('every hostile or malformed id is refused', HOSTILE.every((h) => parseItemRef(h).ok === false),
  HOSTILE.filter((h) => parseItemRef(h).ok).join(', '));
check('a refusal always says why', HOSTILE.every((h) => typeof parseItemRef(h).reason === 'string' && parseItemRef(h).reason.length > 10));

/*
 * And the structural half: the path is a CONSTANT per source, so there is no
 * expression anywhere in the module that builds a path out of an id.
 */
const MODULE = readFileSync(join(repo, 'workers', 'item-detail.js'), 'utf8');
const RUNNER_SRC = readFileSync(join(repo, 'workers', 'agent-runner.js'), 'utf8');
check('each source path is written exactly once, as a constant',
  Object.values(ITEM_SOURCES).every((s) => (MODULE.split(s.path).length - 1) === 1),
  'a second spelling of a source path is a second place a path can be built');
check('the module builds no path from anything',
  !/path:\s*[^,]*\$\{/.test(MODULE) && !/campus\/shared\/board\/BOARD\.md['"`]\s*\+/.test(MODULE),
  'a path assembled at runtime is a path an id can steer');
check('the module imports nothing', !/^import\s/m.test(MODULE));
check('the module contains no fetch and no provider client',
  !/\bfetch\s*\(/.test(MODULE) && !/api\.(?:anthropic|github)\.com|generativelanguage|groq\.com/.test(MODULE));

/* ═════════════════════ §2 the entry, verbatim ════════════════════════════ */

section('§2 the entry is sliced whole and altered in no way');

const e3 = extractEntry(BOARD, 'OB-003');
check('OB-003 is found', e3.found === true, e3.reason);
check('its heading is the task title', e3.heading === 'Permission-flow analysis: trace every write path end to end');
check('the slice starts at its own heading and stops at the next one',
  e3.verbatim.startsWith('### OB-003 —') && !e3.verbatim.includes('### OB-012') && !e3.verbatim.includes('### OB-001'));

/*
 * VERBATIM IS THE POINT. Every character of the slice must appear in the source
 * file exactly as it is — no re-wrapping, no normalising, no stripping of the
 * markdown emphasis `parseBoard()`'s `plain()` removes.
 */
check('the slice is a byte-for-byte substring of the file', BOARD.includes(e3.verbatim));
check('markdown emphasis inside a value survives', extractEntry(BOARD, 'OB-012').verbatim.includes('**an owner decision.**'));

const f3 = entryFields(e3.verbatim);
check('every field the office wrote is returned, not the eleven parseBoard knows',
  f3.map((f) => f.label).join(',') === 'Assignee,State,Metric,Blocked by,Source,Task,Notes',
  f3.map((f) => f.label).join(','));
check('a value that runs onto a second line keeps that line',
  /stopped at permission-guard\.js/.test(fieldValue(f3, 'Notes') || ''),
  'a multi-line Notes value was truncated at its first line');
check('fields come back in file order', f3[0].label === 'Assignee' && f3[1].label === 'State');

/*
 * THE FIELDS parseBoard() DROPS ARE THE WHOLE REASON THIS ENDPOINT EXISTS.
 * `Task:` and `Source:` are read by nothing in `office-context.js`; if they stop
 * arriving here, the expansion has quietly become the card again.
 */
check('the fields the card never had are present',
  !!fieldValue(f3, 'Task') && !!fieldValue(f3, 'Source') && !!fieldValue(f3, 'Metric'));

check('a missing entry is reported, never returned empty', (() => {
  const miss = extractEntry(BOARD, 'OB-999');
  return miss.found === false && /no heading beginning "OB-999"/.test(miss.reason);
})());

/*
 * THE DEFECT THE FIRST LIVE REQUEST FOUND, both halves, pinned.
 *
 * `BOARD.md` groups tasks under `## Agent N` sections and writes a decided task
 * with its heading struck through. Slicing on `###` alone swallowed a section
 * rule and the next agent's heading into OB-003's `Notes:`; looking only for
 * `### OB-001 — ` reported the live blocker as "never there" while it sat in
 * the same file, finished.
 */
const SECTIONED = `## Agent 5 — The IT Chief

### ~~OB-001 — Audit every model call site~~ — DONE

- **State:** DONE
- **Task:** list every place the office calls a model.
- **Notes:** —

---

## Agent 6 — The QA

### OB-020 — Something else

- **State:** READY
`;
check('a struck-through decided entry is found, not reported missing', (() => {
  const d = extractEntry(SECTIONED, 'OB-001');
  return d.found === true && d.match === 'decided' && /Audit every model call site/.test(d.heading);
})(), 'a finished blocker reported as "never there" is absence read as fact');
check('an open entry is still reported as open', extractEntry(BOARD, 'OB-003').match === 'open');

/*
 * THE IDENTIFIER, ONCE.
 *
 * The canonical branch captures only what follows the em-dash, so its heading
 * never carries the identifier. The decorated branch used to keep the whole
 * heading text, identifier included — and every caller that prints the
 * identifier beside the title (the console's blocker card does) rendered
 * `OB-001 — OB-001 — Audit every model call site — DONE`. Found on the
 * console, fixed at the source, pinned here so the two branches cannot drift
 * apart again.
 *
 * The trailing `— DONE` is NOT stripped: it is the office's own heading text,
 * and this fix assembles the heading differently, it does not edit the board.
 */
check('a decided entry\'s heading does not repeat its own identifier', (() => {
  const d = extractEntry(SECTIONED, 'OB-001');
  return d.match === 'decided' && !d.heading.includes('OB-001');
})(), 'a caller printing the id beside the title rendered it twice');
check('and it still carries the title the office wrote, decoration included', (() => {
  const d = extractEntry(SECTIONED, 'OB-001');
  return d.heading === 'Audit every model call site — DONE';
})());
check('the canonical branch is unchanged — no identifier, no leading dash', (() => {
  const o = extractEntry(BOARD, 'OB-003');
  return o.match === 'open' && !o.heading.includes('OB-003') && !/^[-—–\s]/.test(o.heading);
})());
check('a decided heading still slices the same bytes verbatim, identifier included', (() => {
  const d = extractEntry(SECTIONED, 'OB-001');
  return d.verbatim.startsWith('### ~~OB-001 — Audit every model call site~~ — DONE');
})(), 'the heading string is assembled; the record itself is never edited');
check('a decided entry whose heading is nothing but its identifier reports no title', (() => {
  const d = extractEntry('## Agent 5\n\n### ~~OB-001~~\n\n- **State:** DONE\n', 'OB-001');
  return d.found === true && d.match === 'decided' && d.heading === '';
})(), 'an empty title lets the card say "no title recorded" instead of echoing the id');
check('the slice stops at the next section heading, not the next task heading', (() => {
  const d = extractEntry(SECTIONED, 'OB-001');
  return !d.verbatim.includes('## Agent 6') && !d.verbatim.includes('OB-020');
})(), 'a section rule and the next agent\'s heading landed inside a Notes: value on the first live request');
check('a heading that merely MENTIONS an id is not mistaken for its entry',
  extractEntry('## Blocked on OB-001\n\ntext\n', 'OB-001').found === false,
  'the identifier must be the first thing in the heading text');
check('an unreadable file is reported as such', extractEntry('', 'OB-003').found === false);

/*
 * SUBMISSIONS.md documents its own format by showing one. `parseSubmissions()`
 * blanks fenced blocks for exactly this reason, and so must this — otherwise
 * the contract's illustration is served as a live entry.
 */
check('the format example inside a fenced block is not served as an entry',
  extractEntry(SUBMISSIONS, 'S-000').found === false);
check('the real submission next to it still is', extractEntry(SUBMISSIONS, 'S-001').found === true);

/* ═══════════════════ §3 the blocker, named and quoted ════════════════════ */

section('§3 the blocker is named by identifier and quoted in full');

const blk = resolveBlockers(fieldValue(f3, 'Blocked by'), FILES);
check('the blocker is resolved to an identifier', blk.resolved.length === 1 && blk.resolved[0].item_id === 'OB-001');
check('the blocker carries its own entry in full',
  blk.resolved[0].verbatim.startsWith('### OB-001 —') && /list every place the office calls a model/.test(blk.resolved[0].verbatim),
  'a named blocker with no content is the card\'s problem with an extra step');
check('the blocker carries its own state', blk.resolved[0].state === 'READY');
check('the office\'s own sentence is kept verbatim alongside it',
  /^OB-001\. Flow analysis before the call audit/.test(blk.stated));

/* A blocker line that names no item is a real shape and must not read as a
 * failed lookup. */
const noneNamed = resolveBlockers(fieldValue(entryFields(extractEntry(BOARD, 'OB-012').verbatim), 'Blocked by'), FILES);
check('a blocker naming no item says so rather than failing',
  noneNamed.names_no_item === true && noneNamed.resolved.length === 0 && noneNamed.unresolved.length === 0);

/* THE INVERTED CHECK: take the blocker out of the file and the expansion must
 * REPORT it, not quietly show one fewer box. */
const withoutOB001 = BOARD.replace(/### OB-001[\s\S]*?(?=### OB-003)/, '');
const orphan = resolveBlockers('OB-001. Flow analysis first.', { ...FILES, board: withoutOB001 });
check('a blocker that cannot be found is reported, not dropped',
  orphan.resolved.length === 0 && orphan.unresolved.length === 1 && /OB-001/.test(orphan.unresolved[0].reason));
check('a blocker in a file that was not read says which file it needed',
  resolveBlockers('Q-001 must be answered first', { board: BOARD }).unresolved[0].reason.includes(ITEM_SOURCES.question.path));

check('a cross-file blocker resolves when that file was read',
  resolveBlockers('Q-001 must be answered first', FILES).resolved[0].item_id === 'Q-001');

/*
 * THE SECOND LIVE FINDING. `OB-001` is not in `BOARD.md` in any heading form —
 * the board removes a finished task rather than striking it through. So a
 * blocker is looked for in the board's SIBLING files, whose names come from a
 * directory listing and never from a guess in this code.
 */
const ARCHIVE = `# FINISHED

### OB-001 — Audit every model call site

- **State:** DONE
- **Task:** list every place the office calls a model, and which key answers.
`;
const viaSibling = resolveBlockers('**OB-001.** Flow analysis first.',
  { ...FILES, board: withoutOB001 },
  [{ path: 'campus/shared/board/ARCHIVE.md', text: ARCHIVE }]);
check('a blocker filed beside the board is found there',
  viaSibling.resolved.length === 1 && viaSibling.resolved[0].item_id === 'OB-001'
  && viaSibling.resolved[0].file === 'campus/shared/board/ARCHIVE.md');
check('and the card is told it was found somewhere other than the board',
  viaSibling.resolved[0].elsewhere === true,
  '"finished and filed elsewhere" and "still on the board" are different answers');
check('a blocker in NO file says where it looked',
  (() => {
    const none = resolveBlockers('**OB-001.**', { ...FILES, board: withoutOB001 },
      [{ path: 'campus/shared/board/ARCHIVE.md', text: '# empty\n' }]);
    return none.unresolved.length === 1
      && /has no entry in campus\/shared\/board\/BOARD\.md, campus\/shared\/board\/ARCHIVE\.md/.test(none.unresolved[0].reason)
      && none.unresolved[0].looked_in.length === 2;
  })(),
  'named and not there is a fact about the office, and the sentence must say where it looked');
check('the sibling read is on the MISS PATH only', (() => {
  const i = RUNNER_SRC.indexOf("url.pathname === '/api/admin/item'");
  const body = RUNNER_SRC.slice(i, RUNNER_SRC.indexOf("url.pathname === '/api/admin'", i));
  return /if \(detail\.blocker\.unresolved\.length\)/.test(body) && /fetchBackOfficeDir\(env, dir\)/.test(body);
})(), 'an item whose blocker already resolved must pay nothing for this');
check('the sibling filename comes from a listing, never from a literal', (() => {
  const i = RUNNER_SRC.indexOf("url.pathname === '/api/admin/item'");
  const body = RUNNER_SRC.slice(i, RUNNER_SRC.indexOf("url.pathname === '/api/admin'", i));
  // No quoted `.md` filename anywhere in the handler. The comment above it
  // names `DONE.md` in backticks precisely to say why it is not written here,
  // and a backtick is not a string quote for this purpose.
  return !/['"][^'"]*\.md['"]/.test(body) && /e\.name/.test(body);
})(), 'an invented path that 404s looks exactly like an entry that is not there');
check('the sibling cap is reported when it bites', (() => {
  const i = RUNNER_SRC.indexOf("url.pathname === '/api/admin/item'");
  const body = RUNNER_SRC.slice(i, RUNNER_SRC.indexOf("url.pathname === '/api/admin'", i));
  return /only the first \$\{MAX_SIBLING_FILES\} were read/.test(body);
})());
check('identifiers are found wherever they sit in the sentence',
  referencedItemIds('blocked by OB-001 and also S-001, plus OB-001 again').join(',') === 'OB-001,S-001');
check('kindOfItemId maps each family to its own file',
  kindOfItemId('OB-003') === 'board' && kindOfItemId('Q-001') === 'question'
  && kindOfItemId('S-001') === 'submission' && kindOfItemId('REQ-001') === null);

/* ══════════════════ §4 the origin, from git, with its precision ══════════ */

section('§4 first appearance comes from git, and says how sure it is');

/** A fake history: 20 commits, newest first; the entry was added at index 12. */
function fakeHistory(addedAt, { entry = '### OB-003 — x' } = {}) {
  const commits = Array.from({ length: 20 }, (_, i) => ({
    sha: `sha${String(i).padStart(2, '0')}`,
    date: `2026-08-${String(20 - i).padStart(2, '0')}T10:00:00Z`,
    message: `commit ${i}`,
  }));
  let reads = 0;
  const probe = async (sha) => {
    reads += 1;
    const i = commits.findIndex((c) => c.sha === sha);
    return { ok: true, present: i <= addedAt };
  };
  return { commits, probe, reads: () => reads, entry };
}

const h = fakeHistory(12);
const found = await findFirstAppearance(h.commits, h.probe);
check('the search finds the exact commit that added the entry',
  found.ok && found.precision === 'exact' && found.commit.sha === 'sha12',
  JSON.stringify({ precision: found.precision, sha: found.commit?.sha }));
check('it does so in a logarithmic number of reads', found.probes <= 7, `used ${found.probes}`);

const always = fakeHistory(19);
const fromStart = await findFirstAppearance(always.commits, always.probe, { complete: true });
check('an entry present in the file\'s first commit is dated exactly, in one read',
  fromStart.ok && fromStart.precision === 'exact' && fromStart.probes === 1);

const capped = await findFirstAppearance(always.commits, always.probe, { complete: false });
check('the same answer on a CAPPED listing degrades to "at or before"',
  capped.ok && capped.precision === 'at-or-before' && /capped|on or before/.test(capped.reason),
  'a truncated history presented as an exact date is absence read as fact');

/* THE CAP IS REPORTED, NEVER SILENT. */
const tight = fakeHistory(12);
const budgeted = await findFirstAppearance(tight.commits, tight.probe, { max: 3 });
check('a search that runs out of budget returns a WINDOW and says so',
  budgeted.ok && budgeted.precision === 'window' && !!budgeted.window
  && /budget of 3 file reads ran out/.test(budgeted.reason),
  'a truncated search that returned its nearest bound would read like an answer');
check('the reported window really contains the answer', (() => {
  const older = budgeted.window.oldest.sha;
  const newer = budgeted.window.newest.sha;
  return newer <= 'sha12' && older >= 'sha12';
})());

const broken = await findFirstAppearance(
  h.commits,
  async () => ({ ok: false, reason: 'HTTP 404' }),
);
check('a failed read is reported and never becomes a date', broken.ok === false && /404/.test(broken.reason));
check('no commits at all is reported, not treated as "brand new"',
  (await findFirstAppearance([], async () => ({ ok: true, present: true }))).ok === false);
check('an entry absent at HEAD is refused rather than dated', (() => {
  const gone = fakeHistory(-1);
  return findFirstAppearance(gone.commits, gone.probe).then((r) => r.ok === false && /not in the file at HEAD/.test(r.reason));
})() instanceof Promise);
check('the probe budget constant is the one the caller uses', MAX_ORIGIN_PROBES === 9);

/* ══════════════ §5 the honest sentences are carried, not rewritten ═══════ */

section('§5 the card\'s honest labelling survives the expansion');

/*
 * THE SENTENCE IS COPIED FROM THE PAGE, NOT PARAPHRASED. If the page's wording
 * changes and this constant does not, the owner reads two different sentences
 * for one fact — which is the drift a shared constant exists to prevent.
 */
const PAGE = readFileSync(join(repo, 'workers', 'office-site-page.js'), 'utf8');
check('the "no stated default" sentence is the page\'s own words',
  PAGE.includes(NO_STATED_DEFAULT),
  'item-detail.js and the card now say different things about the same silence');

check('an item with no recorded default says so in those words',
  statedDefault(f3).stated === false && statedDefault(f3).words === NO_STATED_DEFAULT);
check('an item that HAS a default reports the office\'s own text', (() => {
  const sf = entryFields(extractEntry(SUBMISSIONS, 'S-001').verbatim);
  const d = statedDefault(sf);
  return d.stated === true && d.label === 'If no answer comes' && /deploys it after 14 days/.test(d.text);
})());

const CARD = {
  id: 'board-ob-003', item_id: 'OB-003', title: 'Permission-flow analysis: trace every write path end to end',
  detail: 'Blocked by: OB-001. Flow analysis before the call audit repeats the call audit inside it.',
  answer_stops_the_asking: false,
  answer_note: 'This is the office\'s own work, not a question in the channel — an answer here is filed as an'
    + ' instruction and reaches every agent\'s prompt, but the office does not record it as a decision against'
    + ' this board item and nothing here will mark the item answered.',
};

const detail = buildItemDetail({
  ref: parseItemRef('board-ob-003'),
  card: CARD,
  files: FILES,
  origin: found,
  lookups: [{ what: 'read the board', ok: true, reason: null, bytes: BOARD.length }],
});

check('the expansion carries the card\'s answer note unchanged', detail.answer_note === CARD.answer_note,
  'a second copy of this sentence is a second sentence that can drift');
check('it carries whether an answer stops the asking', detail.answer_stops_the_asking === false);
check('it names the repository and the file', detail.source.repo === ITEM_REPO && detail.source.file === ITEM_SOURCES.board.path);

/* ═════════════════ §6 the whole answer, and the acceptance ══════════════ */

section('§6 the acceptance: could he decide from what appears?');

check('the expansion returns the entry whole', /- \*\*Task:\*\*/.test(detail.entry.verbatim));
check('IT NAMES THE BLOCKING ITEM BY IDENTIFIER',
  detail.blocker.resolved.some((r) => r.item_id === 'OB-001'),
  'A6: a card that opens and shows two more sentences has not solved anything');
check('and includes enough of the blocker to be actionable',
  /list every place the office calls a model/.test(detail.blocker.resolved[0].verbatim));
check('it dates the entry from git', detail.origin.ok === true && detail.origin.precision === 'exact');
check('it reports every read it made', detail.lookups.length >= 1 && detail.lookups[0].ok === true);

/* A5: a source that cannot be located must say WHICH lookup failed, and must
 * never render as an empty panel. */
const blind = buildItemDetail({
  ref: parseItemRef('board-ob-003'),
  card: CARD,
  files: { board: null, question: null, submission: null },
  origin: null,
  lookups: [{ what: 'read campus/shared/board/BOARD.md', ok: false, reason: 'GET failed: HTTP 404' }],
});
check('an unreadable source is reported, not rendered empty',
  blind.ok === true && blind.source.found === false && /could not be read/.test(blind.source.reason)
  && blind.lookups.some((l) => l.ok === false && /404/.test(l.reason)));
check('it still resolves whatever the CARD already knew about the blocker',
  blind.blocker.stated !== null && /OB-001/.test(blind.blocker.stated),
  'showing less than it found is the second half of A5');
check('a missing origin lookup is stated rather than left null',
  blind.origin.ok === false && typeof blind.origin.reason === 'string');

/* ═════════════ §7 the route: registered, gated, and inside /admin ════════ */

section('§7 the route exists, is inside the Access path, and is gated');

const GATE = readFileSync(join(repo, 'workers', 'admin-gate.js'), 'utf8');
const RUNNER = readFileSync(join(repo, 'workers', 'agent-runner.js'), 'utf8');

check('the alias map carries an explicit entry for the item route',
  /\['item', '\/api\/admin\/item'\]/.test(GATE),
  'without a map entry the page\'s call leaves the Access path and arrives anonymous');
/* The rule the map exists to keep: a lookup, never a rewrite. Checked against
 * the FUNCTION BODY rather than the file, because the file's own comment quotes
 * the forbidden shape in order to explain why it is forbidden. */
const canonicalBody = GATE.slice(GATE.indexOf('export function canonicalAdminApiPath'));
check('the alias is still a lookup and not a concatenation',
  /ADMIN_API_ROUTES\.get\(/.test(canonicalBody)
  && !/return\s+[^;]*\+\s*p\.slice/.test(canonicalBody)
  && !/'\/api\/'\s*\+/.test(canonicalBody.slice(0, canonicalBody.indexOf('}'))));

/*
 * THE ITEM ID RIDES IN THE QUERY STRING. That is what makes the exact-map rule
 * and a per-item route compatible: `canonicalAdminApiPath()` rewrites the
 * pathname only, so nothing attacker-shaped can influence which path is served.
 */
check('the page calls the endpoint inside /admin, with the id in the query',
  /\/admin\/api\/item\?id=" \+ encodeURIComponent/.test(PAGE),
  'a call to /api/... leaves the Access application\'s path scope and arrives with no assertion');
check('the page does not call the canonical path directly', !PAGE.includes('"/api/admin/item"'));

check('the handler is under /api/admin, so the shared prefix gate covers it',
  /url\.pathname === '\/api\/admin\/item'/.test(RUNNER)
  && /const AUTHENTICATED_PREFIXES\s*=\s*\['\/api\/agents\/', '\/api\/admin'\]/.test(RUNNER));

check('the handler contains no authentication check of its own', (() => {
  const i = RUNNER.indexOf("url.pathname === '/api/admin/item'");
  if (i < 0) return false;
  const body = RUNNER.slice(i, RUNNER.indexOf("url.pathname === '/api/admin'", i));
  return !/ADMIN_TOKEN|adminCredential|adminCookieValue/.test(body);
})(), 'a handler-local check is the one a refactor moves');

/* STOP 3: the detail endpoint returns ONE item. If it ever answers by handing
 * the board to the browser, this check is what says so. */
check('the handler slices in the Worker and never returns a whole file', (() => {
  const i = RUNNER.indexOf("url.pathname === '/api/admin/item'");
  const body = RUNNER.slice(i, RUNNER.indexOf("url.pathname === '/api/admin'", i));
  return /buildItemDetail\(/.test(body) && !/json\(\s*\{\s*board:/.test(body) && !/files\s*\}\s*,\s*200/.test(body);
})());

check('the expansion fetches when a card is opened, not on page load',
  /if \(loaded\)/.test(PAGE) && /btn\.addEventListener\("click"/.test(PAGE)
  && !/pending_items.*forEach.*\/admin\/api\/item/.test(PAGE));

/* ════════════════════════════════ Result ════════════════════════════════ */

console.log(`\nitem-detail: ${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  one item comes back whole, its blocker is named by id, and every read it could not make is reported.\n');
process.exit(0);
