#!/usr/bin/env node
/**
 * scripts/verify-office-policy.js — proves the policy is LOAD-BEARING, and pins
 * the in-code digest against the real document.
 *
 * Run: node scripts/verify-office-policy.js
 *
 * ── THE DRIFT THIS EXISTS TO MAKE IMPOSSIBLE ─────────────────────────────
 *
 * `workers/office-policy.js` carries a TRANSCRIBED summary of five rules, and a
 * transcription is a second copy. OFFICE-POLICY.md A9 says it plainly: *"One
 * file, two layers. Never two copies — copies diverge, and this project already
 * has a document two edits behind its counterpart."*
 *
 * The copy is unavoidable — the alternative is 5,586 tokens of policy in every
 * prompt — so the divergence is made into a FAILING CHECK instead. §2 reads the
 * real `back-office-AI-agents/docs/OFFICE-POLICY.md` from the sibling checkout
 * and asserts that every rule the digest cites exists, that the re-check date in
 * code matches the file, and that the ⚖️ provisional set in code is exactly the
 * ⚖️ provisional set in the file.
 *
 * ── WHEN THE SIBLING CHECKOUT IS ABSENT ──────────────────────────────────
 *
 * back-office is a PRIVATE repo and this one is public, so CI here may well not
 * have it. §2 then reports SKIPPED, loudly, with the path it looked for — and
 * the run does NOT pass silently as though it had checked. A verifier that
 * reports "ok" when it verified nothing is this project's §7.2 defect wearing a
 * green tick.
 *
 * NO NETWORK. globalThis.fetch is a tripwire.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = path.resolve(ROOT, '..', 'back-office-AI-agents', 'docs', 'OFFICE-POLICY.md');

globalThis.fetch = () => { throw new Error('verify-office-policy.js made a network call — it must not'); };

const policy = await import('../workers/office-policy.js');
const officeContext = await import('../workers/office-context.js');

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`); }
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}
function skip(name, why) { skipped += 1; console.log(`  SKIP  ${name}  — ${why}`); }

/* ═══════════════ §1 the digest is well-formed on its own ════════════════ */
section('§1 the digest — shape, coverage, and what may never be cut');

check('the digest covers exactly the five operative rules',
  policy.POLICY_DIGEST.map((d) => d.id).join(',') === 'A1,A2,A7,A8,A15',
  policy.POLICY_DIGEST.map((d) => d.id).join(','));
check('every entry has BOTH a brief and a full rendering',
  policy.POLICY_DIGEST.every((d) => d.brief && d.full));
check('brief is genuinely shorter than full for every rule (else the shapes are decoration)',
  policy.POLICY_DIGEST.every((d) => d.brief.length < d.full.length));
check('A1 is marked never-cut', policy.NEVER_CUT.includes('A1'));

const brief = policy.buildPolicyBlock('brief');
const full = policy.buildPolicyBlock('full');
check('the brief block names the source file, so an agent can go read the authority',
  brief.text.includes(policy.POLICY_PATH));
check('the brief block says the owner is the only editor',
  /only editor/i.test(brief.text));
check('the brief block names the provisional rules and the re-check date',
  brief.text.includes('⚖️') && brief.text.includes(policy.POLICY_RECHECK_DATE));
check('A1 survives in the brief shape', /A1 RED LINE/.test(brief.text));
check('the one-active-branch rule reaches every agent, in both shapes',
  /ONE ACTIVE BRANCH PER PROJECT/.test(brief.text) && /one active branch per project/i.test(full.text));
check('brief costs less than full', brief.tokens < full.tokens, `${brief.tokens} vs ${full.tokens}`);
console.log(`        measured: brief=${brief.tokens} tokens, full=${full.tokens} tokens`);

// The digest must render with NO live file. A constraint that a network blip
// removes is not a constraint — see buildPolicyBlock()'s header.
const noFile = policy.buildPolicyBlock('brief', { parsed: null });
check('the digest renders with NO live policy file (a constraint may not depend on a fetch)',
  /A1 RED LINE/.test(noFile.text));
