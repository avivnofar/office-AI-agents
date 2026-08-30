#!/usr/bin/env node
/**
 * scripts/verify-pending-render.js — the waiting-on-you tab, RENDERED.
 *
 * Written 2026-08-30 (layer 1 of the owner-channel readability plan, section ד).
 * Run:  node scripts/verify-pending-render.js
 *
 * ── WHY THIS FILE EXISTS ALONGSIDE verify-office-site.js ─────────────────
 *
 * That file reads the generated bundle as TEXT and asserts the right
 * expressions are in it. It is a good check and it cannot answer the question
 * the owner actually asked, which is *what does the card look like when a
 * blocked item is open*. A string assertion cannot see a control that is
 * rendered but never wired, a panel that opens empty, or a Hebrew label sitting
 * above a value that was quietly reworded.
 *
 * So this file RUNS the real admin bundle. Not a copy of it, not a description
 * of it — `renderOfficeSite({ mode: 'admin' })`'s own script, executed in a
 * `node:vm` context against a ~150-line DOM shim, with `fetch` answered by the
 * REAL server functions: `parseBoard()` from office-context.js,
 * `buildPendingItems()` from site-data.js, `buildItemDetail()` from
 * item-detail.js. The only fiction in this file is the markdown at the top and
 * the DOM underneath; every transformation between them is production code.
 *
 * ── WHAT IT PROVES ───────────────────────────────────────────────────────
 *
 * Two cases, and the second matters more than the first:
 *
 *   * `OB-003` names `OB-001` as its blocker and `OB-001` is in the file. The
 *     card must show that entry INLINE — heading, state, and the office's own
 *     text — after one click and with no navigation.
 *   * `OB-014` names `OB-900`, which is in no file. The card must SAY SO, in
 *     the server's own sentence naming where it looked. A blocker that is named
 *     and missing rendering as nothing reads exactly like "nothing blocks
 *     this", and that confusion is the whole reason the endpoint reports its
 *     failed lookups.
 *
 * And the boundary: every value in the rendered DOM that came out of the board
 * is asserted to appear CHARACTER FOR CHARACTER, in English, under its Hebrew
 * label. `item-detail.js`'s rule — a fluent paraphrase reads exactly like
 * evidence — is a claim about pixels, so it is checked against pixels.
 *
 * NETWORK: zero calls. `fetch` inside the vm is a local function and there is
 * no other one in scope.
 */

import vm from 'node:vm';

import { renderOfficeSite, officeChrome } from '../workers/office-site-page.js';
import { parseBoard } from '../workers/office-context.js';
import { buildPendingItems } from '../workers/site-data.js';
import { parseItemRef, buildItemDetail } from '../workers/item-detail.js';

let pass = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`[PASS] ${name}`); }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* ═══════════════════════ 1. THE FIXTURE BOARD ═══════════════════════════ */

/**
 * Shaped exactly like `campus/shared/board/BOARD.md`, including the two things
 * that have caught this code before: tasks grouped under `## Agent N` sections
 * (so an entry's slice must stop at a `##`, not only at the next `###`), and a
 * finished task carried in the struck-through heading form the board parser
 * skips.
 */
const BOARD = `# The board

## Agent 5 — The IT Chief

### OB-003 — Permission-flow analysis: trace every write path end to end
- **Assignee:** Agent 5
- **State:** BLOCKED
- **Blocked by:** OB-001. Flow analysis before the call audit repeats the call audit inside it and produces two documents that can disagree.
- **Source:** standup 2026-08-14
- **Task:** Walk every call site that can write to a repo and record which token authorises it.
- **Notes:** Raised again 2026-08-20; still not started.

### OB-014 — Retire the second scheduler
- **Assignee:** Agent 5
- **State:** BLOCKED
- **Blocked by:** OB-900, which nobody has written down yet.
- **Task:** Delete workers/scheduler.js once nothing imports it.

## Agent 6 — The QA

### ~~OB-001 — Audit every model call site~~ — DONE
- **Assignee:** Agent 6
- **State:** DONE
- **Task:** List every provider call in the estate and the budget it draws from.
- **Notes:** Closed 2026-08-12. Thirty-one call sites, four providers, one unbudgeted path.

### OB-021 — Decide the retention window for provider_usage
- **Assignee:** Agent 6
- **State:** NOT-READY
- **Blocked by:** an owner decision. The standup did not settle this.
- **Task:** Pick a retention window and write it into the table's own header.
`;

