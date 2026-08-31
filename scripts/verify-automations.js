/**
 * verify-automations.js — the automations panel (session 40, Item C).
 *
 * Runs with `node scripts/verify-automations.js`. No D1, no network, no clock:
 * `buildAutomationsView()` takes every input, which is why the MISSED case can
 * be asserted at all — it is a statement about a time, and a function that read
 * its own clock could only be tested at 14:00.
 *
 * The checks marked [FAILS-OLD] are the ones that fail against the state of
 * this repo before this session: there was no panel, `repo_writes` had no
 * `author`, and the comparison this page makes was made by a person by eye.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, note) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.log(`FAIL  ${name}${note ? ` — ${note}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

const panel = await import('../workers/automations-panel.js');
const page = await import('../workers/automations-page.js');

/* A schedule with three blocks, so "due and missing", "due and present" and
 * "not yet due" are all exercised in one view. */
const SCHEDULE = {
  full_day_schedule: {
    applies_to_day_of_week: [1, 2, 3, 4, 5],
    blocks: [
      { time: '08:30', type: 'architect_liaison', label: 'Architect liaison: file last night’s run. Moved off the 08:00 tick on 2026-08-16.' },
      { time: '10:00', type: 'admin_desk', label: 'The admin desk.' },
      { time: '14:00', type: 'owner_channel', label: 'Read the owner channel.' },
      { time: '16:00', type: 'report', label: 'The daily report.' },
    ],
  },
  saturday_schedule: { applies_to_day_of_week: [7], label: 'REST DAY', blocks: [{ time: '08:00', type: 'spare_time', label: 'Idle.' }] },
};

const ADMISSIONS = [
  { block: 'architect_liaison', at: '08:30', decision: 'run', estimate: 4, actual: 2, created_at: '2026-08-30 05:30:58' },
  { block: 'owner_channel', at: '14:00', decision: 'run', estimate: 42, actual: 0, created_at: '2026-08-30 11:00:13' },
];
const WRITES = [
  { author: 'block:owner_channel', n: 2, last_at: '2026-08-30 11:00:11' },
  { author: 'agent:12', n: 1, last_at: '2026-08-30 07:41:53' },
];

section('§1 the join — what should have run, and did not');

const view = panel.buildAutomationsView({
  scheduleConfig: SCHEDULE, dayOfWeek: 1, israelTime: '14:30',
  admissions: ADMISSIONS, writes: WRITES,
});
const row = (t) => view.rows.find((r) => r.time === t);

check('[FAILS-OLD] a block that was DUE and has NO admission row is MISSED — the comparison the owner has been making by eye',
  row('10:00').state.startsWith('MISSED') && row('10:00').missed === true);
check('a block whose time has not come is NOT YET DUE and is never counted as missed',
  row('16:00').state === 'NOT YET DUE' && row('16:00').missed === false
  && view.missedCount === 1);
check('a block that ran says so, with the row that proves it',
  row('08:30').state === 'RAN' && row('08:30').ranAt === '2026-08-30 05:30:58'
  && row('08:30').estimate === 4 && row('08:30').actual === 2);
check('ADMITTED-AND-DID-NOTHING is its own state, not folded into success',
  row('14:00').state === 'RAN, PRODUCED NOTHING');
check('a DEFERRED block and an OVERSIZE block each say which one they were',
  panel.buildAutomationsView({
    scheduleConfig: SCHEDULE, dayOfWeek: 1, israelTime: '14:30',
    admissions: [{ block: 'admin_desk', at: '10:00', decision: 'defer', estimate: 32, actual: 0, created_at: 'x' }],
  }).rows.find((r) => r.time === '10:00').state.startsWith('DEFERRED')
  && panel.buildAutomationsView({
    scheduleConfig: SCHEDULE, dayOfWeek: 1, israelTime: '14:30',
    admissions: [{ block: 'admin_desk', at: '10:00', decision: 'oversize', estimate: 120, actual: 48, created_at: 'x' }],
  }).rows.find((r) => r.time === '10:00').state.startsWith('OVERSIZE'));

check('AN UNREADABLE ADMISSION RECORD IS NOT AN EMPTY DAY — nothing reads as MISSED and the count is zero',
  (() => {
    const v = panel.buildAutomationsView({
      scheduleConfig: SCHEDULE, dayOfWeek: 1, israelTime: '23:59', admissions: [], admissionsRead: false,
    });
    return v.missedCount === 0 && v.rows.every((r) => r.state.startsWith('UNKNOWN'));
  })(),
  'a D1 blip would otherwise report a total outage that never happened');