check('...and SAYS the live file was not read, rather than implying it was',
  /live file unread/i.test(noFile.text));

/* ═══════════ §2 pinned against the REAL document ════════════════════════ */
section('§2 pinned against back-office-AI-agents/docs/OFFICE-POLICY.md');

if (!fs.existsSync(POLICY_FILE)) {
  skip('the whole of §2', `no sibling checkout at ${POLICY_FILE} — back-office is private, so this is expected off the owner's machine. NOTHING in §2 was verified.`);
} else {
  const md = fs.readFileSync(POLICY_FILE, 'utf8');
  const parsed = policy.parsePolicy(md);
  check('the real policy file parses', parsed.ok === true, parsed.reason);

  if (parsed.ok) {
    console.log(`        parsed: ${parsed.rules.length} rules, re-check ${parsed.recheck}, provisional [${parsed.provisional.join(', ')}]`);
    check('the parse produced no malformed entries', parsed.malformed.length === 0, parsed.malformed.join(' | '));

    const ids = new Set(parsed.rules.map((r) => r.id));
    for (const d of policy.POLICY_DIGEST) {
      check(`${d.id} is a real heading in the live policy`, ids.has(d.id));
    }
    check('A11 (rank filtering) exists in the policy — office-context.js implements it', ids.has('A11'));
    check('A16 (the external check) exists in the policy', ids.has('A16'));
    check('B1 (night-annex precedence) exists in the policy', ids.has('B1'));
    check('B5 (refusal recording) exists in the policy', ids.has('B5'));

    check('the re-check date in code matches the document',
      policy.POLICY_RECHECK_DATE === parsed.recheck, `code=${policy.POLICY_RECHECK_DATE} file=${parsed.recheck}`);
    check('the ⚖️ provisional set in code is EXACTLY the one in the document',
      [...policy.PROVISIONAL_RULES].sort().join(',') === [...parsed.provisional].sort().join(','),
      `code=[${policy.PROVISIONAL_RULES}] file=[${parsed.provisional}]`);
    check('the approval date in code appears in the document',
      md.includes(policy.POLICY_APPROVED_DATE));

    // TRANSCRIPTION SPOT-CHECKS. Not a diff of the prose — the digest is a
    // summary and is meant to be shorter — but the load-bearing NOUNS of each
    // summarised rule must appear in that rule's own body. A digest that says
    // "the QA and Team Lead" about a rule whose body no longer names them is
    // the exact drift this file exists to catch.
    const bodyOf = (id) => {
      const i = md.indexOf(`## ${id}.`);
      if (i === -1) return '';
      const rest = md.slice(i + 4);
      const j = rest.search(/^#{1,2} /m);
      return j === -1 ? rest : rest.slice(0, j);
    };
    const SPOT = {
      A1: ['modifies the code that runs it'],
      A2: ['QA and Team Lead', 'Append only'],
      A7: ['One active branch per project', 'aviv-brain'],
      A8: ['finished work, not questions', 'never a stall'],
      A15: ['appended and dated', 'nothing is ever deleted'],
    };
    for (const [id, phrases] of Object.entries(SPOT)) {
      const body = bodyOf(id).toLowerCase();
      for (const phrase of phrases) {
        check(`${id}'s body still contains "${phrase}" (the digest asserts it)`,
          body.includes(phrase.toLowerCase()));
      }
    }

    // The owner owns this file. This repo must never write it.
    check('nothing in this repo writes OFFICE-POLICY.md',
      !/OFFICE-POLICY\.md[^\n]*commitFileToRepo|commitFileToRepo[^\n]*OFFICE-POLICY/.test(read('workers/agent-runner.js') + read('workers/repo-write.js') + read('workers/office-context.js')));
  }
}

/* ═══════════ §3 the wiring — the policy actually reaches a prompt ═══════ */
section('§3 wiring — office-context.js prepends it and the fitter cannot cut it');

const ocSrc = read('workers/office-context.js');
check('office-context.js imports the policy module', /from '\.\/office-policy\.js'/.test(ocSrc));
check('the policy file is fetched alongside the board and the requirements',
  /fetchBackOfficeFile\(env, POLICY_PATH\)/.test(ocSrc));
check('a 404 on the policy is an ERROR, not the healthy-empty case the questions channel gets',
  !/policyFile\.reason[\s\S]{0,200}HTTP 404/.test(ocSrc));

// The behavioural proof: the policy must be present in a shape where the fitter
// dropped EVERYTHING else. Budget of 1 token guarantees that.
const tinySnapshot = {
  fetched_at: Date.now(),
  board: { ok: true, tasks: [], counts: { total: 0 }, malformed: [] },
  requirements: { ok: true, due: '2026-09-07', requirements: [{ id: 'REQ-001', title: 'x', urgent: false, status: 'in progress' }], malformed: [] },
  questions: { ok: true, questions: [], counts: { total: 0, open: 0, closed: 0 }, malformed: [] },
  lifecycle: null,
  policy: null,
  errors: [],
};
const built = officeContext.buildOfficeContext(tinySnapshot, 'agent', { agentId: 3, clearance: 'standard' });
/*
 * WAS `totalTokens === tokens + policyTokens` until 2026-08-23, when the
 * mission ordering became a THIRD block riding outside the budget beside the
 * policy (office-context.js MISSION_ORDER). The check's intent is unchanged and
 * is the reason it is widened rather than deleted: every out-of-budget block
 * must be reported as its own number, and `tokens` must still mean only what
 * the fitter managed. A third block folded silently into either number would be
 * exactly the thing this line was written to catch.
 */
check('the policy is reported as a SEPARATE token cost, not folded into the office-context number',
  typeof built.policyTokens === 'number' && built.policyTokens > 0
  && typeof built.missionTokens === 'number' && built.missionTokens > 0
  && built.totalTokens === built.tokens + built.policyTokens + built.missionTokens);
check('A1 reaches a standard agent', /A1 RED LINE/.test(built.text));
check('the mission ordering reaches a standard agent, and names all three ranks',
  /SOFTWARE DEVELOPMENT company/.test(built.text)
  && /FIRST — software development/.test(built.text)
  && /SECOND — design and customer experience/.test(built.text)
  && /THIRD, explicitly low/.test(built.text));
check('THIRD is actionable, not decorative — it says do not start it unasked',
  /DO NOT START THIRD-PRIORITY WORK UNLESS YOU WERE ASKED FOR IT/.test(built.text));
check('the mission is read BEFORE the policy (what to pick up, then what not to do)',
  built.text.indexOf('WHAT THIS OFFICE IS') >= 0
  && built.text.indexOf('WHAT THIS OFFICE IS') < built.text.indexOf('A1 RED LINE'));

// The degraded path: no board, no requirements. Before 2026-08-10 this returned
// text:null and the rules went with it.
const deadSnapshot = { fetched_at: Date.now(), board: null, requirements: null, questions: null, lifecycle: null, policy: null, errors: ['github unreachable'] };
const degraded = officeContext.buildOfficeContext(deadSnapshot, 'agent', { agentId: 3, clearance: 'standard' });
check('with the whole snapshot unreadable the policy STILL renders (the office\'s worst day)',
  typeof degraded.text === 'string' && /A1 RED LINE/.test(degraded.text));
check('...and the snapshot failure is still reported as degraded',
  degraded.degraded === true && /github unreachable/.test(degraded.reason));
check('...and the mission ordering survives the same worst day, for the same reason',
  /SOFTWARE DEVELOPMENT company/.test(degraded.text)
  && /DO NOT START THIRD-PRIORITY WORK UNLESS YOU WERE ASKED FOR IT/.test(degraded.text));

/* ═══════════ §4 A11 rank filtering ══════════════════════════════════════ */
section('§4 A11 — information by rank');

check('ADMIN_CLEARANCES matches the tiers agents-config.json actually uses',
  officeContext.ADMIN_CLEARANCES.join(',') === 'specialist,sudo,root');
const agentsConfig = JSON.parse(read('config/agents-config.json'));
const standardIds = agentsConfig.agents.filter((a) => !officeContext.isAdminClearance(a.clearance)).map((a) => a.id);
const adminIds = agentsConfig.agents.filter((a) => officeContext.isAdminClearance(a.clearance)).map((a) => a.id);
check('the standard rank resolves to agents 1-4 and nobody else',
  standardIds.join(',') === '1,2,3,4', standardIds.join(','));
console.log(`        admins: ${adminIds.join(', ')}`);
check('an absent clearance falls to the LESS-informed shape (fail towards showing less)',
  officeContext.isAdminClearance(null) === false && officeContext.isAdminClearance(undefined) === false);

const richSnapshot = {
  fetched_at: Date.now(),
  board: {
    ok: true,
    tasks: [
      { id: 'OB-001', title: 'Alpha', state: 'READY', assignee: 'Agent 3', agentId: 3, urgency: null, metric: null, blockedBy: null, dispatched: null, offered: null, stage: null },
      { id: 'OB-002', title: 'Beta', state: 'BLOCKED', assignee: 'Agent 6', agentId: 6, urgency: null, metric: null, blockedBy: 'owner decision', dispatched: null, offered: null, stage: null },
    ],
    counts: { total: 2, READY: 1, BLOCKED: 1 },
    malformed: [],
  },
  requirements: { ok: true, due: '2026-09-07', requirements: [{ id: 'REQ-001', title: 'Ship it', urgent: true, status: 'in progress' }], malformed: [] },
  questions: { ok: true, questions: [], counts: { total: 0, open: 0, closed: 0 }, malformed: [] },
  lifecycle: null,
  policy: null,
  errors: [],
};
const PROJECTS = [{ key: 'data-center', name: 'Data Center', role: 'client project' }];
const asStandard = officeContext.buildOfficeContext(richSnapshot, 'agent', { agentId: 3, clearance: 'standard', projects: PROJECTS });
const asAdmin = officeContext.buildOfficeContext(richSnapshot, 'agent', { agentId: 3, clearance: 'sudo', projects: PROJECTS });

check('a standard agent is rank-filtered; an admin is not',
  asStandard.rankFiltered === true && asAdmin.rankFiltered === false);
check('the standard agent still sees ITS OWN task in full', /OB-001/.test(asStandard.text));
check('the standard agent does NOT see the office-wide open-work list', !/Open work/.test(asStandard.text));
check('the standard agent does NOT see the stuck list', !/waiting on: owner decision/.test(asStandard.text));
check('the admin DOES see the stuck list', /waiting on: owner decision/.test(asAdmin.text));
check('the standard agent DOES see the board counts (A11: "what is blocked")',
  /1 BLOCKED/.test(asStandard.text));
check('the standard agent DOES see the client requirements (A11: everyone sees those)',
  /REQ-001/.test(asStandard.text));
check('what was withheld by RANK is reported, never silent',
  asStandard.withheld.length > 0 && asStandard.withheld.includes('board-titles'));
check('an admin withholds nothing by rank', asAdmin.withheld.length === 0);
check('A11 is enforced by the SECTION SET, not only by the budget',
  officeContext.STANDARD_SECTIONS.length > 0 && !officeContext.STANDARD_SECTIONS.includes('board-titles'));

/* ═══════════════════════════════ summary ════════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed, ${skipped} skipped`);
if (skipped) console.log('  A SKIP IS NOT A PASS — see the section that reported it.');
if (fail) {
  console.log('\n  FAILED:');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${'═'.repeat(72)}\n`);
process.exit(fail ? 1 : 0);
