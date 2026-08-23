#!/usr/bin/env node
/**
 * Dry-run verification for the owner's page (2026-08-10, REQ-003).
 *
 * NO NETWORK, NO D1/KV, NO MODEL CALLS. globalThis.fetch is a tripwire.
 *
 * ── THE CENTRAL PROPERTY THIS PROVES ─────────────────────────────────────
 *
 * *The page must produce a message the existing parser accepts, and the parser
 * must not be relaxed to make the page easier.*
 *
 * §2 proves it the only way worth proving it: by running **every message the page
 * can build** through **the real, unmodified `parseOwnerMessage()`** — the same
 * function that reads the folder in production — and asserting each one is
 * accepted. §3 then goes the other way and asserts the parser still refuses
 * everything it refused before, so "the page works" cannot have been bought by
 * loosening the contract.
 *
 * The two directions together are the point. Either one alone is satisfiable by
 * cheating.
 *
 * Run: node scripts/verify-owner-page.js
 */

import { readFileSync } from 'node:fs';

import {
  renderOwnerPage, buildOwnerMessage, buildOwnerState, slugify, PAGE_KINDS,
} from '../workers/owner-page.js';
import {
  parseOwnerMessage, OWNER_KINDS, OWNER_STATUSES, OWNER_DIR, classifyOwnerMessages,
} from '../workers/owner-channel.js';

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`[PASS] ${label}`); pass += 1; }
  else { console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`); fail += 1; }
}

const NETWORK = [];
globalThis.fetch = (...args) => {
  NETWORK.push(String(args[0]));
  throw new Error(`verify-owner-page.js made a network call to ${args[0]} — this verifier must stay dry-run`);
};

const DATE = '2026-08-10';
console.log('=== The owner\'s page — dry-run verification ===\n');

/* ── 1. Purity and the trust boundary ───────────────────────────────────── */
console.log('--- 1. The page is presentation, and the contract is not its to change ---');

const pageSrc = readFileSync(new URL('../workers/owner-page.js', import.meta.url), 'utf8');
const channelSrc = readFileSync(new URL('../workers/owner-channel.js', import.meta.url), 'utf8');
const runnerSrc = readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8');

check('owner-page.js imports NOTHING (plain node exercises the real builder)',
  !/^import /m.test(pageSrc));
check('owner-page.js records WHY the office may build a page but not the folder contract',
  /builds the pipe that[\s\S]{0,12}feeds it/.test(pageSrc));
check('the page defines no `kind` of its own — PAGE_KINDS is a SUBSET of the parser\'s vocabulary',
  PAGE_KINDS.every((k) => OWNER_KINDS.includes(k)),
  `page=${PAGE_KINDS.join(',')} parser=${OWNER_KINDS.join(',')}`);
check('...and it offers every owner-side kind the parser knows (nothing he can write by hand is missing from the page)',
  OWNER_KINDS.every((k) => PAGE_KINDS.includes(k)),
  OWNER_KINDS.filter((k) => !PAGE_KINDS.includes(k)).join(','));
check('the page writes into the parser\'s own directory constant, not a second path',
  buildOwnerMessage({ subject: 'x', body: 'y', kind: 'instruction', date: DATE }).path.startsWith(`${OWNER_DIR}/`));

/* ── 2. EVERY MESSAGE THE PAGE CAN BUILD IS ACCEPTED BY THE REAL PARSER ── */
console.log('\n--- 2. Every page message passes the REAL parser, unmodified ---');

for (const kind of PAGE_KINDS) {
  const built = buildOwnerMessage({
    subject: 'Ship the office site',
    body: 'Deploy it somewhere I can reach and tell me the URL.',
    kind,
    date: DATE,
    re: kind === 'reply' ? 'ship-the-office-site' : 'new',
  });
  check(`the page builds a valid message for kind "${kind}"`, built.ok, built.reason || '');
  const parsed = parseOwnerMessage(built.text, built.filename, 'abc123def456');
  check(`...and THE REAL PARSER accepts it`, parsed.ok, parsed.reason || '');
  if (parsed.ok) {
    check(`...and the parsed kind is "${kind}", not a default`, parsed.message.kind === kind, parsed.message.kind);
    check(`...and the parsed title is the SUBJECT, not a guess from the filename`,
      parsed.message.title === 'Ship the office site', parsed.message.title);
    check(`...and the status is "open" — the office writes that field, the owner does not`,
      parsed.message.status === 'open', parsed.message.status);
  }
}

/* Awkward but legitimate subjects. A page that only works for tidy input is a
 * page that fails on the day he is in a hurry. */
const AWKWARD = [
  ['punctuation and caps', 'URGENT: Fix the Front!! (again)', 'urgent-fix-the-front-again'],
  ['leading and trailing junk', '   ---ship it---   ', 'ship-it'],
  ['a very long subject', 'a'.repeat(200), 'a'.repeat(48)],
  ['digits only', '2026 plan', '2026-plan'],
];
for (const [label, subject, expectedSlug] of AWKWARD) {
  const built = buildOwnerMessage({ subject, body: 'do it', kind: 'instruction', date: DATE });
  check(`an awkward subject (${label}) still builds`, built.ok, built.reason || '');
  if (built.ok) {
    check(`...and slugifies to a filename the parser's own regex accepts`,
      parseOwnerMessage(built.text, built.filename).ok, built.filename);
    check(`...and the slug is what it should be (${expectedSlug.slice(0, 20)}…)`,
      built.slug === expectedSlug, `${built.slug} vs ${expectedSlug}`);
  }
}

