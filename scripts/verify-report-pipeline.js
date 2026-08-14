/**
 * scripts/verify-report-pipeline.js — dry-run verification for the report
 * pipeline (workers/report-pipeline.js, 2026-08-08).
 *
 * NO NETWORK, NO D1, NO KV, NO MODEL CALLS. `globalThis.fetch` is replaced
 * with a tripwire that throws, so "no network calls" is PROVEN rather than
 * claimed — the same construction scripts/verify-providers.js and
 * verify-routing.js use.
 *
 * ── WHAT MAKES THIS A TEST AND NOT A DESCRIPTION ─────────────────────────
 *
 * This project's own rule, from the 2026-08-06 guard correction:
 *
 *     A TEST THAT DESCRIBES A FIX IS NOT A TEST THAT CATCHES A BUG.
 *     Transcribe the pre-fix logic and run the new scenario table against it.
 *     If nothing fails, the table is documentation.
 *
 * §2 below does exactly that for the projects gap: the pre-change call site
 * is transcribed verbatim and the same assertions are run against it. Three
 * scenarios fail against the old path, which is what makes them evidence.
 *
 * Scenarios that exercise a NEW capability are labelled `[new]` rather than
 * `[FAILS-OLD]`, because "there was nothing here before" and "the old code
 * got this wrong" are different facts and only one of them is a caught bug.
 *
 * Run: node scripts/verify-report-pipeline.js
 */

import { readFileSync } from 'node:fs';

/* ── Network tripwire ─────────────────────────────────────────────────── */
const NETWORK_CALLS = [];
globalThis.fetch = (...args) => {
  NETWORK_CALLS.push(String(args[0]));
  throw new Error(`NETWORK CALL ATTEMPTED in a dry-run verifier: ${String(args[0])}`);
};

