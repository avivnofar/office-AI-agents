#!/usr/bin/env node
/**
 * scripts/verify-spec-builder.js — is it really deterministic, and is a model
 * really absent?
 *
 * Written 2026-08-24 (Session 16, Item C). Run: node scripts/verify-spec-builder.js
 *
 * The requirement Item C states is unusual in that its central property is a
 * NEGATIVE — *no model is involved* — and a negative cannot be demonstrated by
 * exercising the happy path. So this file checks it two ways that are hard to
 * satisfy accidentally:
 *
 *   1. BYTE EQUALITY across repeated builds and across argument orderings. A
 *      model in the path would not survive this; neither would a timestamp,
 *      a random id, or a `new Date()` hiding in the template.
 *   2. A SOURCE SCAN of the module for `fetch(`, provider client imports, and
 *      clock calls. A generator that is deterministic today and calls a model
 *      tomorrow would pass (1) on the day the call is added and fail this.
 *
 * And, per §7 of ARCHITECTURAL-DECISIONS, it checks the wiring: the route
 * exists, points at the real builder, and — the one that would actually bite —
 * the send path posts to the AUTHENTICATED owner-message endpoint rather than
 * writing to the repo through some new door of its own.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  OPEN_DECISIONS_INSTRUCTION, TASK_TYPES, SPEC_FIELDS, CONDITIONAL_QUESTIONS,
  buildSpec, specFilename, renderSpecPage, prefillFromItem, PREFILL_LOCATION_LABELS,
  hasSpecimen, SPECIMEN_TASK_TYPES,
} from '../workers/spec-builder.js';
import { PAGE_KINDS } from '../workers/owner-page.js';
import { parseOwnerMessage } from '../workers/owner-channel.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/* A complete, realistic set of answers. Reused throughout. */
const ANSWERS = {
  title: 'Invoice due-date checker',
  task_type: 'tool',
  date: '2026-08-24',
  what: 'A command-line tool that reads a CSV of invoices and reports which rows have no usable due date.',
  out_of_scope: 'No web interface. No database. No scheduling.',
  where: 'warehouse-office-AI-agents/tasks/invoice-checker/',
  io: 'In: a path to a .csv with columns id,vendor,amount,due_date.\nOut: a markdown table of the offending rows, on stdout.',
  constraints: 'Standard library only. No keys. Must run on Windows.',
  done: 'Running it against samples/invoices.csv prints exactly the three bad rows and exits 0.',
  open_decisions: 'Whether a malformed row fails the run or is skipped with a warning.',
  invoked: 'node check-invoices.js path/to/file.csv',
};

/* ═══════════════════ 1. THE SEVEN FIELDS ARE ALL THERE ═══════════════════ */

check('there are exactly seven fields', SPEC_FIELDS.length === 7, `got ${SPEC_FIELDS.length}`);
check('six of the seven are required; open decisions is the one that is not',
  SPEC_FIELDS.filter((f) => f.required).length === 6
  && SPEC_FIELDS.find((f) => f.key === 'open_decisions')?.required === false);

const built = buildSpec(ANSWERS);
check('a complete form builds', built.ok, built.reason || '');

for (const f of SPEC_FIELDS) {
  check(`the spec renders a "${f.heading}" heading`, built.markdown.includes(`## ${f.heading}`));
}

check('the title becomes the H1', built.markdown.startsWith('# Invoice due-date checker\n'));
check('every answer reaches the output',
  ['what', 'out_of_scope', 'where', 'io', 'constraints', 'done', 'open_decisions']
    .every((k) => built.markdown.includes(ANSWERS[k].split('\n')[0])));

/* ═════════ 2. THE FIXED INSTRUCTION — the field that made it work ════════ */

check('the open-decisions instruction is rendered VERBATIM',
  built.markdown.includes(OPEN_DECISIONS_INSTRUCTION));
check('the instruction is the exact sentence, not a paraphrase',
  OPEN_DECISIONS_INSTRUCTION === 'decide it, implement it, record the decision and the reasoning. Do not ask.');

/**
 * THE CASE THAT MATTERS: nothing in Open decisions.
 *
 * An empty section and an absent one are different facts. "There were none"
 * should be readable; a missing heading reads as "nobody thought about it",
 * and the office would then be right to come back with a question — which is
 * the exact outcome this field exists to prevent.
 */
const noDecisions = buildSpec({ ...ANSWERS, open_decisions: '' });
check('a spec with NO open decisions still builds', noDecisions.ok, noDecisions.reason || '');
check('...and still renders the instruction', noDecisions.markdown.includes(OPEN_DECISIONS_INSTRUCTION));
check('...and says explicitly that none were stated',
  /None stated/.test(noDecisions.markdown));