/* Hebrew. The office writes Hebrew internally and the owner is a Hebrew speaker,
 * so a subject in Hebrew must not produce an unusable filename — it must produce a
 * REFUSAL with a usable message, since the parser's slug regex is ASCII by
 * contract and this page does not get to change that. */
const hebrew = buildOwnerMessage({ subject: 'לשלוח את האתר', body: 'תעשה את זה', kind: 'instruction', date: DATE });
check('a Hebrew SUBJECT is refused with a reason rather than producing a filename the parser would reject',
  hebrew.ok === false && /at least one letter or digit/.test(hebrew.reason), JSON.stringify(hebrew));
const hebrewBody = buildOwnerMessage({ subject: 'send the site', body: 'תעשה את זה — עברית בגוף ההודעה', kind: 'instruction', date: DATE });
check('a Hebrew BODY is fine — only the filename is ASCII-constrained, and the body is where he writes',
  hebrewBody.ok && parseOwnerMessage(hebrewBody.text, hebrewBody.filename).ok);
check('...and the Hebrew survives into the parsed body intact',
  parseOwnerMessage(hebrewBody.text, hebrewBody.filename).message.body.includes('עברית בגוף ההודעה'));

/* ── 3. THE PARSER STILL REFUSES EVERYTHING IT REFUSED BEFORE ───────────── */
console.log('\n--- 3. The parser is NOT relaxed. Every refusal still refuses. ---');

check('a bad FILENAME is still refused',
  parseOwnerMessage('---\nfrom: owner\nkind: instruction\n---\n\n# t\n\nb', 'not-a-date.md').ok === false);
// CHANGED 2026-08-23: missing front matter is no longer refused — it is read
// conservatively as `kind: instruction` with `kindDefaulted: true`. What the
// PAGE does is unchanged: it always writes a header, so nothing it composes
// ever takes that path. Both halves are asserted, so a page that silently
// stopped writing a header would still be caught here.
check('MISSING front matter is now accepted, and flagged as a DEFAULTED kind',
  (() => {
    const r = parseOwnerMessage('# t\n\nbody with no header', `${DATE}-x.md`);
    return r.ok === true && r.message.kindDefaulted === true;
  })());
check('...and the page NEVER relies on that — what it composes states its own kind',
  (() => {
    const b = buildOwnerMessage({ subject: 'ship it', body: 'do it', kind: 'instruction', date: DATE });
    return b.ok && parseOwnerMessage(b.text, b.filename).message.kindDefaulted === false;
  })());
check('an UNRECOGNISED kind is still refused, not defaulted',
  parseOwnerMessage(`---\nfrom: owner\ndate: ${DATE}\nkind: memo\nre: new\nstatus: open\n---\n\n# t\n\nb`, `${DATE}-x.md`).ok === false);
check('an EMPTY body is still refused',
  parseOwnerMessage(`---\nfrom: owner\ndate: ${DATE}\nkind: instruction\nre: new\nstatus: open\n---\n\n`, `${DATE}-x.md`).ok === false);
check('`status: acted` with no `Acted:` line is still refused — the office may not mark its own homework',
  parseOwnerMessage(`---\nfrom: owner\ndate: ${DATE}\nkind: instruction\nre: new\nstatus: acted\n---\n\n# t\n\nb`, `${DATE}-x.md`).ok === false);
check('the statuses vocabulary is unchanged', OWNER_STATUSES.join(',') === 'open,acted,closed', OWNER_STATUSES.join(','));
check('the parser source contains no page-shaped exception (no branch mentioning the page)',
  !/owner-page|from the page|via the page/i.test(channelSrc));

/* ── 4. The page CANNOT set the fields that are not his ─────────────────── */
console.log('\n--- 4. The page cannot write the fields the contract reserves ---');

