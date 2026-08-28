#!/usr/bin/env node
/**
 * scripts/verify-owner-review.js — the review queue the owner fills (Session 33, Item C).
 *
 * `globalThis.fetch` is a tripwire: `workers/owner-review.js` is pure parsing
 * and rendering, and every fetch on this path belongs to the desk in
 * `agent-runner.js`, never here.
 *
 *   node scripts/verify-owner-review.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  TO_REVIEW_DIR, FROM_OFFICE_DIR, DEFAULT_REVIEWER_ID, MAX_OWNER_REVIEWS_PER_TICK,
  targetFromName, parseTargetFile, filedSlugs, reviewDraw, reviewFilePath, renderReviewFile,
} from '../workers/owner-review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-owner-review.js made a network call'); };

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(label);
  console.error(`  ✗ ${label}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

const runner = readFileSync(path.join(ROOT, 'workers/agent-runner.js'), 'utf8');

/* ═══ §1 — the office does not get to refuse the client's handwriting ═══ */
section("§1 filenames — liberal, because a queue strict enough to reject him stays empty");

check('YYYY-MM-DD is accepted', targetFromName('2026-08-28-pairing-proposal.md')?.slug === 'pairing-proposal');
check('DD-MM-YYYY is accepted — the format the owner actually writes, and the one that cost six days in 2026-08',
  targetFromName('28-08-2026-pairing-proposal.md')?.slug === 'pairing-proposal');
check('no date at all is accepted', targetFromName('pairing-proposal.md')?.slug === 'pairing-proposal');
check('the README is not a target', targetFromName('README.md') === null);
check('the README is not a target whatever its case', targetFromName('readme.md') === null);
check('a non-markdown file is not a target', targetFromName('notes.txt') === null);
check('the path is inside channel/to-review/', targetFromName('x.md')?.path === `${TO_REVIEW_DIR}/x.md`);

/* ═══ §2 — the body: every field optional ═══ */
section('§2 the body — a file with no fields at all is the common case and must be the easy one');

const bare = parseTargetFile('# Just a title\n\nSome material to look at.');
check('no Target: line means the file itself is the material', bare.targetPath === null);
check('no Reviewer: line is reported as null, NOT defaulted here — so "he did not say" and "we could not read it" stay distinguishable',
  bare.reviewerId === null);
check('no Lens: line is null', bare.lens === null);
check('the H1 becomes the title', bare.title === 'Just a title');

const full = parseTargetFile([
  '# The pairing proposal',
  '',
  'Target: campus/shared/board/PAIRING-PROPOSAL.md',
  'Reviewer: 13',
  'Lens: is anything here a security decision in disguise?',
  '',
  'body text',
].join('\n'));
check('Target: is read', full.targetPath === 'campus/shared/board/PAIRING-PROPOSAL.md');
check('Reviewer: is read', full.reviewerId === 13);
check('Lens: is read', /security decision/.test(full.lens));

check('a bullet-and-bold form is read too — he writes markdown, not a config file',
  parseTargetFile('- **Reviewer:** 5\n').reviewerId === 5);
check('an out-of-range agent number is refused rather than used',
  parseTargetFile('Reviewer: 42\n').reviewerId === null);
check('a reviewer named in words but with no number falls back to the default rather than guessing at a persona',
  parseTargetFile('Reviewer: the cyber person\n').reviewerId === null);
check('and the raw text is kept, so the review can say what it could not read',
  parseTargetFile('Reviewer: the cyber person\n').reviewerRaw === 'the cyber person');

/* ═══ §3 — the draw and the clearing ═══ */
section('§3 the draw — and the obligation clearing the moment the review commits');

const QUEUE = [
  { name: 'README.md' },
  { name: '2026-08-28-alpha.md' },
  { name: '2026-08-28-beta.md' },
  { name: '2026-08-27-gamma.md' },
  { name: 'stray.txt' },
];
const FILED = [
  { name: '2026-08-27-review-gamma.md' },
  { name: 'READ-LOG.md' },
  { name: '2026-08-25-something-else.md' },
];

const filed = filedSlugs(FILED);
check('a filed review is recognised by its filename alone — a directory listing, no index, no ingest', filed.has('gamma'));
check('an unrelated file in from-office/ is not mistaken for a filed review', !filed.has('something-else'));

const d = reviewDraw(QUEUE, { filed });
check('exactly MAX_OWNER_REVIEWS_PER_TICK is drawn', d.draw.length === MAX_OWNER_REVIEWS_PER_TICK);
check('the answered target is NOT drawn again — the obligation cleared when the review committed',
  !d.draw.concat(d.deferred).some((t) => t.slug === 'gamma'));
check('and the skip says why, rather than the target silently vanishing',
  d.skipped.some((sk) => sk.slug === 'gamma' && /already filed/.test(sk.why)));
check('the rest are DEFERRED and named, never dropped', d.deferred.length === 1);
check('a non-markdown file is skipped WITH a reason', d.skipped.some((sk) => sk.name === 'stray.txt'));
check('the README is skipped silently — it is documentation, not a refusal worth reporting',
  !d.skipped.some((sk) => sk.name === 'README.md'));
check('an empty folder draws nothing at all', reviewDraw([], { filed: new Set() }).draw.length === 0);
check('every queued target already answered draws nothing',
  reviewDraw([{ name: '2026-08-27-gamma.md' }], { filed }).draw.length === 0);