section('§2 what each block produced — the Item B join');

check('[FAILS-OLD] a block’s output is counted from repo_writes.author, which did not exist before this session',
  /2 files \(last 2026-08-30 11:00:11\)/.test(row('14:00').produced));
check('a block with a known author prefix and no rows says "nothing attributed to it today"',
  row('08:30').produced === 'attribution not wired for this block type'
  || /nothing attributed/.test(row('08:30').produced));
check('AGENT-ATTRIBUTED blocks are named as such — a block-prefix count would find zero and read as "produced nothing"',
  panel.BLOCK_AUTHOR_PREFIX.repair === panel.AGENT_ATTRIBUTED
  && /agent:<N>/.test(panel.buildAutomationsView({
    scheduleConfig: { full_day_schedule: { applies_to_day_of_week: [1], blocks: [{ time: '11:30', type: 'repair', label: '' }] } },
    dayOfWeek: 1, israelTime: '12:00', admissions: [], writes: WRITES,
  }).rows[0].produced));
check('a block type with no mapping is reported as UNWIRED, never as zero — a wrong join looks exactly like a broken automation',
  panel.buildAutomationsView({
    scheduleConfig: { full_day_schedule: { applies_to_day_of_week: [1], blocks: [{ time: '09:00', type: 'no_such_block', label: '' }] } },
    dayOfWeek: 1, israelTime: '12:00',
  }).rows[0].produced === 'attribution not wired for this block type');

section('§3 the switches — C6, C7, C8');

const triggerCases = read('workers/agent-runner.js');
for (const s of panel.SWITCHES) {
  if (!s.trigger) continue;
  check(`C6 — "${s.trigger}" is a trigger case that ALREADY EXISTS; no switch is invented`,
    new RegExp(`case '${s.trigger}':`).test(triggerCases));
}
check('C8 — the RETIRED capabilities carry a date and are offered NO control',
  panel.SWITCHES.filter((s) => s.retired).map((s) => s.key).sort().join(',') === 'cases_enabled,guides_enabled'
  && panel.SWITCHES.filter((s) => s.retired).every((s) => s.trigger === null && /20\d\d-\d\d-\d\d/.test(s.retired)));
check('C8 — the retired rows render as text, never as a button',
  (() => {
    const html = page.renderAutomationsPage({
      stylesheet: '', view, actions: { ok: true, workflows: [] },
      switches: panel.SWITCHES.map((s) => ({ ...s, retired: s.retired || null, value: false })),
      today: '2026-08-30', versionId: 'v',
    });
    const seg = html.slice(html.indexOf('cases_enabled'), html.indexOf('cases_enabled') + 600);
    return /retired — no control offered/.test(seg) && !/data-trigger="cases_toggle"/.test(html);
  })());
check('[FAILS-OLD] an IMMEDIATE mismatch is NOT YET VISIBLE, not a failure — KV is eventually consistent and this fired on a write that had taken',
  /NOT YET VISIBLE/.test(read('workers/automations-page.js'))
  && /eventually consistent/.test(read('workers/automations-page.js'))
  && /setTimeout\(/.test(read('workers/automations-page.js')));
check('...and only the SECOND read is allowed to say the write did not take',
  (() => {
    // Executable body only: the header above the fix QUOTES the sentence it
    // replaced, so a whole-file ordering test trips on the documentation of
    // the very change it is checking — the same scoping verify-office-
    // bureaucracy.js applies to repo-write.js's old Bearer line.
    const body = read('workers/automations-page.js')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return body.indexOf('NOT YET VISIBLE') < body.indexOf('THE WRITE DID NOT TAKE');
  })());
check('C7 — the toggle READS THE LIVE VALUE BACK rather than trusting the write’s own 200',
  /read-back/i.test(read('workers/automations-page.js'))
  // The read-back target is now the alias map's own resolved URL rather than a
  // literal path, so this asserts the SHAPE (a fresh GET of the read-back
  // endpoint) instead of a string the page no longer contains.
  && /readBackUrl\}\?format=json/.test(read('workers/automations-page.js'))
  && /THE WRITE DID NOT TAKE/.test(read('workers/automations-page.js')));

check('the page builds its two fetch targets from adminApiUrl(), not from a literal — KFM-12 deadexport',
  /triggerUrl: adminApiUrl\('trigger'\)/.test(triggerCases)
  && /readBackUrl: adminApiUrl\('automations'\)/.test(triggerCases)
  && !/\$\{apiBase\}/.test(read('workers/automations-page.js')));

