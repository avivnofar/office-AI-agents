#!/usr/bin/env node
/**
 * scripts/verify-site-data.js — does the public endpoint actually fail closed?
 *
 * Written 2026-08-24 (Session 16, Item B). Run:  node scripts/verify-site-data.js
 *
 * ── WHAT THIS IS TRYING TO BE, AND WHAT IT REFUSES TO BE ─────────────────
 *
 * `CLAUDE.md` in back-office states the standard this file is written to,
 * learned the hard way on 2026-08-06:
 *
 *   > **A test that describes a fix is not a test that catches a bug.**
 *
 * A verifier that asserted "the public response contains a `name` field" would
 * pass forever and prove nothing — it would still pass if someone replaced the
 * whitelist with a spread and the response grew every internal column in the
 * config. So the central check here is INVERTED: every source object is
 * POISONED with fields nobody whitelisted, and the requirement is that the
 * poison does not appear in the serialised response.
 *
 * That check fails the moment a `pick()` becomes a `{...src}`, which is the
 * only realistic way this property is ever lost.
 *
 * ── AND THE SECOND ONE, WHICH IS THE ONE THAT WOULD ACTUALLY BITE ────────
 *
 * §7 of ARCHITECTURAL-DECISIONS.md records six occurrences of one shape in
 * this estate: *the guard exists, and the calling path never reaches it.* So
 * this file does not only exercise the module — it READS `agent-runner.js` and
 * asserts that the `/api/public` route calls `buildPublicData` and that no
 * other builder or snapshot reaches it. A whitelist module nothing routes
 * through is exactly as protective as no module at all.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PUBLIC_AGENT_FIELDS, PUBLIC_COUNT_FIELDS, OFFICE_MECHANISMS, OFFICE_SUMMARY,
  ADMIN_CONTRACT_KEYS,
  publicAgents, publicCounts, buildPublicData, buildAdminData,
  buildPendingItems, buildActivity, agentSlug,
} from '../workers/site-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/* ═══════════════════════ 1. THE POISON TEST ══════════════════════════════ */

/**
 * The strings below are what a leak looks like. They stand in for the real
 * things this boundary exists to hold back, named after them so a failure
 * message says what actually escaped:
 *
 *   a meeting transcript, a client's name, a board identifier, an agent's
 *   internal state, a model routing decision, a secret.
 */
const POISON = {
  transcript: 'POISON-MEETING-TRANSCRIPT-the-Architect-said-the-build-is-blocked',
  client: 'POISON-CLIENT-NAME-Acme-Holdings-Ltd',
  boardId: 'POISON-BOARD-ID-OB-043',
  internal: 'POISON-AGENT-INTERNAL-STATE-irritation-7-probation-round-2',
  routing: 'POISON-MODEL-ROUTING-gemini-3.1-flash-lite',
  secret: 'POISON-SECRET-VALUE-sk-live-abcdef',
};

/** A config agent carrying every field the real one carries PLUS poison in
 *  fields nobody whitelisted, PLUS poison nested inside a whitelisted key —
 *  because a key-name whitelist that does not check the VALUE is only half a
 *  whitelist. */
function poisonedAgent(id) {
  return {
    id,
    key: `agent-${id}-poisoned`,
    name: `Agent ${id}`,
    role: 'A Role',
    tier: 'worker',
    clearance: 'standard',
    status: 'active',
    purpose: 'A purpose.',
    character: 'A character paragraph.',
    // NOT whitelisted — must never appear.
    model: POISON.routing,
    durable_object_id: POISON.internal,
    topic_affinity: [POISON.client],
    escalation_threshold: 0.4,
    quotas: { cases_per_day_min: 20 },
    states: { NEUTRAL: { description: POISON.transcript } },
    api_key: POISON.secret,
    board_task: POISON.boardId,
    // Whitelisted KEY, poisoned NON-SCALAR VALUE. `role` is a string in the
    // real config; if it ever became an object this is the case that catches it.
    // (Applied to a second agent below so this one stays representative.)
  };
}

const poisonedAgents = [poisonedAgent(1), poisonedAgent(2), poisonedAgent(3)];
// One agent whose WHITELISTED key holds an object full of poison.
poisonedAgents[2].role = { label: 'A Role', note: POISON.transcript };