/* ═══ §4 — the output ═══ */
section('§4 what he gets back');

check('it lands in channel/from-office/, where he already reads — not a campus folder he has never opened',
  reviewFilePath('2026-08-28', 'alpha') === `${FROM_OFFICE_DIR}/2026-08-28-review-alpha.md`);
check('and its name is exactly what filedSlugs() reads back, so filing it IS the clearing',
  filedSlugs([{ name: '2026-08-28-review-alpha.md' }]).has('alpha'));

const rendered = renderReviewFile({
  today: '2026-08-28', slug: 'alpha', title: 'A thing', reviewerId: 6,
  reviewerName: 'The QA', reviewerRole: 'QA', lens: null, targetPath: 'campus/x.md',
  sourceNote: 'the full text of `campus/x.md` (900 characters)', verdict: 'revise',
  text: 'It does not do the third thing.', provider: 'cerebras', defaultedReviewer: true,
});
check('it carries the channel README\'s own header, so the contract that exists can read it',
  /^---\nfrom: office\n/.test(rendered) && /kind: delivery/.test(rendered));
check('`re:` threads it back to the request slug', /re: alpha/.test(rendered));
check('the verdict is at the top', /\*\*Verdict:\*\* revise/.test(rendered));
check('it says WHAT THE REVIEWER WAS GIVEN — the other half of the 2026-08-17 fabricated-test-run fix',
  /What the reviewer was actually given/.test(rendered) && /the full text of `campus\/x.md`/.test(rendered));
check('it states plainly that nothing was run',
  /ran nothing and executed nothing/i.test(rendered));
check('a defaulted reviewer says it was defaulted, so a persona choice is never read back as his',
  /default/.test(rendered));
check('a NAMED reviewer says he named it',
  /you named this reviewer/.test(renderReviewFile({ today: '2026-08-28', slug: 'a', reviewerId: 13, defaultedReviewer: false, text: 'x', verdict: 'approve' })));
check('a missing verdict is REPORTED, never guessed at',
  /NONE RECORDED/.test(renderReviewFile({ today: '2026-08-28', slug: 'a', reviewerId: 6, text: 'x', verdict: null })));

/* ═══ §5 — the wiring, and what it deliberately does not touch ═══ */
section('§5 the wiring — and C2, proved by absence');

const deskSrc = runner.slice(
  runner.indexOf("const ownerReviewDesk = {"),
  runner.indexOf('out.desks.push(ownerReviewDesk);')
);
/**
 * COMMENTS ARE STRIPPED BEFORE THE ABSENCE CHECKS BELOW.
 *
 * The first version of this file checked the raw source and failed on the
 * comment "the Worker could not read the warehouse even if it were asked to"
 * — a line that says the opposite of a violation. An absence check that reads
 * prose is testing the documentation, and the documentation is precisely the
 * thing this estate keeps finding disagrees with the code.
 */
const deskCode = deskSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

check('the desk exists and is pushed into the admin_desk block\'s desk list',
  deskSrc.length > 500 && /out\.desks\.push\(ownerReviewDesk\)/.test(runner));
check('it runs inside processAdminDeskBlock() — the block already on the Sun-Thu 10:00 tick',
  runner.indexOf("const ownerReviewDesk = {") > runner.indexOf('async function processAdminDeskBlock('));

// C2, PROVED BY ABSENCE. If any of these ever appears in this desk, the review
// queue has been put behind a chain that refuses every day by design.
check('C2: the desk never touches the DISPATCHER', !/dispatch/i.test(deskCode));
check('C2: the desk never requires a warehouse SPEC', !/SPEC\.md/.test(deskCode));
check('C2: the desk never reads a Warehouse PAIRING', !/warehouse/i.test(deskCode));
check('C2: the desk never touches the build chain', !/build_chain|BuildChain|AWAITING_/.test(deskCode));
check('C2: the desk never reads BOARD.md', !/BOARD\.md|boardTasks/.test(deskCode));

check('C3: it commits to back-office channel/from-office/, never to the lifecycle inbox',
  /reviewFilePath\(today, target\.slug\)/.test(deskSrc) && !/LIFECYCLE_INBOX_DIR/.test(deskCode));
check('an UNREADABLE queue is reported as unreadable, not as empty',
  /could not be READ, which is not the same fact as empty/.test(deskSrc));
check('an unreadable FILED set stops the draw too — otherwise the same target is re-reviewed every weekday',
  /what is already answered could not be checked/.test(deskSrc));
check('a named Target: that cannot be read is NAMED, and the request note is not silently reviewed in its place',
  /COULD NOT BE READ/.test(deskSrc));
check('the owner\'s own Lens: is put to the reviewer verbatim and outranks the standing lens',
  /IN THE CLIENT'S OWN WORDS/.test(deskSrc));
check('the reviewer is told what it actually has — the standing anti-fabrication instruction',
  /You have NOT run this/.test(deskSrc));
check('and it gets the same 2200-token budget the 2026-08-17 cut-off verdicts forced',
  /maxTokens: 2200/.test(deskSrc));
check('a review that could not be committed is an ERROR, never counted as produced',
  /the review exists nowhere/.test(deskSrc));
check('the default reviewer is the QA', DEFAULT_REVIEWER_ID === 6);

/* ═══════════════ done ═══════════════ */
console.log(`\n${fail === 0 ? '✅' : '❌'} verify-owner-review: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