/* ═════════════ 3. DETERMINISM — the same answers, the same bytes ═════════ */

const a = buildSpec(ANSWERS).markdown;
const b = buildSpec(ANSWERS).markdown;
const c = buildSpec(JSON.parse(JSON.stringify(ANSWERS))).markdown;
check('two builds of the same answers are byte-identical', a === b);
check('a build from a deep copy is byte-identical too', a === c);

/* Key ORDER must not matter — an object literal typed in a different order is
 * the same answers, and a template that iterated the input rather than the
 * field list would quietly disagree. */
const reordered = {};
for (const k of Object.keys(ANSWERS).reverse()) reordered[k] = ANSWERS[k];
check('argument key order does not change a single byte', buildSpec(reordered).markdown === a);

/* Whitespace normalisation: the same answers typed on Windows and on a phone. */
const crlf = { ...ANSWERS, io: ANSWERS.io.replace(/\n/g, '\r\n'), what: `  ${ANSWERS.what}   ` };
check('CRLF and stray outer whitespace normalise to the same bytes', buildSpec(crlf).markdown === a);

/* Ten builds, one hash. If anything in here read a clock this fails. */
const many = new Set();
for (let i = 0; i < 10; i += 1) many.add(buildSpec(ANSWERS).markdown);
check('ten consecutive builds produce ONE distinct output', many.size === 1, `got ${many.size}`);

/* ═════════════ 4. NO MODEL, AND THE SOURCE SAYS SO ══════════════════════ */

const src = readFileSync(join(repo, 'workers', 'spec-builder.js'), 'utf8');
/* Strip block and line comments — the header talks ABOUT models at length and
 * a scan that could not tell prose from code would be useless. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/*
 * SCOPED TO THE GENERATOR, and the scoping is the honest version rather than a
 * loosening. `renderSpecPage()` emits a browser <script> that DOES call
 * fetch() — twice, deliberately: once to build the spec server-side so there
 * is one implementation of the format, and once to send it through the
 * authenticated owner-message endpoint. Both are the browser's calls, in the
 * owner's own tab, with his own token.
 *
 * What must contain no network call is the part that turns answers into a
 * spec. A whole-file scan that failed on the page's fetch would have to be
 * deleted to make the suite pass, and a deleted check protects nothing — so
 * the boundary is drawn where the requirement actually is.
 */
