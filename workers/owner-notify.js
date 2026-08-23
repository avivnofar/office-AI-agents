/**
 * workers/owner-notify.js — the hop that reaches the owner, built to FAIL LOUDLY.
 *
 * Written 2026-08-10. Imports nothing (the rule `owner-channel.js`,
 * `deliverable-lifecycle.js` and `office-policy.js` all keep) so
 * `scripts/verify-owner-channel.js` can load and CALL it. The one impure thing
 * it does — the GitHub POST — is injected, so the verifier proves the refusals
 * without a network stack and `globalThis.fetch` stays a tripwire.
 *
 * ── THE CRITERION THIS FILE IS WRITTEN AGAINST ───────────────────────────
 *
 * OB-023 criterion 2, in the owner's own words, recorded on the board:
 *
 *   > "Whatever mechanism they propose must fail loudly. The existing email
 *   > path has an unfixed scheduling-jitter bug and its failure mode is
 *   > silence — the office thinks it reached me and I never hear anything. A
 *   > channel that can drop a message without either side noticing is worse
 *   > than no channel, because it produces false confidence on both ends."
 *
 * And the disqualifier he attached to it:
 *
 *   > "An option whose only failure signal is the owner eventually noticing
 *   > nothing arrived does not meet this criterion — that signal is
 *   > indistinguishable from a quiet week."
 *
 * That last sentence is the whole design problem, and it is worth stating
 * plainly because every obvious mechanism fails it: **you cannot make a
 * delivery failure loud on the RECEIVING end by improving the delivery.** If
 * the message does not arrive, nothing about the message can tell him.
 *
 * ── HOW BOTH ENDS ARE MADE TO LEARN ──────────────────────────────────────
 *
 * Three mechanisms, and each closes a different half:
 *
 * 1. **THE SENDER LEARNS — the POST result is a fact, not a hope.** Every
 *    attempt is recorded with its HTTP status, success or failure, into D1
 *    `owner_notifications`. A failure is then surfaced in three places the
 *    office genuinely reads: the daily report, `office-context.js`'s errors
 *    section (so it rides in EVERY agent prompt until it clears), and the
 *    trigger read-back. The old email path recorded nothing, which is why
 *    nobody ever learned.
 *
 * 2. **THE RECEIVER LEARNS A MESSAGE WAS LOST — the sequence number.** Every
 *    notification carries `#N` and names `#N-1` and the date it was sent. If
 *    the owner sees #7 and never saw #6, the gap is visible in the message he
 *    DID get. This converts an invisible loss into a visible one, at the cost
 *    of nothing.
 *
 * 3. **THE RECEIVER LEARNS *NOTHING AT ALL* ARRIVED — the heartbeat.** This is
 *    the mechanism that answers the disqualifier, and it is the only one that
 *    can. **A weekly notification is sent even when there is nothing to say.**
 *    Once the channel always speaks, silence stops being ambiguous: a quiet
 *    week and a broken channel no longer look alike, because a quiet week
 *    still produces a message that says "nothing needed your attention".
 *
 *    So the failure signal on the receiving end is not "he eventually notices
 *    nothing arrived" — it is "the weekly note he expects did not come", which
 *    is a specific, dated, recurring expectation rather than a vague absence.
 *
 * ── WHAT IS STILL NOT CLOSED, SAID HERE RATHER THAN DISCOVERED LATER ────
 *
 * The heartbeat makes silence *detectable*; it does not make it *impossible*,
 * and it depends on the owner noticing a missing weekly note. That is a real
 * residual and it is materially better than the incumbent — but a session that
 * reads this file and concludes the channel cannot drop anything has read it
 * wrong. **The residual is: if the Worker itself stops running, no heartbeat is
 * sent and nothing in this file notices.** OFFICE-POLICY A16 already names that
 * class of failure — *"he cannot catch a failure that stops him from running"* —
 * and answers it with an external check from a different machine. The midnight
 * run is that check, and wiring the heartbeat's absence into it is boarded, not
 * built here.
 *
 * ── WHY GITHUB ISSUES, AND WHY THAT DOES NOT CONTRADICT THE STANDING RULE ─
 *
 * The 2026-07-18 Q&A rebuild set a hard rule: **capability-gap digests are
 * NEVER a GitHub Issue, for either project.** That rule is about GAP REPORTS —
 * machine-generated findings about a model's answer quality, produced at a rate
 * that would turn the issue tracker into a log file nobody reads.
 *
 * **An owner-communication Issue is a different thing and is owner-approved.**
 * It is addressed TO A PERSON, it is rate-limited by the office's actual
 * decisions rather than by its question volume, and it exists because the owner
 * already receives GitHub notifications on his phone — criterion 1, *he must
 * not have to acquire a new habit.* A future session reading `fileGitHubIssue`
 * on this path and remembering only "no Issues" would remove the one hop that
 * reaches him. This paragraph is here so that does not happen.
 */

