#!/usr/bin/env node
/**
 * scripts/verify-owner-channel.js — REQ-001's base, proved rather than claimed.
 *
 * Run: node scripts/verify-owner-channel.js
 *
 * NO NETWORK. `globalThis.fetch` is replaced with a tripwire that throws, so
 * "this made no network call" is proven rather than asserted — the same rule
 * verify-providers.js and verify-routing.js keep.
 *
 * ── WHAT THIS FILE IS CAREFUL ABOUT ──────────────────────────────────────
 *
 * Every check below is written so that it FAILS if the guard is removed. The
 * pattern this project keeps finding is a gate that exists, is documented, and
 * is never on the calling path (OB-001, and three separate incidents). So the
 * refusal checks call the real parser with real malformed input and require the
 * refusal, rather than checking that a refusal branch is present in the source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OWNER_DIR, READ_LOG_PATH, SUBMISSIONS_PATH, OWNER_KINDS,
  parseOwnerMessage, parseReadLog, renderReadLog, readKey,
  classifyOwnerMessages, ownerMessageSections,
  AGE_LADDER, daysBetween, escalationFor,
  parseSubmissions, submissionSections, ageQuestions,
} from '../workers/owner-channel.js';
import {
  ownerChannelEnabled, notifyOwner, selectNotificationItems,
  buildIssueBody, buildIssueTitle, OWNER_ISSUE_LABEL, OWNER_NOTIFY_TABLE_SQL,
} from '../workers/owner-notify.js';
import {
  buildOfficeContext, STANDARD_SECTIONS, parseOpenQuestions, BUDGETS,
} from '../workers/office-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKOFFICE = path.resolve(ROOT, '..', 'back-office-AI-agents');

globalThis.fetch = () => { throw new Error('verify-owner-channel.js made a network call — it must not'); };

let pass = 0;
let fail = 0;
const failures = [];
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`); }
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}

const HEADER = (over = {}) => {
  const f = { from: 'owner', date: '2026-08-10', kind: 'instruction', re: 'new', status: 'open', ...over };
  return `---\n${Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
};
const MSG = (over = {}, body = '# Ship the site\n\nDeploy it this week.\n\nAnd tell me when.') =>
  `${HEADER(over)}\n${body}`;

/* ══════════════ §1 the parser REFUSES rather than guessing ══════════════ */
section('§1 owner messages — refused, not guessed');

{
  const good = parseOwnerMessage(MSG(), '2026-08-10-ship-the-site.md', 'deadbeefcafe0001');
  check('a well-formed owner message parses', good.ok, good.reason);
  check('…and its id is date+slug, so the filename orders the directory', good.ok && good.message.id === '2026-08-10-ship-the-site');
  check('…and the title comes from the H1, not the slug', good.ok && good.message.title === 'Ship the site');

  const badName = parseOwnerMessage(MSG(), 'ship-the-site.md', 'x');
  check('REFUSED — a filename with no date prefix', !badName.ok);

  const noFront = parseOwnerMessage('# Just a heading\n\nbody', '2026-08-10-x.md', 'x');
  check('REFUSED — no front matter (a message that cannot state its kind)', !noFront.ok);

  const badKind = parseOwnerMessage(MSG({ kind: 'delivery' }), '2026-08-10-x.md', 'x');
  check('REFUSED — an unrecognised kind is NOT defaulted', !badKind.ok);
  check('…and the refusal says why a default would be wrong', !badKind.ok && /how urgently/.test(badKind.reason));

  const emptyBody = parseOwnerMessage(`${HEADER()}\n   \n`, '2026-08-10-x.md', 'x');
  check('REFUSED — a header with no instruction behind it', !emptyBody.ok);

  const claimed = parseOwnerMessage(MSG({ status: 'acted' }), '2026-08-10-x.md', 'x');
  check('REFUSED — status:acted with no "Acted:" line (the office may not mark its own homework)', !claimed.ok);
  const evidenced = parseOwnerMessage(
    MSG({ status: 'acted' }, '# Ship it\n\nDo it.\n\n- **Acted:** filed as OB-047'),
    '2026-08-10-x.md', 'x'
  );
  check('…and ACCEPTED once the evidence line is there', evidenced.ok, evidenced.reason);

  const noStatus = parseOwnerMessage(MSG({ status: null }), '2026-08-10-x.md', 'x');
  check('an ABSENT status defaults to "open" — the only default, and it understates the office', noStatus.ok && noStatus.message.status === 'open');

  check('the owner-side kind vocabulary keeps `emergency` and `reply` from the parent contract',
    OWNER_KINDS.includes('emergency') && OWNER_KINDS.includes('reply'));
  check('…and does NOT accept `delivery`/`question`, which are office→owner shapes',
    !OWNER_KINDS.includes('delivery') && !OWNER_KINDS.includes('question'));
}

