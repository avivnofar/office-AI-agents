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
  && /automations\?format=json/.test(read('workers/automations-page.js'))
  && /THE WRITE DID NOT TAKE/.test(read('workers/automations-page.js')));

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
  /url\.pathname === '\/admin\/automations'[\s\S]{0,900}'Cache-Control': 'no-store'/.test(triggerCases));

console.log(`\n${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);
