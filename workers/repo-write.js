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

// `with { type: 'json' }` added 2026-08-10 — the same fix permission-guard.js
// already carries an explanatory header for (see that file's 2026-07-12
// note): a bare JSON import here made this module unimportable by plain
// `node` (ERR_IMPORT_ATTRIBUTE_MISSING on current Node), which is why every
// verifier that needed this file's logic tested it by reading its SOURCE
// TEXT instead of calling it (verify-security-scan.js, verify-report-
// pipeline.js). scripts/verify-learning-loop.js is the first verifier that
// needs to actually CALL commitFileToRepo(), so the gap became worth
// closing rather than working around a fourth time. Wrangler/esbuild accept
// the attribute the same as a bare import — proven by `wrangler deploy
// --dry-run` in the same session this was added, not merely assumed.
import projectPermissions from '../config/project-permissions.json' with { type: 'json' };
import { resolveRepoWrite } from './permission-guard.js';
import { scanOutbound, renderScanRefusal } from './security-scan.js';

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
// ~~WAREHOUSE_REPO_TOKEN is mapped but NOT SET on the Worker, deliberately —
// the second lock on the warehouse code-write exception. No session may set
// it to make a test pass (plan 4.1, owner action).~~
//
// CORRECTED 2026-08-16 (appended, A15 — the sentence above is kept as the
// record of what was true until 2026-08-11). **THE OWNER SET
// WAREHOUSE_REPO_TOKEN HIMSELF ON 2026-08-11**, which is his to do and was
// never the thing the rule forbade — the rule was that no SESSION may set it
// to make a test pass, and that still stands. Verified by reading the live
// secret list off the Worker on 2026-08-16: the secret is present.
//
// **The second lock is therefore OPEN, and only the code rule remains.** That
// is the load-bearing consequence and it was still being denied in five places
// across this repo five days later, this comment among them. A permission
// claim that has stopped being true is the most expensive kind of stale
// documentation, because a reader checking whether a path is safe finds a
// stated impossibility and stops looking.
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
 * THE REPO-WRITE RECORD — OB-038, built 2026-08-10.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────
 *
 * `reports/weekly/week-07-report.md` published *"office-AI-agents: Nothing
 * moved"* in a period with 61 commits, 5 guides, 5 gap digests and the report
 * itself landing in that repo. `validateReportBody()`'s consistency check
 * exists precisely to refuse that sentence — and it was not weak. It was given
 * no fact that credited `office-AI-agents` with anything, because every fact in
 * the pack was indexed on THE SYSTEM ASKED (data-center, notebook-x) and never
 * on THE REPOSITORY WRITTEN TO. **A check can only be as good as the axis its
 * input is indexed on.**
 *
 * commitFileToRepo() returned `{ committed, status, path }` and every caller
 * consumed it transiently — a log line, a summary string. Nothing persisted.
 * §7.2 exactly: a value produced at the right moment, by the right component,
 * for the right reason, and consumed by nobody.
 *
 * ── WHY A SEPARATE TABLE AND NOT A `reports` ROW ─────────────────────────
 *
 * `reports` is documents the office authored; a write is an EVENT about where a
 * document went. Putting writes in `reports` would make "how many reports did we
 * file" and "how many files did we push" the same query shape, and every
 * existing `reports` consumer would start seeing rows it was never written for.
 * The `type` / `event_type` separation exists for this reason and this is the
 * same call one level out.
 *
 * Created LAZILY and deliberately NOT added to database/schema.sql — the same
 * decision task-router.js's PROVIDER_USAGE_TABLE_SQL took, for the same reason:
 * a new table that only one module writes does not need a migration step a
 * deployer can forget, and CREATE TABLE IF NOT EXISTS on every write costs one
 * cheap statement.
 *
 * ── THE HARD REQUIREMENT: THIS MAY NEVER COST A WRITE ────────────────────
 *
 * This sits on the live path that files gap digests, guides and reports. It runs
 * AFTER the PUT has already happened, it cannot throw, nothing branches on what
 * it returns, and it does not appear in commitFileToRepo()'s return value — so a
 * broken recorder degrades to the exact behaviour this module had before it
 * existed. A failed record is a lost measurement; a failed write is lost work,
 * and the two are not comparable.
 */
