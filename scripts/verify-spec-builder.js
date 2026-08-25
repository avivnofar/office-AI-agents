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
  buildSpec, specFilename, renderSpecPage,
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
check('...and the only fetches in the whole module are the page\'s two, to this Worker\'s own endpoints',
  (code.match(/\bfetch\s*\(/g) || []).length === 2
  && /fetch\(BASE \+ '\/api\/spec\/build'/.test(code)
  && /fetch\(BASE \+ '\/api\/agents\/owner-message'/.test(code),
  'a third fetch appearing here is a new outbound call and must be justified, not absorbed');
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
  /'X-Admin-Token': t/.test(html) && !/[?&]token=/.test(html));
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

/* ═══════════════════════════════ Result ════════════════════════════════ */

console.log(`\nspec-builder: ${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  deterministic, model-free, and the office\'s own parser accepts what it produces.\n');
process.exit(0);