section('§4 the Actions half — C3');

const refused = page.renderAutomationsPage({
  stylesheet: '', view, switches: [], today: '2026-08-30', versionId: 'v',
  actions: { ok: false, reason: 'the GitHub Actions API answered 403 — the token is present and cannot read Actions (scope).', workflows: [] },
});
check('C3 — a REFUSED read says the token could not read it; it never renders as "no workflows"',
  /NOT READ —/.test(refused) && /cannot read Actions/.test(refused));
check('C3 — an EMPTY list says it is an empty list, which is a different fact',
  /empty list, not a refused read/.test(page.renderAutomationsPage({
    stylesheet: '', view, switches: [], today: '2026-08-30', versionId: 'v',
    actions: { ok: true, reason: null, workflows: [] },
  })));
check('C3 — the declared cron is NOT invented: the page says where it lives instead',
  /this Worker does not parse YAML/.test(refused));
check('[FAILS-OLD] a DISABLED workflow is SHOWN, not filtered out — three of the eight in this repo are disabled_manually',
  (() => {
    const html = page.renderAutomationsPage({
      stylesheet: '', view, switches: [], today: '2026-08-30', versionId: 'v',
      actions: { ok: true, reason: null, workflows: [
        { name: 'Owner email notice', path: '.github/workflows/owner-email.yml', state: 'active', lastRunAt: '2026-08-29T16:50:44Z', conclusion: 'success', event: 'schedule' },
        { name: 'Archive architect', path: '.github/workflows/archive-architect.yml', state: 'disabled_manually', lastRunAt: null, conclusion: 'DISABLED (disabled_manually)', event: null },
      ] },
    });
    return /archive-architect\.yml/.test(html) && /DISABLED \(disabled_manually\)/.test(html);
  })(),
  'a workflow the owner believes is running and GitHub has disabled is exactly what this panel is for');

section('§5 the stylesheet — C4');

const pageSrc = read('workers/automations-page.js');
const panelSrc = read('workers/automations-panel.js');
/*
 * Scoped to the EXECUTABLE BODY, the same way verify-office-bureaucracy.js
 * scopes its `Bearer ${env.GITHUB_TOKEN}` test: both files' headers describe
 * the rule in prose, and a whole-file regex would trip on the documentation of
 * the very thing it is checking.
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('C4 — NEITHER module declares a custom property; the office palette is imported, not extended',
  !/--[a-z-]+\s*:/.test(stripComments(pageSrc)) && !/--[a-z-]+\s*:/.test(stripComments(panelSrc)),
  'a prior session invented variable names that fell through to browser defaults and painted white tiles on a dark page');
check('...and the check is scoped to the body, so it still trips on a real declaration',
  /--bg\s*:/.test(stripComments('const x = `.a { --bg: #fff; }`;')));
check('C4 — every class the page uses is one the office stylesheet already defines',
  (() => {
    const css = read('workers/office-site-page.js');
    const used = [...pageSrc.matchAll(/class="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    const missing = [...new Set(used)].filter((c) => !css.includes(`.${c}`));
    if (missing.length) console.log(`      missing: ${missing.join(', ')}`);
    return missing.length === 0;
  })());
check('the stylesheet is passed IN, so the page cannot quietly grow its own copy',
  /stylesheet, view, actions, switches/.test(pageSrc) && !/OFFICE_CSS/.test(pageSrc));

section('§6 the route and the gate');

const gate = read('workers/admin-gate.js');
check('the new endpoints are EXPLICIT MAP KEYS — no pattern, no prefix rewrite, no traversal surface',
  /\['automations', '\/api\/admin\/automations'\]/.test(gate) && /\['trigger', '\/api\/agents\/trigger'\]/.test(gate));
check('the page lives under /admin/, so the existing gate covers it and no new door is cut',
  /url\.pathname === '\/admin\/automations'/.test(triggerCases));
check('the page and the JSON endpoint call ONE gatherer — the toggle’s read-back cannot see a different query',
  (triggerCases.match(/await gatherAutomations\(env\)/g) || []).length === 2);
check('the panel is never cached — a cached answer to "did the 14:00 block run" is the failure it exists to remove',
  /url\.pathname === '\/admin\/automations'[\s\S]{0,1400}'Cache-Control': 'no-store'/.test(triggerCases));

section('§7 the Actions half is WRITABLE — 2026-08-31');

/*
 * The write path is exercised WITHOUT A NETWORK. `globalThis.fetch` is replaced
 * with a scripted stub for the length of each case and restored after, so every
 * one of Part 3's four failure shapes is asserted as a real call through
 * `setWorkflowEnabled()` rather than as a regex over its source. The tripwire
 * idiom is the estate's own (verify-providers.js, verify-routing.js); here the
 * stub IS the tripwire — an unexpected URL throws.
 */