/* ══════════ §2 the read record separates unread from read-and-ignored ═══ */
section('§2 the read record — the deliverable, not the reading');

{
  const m1 = parseOwnerMessage(MSG(), '2026-08-10-a.md', 'aaaaaaaaaaaa1111').message;
  const m1edited = parseOwnerMessage(MSG(), '2026-08-10-a.md', 'bbbbbbbbbbbb2222').message;

  check('the read key carries the CONTENT SHA, not just the message id', readKey(m1) !== readKey(m1edited));
  check('…so an EDITED message returns to unread — a stale receipt cannot mask new content',
    readKey(m1).startsWith('2026-08-10-a@') && readKey(m1edited).startsWith('2026-08-10-a@'));

  const rows = [{ readAt: '2026-08-10 12:00', key: readKey(m1), cycle: 'owner_channel 2026-08-10', note: 'instruction · Ship the site' }];
  const rendered = renderReadLog(rows);
  const round = parseReadLog(rendered);
  check('renderReadLog() output parses back to the same record (the file is the source of truth)',
    round.records.length === 1 && round.records[0].key === readKey(m1));
  check('…and the rendered file states what a row proves, narrowly', /does \*\*not\*\* prove any individual agent/i.test(rendered));
  check('an EMPTY read log is not a parse failure', parseReadLog('').records.length === 0);

  const cls = classifyOwnerMessages([m1, m1edited], round);
  check('THREE STATES — the read one is read', cls.readNotActed.length === 1 && cls.readNotActed[0].sha === m1.sha);
  check('…the edited one is UNREAD again', cls.unread.length === 1 && cls.unread[0].sha === m1edited.sha);
  check('…and a read-but-not-acted message still counts as needing action', cls.counts.unactioned === 2);

  const actedMsg = parseOwnerMessage(MSG({ status: 'acted' }, '# X\n\nDo it.\n\n- **Acted:** done'), '2026-08-10-b.md', 'cccc').message;
  const cls2 = classifyOwnerMessages([actedMsg], parseReadLog(''));
  check('an ACTED message leaves the unactioned list', cls2.counts.unactioned === 0 && cls2.counts.acted === 1);

  const emerg = parseOwnerMessage(MSG({ kind: 'emergency', date: '2026-01-01' }), '2026-01-01-fire.md', 'dddd').message;
  const recent = parseOwnerMessage(MSG({ date: '2026-08-10' }), '2026-08-10-later.md', 'eeee').message;
  const cls3 = classifyOwnerMessages([recent, emerg], parseReadLog(''));
  check('an EMERGENCY sorts ahead of a newer ordinary message', cls3.unactioned[0].kind === 'emergency');
  check('…and the count line says the office is expected to have stopped',
    /EMERGENCY/.test(ownerMessageSections(cls3, { shape: 'agent' })[0].text));
}

/* ═════════ §3 an owner message outranks the board, by construction ══════ */
section('§3 precedence — the owner outranks the board');

