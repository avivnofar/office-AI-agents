/**
 * workers/context-editor.js — THE WRITE HALF OF THE LEARNING LOOP.
 *
 * OFFICE-POLICY.md A2/A3. Built 2026-08-10 in response to the capability audit's
 * finding (docs/CAPABILITY-TOOLBOX.md, `active-context-amendment` / `agent-journal`):
 * NO CODE PATH WROTE `active-context.md` OR `journal.md`. Twelve agents had a
 * journal none of them had ever written in; the Team Lead's whole product —
 * conclusions reaching the character files before the next day opens — had
 * nowhere to land. This module is that landing.
 *
 * `workers/office-policy.js`'s header claims A3 "already has its own code" —
 * that was wrong the same day it was written. This module, `probation.js` and
 * `probation-review.js` are the code that claim refers to.
 *
 * ── THE THREE LAYERS, AND WHO MAY TOUCH EACH (A2) ──────────────────────────
 *
 *   active-context.md   QA (6) and Team Lead (7) write it, for OTHER agents
 *                        only. Curated, ~8KB-capped, feeds every prompt.
 *   journal.md           The agent's own free writing. Append-only. Never
 *                        fed into a prompt, so no cap and no review gate.
 *   adaptations/<t>.md   The agent itself, or a reviewer. Append only —
 *                        never deletion.
 *
 * ── GATED, LIKE EVERY OTHER 2026-08 ADDITION ───────────────────────────────
 *
 * `learningLoopEnabled()` mirrors `guides_enabled` / `routing_enabled` /
 * `improvement_loop_enabled` exactly: default OFF, flip without redeploy via
 * `POST /api/agents/trigger {"type":"learning_loop_toggle","enabled":true}`.
 * Every exported write function checks it first and returns `{written:false,
 * reason:'learning_loop_disabled'}` rather than touching the network.
 */

import { commitFileToRepo, BACKOFFICE_REPO_NAME } from './repo-write.js';

export const SIM_STATE_KEY = 'simulation-state';
export const LEARNING_LOOP_FLAG = 'learning_loop_enabled';

export async function learningLoopEnabled(env) {
  if (!env?.SIM_KV) return false;
  const stored = await env.SIM_KV.get(SIM_STATE_KEY, 'json').catch(() => null);
  return stored?.[LEARNING_LOOP_FLAG] === true;
}

/**
 * campus/agents/<slug>/ — hardcoded rather than derived from
 * config/agents-config.json's `name`, because the folder names are not a pure
 * kebab-case of the persona name ("06-the-qa", not "06-the-q-a";
 * "03-the-standard-agent" carries the word "agent" that the config name
 * doesn't). A derived slug that happened to be wrong would 404 silently
 * different from a write that never attempted — see fetchBackOfficeText()'s
 * error shape below.
 */
export const AGENT_SLUGS = Object.freeze({
  1: '01-the-perfectionist',
  2: '02-the-productive',
  3: '03-the-standard-agent',
  4: '04-the-trainee',
  5: '05-the-it-chief',
  6: '06-the-qa',
  7: '07-the-team-lead',
  8: '08-the-lead-qa',
  9: '09-the-designer',
  10: '10-the-architect',
  11: '11-the-ceo',
  12: '12-the-workflow',
  13: '13-the-cyber-expert',
});

/** Only these two may amend ANOTHER agent's active-context.md (A2). */
export const ACTIVE_CONTEXT_REVIEWERS = Object.freeze({
  6: { kind: 'QA-approved', label: 'QA-approved (work quality)' },
  7: { kind: 'Team-Lead-approved', label: 'Team-Lead-approved (persona)' },
});

/** ~8KB. The file feeds the prompt; every byte is paid for on every call. */
export const ACTIVE_CONTEXT_CAP_BYTES = 8 * 1024;

export function agentPath(agentId, file) {
  const slug = AGENT_SLUGS[agentId];
  if (!slug) return null;
  return `campus/agents/${slug}/${file}`;
}