const board = parseBoard(BOARD);
check('the fixture parses as a real board', board.ok && board.tasks.length >= 3,
  board.ok ? `${board.tasks.length} tasks` : board.reason);

const snapshot = { board, questions: { questions: [] }, submissions: { submissions: [] } };
const pendingItems = buildPendingItems(snapshot);
check('buildPendingItems() picks up the blocked and not-ready tasks',
  pendingItems.length === 3, pendingItems.map((i) => i.id).join(', '));

/* ═══════════════════ 2. THE SERVER, FOR THE ITEM ROUTE ══════════════════ */

/** What `/api/admin/item` would answer, built by the real builder. */
function itemResponse(id) {
  const ref = parseItemRef(id);
  if (!ref.ok) return { ok: false, reason: ref.reason };
  return buildItemDetail({
    ref,
    card: pendingItems.find((i) => i.id === ref.id) || null,
    files: { board: BOARD, question: null, submission: null },
    origin: { ok: false, precision: 'none', probes: 0, reason: 'git was not consulted in this harness' },
    lookups: [{ what: 'read campus/shared/board/BOARD.md', ok: true, reason: null, bytes: BOARD.length }],
  });
}

/* ═════════════════════════ 3. THE DOM SHIM ══════════════════════════════ */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this.disabled = false;
    this._text = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn.call(this, {})); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this._text !== null && !this.children.length) return this._text;
    return (this._text || '') + this.children.map((c) => c.textContent).join('');
  }
  /** Everything visible, with a separator, so an assertion can look for a
   *  label and a value without depending on where the line breaks fall. */
  render(depth = 0) {
    const own = this._text !== null && !this.children.length ? this._text : '';
    const pad = '  '.repeat(depth);
    const dir = this.attrs.dir ? ` dir=${this.attrs.dir}` : '';
    const cls = this.attrs.class ? `.${this.attrs.class.split(' ').join('.')}` : '';
    const head = `${pad}<${this.tagName.toLowerCase()}${cls}${dir}${this.hidden ? ' HIDDEN' : ''}>${own}`;
    return [head].concat(this.children.map((c) => c.render(depth + 1))).join('\n');
  }
  find(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach((c) => c.find(pred, out));
    return out;
  }
}

const ROOT_IDS = [
  'load-status', 'pending-groups', 'pending-tab-count', 'office-body', 'agent-grid',
  'agent-count-note', 'gaps-list', 'gaps-errors', 'office-data-body', 'generated-at',
  'data-source', 'spec-frame',
];
const byId = {};
for (const id of ROOT_IDS) { const e = new El('div'); e.setAttribute('id', id); byId[id] = e; }

const tabButtons = ['pending', 'office', 'agents', 'spec', 'office-data', 'gaps'].map((t) => {
  const b = new El('button');
  b.setAttribute('class', 'tab-btn');
  b.setAttribute('data-tab', t);
  return b;
});
const tabPanels = tabButtons.map((b) => {
  const p = new El('section');
  p.setAttribute('class', 'tab-panel');
  p.setAttribute('data-tab', b.getAttribute('data-tab'));
  return p;
});

const documentShim = {
  readyState: 'complete',
  createElement: (t) => new El(t),
  getElementById: (id) => byId[id] || null,
  addEventListener: () => {},
  querySelectorAll: (sel) => {
    if (sel === '.tab-btn') return tabButtons;
    if (sel === '.tab-panel') return tabPanels;
    return [];
  },
  querySelector: (sel) => {
    const m = /^\.tab-btn\[data-tab="(.+)"\]$/.exec(sel);
    if (m) return tabButtons.find((b) => b.getAttribute('data-tab') === m[1]) || null;
    return null;
  },
};