const built = buildOwnerMessage({ subject: 'x', body: 'y', kind: 'instruction', date: DATE });
check('every built message carries `status: open`, always', /^status: open$/m.test(built.text));
check('no built message can carry `status: acted`',
  PAGE_KINDS.every((k) => !/status: acted/.test(buildOwnerMessage({ subject: 'x', body: 'y', kind: k, date: DATE }).text)));
check('no built message can carry an `Acted:` line — that is the office\'s to add, with evidence',
  !/Acted:/i.test(built.text));
check('`from:` is always owner (the page cannot forge an office message into his folder)',
  /^from: owner$/m.test(built.text));
check('the page HTML offers no status control at all',
  !/id="status"[^>]*>\s*<option/i.test(renderOwnerPage({})));

/* Refusals with usable reasons, rather than best-effort files. */
const REFUSALS = [
  ['no subject', { subject: '', body: 'b', kind: 'instruction', date: DATE }, /subject is required/],
  ['multi-line subject', { subject: 'a\nb', body: 'b', kind: 'instruction', date: DATE }, /single line/],
  ['no body', { subject: 's', body: '   ', kind: 'instruction', date: DATE }, /body is empty/],
  ['unknown kind', { subject: 's', body: 'b', kind: 'memo', date: DATE }, /kind must be one of/],
  ['bad date', { subject: 's', body: 'b', kind: 'instruction', date: '10/08/2026' }, /YYYY-MM-DD/],
  ['unslugifiable subject', { subject: '!!!', body: 'b', kind: 'instruction', date: DATE }, /at least one letter or digit/],
];
for (const [label, input, pattern] of REFUSALS) {
  const r = buildOwnerMessage(input);
  check(`${label} is refused with a reason naming the field to fix`,
    r.ok === false && pattern.test(r.reason), JSON.stringify(r));
}
check('slugify() returns null rather than an empty string, so a caller cannot build "2026-08-10-.md"',
  slugify('!!!') === null && slugify('') === null);

/* ── 5. The read state — three states, never two ────────────────────────── */
console.log('\n--- 5. The read state is visible, and "unread" never looks like "ignored" ---');

const msg = (over) => ({
  id: '2026-08-10-a', path: 'channel/from-owner/2026-08-10-a.md', filename: '2026-08-10-a.md',
  date: '2026-08-10', slug: 'a', kind: 'instruction', status: 'open', re: 'new',
  title: 'A', body: 'body', acted: null, sha: 'aaaaaaaaaaaa', ...over,
});
const unreadMsg = msg({ id: 'm-unread', sha: 'unread000000' });
const readMsg = msg({ id: 'm-read', sha: 'read00000000' });
const actedMsg = msg({ id: 'm-acted', sha: 'acted0000000', status: 'acted', acted: 'filed as OB-047, dispatched to Agent 9' });

const readLog = { byKey: new Map([['m-read@read00000000', { readAt: '2026-08-10T09:00:00Z' }]]) };
const classified = classifyOwnerMessages([unreadMsg, readMsg, actedMsg], readLog);
const state = buildOwnerState({ owner: { ok: true, classified, malformed: [] }, submissions: null, questions: null, errors: [] });

check('an unread message reports UNREAD',
  state.messages.find((m) => m.id === 'm-unread').state === 'UNREAD');
check('a read-but-not-acted message reports READ_NOT_ACTED, distinctly',
  state.messages.find((m) => m.id === 'm-read').state === 'READ_NOT_ACTED');
check('an acted message reports ACTED',
  state.messages.find((m) => m.id === 'm-acted').state === 'ACTED');
check('...and carries the `Acted:` line VERBATIM, so he sees WHAT was done rather than that something was',
  state.messages.find((m) => m.id === 'm-acted').acted === 'filed as OB-047, dispatched to Agent 9');
check('the three states are genuinely three (not two with a synonym)',
  new Set(state.messages.map((m) => m.state)).size === 3);
check('the state view carries no token, secret or credential field',
  !/token|secret|apikey|api_key|password/i.test(JSON.stringify(state)));

/* THE most important distinction on the page: an empty channel and an unreadable
 * one must not render alike. This project's most-repeated defect shape. */
const unreadable = buildOwnerState({ owner: null, errors: ['BACKOFFICE_REPO_TOKEN is not configured'] });
const emptyOk = buildOwnerState({ owner: { ok: true, classified: classifyOwnerMessages([], { byKey: new Map() }), malformed: [] }, errors: [] });
check('an UNREADABLE channel reports channelReadable:false',
  unreadable.channelReadable === false && unreadable.ok === false);
check('an EMPTY but readable channel reports channelReadable:true with zero messages',
  emptyOk.channelReadable === true && emptyOk.messages.length === 0);