const SIM_STATE_KEY = 'simulation-state';
const OWNER_CHANNEL_FLAG = 'owner_channel_enabled';

/** The label every owner-communication Issue carries, so the owner can filter
 *  them from everything else the repo generates, and so a future session can
 *  tell this path from the gap-digest path it must never become. */
export const OWNER_ISSUE_LABEL = 'owner-channel';

/**
 * Kill switch. Absent or false means no Issue is posted, no D1 table is
 * touched, and no GitHub call is made. `=== true`, not truthiness, so a stray
 * `"false"` string cannot enable it — `officeContextEnabled()`'s shape,
 * deliberately identical.
 *
 * This is the EIGHTH switch and OB-040 already records that a documented switch
 * state goes stale the moment someone toggles it. So this comment says what the
 * CODE DEFAULT is (OFF) and makes no claim about production.
 */
export async function ownerChannelEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[OWNER_CHANNEL_FLAG] === true;
}

/**
 * The notification ledger. Lazily created, deliberately NOT in
 * `database/schema.sql` — `repo_writes` and `provider_usage` took the same
 * decision for the same reason.
 *
 * `ok` is stored for FAILURES too, and that is the entire point of the table.
 * A ledger that only recorded successes would answer "what did we send" and not
 * "what did we fail to send", and the second question is the one the incumbent
 * email path could never answer about itself.
 */