{
  check(`"owner-messages" is in STANDARD_SECTIONS — A11 withholds the office's recitations, never the client's words`,
    STANDARD_SECTIONS.includes('owner-messages') && STANDARD_SECTIONS.includes('owner-messages-count'));

  const msg = parseOwnerMessage(MSG(), '2026-08-10-a.md', 'aaaa').message;
  const classified = classifyOwnerMessages([msg], parseReadLog(''));
  const board = {
    ok: true,
    tasks: Array.from({ length: 40 }, (_, i) => ({
      id: `OB-${String(i + 1).padStart(3, '0')}`, title: `task ${i} with a reasonably long title to consume budget`,
      state: 'READY', assignee: 'Agent 6 — The QA', agentId: 6, blockedBy: 'nothing',
    })),
    counts: { total: 40, READY: 40 },
    malformed: [],
  };
  const snapshot = {
    today: '2026-08-10', board, requirements: null, questions: null, lifecycle: null,
    policy: null, owner: { classified }, submissions: null, errors: [],
  };

  for (const [shape, clearance] of [['agent', 'standard'], ['agent', 'sudo'], ['meeting', null], ['report', null]]) {
    const built = buildOfficeContext(snapshot, shape, { clearance, today: '2026-08-10' });
    check(`${shape}/${clearance || 'n-a'} — the owner's message survives the budget fitter`,
      /THE OWNER HAS WRITTEN TO THE OFFICE/.test(built.text) && !built.dropped.includes('owner-messages'));
  }

  const agentBuilt = buildOfficeContext(snapshot, 'agent', { clearance: 'standard', today: '2026-08-10' });
  const boardIdx = agentBuilt.text.indexOf('Delegation board');
  const ownerIdx = agentBuilt.text.indexOf('OWNER MESSAGES');
  check('…and it renders ABOVE the delegation board', ownerIdx !== -1 && (boardIdx === -1 || ownerIdx < boardIdx));
  check('…the single-agent shape ABRIDGES the body and SAYS it is abridged',
    /\[ABRIDGED/.test(agentBuilt.text) && new RegExp(OWNER_DIR).test(agentBuilt.text));
  const meetingBuilt = buildOfficeContext(snapshot, 'meeting', { today: '2026-08-10' });
  check('…while a meeting gets the message whole', /And tell me when\./.test(meetingBuilt.text));

  // The degraded path: board and requirements both unreadable.
  const degraded = buildOfficeContext(
    { today: '2026-08-10', board: null, requirements: null, owner: { classified }, errors: ['boom'] },
    'agent', { clearance: 'standard' }
  );
  check('a DEGRADED snapshot still carries the owner\'s instruction (a network blip must not drop the client)',
    degraded.degraded === true && /THE OWNER HAS WRITTEN TO THE OFFICE/.test(degraded.text));

  const none = buildOfficeContext(
    { today: '2026-08-10', board, requirements: null, owner: { classified: classifyOwnerMessages([], parseReadLog('')) }, errors: [] },
    'agent', { clearance: 'standard' }
  );
  check('"the owner has written nothing" is SAID, not omitted (it must not look like an unread channel)',
    /has not written to the office/.test(none.text));
}

/* ═════════════════ §4 the age ladder — it does not go quiet ═════════════ */
section('§4 the age ladder — an entry that ages gets LOUDER');

{
  const plus = (d) => new Date(Date.parse('2026-08-01T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
  const rung = (d) => escalationFor('2026-08-01', plus(d)).rung;
  check('day 0 / 2 → FRESH', rung(0) === 'FRESH' && rung(2) === 'FRESH');
  check('day 3 / 6 → STANDING', rung(3) === 'STANDING' && rung(6) === 'STANDING');
  check('day 7 / 13 → OVERDUE', rung(7) === 'OVERDUE' && rung(13) === 'OVERDUE');
  check('day 14 / 40 → ESCALATED', rung(14) === 'ESCALATED' && rung(40) === 'ESCALATED');
  check('OVERDUE is the rung that starts riding at headline priority', escalationFor('2026-08-01', plus(7)).headline === true);
  check('…and FRESH/STANDING do not', !escalationFor('2026-08-01', plus(2)).headline && !escalationFor('2026-08-01', plus(6)).headline);
  check('only ESCALATED takes the fallback', escalationFor('2026-08-01', plus(13)).takeFallback === false && escalationFor('2026-08-01', plus(14)).takeFallback === true);

  const bad = escalationFor('not-a-date', '2026-08-20');
  check('an UNREADABLE date is forced to the TOP rung — an entry whose age is unknown must never look fresh',
    bad.rung === 'ESCALATED' && bad.unparseableDate === true);
  check('a FUTURE date clamps to 0 days rather than buying a lower rung', daysBetween('2026-09-01', '2026-08-01') === 0);
  check('the ladder is ordered and starts at 0', AGE_LADDER[0].minDays === 0 && AGE_LADDER.every((r, i, a) => i === 0 || r.minDays > a[i - 1].minDays));

  // The real questions file, aged forward — the ladder must apply to it too.
  const qsMd = fs.readFileSync(path.join(BACKOFFICE, 'channel', 'to-owner', 'OPEN-QUESTIONS.md'), 'utf8');
  const qs = parseOpenQuestions(qsMd);
  check('the LIVE OPEN-QUESTIONS.md still parses', qs.ok, qs.reason);
  const agedNow = ageQuestions(qs.questions, '2026-08-11');
  const agedLater = ageQuestions(qs.questions, '2026-09-15');
  check('…its open entries are FRESH the day after they were asked', agedNow.filter((q) => q.open).every((q) => q.escalation.rung === 'FRESH'));
  check('…and ESCALATED five weeks later — the entry does not render the same on day 1 and day 40',
    agedLater.filter((q) => q.open).every((q) => q.escalation.rung === 'ESCALATED'));

  const snapLater = {
    today: '2026-09-15', board: null, requirements: { requirements: [{ id: 'REQ-001', title: 'x', status: 'in progress', urgent: true }], due: '2026-09-07', malformed: [] },
    questions: qs, lifecycle: null, policy: null, owner: null, submissions: null, errors: [],
  };
  const later = buildOfficeContext(snapLater, 'meeting', { today: '2026-09-15' });
  check('…and a risen question is RE-SURFACED in its own headline section, not merely relabelled',
    /ASKED AND NOT ANSWERED/.test(later.text) && !later.dropped.includes('questions-overdue'));
  check('…saying the fallback was TAKEN and the question is STILL OPEN', /FALLBACK HAS BEEN TAKEN and the question is STILL OPEN/.test(later.text));
}

/* ════════════ §5 submissions — finished work, or it is refused ══════════ */
section('§5 submissions — A8 enforced by the parser');

{
  const full = `### S-001 — deploy the office site

- **Submitted by:** Agent 9 — The Designer
- **Date:** 2026-08-01
- **What we did:** built four phases in the warehouse, 129/129 checks.
- **What we recommend:** deploy to production behind the existing gate.
- **Decision needed:** approval to deploy.
- **If no answer comes:** we ship to the staging URL and mark production provisional, by the next weekly meeting.
- **Decision:** —
`;
  const ok = parseSubmissions(full, '2026-08-20');
  check('a complete submission parses', ok.ok && ok.submissions.length === 1, ok.reason);
  check('…and is aged from its Date: field', ok.submissions[0].escalation.rung === 'ESCALATED');
  check('…counts are DERIVED, not read from a header line', ok.counts.open === 1 && ok.counts.escalated === 1);

  const questionInDisguise = full.replace(/- \*\*What we did:\*\*.*\n/, '');
  const refused = parseSubmissions(questionInDisguise, '2026-08-20');
  check('REFUSED — no "What we did" (a question wearing a submission\'s clothes)', !refused.ok);
  check('…and the refusal names A8 rather than just the missing field', !refused.ok && /finished work with a recommendation/.test(refused.reason));

  const noFallback = full.replace(/- \*\*If no answer comes:\*\*.*\n/, '');
  check('REFUSED — no "If no answer comes" (a stall dressed as a submission)', !parseSubmissions(noFallback, '2026-08-20').ok);

  const decided = full.replace('### S-001 — deploy the office site', '### S-001 — ~~deploy the office site~~ — APPROVED');
  const d = parseSubmissions(decided, '2026-08-20');
  check('a decided entry is marked, stays in the file, and stops counting as open', d.ok && d.counts.open === 0 && d.counts.total === 1);
  check('…and a decided entry is NOT aged (nothing is waiting on it)', d.submissions[0].escalation === null);

  check('an EMPTY submissions file is healthy, not a parse failure', parseSubmissions('# SUBMISSIONS\n\nnothing yet\n', '2026-08-20').ok);

  const built = submissionSections(ok, { shape: 'meeting' });
  check('an ESCALATED submission renders at headline priority', built.some((s) => s.label === 'submissions-overdue' && s.priority === 0));
  check('…and says the fallback was taken', built.some((s) => (s.items || []).some((i) => /FALLBACK TAKEN/.test(i))));
  check('only the COUNT reaches a standard agent — composing a submission is an admin act under A8',
    STANDARD_SECTIONS.includes('submissions-count') && !STANDARD_SECTIONS.includes('submissions-open') && !STANDARD_SECTIONS.includes('submissions-overdue'));
}

/* ═════════════════ §6 the notification — it fails LOUDLY ═══════════════ */
section('§6 notification — both ends learn');

{
  const rowsWritten = [];
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { return { run: async () => { rowsWritten.push({ sql, args }); return {}; }, first: async () => null, all: async () => ({ results: [] }) }; },
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
    },
  };
  const envOff = { SIM_KV: { get: async () => ({}) }, DB: fakeDb };
  const envOn = { SIM_KV: { get: async () => ({ owner_channel_enabled: true }) }, DB: fakeDb };

  check('the kill switch defaults OFF with no SIM_KV binding', (await ownerChannelEnabled({})) === false);
  check('…and OFF for a stray string rather than a true boolean',
    (await ownerChannelEnabled({ SIM_KV: { get: async () => ({ owner_channel_enabled: 'true' }) } })) === false);

  const sent = [];
  const deps = { postIssue: async (e, issue) => { sent.push(issue); return { created: true, status: 201, number: 42 }; } };

  const offRes = await notifyOwner(envOff, deps, { items: [{ id: 'S-001', title: 'x' }], today: '2026-08-10' });
  check('DISABLED — no Issue is posted at all', offRes.skipped && offRes.reason === 'owner_channel_disabled' && sent.length === 0);

  const quiet = await notifyOwner(envOn, deps, { items: [], today: '2026-08-11', isHeartbeatDay: false });
  check('nothing to say and not the heartbeat day — skipped', quiet.skipped && sent.length === 0);

  const beat = await notifyOwner(envOn, deps, { items: [], today: '2026-08-09', isHeartbeatDay: true });
  check('THE HEARTBEAT IS SENT EVEN WITH NOTHING TO REPORT — this is what makes silence informative', beat.sent === true && sent.length === 1);
  check('…and its body says why a quiet week still sends a message', /quiet week and a broken channel/.test(sent[0].body));
  check('…and it carries the owner-channel label, so it can never be confused with a gap digest',
    sent[0].labels.includes(OWNER_ISSUE_LABEL));

  // Failure path.
  const failDeps = { postIssue: async () => ({ created: false, status: 503 }) };
  const before = rowsWritten.length;
  const failed = await notifyOwner(envOn, failDeps, { items: [{ id: 'S-002', title: 'y' }], today: '2026-08-10' });
  check('a FAILED send is returned as failed, not swallowed', failed.sent === false && !failed.skipped);
  const recorded = rowsWritten.slice(before).find((r) => /INSERT INTO owner_notifications/.test(r.sql));
  check('…and is RECORDED with ok=0 (a ledger of successes only cannot answer "what did we fail to send")',
    !!recorded && recorded.args.includes(0));

  const threw = await notifyOwner(envOn, { postIssue: async () => { throw new Error('network down'); } }, { items: [{ id: 'S-3', title: 'z' }], today: '2026-08-10' });
  check('a THROWN send is caught and recorded as a failure, never as a success', threw.sent === false && /network down/.test(threw.reason));

  // Sequence rendering.
  const withPrev = buildIssueBody({ seq: 7, previous: { seq: 6, sentAt: '2026-08-03T00:00:00Z', issue: 40 }, kind: 'heartbeat', items: [], today: '2026-08-10' });
  check('the body names the PREVIOUS notification, so a gap is visible in the message that DID arrive', /#6/.test(withPrev) && /a notification was lost/i.test(withPrev));
  const noSeq = buildIssueBody({ seq: null, sequenceReason: 'no_db_binding', kind: 'heartbeat', items: [], today: '2026-08-10' });
  check('an UNKNOWABLE sequence is announced loudly, never invented', /SEQUENCE NUMBER COULD NOT BE ESTABLISHED/.test(noSeq));
  check('…and the title says so too', /#\?/.test(buildIssueTitle({ seq: null, kind: 'heartbeat', items: [], today: '2026-08-10' })));

  check('the reply route is the REPO, not an issue comment (one channel, one history)', /In the repo, not in this issue/.test(withPrev));
  check('…and it tells him an instruction outranks the board', /outranks everything on the office/.test(withPrev));

  // What gets selected.
  const subs = parseSubmissions(`### S-010 — a thing

- **Submitted by:** Agent 6 — The QA
- **Date:** 2026-08-10
- **What we did:** work
- **What we recommend:** a thing
- **Decision needed:** approval
- **If no answer comes:** we proceed on assumption X by Friday
- **Decision:** —
`, '2026-08-10');
  const fresh = ageQuestions([{ id: 'Q-001', open: true, date: '2026-08-10', question: 'q', fallback: 'f', need: 'a decision', blocking: 'b' }], '2026-08-10');
  const old = ageQuestions([{ id: 'Q-002', open: true, date: '2026-07-01', question: 'q2', fallback: 'f2', need: 'a decision', blocking: 'b2' }], '2026-08-10');
  const picked = selectNotificationItems({ submissions: subs.submissions, questions: [...fresh, ...old] });
  check('an OPEN SUBMISSION always reaches him — A8: he receives finished work', picked.some((i) => i.id === 'S-010'));
  check('a FRESH question does NOT — it carries a fallback and is the office\'s problem', !picked.some((i) => i.id === 'Q-001'));
  check('an ESCALATED question DOES, and says its fallback has already been taken',
    picked.some((i) => i.id === 'Q-002' && /ALREADY TAKEN/.test(i.fallback)));

  check('the notification table records failures by schema, not by convention', /ok INTEGER NOT NULL/.test(OWNER_NOTIFY_TABLE_SQL));
}

/* ═════ §6b THE THIRD STATE: a message the office cannot even SEE ═════
 *
 * FOUND LIVE, 2026-08-10, and it is the sharpest thing this channel has taught.
 *
 * `channel/from-owner/` contained
 * `messages-from-aviv/aviv-is-writing-to-the-office.md`, committed by the owner,
 * reading in full:
 *
 *   > this is a test note to see if the office responds. find a way to let me
 *   > know you've read this.
 *
 * The office never saw it. Not read-and-ignored — INVISIBLE. It was in a
 * SUBDIRECTORY, so fetchOfficeSnapshot()'s `type === 'file'` filter dropped it
 * before any parser ran; its filename was not `YYYY-MM-DD-<slug>.md`; and it had
 * no front matter. A top-level file that fails to parse at least lands in
 * `malformed` and is reported. A subdirectory landed nowhere at all.
 *
 * So the channel built specifically to end *"a message the office has not read
 * looks exactly like a message the office has read and ignored"* had a THIRD
 * state nobody had named — and the message it swallowed was him testing exactly
 * that.
 *
 * The filter is UNCHANGED: those entries genuinely cannot be parsed and must not
 * be guessed at. What changed is that being unreadable is now LOUD.
 * ═══════════════════════════════════════════════════════════════════════ */
section('§6b the third state — an unreadable entry is an ERROR, not a filter');

{
  const ctx6b = fs.readFileSync(path.join(ROOT, 'workers', 'office-context.js'), 'utf8');

  check('a DIRECTORY in from-owner/ is reported as unreadable rather than filtered away',
    /unreadableEntries/.test(ctx6b) && /e\.type === 'dir'/.test(ctx6b));
  check('the report says THE CLIENT MAY HAVE WRITTEN SOMETHING NOBODY HAS SEEN',
    /THE CLIENT MAY HAVE WRITTEN SOMETHING NOBODY HAS SEEN/.test(ctx6b));
  check('it is pushed onto `errors` — which rides at the top of every prompt — not onto a quiet note',
    /errors\.push\([\s\S]{0,240}CANNOT READ AS A MESSAGE/.test(ctx6b));
  check('it names the third state explicitly, so nobody has to re-derive it',
    /THIRD state beyond unread and read-and-ignored/.test(ctx6b));
  check('it is deliberately NOT auto-corrected — the office never writes into his folder',
    /deliberately NOT auto-corrected/.test(ctx6b));
  check('...and says why: renaming his file to suit our parser would be editing the clients own words',
    /would be editing the client/.test(ctx6b));
  check('a non-.md file is caught too, not only a directory', /not a \.md file/.test(ctx6b));
  check('the incident is recorded with the owners own words, so the finding survives the fix',
    /find a way to let me/.test(ctx6b));
  check('the unparseable-entry FILTER itself is unchanged (they still must not be guessed at)',
    /\.filter\(\(e\) => e\.type === 'file' && \/\\.md\$\/i\.test\(e\.name\)/.test(ctx6b));
}

/* ═══════════ §7 wiring — the gate is on the calling path (OB-001) ═══════ */
section('§7 wiring — the code that calls it, not the code that defines it');

{
  const runner = fs.readFileSync(path.join(ROOT, 'workers', 'agent-runner.js'), 'utf8');
  const ctx = fs.readFileSync(path.join(ROOT, 'workers', 'office-context.js'), 'utf8');
  const ownerCh = fs.readFileSync(path.join(ROOT, 'workers', 'owner-channel.js'), 'utf8');
  const ownerNo = fs.readFileSync(path.join(ROOT, 'workers', 'owner-notify.js'), 'utf8');
  const schedule = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'daily-schedule.json'), 'utf8'));

  check('owner-channel.js imports NOTHING — so this verifier exercises the real module',
    !/^\s*import\s/m.test(ownerCh));
  check('owner-notify.js imports NOTHING either, and injects its one impure call',
    !/^\s*import\s/m.test(ownerNo) && /deps\.postIssue/.test(ownerNo));

  check('office-context.js actually IMPORTS the owner channel (the gate is wired, not merely defined)',
    /from '\.\/owner-channel\.js'/.test(ctx));
  check('…and fetches the owner directory and the read log', ctx.includes('fetchBackOfficeDir(env, OWNER_DIR)') && ctx.includes('READ_LOG_PATH'));
  check('…and the owner-message cap is REPORTED as an error, never as a silent truncation',
    /MAX_OWNER_MESSAGES/.test(ctx) && /are NOT in this context/.test(ctx));

  check('agent-runner.js has the owner_channel block handler', /processOwnerChannelBlock/.test(runner));
  check('…called from runScheduledBlock on the owner_channel block type', /block\.type === 'owner_channel'/.test(runner));
  check('…with a toggle, a read-back and a supervised single run',
    /case 'owner_channel_toggle'/.test(runner) && /case 'owner_channel_status'/.test(runner) && /case 'owner_channel_block'/.test(runner));
  check('…and the read receipt goes to BACK-OFFICE, never into the owner\'s own directory',
    new RegExp(`commitFileToRepo\\(\\s*\\n?\\s*env, BACKOFFICE_REPO_NAME, READ_LOG_PATH`).test(runner));
  check('…and a failed receipt does NOT stop the notification (a lost measurement is not lost work)',
    /READ RECEIPT NOT WRITTEN/.test(runner));

  const blocks = [...schedule.full_day_schedule.blocks, ...schedule.friday_schedule.blocks];
  check('the owner_channel block is scheduled Sun-Thu and Friday',
    schedule.full_day_schedule.blocks.some((b) => b.type === 'owner_channel')
    && schedule.friday_schedule.blocks.some((b) => b.type === 'owner_channel'));
  check('…and never on Saturday', !schedule.saturday_schedule.blocks.some((b) => b.type === 'owner_channel'));
  check('every block time lands on a :00 or :30 cron tick', blocks.every((b) => /:(00|30)$/.test(b.time)));
  for (const [name, sched] of [['full_day', schedule.full_day_schedule], ['friday', schedule.friday_schedule], ['saturday', schedule.saturday_schedule]]) {
    const times = sched.blocks.map((b) => b.time);
    check(`${name} blocks are still sorted by time (first opens the day, last finalizes it)`,
      times.every((t, i) => i === 0 || t >= times[i - 1]));
  }

  /*
   * ── THE SWITCHBOARD TRAP, FOUND LIVE ON 2026-08-10 ─────────────────────
   *
   * `owner_channel_toggle` was written, deployed and called. The endpoint
   * answered **HTTP 200 with a full state object** and the switch stayed off,
   * because the key was not on `updateSimulationState()`'s allow-list and the
   * loop iterated the ALLOW-LIST rather than the patch — so an unknown key was
   * never even looked at. Nothing anywhere said a key had been ignored.
   *
   * §7.6 on the switchboard: *a value nothing produces, read by something that
   * treats absence as fact.* And it is a standing trap rather than a one-off —
   * **adding a toggle case is not enough, and forgetting the key is invisible.**
   *
   * This check makes it visible at verify time: every key any toggle case passes
   * must be on the list. It is derived from the source, so a toggle added next
   * month is covered without anyone remembering to extend this.
   */
  const toggleKeys = [...runner.matchAll(/updateSimulationState\(env,\s*\{\s*([a-z_]+)\s*:/g)].map((m) => m[1]);
  const allowLine = /const allowedKeys = \[([^\]]+)\]/.exec(runner);
  const allowed = allowLine ? allowLine[1].split(',').map((s) => s.trim().replace(/'/g, '')) : [];
  check('the state allow-list was found at all', allowed.length > 0);
  check(`every toggle case's key is on the allow-list (${toggleKeys.length} toggles found)`,
    toggleKeys.length > 0 && toggleKeys.every((k) => allowed.includes(k)),
    `missing: ${toggleKeys.filter((k) => !allowed.includes(k)).join(', ') || 'none'}`);
  check('owner_channel_enabled specifically is on it', allowed.includes('owner_channel_enabled'));
  check('an unknown key is REPORTED rather than silently dropped — the loop iterates the PATCH, not the allow-list',
    /for \(const key of Object\.keys\(patch\)\)/.test(runner) && /_rejected_keys/.test(runner));

  check('the daily-schedule documents why an owner Issue is not the gap-digest Issue the rebuild banned',
    /why_a_GitHub_Issue_does_not_contradict/.test(JSON.stringify(schedule.owner_channel_program)));
  check('…and states the residual it does NOT close',
    /the_residual/.test(JSON.stringify(schedule.owner_channel_program)) && /A16/.test(schedule.owner_channel_program.the_residual));
}

/* ═══════════════ §8 Saturday is a rest day, and writes nothing ═════════ */
section('§8 A13 — Saturday is genuinely zero-write');

{
  const schedule = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'daily-schedule.json'), 'utf8'));
  const runner = fs.readFileSync(path.join(ROOT, 'workers', 'agent-runner.js'), 'utf8');
  const sat = schedule.saturday_schedule.blocks;

  check('Saturday has no guide_verify block', !sat.some((b) => b.type === 'guide_verify'));
  check('…no case batches, meetings, reports or guide blocks of any kind',
    !sat.some((b) => /case_batch|meeting|report|guide_|weekly_summary|chore_rotation|tool_task_window|architect_liaison/.test(b.type)));
  check('…only the forced-idle block, which makes no model call', sat.length === 1 && sat[0].type === 'spare_time' && sat[0].force_idle === true);
  check('guide_verify moved to Friday and is still weekly (one run, one day)',
    schedule.friday_schedule.blocks.filter((b) => b.type === 'guide_verify').length === 1);

  const guards = runner.match(/rest_day_zero_write/g) || [];
  check('the daily-summary commit is guarded on isOffDay in BOTH day paths (a rule on one path comes back on the other)',
    guards.length === 2);
  check('…and the guard is on the COMMIT, not on the render (the off-day path still exercises the renderer)',
    /isOffDay\s*\n?\s*\? \{ committed: false, skipped: true, reason: 'rest_day_zero_write'/.test(runner));
  check('the day counter still advances on a rest day (Sunday must not open stale)',
    runner.indexOf('await persistYearState(env, newState)') < runner.indexOf("reason: 'rest_day_zero_write'"));
  check('the schedule file records that the SECOND Saturday write was found, not quietly folded in',
    /the_second_write_was_not_in_the_brief/.test(JSON.stringify(schedule.saturday_schedule)));
}

/* ═══════════════════ §9 the contracts exist and agree ══════════════════ */
section('§9 the contracts — a format is load-bearing only if it is written down');

{
  const files = {
    'channel/README.md': null,
    'channel/from-owner/README.md': null,
    'channel/from-office/README.md': null,
    'channel/to-owner/README.md': null,
    'channel/to-owner/SUBMISSIONS.md': null,
  };
  for (const rel of Object.keys(files)) {
    const p = path.join(BACKOFFICE, rel);
    const exists = fs.existsSync(p);
    check(`${rel} exists`, exists);
    if (exists) files[rel] = fs.readFileSync(p, 'utf8');
  }

  const fromOwner = files['channel/from-owner/README.md'] || '';
  check('from-owner/README.md documents every kind the parser accepts',
    OWNER_KINDS.every((k) => new RegExp(`\`${k}\``).test(fromOwner)));
  check('…and the filename shape the parser enforces', /YYYY-MM-DD-short-slug\.md/.test(fromOwner));
  check('…and the Acted: requirement behind a status flip', /\*\*Acted:\*\*/.test(fromOwner));
  check('…and states the trust boundary — the office may not build its own instruction channel',
    /builds the pipe that feeds\s*(?:>\s*)?it/.test(fromOwner));
  check('…and states that an owner message outranks the board', /outranks the board/i.test(fromOwner));

  const fromOffice = files['channel/from-office/README.md'] || '';
  check('from-office/README.md says the record is the deliverable, not the copy', /the record as the deliverable/.test(fromOffice));
  check('…and that an edited message returns to unread', /returns to unread/i.test(fromOffice));

  const subs = files['channel/to-owner/SUBMISSIONS.md'] || '';
  check('SUBMISSIONS.md documents every field the parser requires',
    ['What we did', 'What we recommend', 'Decision needed', 'If no answer comes'].every((f) => subs.includes(f)));
  check('…and the full age ladder with its four rungs', AGE_LADDER.every((r) => subs.includes(r.rung)));
  check('…and marks the numbers provisional, like the policy does with its own', /⚖️/.test(subs) && /2026-08-24/.test(subs));
  /*
   * UPDATED 2026-08-10 (fourth session), when the ledger stopped being empty.
   *
   * This check read `submissions.length === 0` and passed for as long as the file
   * had nothing in it. **That was never the property worth checking** — it was a
   * proxy for the real one, which is that the contract's own fenced ```markdown
   * illustration (`### S-000 — what was delivered, in one line`) and its worked
   * example of a decided heading must NOT parse as live submissions. Without the
   * code-fence strip in parseSubmissions(), the office would report work awaiting
   * the client's decision that nobody ever submitted, and `S-000` would appear in a
   * notification to him.
   *
   * The proxy expired the moment S-001 and S-002 were filed. Replaced with the
   * property itself, which holds whether the file has 0 entries or 50 — and which
   * would have failed against a parser with no fence strip even on an empty file.
   */
  const subsParsed = parseSubmissions(subs, '2026-08-10');
  check('SUBMISSIONS.md — the contract\'s own fenced EXAMPLE does not parse as a live submission',
    !subsParsed.submissions.some((x) => x.id === 'S-000'),
    subsParsed.submissions.map((x) => x.id).join(','));
  check('…and every entry that DOES parse is well-formed (no missing required field)',
    subsParsed.ok === true && subsParsed.malformed.length === 0, JSON.stringify(subsParsed.malformed));
  check('…and the hand-maintained Counts line agrees with the DERIVED count (if not, the line is the stale one)',
    subs.includes(`**Counts:** ${subsParsed.counts.total} entr`) || subsParsed.counts.total === 0,
    `derived ${subsParsed.counts.total}`);
  check('…and says why it is empty, so the next session does not "fix" it', /deliberately EMPTY/.test(subs));

  check('the parent contract points at each direction\'s own README', /from-owner\/README\.md/.test(files['channel/README.md'] || ''));
  check('…and corrects, rather than silently edits, what it no longer knows', /A15/.test(files['channel/README.md'] || ''));

  check('the paths this code reads are the paths the contracts describe',
    OWNER_DIR === 'channel/from-owner'
    && READ_LOG_PATH === 'channel/from-office/READ-LOG.md'
    && SUBMISSIONS_PATH === 'channel/to-owner/SUBMISSIONS.md');
  check('…and every one of them resolves inside back-office',
    fs.existsSync(path.join(BACKOFFICE, OWNER_DIR))
    && fs.existsSync(path.join(BACKOFFICE, path.dirname(READ_LOG_PATH)))
    && fs.existsSync(path.join(BACKOFFICE, SUBMISSIONS_PATH)));
}

/* ════════════════════════════════ summary ══════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`
  PROVEN HERE:   the parsers refuse rather than guess; the read record tells
                 UNREAD from READ-AND-IGNORED and survives an owner edit; an
                 owner message outranks the board and survives both the budget
                 fitter and a degraded snapshot; an unanswered entry climbs and
                 gets LOUDER; a failed notification is returned AND recorded;
                 the heartbeat is sent with nothing to report; Saturday writes
                 nothing.
  NOT PROVEN:    that a GitHub Issue actually reaches the owner's phone. That
                 is a property of his notification settings, not of this code.
                 The heartbeat is what makes its absence detectable.
  STILL OPEN:    if the Worker stops running, no heartbeat is sent and nothing
                 here notices — OFFICE-POLICY A16's class of failure. Boarded.
${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
