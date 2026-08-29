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
  DEFAULT_OWNER_KIND, parseOwnerFilename,
  parseOwnerMessage, parseReadLog, renderReadLog, readKey,
  classifyOwnerMessages, ownerMessageSections,
  AGE_LADDER, daysBetween, escalationFor,
  parseSubmissions, submissionSections, ageQuestions,
  classifyOwnerIssueReadback, messageAddressesAgent,
  // SESSION 14 (2026-08-23), ITEM B: the client's Issue replies.
  OWNER_ISSUE_REPLIES_DIR, parseIssueReply, issueReplySections, collapseDuplicateIssueReplies,
  // SESSION 15 (2026-08-24), ITEM D: a reply stops the repeat.
  classifyOwnerReply, itemIdsInText, RERAISE_AFTER_DAYS,
} from '../workers/owner-channel.js';
import {
  ownerChannelEnabled, notifyOwner, selectNotificationItems,
  buildIssueBody, buildIssueTitle, OWNER_ISSUE_LABEL, OWNER_NOTIFY_TABLE_SQL,
  // SESSION 11 (2026-08-23): the three-part gate and the email notice.
  noticeParts, gateNotificationItems, buildEmailNotice, buildHebrewNoticePrompt,
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

  /* ── the owner's own date format, accepted 2026-08-23 ──────────────────
   * `17-08-2026-build-contract-reader-tool.md` — the first real client-shaped
   * deliverable ever assigned — was refused for six days for being written
   * day-month-year, which is the standard format in Israel. Both shapes are
   * accepted at the door; only ONE is stored. */
  const dmy = parseOwnerMessage(MSG(), '17-08-2026-ship-the-site.md', 'x');
  check('a DD-MM-YYYY filename is ACCEPTED — the owner writes dates that way', dmy.ok, dmy.reason);
  check('…and its id is NORMALISED to YYYY-MM-DD, so ordering and reply threading are unchanged',
    dmy.ok && dmy.message.id === '2026-08-17-ship-the-site', dmy.ok ? dmy.message.id : dmy.reason);
  // `date:` in a header still wins over the filename — unchanged. With no
  // header (the real contract-analyst case) the normalised filename date is
  // what lands, which is the half that has to be right.
  const dmyNoHeader = parseOwnerMessage('# Ship it\n\nDo it.', '17-08-2026-ship-the-site.md', 'x');
  check('…and with no header, message.date is the NORMALISED filename date',
    dmyNoHeader.ok && dmyNoHeader.message.date === '2026-08-17',
    dmyNoHeader.ok ? dmyNoHeader.message.date : dmyNoHeader.reason);
  check('parseOwnerFilename: a first component of 4 digits reads as YYYY-MM-DD',
    parseOwnerFilename('2026-08-17-x.md').written === 'YYYY-MM-DD');
  check('…a last component of 4 digits reads as DD-MM-YYYY',
    parseOwnerFilename('17-08-2026-x.md').written === 'DD-MM-YYYY');
  check("…and where BOTH could read (05-08-2026), the owner's convention wins",
    parseOwnerFilename('05-08-2026-x.md').written === 'DD-MM-YYYY'
    && parseOwnerFilename('05-08-2026-x.md').date === '2026-08-05');
  check('…and a name in neither shape is still REFUSED', parseOwnerFilename('ship-it.md').ok === false);

  /* ── no front matter is classified conservatively, not discarded ───────
   * It used to be fatal. That refused BOTH of the only two messages the owner
   * has ever hand-written into the folder, the contract-analyst task included. */
  const noFront = parseOwnerMessage('# Just a heading\n\nbody', '2026-08-10-x.md', 'x');
  check('ACCEPTED — no front matter, classified conservatively rather than discarded', noFront.ok, noFront.reason);
  check(`…as kind "${DEFAULT_OWNER_KIND}" — the one kind with no automated consequence anywhere`,
    noFront.ok && noFront.message.kind === DEFAULT_OWNER_KIND);
  check('…and the default is RECORDED as defaulted, never passed off as stated',
    noFront.ok && noFront.message.kindDefaulted === true);
  check('…and the default is never `emergency` or `approval` (an alert path and a ship path)',
    DEFAULT_OWNER_KIND !== 'emergency' && DEFAULT_OWNER_KIND !== 'approval');
  check('a message that DOES carry a header is unchanged — kindDefaulted is false',
    good.ok && good.message.kindDefaulted === false);
  const renderedDefault = ownerMessageSections(
    classifyOwnerMessages([noFront.message], { byKey: new Map() }), { shape: 'meeting' }
  ).map((x) => JSON.stringify(x)).join('\n');
  check('…and every surface that shows a defaulted kind SAYS it was defaulted',
    /KIND NOT STATED BY THE OWNER/.test(renderedDefault));

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
    tasks: Array.from({ length: 300 }, (_, i) => ({
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

/* ══ §3b addressed vs general owner messages (2026-08-11, Phase 3) ══ */
section('§3b `to:` — addressed messages reach their addressee, general messages reach everyone');

{
  check('parseOwnerMessage reads an optional `to:` field', parseOwnerMessage(MSG({ to: 'designer' }), '2026-08-11-a.md').message.to === 'designer');
  check('…absent `to:` parses as null (general)', parseOwnerMessage(MSG(), '2026-08-11-a.md').message.to === null);

  check('messageAddressesAgent: no `to:` matches ANY candidate set, including empty', messageAddressesAgent(null, []) && messageAddressesAgent(null, [9]));
  check('…matches by numeric id', messageAddressesAgent('9', [9, 'The Designer']));
  check('…matches by name, case-insensitively', messageAddressesAgent('DESIGNER', [9, 'The Designer']));
  check('…matches "The Designer" against a bare "designer" candidate (leading "the " stripped both sides)', messageAddressesAgent('The Designer', [9, 'designer']));
  check('…does NOT match a different agent', !messageAddressesAgent('designer', [7, 'The Team Lead']));
  check('…a typo\'d addressee matches NOBODY rather than falling back to general', !messageAddressesAgent('desginer', [9, 'The Designer']));

  const general = parseOwnerMessage(MSG({ to: null }, '# General policy\n\nEveryone follow this.'), '2026-08-11-general.md', 'g1').message;
  const toDesigner = parseOwnerMessage(MSG({ to: 'designer', date: '2026-08-11' }, '# Ship the new banner\n\nUse the new palette.'), '2026-08-11-banner.md', 'd1').message;
  const classified = classifyOwnerMessages([general, toDesigner], parseReadLog(''));

  const forDesigner = ownerMessageSections(classified, { shape: 'agent', candidates: [9, 'The Designer'] });
  const itemsForDesigner = forDesigner.find((s) => s.label === 'owner-messages')?.items.join('\n') || '';
  check('the ADDRESSEE sees the addressed message in full', /Ship the new banner/.test(itemsForDesigner) && /Use the new palette/.test(itemsForDesigner));
  check('…and sees the general message too', /General policy/.test(itemsForDesigner));

  const forTrainee = ownerMessageSections(classified, { shape: 'agent', candidates: [4, 'The Trainee'] });
  const itemsForTrainee = forTrainee.find((s) => s.label === 'owner-messages')?.items.join('\n') || '';
  check('a NON-addressee still sees the general message (general reaches everyone, unchanged)', /General policy/.test(itemsForTrainee));
  check('…but NOT the text addressed to someone else', !/Ship the new banner/.test(itemsForTrainee) && !/new palette/.test(itemsForTrainee));
  check('…it collapses to a COUNT instead — the same shape acted messages already use, never silently dropped',
    /1 more addressed to \(an\)other agent/.test(forTrainee.find((s) => s.label === 'owner-messages')?.header || ''));

  const onlyAddressed = classifyOwnerMessages([toDesigner], parseReadLog(''));
  const forSomeoneElse = ownerMessageSections(onlyAddressed, { shape: 'agent', candidates: [4, 'The Trainee'] });
  check('when EVERYTHING is addressed elsewhere, the count still renders (never a silent empty section)',
    /1 owner message\(s\) awaiting action are addressed to \(an\)other agent\(s\)/.test(forSomeoneElse.find((s) => s.label === 'owner-messages-addressed-elsewhere')?.text || ''));
  check('…and the full-text "owner-messages" section is simply absent, not empty', !forSomeoneElse.some((s) => s.label === 'owner-messages'));

  // Meetings/reports are NOT scoped by addressee — a multi-agent forum sees everything.
  const meetingSections = ownerMessageSections(classified, { shape: 'meeting', candidates: [4, 'The Trainee'] });
  const meetingItems = meetingSections.find((s) => s.label === 'owner-messages')?.items.join('\n') || '';
  check('a MEETING shape ignores candidates entirely — sees the addressed message too, regardless of who is asking',
    /Ship the new banner/.test(meetingItems));

  // End-to-end through buildOfficeContext(), the real call path agent-base.js uses.
  const snap = {
    today: '2026-08-11', board: null, requirements: null, questions: null, lifecycle: null,
    policy: null, owner: { classified }, submissions: null, errors: [],
  };
  const designerCtx = buildOfficeContext(snap, 'agent', { agentId: 9, agentName: 'The Designer', clearance: 'specialist', today: '2026-08-11' });
  check('buildOfficeContext threads agentId/agentName through to the real scoping (the actual agent-base.js call shape)',
    /Ship the new banner/.test(designerCtx.text));
  const traineeCtx = buildOfficeContext(snap, 'agent', { agentId: 4, agentName: 'The Trainee', clearance: 'standard', today: '2026-08-11' });
  check('…and a different agentId genuinely changes what is rendered — not a flag that is threaded but never read',
    !/Ship the new banner/.test(traineeCtx.text) && /addressed to \(an\)other agent/.test(traineeCtx.text));
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

  /*
   * THE AGEING CHECKS BELOW NEED AN OPEN ENTRY, AND THE LIVE FILE MAY HAVE NONE.
   *
   * They read the live file until 2026-08-17, when Q-001 was marked ANSWERED and
   * the channel reached zero open questions — and these two checks went RED. The
   * checks were not measuring the ladder at that point; they were measuring
   * whether the owner happened to be behind on answering. **A verifier that can
   * only pass while the office is blocked on the client inverts what it is for**,
   * and "zero open questions" is the healthiest state this channel has.
   *
   * So the ladder is exercised against the live file PLUS one synthetic open
   * entry appended in memory. The live file is still parsed and still asserted
   * above — what stops being required is that it contain something unanswered.
   * Nothing is written to disk.
   */
  const SYNTHETIC_OPEN = [
    '', '---', '',
    '### Q-999 — Synthetic open entry, verifier-only, never written to disk. Does the ladder still rise?',
    '', '- **Asked by:** Agent 12 — The Workflow', '- **Date:** 2026-08-10',
    '- **Blocking:** nothing — this entry exists so the ageing checks have an open question to age',
    '- **What I need:** a decision',
    '- **If no answer comes:** nothing happens; this entry is a fixture, not a question.', '',
  ].join('\n');
  const qsAgeable = parseOpenQuestions(qsMd + SYNTHETIC_OPEN);
  check('the ageing fixture yields exactly one open entry to age',
    qsAgeable.ok && qsAgeable.counts.open === 1, `open=${qsAgeable.counts?.open}`);
  const agedFixture = ageQuestions(qsAgeable.questions, '2026-09-15');
  check('…an open entry five weeks old is ESCALATED',
    agedFixture.filter((q) => q.open).every((q) => q.escalation.rung === 'ESCALATED'));

  const snapLater = {
    today: '2026-09-15', board: null, requirements: { requirements: [{ id: 'REQ-001', title: 'x', status: 'in progress', urgent: true }], due: '2026-09-07', malformed: [] },
    questions: qsAgeable, lifecycle: null, policy: null, owner: null, submissions: null, errors: [],
  };
  const later = buildOfficeContext(snapLater, 'meeting', { today: '2026-09-15' });
  check('…and a risen question is RE-SURFACED in its own headline section, not merely relabelled',
    /ASKED AND NOT ANSWERED/.test(later.text) && !later.dropped.includes('questions-overdue'));
  check('…saying the fallback was TAKEN and the question is STILL OPEN', /FALLBACK HAS BEEN TAKEN and the question is STILL OPEN/.test(later.text));
}

/* ═══ §4b owner-channel Issues — the ladder now covers them too (2026-08-11, Phase 1.2) ═══ */
section('§4b an owner-channel Issue with no reply climbs the SAME ladder, and rises in the next notification');

{
  const fresh = classifyOwnerIssueReadback(
    [{ number: 37, title: 'awaiting your decision', createdAt: '2026-08-11', state: 'open', comments: 0 }],
    '2026-08-11',
  );
  check('[FAILS-OLD] before this session, NOTHING read an Issue back — an unanswered #37 was invisible to the office forever',
    fresh[0].hasReply === false && fresh[0].escalation.rung === 'FRESH');

  const escalated = classifyOwnerIssueReadback(
    [{ number: 37, title: 'awaiting your decision', createdAt: '2026-08-11', state: 'open', comments: 0 }],
    '2026-08-25',
  );
  check('…14 days unanswered climbs to ESCALATED, same ladder as questions/submissions', escalated[0].escalation.rung === 'ESCALATED');
  check('…takeFallback fires at the same rung the ladder defines everywhere else', escalated[0].escalation.takeFallback === true);

  const commented = classifyOwnerIssueReadback(
    [{ number: 37, title: 'x', createdAt: '2026-08-11', state: 'open', comments: 1 }],
    '2026-08-25',
  );
  check('a COMMENT counts as a reply even though the documented channel is the repo — lower friction than editing markdown, and otherwise unread forever',
    commented[0].hasReply === true && commented[0].escalation === null);

  const closedByOwner = classifyOwnerIssueReadback(
    [{ number: 36, title: 'x', createdAt: '2026-08-01', state: 'closed', comments: 0 }],
    '2026-08-25',
  );
  check('a CLOSED Issue counts as a reply — the office never closes an owner-channel Issue itself, so a closure came from him',
    closedByOwner[0].hasReply === true);

  const untouchedHeartbeat = classifyOwnerIssueReadback(
    [{ number: 36, title: 'heartbeat', createdAt: '2026-08-10', state: 'open', comments: 0 }],
    '2026-08-11',
  );
  const items = selectNotificationItems({ submissions: [], questions: [], issueReadback: untouchedHeartbeat });
  check('a 1-day-old unanswered Issue does NOT repeat itself the very next cycle — only OVERDUE+ enters the notification', items.length === 0);

  const overdueIssue = classifyOwnerIssueReadback(
    [{ number: 37, title: 'awaiting your decision', createdAt: '2026-08-01', state: 'open', comments: 0 }],
    '2026-08-11',
  );
  const risen = selectNotificationItems({ submissions: [], questions: [], issueReadback: overdueIssue });
  check('…but an OVERDUE-or-later unanswered Issue DOES rise into the next notification, named by number', risen.length === 1 && risen[0].id === 'Issue #37');
  check('…carrying its age so the owner sees it is a repeat, not a new ask', /OVERDUE|ESCALATED/.test(risen[0].age));

  const repliedNotRepeated = selectNotificationItems({ submissions: [], questions: [], issueReadback: commented });
  check('a REPLIED-TO Issue is never re-notified, no matter how old', repliedNotRepeated.length === 0);
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
  // UPDATED 2026-08-23 (SESSION 11, ITEM E): these items must now state all
  // three parts, or the gate holds them back and there is no send to fail on.
  const failed = await notifyOwner(envOn, failDeps, { items: [{ id: 'S-002', title: 'y', decision: 'Ship it or hold it?', recommend: 'Ship it.', fallback: 'It is held.' }], today: '2026-08-10' });
  check('a FAILED send is returned as failed, not swallowed', failed.sent === false && !failed.skipped);
  const recorded = rowsWritten.slice(before).find((r) => /INSERT INTO owner_notifications/.test(r.sql));
  check('…and is RECORDED with ok=0 (a ledger of successes only cannot answer "what did we fail to send")',
    !!recorded && recorded.args.includes(0));

  const threw = await notifyOwner(envOn, { postIssue: async () => { throw new Error('network down'); } }, { items: [{ id: 'S-3', title: 'z', decision: 'Which way?', recommend: 'This way.', fallback: 'Nothing moves.' }], today: '2026-08-10' });
  check('a THROWN send is caught and recorded as a failure, never as a success', threw.sent === false && /network down/.test(threw.reason));

  // Sequence rendering.
  const withPrev = buildIssueBody({ seq: 7, previous: { seq: 6, sentAt: '2026-08-03T00:00:00Z', issue: 40 }, kind: 'heartbeat', items: [], today: '2026-08-10' });
  check('the body names the PREVIOUS notification, so a gap is visible in the message that DID arrive', /#6/.test(withPrev) && /a notification was lost/i.test(withPrev));
  const noSeq = buildIssueBody({ seq: null, sequenceReason: 'no_db_binding', kind: 'heartbeat', items: [], today: '2026-08-10' });
  check('an UNKNOWABLE sequence is announced loudly, never invented', /SEQUENCE NUMBER COULD NOT BE ESTABLISHED/.test(noSeq));
  check('…and the title says so too', /#\?/.test(buildIssueTitle({ seq: null, kind: 'heartbeat', items: [], today: '2026-08-10' })));

  // REWRITTEN 2026-08-23 (SESSION 11, ITEM D). This check used to assert the
  // OPPOSITE — that the body said "In the repo, not in this issue". That was a
  // faithful test of a real contract, and the contract was the reason eleven
  // notifications went unanswered: it told the one person the office needs to
  // hear from to stop reading and go edit markdown in a private repo. The
  // property it protected (git is the permanent record) is kept by the office
  // doing its own filing — see recordIssueReplies() in agent-runner.js.
  check('the reply route is THE ISSUE ITSELF — he answers where he is reading', /Just reply to this issue/.test(withPrev));
  check('...and the old "not in this issue" instruction is GONE, not merely demoted', !/In the repo, not in this issue/.test(withPrev));
  check('...and the office promises to file the reply itself, so git stays the record', /from-owner-issues/.test(withPrev));
  check('...and the repo route survives as a SECONDARY option, not deleted', /rather write it into the repo yourself/.test(withPrev));
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
  // Was: 'guide_verify moved to Friday and is still weekly (one run, one day)'.
  // Retired from the schedule entirely on 2026-08-29 (Session 34, Item B) —
  // `guides_enabled` has read false in live SIM_KV since 2026-08-20 and every
  // guide_* admission since 2026-08-21 recorded actual: 0. INVERTED rather than
  // deleted, like the Saturday checks above it.
  //
  // What §8 is really protecting is unchanged and still asserted: A13 says
  // Saturday writes nothing. The retirement makes that MORE true, not less, so
  // this check now guards the stronger property — the block is nowhere at all,
  // and cannot drift back onto Saturday from Friday either.
  check('guide_verify is retired from every schedule, Friday included',
    ['full_day_schedule', 'friday_schedule', 'saturday_schedule']
      .every((s) => !schedule[s].blocks.some((b) => b.type === 'guide_verify')));
  check('…and it is preserved verbatim in the retirement record, so A13 still binds if it is ever restored',
    (schedule._blocks_retired_2026_08_29?.removed_blocks?.friday_schedule || [])
      .some((b) => b.type === 'guide_verify' && b.time === '11:30'));

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
/* ─── §11 — THE THREE-PART GATE AND THE EMAIL NOTICE (SESSION 11) ───────── */
section('11. The three-part gate, and the notice that reaches him');

{
  const full = { id: 'S-002', title: 'a thing', decision: 'Deploy it or hold it?',
    recommend: 'Hold it until its data is live.', fallback: 'It is held and OB-060 stays NOT-READY.' };

  const p = noticeParts(full);
  check('an item that states all three parts PASSES', p.ok === true);
  check('...the ask is one sentence, taken from the decision', p.ask === 'Deploy it or hold it?');
  check('...it offers at least two options', p.options.length >= 2);
  check('...and one of them is always "say nothing", carrying the default',
    p.options.some((o) => /Say nothing/.test(o.label)));

  // The identifiers are stripped from what a person reads, and NOT from the record.
  check('board identifiers are stripped from the ask a client reads',
    !/OB-|S-\d|REQ-/.test(noticeParts({ decision: 'Do we ship OB-060 now, per REQ-003?', fallback: 'x' }).ask));
  check('...but the item keeps its own id, because the office still needs it', full.id === 'S-002');
  // Corrected 2026-08-23 after reading live Issue #47, which the first version
  // of this produced: stripping mid-sentence left "sequenced against 's" and
  // "`` is opened". A broken sentence is harder to read than the identifier.
  check('...and NOTHING ELSE is stripped — a mangled sentence is worse than an identifier',
    noticeParts({ decision: 'Ship?', recommend: 'Hold it, per REQ-004.', fallback: 'OB-060 stays NOT-READY.' })
      .options.some((o) => /REQ-004/.test(o.text))
    && noticeParts({ decision: 'Ship?', recommend: 'x', fallback: 'OB-060 stays NOT-READY.' }).noAnswer.includes('OB-060'));

  // THE ITEMS THAT FAIL — and this is the finding, not an edge case.
  // Measured against live notification #11 (Issue 46, 2026-08-23): six items,
  // one passed. The five that failed were `Issue #36`..`#40` — the office
  // telling the client it had already told him, with no options and no default.
  const readback = { id: 'Issue #40', title: '[Office #5] 1 awaiting your decision',
    did: 'This is a previous notification of ours that has had no reply.',
    decision: 'Same as it originally asked — repeated here because it is now overdue.',
    fallback: null, recommend: null };
  const rp = noticeParts(readback);
  check('AN ISSUE-READBACK ITEM FAILS THE GATE — it states no default and no option',
    rp.ok === false && rp.missing.includes('what happens with no answer'));

  const { notifiable, gated } = gateNotificationItems([full, readback]);
  check('the gate SPLITS rather than deletes — the held item is returned with its reason',
    notifiable.length === 1 && gated.length === 1 && gated[0].id === 'Issue #40');
  check('...and a passing item carries its parts forward, so the Issue and the email agree',
    !!notifiable[0].parts && notifiable[0].parts.ok);
}

{
  // The gate is a FILTER on what becomes an Issue, not advice in a prompt.
  const posted = [];
  const deps = { postIssue: async (e, issue) => { posted.push(issue); return { created: true, status: 201, number: 99 }; } };
  const envOn = { DB: null, SIM_KV: { get: async () => ({ owner_channel_enabled: true }) } };

  const res = await notifyOwner(envOn, deps, {
    items: [{ id: 'X-1', title: 'no options here', did: 'we did a thing' }],
    today: '2026-08-11', isHeartbeatDay: false,
  });
  check('AN UNGATED ITEM DOES NOT BECOME AN ISSUE — it is a log entry',
    res.skipped === true && posted.length === 0 && res.reason === 'nothing_notifiable_and_not_heartbeat_day');
  check('...and what was held back is reported, never silently dropped',
    Array.isArray(res.gated) && res.gated.length === 1 && res.gated[0].id === 'X-1');
}

{
  // The Issue body now leads with the three parts and folds the detail away.
  const item = { id: 'S-002', title: 'the site', decision: 'Deploy as-is or hold?',
    recommend: 'Hold it.', fallback: 'It is held.', did: 'Built and deployed the message loop.' };
  const { notifiable } = gateNotificationItems([item]);
  const body = buildIssueBody({ seq: 12, kind: 'submission', items: notifiable, today: '2026-08-23' });
  check('the Issue leads with what is being asked', /\*\*What is being asked:\*\* Deploy as-is or hold\?/.test(body));
  check('...then the options', /\*\*Your options:\*\*/.test(body));
  check('...then what happens with no answer', /\*\*If you do not answer:\*\* It is held\./.test(body));
  check('...and the long "what we did" is folded away, not deleted', /<details><summary>What the office did, in full<\/summary>/.test(body)
    && /Built and deployed the message loop\./.test(body));

  // The email carries the SAME three parts and nothing else.
  const notice = buildEmailNotice({ seq: 12, items: notifiable, today: '2026-08-23',
    issueUrl: 'https://github.com/avivnofar/back-office-AI-agents/issues/1', hebrew: null });
  check('the email skeleton carries the ask, the options and the default', /ASKED: Deploy as-is or hold\?/.test(notice.skeleton)
    && /OPTION —/.test(notice.skeleton) && /IF YOU DO NOT ANSWER: It is held\./.test(notice.skeleton));
  check('THE EMAIL DOES NOT CARRY THE ISSUE\u2019S CONTENTS — it is a notice, not a document',
    !/Built and deployed the message loop/.test(notice.skeleton));
  check('...it links to the Issue instead', /issues\/1/.test(notice.html));
  check('...it is right-to-left, the shell the one working send used', /dir="rtl"/.test(notice.html));
  check('A GEMINI FAILURE DEGRADES TO ENGLISH, NEVER TO SILENCE',
    notice.usedHebrew === false && /Hebrew composition failed/.test(notice.html) && notice.html.length > 200);

  const heb = buildEmailNotice({ seq: 12, items: notifiable, today: '2026-08-23', issueUrl: null, hebrew: 'שאלה: לפרוס או להמתין?' });
  check('...and composed Hebrew is used when it is there, with no warning banner',
    heb.usedHebrew === true && /לפרוס/.test(heb.html) && !/Hebrew composition failed/.test(heb.html));
  check('the Hebrew prompt forbids inventing an option the office did not state',
    /NEVER invent an option/.test(buildHebrewNoticePrompt('x')));
  check('...and forbids internal identifiers reaching him', /Do NOT include internal identifiers/.test(buildHebrewNoticePrompt('x')));
  check('...and HTML is escaped, so a stray angle bracket cannot break the mail',
    !/<script>/.test(buildEmailNotice({ seq: 1, items: [], today: 'x', issueUrl: null, hebrew: '<script>alert(1)</script>' }).html));
}

/* ════════════════════════════════════════════════════════════════════════
 * §12  THE CLIENT'S ISSUE REPLIES — the fourth channel state
 * ════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-23 the owner replied to Issue #47 — the first reply this office
 * has ever received from him, after eleven unanswered notifications. It was
 * read, recorded and committed to git at
 * `channel/from-owner-issues/2026-08-23-issue-47-comment-5386042924.md`.
 *
 * And `fetchOfficeSnapshot()` listed `channel/from-owner/` and nothing else, so
 * the sibling directory was read by no lister, parser or prompt builder in the
 * estate. The instruction reached ZERO agent prompts.
 *
 * That is a FOURTH state and it is worse than the three §1–§2 already
 * distinguish: unread, read-and-ignored and acted are all states the office can
 * SEE. This one is filed, versioned, attributable — and invisible, with every
 * receipt saying the message had arrived.
 *
 * The acceptance test for the fix is not that a function exists. It is that the
 * client's own words come back out of the assembled context, so this section
 * ends by searching a rendered prompt for them.
 */
section('§12 the client\'s Issue replies — filed, versioned, and (until today) invisible');
{
  // The real file, byte for byte, as recordIssueReplies() writes it.
  const REAL = [
    '# Reply from the client — Issue #47',
    '',
    '- **Issue:** [#47](https://github.com/avivnofar/office-AI-agents/issues/47) — [Office #12] 1 awaiting your decision (2026-08-23)',
    '- **Author:** avivnofar',
    '- **Written:** 2026-08-23T12:39:44Z',
    '- **Comment id:** 5386042924',
    '',
    '_Transcribed by the office from the Issue thread. His words, unedited._',
    '_This is the office\'s record of what he said; it is NOT a file he wrote,_',
    '_which is why it is not in `channel/from-owner/`._',
    '',
    '---',
    '',
    'deploy warehouse-office-AI-agents/tasks/office-site/ and try to finish it. the /owner site is not being used anyway and i want to see the new one. try to finish the website, and if you can\'t, tell me what you need',
    '',
  ].join('\n');

  const parsed = parseIssueReply(REAL, '2026-08-23-issue-47-comment-5386042924.md', 'sha1');
  check('the real 2026-08-23 reply parses', parsed.ok, parsed.reason);
  check('...with the Issue NUMBER, so a reader can go back to the thread', parsed.reply?.issueNumber === '47');
  check('...the Issue TITLE, which says WHICH notification he was answering',
    /Office #12/.test(parsed.reply?.issueTitle || ''));
  check('...the author', parsed.reply?.author === 'avivnofar');
  check('...and a date normalised to YYYY-MM-DD from the `Written` timestamp',
    parsed.reply?.date === '2026-08-23');
  check('the BODY is his words and nothing else — no header, no provenance note',
    parsed.reply?.body.startsWith('deploy warehouse-office-AI-agents')
    && !/Transcribed by the office/.test(parsed.reply?.body || ''));

  // ── PERMISSIVE WHERE parseOwnerMessage() IS STRICT, ON PURPOSE ─────────
  // A refusal in the owner's own folder protects against acting on a guess
  // about what HE meant. Here the only thing at risk is the office's own
  // bookkeeping, and refusing his words because our transcriber dropped a field
  // would be the office declining to read the client over its own defect.
  const noFields = parseIssueReply('# x\n\n---\n\nsome words he wrote\n', 'x.md');
  check('a reply missing every header field still yields the BODY',
    noFields.ok && noFields.reply.body === 'some words he wrote');
  check('...with the missing bookkeeping reported as null, never invented',
    noFields.reply.issueNumber === null && noFields.reply.author === null);
  check('...and the rendered line SAYS the number was not recorded, rather than omitting it',
    /ISSUE NUMBER NOT RECORDED/.test(
      issueReplySections([noFields.reply], { shape: 'agent' }).map((x) => (x.items || [x.text]).join('\n')).join('\n')));
  check('an empty file is REFUSED, not rendered as a blank instruction',
    parseIssueReply('', 'x.md').ok === false);
  check('a file with a header and no body is refused too',
    parseIssueReply('# x\n\n- **Author:** a\n\n---\n\n', 'x.md').ok === false);

  // ── THE DISTINCTION IS PRESERVED DOWNSTREAM (B3) ───────────────────────
  const secs = issueReplySections([parsed.reply], { shape: 'agent' });
  const rendered = secs.map((x) => (x.items ? `${x.header}\n${x.items.join('\n')}` : x.text)).join('\n');
  check('the section labels are DISTINCT from the owner-message ones — the two never merge',
    secs.every((x) => /^owner-issue-replies/.test(x.label)), secs.map((x) => x.label).join(', '));
  check('the rendered text says these are the OFFICE\'S TRANSCRIPTIONS, not files he wrote',
    /TRANSCRIPTIONS/.test(rendered) && /NOT files he wrote/.test(rendered));
  check('...and every entry repeats it, so a trimmed list cannot lose the provenance',
    /NOT a file he wrote/.test(rendered));
  check('a reply OUTRANKS the delegation board, exactly as a message in his own folder does',
    /OUTRANKS the delegation board/.test(rendered));
  check('every reply reads as OUTSTANDING — no read/acted state is claimed for these',
    /NO READ\/ACTED STATE/.test(rendered));

  /* ── ONE MESSAGE POSTED TO FIVE ISSUES (SESSION 28, ITEM A) ────────────
   *
   * The rule under test, stated so a reader can apply it by hand: two issue
   * replies are the same message when their bodies are identical after
   * collapsing runs of whitespace, AND they name the same author, AND they
   * carry the same date — in which case the earliest is shown and the other
   * Issue numbers are recorded on it.
   *
   * The SAFETY cases below matter more than the collapsing one. A dedup that
   * merges two things the client said separately is far worse than 3,637
   * wasted tokens, so each conjunct is tested by breaking it on its own.
   */
  const dupOf = (n, { body = 'the same words', author = 'avivnofar', date = '2026-08-25', written = null } = {}) => ({
    id: `${date}-issue-${n}-comment-${1000 + n}`,
    path: `channel/from-owner-issues/${date}-issue-${n}-comment-${1000 + n}.md`,
    issueNumber: String(n), issueTitle: `t${n}`, author, date,
    written: written || `${date}T09:10:${String(10 + n).padStart(2, '0')}Z`,
    commentId: String(1000 + n), body,
  });

  const fiveCopies = [37, 38, 39, 40, 47].map((n) => dupOf(n));
  const collapsedFive = collapseDuplicateIssueReplies(fiveCopies);
  check('five identical bodies, same author and same day, collapse to ONE',
    collapsedFive.kept.length === 1 && collapsedFive.collapsed === 4);
  check('...and the survivor is the EARLIEST, not whichever the directory listed first',
    collapsedFive.kept[0].issueNumber === '37');
  check('...and it names every other Issue the same text went to',
    collapsedFive.kept[0].alsoPostedTo.map((o) => o.issueNumber).join(',') === '38,39,40,47');
  check('whitespace-only differences still collapse — that IS the normalisation',
    collapseDuplicateIssueReplies([dupOf(1), dupOf(2, { body: 'the   same\n\nwords' })]).kept.length === 1);

  // Each conjunct, broken on its own. All three must REFUSE to collapse.
  check('[SAFETY] same body on a DIFFERENT DAY is NOT collapsed — saying it again is the message',
    collapseDuplicateIssueReplies([dupOf(1), dupOf(2, { date: '2026-09-01' })]).kept.length === 2);
  check('[SAFETY] same body from a DIFFERENT AUTHOR is NOT collapsed — that is two people agreeing',
    collapseDuplicateIssueReplies([dupOf(1), dupOf(2, { author: 'someone-else' })]).kept.length === 2);
  check('[SAFETY] a missing author or date NEVER matches another missing one',
    collapseDuplicateIssueReplies([dupOf(1, { author: null }), dupOf(2, { author: null })]).kept.length === 2);
  check('[SAFETY] bodies differing in WORDING are two replies, not one',
    collapseDuplicateIssueReplies([dupOf(1), dupOf(2, { body: 'the same words, roughly' })]).kept.length === 2);
  check('[SAFETY] bodies differing only in CASE are two replies — casing is not normalised away',
    collapseDuplicateIssueReplies([dupOf(1), dupOf(2, { body: 'The Same Words' })]).kept.length === 2);

  // ── A COLLAPSED COPY IS RECORDED, NEVER VANISHED (A4) ─────────────────
  const dupRendered = issueReplySections(fiveCopies, { shape: 'agent' })
    .map((x) => (x.items ? `${x.header}\n${x.items.join('\n')}` : x.text)).join('\n');
  check('the COUNT LINE states both numbers — 5 on record, 1 distinct — and never just the smaller one',
    /5 on record, 1 distinct/.test(dupRendered));
  check('...and says plainly that nothing was omitted',
    /NOTHING IS OMITTED/.test(dupRendered));
  check('the shown copy tells the reader he posted it to FIVE Issues, naming them',
    /WORD FOR WORD, TO 5 ISSUES/.test(dupRendered) && /#38, #39, #40, #47/.test(dupRendered));
  check('...and warns an agent not to read it as said once — repetition is emphasis',
    /DO NOT READ THIS AS SAID ONCE/.test(dupRendered));
  check('the client\'s words themselves are still rendered in full, not summarised away',
    /the same words/.test(dupRendered));
  check('[FAILS-OLD] before this rule the same five rendered five times',
    (dupRendered.match(/the same words/g) || []).length === 1);

  // ── THE ZERO CASE, WHICH IS WHERE THE ORIGINAL DEFECT LIVED ────────────
  const empty = issueReplySections([], { shape: 'agent' });
  check('with no replies the COUNT LINE still renders — silence is stated, not implied',
    empty.length === 1 && /none on record/.test(empty[0].text));
  const refusedOnly = issueReplySections([], { shape: 'agent', malformed: ['x.md: file is empty'] });
  check('a refused reply is NOT reported as an empty channel',
    /this is NOT an empty channel/.test(refusedOnly.map((x) => x.text || '').join(' ')));
  check('...and the refusal says it is the OFFICE\'S defect, since the office writes these files',
    /THIS ONE IS THE OFFICE'S TO FIX/.test(
      refusedOnly.map((x) => (x.items || []).join(' ')).join(' ')));

  // ── EVERY RANK SEES IT, IN FULL (A11) ─────────────────────────────────
  check('both labels are in STANDARD_SECTIONS, so a standard agent sees the client\'s reply',
    STANDARD_SECTIONS.includes('owner-issue-replies-count')
    && STANDARD_SECTIONS.includes('owner-issue-replies'));

  // ── THE ACCEPTANCE TEST (B4): HIS WORDS, OUT OF AN ASSEMBLED PROMPT ────
  //
  // Searched for in the six shapes the renderer actually produces, by the words
  // he typed rather than by a label this file controls. A check written against
  // our own header would pass on a prompt containing no instruction at all.
  const HIS_WORDS = ['deploy warehouse', 'finish the website', 'i want to see the new one'];
  const snapshot = {
    fetched_at: Date.now(),
    today: '2026-08-23',
    board: null,
    requirements: null,
    questions: null,
    lifecycle: null,
    policy: null,
    owner: null,
    ownerIssueReplies: { ok: true, replies: [parsed.reply], malformed: [] },
    submissions: null,
    // A board read that FAILED — deliberately the degraded path, because that
    // is the one where a client instruction is most likely to be dropped and
    // where `degraded: true` would read as "our work is incomplete" rather than
    // "he answered you and you were not shown it".
    errors: ['board parse failed: deliberately broken for this check'],
  };
  const SHAPES = [
    ['agent (standard rank)', { shape: 'agent', opts: { agentId: 3, clearance: 'standard' } }],
    ['agent (admin rank)', { shape: 'agent', opts: { agentId: 6, clearance: 'sudo' } }],
    ['meeting', { shape: 'meeting', opts: {} }],
    ['report', { shape: 'report', opts: {} }],
  ];
  for (const [name, { shape, opts }] of SHAPES) {
    const built = buildOfficeContext(snapshot, shape, opts);
    const text = String(built.text || '').toLowerCase();
    const found = HIS_WORDS.filter((w) => text.includes(w));
    check(`ACCEPTANCE — the client's own words reach the ${name} prompt (${found.length}/3)`,
      found.length === HIS_WORDS.length, `missing: ${HIS_WORDS.filter((w) => !text.includes(w)).join(', ')}`);
  }

  // And the same four shapes on a HEALTHY snapshot, not only the degraded one.
  const healthy = { ...snapshot, errors: [] };
  for (const [name, { shape, opts }] of SHAPES) {
    const built = buildOfficeContext(healthy, shape, opts);
    const text = String(built.text || '').toLowerCase();
    check(`ACCEPTANCE — ...and the ${name} prompt on a healthy snapshot too`,
      HIS_WORDS.every((w) => text.includes(w)),
      `missing: ${HIS_WORDS.filter((w) => !text.includes(w)).join(', ')}`);
  }

  // ── [FAILS-OLD] the defect this closes, transcribed ───────────────────
  // The old snapshot had no `ownerIssueReplies` key at all. Proving the fix
  // means proving the OLD shape produced a prompt with none of his words in it
  // — otherwise "it works now" is a claim about a thing that was never broken.
  const oldShape = { ...snapshot };
  delete oldShape.ownerIssueReplies;
  const oldBuilt = buildOfficeContext(oldShape, 'agent', { agentId: 3, clearance: 'standard' });
  check('[FAILS-OLD] the pre-change snapshot shape carries NONE of his words — the instruction was invisible',
    HIS_WORDS.every((w) => !String(oldBuilt.text || '').toLowerCase().includes(w)));
  check('[FAILS-OLD] ...and said nothing about it either: no count line, no error, no marker',
    !/from-owner-issues/i.test(String(oldBuilt.text || '')));

  /* ── THE FITTER MAY NOT TOUCH THE CLIENT'S WORDS ─────────────────────
   *
   * ADDED AFTER A FAILED ACCEPTANCE RUN, which is the only reason it is here.
   * The first live read-back of the fix — agent shape, standard rank, real
   * snapshot, budget 660 — came back with
   *
   *     dropped: [..., requirements-headline, owner-issue-replies]
   *     trimmed: [owner-messages]
   *
   * and ZERO of his words in the prompt. The section that carried the client's
   * instruction was removed by `fitToBudget()` on the same day the change was
   * made to render it, and his hand-written files were ALREADY being shortened
   * to fit and had been for as long as the shape has been over budget.
   *
   * So the client's words now ride OUTSIDE the fitter, like the policy and the
   * mission, for the reason office-context.js already gives about the policy: a
   * rule enforced only by a budget stops being enforced the moment the budget
   * moves. These checks are what stop that being undone quietly.
   */
  {
    // A snapshot deliberately stuffed far past every budget in the file: 400
    // board tasks and 300 requirements. The fitter WILL be forced to drop and trim heavily;
    // the point is what it is not allowed to reach.
    const big = {
      fetched_at: Date.now(),
      today: '2026-08-23',
      board: {
        ok: true,
        counts: { total: 400, doing: 140, todo: 130, blocked: 130 },
        malformed: [],
        tasks: Array.from({ length: 400 }, (_, i) => ({
          id: `OB-${100 + i}`, title: `a task with a deliberately long title to spend budget ${i}`,
          state: 'TODO', owner: 'someone', urgency: null, blocked: i % 3 === 0,
          blockedReason: 'a reason long enough to matter', dispatched: false, offered: false,
        })),
      },
      requirements: {
        ok: true, due: '2026-09-01', malformed: [],
        requirements: Array.from({ length: 40 }, (_, i) => ({
          id: `REQ-${i}`, title: `requirement ${i} with a long title`, status: 'open', urgent: i < 5,
        })),
      },
      questions: null, lifecycle: null, policy: null,
      owner: null,
      ownerIssueReplies: { ok: true, replies: [parsed.reply], malformed: [] },
      submissions: null,
      errors: [],
    };
    const OWNER_LABELS = ['owner-messages', 'owner-messages-count', 'owner-issue-replies', 'owner-issue-replies-count'];
    const SHAPES_UNDER_PRESSURE = [
      ['agent/standard', 'agent', { agentId: 3, clearance: 'standard' }],
      ['agent/admin', 'agent', { agentId: 6, clearance: 'sudo' }],
      ['meeting', 'meeting', {}],
    ];
    // REPORTED, not assumed. Not every shape squeezes on the same fixture —
    // the standard shape rank-filters the board detail away before the fitter
    // ever sees it, and the meeting budget is large. Asserting "every shape
    // squeezed" would have been a check that passes by accident of the fixture;
    // asserting AT LEAST ONE does is what makes the checks below mean anything,
    // and printing which is what stops the day the answer becomes none.
    const squeezed = SHAPES_UNDER_PRESSURE.filter(([, shape, opts]) => {
      const b = buildOfficeContext(big, shape, opts);
      return b.dropped.length > 0 || b.trimmed.length > 0;
    }).map(([name]) => name);
    check(`SQUEEZE — at least one shape is genuinely over budget on this fixture (so the checks below are real): ${squeezed.join(', ') || 'NONE'}`,
      squeezed.length > 0);

    for (const [name, shape, opts] of SHAPES_UNDER_PRESSURE) {
      const built = buildOfficeContext(big, shape, opts);
      const text = String(built.text || '').toLowerCase();
      check(`SQUEEZE — NONE of the client's sections is among what the fitter dropped or trimmed (${name})`,
        OWNER_LABELS.every((l) => !built.dropped.includes(l) && !built.trimmed.includes(l)),
        `dropped=${built.dropped.join(',')} trimmed=${built.trimmed.join(',')}`);
      check(`SQUEEZE — ...and his words are still in the ${name} prompt, in full`,
        HIS_WORDS.every((w) => text.includes(w)),
        `missing: ${HIS_WORDS.filter((w) => !text.includes(w)).join(', ')}`);
    }

    // THE STRUCTURAL HALF, which is what actually holds. The behavioural checks
    // above depend on a fixture; this one depends on the code. The client's
    // sections are never handed to fitToBudget() at all, so no budget, no
    // fixture and no future board size can reach them.
    const ctxSource = fs.readFileSync(path.join(ROOT, 'workers', 'office-context.js'), 'utf8');
    check('the client\'s sections are never pushed into the fitter\'s list',
      !/sections\.push\(\{ \.\.\.s, priority: PRIORITY\.headline \}\)/.test(ctxSource),
      'a push of owner sections into `sections` is back');
    check('...they are collected into clientWordSections and rendered OUTSIDE fitToBudget()',
      /const clientWordSections = \[/.test(ctxSource)
      && /const clientWords = clientWordSections\.map\(renderSection\)/.test(ctxSource));
    check('...and composed into the text alongside mission and policy, which also ride outside the budget',
      /\[mission\.text, policy\.text, clientWords, fitted\.text\]/.test(ctxSource));
    const built = buildOfficeContext(big, 'agent', { agentId: 3, clearance: 'standard' });
    check('the client\'s words are priced SEPARATELY as ownerTokens, not folded into `tokens`',
      typeof built.ownerTokens === 'number' && built.ownerTokens > 0
      && built.totalTokens === built.tokens + built.policyTokens + built.missionTokens + built.ownerTokens);

    // [FAILS-OLD] — the transcription of the mechanism that dropped him. If the
    // client's sections were still ordinary members of `sections`, this is what
    // would happen to them under the same squeeze.
    const asOrdinaryHeadlineSection = (secs, budget) => {
      const kept = secs.slice().sort((a, b) => a.priority - b.priority);
      // stage 2 of fitToBudget(): drop the LAST index among the lowest priority
      const dropped = [];
      let total = kept.reduce((n, x) => n + Math.ceil((x.text || `${x.header}${(x.items || []).join('')}`).length / 4), 0);
      while (total > budget && kept.length > 1) {
        let worst = 0;
        for (let i = 1; i < kept.length; i += 1) if (kept[i].priority >= kept[worst].priority) worst = i;
        total -= Math.ceil((kept[worst].text || `${kept[worst].header}${(kept[worst].items || []).join('')}`).length / 4);
        dropped.push(kept.splice(worst, 1)[0].label);
      }
      return dropped;
    };
    const asSections = [
      { label: 'headline', priority: 0, text: 'x'.repeat(80) },
      ...issueReplySections([parsed.reply], { shape: 'agent' }).map((x) => ({ ...x, priority: 0 })),
      { label: 'requirements-headline', priority: 0, text: 'y'.repeat(400) },
      { label: 'board-counts', priority: 1, text: 'z'.repeat(600) },
    ];
    check('[FAILS-OLD] as an ordinary headline section, the client\'s reply IS dropped under a squeeze',
      asOrdinaryHeadlineSection(asSections, 120).includes('owner-issue-replies'),
      asOrdinaryHeadlineSection(asSections, 120).join(','));
  }

  // ── THE OFFICE STILL NEVER WRITES INTO HIS OWN FOLDER ─────────────────
  check('the two directories stay distinct constants — no prefix match that would swallow the next sibling',
    OWNER_ISSUE_REPLIES_DIR === 'channel/from-owner-issues' && OWNER_DIR === 'channel/from-owner'
    && OWNER_ISSUE_REPLIES_DIR !== OWNER_DIR);
  const ctxSrc = fs.readFileSync(path.join(ROOT, 'workers', 'office-context.js'), 'utf8');
  check('office-context.js lists BOTH directories, each by its own constant',
    /fetchBackOfficeDir\(env, OWNER_DIR\)/.test(ctxSrc)
    && /fetchBackOfficeDir\(env, OWNER_ISSUE_REPLIES_DIR\)/.test(ctxSrc));
  check('...and a 404 on the reply directory is HEALTHY (it does not exist until he first replies)',
    /HTTP 404/.test(ctxSrc.slice(ctxSrc.indexOf('let ownerIssueReplies'), ctxSrc.indexOf('let ownerIssueReplies') + 900)));
  check('...while any OTHER failure says the client\'s replies are missing from the context',
    /THE CLIENT'S REPLIES ARE NOT IN THIS CONTEXT/.test(ctxSrc));
}

/* ── A REPLY STOPS THE REPEAT (2026-08-24) ──────────────────────────────── */
section('A reply stops the repeat — the live S-002 / Issue #47 case');

/*
 * NOT a constructed example. These three values are the live state of
 * 2026-08-24, read this session:
 *
 *   - S-002 is the ONLY open submission in `channel/to-owner/SUBMISSIONS.md`.
 *     Its heading ends `— APPROVED, then RESCINDED`, deliberately not one of
 *     the four markers `parseSubmissions()` recognises, so `marker === null`
 *     and it parses as OPEN. That is why it kept being selected.
 *   - Issue #47 in the PUBLIC repo carries it, under a `### S-002 — ...`
 *     heading, which is what makes the attribution readable.
 *   - The owner commented on #47 on 2026-08-23T12:39:44Z. That reply was read,
 *     recorded and committed — and the item was sent to him again the next day.
 */
const ISSUE_47_BODY = [
  '## What needs you',
  '',
  '### S-002 — The internal site: `/owner` is live; deploying the fuller `office-site` needs one decision that is yours — APPROVED, then RESCINDED',
  '*OVERDUE — 13 day(s) unanswered*',
].join('\n');
const REPLY_AT = '2026-08-23T12:39:44Z';

check('the Issue body is where the item id is readable — the heading survives stripOfficeIds()',
  itemIdsInText(ISSUE_47_BODY).join(',') === 'S-002', itemIdsInText(ISSUE_47_BODY).join(','));
check('an id boundary is required — `S-2` must not match inside `S-20`',
  itemIdsInText('S-020 and S-002').join(',') === 'S-002,S-020');
check('board ids are not owner-decision items and are not picked up',
  itemIdsInText('OB-060 and REQ-003').length === 0);

const activity = [{ itemId: 'S-002', at: REPLY_AT, source: 'your comment on Issue #47' }];
const dayAfter = classifyOwnerReply('S-002', activity, '2026-08-24');
check('[FAILS-OLD] the client’s comment is seen as activity on S-002',
  dayAfter.replied === true && dayAfter.days === 1);
check('...and it is NOT re-raised the next day', dayAfter.reRaise === false);

const openS002 = {
  id: 'S-002', open: true, title: 'The internal site', escalation: { rung: 'OVERDUE', days: 13 },
  did: 'x', recommend: 'y', decision: 'z', fallback: 'w',
};
const beforeSel = selectNotificationItems({ submissions: [openS002] });
const afterSel = selectNotificationItems({ submissions: [openS002], ownerReplies: { 'S-002': dayAfter } });
check('[FAILS-OLD] S-002 WAS selected under the old predicate — the repeat is measured, not assumed',
  beforeSel.some((i) => i.id === 'S-002'));
check('[FAILS-OLD] D5: S-002 is NOT selected once his reply is known',
  !afterSel.some((i) => i.id === 'S-002'), JSON.stringify(afterSel.map((i) => i.id)));

// D3 — once, and not permanently invisible.
const atRung = classifyOwnerReply('S-002', activity, '2026-08-30');
const pastRung = classifyOwnerReply('S-002', activity, '2026-08-31');
check(`D3: it comes back exactly once, on day ${RERAISE_AFTER_DAYS}`, atRung.reRaise === true);
check('D3: and is quiet again the day after — once, not daily', pastRung.replied === true && pastRung.reRaise === false);
const reRaised = selectNotificationItems({ submissions: [openS002], ownerReplies: { 'S-002': atRung } });
check('D3: the single re-raise really reaches the notification',
  reRaised.some((i) => i.id === 'S-002' && i.reRaised === true));
check('D3: and it says what is MISSING — the `Decision:` field is still empty',
  /Decision:` field in `SUBMISSIONS.md` is still empty/.test(reRaised.find((i) => i.id === 'S-002')?.age || ''));
check('D4: the office states the field is empty and never rules on whether his reply answered',
  /If your reply was the decision, say so/.test(reRaised.find((i) => i.id === 'S-002')?.age || ''));

// The safe direction: a failure must never read as "he answered everything".
check('an unreadable activity date does NOT silence an item — it keeps being asked',
  (() => {
    const r = classifyOwnerReply('S-002', [{ itemId: 'S-002', at: 'not-a-date', source: 'x' }], '2026-08-24');
    return r.replied === false && r.dateUnreadable === true
      && selectNotificationItems({ submissions: [openS002], ownerReplies: { 'S-002': r } }).some((i) => i.id === 'S-002');
  })());
check('an empty reply map suppresses nothing — every pre-existing caller is unaffected',
  JSON.stringify(selectNotificationItems({ submissions: [openS002], ownerReplies: {} }))
  === JSON.stringify(beforeSel));
check('one item’s reply never silences another’s',
  selectNotificationItems({
    submissions: [openS002, { ...openS002, id: 'S-003' }],
    ownerReplies: { 'S-002': dayAfter },
  }).map((i) => i.id).join(',') === 'S-003');
check('a question is gated by the same predicate, not a second copy of it',
  selectNotificationItems({
    questions: [{ id: 'Q-001', open: true, question: 'q', escalation: { rung: 'OVERDUE', days: 9, inNotification: true } }],
    ownerReplies: { 'Q-001': classifyOwnerReply('Q-001', [{ itemId: 'Q-001', at: REPLY_AT, source: 's' }], '2026-08-24') },
  }).length === 0);
check('owner-notify.js STILL imports nothing — the classification is passed in, not imported',
  !/^import\s/m.test(fs.readFileSync(path.join(ROOT, 'workers', 'owner-notify.js'), 'utf8')));

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
  ALSO PROVEN:   (2026-08-23) the client's replies, transcribed out of Issue
                 threads, reach every prompt shape and every rank IN HIS OWN
                 WORDS — searched for by what he typed, not by a label this
                 file controls — and the pre-change snapshot shape is shown to
                 carry none of them.
  STILL OPEN:    if the Worker stops running, no heartbeat is sent and nothing
                 here notices — OFFICE-POLICY A16's class of failure. Boarded.
  ALSO OPEN:     an Issue reply carries NO read/acted state, so the office
                 cannot yet say it answered one. Every reply reads as
                 OUTSTANDING forever. Conservative on purpose, and not a
                 substitute for the record READ-LOG.md keeps for his own files.
${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