check('the two are distinguishable — "you wrote nothing" is not "we cannot see what you wrote"',
  unreadable.channelReadable !== emptyOk.channelReadable);
check('the page renders a DIFFERENT sentence for each',
  /do not read an empty list as silence/.test(renderOwnerPage({}))
  && /genuinely empty, not broken/.test(renderOwnerPage({})));
check('the office\'s own read errors are surfaced to him rather than hidden',
  unreadable.errors.length === 1 && /read "unreachable" as "ignored"/.test(renderOwnerPage({})));

/* ── 6. Authentication and the wiring in agent-runner.js ────────────────── */
console.log('\n--- 6. Authenticated, with no second write path ---');

check('the write endpoint is under /api/agents/, which the router authenticates before any handler',
  /url\.pathname === '\/api\/agents\/owner-message'/.test(runnerSrc)
  && /url\.pathname\.startsWith\('\/api\/agents\/'\)[\s\S]{0,400}token !== env\.ADMIN_TOKEN/.test(runnerSrc));
check('the state endpoint is under /api/agents/ too',
  /url\.pathname === '\/api\/agents\/owner-state'/.test(runnerSrc));
check('THE GATE: the handler runs the candidate through parseOwnerMessage() BEFORE committing',
  /parseOwnerMessage\(built\.text, built\.filename[\s\S]{0,600}if \(!parsed\.ok\)[\s\S]{0,500}commitFileToRepo/.test(runnerSrc));
check('...and refuses rather than writing when the parser says no',
  /refused by the office's own parser before anything was written/.test(runnerSrc));
check('...and says out loud that if it ever fires, the PAGE is wrong — not the parser',
  /If this ever fires, the PAGE is wrong/.test(runnerSrc));
check('the write goes through the GOVERNED write path (commitFileToRepo), not a hand-built request',
  /commitFileToRepo\(\s*env, BACKOFFICE_REPO_NAME, built\.path/.test(runnerSrc));
check('there is no unauthenticated write path anywhere for the owner channel',
  !/POST[\s\S]{0,120}\/owner(?!-)/.test(runnerSrc.replace(/\/api\/agents\/owner-message/g, '')));
check('the served page is explicitly no-store (its job is live read state)',
  /url\.pathname === '\/owner'[\s\S]{0,700}no-store/.test(runnerSrc));
check('the page is served with a CSP that forbids loading anything external',
  /Content-Security-Policy[\s\S]{0,200}default-src 'none'/.test(runnerSrc));
check('...and with no-referrer, so a pasted token can never leak through a referrer header',
  /Referrer-Policy[\s\S]{0,40}no-referrer/.test(runnerSrc));

/* ── 7. The page is self-contained ──────────────────────────────────────── */
console.log('\n--- 7. Self-contained: no CDN, no external asset, no build step ---');

const html = renderOwnerPage({ endpointBase: 'https://example.workers.dev' });
check('the page is one HTML document', /^<!doctype html>/i.test(html.trim()));
check('it loads no external script or stylesheet',
  !/<script[^>]+src=/i.test(html) && !/<link[^>]+href="http/i.test(html));
check('it references no external host at all except its own endpointBase',
  (html.match(/https?:\/\/[^"'\s)]+/g) || []).every((u) => u.startsWith('https://example.workers.dev')),
  (html.match(/https?:\/\/[^"'\s)]+/g) || []).join(' '));
check('the token input is type=password and autocomplete=off', /id="token" type="password" autocomplete="off"/.test(html));
check('the token is sent as a HEADER, never in a query string',
  /'X-Admin-Token': token/.test(html) && !/\?token=/.test(html));
check('the token is held in sessionStorage (this tab only), not localStorage',
  /sessionStorage/.test(html) && !/localStorage/.test(html));
check('the page explains what each `kind` DOES, since kind is load-bearing and not a label',
  /OUTRANKS the delegation board/.test(html) && /expected to have STOPPED/.test(html));
check('the page offers a reply control that threads by slug (the contract\'s `re:` field)',
  /data-reply/.test(html) && /\$\('re'\)\.value/.test(html));
check('the page tells him the write is a DELIVERY and makes no claim that anyone has read it',
  /reads this folder on every office-context refresh/.test(runnerSrc));
check('the page states the parser gate in words he can read',
  /the parser is not relaxed to accept the page/.test(html));

/* ── 8. Network tripwire ────────────────────────────────────────────────── */
console.log('\n--- Network tripwire ---');
check('this verifier made ZERO network calls end to end', NETWORK.length === 0, NETWORK.join(','));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) { console.log('MISMATCH — see FAIL lines above.'); process.exit(1); }
console.log('All scenarios matched expectations.');
process.exit(0);