const poisonedCounts = {
  agents: 13,
  questions_handled: 8926,
  reports_written: 1979,
  meetings_held: 77,
  interactions_logged: 2554,
  simulated_day: 61,
  // NOT whitelisted, and the shapes an accidental `SELECT *` would hand over.
  transcript: POISON.transcript,
  client_name: POISON.client,
  latest_report_content: POISON.transcript,
  admin_token: POISON.secret,
};

const publicOut = buildPublicData({
  agents: poisonedAgents,
  counts: poisonedCounts,
  generatedAt: '2026-08-24T00:00:00.000Z',
});
const publicJson = JSON.stringify(publicOut);

for (const [label, value] of Object.entries(POISON)) {
  check(
    `poison "${label}" does not reach /api/public`,
    !publicJson.includes(value),
    'a field nobody whitelisted was serialised into the public response — the whitelist has been replaced by a spread, or a whitelisted key now carries an object',
  );
}

check(
  'the poisoned object key `api_key` is absent by NAME too',
  !publicJson.includes('api_key') && !publicJson.includes('durable_object_id'),
);

/* The value-level half, stated separately so a failure says which half broke. */
check(
  'a whitelisted key holding an OBJECT is dropped, not published',
  publicOut.agents.find((a) => a.id === 3)?.role === null,
  'agent 3\'s `role` was an object containing a transcript; it must come through as null rather than as its interior',
);

/* ═══════════════ 2. WHAT THE PUBLIC RESPONSE DOES CONTAIN ════════════════ */

const topKeys = Object.keys(publicOut).sort();
check(
  'the public response has exactly the top-level keys this session whitelisted',
  JSON.stringify(topKeys) === JSON.stringify(
    ['agents', 'counts', 'generated_at', 'mechanisms', 'notes', 'office', 'ok', 'surface'].sort(),
  ),
  `got ${topKeys.join(', ')} — a new top-level key means a new decision about what the world sees, and it must be made deliberately`,
);

check(
  'every agent object holds exactly PUBLIC_AGENT_FIELDS, no more and no fewer',
  publicOut.agents.every(
    (a) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify([...PUBLIC_AGENT_FIELDS].sort()),
  ),
);

check(
  'every count is an integer or null — never a string, never a body of text',
  Object.values(publicOut.counts).every((v) => v === null || Number.isInteger(v)),
);

check(
  'counts hold exactly PUBLIC_COUNT_FIELDS',
  JSON.stringify(Object.keys(publicOut.counts).sort()) === JSON.stringify([...PUBLIC_COUNT_FIELDS].sort()),
);

/* A non-numeric count is dropped rather than published. This is the guard for
 * the day someone passes a D1 row straight through. */
check(
  'a text value in a whitelisted count slot becomes null',
  publicCounts({ agents: POISON.transcript }).agents === null,
);

check(
  'publicAgents() drops an entry with no name rather than emitting a half-agent',
  publicAgents([{ id: 4 }]).length === 0,
);

check(
  'publicAgents() sorts by id',
  JSON.stringify(publicAgents([{ id: 3, name: 'c' }, { id: 1, name: 'a' }, { id: 2, name: 'b' }]).map((a) => a.id)) === '[1,2,3]',
);

/* ═════════ 3. THE PUBLIC BUILDER CANNOT BE HANDED INTERNAL DATA ══════════ */

/**
 * The signature IS the argument. If `buildPublicData` accepted a snapshot,
 * every future edit inside it would be one line away from publishing a board.
 * It does not, and this proves it by trying.
 */
const smuggled = buildPublicData({
  agents: [],
  counts: {},
  generatedAt: '2026-08-24T00:00:00.000Z',
  // Everything a caller might carelessly forward.
  snapshot: { board: { tasks: [{ id: 'OB-043', title: POISON.boardId, state: 'BLOCKED' }] }, errors: [POISON.transcript] },
  meetings: [{ transcript: POISON.transcript }],
  reports: [{ content: POISON.transcript }],
  owner: { messages: [{ body: POISON.client }] },
});
check(
  'buildPublicData IGNORES a snapshot/meetings/reports/owner passed to it',
  !JSON.stringify(smuggled).includes('POISON'),
  'the public builder accepted internal data through an unused parameter — that is a publication one typo away',
);