const rp = await import('../workers/report-pipeline.js');
const officeContext = await import('../workers/office-context.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/* ══════════════════════════════════════════════════════════════════════════
 * §1  THE SWITCH — off is off, and off is the default
 * ═════════════════════════════════════════════════════════════════════════ */
section('§1  The switch (report_pipeline_enabled) — default OFF');

const kv = (value) => ({ SIM_KV: { get: async () => value } });

check('[new] no SIM_KV binding -> OFF', (await rp.reportPipelineEnabled({})) === false);
check('[new] absent key -> OFF', (await rp.reportPipelineEnabled(kv({}))) === false);
check('[new] null stored state -> OFF', (await rp.reportPipelineEnabled(kv(null))) === false);
check('[new] the STRING "true" does not enable it (=== true, not truthiness)',
  (await rp.reportPipelineEnabled(kv({ report_pipeline_enabled: 'true' }))) === false);
check('[new] 1 does not enable it',
  (await rp.reportPipelineEnabled(kv({ report_pipeline_enabled: 1 }))) === false);
check('[new] a throwing KV read -> OFF, not an exception',
  (await rp.reportPipelineEnabled({ SIM_KV: { get: async () => { throw new Error('kv down'); } } })) === false);
check('[new] boolean true -> ON', (await rp.reportPipelineEnabled(kv({ report_pipeline_enabled: true }))) === true);

// The 2026-08-08 lesson: a flag with no authenticated route is not shipped.
const runnerSrc = read('workers/agent-runner.js');
check("[new] 'report_pipeline_toggle' trigger case exists (the AUTHENTICATED route)",
  /case 'report_pipeline_toggle':/.test(runnerSrc));
check("[new] 'report_pipeline_status' read-back exists",
  /case 'report_pipeline_status':/.test(runnerSrc));
check("[new] 'report_block' supervised trigger exists (test before enabling, not after)",
  /case 'report_block':/.test(runnerSrc));
check('[new] report_pipeline_enabled is on the updateSimulationState allow-list',
  /allowedKeys = \[[^\]]*'report_pipeline_enabled'/.test(runnerSrc));
// The operational-path check. It lives in the PRIVATE repo, which may simply
// not be checked out beside this one — so an absent file is reported as SKIP,
// not as PASS and not as FAIL. "Not checked" and "checked and fine" must never
// look the same; that confusion is the whole reason this check exists.
{
  let switchesDoc = null;
  try {
    switchesDoc = readFileSync(new URL('../../back-office-AI-agents/docs/procedures/SIMULATION-SWITCHES.md', import.meta.url), 'utf8');
  } catch { /* private repo not present */ }
  if (switchesDoc === null) {
    console.log('  SKIP  SIMULATION-SWITCHES.md not reachable (back-office repo not checked out) — operational path NOT verified');
  } else {
    check('[new] SIMULATION-SWITCHES.md names the toggle (a switch is not shipped until the way to flip it is written down)',
      /report_pipeline_toggle/.test(switchesDoc));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * §2  THE PROJECTS GAP — transcribed pre-change logic, same assertions
 *
 * Before 2026-08-08, `projects` was passed by ONE of five getOfficeContext()
 * callers (meeting-engine.js) and by NONE of the three report sites or the
 * per-agent site. office-context.js was built precisely because the office's
 * projects reached zero prompt-assembly sites; the fix reinstated that state
 * for four of five callers.
 *
 * The transcription below is the OLD call — literally the same function with
 * `projects` omitted, which is exactly what the old call sites did.
 * ═════════════════════════════════════════════════════════════════════════ */
section('§2  The projects gap — new assertions run against the transcribed pre-change call');

const snapshot = {
  fetched_at: Date.now(),
  board: {
    ok: true,
    counts: { total: 3, READY: 2, BLOCKED: 1, 'IN-PROGRESS': 0, 'NOT-READY': 0, DONE: 0 },
    tasks: [
      { id: 'OB-001', title: 'Audit every gate', state: 'READY', assignee: 'Agent 13 — The Cyber Expert', agentId: 13, urgency: null, metric: null, blockedBy: null },
      { id: 'OB-024', title: 'Propose the delivery order', state: 'READY', assignee: 'Agent 12 — The Workflow', agentId: 12, urgency: null, metric: null, blockedBy: null },
      { id: 'OB-013', title: "Propose the Front's structure", state: 'BLOCKED', assignee: 'Agent 9 — The Designer', agentId: 9, urgency: null, metric: null, blockedBy: 'routing carrying real work' },
    ],
    malformed: [],
  },
  requirements: {
    ok: true,
    due: '2026-09-07',
    requirements: [
      { id: 'REQ-001', title: 'A way for the office to communicate with the owner', urgent: true, crossCutting: false, status: 'in progress' },
      { id: 'REQ-003', title: "The office's own site", urgent: false, crossCutting: false, status: 'in progress' },
    ],
    malformed: [],
  },
  errors: [],
};

const PROJECTS = [
  { key: 'data-center', name: 'Data Center', role: 'client project', visibility: 'private' },
  { key: 'notebook-x', name: 'Notebook-X', role: 'client project', visibility: 'private' },
];

// OLD — transcription of every report call site as it stood before this change.
const oldReportContext = officeContext.buildOfficeContext(snapshot, 'report', {});
// NEW
const newReportContext = officeContext.buildOfficeContext(snapshot, 'report', { projects: PROJECTS });

check('[FAILS-OLD] the report-shape context names the office\'s projects',
  /Projects the office is responsible for/.test(newReportContext.text) && /Data Center/.test(newReportContext.text));
check('[FAILS-OLD] proof the assertion above genuinely fails against the pre-change call',
  !/Projects the office is responsible for/.test(oldReportContext.text));

// OLD — the per-agent site, same omission.
//
// `clearance` added 2026-08-10 with A11 rank filtering. Agent 12 (The Workflow)
// is `sudo` in config/agents-config.json, so this is the ADMIN shape — which is
// what this scenario was always about. Without it the shape rank-filters and
// withholds `projects`, and the check would fail for a reason that has nothing
// to do with the projects wiring it exists to pin.
const oldAgentContext = officeContext.buildOfficeContext(snapshot, 'agent', { agentId: 12, clearance: 'sudo' });
const newAgentContext = officeContext.buildOfficeContext(snapshot, 'agent', { agentId: 12, clearance: 'sudo', projects: PROJECTS });
check('[FAILS-OLD] the per-agent context names the projects too (site 2 of the survey)',
  /Notebook-X/.test(newAgentContext.text) && !/Notebook-X/.test(oldAgentContext.text));

// A11's other half, pinned in the same place so the two cannot drift: the
// projects list is admin detail, and a STANDARD agent does not get it even when
// the caller passes it. Enforced by construction (office-context.js
// STANDARD_SECTIONS), not by the budget — a rule enforced only by a budget
// stops being enforced the next time the budget moves.
const standardAgentContext = officeContext.buildOfficeContext(snapshot, 'agent', { agentId: 3, clearance: 'standard', projects: PROJECTS });
check('[new] A11 — a STANDARD agent is NOT shown the projects list, even when the caller passes it',
  !/Projects the office is responsible for/.test(standardAgentContext.text)
  && standardAgentContext.rankFiltered === true
  && standardAgentContext.withheld.includes('projects'));
check('[new] A11 — but a standard agent IS shown the client requirements and the policy (everyone sees those)',
  /REQ-001/.test(standardAgentContext.text) && /A1 RED LINE/.test(standardAgentContext.text));

check('[new] the four call sites now pass projects — three report sites in agent-runner.js',
  (runnerSrc.match(/getOfficeContext\(env, \{ shape: 'report', allowFetch: true, projects: officeProjects\.projects \}\)/g) || []).length === 3);
check('[new] and the per-agent site in agent-base.js',
  /getOfficeContext\(this\.env, \{[\s\S]{0,160}projects: officeProjects\.projects/.test(read('agents/agent-base.js')));

// The token budget moves when projects are added back. Record both numbers so
// a later session comparing against the 1,687 figure knows why it changed.
console.log(`        report-shape tokens WITHOUT projects: ${oldReportContext.tokens}`);
console.log(`        report-shape tokens WITH projects:    ${newReportContext.tokens}`);
check('[new] the report shape still fits its 6,000-token budget with projects restored',
  newReportContext.tokens <= officeContext.BUDGETS.report);
check('[new] the per-agent shape still fits its 400-token budget with projects restored',
  newAgentContext.tokens <= officeContext.BUDGETS.agent);

/* ══════════════════════════════════════════════════════════════════════════
 * §3  NO SELF-QA — the drafter never reviews its own work
 * ═════════════════════════════════════════════════════════════════════════ */
section('§3  Rule 1 — no self-QA, enforced as a refusal');

check('[new] same persona drafting and reviewing is REFUSED',
  rp.assertDistinctReviewer({ draftProvider: 'gemini', reviewProvider: 'groq', draftAgentId: 6, reviewAgentId: 6 }).ok === false);
check('[new] same PROVIDER drafting and reviewing is REFUSED even when the personas differ',
  rp.assertDistinctReviewer({ draftProvider: 'mistral', reviewProvider: 'mistral', draftAgentId: 12, reviewAgentId: 6 }).ok === false);
check('[new] different persona AND different provider is allowed',
  rp.assertDistinctReviewer({ draftProvider: 'gemini', reviewProvider: 'cerebras', draftAgentId: 12, reviewAgentId: 6 }).ok === true);
check('[new] the drafter and reviewer constants are genuinely different personas',
  rp.DRAFTER_AGENT_ID !== rp.REVIEWER_AGENT_ID);

// The same-provider case is not hypothetical: hebrew_composition backs off to
// mistral and judgment backs off to mistral. Two lanes, one backup.
const routing = JSON.parse(read('config/model-routing.json'));
check('[new] the collision this guard exists for is real in the live lane table (both lanes back off to the same provider)',
  routing.lanes.hebrew_composition.backup === routing.lanes.judgment.backup);

/* ══════════════════════════════════════════════════════════════════════════
 * §4  LANE PLANNING — and routing-off as a CLEAN degradation
 * ═════════════════════════════════════════════════════════════════════════ */
section('§4  Lane planning in both flag states');

const planOff = rp.planReportProviders({ routingOn: false, language: 'english' });
check('[new] routing OFF: drafting uses the direct Gemini path',
  planOff.draft.mode === 'direct' && planOff.draft.provider === 'gemini');
check('[new] routing OFF: review uses the direct Groq path (Groq -> Cloudflare AI), not Gemini',
  planOff.review.mode === 'direct' && planOff.review.provider === 'groq');
check('[new] routing OFF: the owner requirement "reports are written by Gemini" holds',
  planOff.geminiRequirementHolds === true);
check('[new] routing OFF: the plan is a degradation, not a failure (both calls have a path)',
  !!planOff.draft.path && !!planOff.review.path);

const planOnEn = rp.planReportProviders({ routingOn: true, language: 'english', draftLanePrimary: 'gemini' });
check('[new] routing ON: review resolves to the judgment lane',
  planOnEn.review.lane === 'judgment');

check('[new] every lane the planner names exists in config/model-routing.json',
  ['report_drafting', 'routine_volume', 'hebrew_composition', 'judgment'].every((l) => l in routing.lanes));
check('[new] the planner never names the architect lane (Anthropic is unreachable from here)',
  ![planOnEn, rp.planReportProviders({ routingOn: true, language: 'hebrew', draftLanePrimary: 'gemini' }), planOff]
    .some((p) => p.draft.lane === 'architect' || p.review.lane === 'architect'));
check('[new] report-pipeline.js imports no provider client and no Anthropic client',
  !/from '\.\/(cerebras|mistral|cohere|claude|groq|gemini)-client\.js'/.test(read('workers/report-pipeline.js')));

/* ══════════════════════════════════════════════════════════════════════════
 * §5  THE STRUCTURAL GATE — an APPROVE with a bad body is not a decision
 * ═════════════════════════════════════════════════════════════════════════ */
section('§5  validateReportBody() — every failure leaves the row drafted');

const FACTS_WITH_MARKER = 'Commitment due date: 2026-09-07.\nDISPATCHED: UNVERIFIED — the office does not record dispatch.';

/**
 * A realistic fixture, NOT a minimal one — deliberately.
 *
 * The first version of this fixture was 1,055 characters and failed the
 * 1,200-character floor, and the tempting fix was to lower the floor. That
 * would have been the guard bending to fit the test: a real report is 550-950
 * words, which is 3,000-6,000 characters, so a 1,055-character "report" is
 * evidence the fixture is unrealistic and no evidence at all about the floor.
 * The fixture grew instead.
 */
function goodReport({ due = '2026-09-07', sentinel = true, markers = true } = {}) {
  const body = `${rp.SUMMARY_HEADING}

- The office is ${due ? `on the clock to ${due}` : 'running against an unstated date'} and one requirement carries the client's own URGENT mark.
- Nothing on the delegation board has been dispatched. Every task reads READY, which means ready to be dispatched, not started.
- The Designer's whole queue is blocked on one missing capability, and it has been blocked all period.
- Capture is running but thin: one morning of data is not a sample, and no review job should be built on it yet.

## 1. Where we stand against the client requirements

Two requirements are on record in this period's snapshot and the commitment date is ${due}. REQ-001, the owner's channel, is the only requirement the client marked urgent, and it is in progress: the folder-based channel exists and the outbound half does not. REQ-003, the office's own site, is also in progress — four phases are built in the warehouse and none of them are deployed, which is a legitimate combination under the finished-is-not-deployed rule and not a contradiction to resolve.

${markers ? 'Dispatch is UNVERIFIED. The office does not record when a task moves from ready to started, so "nothing was dispatched" is inferred from the absence of a state change rather than measured.' : 'Dispatch is not recorded, so nothing can be said about it.'}

## 2. Product decisions and the vote record

No product decisions were taken this period, and no vote was held. That is stated plainly because an empty period reported as an empty period is worth more than an empty period dressed up: the meeting mechanism that would produce a vote record exists and has not yet run against a binding question.

## 3. Conflicts raised and how they resolved

None were raised this period.

## 4. Productivity — what sat, who was idle, what ran late

Two tasks sat READY and unstarted for the whole period; neither has a stamped deadline yet, so neither can be reported as late. One task is BLOCKED on a capability that is not wired, which is a real block and not a queueing choice. No agent was dispatched work from the board at any point in the period, so idleness here is a dispatch fact rather than an agent fact — the four measures are reported separately for exactly this reason, and averaging them into one number would have hidden it.

## 5. Agent state and the improvement loop

Thirteen personas are on the roster and the capture path recorded seven case answers across a single morning. Seven rows is one morning, not a sample, and the Lead QA has not yet named the number she considers sufficient. Building a review job against this table now would produce something that runs, passes, and generalises from almost nothing.

## 6. Blocked, and on whom

The Designer's tasks wait on an image-capable provider being wired through the router, which waits on an owner decision. The escalation definition waits on the owner channel, which is REQ-001. Both chains terminate at the same place, and neither is the office's to unblock.
`;
  return sentinel ? `${body}\n${rp.REPORT_SENTINEL}` : body;
}

const okBody = goodReport();
const okResult = rp.validateReportBody(okBody, { factPack: FACTS_WITH_MARKER, due: '2026-09-07' });
check('[new] a complete, structured, sentinel-terminated report PASSES', okResult.ok === true);
if (!okResult.ok) console.log(`        (reasons: ${okResult.reasons.join(' | ')})`);

check('[new] an empty body is refused (the byline-only failure the guides pipeline shipped once)',
  rp.validateReportBody('', { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === false);

const truncated = okBody.slice(0, Math.floor(okBody.length * 0.55));
const truncResult = rp.validateReportBody(truncated, { factPack: FACTS_WITH_MARKER, due: '2026-09-07' });
check('[new] a response cut off at the token ceiling is refused',
  truncResult.ok === false && truncResult.reasons.some((r) => /sentinel/.test(r)));

check('[new] a report missing the client-requirements section is refused',
  rp.validateReportBody(okBody.replace(/## 1\. Where we stand[^\n]*/, '## 1. Case volume'), { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === false);

check('[new] a report that omits the commitment due date is refused',
  rp.validateReportBody(goodReport({ due: null }), { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === false);

check('[new] an UNVERIFIED marker present in the facts and dropped from the report is refused',
  rp.validateReportBody(goodReport({ markers: false }), { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === false);

check('[new] a due date the office could NOT read is not demanded of the report (defect reported, not invented past)',
  rp.validateReportBody(goodReport({ due: 'no date' }), { factPack: FACTS_WITH_MARKER, due: null }).ok === true);

check('[new] a reviewer may sharpen a heading\'s wording without failing the check',
  rp.validateReportBody(
    okBody.replace('## 1. Where we stand against the client requirements', '## 1. Where we stand against what the client asked for'),
    { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }
  ).ok === true);

/* ── The projects gate, added after judging the first sample ─────────────
 * The first sample passed every structural check and still never named a
 * single project the office works on. Passing the list INTO the prompt is not
 * the same as the report using it — the gate has to be on the output, or
 * item 1.2b closes the input half of a defect and leaves the visible half. */
const PROJECT_NAMES = ['Data Center', 'Notebook-X', 'office-AI-agents'];
check('[FAILS-OLD] a report that names none of the office\'s projects is refused',
  rp.validateReportBody(okBody, { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projectNames: PROJECT_NAMES }).ok === false);
check('[new] naming one project is enough (a project with nothing to say is not forced into a sentence)',
  rp.validateReportBody(
    okBody.replace('## 4. Productivity', '## 4. Productivity\n\nNotebook-X and Data Center both took gap findings this period.\n\n### Productivity'),
    { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projectNames: PROJECT_NAMES }
  ).ok === true);
check('[new] the gate is inert when the office has no project list (no false failure)',
  rp.validateReportBody(okBody, { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projectNames: [] }).ok === true);
check('[new] the runner passes the real project names to the gate',
  /factPack, due, projects: officeProjects\.projects,/.test(runnerSrc));
check('[new] the draft prompt requires section 4 to name the projects',
  /NAME the projects the office is responsible for/.test(rp.buildDraftPrompt('facts', { reportType: 'weekly', periodLabel: 'week-07' })));
check('[new] the fact pack has a "what the office produced" section',
  /WHAT THE OFFICE ACTUALLY PRODUCED THIS PERIOD/.test(rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-07' })));
check('[new] and an absent artifact record is UNVERIFIED, not "produced nothing"',
  /Do not write that the office produced nothing/.test(rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-07' })));
check('[new] the runner distinguishes an unreadable guides table from a quiet period',
  /the guides pipeline table could not be read/.test(runnerSrc) && /Guides: none drafted this period/.test(runnerSrc));

/* ── getWeeklyCasesHandled() looks back 24 HOURS, not a week ─────────────
 * Measured 2026-08-08: the 24-hour figure was 0 and the real 7-day figure was
 * 167. The function is left alone because it feeds committed output; the
 * report pipeline computes its own count over its own window instead. */
check('[FAILS-OLD] the pre-existing weekly case count really does use a 24-hour window',
  /async function getWeeklyCasesHandled[\s\S]{0,400}?24 \* 60 \* 60 \* 1000/.test(runnerSrc));
check('[new] the pipeline does NOT inherit it — it recomputes over its own period window',
  /SELECT agent_id, COALESCE\(SUM\(cases_handled\), 0\) AS total[\s\S]{0,120}?started_at >= \?/.test(runnerSrc)
  && /agentRows: periodAgentRows/.test(runnerSrc));
check('[new] and getWeeklyCasesHandled() itself is unchanged (its committed CSV output does not move)',
  /const since = new Date\(Date\.now\(\) - 24 \* 60 \* 60 \* 1000\)\.toISOString\(\);/.test(runnerSrc));

check('[new] but it may NOT renumber the sections',
  rp.validateReportBody(okBody.replace('## 1. Where we stand', '## 4. Where we stand'), { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === false);

/* ── The review context ceiling — refuse, never send-and-hope ────────────
 * Originally written against Groq llama3-8b-8192, whose 8,192 tokens were
 * TOTAL (prompt plus completion). That model was decommissioned, and on
 * 2026-08-10 DIRECT_REVIEW_CONTEXT_TOKENS was raised 8,192 -> 131,000 by owner
 * decision when routing was enabled.
 *
 * THE FIXTURES BELOW ARE NOW SIZED FROM THE CONSTANT, NOT FROM A LITERAL.
 * They were hardcoded to 8,192 and every one of them silently stopped testing
 * anything the moment the ceiling moved — they passed as "fits" instead of
 * proving a refusal. That is the same class of rot this suite exists to catch,
 * so the scenario now calibrates itself and will survive the next change.
 *
 * What is being proven is unchanged: an overrunning review is REFUSED rather
 * than sent, because neither client on the direct path reports a finish reason
 * and an overrun would come back as a truncated review that parses like a real
 * one. */
section('§5b  The review context ceiling — refuse, never send-and-hope');

const estTok = (t) => (t ? Math.ceil(String(t).length / 3) : 0);
/** `'FACT '` is 5 chars => 5/3 tokens each. Repeats needed for N tokens. */
const packOf = (tokens) => 'FACT '.repeat(Math.max(1, Math.ceil((tokens * 3) / 5)));

const CEILING = rp.DIRECT_REVIEW_CONTEXT_TOKENS;
const bigPack = packOf(CEILING * 1.2);     // comfortably over, whatever the ceiling is
const smallPack = packOf(400);             // ~400 tokens — a realistic pack
const SYS = rp.REVIEW_SYSTEM;
check('[new] a fact pack that would overrun the reviewer is REFUSED',
  rp.estimateReviewFit({ factPack: bigPack, draftContent: okBody, systemPrompt: SYS, maxOutputTokens: 1800 }).fits === false);
check('[new] the refusal names the ceiling AND the provider limits behind it',
  /131,000|131000|judgment lane|Cerebras/.test(rp.estimateReviewFit({ factPack: bigPack, draftContent: okBody, systemPrompt: SYS, maxOutputTokens: 1800 }).reason || ''));
check('[new] a realistic pack fits and is NOT refused',
  rp.estimateReviewFit({ factPack: smallPack, draftContent: okBody, systemPrompt: SYS, maxOutputTokens: 1800 }).fits === true);
check('[new] the completion budget counts against the ceiling, not just the prompt',
  rp.estimateReviewFit({ factPack: smallPack, draftContent: okBody, systemPrompt: SYS, maxOutputTokens: CEILING }).fits === false);
check('[new] the ceiling is the SMALLER of the two real provider limits, used as a total',
  CEILING <= 131000 && CEILING <= 131072);
check('[new] the full 41-task board fits with room — the cap that managed scarcity is gone',
  rp.BOARD_TASKS_IN_PACK >= 41 && rp.estimateReviewFit({
    factPack: packOf(5181), draftContent: okBody, systemPrompt: SYS, maxOutputTokens: 500,
  }).fits === true);
check('[new] the runner checks the fit only on the DIRECT path (routing ON has 131K and does not bind)',
  /if \(plan\.review\.mode !== 'direct'\) \{\s*\n\s*return callReportModel\(env, plan\.review, \{/.test(runnerSrc)
  && runnerSrc.indexOf('const fit = estimateReviewFit(') > runnerSrc.indexOf("if (plan.review.mode !== 'direct')"));
check('[new] the fact pack bounds BOTH of its unbounded lists',
  rp.BOARD_TASKS_IN_PACK > 0 && rp.BLOCKED_IN_PACK > 0);

/* ── THE GUARD MEASURED THE WRONG STRING (fixed 2026-08-09) ──────────────
 * estimateReviewFit()'s systemPrompt defaulted to REVIEW_SYSTEM. REVIEW_SYSTEM
 * is never sent: agent-base.js queryGroqRouted() sends
 * _buildPersonaSystemPrompt(), which appends the state line, the behavioral
 * rules, the DB context and the office-context block (agent-base.js:266-274).
 * The live run measured 8,347 tokens against the 8,192 ceiling — the request
 * overran and the guard said it fit, because the guard was measuring a
 * different string. Only the estimator's over-estimating bias (length/3
 * against a real ~length/4) kept the overrun from being worse.
 *
 * The scenarios below are run against the OLD signature (a REVIEW_SYSTEM
 * default) and the NEW one (assembled prompt required). The old one passes the
 * call. That is the bug. */
section('§5c  The fit guard measures what is actually sent, not REVIEW_SYSTEM');

/** A stand-in for what _buildPersonaSystemPrompt() actually returns: the given
 *  system prompt PLUS the state line, the QA's behavioral rules and the office
 *  context block. Sized from the live measurement — the assembly added roughly
 *  a thousand tokens on top of REVIEW_SYSTEM. */
const ASSEMBLED = `${rp.REVIEW_SYSTEM}\n\nCurrent state: mood=NEUTRAL, irritation=1/5, angry=false.\n\nBehavioral rules:\n- ${'checks every figure against its source. '.repeat(20)}\n\n${'The office board: OB-0xx [READY] Agent 12 — a task title long enough to matter. '.repeat(60)}`;

/** Transcription of the pre-change signature: systemPrompt defaults to
 *  REVIEW_SYSTEM and the caller passes nothing. The BUG being reproduced is
 *  which STRING gets measured, not which ceiling it is measured against — so
 *  the ceiling here tracks the current constant, and both sides of the
 *  comparison are judged against the same number. Hardcoding 8,192 here made
 *  this scenario stop reproducing anything when the ceiling moved. */
function oldEstimateReviewFit({ factPack, draftContent, systemPrompt = rp.REVIEW_SYSTEM, maxOutputTokens }) {
  const est = (t) => (t ? Math.ceil(String(t).length / 3) : 0);
  const estimated = est(factPack) + est(draftContent) + est(systemPrompt) + maxOutputTokens + 400;
  return { fits: estimated <= rp.DIRECT_REVIEW_CONTEXT_TOKENS, estimated };
}

// A pack sized so the call FITS when the un-assembled prompt is measured and
// OVERRUNS when the real one is — precisely the live 8,347-vs-8,192 case,
// reproduced at whatever ceiling is currently in force. Sized from the
// assembly delta so the straddle holds by construction rather than by luck.
const ASSEMBLY_DELTA = estTok(ASSEMBLED) - estTok(rp.REVIEW_SYSTEM);
const EDGE_PACK = packOf(
  rp.DIRECT_REVIEW_CONTEXT_TOKENS
  - estTok(okBody) - estTok(rp.REVIEW_SYSTEM) - 1600 - 400
  - Math.floor(ASSEMBLY_DELTA / 2)
);
const oldFit = oldEstimateReviewFit({ factPack: EDGE_PACK, draftContent: okBody, maxOutputTokens: 1600 });
const newFit = rp.estimateReviewFit({ factPack: EDGE_PACK, draftContent: okBody, systemPrompt: ASSEMBLED, maxOutputTokens: 1600 });
console.log(`        old guard (measuring REVIEW_SYSTEM):     ~${oldFit.estimated} tokens -> fits=${oldFit.fits}`);
console.log(`        new guard (measuring what is sent):      ~${newFit.estimated} tokens -> fits=${newFit.fits}`);
check('[FAILS-OLD] the old guard passed a call that overruns the ceiling',
  oldFit.fits === true && newFit.fits === false);
check('[FAILS-OLD] the difference is the assembly the old guard never counted',
  newFit.estimated - oldFit.estimated > 700);
check('[new] omitting the system prompt is REFUSED, not estimated optimistically (fail-closed on a missing input)',
  (() => {
    const f = rp.estimateReviewFit({ factPack: smallPack, draftContent: okBody, maxOutputTokens: 500 });
    return f.fits === false && /_buildPersonaSystemPrompt/.test(f.reason || '');
  })());
check('[new] the runner passes the ASSEMBLED prompt, not REPORT_REVIEW_SYSTEM',
  /const assembledSystemPrompt = await reviewer\.buildAssembledSystemPrompt\(reviewPrompt, REPORT_REVIEW_SYSTEM\);/.test(runnerSrc)
  && /estimateReviewFit\(\{[\s\S]{0,160}?systemPrompt: assembledSystemPrompt,/.test(runnerSrc));
check('[new] agent-base.js exposes the assembled prompt without making a call',
  /async buildAssembledSystemPrompt\(prompt, systemPrompt\) \{\s*\n\s*return this\._buildPersonaSystemPrompt\(prompt, systemPrompt\);/.test(read('agents/agent-base.js')));
check('[new] and it is assembled ONCE — the same string is handed to the call it was measured for',
  /opts\.assembledSystemPrompt\s*\n?\s*\?\? await this\._buildPersonaSystemPrompt\(prompt, systemPrompt\);/.test(read('agents/agent-base.js'))
  && /agent: reviewer,\s*\n\s*assembledSystemPrompt,/.test(runnerSrc));
check('[new] every pre-existing queryGroqRouted() caller is unaffected (the option defaults to absent)',
  /opts\.assembledSystemPrompt\s*\n?\s*\?\?/.test(read('agents/agent-base.js')));

/* ── THE STRUCTURAL REFUSAL LEAVES AN ARTIFACT (fixed 2026-08-09) ────────
 * agent-runner.js returned before commitFileToRepo() and before
 * updateReportRow() on this path, so the whole failure class left evidence in
 * one console line — and Cloudflare no longer retains those. It did not even
 * persist which provider answered. Rule 3 governed the REJECT branch only. */
section('§5d  A structurally refused report is SAVED, not merely logged');

const refusalBlock = runnerSrc.slice(
  runnerSrc.indexOf('APPROVE refused structurally'),
  runnerSrc.indexOf("reason: 'approve_failed_structural_check'")
);
check('[FAILS-OLD] the refusal path now commits a file before it returns',
  /commitFileToRepo\(/.test(refusalBlock) && /rejectedReportPath\(reportType, periodLabel\)/.test(refusalBlock));
check('[FAILS-OLD] with the structural reasons in it, via the existing renderer',
  /renderRejectedReportFile\(\{/.test(refusalBlock) && /structuralReasons: structural\.reasons,/.test(refusalBlock));
check('[FAILS-OLD] and persists the provider that answered, which was previously lost entirely',
  /updateReportRow\(env, row\.id, \{\s*\n\s*reviewerProvider: review\.provider,/.test(refusalBlock));
check('[new] the row still stays "drafted" — a refusal is not a rejection and must retry cleanly',
  !/status: '(rejected|approved)'/.test(refusalBlock));
check('[new] the saved file does NOT claim the reviewer rejected a report it approved',
  /headline: `STRUCTURALLY REFUSED/.test(refusalBlock));
check('[new] renderRejectedReportFile() honours that headline and still defaults to REJECTED',
  (() => {
    const args = {
      reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-09',
      draftContent: 'draft', reviewNotes: 'the gate refused', drafterName: 'The Workflow', reviewerName: 'The QA',
      structuralReasons: ['a marker was dropped'],
    };
    const structuralFile = rp.renderRejectedReportFile({ ...args, headline: 'STRUCTURALLY REFUSED WEEKLY REPORT' });
    const rejectFile = rp.renderRejectedReportFile(args);
    return /^# STRUCTURALLY REFUSED WEEKLY REPORT — week-07/.test(structuralFile)
      && /Structural refusals/.test(structuralFile)
      && /a marker was dropped/.test(structuralFile)
      && /^# REJECTED WEEKLY REPORT — week-07/.test(rejectFile);
  })());

/* ── THE MARKER CONTRACT IS THE LITERAL TOKEN (settled 2026-08-09) ───────
 * The first live draft did not disobey. DRAFT_SYSTEM demanded the markers "in
 * those words" while the fact-pack lines told the writer to report the same
 * facts as prose ("report this as a DEFECT in section 1", and a DISPATCHED
 * value that read as a sentence to copy). The draft kept the meaning and lost
 * the word; countUnverified() matches the word and fired correctly.
 *
 * The contract chosen is the LITERAL TOKEN, because it is the only half that
 * can be checked. These scenarios assert that every instruction site now says
 * the same thing, and they are run against the transcribed old strings, which
 * do not. */
section('§5e  The marker instruction conflict — one contract, stated the same way everywhere');

const OLD_DUE_INSTRUCTION = 'Commitment due date: UNVERIFIED — could not be parsed from docs/CLIENT-REQUIREMENTS.md. Report this as a DEFECT in section 1, in those words. Do not write that there is no deadline.';
const OLD_DISPATCH_INSTRUCTION = 'DISPATCHED: UNVERIFIED — the office does not yet record dispatch, so "READY" means ready to be dispatched, not started.';
/** Does this instruction demand the LITERAL token, or merely a report of the
 *  fact? "Contains the word UNVERIFIED as a value" is not the same as "tells
 *  the writer to carry the word" — the first is what both old lines did. */
const demandsLiteralToken = (s) => /literal word (UNVERIFIED|UNREADABLE)|that same literal word/i.test(s);

check('[FAILS-OLD] the old due-date instruction never demanded the literal token — it asked for prose',
  demandsLiteralToken(OLD_DUE_INSTRUCTION) === false);
check('[FAILS-OLD] nor did the old DISPATCHED line, whose value doubled as the sentence to copy',
  demandsLiteralToken(OLD_DISPATCH_INSTRUCTION) === false);

const unreadableDuePack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-09',
  requirements: { requirements: [{ id: 'REQ-001', title: 'x', status: 'in progress', urgent: true }], due: null },
  board: { counts: { total: 1, READY: 1 }, tasks: [{ id: 'OB-001', state: 'READY', assignee: 'Agent 12', title: 't' }] },
});
check('[FAILS-OLD] the due-date line now demands the literal token',
  demandsLiteralToken(unreadableDuePack.split('\n').find((l) => /Commitment due date: UNVERIFIED/.test(l))));
check('[FAILS-OLD] and the DISPATCHED fact carries its instruction as a SEPARATE line from its value',
  /^DISPATCHED: UNVERIFIED/m.test(unreadableDuePack)
  && demandsLiteralToken(unreadableDuePack.split('\n').find((l) => /satisfy the marker rule/.test(l) && /dispatch/.test(l))));
check('[new] the rule is stated ONCE at the top of every fact pack, not re-derived per line',
  /^MARKER RULE — READ FIRST/m.test(unreadableDuePack) && demandsLiteralToken(rp.MARKER_RULE));
check('[new] the drafter\'s system prompt agrees with it',
  /literal word/.test(rp.DRAFT_SYSTEM) && /an automated check looks for the word itself/.test(rp.DRAFT_SYSTEM));
check('[new] the draft prompt agrees with it',
  /literal word UNVERIFIED/.test(rp.buildDraftPrompt('facts', { reportType: 'weekly', periodLabel: 'week-07' })));
check('[new] the reviewer is asked to check for the same thing (a paraphrase is a dropped marker)',
  /as that literal word/.test(rp.REVIEW_SYSTEM) && /A paraphrase that conveys the same meaning is a DROPPED marker/.test(rp.REVIEW_SYSTEM));
// The runner's meeting-decisions text was REPLACED wholesale by OB-028 (§9b) —
// it asserted the office persisted no decisions, which was false. What survives
// of the marker fix at that site is that every UNVERIFIED branch there still
// demands the literal token, which §9b asserts directly. The paraphrase that
// originally failed is pinned against the CHECKER instead, above, where it
// cannot go stale when the surrounding prose is rewritten again.
check('[new] every meeting-decisions branch that reports UNVERIFIED demands the literal token',
  /the meetings table could not be read this cycle[\s\S]{0,220}?literal word UNVERIFIED/.test(runnerSrc)
  && /EVERY one recorded an empty decision block[\s\S]{0,700}?literal word UNVERIFIED/.test(runnerSrc));
check('[new] the checker was already right and is unchanged — it matches the token it is now promised',
  rp.countUnverified('the due date is UNVERIFIED and the board was UNREADABLE') === 2);
check('[FAILS-OLD] the exact sentence the first live draft wrote does NOT satisfy the checker',
  rp.countUnverified('This section is a gap in the office\'s own record-keeping. As the office does not yet record dispatch, READY means ready to be dispatched.') === 0);
check('[new] and the gate\'s refusal message names which half of the contract it enforces',
  rp.validateReportBody(goodReport({ markers: false }), { factPack: FACTS_WITH_MARKER, due: '2026-09-07' })
    .reasons.some((r) => /the literal word, not the conveyed meaning/.test(r)));

/* ── THE REFUSAL MUST STAY LOUD (owner instruction, 2026-08-08) ──────────
 * "A truncated review that parses like a real one is the failure mode we've
 * now hit in three subsystems." These checks pin the loudness itself, not
 * just the refusal, so a later session cannot quietly downgrade it to a
 * silent skip while leaving the mechanism nominally in place. */
const loudFit = rp.estimateReviewFit({ factPack: bigPack, draftContent: okBody, systemPrompt: ASSEMBLED, maxOutputTokens: 1800 });
check('[LOUD] the refusal carries a reason, never a bare false',
  typeof loudFit.reason === 'string' && loudFit.reason.length > 80);
check('[LOUD] the reason states BOTH numbers, so the margin is auditable from the log alone',
  /~\d+ tokens/.test(loudFit.reason)
  && new RegExp(String(rp.DIRECT_REVIEW_CONTEXT_TOKENS)).test(loudFit.reason));
check('[LOUD] the reason says WHY it refuses rather than truncating (no finish reason on this path)',
  /no finish reason/.test(loudFit.reason));
check('[LOUD] the runner console.warns the refusal — it is not a silent skip',
  /console\.warn\(`\[report-pipeline\] \$\{fit\.reason\}`\)/.test(runnerSrc));
check('[LOUD] and returns a named, greppable reason to its caller',
  /reason: `review_input_exceeds_direct_context \(~\$\{fit\.estimated\}\/\$\{fit\.ceiling\}\)`/.test(runnerSrc));
check('[LOUD] a refused review never reaches the publish path',
  /if \(!review\.text\) return \{ ran: false, reason: `review_failed/.test(runnerSrc));

/* ── AD-028: report drafting pins to Gemini when routing is enabled ──────
 * Owner decision 2026-08-08, IMPLEMENTED 2026-08-09 as a lane rather than a
 * call-site constant. The old checks here asserted the decision was RECORDED;
 * these assert it HOLDS. The pre-change behaviour is transcribed so the
 * scenarios fail against it. */
section('§5f  AD-028 — report drafting resolves to Gemini, and the pin is checked against the live table');

const pipelineSrc = read('workers/report-pipeline.js');

/** VERBATIM transcription of pickDraftLane() before the pin landed. */
const oldPickDraftLane = (language) =>
  (String(language || '').toLowerCase() === 'hebrew' ? 'hebrew_composition' : 'routine_volume');

check('[FAILS-OLD] an English report used to resolve to a lane whose primary is NOT Gemini',
  routing.lanes[oldPickDraftLane('english')].primary !== 'gemini'
  && routing.lanes[oldPickDraftLane('english')].primary === 'groq');
check('[FAILS-OLD] it now resolves to a lane whose primary IS Gemini',
  routing.lanes[rp.pickDraftLane('english')].primary === 'gemini');
check('[new] and so does Hebrew — the pin is language-independent, with no path where it stops holding',
  rp.pickDraftLane('hebrew') === rp.pickDraftLane('english')
  && rp.pickDraftLane(null) === rp.DRAFT_LANE_REPORT);
check('[new] the requirement is reported as HOLDING when the table really does say gemini',
  rp.planReportProviders({ routingOn: true, language: 'english', draftLanePrimary: 'gemini' }).geminiRequirementHolds === true);
check('[new] and as NOT holding the moment someone repoints the lane — the check is on the resolved value',
  (() => {
    const p = rp.planReportProviders({ routingOn: true, language: 'english', draftLanePrimary: 'groq' });
    return p.geminiRequirementHolds === false && p.notes.some((n) => /"groq" and NOT Gemini/.test(n));
  })());
check('[new] a caller that does not look is reported as NOT holding, never as holding by default',
  (() => {
    const p = rp.planReportProviders({ routingOn: true, language: 'english' });
    return p.geminiRequirementHolds === false && p.notes.some((n) => /could not be verified/.test(n));
  })());
check('[new] the runner reads the primary from the live lane table rather than assuming it',
  /resolveTaskLane\(pickDraftLane\('english'\)\)\.candidates\?\.\[0\]/.test(runnerSrc)
  && /planReportProviders\(\{ routingOn, language: 'english', draftLanePrimary \}\)/.test(runnerSrc));
check('[new] routine_volume was NOT repointed to satisfy the pin (it serves every other routine caller)',
  routing.lanes.routine_volume.primary === 'groq');
check('[new] the lane records the decision as data, where a session would edit it',
  /AD-028/.test(routing.lanes.report_drafting._why)
  && /routine_volume/.test(routing.lanes.report_drafting._do_not));
check('[AD-028] and the code still warns against the specific "simplification" that would undo it',
  /Do NOT\s*\n?\s*\* "simplify" report drafting back onto the routine lane/.test(pipelineSrc)
  && /repoint\s*\n?\s*\* `routine_volume`'s primary/.test(pipelineSrc));
check('[new] the report_drafting lane is a chat lane with a real backup',
  routing.lanes.report_drafting.kind === 'chat' && !!routing.lanes.report_drafting.backup);
check('[new] and says so when it clips them — no silent caps',
  (() => {
    const many = Array.from({ length: 40 }, (_, i) => `OB-${i} blocked on something`);
    const pack = rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-07', blocked: many });
    return new RegExp(`showing ${rp.BLOCKED_IN_PACK} of 40`).test(pack);
  })());

/* ══════════════════════════════════════════════════════════════════════════
 * §5g  THE FIRST PUBLISHED REPORT'S TWO DEFECTS
 *
 * week-07 published on 2026-08-09 and said, in section 4:
 *
 *   "nothing moved on Data Center, Notebook-X, office-AI-agents,
 *    back-office-AI-agents, or warehouse-office-AI-agents this period, as the
 *    office focused on clearing internal administrative tasks and
 *    capability-gap reporting."
 *
 * while section 5 credited three approved guides and ten gap findings — three
 * against Data Center, seven against Notebook-X — from the same fact pack.
 * The QA read both and approved. Both checks therefore live in the GATE.
 *
 * The sentences below are the real ones, quoted from the published file.
 * ═════════════════════════════════════════════════════════════════════════ */
section('§5g  Consistency and fabrication — the two defects the reviewer passed');

const PROJECT_BODY = okBody.replace(
  '## 4. Productivity',
  '## 4. Productivity\n\nNotebook-X and Data Center both took gap findings this period.\n\n### Productivity'
);
const PROJECT_OBJS = [
  { key: 'data-center', name: 'Data Center' },
  { key: 'notebook-x', name: 'Notebook-X' },
  { key: 'office-AI-agents', name: 'office-AI-agents' },
];
const PACK_WITH_OUTPUT = [
  '=== 5. WHAT THE OFFICE ACTUALLY PRODUCED THIS PERIOD (section 5 OPENS with this) ===',
  '- Guides: 3 approved, 2 rejected.',
  '- Capability-gap findings filed against data-center: 3, digested to reports/gaps/data-center/.',
  '- Capability-gap findings filed against notebook-x: 7, digested to reports/gaps/notebook-x/.',
  '',
  '=== 6. BLOCKED WORK ===',
  '- OB-003 blocked',
].join('\n');

check('[new] the fact pack\'s attribution is read by project KEY as well as display name',
  (() => {
    const out = rp.projectsWithOutput(PACK_WITH_OUTPUT, PROJECT_OBJS).map((p) => p.name);
    return out.includes('Data Center') && out.includes('Notebook-X') && !out.includes('office-AI-agents');
  })());
check('[new] a project merely NAMED in the roster is not credited with output',
  rp.projectsWithOutput('=== 4b. PROJECTS ===\n- Data Center (private) — client project\n=== 6. BLOCKED WORK ===', PROJECT_OBJS).length === 0);
check('[new] a zero count is not output',
  rp.projectsWithOutput('=== 5. PRODUCED ===\n- Capability-gap findings filed against data-center: 0.\n=== 6. BLOCKED WORK ===', PROJECT_OBJS).length === 0);

/** The published sentence, verbatim. */
const REAL_NO_MOVEMENT = 'Regarding the office projects: nothing moved on Data Center, Notebook-X, office-AI-agents, back-office-AI-agents, or warehouse-office-AI-agents this period, as the office focused on clearing internal administrative tasks and capability-gap reporting.';
const bodyWithDefects = PROJECT_BODY.replace('## 4. Productivity', `## 4. Productivity\n\n${REAL_NO_MOVEMENT}\n\n### Productivity`);
const defectResult = rp.validateReportBody(bodyWithDefects, {
  factPack: `${FACTS_WITH_MARKER}\n${PACK_WITH_OUTPUT}`, due: '2026-09-07', projects: PROJECT_OBJS,
});
check('[FAILS-OLD] the sentence that published on 2026-08-09 is now REFUSED',
  defectResult.ok === false);
check('[FAILS-OLD] refused for the contradiction — no movement claimed on projects the facts credit',
  defectResult.reasons.some((r) => /claims no movement on Data Center, Notebook-X/.test(r)));
check('[FAILS-OLD] AND for the invented motive, as a separate reason',
  defectResult.reasons.some((r) => /asserts a motive for the office's own actions/.test(r)));
check('[new] the two are distinct classes, not one reason counted twice',
  defectResult.reasons.filter((r) => /no movement|motive/.test(r)).length === 2);

check('[new] "nothing moved" stays legal when the facts record no output for that project',
  rp.validateReportBody(
    PROJECT_BODY.replace('## 4. Productivity', '## 4. Productivity\n\nNothing moved on office-AI-agents this period.\n\n### Productivity'),
    { factPack: `${FACTS_WITH_MARKER}\n${PACK_WITH_OUTPUT}`, due: '2026-09-07', projects: PROJECT_OBJS }
  ).ok === true);
check('[new] the check is SENTENCE-scoped — crediting one project and clearing another in one report is fine',
  rp.validateReportBody(
    PROJECT_BODY.replace('## 4. Productivity', '## 4. Productivity\n\nNotebook-X took seven gap findings. Nothing moved on office-AI-agents.\n\n### Productivity'),
    { factPack: `${FACTS_WITH_MARKER}\n${PACK_WITH_OUTPUT}`, due: '2026-09-07', projects: PROJECT_OBJS }
  ).ok === true);
check('[new] an inference FROM the facts is not a motive claim (the check is narrow on purpose)',
  !/motive/.test((rp.validateReportBody(
    PROJECT_BODY.replace('## 6. Blocked', '## 6. Blocked\n\nNeither task has a stamped deadline, so neither can be reported as late.\n\n### Blocked'),
    { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projects: PROJECT_OBJS }
  ).reasons || []).join(' ')));
check('[new] other motive phrasings are caught too, not just the one that shipped',
  ['because the team prioritised the board', 'since we deliberately chose the smaller items', 'the office decided to focus on internal work, as they preferred it']
    .every((s) => rp.validateReportBody(`${PROJECT_BODY}\n\n${s}.`, { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projects: PROJECT_OBJS })
      .reasons.some((r) => /asserts a motive/.test(r))));
check('[new] the drafter is told both rules too — the gate enforces, the prompt explains',
  (() => {
    const p = rp.buildDraftPrompt('facts', { reportType: 'weekly', periodLabel: 'week-07' });
    return /Never say a project did not move/.test(p) && /do not explain WHY the office did it/.test(p);
  })());
check('[new] the gate takes full project objects from the runner, keys included',
  /factPack, due, projects: officeProjects\.projects,/.test(runnerSrc));
check('[new] projectNames still works for callers that pass only names (no silent loss of the naming check)',
  rp.validateReportBody(okBody, { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projectNames: PROJECT_NAMES }).ok === false);

/* ── Section 5's running order ───────────────────────────────────────── */
section('§5h  Section 5 leads with output, not with a mood list');

const orderedPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-07',
  artifacts: ['Guides: 3 approved.'], gapSummary: '- data-center: 3 gaps',
  agentRows: [{ agentId: 1, name: 'The Perfectionist', weeklyCases: 2, mood: 'HAPPY', irritation: 0 }],
});
check('[FAILS-OLD] the produced-output block now comes BEFORE the agent-state block in the pack',
  orderedPack.indexOf('WHAT THE OFFICE ACTUALLY PRODUCED') < orderedPack.indexOf('AGENT STATE AND THE IMPROVEMENT LOOP'));
check('[new] and the pack says so explicitly rather than relying on order alone',
  /section 5 OPENS with this/.test(orderedPack)
  && /Do NOT open section 5 with a per-agent mood list/.test(orderedPack));
check('[new] the section heading names output first',
  rp.REQUIRED_SECTIONS[4].heading === '## 5. What the office produced, and agent state');
check('[new] the structural match is no weaker — the key is unchanged and renumbering still fails',
  rp.REQUIRED_SECTIONS[4].key === 'Agent state'
  && rp.validateReportBody(okBody.replace('## 5. Agent state', '## 7. Agent state'), { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === false);
check('[new] a report using the OLD section-5 wording still passes (a reviewer may sharpen a heading)',
  rp.validateReportBody(okBody, { factPack: FACTS_WITH_MARKER, due: '2026-09-07' }).ok === true);

/* ── The silent lane substitution ────────────────────────────────────── */
section('§5i  A fallback nobody notices is a measurement nobody can trust');

check('[FAILS-OLD] the byline used to name only the provider that answered, with no sign one was planned',
  rp.providerLabel(null, 'cloudflare-fallback') === 'cloudflare-fallback');
check('[FAILS-OLD] it now says so when the planned provider did not answer',
  /SUBSTITUTED, groq was planned/.test(rp.providerLabel('groq', 'cloudflare-fallback')));
check('[new] and stays quiet when the plan held',
  rp.providerLabel('gemini', 'gemini') === 'gemini');
check('[new] a missing provider is named as missing, not blanked',
  /NO PROVIDER RECORDED/.test(rp.providerLabel('groq', null)));
check('[new] the byline carries it into the published file',
  /SUBSTITUTED, groq was planned/.test(rp.renderReportFile({
    reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-09', finalReport: okBody,
    drafterName: 'The Workflow', drafterProvider: 'gemini', drafterPlanned: 'gemini',
    reviewerName: 'The QA', reviewerProvider: 'cloudflare-fallback', reviewerPlanned: 'groq',
  })));
check('[new] the runner warns, records the substitution, and returns it to its caller',
  /function noteProviderSubstitution\(role, planned, actual, sink\)/.test(runnerSrc)
  && /PROVIDER SUBSTITUTED on the \$\{role\} call/.test(runnerSrc)
  && /providerSubstitutions: substitutions/.test(runnerSrc));
check('[new] every model call in the pipeline is checked, not just the first',
  (runnerSrc.match(/noteProviderSubstitution\('/g) || []).length === 4);
check('[new] it reaches the D1 row too',
  /PROVIDER SUBSTITUTIONS: \$\{substitutions\.map/.test(runnerSrc));
check('[new] but NOT the revision prompt — an operations fact is not a note about the prose',
  /priorDraft: \{ draftContent: row\.draft_content, reviewNotes: noteWithEdits\(decision\) \}/.test(runnerSrc));
check('[new] the "- None." bullet that published on 2026-08-09 is now read as no edits',
  ['- None.', '- none', '* N/A', '• nothing'].every(
    (v) => rp.parseReportReviewDecision(`DECISION: APPROVE\nNOTES: fine\nEDITS:\n${v}`).edits === ''));

/* ══════════════════════════════════════════════════════════════════════════
 * §6  DECISION PARSING — the failure direction is the safe one
 * ═════════════════════════════════════════════════════════════════════════ */
section('§6  parseReportReviewDecision() — unparseable is a REJECT, never an APPROVE');

check('[new] an unparseable response is a REJECT',
  rp.parseReportReviewDecision('the model wandered off').decision === 'REJECT');
check('[new] an empty response is a REJECT',
  rp.parseReportReviewDecision('').decision === 'REJECT');
check('[new] a decision and a note parse cleanly',
  (() => {
    const d = rp.parseReportReviewDecision('DECISION: APPROVE\nNOTES: leads on the requirements and finishes.');
    return d.decision === 'APPROVE' && /leads on the requirements/.test(d.notes);
  })());
check('[new] an EDITS block parses and does not leak into the note',
  (() => {
    const d = rp.parseReportReviewDecision('DECISION: REVISE\nNOTES: section 4 is thin.\nEDITS:\n- name the projects in section 4\n- cut the last paragraph');
    return /section 4 is thin/.test(d.notes) && !/name the projects/.test(d.notes)
      && /name the projects/.test(d.edits) && /cut the last paragraph/.test(d.edits);
  })());
check('[new] an EDITS block that says "none" is treated as no edits',
  ['none', 'None.', 'N/A', '-', 'no changes needed'].every(
    (v) => rp.parseReportReviewDecision(`DECISION: APPROVE\nNOTES: fine\nEDITS:\n${v}`).edits === ''));

/* ══════════════════════════════════════════════════════════════════════════
 * §6b  THE RE-EMIT CONTRACT — the design cause of the first live failure
 *
 * The published artifact used to be sourced from the reviewer's re-emission of
 * a body it had just been handed. The routing-off reviewer (Groq
 * llama3-8b-8192) emitted DECISION and NOTES and never emitted the
 * ---REPORT--- marker, so the parse returned an empty string and the
 * structural gate refused it. Safe, and it produced nothing.
 *
 * §6b transcribes the OLD parser verbatim and runs the SAME scenarios against
 * both. The old one fails them. That is what makes this a caught bug and not a
 * description of one.
 * ═════════════════════════════════════════════════════════════════════════ */
section('§6b  The re-emit contract — new assertions run against the transcribed pre-change parser');

/** VERBATIM transcription of parseReportReviewDecision() as it stood before
 *  2026-08-09. Do not "fix" it — its job here is to fail. */
function oldParseReportReviewDecision(text) {
  const raw = String(text || '');
  const decisionMatch = raw.match(/DECISION:\s*(APPROVE|REVISE|REJECT)/i);
  const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'REJECT';
  const splitIndex = raw.indexOf('---REPORT---');
  const notesBlock = splitIndex >= 0 ? raw.slice(0, splitIndex) : raw;
  const notesMatch = notesBlock.match(/NOTES:\s*([\s\S]*)$/);
  const notes = notesMatch ? notesMatch[1].trim() : '';
  const finalReport = splitIndex >= 0 ? raw.slice(splitIndex + '---REPORT---'.length).trim() : '';
  return { decision, notes, finalReport: decision === 'APPROVE' ? finalReport : '' };
}

// The response the live reviewer actually returned: a decision and a note, no
// marker, no re-typed report.
const REAL_8B_REVIEW = 'DECISION: APPROVE\nNOTES: The report leads on the client requirements with the due date visible and every figure traces to the FACTS.';
const GATE_OPTS = { factPack: FACTS_WITH_MARKER, due: '2026-09-07', projectNames: PROJECT_NAMES };

check('[FAILS-OLD] the pre-change path produced NOTHING publishable from a real reviewer response',
  rp.validateReportBody(oldParseReportReviewDecision(REAL_8B_REVIEW).finalReport, GATE_OPTS).ok === false);
check('[FAILS-OLD] and it failed for the CHARACTERISTIC reason — an empty body under the char floor',
  rp.validateReportBody(oldParseReportReviewDecision(REAL_8B_REVIEW).finalReport, GATE_OPTS)
    .reasons.some((r) => /under the 1200-char floor|missing or truncated/.test(r)));
check('[FAILS-OLD] the SAME reviewer response now publishes the stored draft through the SAME gate',
  (() => {
    const d = rp.parseReportReviewDecision(REAL_8B_REVIEW);
    return d.decision === 'APPROVE' && rp.validateReportBody(PROJECT_BODY, GATE_OPTS).ok === true;
  })());

// The tidy-up guard. A future session that reintroduces the re-emit contract
// as a cleanup has to delete these two checks to do it.
check('[new] the parser exposes NO finalReport field — the publish path cannot read one',
  !('finalReport' in rp.parseReportReviewDecision(REAL_8B_REVIEW)));
check('[new] the publish path reads the STORED DRAFT, not the reviewer\'s output',
  /const finalReport = row\.draft_content \|\| '';/.test(runnerSrc)
  && /const structural = validateReportBody\(finalReport, \{/.test(runnerSrc));
check('[new] and the gate it goes through is the identical one — every check still runs',
  /validateReportBody\(finalReport, \{[\s\S]{0,500}?factPack, due, projects: officeProjects\.projects,/.test(runnerSrc));
check('[new] the review contract no longer asks the reviewer for the report',
  !/---REPORT---/.test(rp.REVIEW_SYSTEM) && /You do not rewrite it and you do not reproduce it/.test(rp.REVIEW_SYSTEM));
check('[new] a reviewer that re-emits the report ANYWAY has that text discarded, not published',
  (() => {
    const d = rp.parseReportReviewDecision(`DECISION: APPROVE\nNOTES: fine\n---REPORT---\n${okBody}`);
    return d.reEmitted === true && !/At a glance/.test(d.notes) && !/At a glance/.test(d.edits || '');
  })());
check('[new] and the runner says so in the log rather than absorbing it silently',
  /decision\.reEmitted[\s\S]{0,200}?DISCARDED/.test(runnerSrc));
check('[new] EDITS are RECORDED, NEVER APPLIED — nothing rewrites the draft between decision and commit',
  /RECORDED, NOT APPLIED/.test(rp.renderReportFile({
    reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-09', finalReport: okBody,
    drafterName: 'The Workflow', drafterProvider: 'gemini', reviewerName: 'The QA', reviewerProvider: 'groq',
    reviewerEdits: '- tighten section 3',
  })));
// RAISED AGAIN 2026-08-11, and this check raised with it — see
// agent-runner.js's own comment on REPORT_REVIEW_MAX_TOKENS for why 500
// (right for a non-reasoning reviewer that only emits DECISION/NOTES/EDITS)
// stopped being enough the moment the judgment lane's primary became a
// reasoning model whose thinking is charged against the same budget. The
// property this check still needs to hold — "not a whole re-emitted
// report's worth of tokens" — holds at 3,500 exactly as it held at 500; this
// is not the 1,600-token pre-fix figure returning.
check('[new] the review output budget still is not sized for a whole re-emitted report (the other half of the fit fix)',
  /const REPORT_REVIEW_MAX_TOKENS = 3500;/.test(runnerSrc) && !/const REPORT_REVIEW_MAX_TOKENS = 1600;/.test(runnerSrc));

/* ══════════════════════════════════════════════════════════════════════════
 * §7  THE PIPELINE CONTRACT IN THE RUNNER
 * ═════════════════════════════════════════════════════════════════════════ */
section('§7  The orchestration rules, asserted against the runner source');

check('[new] runReportPipeline() checks the gate FIRST and returns before any work',
  /async function runReportPipeline\([\s\S]{0,400}?if \(!bypassGate && !\(await reportPipelineOn\(env\)\)\)[\s\S]{0,200}?return \{ ran: false, skipped: true, reason: 'report_pipeline_disabled' \}/.test(runnerSrc));
check('[new] exactly one revision round — a second REVISE becomes a REJECT',
  /if \(decision\.decision === 'REVISE'\) decision = \{ \.\.\.decision, decision: 'REJECT' \}/.test(runnerSrc));
check('[new] a structurally-failed APPROVE leaves the row drafted (not rejected, not published)',
  /approve_failed_structural_check/.test(runnerSrc) && !/status: 'rejected'[\s\S]{0,200}approve_failed_structural_check/.test(runnerSrc));
check('[new] the self-QA check runs against the provider that ANSWERED, not the one planned',
  /assertDistinctReviewer\(\{[\s\S]{0,200}draftProvider: row\.drafter_provider,\s*reviewProvider: review\.provider/.test(runnerSrc));
check('[new] the pipeline never opens a GitHub Issue and never emails the owner',
  !/runReportPipeline[\s\S]{0,9000}?(createIssue|sendEmail|resend)/i.test(runnerSrc));
check('[new] gemini-pacer refusal makes the report WAIT — it does not fall through to another provider',
  /if \(!pacing\.allowed\) return \{ text: null, provider: null, planned: plan\.provider, reason: 'gemini_pacing' \}/.test(runnerSrc));
check('[new] the weekly summary never lets a failed report break the block',
  /try \{[\s\S]{0,600}?runReportPipeline\(env, \{[\s\S]{0,400}?reportType: 'weekly'[\s\S]{0,400}?\}\);[\s\S]{0,200}?\} catch/.test(runnerSrc));
check('[new] the monthly report runs AFTER the monthly meeting, so the meeting reaches the fact pack',
  /milestoneMeeting = await runMeeting\(MILESTONE_MEETINGS\[milestoneKey\], env\);[\s\S]{0,700}?generateMonthlyReport\(env/.test(runnerSrc));

/* ══════════════════════════════════════════════════════════════════════════
 * §8  SWITCH OFF => THE CURRENT REPORT OUTPUT IS BYTE-IDENTICAL
 *
 * The claim is scoped precisely, because a vague version of it would be
 * false: with `report_pipeline_enabled` off, the three files
 * generateWeeklySummary() commits today are committed with the same paths,
 * the same template and the same commit messages, and NO fourth file is
 * written. Holding office-context input constant, the bytes do not move.
 *
 * (Item 1.2b's `projects` change DOES alter report content, deliberately —
 * that is its entire purpose, it is governed by `office_context_enabled`,
 * and it is a different switch. §2 above measures it rather than hiding it.)
 * ═════════════════════════════════════════════════════════════════════════ */
section('§8  With the switch off, the existing weekly output is unchanged');

const weeklyFn = runnerSrc.slice(
  runnerSrc.indexOf('async function generateWeeklySummary'),
  runnerSrc.indexOf('async function generateMonthlyReport')
);

check('[new] the three existing template commits are still there, at the same paths',
  /\$\{base\}\/week-\$\{pad\(weekNumber, 2\)\}-summary\.md/.test(weeklyFn)
  && /\$\{base\}\/week-\$\{pad\(weekNumber, 2\)\}-data\.csv/.test(weeklyFn)
  && /\$\{base\}\/week-\$\{pad\(weekNumber, 2\)\}-public-summary\.md/.test(weeklyFn));
check('[new] with the same commit messages',
  /chore\(office\): week \$\{weekNumber\} executive summary \[skip ci\]/.test(weeklyFn));
check('[new] the pipeline is ADDITIVE — its commit happens inside runReportPipeline, not in the template block',
  !/commitFileToRepo\([^)]*week-\$\{pad\(weekNumber, 2\)\}-report/.test(weeklyFn));
check('[new] the written report goes to a DIFFERENT path, so it can never overwrite the template output',
  rp.reportPath('weekly', 'week-07') === 'reports/weekly/week-07-report.md');
check('[new] and the rejected one goes somewhere else again',
  rp.rejectedReportPath('weekly', 'week-07') === 'reports/_drafts/weekly-week-07.md');

// The gated no-op, exercised for real: a throwing DB and a throwing KV, and
// the fetch tripwire still armed. If the gate did not return first, one of
// the three would fire.
const hostileEnv = {
  SIM_KV: { get: async () => ({}) },
  DB: { prepare: () => { throw new Error('DB TOUCHED while the switch was off'); } },
};
let gatedResult = null;
let gatedThrew = null;
try {
  const mod = runnerSrc; // the runner cannot be imported under plain node (JSON imports); assert on the source
  void mod;
  gatedResult = await (async () => {
    // Re-implement nothing: call the exported switch the gate uses, with the
    // hostile env, and assert it reports OFF without touching DB or network.
    const on = await rp.reportPipelineEnabled(hostileEnv);
    return { on };
  })();
} catch (err) {
  gatedThrew = err;
}
check('[new] reading the switch with a hostile env touches neither D1 nor the network',
  gatedThrew === null && gatedResult.on === false && NETWORK_CALLS.length === 0);

/* ══════════════════════════════════════════════════════════════════════════
 * §8b  THE INDEX — newest first, and it never deletes the archive
 * ═════════════════════════════════════════════════════════════════════════ */
section('§8b  reports/LATEST.md — an index, not an archive');

const seedIndex = rp.renderLatestIndex([]);
check('[new] an empty index says so rather than rendering a bare header',
  /No reviewed reports have been published yet/.test(seedIndex));
// WAS: `read('reports/LATEST.md') === seedIndex` — "the shipped seed matches
// what the code renders, so there is no drift on the first publish". That
// check expired the moment it succeeded: the first publish landed 2026-08-09
// and the live index now carries a real entry, so the assertion started
// failing for the exact reason it was written to allow.
//
// Replaced with the property that holds for the file's whole life rather than
// only before its first write: whatever `reports/LATEST.md` currently contains,
// the parser reads it and the renderer reproduces it. That catches drift
// between the committed file and the code on every future publish, not just
// the first.
{
  // Line endings are normalised on both sides. The Worker writes LF through the
  // GitHub API; a Windows checkout with core.autocrlf brings it back as CRLF.
  // That is a property of whoever ran `git clone`, not of the pipeline, and a
  // verifier that fails on it would be reporting the developer's git config.
  const lf = (s) => String(s).replace(/\r\n/g, '\n').trim();
  const liveIndex = read('reports/LATEST.md');
  const parsed = rp.parseLatestIndex(liveIndex);
  check('[new] the live index round-trips through the parser and renderer (drift check, every publish)',
    lf(rp.renderLatestIndex(parsed)) === lf(liveIndex));
  check('[new] and it is no longer the empty seed — the pipeline has actually published',
    parsed.length > 0 && lf(liveIndex) !== lf(seedIndex));
}

const e1 = { title: 'Weekly report — week-07', path: '/reports/weekly/week-07-report.md', reportType: 'weekly', dateStr: '2026-08-08', words: 948 };
const e2 = { title: 'Weekly report — week-08', path: '/reports/weekly/week-08-report.md', reportType: 'weekly', dateStr: '2026-08-15', words: 812 };
const idx1 = rp.addToLatestIndex([], e1);
const idx2 = rp.addToLatestIndex(idx1, e2);
check('[new] the newest entry is first', idx2[0].path === e2.path && idx2[1].path === e1.path);
check('[new] republishing the same period moves it to the top rather than duplicating',
  rp.addToLatestIndex(idx2, e1).filter((e) => e.path === e1.path).length === 1);
check('[new] the index round-trips through its own renderer and parser',
  (() => {
    const parsed = rp.parseLatestIndex(rp.renderLatestIndex(idx2));
    return parsed.length === 2 && parsed[0].path === e2.path && parsed[0].words === 812;
  })());
check('[new] the index is BOUNDED and says what it omitted — no silent caps',
  (() => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...e1, path: `/reports/weekly/week-${i}-report.md` }));
    const text = rp.renderLatestIndex(many);
    return rp.parseLatestIndex(text).length === rp.LATEST_INDEX_KEEP
      && new RegExp(`most recent of 30`).test(text);
  })());
check('[new] a failed index update never un-publishes the report it indexes',
  /The index is a convenience\. A report that published successfully is[\s\S]{0,120}not un-published/.test(runnerSrc));
check('[new] the index is only written when the report itself committed',
  /if \(commit\.committed\) \{[\s\S]{0,300}?parseLatestIndex\(/.test(runnerSrc));

/* ══════════════════════════════════════════════════════════════════════════
 * §9  HOUSEKEEPING
 * ═════════════════════════════════════════════════════════════════════════ */
section('§9  Housekeeping');

check('[new] period labels are stable and sortable',
  rp.periodLabelFor('weekly', 7) === 'week-07' && rp.periodLabelFor('monthly', 2) === 'month-02');
check('[new] daysUntil() returns null for an unreadable due date, never a guess',
  rp.daysUntil(null) === null && rp.daysUntil('not a date') === null);
check('[new] daysUntil() computes a real remaining count',
  rp.daysUntil('2026-09-07', Date.parse('2026-08-08T00:00:00Z')) === 30);
check('[new] the byline names both personas AND both providers (the embodiment record)',
  (() => {
    const f = rp.renderReportFile({
      reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-08', finalReport: okBody,
      drafterName: 'The Workflow', drafterProvider: 'gemini',
      reviewerName: 'The QA', reviewerProvider: 'groq', revisionCount: 0,
    });
    return /The Workflow \(gemini\)/.test(f) && /The QA \(groq\)/.test(f);
  })());
check('[new] a rejected report is SAVED with its note (never escalated, never dropped)',
  /Reviewer's note/.test(rp.renderRejectedReportFile({
    reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-08',
    draftContent: 'draft', reviewNotes: 'section 1 missing', drafterName: 'The Workflow', reviewerName: 'The QA',
  })));
check('[new] the fact pack renders an unreadable due date as a DEFECT, not as an absent deadline',
  /UNVERIFIED/.test(rp.buildFactPack({
    reportType: 'weekly', periodLabel: 'week-07', dateStr: '2026-08-08',
    requirements: { requirements: [{ id: 'REQ-001', title: 'x', status: 'in progress', urgent: true }], due: null },
  })));
check('[new] the fact pack says "no decisions" plainly rather than omitting the section',
  /no product decisions were taken/i.test(rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-07', decisions: [] })));

/* ── The decisions defect, found 2026-08-08 ──────────────────────────────
 * The office does not persist meeting decisions to D1 — `reports` has only
 * ever carried incident / status / gap_hebrew / model_education /
 * office_event. A decisions query therefore returns zero rows for a week in
 * which meetings genuinely happened, and zero rendered as "nothing was
 * decided" is a confident falsehood. These three checks pin the
 * discriminator: never-recorded and none-this-period must not collapse. */
check('[new] "we could not look" is seeded as UNVERIFIED, never as an empty result',
  /let decisions = \['UNVERIFIED/.test(runnerSrc));

/* ── OB-028: the decisions query read the WRONG TABLE ────────────────────
 * meeting-engine.js persistMeeting() has always inserted into `meetings`
 * (id, type, attendees, transcript, decisions). The fact pack queried
 * `reports`, which has never carried a meeting row, and published the zero as
 * "the office does not persist meeting decisions or votes to a queryable
 * store". Measured live 2026-08-09: 43 meeting rows, 6 weekly, most recent
 * two days before the report that said they did not exist. */
section('§9b  OB-028 — meeting decisions were queried from the wrong table');

check('[FAILS-OLD] the old query read `reports`, which carries no meeting row',
  !/FROM reports\s+WHERE type IN \('meeting'/.test(runnerSrc));
check('[FAILS-OLD] and the false claim it published is gone from the source',
  !/does not persist meeting decisions or votes to a queryable store/.test(runnerSrc));
check('[FAILS-OLD] the decisions now come from the table meeting-engine.js actually writes',
  /SELECT type, decisions, created_at FROM meetings/.test(runnerSrc)
  && /INSERT INTO meetings \(id, type, attendees, transcript, decisions, created_at\)/.test(read('workers/meeting-engine.js')));
check('[new] THREE states are distinguished, not two — the third is the one the office is in',
  /EVERY one recorded an empty decision block/.test(runnerSrc)
  && /no meeting has ever been recorded/.test(runnerSrc)
  && /the meetings table could not be read/.test(runnerSrc));
check('[new] an empty extraction is named as a defect in the extractor, not as a quiet meeting',
  /defect in the office\\'s decision extraction/.test(runnerSrc)
  && /NOT evidence that nothing was decided/.test(runnerSrc));
check('[new] partial extraction failure is counted and surfaced alongside the real decisions',
  /further meeting\(s\) this period recorded an EMPTY decision block/.test(runnerSrc));
check('[new] a genuinely quiet period still says so plainly (the empty array reaches the fact pack)',
  /decisions = \[\];\s+\/\/ genuinely quiet period/.test(runnerSrc));
check('[new] and every UNVERIFIED branch asks for the literal token, per §5e',
  (runnerSrc.match(/literal word UNVERIFIED/g) || []).length >= 3);

/* ── OB-031: a 24-hour figure under a `weekly_cases` header ──────────────
 * Left in place deliberately. Widening the window would change what an
 * existing column MEANS without changing its name, putting a step change into
 * a series a reader compares across weeks — a false trend is worse than a
 * stable wrong number. Fixed additively instead. */
section('§9c  OB-031 — fixed by adding a column, not by moving a series');

check('[new] the misnamed function is UNCHANGED, so no archived row changes meaning',
  /const since = new Date\(Date\.now\(\) - 24 \* 60 \* 60 \* 1000\)\.toISOString\(\);/.test(runnerSrc));
check('[new] and is now labelled as misnamed where someone would "fix" it',
  /MISNAMED, AND DELIBERATELY LEFT THAT WAY/.test(runnerSrc));
check('[FAILS-OLD] a correct windowed count exists alongside it, with the window in the parameter',
  /async function getCasesHandledOverDays\(env, agentId, days = 7\)/.test(runnerSrc));
check('[FAILS-OLD] the CSV carries BOTH columns — the old series is not rewritten',
  /'agent_id,name,weekly_cases,cases_7d,mood,irritation'/.test(runnerSrc));
check('[new] an unreadable count is UNVERIFIED in the CSV, never 0',
  /r\.cases7d \?\? 'UNVERIFIED'/.test(runnerSrc)
  && /return row \? \(row\.total \|\| 0\) : null;/.test(runnerSrc));
check('[new] the summary explains the discontinuity in words, so the new column is not read as a jump',
  /Two case columns, and why \(OB-031/.test(runnerSrc)
  && /that never\s*\n?> happened/.test(runnerSrc));
check('[new] the rename is boarded rather than taken — it would break any header consumer',
  /Renaming `weekly_cases` to what it actually holds is\s*\n \* the right end state and is an owner decision/.test(runnerSrc));
check('[new] the fact pack\'s empty branch states that the record is known to be working',
  /the record is known to be working/.test(rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-07', decisions: [] })));
check('[new] report_pipeline is declared in database/schema.sql',
  /CREATE TABLE IF NOT EXISTS report_pipeline/.test(read('database/schema.sql')));
check('[new] the D1 shape in code matches the declared schema (both carry both provider columns)',
  /drafter_provider TEXT/.test(rp.REPORT_PIPELINE_TABLE_SQL) && /reviewer_provider TEXT/.test(rp.REPORT_PIPELINE_TABLE_SQL));

/* ══════════════════════════════════════════════════════════════════════════
   §12 — 2026-08-10: DISPATCH IS COUNTED, AND OUTPUT IS INDEXED ON THE REPO
   OB-036 and OB-038. Both were "the fact pack cannot see something the office
   already records", and both are proved here against the REAL consumer rather
   than against the text of the line.
   ══════════════════════════════════════════════════════════════════════════ */
section('§12 dispatch counting and repo-write attribution (2026-08-10)');

const BOARD_2 = {
  counts: { total: 3, READY: 2, 'IN-PROGRESS': 1 },
  tasks: [
    { id: 'OB-001', state: 'READY', assignee: 'Agent 13', title: 'a' },
    { id: 'OB-017', state: 'READY', assignee: 'Agent 4', title: 'b', offered: '2026-08-10 · available to an unattended run' },
    { id: 'OB-018', state: 'IN-PROGRESS', assignee: 'Agent 4', title: 'c', dispatched: '2026-08-09 · held by headless Architect run' },
  ],
};

const dispatchedPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-08', board: BOARD_2,
  dispatchedCount: 1, inProgressCount: 1, offeredCount: 1,
});
check('[FAILS-OLD] a real dispatch count reaches the pack instead of UNVERIFIED',
  /^DISPATCHED: 1 of the 3 tasks/m.test(dispatchedPack) && !/DISPATCHED: UNVERIFIED/.test(dispatchedPack));
check('[new] an OFFERED task is reported as still on the board and still claimable',
  /OFFERED to an unattended Architect run: 1\./.test(dispatchedPack)
  && /does NOT remove a task from the board or block it/.test(dispatchedPack));

// THE ZERO CASE. This is the one that would regress under a tidy-up: a reader
// who changed `!= null` to a truthiness test would send 0 down the UNVERIFIED
// path and republish the exact confusion the pipeline exists to prevent.
const zeroDispatchPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-08', board: BOARD_2,
  dispatchedCount: 0, inProgressCount: 0,
});
check('[new] ZERO dispatched renders as a real measurement, never as UNVERIFIED',
  /^DISPATCHED: 0 of the 3 tasks/m.test(zeroDispatchPack) && !/DISPATCHED: UNVERIFIED/.test(zeroDispatchPack));
check('[new] ...and the pack says explicitly not to write UNVERIFIED for it',
  /Zero dispatched is a REAL measurement/.test(zeroDispatchPack));

// The two board fields disagreeing is a defect in the board's own record, and
// the report carries it rather than silently preferring one number.
const skewPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-08', board: BOARD_2,
  dispatchedCount: 1, inProgressCount: 3,
});
check('[new] IN-PROGRESS and Dispatched disagreeing is REPORTED, not reconciled',
  /3 task\(s\) are IN-PROGRESS but 1 carry a Dispatched line/.test(skewPack));

// ── OB-038: the attribution has to reach the CHECK, not just the pack ──────
const projects = [
  { key: 'notebook-x', name: 'Notebook-X' },
  { key: 'office-agents', name: 'office-AI-agents' },
];
const unattributedPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-07',
  artifacts: ['Guides: 5 approved.'],
  gapSummary: '- notebook-x: 5 capability gap(s) flagged against that system this period',
  repoWrites: [],
});
check('[FAILS-OLD] the week-07 shape credits notebook-x and NOT office-AI-agents',
  rp.projectsWithOutput(unattributedPack, projects).map((p) => p.key).join(',') === 'notebook-x');
check('[FAILS-OLD] ...so "Nothing moved" about office-AI-agents was consistent with every fact given',
  rp.validateReportBody(
    ['# R', '## Summary', 'Nothing moved on office-AI-agents this week. Notebook-X saw five findings.',
      ...rp.REQUIRED_SECTIONS.map((s) => `## ${s.n}. ${s.key}`), rp.REPORT_SENTINEL].join('\n'),
    { factPack: unattributedPack, projects }
  ).reasons.every((r) => !/no movement on office-AI-agents/.test(r)));

const attributedPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-07',
  artifacts: ['Guides: 5 approved.'],
  gapSummary: '- notebook-x: 5 capability gap(s) flagged against that system this period',
  repoWrites: ['office-AI-agents: 61 file(s) committed.'],
});
check('[FAILS-OLD] with the repo axis present, office-AI-agents IS credited with output',
  rp.projectsWithOutput(attributedPack, projects).map((p) => p.key).sort().join(',') === 'notebook-x,office-agents');
check('[FAILS-OLD] ...and the exact sentence week-07 published is now REFUSED by the unchanged check',
  rp.validateReportBody(
    ['# R', '## Summary', 'Nothing moved on office-AI-agents this week. Notebook-X saw five findings.',
      ...rp.REQUIRED_SECTIONS.map((s) => `## ${s.n}. ${s.key}`), rp.REPORT_SENTINEL].join('\n'),
    { factPack: attributedPack, projects }
  ).reasons.some((r) => /no movement on office-AI-agents/.test(r)));
check('[new] the two axes are labelled as two axes, so a reader does not treat 5a as complete',
  /index the SAME work on two different axes/.test(attributedPack));

// null vs [] — "we could not look" must not render as "we looked and found none".
const unreadableWrites = rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-08', repoWrites: null });
check('[new] an unreadable repo-write record renders UNVERIFIED, not zero',
  /5a-bis[\s\S]*?UNVERIFIED — the repo-write record could not be read/.test(unreadableWrites));
check('[new] ...and forbids inferring that nothing was written',
  /Do NOT infer that nothing was written/.test(unreadableWrites));
check('[new] an EMPTY record names the date recording began, so a pre-2026-08-10 zero is not read as a fact',
  /recording of repo writes began 2026-08-10/.test(
    rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-08', repoWrites: [] })
  ));

// The recorder itself: it may never cost a write.
const rwSrc = read('workers/repo-write.js');
check('[new] recordRepoWrite runs AFTER the PUT, never before it',
  rwSrc.indexOf('method: \'PUT\'') < rwSrc.lastIndexOf('await recordRepoWrite('));
check('[new] recordRepoWrite cannot throw — it swallows and warns, like recordOfficeEvent',
  /export async function recordRepoWrite[\s\S]*?try \{[\s\S]*?\} catch \(err\) \{[\s\S]*?console\.warn/.test(rwSrc));
check('[new] the record does NOT appear in commitFileToRepo\'s return value (nothing may branch on it)',
  /return \{ committed: res\.ok, status: res\.status, path \};/.test(rwSrc));
check('[new] a DENIED write is not recorded as output (a denial is not an artifact)',
  rwSrc.indexOf('return { committed: false, reason: verdict.reason') < rwSrc.lastIndexOf('await recordRepoWrite('));
check('[new] the table is created lazily, the same call task-router.js made for provider_usage',
  /CREATE TABLE IF NOT EXISTS repo_writes/.test(rwSrc)
  && !/repo_writes/.test(read('database/schema.sql')));

// The Architect's night work: present only when filed, and never a cadence.
const nightPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-08',
  architectRuns: [{ title: 'Architect session — 2026-08-10 (build)', created_at: '2026-08-10 05:00:34' }],
});
check('[new] a filed unattended Architect session reaches the pack',
  /Unattended Architect sessions filed this period: 1\./.test(nightPack));
check('[new] ...and the pack forbids reporting it as a schedule or implying another is expected',
  /NOT a shift and NOT a schedule/.test(nightPack) && /do not imply the next one is expected/.test(nightPack));
check('[new] with no run filed, the pack says NOTHING about night work (absence is not a quiet night)',
  !/Unattended Architect session/.test(rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-08' })));

// Open questions reach the client-facing report, with their fallbacks.
const qPack = rp.buildFactPack({
  reportType: 'weekly', periodLabel: 'week-08',
  questions: {
    counts: { total: 2, open: 1, closed: 1 },
    questions: [
      { id: 'Q-001', question: 'which products?', open: true, askedBy: 'Agent 12 — The Workflow', date: '2026-08-10', blocking: 'REQ-004', fallback: 'REQ-004 goes last, marked provisional.' },
      { id: 'Q-002', question: 'answered one', open: false, askedBy: 'Agent 9', date: '2026-08-09', blocking: 'REQ-006', fallback: 'x' },
    ],
  },
});
check('[new] an open question reaches the client-facing report with its fallback',
  /Q-001 \(Agent 12 — The Workflow, 2026-08-10\): which products\?/.test(qPack)
  && /if no answer comes: REQ-004 goes last/.test(qPack));
check('[new] ...and must NOT be reported as blocked work',
  /NOT as blocked work/.test(qPack));
check('[new] an unreadable questions channel is UNREADABLE, not "nothing to ask"',
  /UNREADABLE — the office→owner questions channel/.test(
    rp.buildFactPack({ reportType: 'weekly', periodLabel: 'week-08' })
  ));

/* ══════════════════════════════════════════════════════════════════════════
 * §N  THE DUPLICATE-PUBLISH GUARD (fixed 2026-08-14) — getPendingReportRow()
 * only ever sees status='drafted' rows, so an already-approved period was
 * invisible to it and could be re-drafted and re-approved, overwriting a
 * published report (including manual owner corrections appended after
 * publish — reports/weekly/week-07-report.md, commit 4337350). Audit א.4.
 *
 * getLatestReportRow() was imported and never called — but wiring THAT
 * function alone as the guard is insufficient, confirmed against live D1
 * before this went in: week-07 carries 3 approved rows from 2026-08-09
 * followed by 7 REJECTED retries through 2026-08-14 (the self-locking gate,
 * audit א.2/Phase 2), so its MOST RECENT row is 'rejected'. A guard that
 * only checks the latest row would be blind to exactly this case. The fix
 * adds getApprovedReportRow() (status='approved' in the WHERE clause, not
 * just the newest row) and guards on THAT.
 * ═════════════════════════════════════════════════════════════════════════ */
section('§N  Duplicate-publish guard — an approved period refuses to re-draft');

const runReportPipelineSrc = (() => {
  const start = runnerSrc.indexOf('async function runReportPipeline(');
  const end = runnerSrc.indexOf('\nasync function routingEnabledForReports');
  return runnerSrc.slice(start, end);
})();

check('[new] getApprovedReportRow is actually CALLED, not just imported',
  /const approvedForGuard = await getApprovedReportRow\(env, reportType, periodLabel\);/.test(runReportPipelineSrc));
check('[new] the guard refuses when an approved row exists',
  /if \(approvedForGuard\) \{/.test(runReportPipelineSrc)
  && /reason: `already_approved:/.test(runReportPipelineSrc));
check('[new] the guard runs BEFORE the fact pack is built (buildReportFacts)',
  runReportPipelineSrc.indexOf('const approvedForGuard = await getApprovedReportRow') <
  runReportPipelineSrc.indexOf('buildReportFacts('));
check('[new] the guard runs BEFORE every model call in the function (callReportModel)',
  runReportPipelineSrc.indexOf('const approvedForGuard = await getApprovedReportRow') <
  runReportPipelineSrc.indexOf('callReportModel('));
check('[new] the guard is NOT gated behind bypassGate — a manual re-fire against an already-published period must refuse exactly like a cron tick',
  !/if \(!bypassGate[^)]*\)[\s\S]{0,40}getApprovedReportRow/.test(runReportPipelineSrc)
  && /const approvedForGuard = await getApprovedReportRow\(env, reportType, periodLabel\);\r?\n\s*if \(approvedForGuard\)/.test(runReportPipelineSrc));

// ── [FAILS-OLD] transcribed row-selection logic ────────────────────────────
// getPendingReportRow()'s real SQL is `WHERE status = 'drafted'`;
// getLatestReportRow()'s is the same query with NO status filter, ORDER BY
// created_at DESC LIMIT 1; getApprovedReportRow()'s adds `AND status =
// 'approved'` back in, but keeps LIMIT 1 on recency WITHIN that filter, so
// it is not simply "the latest row" filtered after the fact. All three are
// transcribed here in pure JS (no D1 needed) against a fixture rows table
// shaped exactly like live week-07: one old approval, then several newer
// rejections on top of it. This is the actual bug being reproduced, not a
// description of the fix.
const fixtureRows = [
  { id: 'row-1', report_type: 'weekly', period_label: 'week-07', status: 'approved', created_at: '2026-08-09T11:55:10Z' },
  { id: 'row-2', report_type: 'weekly', period_label: 'week-07', status: 'rejected', created_at: '2026-08-11T16:50:21Z' },
  { id: 'row-3', report_type: 'weekly', period_label: 'week-07', status: 'rejected', created_at: '2026-08-14T09:02:58Z' },
];
const oldPendingSelect = (rows, reportType, periodLabel) =>
  rows.filter((r) => r.report_type === reportType && r.period_label === periodLabel && r.status === 'drafted')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
const latestSelect = (rows, reportType, periodLabel) =>
  rows.filter((r) => r.report_type === reportType && r.period_label === periodLabel)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
const approvedSelect = (rows, reportType, periodLabel) =>
  rows.filter((r) => r.report_type === reportType && r.period_label === periodLabel && r.status === 'approved')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;

check('[FAILS-OLD] old pending-only selection is BLIND to the approved row — the actual bug: it would have proceeded to draft from scratch',
  oldPendingSelect(fixtureRows, 'weekly', 'week-07') === null);
check("[FAILS-OLD] a latest-row-only guard would ALSO have been blind here — week-07's newest row is 'rejected', not 'approved'",
  latestSelect(fixtureRows, 'weekly', 'week-07')?.status === 'rejected');
check('[new] getApprovedReportRow SEES the approval regardless of what landed after it — this is what actually protects week-07',
  approvedSelect(fixtureRows, 'weekly', 'week-07')?.id === 'row-1');

// A period with only a drafted (unreviewed) row, or only rejected rows, must
// NOT be refused — the guard is specifically for "was ever approved", not
// for "any row exists".
const draftedOnlyRows = [
  { id: 'row-4', report_type: 'weekly', period_label: 'week-08', status: 'drafted', created_at: '2026-08-14T09:00:00Z' },
];
check('[new] a period with only a drafted row is NOT refused (recovery must still work)',
  approvedSelect(draftedOnlyRows, 'weekly', 'week-08') === null);
const rejectedOnlyRows = [
  { id: 'row-5', report_type: 'weekly', period_label: 'week-09', status: 'rejected', created_at: '2026-08-14T09:00:00Z' },
];
check('[new] a period with only rejected rows (never approved) is NOT refused',
  approvedSelect(rejectedOnlyRows, 'weekly', 'week-09') === null);

/* ══════════════════════════════════════════════════════════════════════════ */
section('─────────────────────────────────────────────────────────────');
console.log(`\n  ${pass} passed, ${fail} failed  (${pass + fail} checks)`);
console.log(`  network calls attempted: ${NETWORK_CALLS.length}`);
if (failures.length) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`    - ${f}`);
}
process.exit(fail === 0 && NETWORK_CALLS.length === 0 ? 0 : 1);