const generatorSrc = code.slice(0, code.indexOf('export function renderSpecPage'));
check('the GENERATOR makes no network call', !/\bfetch\s*\(/.test(generatorSrc));
check('...and the only fetches in the whole module are the page\'s three, to this Worker\'s own endpoints',
  (code.match(/\bfetch\s*\(/g) || []).length === 3
  /* The first two moved under `/admin/` on 2026-08-25 (Session 21): the Access
     application binds that PATH, and a call from outside it reaches the Worker
     with no assertion on it — which is why a signed-in owner was still being
     asked for a token. Same handlers, same Worker, reached by a rewrite. */
  && /fetch\(BASE \+ '\/admin\/api\/spec\/build'/.test(code)
  && /fetch\(BASE \+ '\/admin\/api\/agents\/owner-message'/.test(code)
  /* The THIRD, added 2026-08-25 (Session 22, Item B), and it is justified here
     rather than absorbed. `#item=<card id>` in the fragment means this page was
     opened from a pending card, and it asks the office for that item so the
     form can be filled from what the item actually says. Same Worker, same
     `/admin` prefix, same credential; nothing is derived in the browser — the
     server returns `spec_prefill`, computed by this module's own
     `prefillFromItem()`. */
  && /fetch\(BASE \+ '\/admin\/api\/item\?id='/.test(code),
  'a fourth fetch appearing here is a new outbound call and must be justified, not absorbed');

/*
 * AND THE GENERATOR STILL DOES NOT DERIVE ANYTHING FROM A MODEL.
 * `prefillFromItem()` is above `renderSpecPage()`, so the "generator makes no
 * network call" check already covers it — this asserts the other half: every
 * value it produces is the item's own text, never a composition.
 */
check('prefillFromItem is inside the network-free generator half',
  generatorSrc.includes('export function prefillFromItem'),
  'the derivation must sit under the same no-fetch, no-model rule as buildSpec()');
check('the module imports nothing at all',
  !/^\s*import\s/m.test(code), 'the pure-module rule — plain node must be able to load it');
check('no provider client is referenced',
  !/gemini|groq|cerebras|mistral|cohere|anthropic|openai|callModel|askModel/i.test(code));
check('no clock call in the generator',
  !/new Date\(|Date\.now\(/.test(code.slice(0, code.indexOf('export function renderSpecPage'))),
  'the page\'s own script may read a clock for the default date; the GENERATOR may not, or determinism is unprovable');
check('no randomness', !/Math\.random|crypto\.randomUUID/.test(code));

/* ═════════════ 5. REFUSALS NAME THE FIELD ═══════════════════════════════ */

for (const f of SPEC_FIELDS.filter((x) => x.required)) {
  const r = buildSpec({ ...ANSWERS, [f.key]: '' });
  check(`a missing "${f.heading}" is refused BY NAME`,
    r.ok === false && r.reason.includes(f.heading), r.reason || 'it built anyway');
}
check('a missing title is refused', buildSpec({ ...ANSWERS, title: '' }).ok === false);
check('a multi-line title is refused', buildSpec({ ...ANSWERS, title: 'a\nb' }).ok === false);
check('an unknown task type is refused rather than defaulted',
  buildSpec({ ...ANSWERS, task_type: 'invention' }).ok === false);
check('a bad date is refused', buildSpec({ ...ANSWERS, date: '24-08-2026' }).ok === false);

/* ═════════════ 6. THE CONDITIONAL QUESTIONS ═════════════════════════════ */

check('there are four task types', TASK_TYPES.length === 4);
check('every task type has at least one conditional question',
  TASK_TYPES.every((t) => (CONDITIONAL_QUESTIONS[t] || []).length >= 1));
check('a FIX asks for the symptom AND how you would know it stopped',
  CONDITIONAL_QUESTIONS.fix.some((q) => q.key === 'symptom')
  && CONDITIONAL_QUESTIONS.fix.some((q) => q.key === 'how_known'));
check('an INTERFACE asks who the user is AND what they see first',
  CONDITIONAL_QUESTIONS.interface.some((q) => q.key === 'user')
  && CONDITIONAL_QUESTIONS.interface.some((q) => q.key === 'first_screen'));

check('an answered conditional question reaches the spec',
  built.markdown.includes('node check-invoices.js path/to/file.csv'));
check('the conditional section is labelled with the task type',
  built.markdown.includes('## Additional context (tool)'));
check('a spec with NO conditional answers omits the section entirely rather than leaving an empty heading',
  !buildSpec({ ...ANSWERS, invoked: '' }).markdown.includes('## Additional context'));
check('the conditional answers are NOT required',
  buildSpec({ ...ANSWERS, invoked: '' }).ok === true);

const fixSpec = buildSpec({
  ...ANSWERS, task_type: 'fix', symptom: 'The email body is empty twice a week.',
  how_known: 'Fourteen consecutive non-empty emails.',
});
check('a FIX spec carries its two answers', fixSpec.ok
  && fixSpec.markdown.includes('The email body is empty twice a week.')
  && fixSpec.markdown.includes('Fourteen consecutive non-empty emails.'));
check('a FIX spec does NOT carry the tool question', !fixSpec.markdown.includes('How it is invoked'));

/* ═════════════ 7. THE SEND PATH — the office's own parser accepts it ═════ */

/**
 * THE ACCEPTANCE TEST, run against THE REAL PARSER rather than a schema that
 * resembles it. `buildOwnerMessage()` wraps `channelBody` in the front matter;
 * this reproduces that wrapping exactly and hands the bytes to
 * `parseOwnerMessage()` — the same function that reads the folder.
 *
 * If this ever fails, the SPEC BUILDER is wrong. The parser is not relaxed to
 * accept it, which is owner-page.js's rule and it is not softened here.
 */
check('channelBody drops the H1 the wrapper will add',
  built.channelBody.startsWith('**Assigned by:**'),
  'posting the full markdown would produce a file with two H1s and the office would read the wrapper\'s');
check('channelBody keeps everything else', built.channelBody.includes(OPEN_DECISIONS_INSTRUCTION));

const candidate = `---
from: owner
date: 2026-08-24
kind: instruction
re: new
status: open
---

# ${built.title}

${built.channelBody}
`;
const parsed = parseOwnerMessage(candidate, '2026-08-24-invoice-due-date-checker.md', null);
check('THE OFFICE\'S OWN PARSER ACCEPTS A SPEC-BUILDER MESSAGE', parsed.ok, parsed.reason || '');
check('...and reads the spec\'s title, not a guess from the filename',
  parsed.ok && parsed.message.title === built.title);
check('...and reads the kind as stated rather than defaulted',
  parsed.ok && parsed.message.kind === 'instruction' && parsed.message.kindDefaulted === false);

check('the kind the page sends is one the page-level vocabulary offers',
  PAGE_KINDS.includes('instruction'));

check('specFilename matches the channel\'s slug rules',
  specFilename({ title: 'Invoice due-date checker', date: '2026-08-24' }) === '2026-08-24-invoice-due-date-checker.md');
check('specFilename refuses a title with nothing sluggable in it',
  specFilename({ title: '!!!', date: '2026-08-24' }) === null);

/* ═════════════ 8. THE PAGE, AND ITS WIRING ══════════════════════════════ */

const html = renderSpecPage({ endpointBase: 'https://office.example.com' });
check('the page holds no secret', !/ADMIN_TOKEN|api[_-]?key|Bearer /i.test(html));
check('the page loads nothing from anywhere',
  (html.match(/https?:\/\/[^"'\s)]+/g) || []).every((u) => u.startsWith('https://office.example.com')),
  'an external asset is a page that stops working when that host does');
/*
 * Compared against the ESCAPED heading, because the page escapes everything it
 * interpolates. `What "done" looks like` contains quotes and reaches the HTML
 * as `What &quot;done&quot; looks like`. Asserting on the raw string would have
 * been a check that could only pass if the page stopped escaping — the wrong
 * way round.
 */
const escapeForHtml = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
check('the page renders all seven field headings',
  SPEC_FIELDS.every((f) => html.includes(escapeForHtml(f.heading))),
  SPEC_FIELDS.filter((f) => !html.includes(escapeForHtml(f.heading))).map((f) => f.heading).join(', '));
check('the page ESCAPES what it interpolates — the quoted heading arrives encoded',
  html.includes('What &quot;done&quot; looks like') && !html.includes('What "done" looks like'));
check('the page offers all four task types',
  TASK_TYPES.every((t) => html.includes(`<option value="${t}"`)));
check('the page has a download control', /id="dl"/.test(html));
check('the page shows the raw text for copying', /id="out"/.test(html) && /id="copy"/.test(html));
check('the page sends the admin token in a HEADER, never a query string',
  /headers\['X-Admin-Token'\] = t/.test(html) && !/[?&]token=/.test(html));
/*
 * ADDED 2026-08-25 (Session 21). Send used to refuse on an empty token box —
 * the page stopping a signed-in owner before the office ever saw the request.
 * The token is now sent when there is one, and the SERVER decides otherwise.
 */
check('Send carries no client-side lock — an absent token is the server call',
  /if \(t\) headers\['X-Admin-Token'\] = t/.test(html)
  && !/the admin token is required to write to the repo/.test(html));
check('a page rendered for a signed-in owner contains no token field at all',
  !/id="tok"/.test(renderSpecPage({ endpointBase: '', signedInViaAccess: true })));
check('...and a page rendered WITHOUT one still does — nothing is removed',
  /id="tok"/.test(renderSpecPage({ endpointBase: '', signedInViaAccess: false })));
check('the page keeps the token in sessionStorage only',
  /sessionStorage/.test(html) && !/localStorage/.test(html));
check('the page states plainly that landing a file does not start a build',
  /It does not start a build/.test(html));

const runner = readFileSync(join(repo, 'workers', 'agent-runner.js'), 'utf8');
check('agent-runner imports the real builder', /from '\.\/spec-builder\.js'/.test(runner));
check('the /admin/spec route exists', /url\.pathname === '\/admin\/spec'/.test(runner));
check('the /api/spec/build route exists', /url\.pathname === '\/api\/spec\/build'/.test(runner));

/**
 * The wiring check that would actually bite: the SEND path must go through the
 * authenticated owner-message endpoint. A page that grew its own write route
 * would be a second, unauthenticated door into the owner's instruction folder.
 */
check('the page SENDS through the authenticated /api/agents/owner-message endpoint',
  /\/api\/agents\/owner-message/.test(html));
check('the page has no other write path',
  !/commitFileToRepo|api\.github\.com|\/api\/spec\/send|\/api\/admin/.test(html),
  'the spec builder must not acquire a write door of its own');
check('the build endpoint writes nothing',
  (() => {
    const i = runner.indexOf("url.pathname === '/api/spec/build'");
    if (i < 0) return false;
    const body = runner.slice(i, i + 1600);
    return !/commitFileToRepo|env\.DB|SIM_KV|fetchOfficeSnapshot/.test(body);
  })(),
  'it is a text transform; it must touch no store');

/* ═══ 9. CARRYING A PENDING ITEM IN (2026-08-25, Session 22, Item B) ═════ */

/**
 * The failure this replaces: the card offered "Write a full spec instead", the
 * builder opened EMPTY, and the owner retyped what the card had just told him.
 *
 * The check that matters is not "some fields are filled". It is that the fields
 * nothing may honestly derive stay BLANK — above all `out_of_scope`, which the
 * module header names as the field that stopped a build from adding an
 * interface when an engine was asked for. A guessed boundary gets built.
 */

/** One item, in the shape `/api/admin/item` actually returns. */
const DETAIL = {
  ok: true,
  id: 'board-ob-003',
  item_id: 'OB-003',
  kind: 'board',
  title: 'Permission-flow analysis: trace every write path end to end',
  source: { repo: 'back-office-AI-agents', file: 'campus/shared/board/BOARD.md', found: true, reason: null },
  entry: {
    verbatim: '### OB-003 — Permission-flow analysis…',
    match: 'open',
    fields: [
      { label: 'Assignee', value: 'Agent 13 — The Cyber Expert' },
      { label: 'State', value: 'BLOCKED' },
      { label: 'Metric', value: '4 office-days · delivered = campus/agents/13-the-cyber-expert/findings/permission-flow.md' },
      { label: 'Blocked by', value: '**OB-001.** Flow analysis before the call audit repeats the call audit inside it.' },
      { label: 'Task', value: 'For each of the three write destinations, trace from the calling function to the credential.' },
    ],
    field_count: 5,
  },
  blocker: {
    stated: '**OB-001.** Flow analysis before the call audit repeats the call audit inside it.',
    names_no_item: false,
    resolved: [{
      item_id: 'OB-001', kind: 'board', file: 'campus/shared/board/BOARD-ARCHIVE.md',
      title: 'Determine, for every gate, whether it is on the calling path',
      state: 'DONE', match: 'open', elsewhere: true, verbatim: '### OB-001 …', fields: [],
    }],
    unresolved: [],
  },
  default: { stated: false, label: null, text: null, words: 'there is no stated default here.' },
  answer_note: 'the office does not record it as a decision against this board item and nothing here will mark the item answered.',
};

const pre = prefillFromItem(DETAIL);

check('the title is carried from the item', pre.values.title === DETAIL.title);
check('"what to build" is the item\'s own description text',
  pre.values.what === 'For each of the three write destinations, trace from the calling function to the credential.',
  'it must be the Task: field verbatim, not a composition');
check('every filled value is text the office actually wrote',
  Object.entries(pre.values).every(([k, v]) => k === 'open_decisions'
    || DETAIL.title === v || JSON.stringify(DETAIL.entry.fields).includes(v)),
  'a value that is not in the item is a value somebody invented');

/* THE INVERTED CHECK, and it is the one that would bite. */
const BLANK_KEYS = pre.blank.map((b) => b.key);
check('OUT OF SCOPE IS LEFT BLANK',
  pre.values.out_of_scope === undefined && BLANK_KEYS.includes('out_of_scope'),
  'a guessed scope boundary is worse than an empty one — the empty one stops the form and asks him');
check('input/output, constraints and done are left blank too',
  ['io', 'constraints', 'done'].every((k) => pre.values[k] === undefined && BLANK_KEYS.includes(k)));
check('every blank field says WHY it is blank',
  pre.blank.every((b) => typeof b.why === 'string' && b.why.length > 20),
  'a blank required box with no explanation reads like the form failed to load');

/*
 * `where` is the near miss. A board task's Metric line contains a real repo
 * path and lifting it would be right often enough to be dangerous — it is where
 * the DELIVERABLE lands, not where the work lives.
 */
check('WHERE IT LIVES is not lifted out of the Metric sentence',
  pre.values.where === undefined && BLANK_KEYS.includes('where'),
  'that path is where the deliverable lands, which is a different claim');
check('...and it says so rather than going silently empty',
  /deliverable lands, not where the work lives/.test(pre.blank.find((b) => b.key === 'where').why));
check('where IS filled when the item states a location outright', (() => {
  const stated = JSON.parse(JSON.stringify(DETAIL));
  stated.entry.fields.push({ label: 'Where', value: 'warehouse-office-AI-agents/tasks/permission-flow/' });
  return prefillFromItem(stated).values.where === 'warehouse-office-AI-agents/tasks/permission-flow/';
})(), 'stated is not guessed — a labelled location field is the item saying it');
check('the location labels are declared, not scattered', PREFILL_LOCATION_LABELS.includes('Where'));

check('open decisions carry the blocker', /OB-001/.test(pre.values.open_decisions));
check('...including that the blocker is DONE and filed off the board',
  /State: DONE/.test(pre.values.open_decisions) && /BOARD-ARCHIVE\.md/.test(pre.values.open_decisions),
  'this is the sentence that tells him the block is stale');
check('an item with no blocker leaves open decisions blank rather than filling it with nothing', (() => {
  const bare = JSON.parse(JSON.stringify(DETAIL));
  bare.blocker = { stated: null, names_no_item: false, resolved: [], unresolved: [] };
  bare.entry.fields = bare.entry.fields.filter((f) => f.label !== 'Blocked by');
  const p3 = prefillFromItem(bare);
  return p3.values.open_decisions === undefined && p3.blank.some((b) => b.key === 'open_decisions');
})());

check('the honest note is carried, not re-composed', pre.answer_note === DETAIL.answer_note);
check('an item with no description leaves "what to build" blank', (() => {
  const noTask = JSON.parse(JSON.stringify(DETAIL));
  noTask.entry.fields = noTask.entry.fields.filter((f) => f.label !== 'Task');
  const p4 = prefillFromItem(noTask);
  return p4.values.what === undefined && p4.blank.some((b) => b.key === 'what');
})());

/* B5 — the produced spec references the item id, in a shape the office reads. */
const withItem = buildSpec({ ...ANSWERS, item_id: 'OB-003' });
check('the spec names the item it was written from',
  withItem.ok && /\*\*In answer to:\*\* OB-003/.test(withItem.markdown));
check('...in the HEADER, so the filename slug cannot truncate it away',
  withItem.markdown.indexOf('In answer to') < withItem.markdown.indexOf('## What to build'));
check('...and it survives into what is actually SENT',
  withItem.channelBody.includes('**In answer to:** OB-003'));
check('a spec built without an item carries no empty In-answer-to line',
  !buildSpec(ANSWERS).markdown.includes('In answer to'),
  'a line naming nothing is worse than no line');

const carried = `---
from: owner
date: 2026-08-25
kind: instruction
re: new
status: open
---

# ${withItem.title}

${withItem.channelBody}
`;
const carriedParsed = parseOwnerMessage(carried, '2026-08-25-invoice-due-date-checker.md', null);
check('THE OFFICE\'S OWN PARSER ACCEPTS A SPEC CARRYING AN ITEM ID',
  carriedParsed.ok, carriedParsed.reason || '');
check('...and the item id is in the body the office reads',
  carriedParsed.ok && /OB-003/.test(carriedParsed.message.body));

/* B4 / B2 — the page wiring, checked at the call site rather than described. */
const SITE = readFileSync(join(repo, 'workers', 'office-site-page.js'), 'utf8');
check('the card passes the item IDENTITY, not its text',
  /\/admin\/spec#item=" \+ encodeURIComponent\(item\.id\)/.test(SITE),
  'the builder would otherwise have to re-derive what the card already knew');
check('the page reads that fragment and asks the office for the item',
  /\^#item=\(\.\+\)\$/.test(html) && /admin\/api\/item\?id=/.test(html),
  'the previous version put the title in the fragment and the page read no fragment at all');
check('NOTHING IS LOCKED: no disabled or readonly is applied to a pre-filled box',
  !/box\.disabled|box\.readOnly|setAttribute\('readonly', *'readonly'\)/
    .test(html.slice(html.indexOf('function applyPrefill'), html.indexOf('function carryItem'))),
  'B4 — every pre-filled field stays editable');
check('a pre-filled box says where its text came from, and stops saying it once edited',
  /Filled from/.test(html) && /You changed this/.test(html));
check('a failed carry is SAID rather than silently opening an empty form',
  /Could not carry/.test(html) && /everything in it is yours to type/.test(html),
  'a silent empty form is indistinguishable from the behaviour this replaces');
check('the honest note still renders on the builder', /pre\.answer_note/.test(html));


/* ══════════ N. THE SPECIMEN RULE — the refusal that does not need reading ══
 *
 * Added 2026-08-26 (Session 25). Every case below is marked [FAILS-OLD] or
 * [PASSES-OLD] against the code as it stood before the rule existed, because a
 * table where nothing fails against the old path is documentation of a change
 * rather than a test of one — the standard this estate already applies in
 * scripts/verify-permissions.js.
 *
 * Before the rule, `buildSpec()` validated `io` for EMPTINESS ONLY. So every
 * non-empty prose case below built successfully and is [FAILS-OLD]; every
 * accept case built successfully then too and is [PASSES-OLD], which is the
 * point of including them — they prove the rule did not become a blanket
 * refusal.
 *
 * The four REFUSE strings are the real `io` answers from campaign runs 2, 3, 4
 * and R3, and the four ACCEPT strings from runs 1, 5, 6 and R1. They are not
 * invented for this table.
 */

/* --- the predicate, directly ------------------------------------------- */

/* ACCEPT — all [PASSES-OLD]: they built before the rule and must still build. */
for (const [label, value] of [
  ['a backticked span', 'Out: a row like `4471,Acme,1200.00`'],
  ['a path', 'In: lines on /dev/ttyUSB0 at 9600 baud'],
  ['a dot-extension', 'the folder of photos with names like DSC_0431.JPG'],
  ['a bare number', '9600 baud, one reading every 2 seconds'],
  ['Hebrew prose carrying a Latin specimen', 'קלט: קובץ quotas.json עם מיפוי {"groq": 14400}'],
]) check(`specimen accepted — ${label}`, hasSpecimen(value) === true, JSON.stringify(value));

/* REFUSE — all [FAILS-OLD]: every one of these built a spec before the rule. */
for (const [label, value] of [
  ['English prose, no example', 'In: our customer data I guess? Out: a list of accounts, worst first.'],
  ['terse English prose', 'in: discord messages. out: message gone, user banned'],
  ['Hebrew prose, no example', 'קלט: תיקייה עם קבצי חשבוניות. פלט: טבלה עם מספר חשבונית, ספק, תאריך.'],
  ['column names without a shape', 'a table with columns id, vendor, amount, and one row per invoice'],
]) check(`specimen refused — ${label}`, hasSpecimen(value) === false, JSON.stringify(value));

/* Language neutrality is a property of the mechanism, not a happy accident:
 * the predicate reads character classes and never words, so the SAME sentence
 * with and without a specimen must flip regardless of script. */
check('the rule is decided by the specimen, not by the language [FAILS-OLD]',
  hasSpecimen('פלט: טבלה עם עמודות ספק, קריאות, טוקנים') === false
  && hasSpecimen('פלט: שורה כמו | groq | 312 | 84210 |') === true,
  'two Hebrew sentences differing only in whether an example is present');

/* --- the refusal, through buildSpec() ---------------------------------- */

const proseIo = { ...ANSWERS, io: 'In: the customer records. Out: a list of who is at risk, worst first.' };
const refusedIo = buildSpec(proseIo);
check('buildSpec refuses an io with no specimen [FAILS-OLD]', refusedIo.ok === false, JSON.stringify(refusedIo).slice(0, 120));
check('...and names the field rather than saying "invalid" [FAILS-OLD]',
  refusedIo.ok === false && refusedIo.reason.includes('"Input and output"'));
check('...and SHOWS an example instead of only asking for one [FAILS-OLD]',
  refusedIo.ok === false && /4471,Acme Ltd,1200\.00/.test(refusedIo.reason),
  'the reader this exists for is the one who did not read the hint');
/* Permission to proceed WITHOUT real data, so that having none is not a dead
 * end — but stated as "write the closest thing you can", never as an
 * instruction to announce that it is invented. See the guard below. */
check('...and permits an example the person does not yet have, so nobody with no data is stuck [FAILS-OLD]',
  refusedIo.ok === false && /nothing to paste yet/.test(refusedIo.reason)
  && /closest thing/.test(refusedIo.reason), refusedIo.reason || '');
/*
 * IT MUST NOT TELL ANYONE TO CAVEAT THE EXAMPLE. Tried twice, measured twice,
 * worse both times and in different sections:
 *   v1 "say that you invented it"  -> three requesters complied, all three
 *      failed criterion 4; an ablation deleting only the disclaimer flipped it.
 *   v2 "say it needs confirming under Open decisions" -> moved the caveat into
 *      the one section that was working. "Needs confirming" is a REQUEST, both
 *      requesters wrote it as one, and criterion 7 began failing.
 * This check is a regression guard, not a description. Re-adding either phrasing
 * is a change that has already been measured as harmful twice.
 */
check('the refusal does NOT instruct the person to caveat their own example',
  refusedIo.ok === false
  && !/say that you invented|needs confirming|Open decisions/i.test(refusedIo.reason),
  refusedIo.reason || '');

/* EMPTINESS STILL WINS. A blank io must be told it is blank, not told it has no
 * example — the more specific message is the wrong one here. */
const emptyIo = buildSpec({ ...ANSWERS, io: '   ' });
check('an empty io is still refused as EMPTY, not as specimen-less [PASSES-OLD]',
  emptyIo.ok === false && /is empty, and it is required/.test(emptyIo.reason),
  emptyIo.reason || '');

/* THE COST SIDE. A rule that fixes one register by breaking another is not a
 * fix, so the unchanged reference answers must still build untouched. */
check('the reference answers still build [PASSES-OLD]', buildSpec(ANSWERS).ok === true);
check('...byte-for-byte as before the rule [PASSES-OLD]',
  buildSpec(ANSWERS).markdown === built.markdown,
  'the specimen rule refuses or it does nothing; it never edits');

/* --- THE FLOOR IS SCOPED TO DATA-SHAPED TASK TYPES ---------------------
 *
 * Added 2026-08-26 after the floor refused a legitimate request twice: a
 * complete before/after description of a UI change, refused because it holds no
 * digit, path or file extension — and it holds none because there is no file.
 *
 * Every case below is [FAILS-OLD]: before the scoping, the SAME prose was
 * refused under every task type, because the rule did not look at the type.
 */
const proseUi = 'In: someone opens our home page on a phone and there is no accessibility button anywhere.'
  + ' Out: the same page with a round button in the corner that opens a menu offering larger text and higher contrast.';
check('the floor does not apply to `interface` — a UI change has no specimen and needs none [FAILS-OLD]',
  buildSpec({ ...ANSWERS, task_type: 'interface', io: proseUi }).ok === true);
check('...nor to `fix`, which is where both real false refusals landed [FAILS-OLD]',
  buildSpec({ ...ANSWERS, task_type: 'fix', io: proseUi }).ok === true);
check('...and it DOES still apply to `tool` [PASSES-OLD]',
  buildSpec({ ...ANSWERS, task_type: 'tool', io: proseUi }).ok === false);
check('...and to `integration` [PASSES-OLD]',
  buildSpec({ ...ANSWERS, task_type: 'integration', io: proseUi }).ok === false);

/* The scoping list is the whole mechanism, so it is asserted rather than assumed:
 * every member must be a real task type, and it must be a strict subset — a list
 * equal to TASK_TYPES would silently disable the floor everywhere. */
check('SPECIMEN_TASK_TYPES is a strict, non-empty subset of TASK_TYPES',
  SPECIMEN_TASK_TYPES.length > 0
  && SPECIMEN_TASK_TYPES.length < TASK_TYPES.length
  && SPECIMEN_TASK_TYPES.every((t) => TASK_TYPES.includes(t)),
  SPECIMEN_TASK_TYPES.join(','));

/* THE COST, ASSERTED SO IT CANNOT BE FORGOTTEN. A data-shaped `fix` — a CSV bug —
 * now escapes the floor. This was pre-registered as the price of the change and
 * is pinned here so nobody later reads the scoping as free. */
check('KNOWN COST: a data-shaped `fix` escapes the floor, deliberately [FAILS-OLD]',
  buildSpec({ ...ANSWERS, task_type: 'fix', io: 'the export comes out wrong sometimes' }).ok === true,
  'accepted on purpose — a false refusal that blocks a legitimate request was measured as worse');

/* ONLY `io` CARRIES IT. The rule is one field's floor, not a form-wide policy —
 * a `where` or `done` that reads as prose is still the person's to write. */
check('exactly one field declares specimen, and it is io',
  SPEC_FIELDS.filter((f) => f.specimen).length === 1
  && SPEC_FIELDS.find((f) => f.specimen)?.key === 'io');
check('a prose `done` still builds — the rule did not leak to other fields [PASSES-OLD]',
  buildSpec({ ...ANSWERS, done: 'when it feels right and the team is happy' }).ok === true);

/* NO MODEL, NO NETWORK, NO WORD LIST. The third is the one worth asserting:
 * a language-specific phrase list is the patch that passes one run and fails
 * the next one written in another language. */
{
  const src = readFileSync(join(repo, 'workers', 'spec-builder.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function hasSpecimen'), src.indexOf('/** Collapses runs of whitespace'));
  check('hasSpecimen makes no network or model call', !/\bfetch\s*\(/.test(fn) && !/env\./.test(fn));
  /*
   * NO WORD LIST — asserted structurally rather than by scrubbing the source.
   * A list of phrases needs either string literals to compare against or a
   * membership call to compare with. The body has neither: its only string
   * literal is the empty-string default in `String(v ?? '')`.
   */
  const literals = fn.match(/'[^']*'|"[^"]*"/g) || [];
  check('hasSpecimen holds no word list — its only string literal is empty',
    literals.every((l) => l.length === 2), literals.join(' '));
  check('...and compares against no vocabulary',
    !/\.includes\s*\(|\.indexOf\s*\(|\bWORDS\b|\bPHRASES\b/.test(fn),
    'a word list would be a list in one language, and this rule has to hold in every language');
}

/* ═══════════════════════════════ Result ════════════════════════════════ */

console.log(`\nspec-builder: ${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  deterministic, model-free, and the office\'s own parser accepts what it produces.\n');
process.exit(0);
