/**
 * workers/architect-liaison.js
 *
 * Recognises a headless Architect (Agent 10) midnight run as a real office
 * session, filing it into D1 `reports` (attributed to agent_id 10) so the
 * agents' own context and the meeting engine can see it happened — instead
 * of the run being invisible to everything the office reads, an anomaly
 * rather than a session.
 *
 * INERT BY DEFAULT, and DELIBERATELY STRICTER than this repo's existing
 * "gated no-op" pattern (compare guidesEnabled()/processGuideDraftBlock()
 * in agent-runner.js, where the gated function IS entered every tick and
 * returns early). Here the gate is checked ONLY at the call site
 * (agent-runner.js's block dispatch, `block.type === 'architect_liaison'`)
 * — when SIM_KV simulation-state `architect_liaison_enabled` is not
 * exactly `true`, processArchitectLiaisonBlock() below is never invoked at
 * all. Not entered, not short-circuited internally, not reachable by any
 * path this file exposes. This module exports no way to run the fetch/file
 * logic that does not go through that one caller-supplied boolean.
 *
 * Why stricter, stated because it is a deliberate departure from precedent
 * already in this codebase: the 2026-08-06 guard-correction in this
 * project's CLAUDE.md ("documentation asserts a guard, the calling path
 * never reaches it") has now happened three times, and the fix each time
 * was to make the gate's absence provable, not just claimed. Default off
 * behind a claimed check is exactly the shape that failed twice before.
 * See PERSONA.md's `wears:` entry for this module, and the written test
 * procedure this build session hands the owner, for how to read the proof
 * back rather than take this comment's word for it.
 *
 * Reads the Architect's SESSION RECORD from the private back-office-AI-agents
 * repo via the GitHub Contents API — GET only, never a write, never any
 * other verb. Schema is defined ONCE, on the writer's side, and this module
 * points at it rather than restating the shape:
 *   back-office-AI-agents/campus/agents/10-the-architect/automation/SESSION-RECORD-CONTRACT.md
 *
 * KNOWN GAP, flagged not fixed: this reuses BACKOFFICE_REPO_TOKEN, which
 * `permission-guard.js`'s REPO_TO_TOKEN_SECRET scopes for WRITES to
 * back-office-AI-agents. Used here for GET requests only (verified by
 * reading this file — no PUT/POST/DELETE call exists in it), but a
 * dedicated read-only token would be the tighter design. Minting a new
 * secret is outside an inert build's scope; left for the owner alongside
 * the rest of this module's activation decision.
 */

const BACKOFFICE_REPO_OWNER = 'avivnofar';
const BACKOFFICE_REPO_NAME = 'back-office-AI-agents';
const SESSION_RECORD_DIR = 'campus/agents/10-the-architect/runs';
const ARCHITECT_AGENT_ID = 10;
const GITHUB_HEADERS_BASE = {
  'User-Agent': 'data-center-agent-sim',
  Accept: 'application/vnd.github+json',
};

/**
 * The off-switch. Takes the ALREADY-RESOLVED simulation-state object
 * (agent-runner.js's own getSimulationState(env) result for this tick) so
 * this module never does its own SIM_KV read — one read per tick, done
 * once by the caller, not duplicated here. Also avoids a circular import:
 * agent-runner.js imports THIS file for its block dispatch, so this file
 * must not import getSimulationState back from agent-runner.js.
 */
export function architectLiaisonEnabled(sim) {
  return sim?.architect_liaison_enabled === true;
}

/**
 * Lists SESSION_RECORD_DIR via the GitHub Contents API and returns the
 * lexicographically latest `*-session-record.json` entry's name, or null
 * if the directory is empty/missing/unreadable. The stamp format
 * (yyyy-MM-dd-HHmm) sorts correctly as a plain string, so "latest name"
 * is "latest run" without parsing every filename.
 */