const byteLen = (s) => new TextEncoder().encode(s).length;

/* ─────────────────────────── GitHub Contents API ─────────────────────────── */

/**
 * Reads one back-office file as text. Same shape as office-context.js's
 * (unexported) fetchBackOfficeFile() — duplicated rather than imported so this
 * module has no dependency on office-context.js's cache/snapshot machinery,
 * which is built around a 30-minute TTL that a write path must not inherit: a
 * write has to see the CURRENT file, not a cached one up to 30 minutes stale,
 * or two amendments landing in the same window could silently clobber each
 * other's sha.
 */
async function fetchBackOfficeText(env, path) {
  const url = `https://api.github.com/repos/avivnofar/${BACKOFFICE_REPO_NAME}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.BACKOFFICE_REPO_TOKEN}`,
    },
  }).catch((err) => ({ ok: false, status: 0, _err: err?.message }));

  if (!res?.ok) return { text: null, reason: `GET ${path} failed: HTTP ${res?.status ?? 'network error'}` };
  const body = await res.json().catch(() => null);
  if (!body?.content) return { text: null, reason: `${path}: no content field in Contents API response` };
  try {
    return { text: decodeURIComponent(escape(atob(body.content.replace(/\n/g, '')))), reason: null };
  } catch (err) {
    return { text: null, reason: `${path}: base64/UTF-8 decode failed — ${err.message}` };
  }
}

/* ──────────────────────────── active-context.md ──────────────────────────── */

const ENTRY_HEADING = /^### (\d{4}-\d{2}-\d{2}) — (.+)$/;
const APPROVED_SECTION_RE = /^## Approved conclusions\s*$/m;
const NONE_YET_RE = /^\*None yet\.\*.*$/m;

/**
 * Splits the "## Approved conclusions" section into discrete dated entries.
 * An entry is everything from one "### <date> — <kind>" heading to the next
 * (or end of section). Returns entries in FILE ORDER, which this module
 * always treats as chronological (oldest first, newest appended at the
 * bottom) — see writeActiveContextAmendment()'s append step.
 */