export const REPO_WRITE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS repo_writes (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  project_key TEXT,
  path TEXT NOT NULL,
  committed INTEGER NOT NULL,
  status INTEGER,
  redirected INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/*
 * ── `mechanism` (session 36, Item C) ──────────────────────────────────────
 *
 * Session 36 found that `repo_writes` — the one queryable, structured record
 * of an office write — had no field saying WHICH office mechanism produced a
 * given warehouse/channel artifact. Attribution existed only as free text in
 * each call site's own commit message ("office: Agent 7 build artifact for
 * OB-103"), which is readable by a human scrolling git log but not
 * queryable, and not distinguishable from a session hand-writing the same
 * message convention into a commit made outside the Worker entirely.
 *
 * This is the smallest fix: one nullable column, populated ONLY by the
 * office's build-chain / own-build mechanisms (`processArchitectSpecBlock`,
 * `processBuildNotesBlock`, `processBuildArtifactBlock`, `processRepairBlock`
 * in agent-runner.js) via `opts.mechanism` on `commitFileToRepo()`. Every
 * other call site is unaffected and keeps writing `mechanism: null` — this
 * is deliberately NOT a general audit of all ~40 commitFileToRepo() sites.
 * Shape is free text, `"<block>:agent<N>:<provider>"`, matching the existing
 * commit-message convention rather than inventing a second taxonomy.
 *
 * Retrofitted onto a table that already exists in production, so
 * `CREATE TABLE IF NOT EXISTS` above does not add it to the live table (same
 * caveat CLAUDE.md documents for `cases.project` and `guide_pipeline`'s
 * siblings) — see this session's own manual `ALTER TABLE` migration note.
 * `ADD COLUMN` is attempted here too, wrapped so an already-migrated table
 * (or a brand-new one where the CREATE above already included it) does not
 * throw.
 */
async function ensureMechanismColumn(env) {
  try {
    await env.DB.prepare('ALTER TABLE repo_writes ADD COLUMN mechanism TEXT').run();
  } catch (err) {
    // Already present — the expected steady-state outcome, not a failure.
    if (!/duplicate column/i.test(err?.message || '')) {
      console.warn(`[repo-write] mechanism column migration check: ${err?.message || err}`);
    }
  }
}

export async function recordRepoWrite(env, { repo, projectKey, path, committed, status, redirected, mechanism }) {
  try {
    if (!env?.DB) return { recorded: false, reason: 'no_db_binding' };
    await env.DB.prepare(REPO_WRITE_TABLE_SQL).run();
    await ensureMechanismColumn(env);
    await env.DB.prepare(
      `INSERT INTO repo_writes (id, repo, project_key, path, committed, status, redirected, mechanism)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), repo, projectKey || null, path, committed ? 1 : 0, status ?? null, redirected ? 1 : 0, mechanism || null).run();
    return { recorded: true };
  } catch (err) {
    // Swallowed on purpose. Same posture recordOfficeEvent() takes: a capture
    // failure must not cost the thing being captured.
    console.warn(`[repo-write] could not record the write of ${path} to ${repo}, continuing: ${err?.message || err}`);
    return { recorded: false, reason: 'record_error' };
  }
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
 *
 * ── BINARY CONTENT (opts.contentIsBase64, added 2026-08-10) ───────────────
 *
 * The Designer's image lane produces PNG bytes, and this function's encoder is
 * `btoa(unescape(encodeURIComponent(content)))` — correct for text and
 * CORRUPTING for bytes. So a caller holding an already-base64 payload passes
 * `contentIsBase64: true` and the encode step is skipped. It is a flag on the
 * ONE write function rather than a second write function, because a second one
 * is how a repo ends up with a write path that never learned about the
 * permission guard (see this file's own header).
 *
 * **A binary write to the PUBLIC repo is refused.** Not because of permissions —
 * `office-agents` has `push: true` — but because A10's pre-publication security
 * scan is a TEXT scan, and base64 is not text it can read. Letting a binary
 * through would mean the one write path that reaches the public internet had an
 * exemption from the scan that A10 says is "automatic and never judgment", and
 * the exemption would be invisible: the write would succeed and the scan would
 * report `scanned: false`. Refusing is the only option that does not quietly
 * create the hole. Assets therefore live in back-office (which A10 does not
 * scan, by design), and putting an image on the public Front is the publishing
 * gate's decision — board `OB-014`, not yet built.
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

  /*
   * ── A10: THE PRE-PUBLICATION SECURITY SCAN ─────────────────────────────
   *
   * Placed HERE and not one line earlier, deliberately: `verdict` may have
   * REDIRECTED the write into this repo under agent-output/, so the path that
   * matters is the resolved one. Scanning the requested path would let a
   * redirected write reach the public repo unscanned — the guard's own
   * fail-open shape, reproduced inside the check meant to close it.
   *
   * Scoped to REPO_NAME because that is the PUBLIC repo. back-office is where
   * A10 says findings live; scanning it would refuse the very destination the
   * refusal points at, which is a loop with no exit.
   *
   * REFUSES. Not warns. A10 is explicit that this is automatic and never
   * judgment, so there is no override flag and no `opts.force` — adding one
   * would put the judgment back in exactly the place A10 removed it from.
   * Runs BEFORE the PUT: a scan after the write has published the content and
   * is then commenting on it.
   */
  if (repoName === REPO_NAME && opts.contentIsBase64) {
    // See the header. A base64 payload is not text scanOutbound() can read, so
    // allowing it here would give the public write path a silent exemption from
    // the one control A10 says is never a judgment call.
    const reason = `binary_write_to_public_repo_refused: "${path}" is base64 content bound for ${REPO_NAME}, and A10's pre-publication scan is a TEXT scan that cannot read it. Refused rather than passed through unscanned. Assets belong in back-office; publishing one to the Front is the publishing gate's decision (OB-014).`;
    console.warn(`[repo-write] ${reason}`);
    await recordRepoWrite(env, {
      repo: repoName, projectKey: verdict.projectKey, path, committed: false, status: null, redirected: !!verdict.redirected, mechanism: opts.mechanism || null,
    });
    return { committed: false, reason: 'binary_write_to_public_repo_refused', message: reason };
  }

  if (repoName === REPO_NAME) {
    const scanned = scanOutbound(content, { path });
    if (scanned.scanned && !scanned.clean) {
      const reason = renderScanRefusal(path, scanned.hits);
      console.warn(`[repo-write] ${reason}`);
      // Recorded as a NON-committed write so the refusal is countable. A
      // refusal that leaves no row is a control nobody can audit, and A10's
      // whole argument is that unaudited security posture is the problem.
      await recordRepoWrite(env, {
        repo: repoName, projectKey: verdict.projectKey, path, committed: false, status: null, redirected: !!verdict.redirected, mechanism: opts.mechanism || null,
      });
      return { committed: false, reason: 'security_scan_refused', securityHits: scanned.hits, message: reason };
    }
  }

  const headers = {
    Authorization: `Bearer ${env[verdict.tokenSecret]}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };
  const url = `https://api.github.com/repos/${REPO_OWNER}/${repoName}/contents/${path}`;

  /*
   * ── THE SHA, AND WHICH MOMENT IT DESCRIBES (audit #9 / KFM-15) ──────────
   *
   * Updating an existing file requires its current blob sha. Fetching it HERE
   * — at write time — makes every write succeed, which sounds like robustness
   * and is the opposite. GitHub's `sha` field is an optimistic-concurrency
   * token: it means "I am changing the version I read." Re-reading it
   * immediately before the PUT answers "I am changing whatever is there now,"
   * which is not a check at all. Two writers who each read the file, each
   * modify their own copy, and each re-fetch the sha will BOTH succeed, and
   * the second silently discards the first. No error is raised anywhere.
   *
   * `opts.expectedSha` is the fix, and it is opt-in per caller rather than
   * mandatory, deliberately: most callers here write a NEW dated file
   * (reports, digests, guides) where there is nothing to conflict with, and
   * forcing them to supply a sha would add a read they do not need. The
   * callers that matter are the ones doing read-modify-write on a SHARED
   * mutable file — `reports/asset-pipeline/board.json` has two of them — and
   * those now pass the sha they actually read.
   *
   * When supplied, the write-time fetch is SKIPPED entirely, so GitHub
   * compares against the caller's read and answers 409 (or 422) if anything
   * moved in between. A refused write with a conflict status is a good
   * outcome: it is the lost update, surfaced instead of absorbed.
   */
  /*
   * ── opts.branch (session 31, Item E) ─────────────────────────────────────
   * When given, the sha lookup below reads FROM that branch (`?ref=`) rather
   * than the repo's default branch, and the PUT commits TO that branch — so a
   * repair round never reads main's sha and never lands on main by accident.
   * Absent, this is byte-for-byte the pre-existing behaviour (every caller
   * before this session).
   */
  let sha = opts.expectedSha;
  if (!sha) {
    const shaUrl = opts.branch ? `${url}?ref=${encodeURIComponent(opts.branch)}` : url;
    const existing = await fetch(shaUrl, { headers }).catch(() => null);
    if (existing?.ok) {
      const data = await existing.json().catch(() => null);
      sha = data?.sha;
    }
    // NOTE (KFM-13): a FAILED existence check and a genuinely ABSENT file are
    // indistinguishable here — both leave `sha` undefined. The consequence is
    // not a silent overwrite: GitHub refuses an update with no sha (422), so
    // the write fails and `committed: false` is returned and recorded. It is a
    // lost write that is REPORTED, not one that is hidden. Callers doing
    // read-modify-write should pass `expectedSha` and avoid this path.
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      // Text is UTF-8-encoded then base64'd; binary arrives already base64 and
      // must NOT go through that encoder, which would corrupt every byte above
      // 0x7F. See the header's note on opts.contentIsBase64.
      content: opts.contentIsBase64 ? String(content) : btoa(unescape(encodeURIComponent(content))),
      ...(sha ? { sha } : {}),
      ...(opts.branch ? { branch: opts.branch } : {}),
    }),
  });

  // Record the write. Deliberately AFTER the PUT and deliberately not awaited
  // into the return value's shape — see recordRepoWrite()'s header. A DENIED
  // write is not recorded here at all: a denial is a permission decision, not
  // an output, and counting it as one would make `projectsWithOutput()` credit
  // a project the office was refused access to.
  await recordRepoWrite(env, {
    repo: repoName,
    projectKey: verdict.projectKey,
    path,
    committed: res.ok,
    status: res.status,
    redirected: !!verdict.redirected,
    mechanism: opts.mechanism || null,
  });

  // A conflict is NAMED rather than left as a bare status, so a caller that
  // passed `expectedSha` can tell "somebody else wrote this file since I read
  // it" apart from "the write failed". They call for different responses: the
  // first means re-read and re-apply, the second means retry or report.
  const conflict = res.status === 409 || res.status === 422;
  return {
    committed: res.ok,
    status: res.status,
    path,
    ...(conflict ? { conflict: true, reason: 'sha_conflict_or_missing' } : {}),
  };
}

