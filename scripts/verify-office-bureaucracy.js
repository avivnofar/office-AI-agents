#!/usr/bin/env node
/**
 * scripts/verify-office-bureaucracy.js
 *
 * Dry-run verifier for the 2026-08-07 office-bureaucracy session:
 *   §1  office-context.js parsers — refuse rather than guess
 *   §2  size budgets and the documented drop order
 *   §3  the switches — OFF is silent, and OFF is the default
 *   §4  action_items schema + normaliser — agent_id refused, never defaulted
 *   §5  the board task renderer — decided:false lands as NOT-READY
 *   §6  commitMeetingReport() goes through the guard  [FAILS-OLD]
 *   §7  the roster 11→13 change and its Track A protection  [FAILS-OLD]
 *   §8  the Workflow's metrics — four measures, never one score
 *   §9  source-level assertions: no ungoverned Authorization header,
 *       no Anthropic path in the meeting engine, mirror-drift guard
 *
 * NO NETWORK. globalThis.fetch is replaced with a tripwire that throws, so
 * "this makes no network calls" is PROVEN rather than claimed.
 *
 * Held to the standard plan item 0.3 set: the sections marked [FAILS-OLD]
 * transcribe the PRE-CHANGE logic and assert against it, so the table catches
 * a real defect rather than describing a fix. A scenario that passes against
 * both the old and new code is documentation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/* ── tripwire: nothing in this file may touch the network ── */
globalThis.fetch = () => {
  throw new Error('TRIPWIRE: verify-office-bureaucracy.js made a network call. It must not.');
};

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n--- ${title} ---`); }

// Both of these are JSON-import-free by design, so plain Node can import the
// REAL modules and exercise the real functions — no hand-written mirror.
const officeContext = await import('../workers/office-context.js');
const meetingEngine = await import('../workers/meeting-decisions.js');
const agentsConfig = JSON.parse(read('config/agents-config.json'));
const relationships = JSON.parse(read('config/relationships.json'));

/* ═══════════════════ §1 parsers refuse rather than guess ═══════════════ */
section('§1 parsers — refuse rather than guess');

const GOOD_BOARD = `# THE OFFICE BOARD

### OB-001 — Do the first thing

- **Assignee:** Agent 13 — The Cyber Expert
- **State:** READY
- **Metric:** 3 office-days from dispatch · delivered = a file that exists
- **Blocked by:** nothing

### OB-002 — Do the second thing

- **Assignee:** Agent 12 — The Workflow
- **State:** BLOCKED
- **Metric:** 2 office-days from dispatch · delivered = another file
- **Blocked by:** **OB-001.**

### OB-003 — An urgent thing

- **Assignee:** Agent 5 — The IT Chief
- **State:** IN-PROGRESS
- **Urgency:** **URGENT** (owner-assigned, REQ-001)
- **Metric:** 4 office-days from dispatch (2026-01-01) · delivered = a proposal
- **Blocked by:** nothing
`;

const board = officeContext.parseBoard(GOOD_BOARD);
check('parseBoard reads a well-formed board', board.ok === true, board.reason);
check('parseBoard derives 3 tasks', board.ok && board.tasks.length === 3, `got ${board.tasks?.length}`);
check('parseBoard extracts agentId from the assignee line', board.ok && board.tasks[0].agentId === 13);
check('parseBoard picks up the optional Urgency field', board.ok && !!board.tasks[2].urgency);
check('parseBoard DERIVES counts rather than reading the file\'s own Counts line',
  board.ok && board.counts.READY === 1 && board.counts.BLOCKED === 1 && board.counts['IN-PROGRESS'] === 1);

const badState = officeContext.parseBoard(GOOD_BOARD.replace('- **State:** READY', '- **State:** SORTA-READY'));
check('a task with an unreadable State is REFUSED, not counted as READY',
  badState.ok && badState.tasks.length === 2 && badState.malformed.length === 1, JSON.stringify(badState.malformed));
check('the refused task is REPORTED, not silently dropped',
  badState.ok && /OB-001/.test(badState.malformed[0]));

check('parseBoard refuses a file with no task headings (format changed)',
  officeContext.parseBoard('# Not the board\n\nsome prose').ok === false);
check('parseBoard refuses empty input', officeContext.parseBoard('').ok === false);

const GOOD_REQS = `# CLIENT-REQUIREMENTS.md

- **Clock started:** **2026-08-07**
- **Due:** **2026-09-07**

| ID | Requirement | Urgency | Status |
|---|---|---|---|
| **REQ-001** | Reach the owner | **URGENT** *(owner-marked)* | in progress |
| **REQ-002** | New designs | normal | not started |
| **REQ-X1** | Multiple hands | cross-cutting | in progress |
`;

const reqs = officeContext.parseRequirements(GOOD_REQS);
check('parseRequirements reads the table', reqs.ok === true, reqs.reason);
check('parseRequirements extracts the absolute due date', reqs.ok && reqs.due === '2026-09-07', reqs.due);
check('parseRequirements reads 3 rows including REQ-X1', reqs.ok && reqs.requirements.length === 3);
check('parseRequirements flags the owner-marked URGENT row',
  reqs.ok && reqs.requirements.find((r) => r.id === 'REQ-001').urgent === true);
check('parseRequirements does NOT mark a normal row urgent',
  reqs.ok && reqs.requirements.find((r) => r.id === 'REQ-002').urgent === false);

const badStatus = officeContext.parseRequirements(GOOD_REQS.replace('| in progress |', '| mostly done |'));
check('a requirement with an unreadable status is REFUSED, never defaulted to "not started"',
  badStatus.ok && badStatus.requirements.length === 2 && badStatus.malformed.length === 1,
  JSON.stringify(badStatus.malformed));

/* ═══════════════════ §2 budgets and drop order ════════════════════════ */
section('§2 size budgets and the documented drop order');

check('BUDGETS.agent is the tightest — it is the per-LLM-call one',
  officeContext.BUDGETS.agent < officeContext.BUDGETS.meeting);
check('BUDGETS.report is the loosest — those two sites make no model call',
  officeContext.BUDGETS.report > officeContext.BUDGETS.meeting);
// 400 -> 520 on 2026-08-10, closing OB-030's open half with a measured per-day
// cost figure (~18,000 extra input tokens a day across free tiers that meter
// requests, not tokens — see BUDGETS' own header). At 400 the ADMIN agent shape
// measured 327 tokens, 82%, apparently healthy, while dropping
// `deliverables-count` and `questions-headline` outright: an admin was told
// neither that a deliverable was in the review loop nor that the office had
// questions open with the owner. Same failure the meeting budget hit twice.
/*
 * RAISED 520 -> 880 (admin) and 380 -> 660 (standard) on 2026-08-10 with the
 * owner channel. Not a loosening: at the old numbers ONE owner message made the
 * fitter drop `requirements-status` from the standard shape, which is one of the
 * two things A11 names as universal. Measured curve in office-context.js BUDGETS.
 *
 * Pinned to the exact numbers on purpose. A `> 500` style assertion would let
 * the budget drift upward one convenience at a time, which is how a budget stops
 * being one.
 */
check('BUDGETS.agent is 880 as measured (raised with the owner channel)', officeContext.BUDGETS.agent === 880);
check('BUDGETS.agent_standard is 660 as measured', officeContext.BUDGETS.agent_standard === 660);
check('BUDGETS.agent_standard exists and is tighter than the admin one (A11)',
  officeContext.BUDGETS.agent_standard < officeContext.BUDGETS.agent);
// 3,500 since 2026-08-10 (was 1,200). OB-030 closed: at 1,200 the meeting
// shape measured 1,181 tokens — 98.4%, apparently healthy — while quietly
// shrinking FOUR sections to a single item each, so a meeting saw 1 of 26 open
// tasks, 1 of 5 projects, 1 of 8 requirements and 1 of 12 stuck items. The
// shape's full untrimmed size is 3,236; 3,500 clears it with headroom. See the
// measured curve in office-context.js's BUDGETS note.
// 3,500 -> 4,600 LATER THE SAME DAY, with the deliverable lifecycle. With one
// deliverable at GAPS-RAISED the shape measures 4,277 untrimmed, and at 3,500 it
// "fitted" at 3,488 by trimming the REQUIREMENT DETAIL — the thing agenda item 1
// is about. Same lesson as OB-030's, one raise later: the percentage was never
// the number that mattered; what the fitter had to cut to reach it is.
check('BUDGETS.meeting is 4600 as specified (2026-08-10, the lifecycle raise)', officeContext.BUDGETS.meeting === 4600);
check('the meeting budget clears the shape\'s full untrimmed size WITH a deliverable in the loop',
  officeContext.BUDGETS.meeting >= 4277);
check('the report budget clears the three-deliverable shape — it is free, it makes no model call',
  officeContext.BUDGETS.report >= 5944);

const snapshot = { fetched_at: Date.now(), board, requirements: reqs, errors: [] };

const agentShape = officeContext.buildOfficeContext(snapshot, 'agent', { agentId: 12 });
const meetingShape = officeContext.buildOfficeContext(snapshot, 'meeting');
const reportShape = officeContext.buildOfficeContext(snapshot, 'report');

check('agent shape fits its budget', agentShape.tokens <= officeContext.BUDGETS.agent, `${agentShape.tokens} tokens`);
check('meeting shape fits its budget', meetingShape.tokens <= officeContext.BUDGETS.meeting, `${meetingShape.tokens} tokens`);
check('report shape fits its budget', reportShape.tokens <= officeContext.BUDGETS.report, `${reportShape.tokens} tokens`);
// The budgets only MEAN anything when they bind. With three tasks nothing is
// dropped and all three shapes are the same size — so this builds a board big
// enough to force the budget to bite, which is the condition the ordering is
// actually a claim about.
//
// 60 -> 110 TASKS ON 2026-08-10. The meeting budget went 1,200 -> 3,500 and a
// 60-task board stopped binding it: meeting and report both came back at 2,465
// untrimmed and the ordering assertion below failed on EQUALITY, not on a real
// regression. Weakening it to `>=` would have been the wrong repair — it would
// have left the suite asserting an ordering it was no longer testing. The
// fixture is scaled instead, so the claim is still made under a board that
// genuinely binds every budget.
//
// 110 -> DERIVED, LATER THE SAME DAY. The budget moved again (3,500 -> 4,600
// with the deliverable lifecycle) and 110 tasks stopped binding it, in exactly
// the same way, for exactly the same reason — the second time in one day that a
// hand-picked fixture size silently stopped testing what it claims to test.
//
// So the size is no longer hand-picked. It is DERIVED FROM THE BUDGETS, and it
// has to satisfy TWO conditions at once, not one — which the first derived
// attempt got wrong and the suite caught: a board sized only to bind the meeting
// budget also bound the REPORT budget, breaking the very next check, whose whole
// claim is that the report shape is the unbound one.
//
// So the fixture is sized to land STRICTLY BETWEEN the two budgets: big enough
// that the meeting shape trims, small enough that the report shape does not.
// The midpoint does that for any pair, and the ~39-tokens-per-task divisor is
// measured on this fixture's own shape (110 tasks produced 4,331 tokens).
//
// BOTH conditions are then ASSERTED rather than assumed, because a fixture that
// fails either one turns the checks below into checks that pass for the wrong
// reason — which is exactly how this line came to need fixing twice in a day.
const BIG_BOARD_TASKS = Math.ceil(((officeContext.BUDGETS.meeting + officeContext.BUDGETS.report) / 2) / 39);
const bigBoard = officeContext.parseBoard(
  Array.from({ length: BIG_BOARD_TASKS }, (_, i) => `### OB-${String(i + 1).padStart(3, '0')} — Task number ${i + 1} with a deliberately long title to consume budget