const realFetch = globalThis.fetch;
async function withFetch(script, fn) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || 'GET' });
    const step = script.shift();
    if (!step) throw new Error(`unscripted fetch to ${url}`);
    if (step === 'throw') throw new Error('socket hung up');
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body,
    };
  };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = realFetch; }
}
const ENV = { GITHUB_TOKEN: 'stub' };
const CALL = { owner: 'avivnofar', repo: 'office-AI-agents', id: '12345' };

check('the id is DIGITS ONLY, checked before it is a URL — a workflow FILE NAME is refused, which GitHub itself would accept',
  panel.parseWorkflowRef('12345').ok
  && !panel.parseWorkflowRef('owner-email.yml').ok
  && !panel.parseWorkflowRef('../../secrets').ok
  && !panel.parseWorkflowRef('').ok);

check('[FAILS-OLD] a real enable call PUTs the enable endpoint and then RE-READS the live state — two calls, not one',
  await (async () => {
    const { result, seen } = await withFetch(
      [{ status: 204 }, { status: 200, body: { state: 'active' } }],
      () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: true }),
    );
    return result.ok && result.code === 'confirmed' && result.state === 'active'
      && seen.length === 2
      && seen[0].method === 'PUT' && /\/actions\/workflows\/12345\/enable$/.test(seen[0].url)
      && seen[1].method === 'GET' && /\/actions\/workflows\/12345$/.test(seen[1].url);
  })());

check('PART 3 — 403 says the TOKEN CANNOT DO THIS (scope), and says it is not the same as the call being wrong',
  await (async () => {
    const { result } = await withFetch([{ status: 403 }], () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: false }));
    return result.code === 'forbidden' && /scope/.test(result.message) && /NOT the same as/.test(result.message);
  })());

check('PART 3 — 404 says NO SUCH WORKFLOW, and says it is not a refusal',
  await (async () => {
    const { result } = await withFetch([{ status: 404 }], () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: false }));
    return result.code === 'not_found' && /NOT a refusal/.test(result.message);
  })());

check('PART 3 — no response at all is UNKNOWN, never "failed": the call may have landed',
  await (async () => {
    const { result } = await withFetch(['throw'], () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: true }));
    return result.code === 'unreachable' && /UNKNOWN, not failed/.test(result.message);
  })());

check('PART 3 — the one that is easiest to paper over: 204 ACCEPTED and the follow-up read still shows the OLD state',
  await (async () => {
    const { result } = await withFetch(
      [{ status: 204 }, { status: 200, body: { state: 'disabled_manually' } }],
      () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: true }),
    );
    return result.ok === false && result.code === 'unchanged'
      && /SUCCEEDED/.test(result.message) && /DID NOT MOVE/.test(result.message);
  })(),
  'the write answered success, so folding this into "it worked" is the failure this endpoint is built to refuse');

check('...and a 204 whose follow-up read ITSELF fails is `unverified` — the write is known and the result is not',
  await (async () => {
    const { result } = await withFetch([{ status: 204 }, { status: 500 }], () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: false }));
    return result.code === 'unverified' && /WRITE is known and the RESULT is not/.test(result.message);
  })());

check('DISABLING SOMETHING ALREADY DISABLED IS A SUCCESS — which is what makes the permission probe possible with no live effect',
  await (async () => {
    const { result } = await withFetch(
      [{ status: 204 }, { status: 200, body: { state: 'disabled_manually' } }],
      () => panel.setWorkflowEnabled(ENV, { ...CALL, enable: false }),
    );
    return result.ok && result.state === 'disabled_manually';
  })());

check('no GITHUB_TOKEN attempts NOTHING — it does not reach the network to find out',
  await (async () => {
    const { result, seen } = await withFetch([], () => panel.setWorkflowEnabled({}, { ...CALL, enable: true }));
    return result.code === 'no_token' && seen.length === 0;
  })());
check('a missing direction is a 400-shaped refusal, never a guess about which way to flip something',
  (await panel.setWorkflowEnabled(ENV, { ...CALL })).code === 'bad_direction');

check('THE SWITCHES IDIOM IS HELD: an unwritable row gets NO control at all, not a greyed-out one, and says why',
  (() => {
    const off = panel.workflowControl({ state: 'active' }, { writable: false, repo: 'back-office-AI-agents', writeRepo: 'office-AI-agents' });
    return off.action === null && /back-office-AI-agents/.test(off.why) && /different credential/.test(off.why);
  })());