/* Every fetch this harness answers, recorded — so "the page called the aliased
 * route" is a fact about what ran, not a fact about what the source says. */
const calls = [];
function fetchShim(url, opts) {
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  const u = String(url);
  if (u === '/admin/api/data') {
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        generated_at: '2026-08-30T09:00:00Z',
        counts: {}, agents: [], mechanisms: [], notes: [], data_gaps: [], errors: [],
        office: { text: null }, automation: null,
        pending_items: pendingItems,
      }),
    });
  }
  const item = /^\/admin\/api\/item\?id=(.+)$/.exec(u);
  if (item) {
    const body = itemResponse(decodeURIComponent(item[1]));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, reason: 'no such route in this harness' }) });
}

/* ═════════════════════ 4. RUN THE REAL BUNDLE ═══════════════════════════ */

const html = renderOfficeSite({ mode: 'admin' });
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</' + 'script>'));

const sandbox = {
  document: documentShim,
  fetch: fetchShim,
  sessionStorage: { getItem: () => 'a-token', setItem: () => {} },
  location: { hash: '#pending' },
  history: { replaceState: () => {} },
  console,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'office-site-admin-bundle.js' });

/** The bundle is promise-driven; drain the microtask queue between steps. */
const settle = () => new Promise((r) => setImmediate(r));

const HE = officeChrome('admin');