- **Assignee:** Agent ${(i % 9) + 1} — Somebody
- **State:** ${i % 3 === 0 ? 'READY' : i % 3 === 1 ? 'IN-PROGRESS' : 'BLOCKED'}
- **Metric:** 3 office-days from dispatch · delivered = a file with a long descriptive name ${i}
- **Blocked by:** ${i % 3 === 2 ? 'something specific and wordy' : 'nothing'}
`).join('\n')
);
check('the big test board parses', bigBoard.ok === true, bigBoard.reason);
const bigSnap = { fetched_at: Date.now(), board: bigBoard, requirements: reqs, errors: [] };
const bigAgent = officeContext.buildOfficeContext(bigSnap, 'agent', { agentId: 3 });
/*
 * THE ADMIN SHAPE IS WHAT BINDS, and this variable exists because the check
 * below started passing for the wrong reason on 2026-08-10.
 *
 * `bigAgent` has no `clearance`, so A11 treats it as STANDARD and the section
 * filter removes `board-titles` — the 161-item list this fixture exists to
 * blow — before the fitter ever sees it. At the old 380 budget the shape still
 * bound on the agent's OWN ~18 tasks; at 660 it does not, so `trimmed` came back
 * empty and the shrink-before-drop assertion failed against a shape that had
 * nothing to shrink. The assertion was right and the fixture had gone slack.
 */
const bigAgentAdmin = officeContext.buildOfficeContext(bigSnap, 'agent', { agentId: 3, clearance: 'sudo' });
const bigMeeting = officeContext.buildOfficeContext(bigSnap, 'meeting');
const bigReport = officeContext.buildOfficeContext(bigSnap, 'report');
check(`the fixture (${BIG_BOARD_TASKS} tasks) actually BINDS the meeting budget — a fixture that does not bind makes the ordering check below pass for the wrong reason`,
  bigMeeting.trimmed.length > 0 || bigMeeting.dropped.length > 0,
  `trimmed=${bigMeeting.trimmed.join(',')} dropped=${bigMeeting.dropped.join(',')}`);
check('under a board big enough to bind, report > meeting > agent',
  bigReport.tokens > bigMeeting.tokens && bigMeeting.tokens > bigAgent.tokens,
  `agent=${bigAgent.tokens} meeting=${bigMeeting.tokens} report=${bigReport.tokens}`);
check(`the agent shape still respects its ${officeContext.BUDGETS.agent}-token ceiling under load`,
  bigAgent.tokens <= officeContext.BUDGETS.agent && bigAgentAdmin.tokens <= officeContext.BUDGETS.agent,
  `standard=${bigAgent.tokens} admin=${bigAgentAdmin.tokens}`);
check(`the meeting shape still respects its ${officeContext.BUDGETS.meeting}-token ceiling under load`,
  bigMeeting.tokens <= officeContext.BUDGETS.meeting, `${bigMeeting.tokens}`);
// SHRINK BEFORE DROP. The first version of fitToBudget() only dropped whole
// sections, and this assertion is what caught it: a 60-task "Open work"
// section blew the 1,200-token meeting budget, so the whole section vanished
// and left ~1,050 tokens unused — a full meeting ended up with LESS office
// context (149 tokens) than a single agent (349). Invisible with the
// three-task fixture; it would have appeared the first day the board grew.
check('the admin fixture actually BINDS (a slack fixture makes the next check meaningless)',
  bigAgentAdmin.trimmed.length > 0 || bigAgentAdmin.dropped.length > 0,
  `trimmed=${bigAgentAdmin.trimmed.join(',')} dropped=${bigAgentAdmin.dropped.join(',')}`);
check('a bound shape TRIMS list sections rather than dropping them whole',
  bigAgentAdmin.trimmed.length > 0,
  `agent trimmed=${JSON.stringify(bigAgentAdmin.trimmed)} dropped=${JSON.stringify(bigAgentAdmin.dropped)}`);
check('the report shape, being unbound, neither trims nor drops',
  bigReport.trimmed.length === 0 && bigReport.dropped.length === 0);
check('a trimmed list SAYS it was trimmed — no silent caps',
  /showing \d+ of \d+/.test(bigAgentAdmin.text), bigAgentAdmin.text.slice(0, 200));
check('trimming never empties a section below one item (the section survives)',
  /Open work/.test(bigMeeting.text) || bigMeeting.dropped.includes('board-titles'));
check('even fully squeezed, the agent shape keeps the requirement statuses',
  /REQ-001/.test(bigAgent.text));

check('every shape keeps the requirement STATUS lines (last to be dropped)',
  [agentShape, meetingShape, reportShape].every((s) => /REQ-001/.test(s.text)));
check('the agent shape narrows to that agent\'s own tasks', /OB-002/.test(agentShape.text));

// Force the drop order: a tiny budget must shed detail before status.
const squeezed = officeContext.fitToBudget([
  { label: 'headline', priority: 0, text: 'H'.repeat(30) },
  { label: 'status', priority: 1, text: 'S'.repeat(30) },
  { label: 'detail', priority: 3, text: 'D'.repeat(600) },
], 40);
check('over budget, DETAIL is dropped before STATUS', squeezed.dropped.includes('detail') && !squeezed.dropped.includes('status'),
  JSON.stringify(squeezed.dropped));
check('over budget, the headline always survives', /H/.test(squeezed.text));
check('what was dropped is REPORTED, never silently truncated', squeezed.dropped.length > 0);

/* ═══════════════════ §3 the switches ═══════════════════════════════════ */
section('§3 switches — OFF is the default and OFF is silent');

const noKv = {};
check('officeContextEnabled is FALSE with no SIM_KV binding', (await officeContext.officeContextEnabled(noKv)) === false);
const meSrc0 = read('workers/meeting-engine.js');
check('actionItemsToBoardEnabled returns false with no SIM_KV binding (source)',
  meSrc0.includes('if (!env?.SIM_KV) return false;'));
check('actionItemsToBoardEnabled tests === true, not truthiness (source)',
  meSrc0.includes('stored?.[ACTION_ITEMS_FLAG] === true'));
check('the action-items consumer has its OWN flag, not improvement_loop_enabled',
  meSrc0.includes("ACTION_ITEMS_FLAG = 'action_items_to_board_enabled'"));

const kv = (obj) => ({ SIM_KV: { get: async () => obj } });
check('office context OFF when the key is absent', (await officeContext.officeContextEnabled(kv({ paused: false }))) === false);
check('office context OFF when explicitly false', (await officeContext.officeContextEnabled(kv({ office_context_enabled: false }))) === false);
check('office context OFF for the STRING "true" (=== true, not truthiness)',
  (await officeContext.officeContextEnabled(kv({ office_context_enabled: 'true' }))) === false);
check('office context ON only for the boolean true', (await officeContext.officeContextEnabled(kv({ office_context_enabled: true }))) === true);
check('the two new flags are on the simulation-state allow-list (else they can never be set)',
  /'office_context_enabled', 'action_items_to_board_enabled'/.test(read('workers/agent-runner.js')));

// OPERATIONAL PATH (added 2026-08-08). Being on the allow-list only means the
// flag CAN be set; it says nothing about there being a documented, authenticated
// way to set it. office_context_enabled shipped 2026-08-07 allow-listed but with
// no trigger case, so its only route was the unauthenticated POST /api/simulation
// — the owner burned twenty minutes guessing trigger-type names that did not
// exist. These checks make "capability with no operational path" a test failure.
const arSrc0 = read('workers/agent-runner.js');
for (const flag of ['guides', 'routing', 'architect_liaison', 'improvement_loop', 'office_context']) {
  check(`${flag} has a toggle case on /api/agents/trigger (the AUTHENTICATED path)`,
    arSrc0.includes(`case '${flag}_toggle':`));
}
check('office_context_status exists so flag-ON-input-EMPTY is observable without generating a report',
  arSrc0.includes("case 'office_context_status':"));
check('office_context_status reports the token presence — the silent-empty cause',
  /officeContextEnabled: true[\s\S]{0,200}backofficeTokenPresent/.test(arSrc0));
/* ── THE REVERSAL, 2026-08-10 ────────────────────────────────────────────
 *
 * This check used to assert the OPPOSITE: that `action_items_to_board_toggle`
 * must NOT exist, so the flag "stays owner-only". That reasoning was sound
 * while the alternative route was an UNAUTHENTICATED `POST /api/simulation`,
 * and it inverts the moment that endpoint requires the admin token — which it
 * now does. With the endpoint closed, the trigger case IS the owner-only path,
 * and withholding it would leave a live production flag settable by nobody.
 *
 * Rewritten in place rather than deleted, so the reversal is legible in the
 * diff instead of reading as a rule quietly dropped.
 */
check('action_items_to_board_toggle now EXISTS — the endpoint that used to be its only route is closed',
  arSrc0.includes("case 'action_items_to_board_toggle':"));

/* ═══════ §3b THE UNAUTHENTICATED STATE ENDPOINT — CLOSED 2026-08-10 ═════
 *
 * Flagged 2026-07-18, open 23 days, named in OFFICE-POLICY.md Part C as a
 * thing that "must be closed before the public front opens". `POST
 * /api/simulation` took a JSON body straight into updateSimulationState() with
 * no token check, reaching all ten allow-list keys including `paused`.
 *
 * THE SCENARIO BELOW FAILS AGAINST THE PRE-CHANGE CODE, by construction: the
 * gate detector is run against a TRANSCRIPTION of the old handler as well as
 * against the live source, and is required to refuse one and pass the other.
 * A checker that only ever sees the fixed code cannot tell "this is guarded"
 * from "my regex matches anything".
 */
section('§3b POST /api/simulation requires the admin token');

/** Extracts the POST /api/simulation handler body and asks whether the admin
 *  token is checked BEFORE updateSimulationState() is reached. Pure, so it can
 *  be pointed at the old code and the new one alike. */
function simulationPostIsGuarded(source) {
  const start = source.indexOf("url.pathname === '/api/simulation'", source.indexOf("request.method === 'POST' && url.pathname === '/api/simulation'"));
  if (start === -1) return { found: false, guarded: false };
  const body = source.slice(start, start + 2500);
  const gateAt = body.search(/env\.ADMIN_TOKEN/);
  const updateAt = body.search(/updateSimulationState\(env, body\)/);
  if (updateAt === -1) return { found: false, guarded: false };
  return { found: true, guarded: gateAt !== -1 && gateAt < updateAt };
}

// The pre-change handler, transcribed verbatim from office-AI-agents@39ff10c
// workers/agent-runner.js. This is the control: if the detector passes it, the
// detector is not detecting anything.
const PRE_CHANGE_HANDLER = `
      if (request.method === 'POST' && url.pathname === '/api/simulation') {
        const body = await request.json();
        return json(await updateSimulationState(env, body), 200, origin);
      }