async function listLatestSessionRecordName(env) {
  const url = `https://api.github.com/repos/${BACKOFFICE_REPO_OWNER}/${BACKOFFICE_REPO_NAME}/contents/${SESSION_RECORD_DIR}`;
  const res = await fetch(url, {
    headers: { ...GITHUB_HEADERS_BASE, Authorization: `Bearer ${env.BACKOFFICE_REPO_TOKEN}` },
  });
  if (!res.ok) return { name: null, reason: `contents API list failed: HTTP ${res.status}` };
  const entries = await res.json().catch(() => null);
  if (!Array.isArray(entries)) return { name: null, reason: 'contents API did not return a directory listing' };
  const names = entries
    .filter((e) => e.type === 'file' && /-session-record\.json$/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (!names.length) return { name: null, reason: 'no *-session-record.json files present' };
  return { name: names[names.length - 1], reason: null };
}

/**
 * Fetches and parses one session-record.json by filename. Returns
 * { record, reason }: record is null and reason is set on any failure —
 * bad HTTP status, non-UTF8/non-base64 content, invalid JSON, or a
 * schema_version this module does not understand (refuse rather than
 * guess, same posture as run-controller.js's corrupt-state handling).
 */
async function fetchSessionRecord(env, fileName) {
  const url = `https://api.github.com/repos/${BACKOFFICE_REPO_OWNER}/${BACKOFFICE_REPO_NAME}/contents/${SESSION_RECORD_DIR}/${fileName}`;
  const res = await fetch(url, {
    headers: { ...GITHUB_HEADERS_BASE, Authorization: `Bearer ${env.BACKOFFICE_REPO_TOKEN}` },
  });
  if (!res.ok) return { record: null, reason: `contents API fetch failed for ${fileName}: HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  if (!body?.content) return { record: null, reason: `${fileName}: no content field in API response` };
  let text;
  try {
    text = atob(body.content.replace(/\n/g, ''));
  } catch (err) {
    return { record: null, reason: `${fileName}: base64 decode failed — ${err.message}` };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    return { record: null, reason: `${fileName}: JSON parse failed — ${err.message}` };
  }
  if (record.schema_version !== 1) {
    return { record: null, reason: `${fileName}: schema_version ${record.schema_version} is not the 1 this module understands — refusing rather than guessing` };
  }
  return { record, reason: null };
}

/**
 * Files one D1 `reports` row for a session record, keyed deterministically
 * on the record's own stamp so a repeated tick (record unchanged since the
 * last successful file) is a no-op via INSERT OR IGNORE rather than a
 * duplicate row — idempotent without a separate existence check.
 */
async function fileSessionReport(env, record) {
  if (!env.DB) return { filed: false, reason: 'no DB binding' };
  const id = `architect-session-${record.stamp}`;
  const title = `Architect session — ${record.date} (${record.outcome})`;
  const content = record.summary || '(no summary provided in session record)';
  const { meta } = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (id, agent_id, type, title, content, severity, event_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ARCHITECT_AGENT_ID, 'architect_session', title, content, 'info', 'architect_liaison').run();
  const inserted = (meta?.changes ?? 0) > 0;
  return { filed: inserted, id, reason: inserted ? null : 'already filed (idempotent no-op)' };
}

/**
 * The liaison's actual work. NOT gated internally — see this file's header.
 * The caller (agent-runner.js's block dispatch) must have already checked
 * architectLiaisonEnabled(sim) before calling this. Never throws; every
 * failure path returns { filed: false, reason } for the caller's
 * cycle.results bookkeeping and logScheduledError's catch, same contract
 * as the guide_* blocks.
 */
export async function processArchitectLiaisonBlock(env) {
  if (!env.BACKOFFICE_REPO_TOKEN) {
    return { filed: false, reason: 'BACKOFFICE_REPO_TOKEN not configured on this Worker' };
  }
  const listed = await listLatestSessionRecordName(env);
  if (!listed.name) return { filed: false, reason: listed.reason };

  const fetched = await fetchSessionRecord(env, listed.name);
  if (!fetched.record) return { filed: false, reason: fetched.reason };

  return fileSessionReport(env, fetched.record);
}