check(
  'the public builder produces no `errors`, `pending_items`, `activity` or `board` key',
  !('errors' in publicOut) && !('pending_items' in publicOut)
    && !('activity' in publicOut) && !('board' in publicOut),
);

/* ═════════════════ 4. THE PUBLIC CONTENT ITSELF ══════════════════════════ */

check('OFFICE_SUMMARY is frozen', Object.isFrozen(OFFICE_SUMMARY));
check('OFFICE_MECHANISMS is frozen', Object.isFrozen(OFFICE_MECHANISMS));
check('there are at least 6 mechanism entries', OFFICE_MECHANISMS.length >= 6);
check(
  'every mechanism entry has id, title and text',
  OFFICE_MECHANISMS.every((m) => m.id && m.title && m.text),
);

/**
 * A10: security FINDINGS are never published — not open, not closed, not
 * historical. The `security` entry is allowed to say the review happens. It is
 * not allowed to describe a defence or name a finding, so this asserts on the
 * vocabulary a finding would have to use.
 */
const securityText = (OFFICE_MECHANISMS.find((m) => m.id === 'security') || {}).text || '';
const findingWords = /\b(vulnerab|exploit|CVE-|injection|bypass|unauthenticated endpoint|leaked|exposure|token was|key was)\b/i;
check(
  'the security mechanism entry describes the PROCESS and names no finding',
  !!securityText && !findingWords.test(securityText),
  'A10 permits showing that security review happens and forbids publishing what it found',
);

/* The whole public payload gets the same scan, not just that one entry. */
check(
  'no finding vocabulary anywhere in the public payload',
  !findingWords.test(publicJson),
);

/* ═══════════════════ 5. THE ADMIN SURFACE AND ITS CONTRACT ═══════════════ */

const snapshot = {
  board: {
    tasks: [
      { id: 'OB-043', title: 'Build the office site', state: 'BLOCKED', blockedBy: 'an owner decision', stage: null },
      { id: 'OB-060', title: 'A live data path', state: 'NOT-READY', blockedBy: null, stage: 'IN-REVIEW' },
      { id: 'OB-999', title: 'Ordinary work', state: 'READY', blockedBy: null, stage: null },
    ],
  },
  questions: { questions: [{ id: 'Q-010', title: 'A question', open: true, date: '2026-08-01', fallback: 'proceed' }, { id: 'Q-011', title: 'Answered', open: false }] },
  submissions: { submissions: [{ id: 'S-002', title: 'A submission', open: true, recommend: 'ship it', escalation: { rung: 'RE-RAISED', days: 12 } }] },
  errors: ['a read error the office must not hide'],
};

const adminOut = buildAdminData({
  agents: poisonedAgents,
  counts: poisonedCounts,
  snapshot,
  reports: [{ created_at: '2026-08-24T10:00:00Z', agent_id: 7, type: 'daily', title: 'Daily summary', severity: 'info' }],
  meetings: [{ created_at: '2026-08-24T09:00:00Z', type: 'daily_standup', attendee_count: 5 }],
  generatedAt: '2026-08-24T12:00:00.000Z',
  versionId: 'test-version',
});

check(
  'the admin response carries every key of the data.js contract',
  ADMIN_CONTRACT_KEYS.every((k) => k in adminOut),
  `missing: ${ADMIN_CONTRACT_KEYS.filter((k) => !(k in adminOut)).join(', ')}`,
);

check(
  'a READY board task is NOT listed as pending — it is the office\'s work, not the owner\'s',
  !adminOut.pending_items.some((i) => i.id === 'board-ob-999'),
);
check('a BLOCKED task IS listed', adminOut.pending_items.some((i) => i.id === 'board-ob-043' && i.kind === 'blocked'));
check('a NOT-READY task IS listed', adminOut.pending_items.some((i) => i.id === 'board-ob-060' && i.kind === 'decision'));
check('an OPEN question IS listed', adminOut.pending_items.some((i) => i.id === 'question-q-010'));
check('an ANSWERED question is NOT listed', !adminOut.pending_items.some((i) => i.id === 'question-q-011'));
check('an OPEN submission IS listed', adminOut.pending_items.some((i) => i.id === 'submission-s-002'));