check('active -> disable, disabled_manually -> enable, and NOTHING for a state this panel does not model',
  panel.workflowControl({ state: 'active' }, { writable: true }).action === 'disable'
  && panel.workflowControl({ state: 'disabled_manually' }, { writable: true }).action === 'enable'
  && panel.workflowControl({ state: 'disabled_inactivity' }, { writable: true }).action === null
  && /went quiet/.test(panel.workflowControl({ state: 'disabled_inactivity' }, { writable: true }).why)
  && panel.workflowControl({ state: 'something_new' }, { writable: true }).action === null);

const WF = [
  { id: 111, name: 'Owner email notice', path: '.github/workflows/owner-email.yml', state: 'active', lastRunAt: '2026-08-30T16:55:13Z', conclusion: 'success', event: 'schedule' },
  { id: 222, name: 'Archive Architect', path: '.github/workflows/archive-architect.yml', state: 'disabled_manually', lastRunAt: null, conclusion: 'DISABLED (disabled_manually)', event: null },
];
const renderActions = (repo, writableRepo) => page.renderAutomationsPage({
  stylesheet: '', view, switches: [], today: '2026-08-30', versionId: 'v',
  workflowUrl: '/admin/api/workflow', writableRepo,
  actions: { ok: true, reason: null, owner: 'avivnofar', repo, workflows: WF },
});

check('[FAILS-OLD] the page renders an ENABLE control on the disabled row and a DISABLE control on the active one',
  (() => {
    const html = renderActions('office-AI-agents', 'office-AI-agents');
    return /data-workflow="111" data-enable="false" data-name="Owner email notice">disable</.test(html)
      && /data-workflow="222" data-enable="true" data-name="Archive Architect">enable</.test(html);
  })());
check('PART 4 — a row in a repo this token cannot write to carries NO button, and the reason instead',
  (() => {
    const html = renderActions('back-office-AI-agents', 'office-AI-agents');
    return !/data-workflow=/.test(html) && /not writable from here/.test(html);
  })());
check('the page calls the workflow endpoint through the alias map, never a literal /api path',
  (() => {
    const html = renderActions('office-AI-agents', 'office-AI-agents');
    return /fetch\('\/admin\/api\/workflow\?id='/.test(html)
      && /workflowUrl: adminApiUrl\('workflow'\)/.test(triggerCases);
  })());
check('the control column did not break the two colspans that describe a refused or empty read',
  (() => {
    const empty = page.renderAutomationsPage({
      stylesheet: '', view, switches: [], today: '2026-08-30', versionId: 'v',
      actions: { ok: true, reason: null, repo: 'office-AI-agents', workflows: [] },
      workflowUrl: '/admin/api/workflow', writableRepo: 'office-AI-agents',
    });
    return /colspan="6"[^>]*>The API answered and listed no active workflow/.test(empty)
      && !/colspan="5"/.test(empty);
  })());
check('the page REPAINTS FROM THE STATE THE SERVER READ BACK, never from the direction the button asked for',
  /the state shown is the one the SERVER read back from GitHub/i.test(pageSrc)
  && /cell\.textContent = data\.state === 'active'/.test(pageSrc));

check('the write route is an EXPLICIT MAP KEY like every other, and the direction is not in the query string',
  /\['workflow', '\/api\/admin\/workflow'\]/.test(gate)
  && /id=<digits>/.test(gate));
check('the endpoint is POST and lives inside the AUTHENTICATED_PREFIXES block — surface: \'api\', so the page cookie is refused',
  /request\.method === 'POST' && url\.pathname === '\/api\/admin\/workflow'/.test(triggerCases)
  && triggerCases.indexOf("url.pathname === '/api/admin/workflow'")
     > triggerCases.indexOf("const credential = await adminCredential(request, env, { surface: 'api' });"));
check('the HTTP status carries the same distinction the body does — 403, 404, 409 and 504 are four different answers',
  /forbidden: 403/.test(triggerCases) && /not_found: 404/.test(triggerCases)
  && /unchanged: 409/.test(triggerCases) && /unreachable: 504/.test(triggerCases));
check('NOTHING here pushes to a workflow YAML file — that is the `workflow` scope this token does not carry',
  !/\.github\/workflows\/[a-z-]+\.yml/.test(stripComments(panelSrc))
  && /workflow` scope/.test(panelSrc));

console.log(`\n${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);