async function main() {
  await settle(); await settle();

  const host = byId['pending-groups'];
  check('the pending list rendered', host.children.length > 0,
    `${host.children.length} groups`);
  check('the group headings are the Hebrew chrome',
    host.render().includes(HE.group_blocked) && host.render().includes(HE.group_decision),
    'expected the translated group labels');

  const cards = host.find((n) => (n.attrs.class || '').startsWith('pending-item'));
  check('three cards rendered, one per pending task', cards.length === 3, `${cards.length}`);

  /* ── CASE 1: a blocker that resolves ─────────────────────────────────── */
  const ob003 = cards[0];
  const open003 = ob003.find((n) => (n.attrs.class || '').includes('blocker-open'))[0];
  check('OB-003 has an inline blocker control', !!open003);
  check('and it is collapsed before anything is clicked',
    ob003.find((n) => (n.attrs.class || '').includes('blocker-detail'))[0].hidden === true);
  check('its label is the Hebrew chrome', open003 && open003.textContent === HE.blocker_open,
    open003 && open003.textContent);

  open003.click();
  await settle(); await settle();

  const panel003 = ob003.find((n) => (n.attrs.class || '').includes('blocker-detail'))[0];
  const dom003 = panel003.render();
  check('one click opens it in place', panel003.hidden === false);
  check('the button now offers to close it, not to navigate',
    open003.textContent === HE.blocker_close);
  check('the request went through the /admin/api/ alias map',
    calls.some((c) => c.url === '/admin/api/item?id=board-ob-003'),
    calls.map((c) => c.url).join(' | '));

  /* THE BLOCKING ENTRY, IN THE DOM. Each of these is a character sequence the
   * office wrote into BOARD.md, asserted to be in the rendered card. */
  check('the blocker is named by its identifier', dom003.includes('OB-001'));
  check('its title is the office\'s, verbatim',
    dom003.includes('Audit every model call site'));
  check('its state is shown', dom003.includes('DONE'));
  check('its ENTRY is in the card, verbatim and in English',
    dom003.includes('Thirty-one call sites, four providers, one unbudgeted path.'),
    'the office\'s own words must reach the DOM unaltered');
  check('the entry stops at the section heading, not inside the next agent\'s tasks',
    !dom003.includes('OB-021'),
    'slicing on ### alone swallowed the section rule on the first live request');
  check('the struck-through form is labelled, not presented as an ordinary hit',
    dom003.includes(HE.item_blocker_struck));
  check('the board\'s own "Blocked by" line is carried with its identifiers intact',
    dom003.includes('Flow analysis before the call audit repeats the call audit inside it'));
  check('the office\'s verbatim entry is marked left-to-right inside Hebrew chrome',
    panel003.find((n) => (n.attrs.class || '') === 'item-verbatim').length > 0);

  /* ── CASE 2: a blocker that is named and is not there ────────────────── */
  const ob014 = cards[1];
  const open014 = ob014.find((n) => (n.attrs.class || '').includes('blocker-open'))[0];
  check('OB-014 has an inline blocker control too', !!open014);
  open014.click();
  await settle(); await settle();

  const panel014 = ob014.find((n) => (n.attrs.class || '').includes('blocker-detail'))[0];
  const dom014 = panel014.render();
  check('a named-but-missing blocker renders SOMETHING, never an empty panel',
    panel014.children.length > 0 && dom014.trim().length > 40);
  check('it says the blocker was named', dom014.includes('OB-900'));
  check('it says so in the server\'s own sentence, under a Hebrew label',
    dom014.includes(HE.item_blocker_unresolved)
    && dom014.includes('is named as a blocker but has no entry in'),
    'the reason names where it looked; a summary would drop that');
  check('it names the file it searched',
    dom014.includes('campus/shared/board/BOARD.md'));

  /* ── the third card: a blocker line that names no item at all ────────── */
  const ob021 = cards[2];
  const open021 = ob021.find((n) => (n.attrs.class || '').includes('blocker-open'))[0];
  check('a "Blocked by: an owner decision" task gets the control as well', !!open021,
    'the test is the office\'s own text, not the card kind — this one is NOT-READY');
  open021.click();
  await settle(); await settle();
  const dom021 = ob021.find((n) => (n.attrs.class || '').includes('blocker-detail'))[0].render();
  check('it says the board named no item, rather than implying a lookup failed',
    dom021.includes(HE.item_blocker_none_named));
  check('and it still shows what the board DID say',
    dom021.includes('an owner decision. The standup did not settle this.'));

  /* ── the two controls share one read ─────────────────────────────────── */
  const beforeOpen = calls.filter((c) => c.url.startsWith('/admin/api/item')).length;
  ob003.find((n) => (n.attrs.class || '') === 'item-open')[0].click();
  await settle(); await settle();
  const afterOpen = calls.filter((c) => c.url.startsWith('/admin/api/item')).length;
  check('opening the whole item after the blocker costs NO second request',
    afterOpen === beforeOpen, `${beforeOpen} -> ${afterOpen}`);
  const full = ob003.find((n) => (n.attrs.class || '') === 'item-detail')[0].render();
  check('the full expansion carries the item\'s own entry, verbatim',
    full.includes('Walk every call site that can write to a repo'));
  check('and renders the blocker through the SAME section renderer',
    full.includes(HE.item_h_blocker) && full.includes('Thirty-one call sites'));

  /* ── the boundary, stated as a whole-DOM property ─────────────────────── */
  const wholeDom = host.render();
  const OFFICE_WORDS = [
    'Permission-flow analysis: trace every write path end to end',
    'Audit every model call site',
    'Thirty-one call sites, four providers, one unbudgeted path.',
    'Walk every call site that can write to a repo',
    'Retire the second scheduler',
  ];
  check('every office-written string in the fixture survives into the DOM unchanged',
    OFFICE_WORDS.every((w) => wholeDom.includes(w)),
    OFFICE_WORDS.filter((w) => !wholeDom.includes(w)).join(' | '));
  check('the chrome around them is Hebrew',
    /[֐-׿]/.test(wholeDom));
  check('no request left the aliased admin prefix',
    calls.every((c) => c.url.startsWith('/admin/api/')),
    calls.map((c) => c.url).join(' | '));

  /* ── the artefact the session report quotes ───────────────────────────── */
  if (process.argv.includes('--print')) {
    console.log('\n───────── OB-003, blocker panel, as rendered ─────────');
    console.log(panel003.render());
    console.log('\n───────── OB-014, blocker named and not found ─────────');
    console.log(panel014.render());
  }

  console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
  if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
  console.log('the card answers "what is blocking this" in place, in the office\'s own words.');
}

main().catch((err) => { console.error(err); process.exit(1); });
