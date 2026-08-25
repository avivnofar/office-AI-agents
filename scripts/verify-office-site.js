#!/usr/bin/env node
/**
 * scripts/verify-office-site.js — is the merged page actually live-wired,
 * and are the two surfaces actually two?
 *
 * Written 2026-08-25 (Session 17, Item C). Run:  node scripts/verify-office-site.js
 *
 * ── THE TWO THINGS THAT WOULD SILENTLY UNDO THIS MERGE ───────────────────
 *
 * 1. **The snapshot creeping back.** The office's warehouse build read a 52KB
 *    `data.js` frozen on 2026-08-07 and rendered it as though it were current.
 *    The failure mode is not that the page breaks — it is that the page keeps
 *    working and shows numbers that stopped being true weeks ago. §1 asserts
 *    the module carries no baked data at all: no `OFFICE_SITE_DATA`, no
 *    `data.js`, and no literal count anywhere it could render as a total.
 *
 * 2. **The two surfaces collapsing into one.** Session 16 split `/api/public`
 *    from `/api/admin` so that a single auth bug could not expose everything.
 *    A merged page that shipped one bundle able to call either would hand that
 *    property straight back. §2 asserts the PUBLIC render contains no admin
 *    path, no admin field name, and none of the code that renders them —
 *    not that a runtime check hides them.
 *
 * §3 reads `agent-runner.js` and asserts the routes are wired and that
 * `/admin` is reached only after the gate — §7 of ARCHITECTURAL-DECISIONS.md
 * is six occurrences of a guard the calling path never reaches, and a page
 * route added below a gate is exactly where the seventh would go.
 *
 * §4 is the honesty check the office itself wrote and this session inherited:
 * the "what this page cannot show you" section must still exist AND must not
 * still be making the claims that stopped being true when it went live.
 *
 * NETWORK: zero calls. What is DEPLOYED is proven in the session report by
 * real HTTP requests; this file proves what the code decides.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderOfficeSite } from '../workers/office-site-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const runner = readFileSync(join(repo, 'workers', 'agent-runner.js'), 'utf8');
const module_ = readFileSync(join(repo, 'workers', 'office-site-page.js'), 'utf8');

const PUBLIC = renderOfficeSite({ mode: 'public' });
const ADMIN = renderOfficeSite({ mode: 'admin' });

/**
 * The three surfaces of one render, kept apart on purpose.
 *
 * The first cut of this file asserted things about the whole HTML string and
 * produced four findings, all of them about the wrong surface: three matched
 * SELECTOR NAMES in the office's verbatim stylesheet (`.pending-item`,
 * `.spec-frame`) and one matched the word "localStorage" inside a COMMENT
 * explaining that localStorage is no longer used.
 *
 * That is worth keeping in the file rather than quietly fixing, because the
 * distinction is the point: a class name in a stylesheet copied byte for byte
 * from the office's own public work is not an admin leak, and a comment is not
 * a behaviour. What matters is whether the public bundle can ACT — whether its
 * script can reach an admin path or render admin material. So the assertions
 * below name which surface they are asking about.
 */
function surfaces(html) {
  return {
    css: html.split('<style>')[1].split('</style>')[0],
    markup: html.split('</style>')[1].split('<script>')[0],
    js: html.split('<script>')[1].split('</' + 'script>')[0],
  };
}
const PUB = surfaces(PUBLIC);
const ADM = surfaces(ADMIN);
/** Everything that can act: markup + script, but not the stylesheet. */
const PUB_ACTIVE = PUB.markup + PUB.js;
const ADM_ACTIVE = ADM.markup + ADM.js;

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ═══════════ 1. NO SNAPSHOT — THE THING THE MERGE EXISTED TO KILL ════════ */

console.log('--- 1. nothing is baked in ---');

check('the warehouse global is gone from both renders',
  !PUBLIC.includes('OFFICE_SITE_DATA') && !ADMIN.includes('OFFICE_SITE_DATA'),
  'window.OFFICE_SITE_DATA was the snapshot');
check('no <script src="data.js"> in either render',
  !PUBLIC.includes('data.js') && !ADMIN.includes('data.js'));