/**
 * Session 31, Item E — creates a branch from the repo's current default
 * branch, if it does not already exist. Goes through the SAME
 * resolveRepoWrite() permission check commitFileToRepo() uses (an unmapped
 * or push:false repo is refused here too, before any git object is touched).
 * The representative path carries no code-file extension, so this call never
 * trips the code-write gate on its own — it creates a branch, not a file.
 *
 * A7's "one active branch per project" is NOT enforced here — this only
 * refuses an unauthorized repo, the same as every other write in this
 * module. Enforcing "one active branch" is the CALLER's responsibility (the
 * repair loop tracks its own branch state), because this function has no
 * shared state with a caller to know what "active" means for it.
 *
 * @returns {Promise<{ok: boolean, created: boolean, sha: string|null, reason: string|null}>}
 */
export async function ensureBranch(env, repoName, branchName) {
  const verdict = resolveRepoWrite(projectPermissions, {
    repoToProjectKey: REPO_TO_PROJECT_KEY,
    repoToTokenSecret: REPO_TO_TOKEN_SECRET,
    ownRepoName: REPO_NAME,
    targetRepoName: repoName,
    path: `_branch_check/${branchName}`,
    secretsPresent: secretsPresentIn(env),
  });
  if (!verdict.allowed) return { ok: false, created: false, sha: null, reason: verdict.reason };

  repoName = verdict.repoName;
  const headers = {
    Authorization: `Bearer ${env[verdict.tokenSecret]}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };

  const existingRef = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${repoName}/git/ref/heads/${encodeURIComponent(branchName)}`,
    { headers }
  ).catch(() => null);
  if (existingRef?.ok) {
    const data = await existingRef.json().catch(() => null);
    return { ok: true, created: false, sha: data?.object?.sha || null, reason: null };
  }

  const repoInfo = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${repoName}`, { headers }).catch(() => null);
  const repoData = repoInfo?.ok ? await repoInfo.json().catch(() => null) : null;
  const defaultBranch = repoData?.default_branch || 'main';

  const baseRef = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${repoName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    { headers }
  ).catch(() => null);
  if (!baseRef?.ok) {
    return { ok: false, created: false, sha: null, reason: `could not read ${defaultBranch}'s ref (HTTP ${baseRef?.status ?? 'network error'})` };
  }
  const baseData = await baseRef.json().catch(() => null);
  const baseSha = baseData?.object?.sha;
  if (!baseSha) return { ok: false, created: false, sha: null, reason: `${defaultBranch}'s ref carried no sha` };

  const created = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${repoName}/git/refs`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    }
  ).catch(() => null);
  if (!created?.ok) {
    const body = created ? await created.text().catch(() => '') : '';
    return { ok: false, created: false, sha: null, reason: `branch creation failed (HTTP ${created?.status ?? 'network error'}): ${body.slice(0, 300)}` };
  }
  return { ok: true, created: true, sha: baseSha, reason: null };
}

/**
 * Session 31, Item E, ADDENDUM — the Architect's merge step. CLEAN MERGES
 * ONLY: a 409/conflict from GitHub is returned as-is, never retried, never
 * resolved, never forced. No `--force`, no history rewrite, no deleting the
 * branch to route around a failure — if it does not go cleanly by ordinary
 * means, it does not go, and the branch is left exactly as it was for a
 * human to look at. Verified LIVE 2026-08-28: a real branch, a real commit
 * on it, and a real clean merge via this exact API shape, read back from the
 * remote afterward (`git pull`) rather than trusted from the HTTP status
 * alone.
 *
 * Goes through the SAME resolveRepoWrite() permission check as every other
 * write here.
 *
 * @returns {Promise<{merged: boolean, sha: string|null, conflict: boolean, reason: string|null, status: number|null}>}
 */
export async function mergeBranchToMain(env, repoName, branchName, message) {
  const verdict = resolveRepoWrite(projectPermissions, {
    repoToProjectKey: REPO_TO_PROJECT_KEY,
    repoToTokenSecret: REPO_TO_TOKEN_SECRET,
    ownRepoName: REPO_NAME,
    targetRepoName: repoName,
    path: `_merge_check/${branchName}`,
    secretsPresent: secretsPresentIn(env),
  });
  if (!verdict.allowed) return { merged: false, sha: null, conflict: false, reason: verdict.reason, status: null };

  repoName = verdict.repoName;
  const headers = {
    Authorization: `Bearer ${env[verdict.tokenSecret]}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };

  const repoInfo = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${repoName}`, { headers }).catch(() => null);
  const repoData = repoInfo?.ok ? await repoInfo.json().catch(() => null) : null;
  const base = repoData?.default_branch || 'main';

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${repoName}/merges`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, head: branchName, commit_message: message }),
    }
  ).catch((err) => ({ ok: false, status: 0, _err: err?.message }));

  if (res.status === 204) {
    // Already up to date — head carries nothing base does not already have.
    // Not a failure, and not a real merge either.
    return { merged: false, sha: null, conflict: false, reason: 'already_up_to_date', status: 204 };
  }
  if (res.status === 409) {
    const body = await res.text().catch(() => '');
    return { merged: false, sha: null, conflict: true, reason: `merge conflict (HTTP 409): ${body.slice(0, 500)}`, status: 409 };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { merged: false, sha: null, conflict: false, reason: `merge failed (HTTP ${res.status}): ${body.slice(0, 500)}`, status: res.status };
  }
  const data = await res.json().catch(() => null);
  return { merged: true, sha: data?.sha || null, conflict: false, reason: null, status: res.status };
}