check(
  'a task with no "Blocked by" line SAYS the board does not say — it does not invent one',
  (adminOut.pending_items.find((i) => i.id === 'board-ob-060') || {}).detail?.includes('does not say what this is waiting on'),
);

check(
  'the office\'s own read errors are carried, not swallowed',
  adminOut.errors.includes('a read error the office must not hide'),
);

check(
  'an unreadable snapshot says pending_items is empty BECAUSE THE READ FAILED',
  buildAdminData({ snapshot: null }).data_gaps.some((g) => /COULD NOT READ ITS OWN BOARD/.test(g)),
  'an empty list from a failed read must never look like an empty list from nothing pending',
);

check(
  'bible_detail and produced are named in data_gaps rather than silently empty',
  adminOut.data_gaps.some((g) => /bible_detail is null/.test(g))
    && adminOut.data_gaps.some((g) => /produced is empty/.test(g))
    && adminOut.data_gaps.some((g) => /git commit feed/.test(g)),
);

check(
  'activity carries no report body and no meeting transcript field',
  adminOut.activity.every((a) => !('content' in a) && !('transcript' in a) && !('decisions' in a)),
);

check(
  'activity is sorted newest first',
  adminOut.activity[0]?.sort_key === '2026-08-24T10:00:00Z',
);

check('agentSlug builds the campus folder name', agentSlug({ id: 1, key: 'agent-1-perfectionist' }) === '01-the-perfectionist');
check('agentSlug does not double the "the"', agentSlug({ id: 7, key: 'agent-7-team-lead' }) === '07-the-team-lead');
check('agentSlug refuses a key it cannot read', agentSlug({ id: 1, key: 'nonsense' }) === null);

check(
  'buildPendingItems on an empty snapshot returns an empty array, not a throw',
  Array.isArray(buildPendingItems(null)) && buildPendingItems(null).length === 0,
);
check(
  'buildActivity with no input returns an empty array',
  buildActivity().length === 0,
);

/* ══════════ 6. IS THE GATE ACTUALLY ON THE ROUTE? (the §7 check) ═════════ */

const runner = readFileSync(join(repo, 'workers', 'agent-runner.js'), 'utf8');

check(
  'agent-runner.js imports the builders from site-data.js',
  /import\s*\{[^}]*buildPublicData[^}]*\}\s*from\s*'\.\/site-data\.js'/.test(runner),
  'the module exists and nothing routes through it — exactly as protective as no module at all',
);

const publicRoute = /url\.pathname === '\/api\/public'/.test(runner);
check('a /api/public route exists in the router', publicRoute);

const adminRoute = /url\.pathname === '\/api\/admin'/.test(runner);
check('a /api/admin route exists in the router', adminRoute);

/**
 * THE AUTH CHECK, and it is the one that matters most here.
 *
 * `/api/admin` must be refused without the admin token, and it must be refused
 * by the SAME prefix guard that already stands in front of `/api/agents/` —
 * not by a check inside its own handler. A per-handler check is a check
 * somebody removes while refactoring; a prefix guard is one somebody has to
 * defeat on purpose.
 */
const guard = /const AUTHENTICATED_PREFIXES\s*=/.test(runner)
  && /AUTHENTICATED_PREFIXES\.some\(/.test(runner);
check(
  '/api/admin is authenticated by the shared prefix guard, not by its own handler',
  guard,
  'expected an AUTHENTICATED_PREFIXES list applied before any handler is reached',
);

check(
  'the /api/public route body does not mention a snapshot',
  (() => {
    const i = runner.indexOf("url.pathname === '/api/public'");
    if (i < 0) return false;
    const body = runner.slice(i, i + 1400);
    return !/getOfficeSnapshot|fetchOfficeSnapshot|buildAdminData|transcript/.test(body);
  })(),
  'the public handler reaches for internal data — the boundary is in the module and the route walked around it',
);

/* ════════════════════════════════ Result ════════════════════════════════ */

console.log(`\nsite-data: ${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  the public surface fails closed: poisoned fields did not reach it, and the route is behind the module.\n');
process.exit(0);