`;
const preChange = simulationPostIsGuarded(PRE_CHANGE_HANDLER);
check('CONTROL — the pre-change handler is detected as UNGUARDED (else this check proves nothing)',
  preChange.found === true && preChange.guarded === false, JSON.stringify(preChange));

const liveGuard = simulationPostIsGuarded(arSrc0);
check('the LIVE handler is guarded, and the token check precedes the state write',
  liveGuard.found === true && liveGuard.guarded === true, JSON.stringify(liveGuard));

check('the closure did NOT widen the /api/agents/ prefix gate (GET /api/simulation stays a public read)',
  arSrc0.includes("url.pathname.startsWith('/api/agents/')") && !arSrc0.includes("url.pathname.startsWith('/api/')"));
check('the 401 body is the SAME shape the /api/agents/* gate returns (one idiom, not two)',
  (arSrc0.match(/error: 'unauthorized' \}, 401, origin\)/g) || []).length >= 2);

/* ── EVERY SWITCH IS STILL REACHABLE THROUGH AN AUTHENTICATED PATH ───────
 *
 * The reason this check exists at all: `office_context_enabled` was set through
 * the unauthenticated endpoint precisely BECAUSE it had no trigger handler. A
 * switch with no route is worse than one with an open route — the open route is
 * a known risk with a known fix; the absent route is discovered at the moment
 * someone needs to stop the office. So closing the endpoint is only safe if
 * every allow-list key has a case on /api/agents/trigger, and that is asserted
 * here per key rather than assumed.
 */
const ALLOW_LIST_TO_TRIGGER = {
  inspection_mode: 'inspection',
  paused: 'pause',
  phase: 'phase_set',
  guides_enabled: 'guides_toggle',
  routing_enabled: 'routing_toggle',
  improvement_loop_enabled: 'improvement_loop_toggle',
  architect_liaison_enabled: 'architect_liaison_toggle',
  office_context_enabled: 'office_context_toggle',
  action_items_to_board_enabled: 'action_items_to_board_toggle',
  report_pipeline_enabled: 'report_pipeline_toggle',
  // Added 2026-08-10 with the owner channel. This map caught it immediately —
  // which is the check working exactly as its header describes, on the first new
  // switch since it was written.
  owner_channel_enabled: 'owner_channel_toggle',
  // Added 2026-08-10 with the learning loop's write path (workers/context-
  // editor.js, probation.js) — same session, later in the day.
  learning_loop_enabled: 'learning_loop_toggle',
};
const allowListMatch = /const allowedKeys = \[([^\]]+)\]/.exec(arSrc0);
const allowListKeys = allowListMatch
  ? allowListMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  : [];
/*
 * Was `length === 10`, a hardcoded count that had to be edited by hand every
 * time a switch was added — and on 2026-08-10 it was the thing that failed when
 * the eleventh arrived, reporting only a number. The set comparison below says
 * WHICH key is unaccounted for in either direction, which is the whole reason
 * anyone reads a failing check.
 *
 * Both directions matter and neither is redundant: a key in the source with no
 * entry here is a switch whose authenticated route was never declared; an entry
 * here with no key in the source is a route to a switch that no longer exists.
 */
const mapKeys = Object.keys(ALLOW_LIST_TO_TRIGGER);
check('the allow-list was found in source (else the per-key checks below are vacuous)',
  allowListKeys.length > 0, `${allowListKeys.length} keys`);
check('the allow-list and the trigger map name exactly the same switches',
  allowListKeys.length === mapKeys.length && allowListKeys.every((k) => mapKeys.includes(k)),
  `in source only: ${allowListKeys.filter((k) => !mapKeys.includes(k)).join(', ') || 'none'}`
  + ` | in this map only: ${mapKeys.filter((k) => !allowListKeys.includes(k)).join(', ') || 'none'}`);
for (const key of allowListKeys) {
  const trigger = ALLOW_LIST_TO_TRIGGER[key];
  check(`allow-list key "${key}" has an authenticated route (trigger "${trigger}")`,
    !!trigger && arSrc0.includes(`case '${trigger}':`));
}
check('a read-back of the whole state exists on the AUTHENTICATED endpoint too',
  arSrc0.includes("case 'simulation_state':"));

// THE SILENT DROP (found 2026-08-08, live). The commitment due date sat inside
// a blockquote, `^- **Due:**` could not match it, and `due:null` rendered as
// NOTHING — so the office ran a full day with no deadline in any prompt while
// every health signal said fine. The regex was the trigger; the silence was the
// defect. These scenarios pin all three layers of the fix, because fixing only
// the anchor would close this instance and leave the next one silent.
const REQ_ROWS = [
  '| ID | Requirement | Urgency | Status |',
  '|---|---|---|---|',
  '| **REQ-001** | Ship the thing | URGENT | in progress |',
  '| **REQ-002** | Ship the other thing |  | not started |',
].join('\n');

const dueQuoted = officeContext.parseRequirements(`> - **Due:** **2026-09-07**\n\n${REQ_ROWS}`);
check('due date parses when BLOCKQUOTED (the live shape that silently failed)',
  dueQuoted.ok === true && dueQuoted.due === '2026-09-07');
check('...and a blockquoted due date produces NO malformed entry',
  dueQuoted.malformed.length === 0);

const duePlain = officeContext.parseRequirements(`- **Due:** **2026-09-07**\n\n${REQ_ROWS}`);
check('due date still parses UNQUOTED (the fix did not trade one anchor for another)',
  duePlain.ok === true && duePlain.due === '2026-09-07');

const dueMissing = officeContext.parseRequirements(`## No commitment here\n\n${REQ_ROWS}`);
check('a MISSING due date still parses the rows (ok:true — it is not a total failure)',
  dueMissing.ok === true && dueMissing.due === null && dueMissing.requirements.length === 2);