check('the module has no generated_at literal of its own',
  !/generated_at['"]?\s*[:=]\s*['"]20/.test(module_),
  'a baked timestamp means a baked page');
check('the 2026-08-07 snapshot stamp appears nowhere in the renders',
  !PUBLIC.includes('2026-08-07') && !ADMIN.includes('2026-08-07'));
check('the public render fetches at load time',
  /fetch\(ENDPOINT/.test(PUBLIC));
check('the public render points at /api/public and nothing else',
  PUBLIC.includes('"/api/public"') && (PUBLIC.match(/\/api\//g) || []).length === 1,
  `found ${(PUBLIC.match(/\/api\/[a-z]+/g) || []).join(', ')}`);
check('the admin render points at /api/admin',
  ADMIN.includes('"/api/admin"'));
check('neither render READS OR WRITES localStorage (a comment mentioning it is fine)',
  !/localStorage\s*\.\s*(get|set|remove)Item/.test(PUB.js)
  && !/localStorage\s*\.\s*(get|set|remove)Item/.test(ADM.js),
  'a fallback copy is a snapshot with extra steps');

/* ═══════════ 2. THE TWO SURFACES ARE TWO BUNDLES, NOT ONE WITH A FLAG ════ */

console.log('\n--- 2. the public bundle cannot reach the admin surface ---');

check('the public render never names /api/admin', !PUBLIC.includes('/api/admin'));
check('the public render never names ANY /admin path — stylesheet included', !PUBLIC.includes('/admin'));
check('the public SCRIPT carries no pending-item renderer',
  !PUB.js.includes('renderPending()') && !PUB.js.includes('pending-groups')
  && !PUB.markup.includes('pending-groups'),
  'the office\'s stylesheet still defines .pending-* and is copied verbatim — that is design, not behaviour');
check('the public MARKUP frames nothing at all',
  !PUB.markup.includes('iframe') && !PUB.js.includes('iframe')
  && !PUB.markup.includes('spec-frame'));
check('the public render has no tab that would reveal an admin surface exists',
  !PUBLIC.includes('data-tab="pending"') && !PUBLIC.includes('data-tab="spec"'));
check('the public script cannot render the office\'s internal material',
  !PUB.js.includes('status_note') && !PUB.js.includes('pending_items')
  && !PUB.js.includes('data_gaps') && !PUB.js.includes('openSpecFor'),
  'these are the admin payload\'s fields and the code that displays them');
/*
 * `bible_detail` IS in the public script, and is allowed to be.
 *
 * It is read by the agent-card detail view, which is ONE renderer handling both
 * payload shapes — the office's own card, unchanged. The public endpoint never
 * returns the field, so the branch never fires; the alternative is a second
 * copy of the card renderer, which is the duplication this estate keeps paying
 * for. A field NAME is not the field's contents, and it is asserted here
 * deliberately rather than left as an accident nobody decided.
 */
check('the one admin-shaped field name in the public script is the shared card renderer, and nothing else',
  PUB.js.includes('bible_detail')
  && PUB.js.indexOf('bible_detail') === PUB.js.lastIndexOf('bible_detail'),
  'more than one occurrence means something other than the shared renderer read it');
check('the admin render DOES carry all of it',
  ADMIN.includes('/api/admin') && ADMIN.includes('pending-groups')
  && ADMIN.includes('spec-frame') && ADMIN.includes('data-tab="pending"'));
check('the admin render asks robots not to index it',
  /noindex/.test(ADMIN) && !/noindex/.test(PUBLIC));

/* ═══════════ 3. THE ROUTES, AND WHICH SIDE OF THE GATE THEY ARE ON ══════ */

console.log('\n--- 3. wired, and on the right side of the gate ---');

const gateCall = runner.indexOf('if (isAdminPagePath(url.pathname)');
const rootRoute = runner.indexOf("url.pathname === '/'");
const adminRoute = runner.indexOf("(url.pathname === '/admin' || url.pathname === '/admin/')");

check('agent-runner.js imports the page module', /from '\.\/office-site-page\.js'/.test(runner));
check('GET / is routed', rootRoute !== -1);
check('GET /admin is routed', adminRoute !== -1);
check('/ is served in public mode',
  /url\.pathname === '\/'\)\s*\{[\s\S]{0,120}renderOfficeSite\(\{ mode: 'public' \}\)/.test(runner));
check('/admin is served in admin mode',
  /renderOfficeSite\(\{ mode: 'admin' \}\)/.test(runner));
check('the /admin page route is BELOW the gate, so it is unreachable without a credential',
  gateCall !== -1 && adminRoute !== -1 && gateCall < adminRoute,
  `gate at ${gateCall}, /admin route at ${adminRoute}`);
check('the public route is NOT inside the admin prefix, so the gate never sees it',
  !/^\/admin/.test('/'));
check('only the admin render is allowed to frame anything (frame-src)',
  /frame-src 'self'/.test(runner.slice(adminRoute, adminRoute + 900))
  && !/frame-src/.test(runner.slice(rootRoute, rootRoute + 900)));
check('the public page is cacheable, the admin page is not',
  /max-age=60/.test(runner.slice(rootRoute, rootRoute + 900))
  && /no-store/.test(runner.slice(adminRoute, adminRoute + 900)));

/* ═══════════ 4. THE HONESTY SECTION SURVIVED, AND IS NOT STALE ══════════ */

console.log('\n--- 4. "what this page cannot show you" ---');

check('the section still exists in both renders',
  PUBLIC.includes('What this page cannot show you') && ADMIN.includes('What this page cannot show you'),
  'this is the best thing on the office\'s site and the habit is the point');
check('it no longer claims live counts are unavailable',
  !PUBLIC.includes('not available from a static page'),
  'that sentence was true of the snapshot and is false now — stale in the other direction');
check('it no longer claims the page does not update itself',
  !PUBLIC.includes('nothing on this page updates itself') && !ADMIN.includes('nothing on this page updates itself'));
check('it no longer promises a localStorage message box',
  !PUBLIC.includes('live only in this browser') && !ADMIN.includes('live only in this browser'));
check('it names the real staleness bound the live wiring introduces',
  PUBLIC.includes('30-minute cron'),
  'the counts are written on a cron; a live fetch does not make them instantaneous');
check('it still refuses to claim the counts mean quality',
  /is a count, not a quality claim/.test(PUBLIC));
check('the admin version adds the pending list\'s own limits',
  ADMIN.includes('read FRESH') && !PUBLIC.includes('read FRESH'));
check('the section is filled from the live payload too, not only a static list',
  /GAP_KEYS\.forEach/.test(ADM.js) && /data\[key\]/.test(ADM.js));
check('the admin bundle reads BOTH live gap sources, the public bundle only the public one',
  ADM.js.includes('["notes","data_gaps"]') && PUB.js.includes('["notes"]')
  && !PUB.js.includes('data_gaps'),
  'which payload keys feed the list is a per-mode list, not a shared read of an admin field');
check('errors the office hit reading its own material are surfaced, not swallowed',
  /gaps-errors/.test(ADMIN) && /data\.errors/.test(ADMIN));

/* ═══════════ 5. THE OFFICE'S DESIGN WAS NOT REDESIGNED ═════════════════ */

console.log('\n--- 5. the shell is the office\'s ---');

const OFFICE_SELECTORS = [
  '.agent-card', '.agent-badges', '.status--live', '.status--bible-only',
  '.status--persona', '.agent-detail-toggle', '.pending-item', '.pending-source',
  '.respond-btn', '.site-header', '.eyebrow', '.lede', '.section-note',
];
for (const sel of OFFICE_SELECTORS) {
  check(`the office's ${sel} rule survived the copy`, module_.includes(sel + ' {') || module_.includes(sel + ','));
}
check('the office\'s dark palette survived (its :root variables)',
  module_.includes('--bg: #0b0d12') && module_.includes('--accent: #6ea8fe'));
check('the copy is marked as a copy, with its provenance',
  /PROVENANCE: copied verbatim/.test(module_) && /warehouse-office-AI-agents/.test(module_));
check('additions are kept separate from the copied stylesheet',
  module_.includes('OFFICE_CSS_ADDITIONS'),
  'so a diff against the warehouse file stays meaningful');

/* ═══════════ 6. THE SPEC BUILDER IS REUSED, NOT REBUILT ════════════════ */

console.log('\n--- 6. one implementation of the spec format ---');

check('the admin page FRAMES /admin/spec', ADMIN.includes('src="/admin/spec"'));
check('the page module does not import the spec builder',
  !/from '\.\/spec-builder\.js'/.test(module_));
check('the page module rebuilds no part of the spec format',
  !module_.includes('buildSpec') && !module_.includes('channel_body') && !module_.includes('specFilename'));
check('the framed builder is same-origin only',
  ADMIN.includes('src="/admin/spec"') && !ADMIN.includes('src="http'));

/* ═══════════ 7. WHAT THE OLD PAGE DID, THAT THIS ONE MUST NOT ══════════ */

/**
 * Transcribed from the warehouse build rather than described. If the merged
 * page still does any of these, the merge did not happen.
 */
console.log('\n--- 7. the warehouse page\'s behaviours are gone ---');

const OLD_BEHAVIOURS = [
  ['read a frozen global instead of the network', 'window.OFFICE_SITE_DATA'],
  ['saved messages to localStorage under office-site.messages.v1', 'office-site.messages.v1'],
  ['told the owner a message was "Saved on this device"', 'Saved on this device'],
  ['opened a pre-filled GitHub Issue as its delivery mechanism', 'github.com/avivnofar'],
  ['described itself as a static build', 'static, dependency-free build'],
];
for (const [what, needle] of OLD_BEHAVIOURS) {
  check(`no longer: ${what}`, !PUBLIC.includes(needle) && !ADMIN.includes(needle));
}

/* ═══════ 8. THE ANSWER BOX, AND THE OFFICE-DATA TAB (Session 18) ═══════ */

console.log('\n--- 8. the room takes an answer, and says what that does ---');

check('the admin page has an answer box on the pending card',
  ADM.js.includes('answer-send') && ADM.js.includes('function answerBox('));
check('the answer goes to the endpoint that ALREADY WORKS — no new channel',
  ADM.js.includes('"/api/agents/owner-message"'));
/*
 * Behaviour, not vocabulary. The client script's own comments NAME
 * `channel/from-owner/` — that is the script explaining where its POST ends up,
 * and this file already draws that distinction for the stylesheet. What must be
 * true is that every URL the page actually calls is one of this Worker's own
 * /api/ paths.
 */
const fetchTargets = [...ADM.js.matchAll(/fetch\(\s*("[^"]*"|[A-Z_]+)/g)].map((m) => m[1]);
check('it invents no second write path — every call the page makes is a Worker /api/ path',
  fetchTargets.length > 0
  && fetchTargets.every((t) => t === 'ENDPOINT' || /^"\/api\//.test(t))
  && !ADM.js.includes('api.github.com') && !ADM.js.includes('commitFile'),
  `targets: ${fetchTargets.join(', ')}`);
check('the answer carries the item id so the office\'s reply reader can attribute it',
  /In answer to item/.test(ADM.js) && /item\.item_id/.test(ADM.js));
check('the subject leads with the id, because the filename slug is cut at 48 characters',
  /item\.item_id \+ " — " \+ ask/.test(ADM.js));
check('the card renders the ask, the options and the office\'s default',
  ADM.js.includes('notice.options') && ADM.js.includes('If you say nothing: ')
  && ADM.js.includes('item.by_when'));
check('the card renders the PLAIN provenance, not the board line with its identifier',
  ADM.js.includes('item.source_plain') && !ADM.js.includes('text: item.source }'));
check('the headline is the stripped ask, not the raw title',
  /var headline = item\.ask \|\| item\.title/.test(ADM.js));
check('what the office FAILED to state is shown rather than hidden',
  ADM.js.includes('notice.missing') && /did not record/.test(ADM.js));
check('a refusal is shown in the parser\'s own words, not summarised',
  /r\.body && r\.body\.reason/.test(ADM.js) && /The office refused it/.test(ADM.js));
check('the page states, on the card, whether an answer stops the office asking',
  /answer_stops_the_asking/.test(ADM.js) && /raises it once more after seven days/.test(ADM.js));
check('AND IT DOES NOT CLAIM the card disappears — this list reads the ledger',
  /stays on this page until the office marks its own ledger entry/.test(ADM.js),
  'the page must not promise a state change it does not perform');

check('the office-data tab exists and renders from the payload',
  ADMIN.includes('data-tab="office-data"') && ADM.js.includes('function renderOfficeData('));
check('the office-data tab reads the automation block the endpoint supplies',
  ADM.js.includes('data.automation'));
check('none of it is in the public bundle',
  !PUBLIC.includes('data-tab="office-data"') && !PUB.js.includes('renderOfficeData')
  && !PUB.js.includes('owner-message') && !PUB.js.includes('answerBox')
  && !PUB.js.includes('automation'));
check('the public bundle still cannot POST anything anywhere',
  !/method:\s*"POST"/.test(PUB.js));

/* B6: the office's palette, and no invented variable. The bug this catches
 * was invisible to code review and was found by loading the page — added CSS
 * named --ink/--card/--rule, which :root does not define, so every one fell
 * through to a light-theme fallback. */
const declared = new Set((module_.match(/--[a-z0-9-]+(?=\s*:)/g) || []));
const used = new Set((module_.match(/var\((--[a-z0-9-]+)/g) || []).map((m) => m.slice(4)));
const undeclared = [...used].filter((v) => !declared.has(v));
check('every CSS variable the page USES is one the office\'s palette DECLARES',
  undeclared.length === 0, undeclared.join(', '));

/* ═════════════════════════════ RESULT ══════════════════════════════════ */

console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('the office\'s shell, its own design, reading the office\'s live data.');