export const OWNER_NOTIFY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS owner_notifications (
  id TEXT PRIMARY KEY,
  seq INTEGER,
  kind TEXT NOT NULL,
  title TEXT,
  ok INTEGER NOT NULL,
  status INTEGER,
  detail TEXT,
  issue_number INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * The next sequence number, and the previous notification, from D1.
 *
 * ── AN UNKNOWABLE SEQUENCE IS REPORTED, NEVER GUESSED ────────────────────
 *
 * If D1 is unreachable this returns `seq: null`, and `buildIssueBody()` renders
 * that as a loud line in the Issue the owner receives. The tempting alternative
 * — start again at 1, or reuse the last cached number — would produce a
 * sequence with a silent discontinuity, which is worse than no sequence at all:
 * the mechanism whose whole job is to make a gap visible would be manufacturing
 * gaps that mean nothing, and the owner would learn to ignore them.
 */
export async function nextSequence(env) {
  try {
    if (!env?.DB) return { seq: null, previous: null, reason: 'no_db_binding' };
    await env.DB.prepare(OWNER_NOTIFY_TABLE_SQL).run();
    const row = await env.DB.prepare(
      `SELECT seq, kind, created_at, issue_number FROM owner_notifications
       WHERE ok = 1 AND seq IS NOT NULL ORDER BY seq DESC LIMIT 1`
    ).first();
    const last = row?.seq ? Number(row.seq) : 0;
    return {
      seq: last + 1,
      previous: row ? { seq: Number(row.seq), sentAt: row.created_at, kind: row.kind, issue: row.issue_number } : null,
      reason: null,
    };
  } catch (err) {
    return { seq: null, previous: null, reason: `sequence_unreadable: ${err?.message || err}` };
  }
}

export async function recordNotifyAttempt(env, { seq, kind, title, ok, status, detail, issueNumber }) {
  try {
    if (!env?.DB) return { recorded: false, reason: 'no_db_binding' };
    await env.DB.prepare(OWNER_NOTIFY_TABLE_SQL).run();
    await env.DB.prepare(
      `INSERT INTO owner_notifications (id, seq, kind, title, ok, status, detail, issue_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), seq ?? null, kind, title || null, ok ? 1 : 0, status ?? null, detail || null, issueNumber ?? null).run();
    return { recorded: true };
  } catch (err) {
    // Swallowed, like every other recorder in this codebase — but NOT silent.
    // The caller still returns the failure to its caller, and the daily report
    // still renders it from the live attempt result rather than from this table.
    console.warn(`[owner-notify] could not record notification attempt: ${err?.message || err}`);
    return { recorded: false, reason: 'record_error' };
  }
}

/**
 * Unsent notifications, for the loud half of "the sender learns".
 *
 * Read by the daily report and by `office-context.js`'s errors section, so a
 * failed notification is in front of every agent on every model call until it
 * clears. That is deliberately annoying. A failure that is merely logged is a
 * failure nobody meets.
 */
export async function recentFailures(env, { limit = 5 } = {}) {
  try {
    if (!env?.DB) return [];
    await env.DB.prepare(OWNER_NOTIFY_TABLE_SQL).run();
    const res = await env.DB.prepare(
      `SELECT seq, kind, title, status, detail, created_at FROM owner_notifications
       WHERE ok = 0 ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    return res?.results || [];
  } catch {
    return [];
  }
}

/* ─────────────────────────────── Composition ───────────────────────────── */

/**
 * The Issue body.
 *
 * Written for a person reading it on a phone: what happened, what is being
 * asked of him, and where to reply. **The reply lands in the repo, not in the
 * Issue** — one channel, one history. An Issue comment would create a second
 * place decisions live, and `channel/README.md`'s whole argument for a folder
 * is that git supplies one ordered history for free.
 *
 * `heartbeat` renders the same envelope with an explicitly empty payload, and
 * the wording is chosen so an empty week cannot be mistaken for a broken one.
 */
export function buildIssueBody({ seq, previous, sequenceReason, kind, items = [], today }) {
  const lines = [];

  lines.push(`**Notification #${seq ?? 'UNKNOWN'}** · ${today} · \`${kind}\``);
  if (seq === null) {
    lines.push('');
    lines.push('> ⚠️ **THE SEQUENCE NUMBER COULD NOT BE ESTABLISHED** — the office could not read'
      + ` its own notification ledger (${sequenceReason || 'reason not recorded'}). This message is real;`
      + ' its position in the sequence is not. Do not use it to judge whether an earlier'
      + ' notification went missing, and do not assume the ledger is intact.');
  } else if (previous) {
    lines.push('');
    lines.push(`_Previous: **#${previous.seq}**, sent ${String(previous.sentAt).slice(0, 10)}`
      + `${previous.issue ? ` (issue #${previous.issue})` : ''}. **If you did not receive #${previous.seq}, a notification was lost** —`
      + ' that is what these numbers are for._');
  } else {
    lines.push('');
    lines.push('_This is the first notification the office has sent. There is no previous one to check against._');
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  if (!items.length) {
    lines.push('## Nothing needs your attention');
    lines.push('');
    lines.push('This is the **weekly heartbeat**. It is sent whether or not there is anything to report,'
      + ' and that is the entire reason it exists:');
    lines.push('');
    lines.push('> A quiet week and a broken channel used to look identical. They no longer do —'
      + ' **a quiet week still sends this message.** If a week passes and you get nothing at all,'
      + ' the channel is broken, not quiet.');
    lines.push('');
    lines.push('No submissions are awaiting your decision and no question has gone unanswered long enough to escalate.');
  } else {
    lines.push('## What needs you');
    lines.push('');
    for (const it of items) {
      lines.push(`### ${it.id} — ${it.title}`);
      if (it.age) lines.push(`*${it.age}*`);
      lines.push('');
      if (it.did) lines.push(`- **What we did:** ${it.did}`);
      if (it.recommend) lines.push(`- **What we recommend:** ${it.recommend}`);
      if (it.decision) lines.push(`- **Decision needed:** ${it.decision}`);
      if (it.fallback) lines.push(`- **If no answer comes:** ${it.fallback}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('### How to reply');
  lines.push('');
  lines.push('**In the repo, not in this issue.** One channel, one history — git already gives the office'
    + ' an ordered, permanent record of who said what and when, and a second thread in an issue tracker'
    + ' would split it.');
  lines.push('');
  lines.push('- **To decide a submission:** edit `channel/to-owner/SUBMISSIONS.md`, fill the entry\'s'
    + ' `Decision:` field and add your date. The office marks the heading; it never deletes the entry.');
  lines.push('- **To answer a question:** edit `channel/to-owner/OPEN-QUESTIONS.md` the same way.');
  lines.push('- **To tell the office to do something:** add a file to `channel/from-owner/` named'
    + ' `YYYY-MM-DD-short-slug.md`. The contract — including the four words `kind:` accepts — is in'
    + ' `channel/from-owner/README.md`. **An instruction there outranks everything on the office\'s board.**');
  lines.push('');
  lines.push('_Filed automatically by the office. Closing this issue changes nothing —'
    + ' the office reads the repo, not the tracker._');

  return lines.join('\n');
}

export function buildIssueTitle({ seq, kind, items, today }) {
  const n = seq === null ? '?' : seq;
  if (!items.length) return `[Office #${n}] Weekly heartbeat — nothing needs you (${today})`;
  const escalated = items.filter((i) => /ESCALATED/.test(i.age || '')).length;
  return `[Office #${n}] ${items.length} awaiting your decision${escalated ? ` — ${escalated} ESCALATED` : ''} (${today})`;
}

/* ──────────────────────────────── Sending ─────────────────────────────── */

/**
 * Decides whether to notify, composes it, sends it through the injected
 * `postIssue`, and RECORDS the outcome either way.
 *
 * `postIssue` is injected rather than imported so this module stays pure and
 * the verifier can prove the refusal paths, the sequence rendering and the
 * failure recording without a network stack. The real implementation is
 * `agent-runner.js`'s `fileGitHubIssue()`, which already carries the
 * permission-guard redirect and the token-follows-the-repo rule — this module
 * deliberately reimplements none of that.
 *
 * @param {object}   env
 * @param {object}   deps            { postIssue(env, {title, body, labels}) }
 * @param {object}   input           { items, today, isHeartbeatDay, force }
 */
export async function notifyOwner(env, deps, { items = [], today, isHeartbeatDay = false, force = false } = {}) {
  if (!force && !(await ownerChannelEnabled(env))) {
    return { sent: false, skipped: true, reason: 'owner_channel_disabled' };
  }

  // Nothing to say and not the heartbeat day: SKIP, and this is the one skip in
  // the module that is not a failure. The heartbeat is what makes this silence
  // safe — without it, "we had nothing to say" would be indistinguishable from
  // "we could not send", which is the exact property that disqualified email.
  if (!items.length && !isHeartbeatDay) {
    return { sent: false, skipped: true, reason: 'nothing_to_report_and_not_heartbeat_day' };
  }

  const kind = items.length ? 'submission' : 'heartbeat';
  const { seq, previous, reason: sequenceReason } = await nextSequence(env);
  const title = buildIssueTitle({ seq, kind, items, today });
  const body = buildIssueBody({ seq, previous, sequenceReason, kind, items, today });

  let res;
  try {
    res = await deps.postIssue(env, { title, body, labels: [OWNER_ISSUE_LABEL] });
  } catch (err) {
    res = { created: false, status: 0, reason: `threw: ${err?.message || err}` };
  }

  const ok = !!res?.created;
  await recordNotifyAttempt(env, {
    seq, kind, title, ok,
    status: res?.status,
    detail: ok ? null : (res?.reason || `HTTP ${res?.status ?? 'no response'}`),
    issueNumber: res?.number ?? null,
  });

  if (!ok) {
    // LOUD. This string is what reaches the daily report and every agent prompt.
    console.error(`[owner-notify] NOTIFICATION #${seq ?? '?'} TO THE OWNER FAILED — ${res?.reason || `HTTP ${res?.status}`}. `
      + 'The office believes it has NOT reached him. This is recorded in owner_notifications and is not a silent failure.');
  }

  return { sent: ok, skipped: false, seq, kind, title, status: res?.status, reason: ok ? null : (res?.reason || `HTTP ${res?.status}`) };
}

/**
 * Turns parsed submissions and aged questions into notification items.
 *
 * ── WHAT REACHES HIM, AND WHY IT IS NOT EVERYTHING ──────────────────────
 *
 * A8: *"The owner receives finished work, not questions."* So an OPEN
 * SUBMISSION always goes — it is finished work with a recommendation, which is
 * precisely what he agreed to receive. An open QUESTION goes only once it has
 * climbed to OVERDUE or above, because a fresh question is the office's problem
 * and it already carries a fallback that keeps the work moving.
 *
 * This is the ONE place the channel decides what is worth a person's attention,
 * so the rule is written here in full rather than spread across two callers.
 *
 * `issueReadback` (2026-08-11, Phase 1.2) is
 * `owner-channel.js`'s `classifyOwnerIssueReadback()` output — a PREVIOUS
 * notification of ours (`[Office #N]`) that got no reply. It follows the
 * same "only once it climbs the ladder" rule as a question, for the same
 * reason: a fresh Issue is expected to sit for a day or two, and repeating
 * it immediately would be noise, not escalation.
 *
 * ── `refusedMessages` (2026-08-23) — AND WHY IT DOES NOT WAIT FOR A RUNG ──
 *
 * `office-context.js`'s `snapshot.owner.malformed`: files the owner put in
 * `channel/from-owner/` that `parseOwnerMessage()` could not read. Until today
 * a refusal was surfaced only INSIDE agent prompts, where it sat visible for
 * six days and no agent acted on it — correctly, because no agent has any
 * action available for it: `channel/from-owner/README.md` reserves changes in
 * that folder to the owner. The office was talking to the wrong person.
 *
 * These go in the notification IMMEDIATELY, with no age ladder, and that is the
 * one place this function departs from the rule above. A fresh question is the
 * office's own problem and carries a fallback that keeps work moving. A refused
 * message has no fallback that can exist — the office does not know what it
 * says. Waiting three days to mention that the client's own words are
 * unreadable would be the graveyard A8 names, at the one point in the channel
 * where the office cannot work around the silence.
 */
export function selectNotificationItems({
  submissions = [], questions = [], issueReadback = [], refusedMessages = [],
} = {}) {
  const items = [];

  // FIRST in the list, deliberately. Everything else here is work the office
  // did and is showing him; this is work he asked for that never started.
  for (const refusal of refusedMessages) {
    const reason = String(refusal || '').trim();
    if (!reason) continue;
    // `parseOwnerMessage()` and `fetchBackOfficeFile()` both compose their
    // reasons as `<filename>: <why>`. Split on the FIRST colon only; the why
    // half contains colons of its own.
    const sep = reason.indexOf(':');
    const filename = sep === -1 ? reason : reason.slice(0, sep).trim();
    const why = sep === -1 ? reason : reason.slice(sep + 1).trim();
    items.push({
      id: `from-owner/${filename}`,
      title: 'A MESSAGE YOU WROTE COULD NOT BE READ BY THE OFFICE',
      age: 'REFUSED AT INTAKE — no age ladder: the office cannot work around a message it cannot read',
      did: 'Nothing on it. The office has never seen what this file says — it was refused at the door,'
        + ' so its contents reached no agent, no meeting and no report.',
      recommend: 'Re-file it in a form the office accepts. It will not rename or move your file itself:'
        + ' the office never writes into `channel/from-owner/`, and editing the client\'s own words to suit'
        + ' our parser is not a thing it is allowed to do.',
      decision: `Why it was refused — ${why}.`
        + ' ACCEPTED FORM: a single `.md` file at the TOP LEVEL of `channel/from-owner/` (never in a'
        + ' subdirectory — nothing inside one is ever listed), named `YYYY-MM-DD-short-slug.md` OR'
        + ' `DD-MM-YYYY-short-slug.md` (both work; the slug is lower-case letters, digits and hyphens).'
        + ' A front-matter header is OPTIONAL — a file without one is read as `kind: instruction`.',
      fallback: 'None is possible. The message stays unread and this line repeats in every notification'
        + ' until the file is readable. There is no assumption the office can safely make about what you asked for.',
    });
  }

  for (const s of submissions) {
    if (!s.open) continue;
    items.push({
      id: s.id,
      title: s.title,
      age: s.escalation ? `${s.escalation.rung}${s.escalation.days === null ? ' — submission date unreadable' : ` — ${s.escalation.days} day(s) unanswered`}` : null,
      did: s.did,
      recommend: s.recommend,
      decision: s.decision,
      fallback: s.fallback,
    });
  }

  for (const q of questions) {
    if (!q.open || !q.escalation?.inNotification) continue;
    items.push({
      id: q.id,
      title: q.question,
      age: `${q.escalation.rung}${q.escalation.days === null ? ' — date unreadable' : ` — ${q.escalation.days} day(s) unanswered`}`,
      did: null,
      recommend: null,
      decision: q.need ? `${q.need} — blocking: ${q.blocking || 'unstated'}` : (q.blocking || null),
      fallback: q.escalation.takeFallback
        ? `ALREADY TAKEN (14+ days, per the age ladder — the entry stays OPEN and keeps being asked): ${q.fallback}`
        : q.fallback,
    });
  }

  for (const ir of issueReadback) {
    if (ir.hasReply || !ir.escalation?.inNotification) continue;
    items.push({
      id: `Issue #${ir.number}`,
      title: ir.title,
      age: `${ir.escalation.rung}${ir.escalation.days === null ? ' — open date unreadable' : ` — ${ir.escalation.days} day(s) unanswered`}`,
      did: 'This is a previous notification of ours (a GitHub Issue) that has had no reply — no comment, and it has not been closed.',
      recommend: null,
      decision: 'Same as it originally asked — repeated here because it is now overdue, not because anything changed.',
      fallback: ir.escalation.takeFallback
        ? 'ALREADY TAKEN (14+ days, per the age ladder): the Issue stays open and keeps being surfaced until it gets a reply.'
        : null,
    });
  }

  return items;
}