export function parseApprovedEntries(fileText) {
  const secMatch = APPROVED_SECTION_RE.exec(fileText);
  if (!secMatch) return { ok: false, reason: '"## Approved conclusions" heading not found' };
  const sectionStart = secMatch.index + secMatch[0].length;
  const rest = fileText.slice(sectionStart);
  const nextHeading = rest.search(/^## /m);
  const sectionBody = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const afterSection = nextHeading === -1 ? '' : rest.slice(nextHeading);

  const lines = sectionBody.split('\n');
  const entries = [];
  let current = null;
  for (const line of lines) {
    const h = ENTRY_HEADING.exec(line);
    if (h) {
      if (current) entries.push(current);
      current = { date: h[1], kind: h[2].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push(current);

  const rendered = entries.map((e) => ({ ...e, text: e.lines.join('\n').replace(/\n+$/, '') }));
  return {
    ok: true,
    before: fileText.slice(0, sectionStart),
    entries: rendered,
    after: afterSection,
  };
}

function renderApprovedSection(before, entries, after) {
  const body = entries.length
    ? entries.map((e) => e.text).join('\n\n')
    : '*None yet.*';
  const sep = after && !after.startsWith('\n') ? '\n' : '';
  return `${before}\n${body}\n${sep}${after}`.replace(/\n{3,}/g, '\n\n\n');
}

/**
 * Writes one approved conclusion into ANOTHER agent's active-context.md.
 *
 * Refuses (A2, hard rule — never a default):
 *   - actor is not 6 (QA) or 7 (Team Lead)
 *   - actor === targetAgentId (no agent modifies its own active context)
 *   - target has no known folder
 *   - the flag is off, or the write is denied by resolveRepoWrite()
 *
 * Rolls the OLDEST approved entries off into journal.md once the file exceeds
 * ACTIVE_CONTEXT_CAP_BYTES — the file feeds the prompt, so the cap is real and
 * not advisory.
 *
 * @param {object} env
 * @param {{actorId:number, targetAgentId:number, content:string, date?:string}} r
 */
export async function writeActiveContextAmendment(env, { actorId, targetAgentId, content, date }) {
  if (!(await learningLoopEnabled(env))) return { written: false, reason: 'learning_loop_disabled' };

  const reviewer = ACTIVE_CONTEXT_REVIEWERS[actorId];
  if (!reviewer) {
    return { written: false, reason: `actor ${actorId} may not amend active context — only the QA (6) and the Team Lead (7) may (A2)` };
  }
  if (actorId === targetAgentId) {
    return { written: false, reason: 'no agent modifies its own active context (A2) — the QA/Team Lead change OTHER agents\' context only' };
  }
  const path = agentPath(targetAgentId, 'active-context.md');
  if (!path) return { written: false, reason: `agent ${targetAgentId} has no known campus folder` };
  if (typeof content !== 'string' || !content.trim()) {
    return { written: false, reason: 'content must be a non-empty string' };
  }

  const read = await fetchBackOfficeText(env, path);
  if (read.text === null) return { written: false, reason: read.reason };

  const parsed = parseApprovedEntries(read.text);
  if (!parsed.ok) return { written: false, reason: parsed.reason };

  const stamp = date || new Date().toISOString().slice(0, 10);
  const newEntry = {
    date: stamp,
    kind: reviewer.label,
    text: `### ${stamp} — ${reviewer.label}\n\n${content.trim()}`,
  };
  // Drop the seeded "*None yet.*" placeholder — it is not a real entry and
  // parseApprovedEntries() never produces one for it, but a hand-written file
  // could still carry it as stray prose in `before`/`after`. Nothing here
  // strips it outside the section boundary; renderApprovedSection() only ever
  // emits it when `entries` is empty, so once one real entry exists it cannot
  // reappear.
  const entries = [...parsed.entries, newEntry];

  const rolledToJournal = [];
  let rendered = renderApprovedSection(parsed.before, entries, parsed.after);
  while (byteLen(rendered) > ACTIVE_CONTEXT_CAP_BYTES && entries.length > 1) {
    const oldest = entries.shift();
    rolledToJournal.push(oldest);
    rendered = renderApprovedSection(parsed.before, entries, parsed.after);
  }

  const commitMsg = `active-context: ${reviewer.label} conclusion for agent ${targetAgentId} (${AGENT_SLUGS[targetAgentId]})`
    + (rolledToJournal.length ? ` — rolled ${rolledToJournal.length} oldest entr${rolledToJournal.length === 1 ? 'y' : 'ies'} to journal.md (8KB cap)` : '');
  const commit = await commitFileToRepo(env, BACKOFFICE_REPO_NAME, path, rendered, commitMsg);
  if (!commit.committed) {
    return { written: false, reason: `commit refused: ${commit.reason || commit.status}` };
  }

  // Roll-off writes to journal.md AFTER the active-context commit succeeds —
  // an entry that rolled off is by definition one that was already live and
  // approved; failing to archive it loses history (A15) but must never be
  // allowed to block or undo the active-context write that already happened.
  let journalWrite = null;
  if (rolledToJournal.length) {
    const archiveText = rolledToJournal
      .map((e) => `${e.text}\n\n_(rolled off active-context.md — 8KB cap — on ${stamp})_`)
      .join('\n\n---\n\n');
    journalWrite = await writeJournalEntry(env, {
      actorId: 'system:rolloff',
      agentId: targetAgentId,
      content: archiveText,
      _bypassSelfCheck: true,
    });
  }

  return {
    written: true,
    kind: reviewer.kind,
    path,
    committed: commit,
    entryText: newEntry.text,
    rolledToJournal: rolledToJournal.map((e) => e.text),
    journalWrite,
  };
}

/**
 * Removes one exact entry (by its previously-rendered `entryText`) from a
 * target agent's active-context.md — the DROP half of A3's probation
 * decision. If the entry already rolled off into journal.md before the
 * decision landed, this is a correct no-op on the file: journal.md "never
 * feeds a prompt" (its own header), so an entry that rolled off has already
 * stopped affecting anything the agent sees, which is what "dropped" means in
 * effect. journal.md itself is never edited to remove it — A15, nothing is
 * ever deleted, and the journal's own contract is "never edited by anyone
 * else."
 */
export async function removeActiveContextEntry(env, { actorId, targetAgentId, entryText }) {
  if (!(await learningLoopEnabled(env))) return { written: false, reason: 'learning_loop_disabled' };
  const reviewer = ACTIVE_CONTEXT_REVIEWERS[actorId];
  if (!reviewer) {
    return { written: false, reason: `actor ${actorId} may not amend active context — only the QA (6) and the Team Lead (7) may (A2)` };
  }
  const path = agentPath(targetAgentId, 'active-context.md');
  if (!path) return { written: false, reason: `agent ${targetAgentId} has no known campus folder` };

  const read = await fetchBackOfficeText(env, path);
  if (read.text === null) return { written: false, reason: read.reason };
  const parsed = parseApprovedEntries(read.text);
  if (!parsed.ok) return { written: false, reason: parsed.reason };

  const before = parsed.entries.length;
  const remaining = parsed.entries.filter((e) => e.text !== entryText);
  if (remaining.length === before) {
    // Not present — most likely already rolled off. Correct no-op; see header.
    return { written: true, removed: false, reason: 'entry not present in active-context.md — likely already rolled off into journal.md; no live effect to remove' };
  }

  const rendered = renderApprovedSection(parsed.before, remaining, parsed.after);
  const commit = await commitFileToRepo(
    env, BACKOFFICE_REPO_NAME, path, rendered,
    `active-context: probation DROP — removing a provisional conclusion for agent ${targetAgentId} (A3)`
  );
  if (!commit.committed) return { written: false, reason: `commit refused: ${commit.reason || commit.status}` };
  return { written: true, removed: true, path, committed: commit };
}

/* ──────────────────────────────── journal.md ──────────────────────────────── */

/**
 * Appends free writing to an agent's OWN journal.md. Self-write only —
 * `actorId` must equal `agentId` — with one deliberate exception: the roll-off
 * mechanism inside writeActiveContextAmendment() above, which is the WRITE
 * PATH archiving its own output, not a persona choosing to write about
 * itself. That call sets `_bypassSelfCheck: true` and `actorId:
 * 'system:rolloff'` so it is never confusable with a real agent id in a log
 * or a D1 row.
 *
 * Append-only: fetches current content, adds the new entry at the end, writes
 * back. No size cap — journal.md never feeds a prompt (its own header), so
 * growth here costs nothing per call.
 */
export async function writeJournalEntry(env, { actorId, agentId, content, date, _bypassSelfCheck = false }) {
  if (!(await learningLoopEnabled(env))) return { written: false, reason: 'learning_loop_disabled' };
  if (!_bypassSelfCheck && actorId !== agentId) {
    return { written: false, reason: 'an agent writes only its own journal — no reviewer, and no other agent, writes it for them' };
  }
  const path = agentPath(agentId, 'journal.md');
  if (!path) return { written: false, reason: `agent ${agentId} has no known campus folder` };
  if (typeof content !== 'string' || !content.trim()) {
    return { written: false, reason: 'content must be a non-empty string' };
  }

  const read = await fetchBackOfficeText(env, path);
  if (read.text === null) return { written: false, reason: read.reason };

  const stamp = date || new Date().toISOString().slice(0, 10);
  const entry = `\n### ${stamp}\n\n${content.trim()}\n`;
  const appended = read.text.replace(/\s*$/, '') + '\n' + entry;

  const commit = await commitFileToRepo(
    env, BACKOFFICE_REPO_NAME, path, appended,
    `journal: agent ${agentId} (${AGENT_SLUGS[agentId]}) — ${_bypassSelfCheck ? 'active-context roll-off archive' : 'self-entry'}`
  );
  if (!commit.committed) return { written: false, reason: `commit refused: ${commit.reason || commit.status}` };
  return { written: true, path, committed: commit };
}

/* ─────────────────────────────── adaptations/ ─────────────────────────────── */

/**
 * Appends to an agent's adaptations/<topic>.md, per A2: "the agent itself,
 * and reviewers" (6, 7, 8 — the three who run the improvement loop). Creates
 * the topic file if it does not yet exist, in which case it also appends a
 * row to _INDEX.md (adding a row is not deletion; the existing rows are
 * untouched).
 *
 * STRUCTURALLY append-only: this function's only write operation is
 * `current text + separator + new text`. There is no parameter that accepts
 * a full replacement, which is what makes "never deletion" true by
 * construction rather than by convention.
 */
export async function appendAdaptation(env, { actorId, agentId, topic, content, date }) {
  if (!(await learningLoopEnabled(env))) return { written: false, reason: 'learning_loop_disabled' };
  const isSelf = actorId === agentId;
  const isReviewer = [6, 7, 8].includes(actorId);
  if (!isSelf && !isReviewer) {
    return { written: false, reason: 'adaptations may be written by the agent itself, or by a reviewer (6/7/8) — A2' };
  }
  const slug = AGENT_SLUGS[agentId];
  if (!slug) return { written: false, reason: `agent ${agentId} has no known campus folder` };
  if (!topic || !/^[a-z0-9-]+$/.test(topic)) {
    return { written: false, reason: 'topic must be a kebab-case filename stem, e.g. "asking-a-clarifying-follow-up"' };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { written: false, reason: 'content must be a non-empty string' };
  }

  const path = `campus/agents/${slug}/adaptations/${topic}.md`;
  const stamp = date || new Date().toISOString().slice(0, 10);
  const read = await fetchBackOfficeText(env, path);

  let body;
  let isNewFile = false;
  if (read.text === null) {
    isNewFile = true;
    body = `# ${topic.replace(/-/g, ' ')} — Agent ${agentId}\n\n### ${stamp} — ${isSelf ? 'self' : `reviewer ${actorId}`}\n\n${content.trim()}\n`;
  } else {
    body = read.text.replace(/\s*$/, '') + `\n\n---\n\n### ${stamp} — ${isSelf ? 'self' : `reviewer ${actorId}`}\n\n${content.trim()}\n`;
  }

  const commit = await commitFileToRepo(
    env, BACKOFFICE_REPO_NAME, path, body,
    `adaptations: agent ${agentId} (${slug}) — ${topic}${isNewFile ? ' (new)' : ''}`
  );
  if (!commit.committed) return { written: false, reason: `commit refused: ${commit.reason || commit.status}` };

  let indexWrite = null;
  if (isNewFile) {
    const indexPath = `campus/agents/${slug}/adaptations/_INDEX.md`;
    const idxRead = await fetchBackOfficeText(env, indexPath);
    if (idxRead.text !== null) {
      const row = `| [\`${topic}.md\`](${topic}.md) | — | seeded ${stamp} | ${stamp} |`;
      const appendedIdx = idxRead.text.includes('|---|') && !idxRead.text.includes(`${topic}.md`)
        ? idxRead.text.replace(/(\|[-\s|]+\|\s*\n)/, `$1${row}\n`)
        : idxRead.text;
      const idxCommit = await commitFileToRepo(
        env, BACKOFFICE_REPO_NAME, indexPath, appendedIdx,
        `adaptations/_INDEX.md: agent ${agentId} — add ${topic}.md row`
      );
      indexWrite = idxCommit;
    }
  }

  return { written: true, path, committed: commit, isNewFile, indexWrite };
}