check('...and is REPORTED as malformed rather than vanishing (the actual defect)',
  dueMissing.malformed.length === 1 && /commitment Due date not found/.test(dueMissing.malformed[0]));

const builtMissing = officeContext.buildOfficeContext(
  { fetched_at: Date.now(), board: null, requirements: dueMissing, errors: [] }, 'report', {});
check('...and the RENDERED context shouts it, so the office cannot read it as "no deadline"',
  /COMMITMENT DUE DATE UNREADABLE/.test(builtMissing.text));
const builtOk = officeContext.buildOfficeContext(
  { fetched_at: Date.now(), board: null, requirements: dueQuoted, errors: [] }, 'report', {});
check('...while a readable due date renders the date and NOT the marker',
  /commitment due 2026-09-07/.test(builtOk.text) && !/UNREADABLE/.test(builtOk.text));

check('getOfficeContext logs malformed INPUT (distinct from a degraded RENDER)',
  read('workers/office-context.js').includes('built from UNREADABLE input'));

// Switch OFF must not read the cache, not fetch, not log. The tripwire proves
// no fetch; a throwing SIM_KV.get proves the cache is not read either.
const throwingKv = { SIM_KV: { get: async (k) => { if (k === 'office-context-cache') throw new Error('cache was read while the switch was OFF'); return null; } } };
const offResult = await officeContext.getOfficeContext(throwingKv, { shape: 'agent' });
check('switch OFF returns text:null and reads no cache', offResult.text === null && offResult.reason === 'office_context_disabled');
check('switch OFF is not reported as degraded (off is not a failure)', offResult.degraded === false);

/* ═══════════════ §4 action_items — refused, never defaulted ═══════════ */
section('§4 action_items normaliser');

const roster = agentsConfig.agents.map((a) => a.id);

const good = { agent_id: 13, task: 'Audit the write paths', delivered: 'findings/write-paths.md with one row per path', due_days: 3, decided: true };
let n = meetingEngine.normalizeActionItems([good], { rosterIds: roster });
check('a complete item passes', n.items.length === 1 && n.dropped.length === 0, JSON.stringify(n.dropped));

n = meetingEngine.normalizeActionItems([{ ...good, agent_id: undefined }], { rosterIds: roster });
check('agent_id absent → DROPPED, never defaulted', n.items.length === 0 && n.dropped.length === 1);
check('the drop reason says it was refused rather than defaulted', /REFUSED, never defaulted/.test(n.dropped[0].reason));

n = meetingEngine.normalizeActionItems([{ ...good, agent_id: 99 }], { rosterIds: roster });
check('agent_id outside the roster → DROPPED with the roster in the reason',
  n.items.length === 0 && /not in the roster/.test(n.dropped[0].reason));

n = meetingEngine.normalizeActionItems([{ ...good, delivered: '' }], { rosterIds: roster });
check('delivered empty → DROPPED (the deadline would be unfalsifiable)', n.items.length === 0 && n.dropped.length === 1);

n = meetingEngine.normalizeActionItems([{ ...good, due_days: 'soon' }], { rosterIds: roster });
check('due_days non-numeric → DROPPED', n.items.length === 0);

n = meetingEngine.normalizeActionItems(['Review the gap digest format'], { rosterIds: roster });
check('a BARE STRING (the pre-2026-08-07 schema) → DROPPED', n.items.length === 0 && n.dropped.length === 1);
check('the bare-string drop names it as the OLD SCHEMA, not merely malformed',
  /pre-2026-08-07 action_items schema/.test(n.dropped[0].reason), n.dropped[0].reason);

n = meetingEngine.normalizeActionItems([{ ...good, decided: false, open_question: 'who owns the front?' }], { rosterIds: roster });
check('decided:false is ACCEPTED as a first-class value, not dropped', n.items.length === 1 && n.items[0].decided === false);

n = meetingEngine.normalizeActionItems([{ ...good, decided: undefined }], { rosterIds: roster });
check('decided absent is treated as NOT decided (the conservative direction)', n.items[0].decided === false);

check('agents 12 and 13 are now real assignees the normaliser accepts',
  meetingEngine.normalizeActionItems([{ ...good, agent_id: 12 }], { rosterIds: roster }).items.length === 1 &&
  meetingEngine.normalizeActionItems([{ ...good, agent_id: 13 }], { rosterIds: roster }).items.length === 1);

/* ═══════════════ §5 the board task renderer ═══════════════════════════ */
section('§5 board task rendering');

const decidedBlock = meetingEngine.renderBoardTask(
  { agentId: 13, task: 'Audit', delivered: 'a file', dueDays: 3, decided: true, openQuestion: null },
  { id: 'PROPOSED-X-01', meetingType: 'weekly', dateStr: '2026-08-07', agentName: 'The Cyber Expert' }
);
check('a decided item renders as READY', /\*\*State:\*\* READY/.test(decidedBlock));
check('a decided item has "Blocked by: nothing"', /\*\*Blocked by:\*\* nothing/.test(decidedBlock));

const undecidedBlock = meetingEngine.renderBoardTask(
  { agentId: 13, task: 'Decide the front', delivered: 'a decision doc', dueDays: 2, decided: false, openQuestion: 'which audience?' },
  { id: 'PROPOSED-X-02', meetingType: 'weekly', dateStr: '2026-08-07', agentName: 'The Cyber Expert' }
);
check('an UNDECIDED item renders as NOT-READY', /\*\*State:\*\* NOT-READY/.test(undecidedBlock));
check('the open question lands in the Blocked by line', /which audience\?/.test(undecidedBlock));
check('a NOT-READY item explains that decided:false is a real outcome, not a parse failure',
  /not a parse failure/.test(undecidedBlock));

check('every rendered block carries all six required board fields',
  ['Assignee', 'State', 'Metric', 'Blocked by', 'Source', 'Task'].every((f) => decidedBlock.includes(`**${f}:**`)));
check('the Metric line names an artifact AND a deadline', /delivered = a file/.test(decidedBlock) && /office-days/.test(decidedBlock));

check('addOfficeDays skips Saturday', meetingEngine.addOfficeDays('2026-08-07', 1) === '2026-08-09',
  meetingEngine.addOfficeDays('2026-08-07', 1));

/* ═══════════ §6 commitMeetingReport goes through the guard [FAILS-OLD] ═ */
section('§6 the meeting report write is governed  [FAILS-OLD]');

const meetingSrc = read('workers/meeting-engine.js');

// OLD BEHAVIOUR, transcribed from the pre-2026-08-07 source. It built its own
// request against hardcoded constants and never called the guard.
function commitMeetingReport_OLD(env) {
  if (!env.GITHUB_TOKEN) return { committed: false, reason: 'GITHUB_TOKEN not configured' };
  return { calledGuard: false, tokenUsed: 'GITHUB_TOKEN', repo: 'office-AI-agents' };
}
const oldVerdict = commitMeetingReport_OLD({ GITHUB_TOKEN: 'x' });
check('[FAILS-OLD] the pre-change commitMeetingReport did NOT call the guard', oldVerdict.calledGuard === false);
check('[FAILS-OLD] ...and hardcoded its token rather than resolving it', oldVerdict.tokenUsed === 'GITHUB_TOKEN');

