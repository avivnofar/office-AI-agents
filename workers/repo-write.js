/**
 * workers/repo-write.js — THE one place a repo write is performed.
 *
 * Created 2026-08-07. Nothing here is new logic: this file is the maps and
 * the write function LIFTED OUT of agent-runner.js, unchanged, so that a
 * second module can perform a governed write without either importing
 * agent-runner.js (circular — agent-runner imports meeting-engine.js) or
 * hand-rolling its own request.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────
 *
 * CLAUDE.md and plan item 0.3 both state that resolveRepoWrite() is "the
 * single entry point for every repo write". As of 2026-08-07 that was FALSE,
 * and the counter-example was meeting-engine.js's commitMeetingReport(),
 * which built its own request:
 *
 *     Authorization: `Bearer ${env.GITHUB_TOKEN}`   // meeting-engine.js:585
 *
 * against hardcoded REPO_OWNER/REPO_NAME constants, having never consulted
 * the guard. Every meeting report the office has ever filed went out that
 * way.
 *
 * ── WHY IT WAS NOT AN INCIDENT, AND WHY THAT IS THE POINT ────────────────
 *
 * Nothing was mis-written. The hardcoded token (GITHUB_TOKEN) is in fact the
 * correct credential for the hardcoded destination (the public repo), so the
 * outcome was right every time. It was right because two constants sitting
 * four hundred lines apart happened to agree — not because any rule compared
 * them. That is this project's own recorded corollary, verbatim:
 *
 *     TWO MECHANISMS AGREEING BY ACCIDENT IS NOT A GUARD.
 *
 * A scenario that passes for the wrong reason keeps passing right up until
 * the coincidence breaks. Here the break was already scheduled: the meeting
 * engine's action_items consumer (plan 0.3 / DECISION-PIPELINE.md) writes to
 * BACK-OFFICE. Adding that second destination into a file whose existing
 * write path hardcodes the PUBLIC repo's token is precisely the credential
 * over-reach decision 0.8 exists to prevent — a private target handed a
 * public-repo write credential.
 *
 * So the fix landed BEFORE the new caller, not after it.
 *
 * ── THE RULE THIS FILE ENFORCES BY CONSTRUCTION ──────────────────────────
 *
 * No module outside this one may build a GitHub write request. If you are
 * about to write `Authorization: Bearer` next to a PUT or POST, import
 * commitFileToRepo() instead. Reads are NOT governed by this — the guard
 * decides writes, and architect-liaison.js's GET-only Contents API calls are
 * deliberately left alone (that module flags its own token reuse as a known
 * gap, which is a different question from this one).
 */

import projectPermissions from '../config/project-permissions.json';
import { resolveRepoWrite } from './permission-guard.js';

export const REPO_OWNER = 'avivnofar';
export const REPO_NAME = 'office-AI-agents';
export const BACKOFFICE_REPO_NAME = 'back-office-AI-agents';
export const WAREHOUSE_REPO_NAME = 'warehouse-office-AI-agents';

// Maps GitHub repo names to config/project-permissions.json keys, so every
// write can enforce push permission per the General rule for EVERY repo it
// might target, including this one. REPO_NAME is deliberately included, not
// exempted — self-repo writes are gated by the real "office-agents" entry
// (push:true, currently) like any other project, not by a hardcoded bypass.
// back-office / warehouse mapped 2026-08-06 (plan item 0.3). Both keys
// already existed in project-permissions.json with push:true; what was
// missing was this lookup, and its absence did NOT fail closed — see
// resolveRepoWrite()'s header in permission-guard.js.
export const REPO_TO_PROJECT_KEY = {
  [REPO_NAME]: 'office-agents',
  [BACKOFFICE_REPO_NAME]: 'back-office',
  [WAREHOUSE_REPO_NAME]: 'warehouse',
};

// ONE SCOPED TOKEN PER WRITE TARGET (plan decision 0.8), made enforceable
// rather than merely documented. The token follows the repo; there is no
// fallback and no default. A repo whose secret is unmapped or unset is a
// DENIAL — see resolveRepoWrite() step 4.
//
// WAREHOUSE_REPO_TOKEN is mapped but NOT SET on the Worker, deliberately —
// the second lock on the warehouse code-write exception. No session may set
// it to make a test pass (plan 4.1, owner action).
export const REPO_TO_TOKEN_SECRET = {
  [REPO_NAME]: 'GITHUB_TOKEN',
  [BACKOFFICE_REPO_NAME]: 'BACKOFFICE_REPO_TOKEN',
  [WAREHOUSE_REPO_NAME]: 'WAREHOUSE_REPO_TOKEN',
};

/** Secret NAMES to booleans. Never carries a token value — resolveRepoWrite()
 * decides on presence alone, so no secret reaches the guard or a log line. */
export function secretsPresentIn(env) {
  const out = {};
  for (const name of Object.values(REPO_TO_TOKEN_SECRET)) out[name] = !!env?.[name];
  return out;
}

/**
 * Commits a file to a repo via the GitHub Contents API.
 *
 * EVERY decision is delegated to resolveRepoWrite() (permission-guard.js) —
 * this function contains no permission logic of its own, deliberately, so
 * there is exactly one place where a write can be allowed and one dry-run
 * verifier scenario table covering it. It enforces, in order:
 *   1. Unmapped repo name -> DENIED. Not skipped. (Fixed 2026-08-06; this
 *      was the fail-open hole — see resolveRepoWrite()'s header.)
 *   2. push:false -> redirected into REPO_NAME under agent-output/<key>/
 *      rather than dropped (agents may recommend / write-to-own-repo).
 *   3. Code-file writes blocked unless `opts.explicitCodeTask` is true OR
 *      the DESTINATION project carries code_write:true (warehouse only).
 *   4. The token FOLLOWS THE REPO — GITHUB_TOKEN for the public repo,
 *      BACKOFFICE_REPO_TOKEN for back-office. No fallback: an unmapped or
 *      unset secret is a denial, never a borrow of another target's token.
 */
export async function commitFileToRepo(env, repoName, path, content, message, opts = {}) {
  const verdict = resolveRepoWrite(projectPermissions, {
    repoToProjectKey: REPO_TO_PROJECT_KEY,
    repoToTokenSecret: REPO_TO_TOKEN_SECRET,
    ownRepoName: REPO_NAME,
    targetRepoName: repoName,
    path,
    explicitCodeTask: opts.explicitCodeTask,
    secretsPresent: secretsPresentIn(env),
  });
  if (!verdict.allowed) {
    return { committed: false, reason: verdict.reason, blocked: verdict.blocked };
  }

  repoName = verdict.repoName;
  path = verdict.path;
  if (verdict.redirected) message = `${message} [redirected: push disabled for "${verdict.projectKey}"]`;

  const headers = {
    Authorization: `Bearer ${env[verdict.tokenSecret]}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };
  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/contents/${path}`;

  // Updating an existing file requires its current blob sha.
  let sha;
  const existing = await fetch(url, { headers }).catch(() => null);
  if (existing?.ok) {
    const data = await existing.json().catch(() => null);
    sha = data?.sha;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: btoa(unescape(encodeURIComponent(content))), ...(sha ? { sha } : {}) }),
  });
  return { committed: res.ok, status: res.status, path };
}