check('commitMeetingReport now delegates to commitFileToRepo',
  /async function commitMeetingReport[\s\S]{0,900}?return commitFileToRepo\(/.test(meetingSrc));
check('meeting-engine.js no longer builds an Authorization header anywhere',
  !/Authorization:\s*`Bearer/.test(meetingSrc));
check('meeting-engine.js no longer holds its own REPO_OWNER constant',
  !/^const REPO_OWNER =/m.test(meetingSrc));
check('the action_items consumer writes to BACK-OFFICE through the same path',
  /commitFileToRepo\(\s*\n?\s*env,\s*\n?\s*BACKOFFICE_REPO_NAME/.test(meetingSrc));

// The property that made this urgent: two destinations, one governed path.
check('meeting-engine.js now targets two repos and calls commitFileToRepo for both',
  (meetingSrc.match(/commitFileToRepo\(/g) || []).length >= 2);

/* ═══════════ §7 the roster change and its Track A protection [FAILS-OLD] ═ */
section('§7 roster 11→13 and the Track A protection  [FAILS-OLD]');

check('the roster now carries 13 agents', agentsConfig.agents.length === 13, `got ${agentsConfig.agents.length}`);
check('Agent 12 (The Workflow) is present', agentsConfig.agents.some((a) => a.id === 12 && a.name === 'The Workflow'));
check('Agent 13 (The Cyber Expert) is present', agentsConfig.agents.some((a) => a.id === 13 && a.name === 'The Cyber Expert'));
check('both new agents carry system_prompt_additions (the meeting engine reads this field)',
  [12, 13].every((id) => (agentsConfig.agents.find((a) => a.id === id).system_prompt_additions || '').length > 100));
check('both new agents carry behavioral_rules',
  [12, 13].every((id) => Array.isArray(agentsConfig.agents.find((a) => a.id === id).behavioral_rules)));
check('both new agents are marked out of the case rotation',
  [12, 13].every((id) => agentsConfig.agents.find((a) => a.id === id).in_case_rotation === false));

// qa-engine.js imports config JSON, so it cannot be imported here. Its
// filter is one line and is asserted against the SOURCE below as well, so a
// change there without a change here is caught rather than assumed.
const qaSrc = read('workers/qa-engine.js');
check('qa-engine.js getActiveQaAgents() carries the in_case_rotation clause',
  /a\.in_case_rotation !== false/.test(qaSrc));
const active = agentsConfig.agents.filter(
  (a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10 && a.in_case_rotation !== false
);
// 2026-08-11 (Phase 2, owner decision): admins 5,6,7,8,9,11 removed from the
// case rotation too — they solve support cases and their real roles (review,
// design, dispatch, judgment) went unenforced since the Q&A engine predates
// the bureaucracy. Rotation dropped from 10 to 4: only the field workers.
check('the Q&A rotation is now 4 agents (down from 10, six admins removed 2026-08-11)', active.length === 4, `got ${active.length}`);
check('…and they are exactly the four field workers, 1-4', active.map((a) => a.id).sort().join(',') === '1,2,3,4');
check('Workflow (12) is NOT in the Q&A rotation', !active.some((a) => a.id === 12));
check('Cyber Expert (13) is NOT in the Q&A rotation', !active.some((a) => a.id === 13));
check('the Architect (10) exclusion is unchanged', !active.some((a) => a.id === 10));
check('admins 5,6,7,8,9,11 are NOT in the Q&A rotation',
  ![5, 6, 7, 8, 9, 11].some((id) => active.some((a) => a.id === id)));

// FAILS-OLD: run the pre-change filter against today's config.
const oldActive = agentsConfig.agents.filter((a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10);
check('[FAILS-OLD pre-2026-08-07] the pre-change filter admits 12, 13 AND the six admins into the Q&A rotation',
  oldActive.some((a) => a.id === 12) && oldActive.some((a) => a.id === 13)
  && [5, 6, 7, 8, 9, 11].every((id) => oldActive.some((a) => a.id === id)),
  `old=${oldActive.length} new=${active.length}`);
check('[FAILS-OLD pre-2026-08-07] ...which is a Track A regression of exactly 8 agents (2 non-rotation admins + the 6 case-solving admins)',
  oldActive.length - active.length === 8);

// FAILS-OLD (2026-08-07 to 2026-08-10, yesterday's live production filter):
// the in_case_rotation clause existed but only 12/13 carried it — admins
// 5,6,7,8,9,11 still passed and were pulled into the rotation. This is the
// exact bug Phase 2 fixes, demonstrated against the SAME clause the source
// still carries (the source's regex match above did not change — only the
// config's per-agent flags did).
const oldActivePreP2 = agentsConfig.agents.filter(
  (a) => (a.status === 'active' || a.status === 'specified') && a.id !== 10 && ![12, 13].includes(a.id)
);
check('[FAILS-OLD pre-Phase-2] admins 5,6,7,8,9,11 WOULD still be in the rotation under yesterday\'s exclusion set',
  [5, 6, 7, 8, 9, 11].every((id) => oldActivePreP2.some((a) => a.id === id))
  && oldActivePreP2.length === 10,
  `pre-Phase-2 rotation would be ${oldActivePreP2.length} agents (the exact bug) vs today's ${active.length}`);
check('the four field-worker agents are byte-for-byte unaffected by the new clause',
  [1, 2, 3, 4].every((id) => agentsConfig.agents.find((a) => a.id === id).in_case_rotation === undefined));

check('the Architect is now seated at the weekly meeting', relationships.meeting_default_attendees.weekly.includes(10));
check('the Workflow is seated at the weekly meeting', relationships.meeting_default_attendees.weekly.includes(12));
check('closing_qa_review has an attendee list', Array.isArray(relationships.meeting_default_attendees.closing_qa_review));
check('closing_qa_review seats the QA and the Team Lead',
  [6, 7].every((id) => relationships.meeting_default_attendees.closing_qa_review.includes(id)));
check('the Architect is NOT added to the daily standup (he stays out of the dailies)',
  !relationships.meeting_default_attendees.daily_standup.includes(10));

/* ═══════════ §8 the Workflow's metrics — four measures, never one ═════ */
section('§8 the Workflow\'s productivity picture');

const NOW_FIXED = Date.parse('2026-08-07T12:00:00Z');
const metrics = meetingEngine.computeWorkflowMetrics({
  boardTasks: [
    { id: 'OB-001', state: 'READY', title: 'a', assignee: 'Agent 13', agentId: 13, urgency: null, metric: null },
    { id: 'OB-002', state: 'READY', title: 'b', assignee: 'Agent 12', agentId: 12, urgency: 'URGENT', metric: null },
    { id: 'OB-003', state: 'IN-PROGRESS', title: 'c', assignee: 'Agent 5', agentId: 5, metric: '3 office-days (2020-01-01) · delivered = x' },
    { id: 'OB-004', state: 'IN-PROGRESS', title: 'd', assignee: 'Agent 6', agentId: 6, metric: 'no date here' },
    { id: 'OB-005', state: 'NOT-READY', title: 'e', assignee: 'Agent 9', agentId: 9, blockedBy: 'an owner decision' },
  ],
  // Relative to NOW_FIXED, never to the wall clock — a verifier whose result
  // depends on what time it is run is not a verifier.
  activityByAgent: { 5: NOW_FIXED, 6: NOW_FIXED - 5 * 24 * 3600 * 1000 },
  rosterIds: [5, 6, 9, 12, 13],
  now: NOW_FIXED,
});

check('measure 1 — unstarted work is counted', metrics.unstarted.length === 2);
check('measure 1 — the URGENT one is flagged', metrics.unstarted.filter((t) => t.urgent).length === 1);
check('measure 2 — an agent with no recorded activity reports "never", not 0 days',
  metrics.idle.some((i) => i.agentId === 9 && i.days === null && /no activity ever recorded/.test(i.note)),
  JSON.stringify(metrics.idle));
check('measure 2 — an agent idle 5 days reports the day count', metrics.idle.some((i) => i.agentId === 6 && i.days === 5));
check('measure 3 — a past-due dispatched task is overdue', metrics.overdue.some((o) => o.id === 'OB-003'));
check('measure 3 — a task with an UNPARSEABLE deadline is reported as unknown, NOT assumed on time',
  metrics.undated.includes('OB-004'));
check('measure 4 — free capacity excludes agents holding in-progress work',
  !metrics.freeCapacity.includes(5) && !metrics.freeCapacity.includes(6) && metrics.freeCapacity.includes(13));
check('NOT-READY work is reported separately from capacity problems', metrics.stuck.some((s) => s.id === 'OB-005'));

const rendered = meetingEngine.renderWorkflowMetrics(metrics);
check('the rendered picture carries all four numbered measures',
  ['1. UNSTARTED', '2. AGENTS NOT WORKING', '3. PAST THE METRIC LINE', '4. FREE CAPACITY'].every((s) => rendered.includes(s)));
check('the rendered picture explicitly forbids collapsing to one percentage',
  /do NOT collapse these into one percentage/i.test(rendered));
check('there is NO single productivity percentage anywhere in the output',
  !/\b\d{1,3}%\s*(productiv|efficien)/i.test(rendered));
check('the hand-off path is stated — flag, delegate to whoever is present, Team Lead passes onward',
  /DELEGATES TO WHOEVER IS PRESENT/.test(rendered) && /Team Lead \(Agent 7\) may pass work onward/.test(rendered));

/* ═══════════ §9 source-level guarantees ═══════════════════════════════ */
section('§9 source-level guarantees');

check('NO Anthropic/Claude client is imported by the meeting engine (the Architect provider rule)',
  !/from '\.\/claude-client\.js'/.test(meetingSrc) && !/anthropic/i.test(meetingSrc.replace(/ANTHROPIC\.|NEVER USE\s+ANTHROPIC|Anthropic is reserved|to Anthropic|an Anthropic|no Anthropic|Anthropic client/gi, '')),
  'meeting-engine.js must have no Anthropic path — see runMeeting()\'s header');

const runnerSrc = read('workers/agent-runner.js');
check('agent-runner.js no longer defines commitFileToRepo (it imports it)',
  !/^async function commitFileToRepo/m.test(runnerSrc));
check('agent-runner.js imports commitFileToRepo from repo-write.js',
  /import \{[\s\S]*?commitFileToRepo,?[\s\S]*?\} from '\.\/repo-write\.js'/.test(runnerSrc));

const repoWriteSrc = read('workers/repo-write.js');
check('repo-write.js is the only worker that builds a write Authorization header',
  /Authorization: `Bearer \$\{env\[verdict\.tokenSecret\]\}`/.test(repoWriteSrc));
// Scoped to the executable body: this file's HEADER deliberately quotes the
// old `Bearer ${env.GITHUB_TOKEN}` line as the thing that was wrong, so a
// whole-file test would trip on the very documentation of the fix.
const repoWriteBody = repoWriteSrc.slice(repoWriteSrc.indexOf('export async function commitFileToRepo'));
check('repo-write.js resolves the token from the verdict, never from a constant',
  !/Authorization: `Bearer \$\{env\.GITHUB_TOKEN\}`/.test(repoWriteBody));
check('...and the header still documents the old hardcoded line it replaced',
  /Bearer \$\{env\.GITHUB_TOKEN\}/.test(repoWriteSrc.slice(0, repoWriteSrc.indexOf('export const REPO_OWNER'))));

// Mirror-drift guard: verify-permissions.js hand-copies the two maps. Now
// that the real ones moved to repo-write.js, an undetected divergence would
// mean the permissions verifier tests a map nothing uses.
const permVerifySrc = read('scripts/verify-permissions.js');
for (const repo of ['office-AI-agents', 'back-office-AI-agents', 'warehouse-office-AI-agents']) {
  check(`verify-permissions.js's mirrored map still names "${repo}" (drift guard)`,
    permVerifySrc.includes(repo));
}
for (const secret of ['GITHUB_TOKEN', 'BACKOFFICE_REPO_TOKEN', 'WAREHOUSE_REPO_TOKEN']) {
  check(`repo-write.js maps ${secret} (drift guard vs verify-permissions.js)`,
    repoWriteSrc.includes(secret) && permVerifySrc.includes(secret));
}

check('WAREHOUSE_REPO_TOKEN is mapped and this session did not set it',
  /WAREHOUSE_REPO_TOKEN/.test(repoWriteSrc) && /NOT SET on the Worker/.test(repoWriteSrc));

// DRIFT GUARD for the one duplication this session introduced on purpose.
// office-context.js may not import provider-common.js (verify-providers.js
// enforces that nothing outside the router touches the provider layer), so it
// carries its own copy of estimateTokens(). Same remedy plan item 1.8 used for
// PROVIDER_USAGE_TABLE_SQL: extract both and compare character-for-character,
// so a change to one that is not made to the other FAILS here rather than
// drifting silently.
const bodyOf = (src, name) => {
  const i = src.indexOf(`function ${name}(text) {`);
  if (i === -1) return null;
  return src.slice(i, src.indexOf('\n}', i) + 2).replace(/\s+/g, ' ').trim();
};
const ocEstimator = bodyOf(read('workers/office-context.js'), 'estimateTokens');
const pcEstimator = bodyOf(read('workers/provider-common.js'), 'estimateTokens');
check('office-context.js carries its own estimateTokens (it may not import the provider layer)',
  ocEstimator !== null);
check('...and it is character-for-character identical to provider-common.js\'s',
  ocEstimator !== null && pcEstimator !== null && ocEstimator === pcEstimator,
  `office-context: ${ocEstimator}\n            provider-common: ${pcEstimator}`);
check('office-context.js imports nothing from the provider layer',
  !/from\s+['"][^'"]*provider-common\.js['"]/.test(read('workers/office-context.js')));

const agentBaseSrc = read('agents/agent-base.js');
check('agent-base.js takes the office context CACHE-ONLY (no allowFetch on the per-call path)',
  /getOfficeContext\(this\.env,\s*\{\s*shape: 'agent'[^}]*\}\)/.test(agentBaseSrc) &&
  !/getOfficeContext\(this\.env[^)]*allowFetch/.test(agentBaseSrc));
// The window was {0,300} and the A11 `clearance` argument (plus the comment
// explaining it) pushed the try/catch span past it. Widened to 1200, and
// recorded rather than silently retuned: this is a TEXT-PROXIMITY PROXY, the
// same shape agent-runner.js's `report_block` comment already flags — a check
// that a comment can break can also pass by coincidence of layout. Its intent
// is right and there is no cheap way to assert "wrapped in try/catch" from
// source text without one.
check('agent-base.js wraps the office-context call so it can never break a client answer',
  /try\s*\{[\s\S]{0,1200}getOfficeContext[\s\S]{0,1200}catch/.test(agentBaseSrc));
check('agent-base.js passes the agent\'s CLEARANCE so A11 rank filtering has an input',
  /getOfficeContext\(this\.env,[\s\S]{0,800}clearance:/.test(agentBaseSrc));
check('getDbContext() was left exactly as it was (still the inert placeholder)',
  /async getDbContext\(_query\) \{\s*return '';\s*\}/.test(agentBaseSrc));

/* ══════════════════════════════════════════════════════════════════════════
   §10 — THE OFFICE→OWNER QUESTIONS CHANNEL, AND THE OFFER MARKER
   Added 2026-08-10 with channel/to-owner/. Two mechanisms, one section,
   because they share one property worth proving together: NEITHER may change
   what a board task's State means.
   ══════════════════════════════════════════════════════════════════════════ */
section('§10 the owner-questions channel and the offer marker');

const GOOD_Q = `# OPEN QUESTIONS — office → owner

**Counts:** 9 entries — deliberately WRONG, to prove counts are derived.

### Q-001 — which products does REQ-004 mean?

- **Asked by:** Agent 12 — The Workflow
- **Date:** 2026-08-10
- **Blocking:** REQ-004 · plan 4.5 · OB-016 · OB-024
- **What I need:** a decision
- **If no answer comes:** REQ-004 goes last in the order. The justification says the position is provisional.
- **Answer:** —

### Q-002 — ~~does "PR" mean public relations?~~ — ANSWERED

- **Asked by:** Agent 9 — The Designer
- **Date:** 2026-08-09
- **Blocking:** REQ-006
- **What I need:** a clarification
- **If no answer comes:** the office assumes public relations and marks it provisional.
- **Answer:** *(2026-08-09, owner)* Public relations.

### Q-003 — may we raise the meeting budget? — DECLINED

- **Asked by:** Agent 8 — The Lead QA
- **Date:** 2026-08-09
- **Blocking:** nothing — a preference.
- **What I need:** an approval
- **If no answer comes:** the budget stays at 1200 and the measurement is reported.
- **Answer:** *(2026-08-10, owner)* Not now.
`;

const qs = officeContext.parseOpenQuestions(GOOD_Q);
check('parseOpenQuestions reads a well-formed questions file', qs.ok === true, qs.reason);
check('parseOpenQuestions reads all three entries', qs.ok && qs.questions.length === 3, `got ${qs.questions?.length}`);
check('an entry with no heading marker is OPEN (the only defaulted state)',
  qs.ok && qs.questions[0].open === true && qs.questions[0].marker === null);
check('ANSWERED is read from the heading suffix, not from the Answer field',
  qs.ok && qs.questions[1].marker === 'ANSWERED' && qs.questions[1].open === false);
check('DECLINED is a real outcome and is NOT counted as open',
  qs.ok && qs.questions[2].marker === 'DECLINED' && qs.questions[2].open === false);
check('the strikethrough and the marker are stripped from the question text',
  qs.ok && !/~~|ANSWERED/.test(qs.questions[1].question), qs.questions[1]?.question);
check('parseOpenQuestions DERIVES counts rather than reading the file\'s own Counts line',
  qs.ok && qs.counts.total === 3 && qs.counts.open === 1 && qs.counts.closed === 2,
  JSON.stringify(qs.counts));
check('the asking agent id is extracted so an agent can see its own questions',
  qs.ok && qs.questions[0].agentId === 12);

// THE REFUSAL THAT MATTERS. The contract makes the fallback mandatory because a
// question with no fallback is a stall dressed as a question — so an entry
// missing it must not reach a prompt, where it would put an agent in front of an
// open question with no path but to wait.
const noFallback = officeContext.parseOpenQuestions(
  GOOD_Q.replace('- **If no answer comes:** REQ-004 goes last in the order. The justification says the position is provisional.\n', '')
);
check('an entry with NO "If no answer comes" line is REFUSED, not rendered without it',
  noFallback.ok === true && !noFallback.questions.some((q) => q.id === 'Q-001'));
check('...and the refusal is REPORTED, naming the missing field',
  noFallback.malformed.some((s) => /Q-001/.test(s) && /If no answer comes/.test(s)),
  JSON.stringify(noFallback.malformed));
const noAsker = officeContext.parseOpenQuestions(GOOD_Q.replace('- **Asked by:** Agent 12 — The Workflow\n', ''));
check('an entry with no readable "Asked by" line is REFUSED',
  noAsker.ok === true && !noAsker.questions.some((q) => q.id === 'Q-001'));

// An EMPTY channel is healthy, not broken. Reporting it as a parse failure would
// put a spurious error into every prompt for as long as the office had nothing
// to ask.
const emptyQ = officeContext.parseOpenQuestions('# OPEN QUESTIONS\n\nNothing open.\n');
check('an EMPTY questions file parses ok with zero entries (a healthy state, not an error)',
  emptyQ.ok === true && emptyQ.questions.length === 0 && emptyQ.counts.open === 0);
check('parseOpenQuestions still refuses a non-string / empty input',
  officeContext.parseOpenQuestions('').ok === false);

// ── The rendering contract: the count survives, the answered TEXT does not ──
const qSnap = { fetched_at: Date.now(), board, requirements: reqs, questions: qs, errors: [] };
const qMeeting = officeContext.buildOfficeContext(qSnap, 'meeting');
const qAgent = officeContext.buildOfficeContext(qSnap, 'agent', { agentId: 12 });
check('the meeting shape names the open-question count', /1 awaiting an answer/.test(qMeeting.text || ''));
check('...and the closed count, so "answered eleven" and "never asked" cannot look alike',
  /2 already answered/.test(qMeeting.text || ''));
check('an ANSWERED question\'s TEXT does not reach the prompt (history lives in the file)',
  !/does "PR" mean public relations/i.test(qMeeting.text || ''));
check('the open question\'s text DOES reach the prompt', /which products does REQ-004 mean/i.test(qMeeting.text || ''));
check('the prompt tells the agent to check the list before asking again (the whole purpose)',
  /BEFORE asking the client anything/.test(qMeeting.text || ''));
check('the per-agent shape keeps the questions HEADLINE even when it drops the list',
  /awaiting an answer/.test(qAgent.text || ''), `agent text: ${(qAgent.text || '').slice(0, 200)}`);
check('adding the questions section did not push the meeting shape over budget',
  qMeeting.tokens <= officeContext.BUDGETS.meeting, `${qMeeting.tokens}/${officeContext.BUDGETS.meeting}`);

// firstSentence(): a truncated commitment must SAY it was truncated.
check('an abridged fallback carries a visible marker, never a silent clip',
  /\[…full text in the file\]/.test(qMeeting.text || ''));

// ── THE OFFER MARKER: a marker, never a state ──────────────────────────────
const OFFER_BOARD = GOOD_BOARD
  .replace('- **State:** READY', '- **State:** READY\n- **Offered:** 2026-08-10 · available to the Architect\'s next unattended run · warehouse task `x`');
const offerBoard = officeContext.parseBoard(OFFER_BOARD);
check('parseBoard reads the optional Offered field', offerBoard.ok && !!offerBoard.tasks[0].offered);
check('an OFFERED task is still exactly as READY as it was — the offer is not a state',
  offerBoard.ok && offerBoard.tasks[0].state === 'READY');
check('...and the READY count is UNCHANGED by the offer (the "not blocked" half of the rule)',
  offerBoard.ok && board.ok && offerBoard.counts.READY === board.counts.READY,
  `${offerBoard.counts?.READY} vs ${board.counts?.READY}`);
const DISPATCHED_BOARD = GOOD_BOARD
  .replace('- **State:** READY', '- **State:** IN-PROGRESS\n- **Dispatched:** 2026-08-09 · held by headless Architect run · deadline 2026-08-13');
const dispBoard = officeContext.parseBoard(DISPATCHED_BOARD);
check('parseBoard reads the Dispatched line so the office can see WHO holds a task',
  dispBoard.ok && /held by headless Architect run/.test(dispBoard.tasks[0].dispatched || ''));
const dispSnap = { fetched_at: Date.now(), board: dispBoard, requirements: reqs, questions: emptyQ, errors: [] };
const dispText = officeContext.buildOfficeContext(dispSnap, 'report').text || '';
check('the holder is RENDERED — an IN-PROGRESS task with no visible holder is a race the prompt invites',
  /HELD: 2026-08-09/.test(dispText), dispText.slice(0, 300));
const offerSnap = { fetched_at: Date.now(), board: offerBoard, requirements: reqs, questions: emptyQ, errors: [] };
const offerText = officeContext.buildOfficeContext(offerSnap, 'report').text || '';
check('an offered task is rendered as STILL CLAIMABLE by the office, not as taken',
  /OFFERED/.test(offerText) && /still yours to claim/.test(offerText));

// The questions channel's malformed entries must reach the same log line the
// board's and the requirements' do — three sources, one channel, no fourth
// mechanism.
const ocSrc = read('workers/office-context.js');
check('questions malformed entries join the SAME malformed log line as board and requirements',
  /snapshot\?\.questions\?\.malformed/.test(ocSrc));
check('a 404 on the questions file is NOT reported as an error (empty channel is healthy)',
  /HTTP 404/.test(ocSrc) && /questionsFile\.reason/.test(ocSrc));

/* ═══════ §11 POLICY MECHANISM — B5, A7's branch half, A12's roster ══════
 *
 * Added 2026-08-10 with the policy wiring. Three rules that each needed code,
 * pinned in one place because they were built in one session and a later reader
 * needs to find them together.
 */
section('§11 policy mechanism — B5 refusals, A7 branches, A12 attendance');

/* ── B5: refusal recording, office-wide ────────────────────────────────── */
const improvementLoop = await import('../workers/improvement-loop.js');
const lifecycle = await import('../workers/deliverable-lifecycle.js');

check('B5 — `refusal` is a first-class event type on the office-wide table',
  improvementLoop.EVENT_TYPES.includes('refusal'));
check('B5 — there is ONE validator for a refusal, borrowed not copied',
  /from '\.\/deliverable-lifecycle\.js'/.test(read('workers/improvement-loop.js')));

// The strictness IS the mechanism. A refusal with no character line must be
// refused, and the refusal-to-record must reach the caller.
const noLine = await improvementLoop.recordRefusalEvent({}, {
  agentId: 6, who: 'Agent 6 — The QA', declined: 'the deliverable', characterLine: '',
});
check('B5 — a refusal with NO character line is REFUSED, not stored',
  noLine.recorded === false && noLine.refusalLost === true);
check('B5 — ...and the refusal-to-record names why, so the caller can report the loss',
  /character/i.test(noLine.reason || ''), noLine.reason);
const noWho = await improvementLoop.recordRefusalEvent({}, {
  agentId: 6, declined: 'the deliverable', characterLine: 'I do not sign off on what I have not read.',
});
check('B5 — a refusal that names no refuser is REFUSED', noWho.recorded === false);

// With a valid refusal and the flag OFF, nothing is written — but the reason
// must be the FLAG, not a validation failure. Those are different states and
// collapsing them would hide a malformed refusal behind a disabled switch.
const validOff = await improvementLoop.recordRefusalEvent({}, {
  agentId: 6, who: 'Agent 6 — The QA', declined: 'the office-site deliverable at round 2',
  characterLine: 'I do not sign off on what I have not read end to end.',
});
check('B5 — a VALID refusal with the loop off is refused by the FLAG, not by validation',
  validOff.recorded === false && validOff.reason === 'improvement_loop_disabled');

check('B5 — the rendered line is the office\'s ONE shape (same renderer as the lifecycle)',
  /refusal: WHO declined WHAT, and the line of their character it came from: "LINE"/.test(
    lifecycle.renderRefusal({ who: 'WHO', declined: 'WHAT', character_line: 'LINE' })));

const meSrc11 = read('workers/meeting-engine.js');
check('B5 — the meeting prompt ASKS for refusals in the required shape',
  /"refusals": \[\{ "agent_id"/.test(meSrc11) && /character_line/.test(meSrc11));
check('B5 — the prompt forbids inventing a character line',
  /IF YOU CANNOT NAME THE LINE, OMIT THE ENTRY/.test(meSrc11));
check('B5 — refusals are recorded BEFORE the meeting row is persisted (the fragile record first)',
  meSrc11.indexOf('recordMeetingRefusals(') < meSrc11.indexOf('await persistMeeting(env'));
check('B5 — a refusal naming a non-attendee is dropped, not attributed',
  /was not an attendee/.test(meSrc11));
check('B5 — the loss count reaches the caller, so "we lost one" can be reported',
  /refusals,\n    report:/.test(meSrc11) || /\n    refusals,/.test(meSrc11));

/* ── A7: the branch rule's visibility half ─────────────────────────────── */
const branchWatch = await import('../workers/branch-watch.js');

const twoBranches = [
  { repo: 'office-AI-agents', defaultBranch: 'master', branches: [{ branch: 'feat/a', ageDays: 12, sha: 'abc1234' }, { branch: 'feat/b', ageDays: 3, sha: 'def5678' }] },
  { repo: 'back-office-AI-agents', defaultBranch: 'main', branches: [] },
  { repo: 'warehouse-office-AI-agents', unreadable: 'WAREHOUSE_REPO_TOKEN is deliberately unset.' },
];
const bv = branchWatch.branchVerdict(twoBranches);
check('A7 — two active branches in one project is reported as a VIOLATION', bv.violation === true);
check('A7 — a project with any active branch is blocked from opening a new one',
  bv.blockedFromNew.includes('office-AI-agents') && !bv.blockedFromNew.includes('back-office-AI-agents'));
check('A7 — an unreadable repo is listed as unreadable, never as clean',
  bv.unreadable.includes('warehouse-office-AI-agents'));

const bs = branchWatch.renderBranchSection(twoBranches);
check('A7 — the section renders ages, which is the half A7 asks for by name',
  /12 day\(s\) old/.test(bs) && /3 day\(s\) old/.test(bs));
check('A7 — the violation is stated in the report, not left to be inferred',
  /A7 VIOLATION/.test(bs));
check('A7 — "not checked from here" is distinguished from "no branches"',
  /not "no branches"/.test(bs));
check('A7 — a repo with no branches says so explicitly',
  /no open branches/.test(bs));

// An unknown age must never render as 0 — a six-week-old branch shown as
// today's is worse than no age at all.
const unknownAge = branchWatch.parseBranchRows([{ name: 'x', commit: { sha: 'aaaaaaa' } }], {}, 'master');
check('A7 — an unreadable tip date yields ageDays:null, never 0', unknownAge[0].ageDays === null);
check('A7 — ...and renders as "age unknown"',
  /age unknown/.test(branchWatch.renderBranchSection([{ repo: 'r', defaultBranch: 'master', branches: unknownAge }])));
check('A7 — the default branch is EXCLUDED, and it is passed in rather than guessed',
  branchWatch.parseBranchRows([{ name: 'main', commit: {} }, { name: 'feat/x', commit: {} }], {}, 'main').length === 1);

const arSrc11 = read('workers/agent-runner.js');
check('A7 — the daily report actually renders the branch section (a section nobody calls is the defect)',
  /renderBranchSection\(branches\)/.test(arSrc11));
check('A7 — the branch fetch cannot take down the daily report it rides in',
  /fetchOpenBranches\(env\)\.catch\(/.test(arSrc11));
check('A7 — the warehouse gap is declared in code, not discovered later',
  /expectedUnreadable/.test(read('workers/branch-watch.js')));

/* ── A12: "The Workflow attends all four" ──────────────────────────────── */
//
// FOUND ALREADY DONE, 2026-08-10, and pinned rather than "fixed". The session
// brief said the Workflow "was added to the roster two days ago and the
// attendee lists were never updated". relationships.json's own
// `_meta_meeting_attendees_2026_08_07` records that they WERE updated on
// 2026-08-07, and agent 12 is seated at all four. The prompt was wrong and the
// config was right; what was missing was a check saying so, which is why the
// claim was believable. Only `weekly` was pinned before this.
const FOUR = ['daily_standup', 'closing_qa_review', 'weekly', 'monthly'];
for (const m of FOUR) {
  check(`A12 — the Workflow (12) is seated at "${m}"`,
    Array.isArray(relationships.meeting_default_attendees[m])
    && relationships.meeting_default_attendees[m].includes(12));
}
check('A12 — all four are meeting types the engine can actually run',
  FOUR.every((m) => new RegExp(`^  ${m}: \\{`, 'm').test(meSrc11)));
check('A12 — all four get the office context (a meeting that cannot see the office decides nothing)',
  /OFFICE_CONTEXT_MEETINGS = new Set\(\[\s*'daily_standup', 'closing_qa_review', 'weekly', 'monthly'/.test(meSrc11));

/* ════════════════════════════════════════════════════════════════════════
 * §13. THE OUTPUT CENSUS (added 2026-08-10)
 *
 * `computeWorkflowMetrics()`'s measure 2 already asked "who has not worked" and
 * measured it from ACTIVITY rows — every Q&A ask counts. The Designer produced
 * nothing her role is for, for two months, and never once read as idle, because
 * her asks kept the row warm. THE CENSUS IS THE COMPLETION: output, over a
 * stated window, BY KIND.
 *
 * The scenarios below are built around that exact case and carry [FAILS-OLD]
 * where they distinguish the new measure from the old one — because a test that
 * merely describes a new function is not a test that catches the bug it was
 * written for.
 * ════════════════════════════════════════════════════════════════════════ */
console.log('\n--- §13. The output census: OUTPUT by kind, not activity ---');

const { computeOutputCensus, renderOutputCensus } = meetingEngine;
const CENSUS_DAY = 24 * 60 * 60 * 1000;
const CENSUS_NOW = Date.parse('2026-08-10T12:00:00Z');

check('§13 — computeOutputCensus is exported (the capability manifest names this symbol)',
  typeof computeOutputCensus === 'function');

/* THE DESIGNER'S CASE, as it actually stood on 2026-08-09: plenty of Q&A output,
 * none of it a visual_asset. */
const designerCase = computeOutputCensus({
  rosterIds: [9, 12],
  outputByAgent: {
    9: { lastAt: CENSUS_NOW - (1 * CENSUS_DAY), kinds: { case_answer: 40, gap_hebrew: 3 } },
    12: { lastAt: CENSUS_NOW - (2 * CENSUS_DAY), kinds: { weekly: 1 } },
  },
  roleKinds: { 9: ['visual_asset', 'front_publication', 'design_flag'], 12: ['dispatch', 'weekly', 'board_task'] },
  windowDays: 7,
  now: CENSUS_NOW,
});

/** VERBATIM transcription of the old measure's decision: last ACTIVITY, any kind,
 *  flagged only when a whole day has passed. */
const oldIdleTest = (lastAt) => Math.floor((CENSUS_NOW - lastAt) / CENSUS_DAY) >= 1;
check('§13 [FAILS-OLD] the old measure flagged the Designer only for BEING QUIET, on any activity at all',
  oldIdleTest(CENSUS_NOW - (1 * CENSUS_DAY)) === true);
check('§13 [FAILS-OLD] ...and one question that day cleared it, whatever she had actually produced',
  oldIdleTest(CENSUS_NOW - (2 * 60 * 60 * 1000)) === false);

const nine = designerCase.agents.find((a) => a.agentId === 9);
check('§13 [new] the Designer is PRODUCING_OFF_ROLE — producing, none of it her job',
  nine.verdict === 'PRODUCING_OFF_ROLE', JSON.stringify(nine));
check('§13 [new] ...and she appears in the offRole list, which is what a meeting reads',
  designerCase.offRole.map((a) => a.agentId).includes(9));
check('§13 [new] ...and she is NOT in `producing`, so a healthy-looking count cannot absorb her',
  !designerCase.producing.map((a) => a.agentId).includes(9));
check('§13 [new] the Workflow, producing a kind his role IS for, reads PRODUCING',
  designerCase.agents.find((a) => a.agentId === 12).verdict === 'PRODUCING');
check('§13 [new] the rendered census names the off-role state as the one the old measure could not see',
  /THIS IS THE STATE THE OLD MEASURE COULD NOT SEE/.test(renderOutputCensus(designerCase)));

/* NEVER vs SILENT — two different facts, and only one is alarming. */
const neverVsSilent = computeOutputCensus({
  rosterIds: [1, 2, 13],
  outputByAgent: {
    1: { lastAt: CENSUS_NOW - (30 * CENSUS_DAY), kinds: { case_answer: 5 } },
    2: { lastAt: CENSUS_NOW - (1 * CENSUS_DAY), kinds: { case_answer: 5 } },
  },
  roleKinds: { 1: ['case_answer'], 2: ['case_answer'], 13: ['finding', 'security_review'] },
  windowDays: 7,
  now: CENSUS_NOW,
});
check('§13 — an agent with NO output row ever reads NEVER, not "0 days ago"',
  neverVsSilent.agents.find((a) => a.agentId === 13).verdict === 'NEVER'
  && neverVsSilent.agents.find((a) => a.agentId === 13).days === null);
check('§13 — an agent that produced 30 days ago reads SILENT, with the day count',
  neverVsSilent.agents.find((a) => a.agentId === 1).verdict === 'SILENT'
  && neverVsSilent.agents.find((a) => a.agentId === 1).days === 30);
check('§13 — NEVER and SILENT are reported in separate lists (different problems, different responses)',
  neverVsSilent.never.length === 1 && neverVsSilent.silent.length === 1);

/* "Could not check" must never share a number with "checked and fine" — this
 * project's single most-repeated defect shape. */
const noRoleKinds = computeOutputCensus({
  rosterIds: [5],
  outputByAgent: { 5: { lastAt: CENSUS_NOW, kinds: { case_answer: 2 } } },
  roleKinds: {},
  windowDays: 7,
  now: CENSUS_NOW,
});
check('§13 — an agent with NO declared output_kinds is reported as uncheckable, not as passing',
  noRoleKinds.uncheckable.length === 1 && noRoleKinds.offRole.length === 0,
  JSON.stringify(noRoleKinds.agents));
check('§13 — ...and its note says the off-role check could NOT run rather than that it passed',
  /could NOT run/.test(noRoleKinds.agents[0].note || ''));
check('§13 — ...and the rendered census carries a "could not be checked" section',
  /COULD NOT BE CHECKED/.test(renderOutputCensus(noRoleKinds)));

/* Dormancy is passed in, never hardcoded. */
const dormantCensus = computeOutputCensus({
  rosterIds: [10], outputByAgent: {}, roleKinds: { 10: ['guide_review'] }, now: CENSUS_NOW,
});
check('§13 — the Architect is excluded from the alarm lists as deliberately dormant',
  dormantCensus.never.length === 0 && dormantCensus.dormantExcluded.includes(10));
check('§13 — ...but he is still IN the per-agent list, so his state is visible rather than hidden',
  dormantCensus.agents.some((a) => a.agentId === 10 && a.dormant === true));

/* The census must reach a prompt. A measure computed and never rendered is the
 * defect this whole session is about, and a THIRD instance of it was found HERE
 * while adding the census: quarterly, semi_yearly and yearly were all in
 * WORKFLOW_METRICS_MEETINGS and rendered nothing at all. */
console.log('\n--- §13b. Every meeting that COMPUTES the measures also RENDERS them ---');

const meSrc13 = readFileSync(path.join(root, 'workers/meeting-engine.js'), 'utf8');
const metricsSet = /WORKFLOW_METRICS_MEETINGS = new Set\(\[([^\]]*)\]/.exec(meSrc13);
const computeFor = ((metricsSet ? metricsSet[1] : '').match(/'([a-z_]+)'/g) || []).map((x) => x.replace(/'/g, ''));
check('§13b — WORKFLOW_METRICS_MEETINGS still names six meeting types', computeFor.length === 6, computeFor.join(','));
for (const m of computeFor) {
  const builder = new RegExp('^  ' + m + ': \\(data\\) =>([\\s\\S]*?)\\n  [a-z_]+: \\(data\\) =>', 'm').exec(meSrc13)
    || new RegExp('^  ' + m + ': \\(data\\) =>([\\s\\S]*?)\\n\\};', 'm').exec(meSrc13);
  check('§13b — "' + m + '" renders data.workflowMetrics (it COMPUTES them; computing into a void is §7.2)',
    !!builder && /data\.workflowMetrics/.test(builder[1]), m);
  check('§13b — "' + m + '" renders data.outputCensus too',
    !!builder && /data\.outputCensus/.test(builder[1]), m);
}
check('§13b — the census draws its role kinds from the SAME manifest the capability audit reads',
  /capability-manifest\.json/.test(meSrc13) && /output_kinds/.test(meSrc13));
check('§13b — the fix records WHY membership and rendering must agree',
  /computed, for three meeting types,[\s\S]{0,24}and consumed by nobody/.test(meSrc13));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
process.exit(0);
