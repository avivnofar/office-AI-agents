/**
 * Shared enforcement for the office-wide "General" agent-conduct rules
 * (TODO.md's General section) and the manually maintained
 * config/project-permissions.json push/pull model.
 *
 * Pure decision logic only — no fetch/GitHub API calls live here, so this
 * stays importable by both the Worker (agent-runner.js, bundled by
 * wrangler/esbuild) and Node tooling.
 *
 * REFACTORED 2026-07-12 (LOW finding from the safety-claim audit): this
 * file used to `import projectPermissions from '../config/project-
 * permissions.json'` at module scope. That needs an import assertion
 * esbuild/Workers accepts but plain `node` rejects
 * (ERR_IMPORT_ASSERTION_TYPE_MISSING), so scripts/verify-permissions.js and
 * notebook-x-daily.mjs (both plain-Node scripts) couldn't import this file
 * directly — each carried its own hand-written mirror of
 * canPushToProject()/resolveWriteTarget()/checkCodeWriteAllowed() instead,
 * three manually-synced copies of the same decision logic with a "keep in
 * sync manually" comment as the only thing holding them together. Every
 * exported function below now takes `permissions` as an explicit first
 * argument instead of reading a module-level import, so this file has NO
 * JSON import of its own and is safe to import from plain Node. Each
 * caller still loads config/project-permissions.json its own way
 * (agent-runner.js via its own esbuild-compatible `import`, the Node
 * scripts via fs.readFileSync + JSON.parse — that split is unavoidable,
 * Workers have no filesystem at runtime) but the actual branching logic —
 * the part that was actually drifting silently — now lives in exactly one
 * place.
 */

// .html/.htm/.css added 2026-07-12, found while consolidating
// notebook-x-daily.mjs's checkCodeWriteAllowedForModel() mirror into a
// direct call to checkCodeWriteAllowed() below: frontend_code_change's
// actual target is index.html (see notebook-x-daily.mjs's targetPath
// default), and this set previously had no markup/style extensions at
// all. Without this, isCodeFilePath('index.html') was false, so
// checkCodeWriteAllowed() would return {allowed: true} immediately and
// skip the model-scoped code_write check entirely for the one file
// frontend_code_change's 2026-07-11 permission-guard wiring was built to
// gate — consolidating onto this function unchanged would have silently
// reintroduced the gap that work closed.
const CODE_FILE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.sh', '.ps1', '.psm1', '.sql',
  '.html', '.htm', '.css',
]);

/**
 * True if `push` is enabled for `projectKey` in project-permissions.json.
 * Unknown keys default to false (deny) — fail closed.
 */
export function canPushToProject(permissions, projectKey) {
  return permissions[projectKey]?.push === true;
}

/**
 * Decides where a write actually lands. If push is disabled for
 * `projectKey`, the write is redirected into office-AI-agents' own repo
 * under agent-output/<projectKey>/ rather than being silently dropped —
 * per the General rule, push:false means "recommend/write-to-own-repo
 * only", not "do nothing".
 */
export function resolveWriteTarget(permissions, { projectKey, ownRepoName, targetRepoName, path }) {
  if (canPushToProject(permissions, projectKey)) {
    return { repoName: targetRepoName, path, projectKey, redirected: false };
  }
  const redirectedPath = `agent-output/${projectKey}/${path}`;
  const reason = `push:false for project "${projectKey}" in config/project-permissions.json — blocked write to ${targetRepoName}/${path}, redirected into ${ownRepoName}/${redirectedPath}`;
  console.warn(`[permission-guard] ${reason}`);
  return { repoName: ownRepoName, path: redirectedPath, projectKey, redirected: true, reason };
}

/**
 * Issue-creation counterpart to resolveWriteTarget(): if push is disabled
 * for `projectKey`, the Issue is redirected into ownRepoName instead of
 * being filed against an external repo the agents aren't allowed to write
 * to (or silently dropped). Mirrors resolveWriteTarget()'s redirect
 * semantics but for GitHub Issues (title/body) rather than file paths —
 * every fileGitHubIssue() call for a non-self repo must run through this
 * before touching the GitHub API, the same way commitFileToRepo() already
 * runs every non-self file write through resolveWriteTarget().
 */
export function resolveIssueTarget(permissions, { projectKey, ownRepoName, targetRepoName, title, body }) {
  if (canPushToProject(permissions, projectKey)) {
    return { repoName: targetRepoName, title, body, projectKey, redirected: false };
  }
  const reason = `push:false for project "${projectKey}" in config/project-permissions.json — blocked Issue creation in ${targetRepoName}, redirected into ${ownRepoName}`;
  console.warn(`[permission-guard] ${reason}`);
  return {
    repoName: ownRepoName,
    title: `[redirected from ${projectKey}] ${title}`,
    body: `${body}\n\n---\n_${reason}_`,
    projectKey,
    redirected: true,
    reason,
  };
}

/** Extension check for the "agents don't write code files unless directly instructed" rule. */
export function isCodeFilePath(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return CODE_FILE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/**
 * Blocks code-file writes unless allowed. Non-code files (reports,
 * markdown, JSON, etc.) always pass this check untouched.
 *
 * Blanket rule (config/project-permissions.json `automated_code_write:
 * false`, 2026-07-18 — see its _meta.code_write_blanket_2026-07-18 for the
 * full reasoning): no agent or automation writes code autonomously,
 * regardless of acting model. The only pass is `explicitCodeTask` — a
 * per-change human authorization carried by this specific call. This
 * replaces the 2026-07-11 model-scoped branch (`code_write.<model>`),
 * whose only consumer (notebook-x-daily.mjs) was deleted the same day.
 */
export function checkCodeWriteAllowed(permissions, { filePath, explicitCodeTask = false, projectKey = undefined }) {
  if (!isCodeFilePath(filePath)) return { allowed: true };

  if (explicitCodeTask) return { allowed: true };

  // Per-project exception, wired 2026-08-06. Until then this function read
  // only the blanket rule and IGNORED the per-project `code_write` field
  // entirely — so `warehouse: { code_write: true }`, the single deliberate
  // exception in the whole repo, was documentation with no enforcement path,
  // and so was `back-office: { code_write: false }`. Neither key was read by
  // any code. `permissions[undefined]` is undefined, so a caller that passes
  // no projectKey lands on the blanket denial exactly as before.
  if (permissions?.[projectKey]?.code_write === true) {
    return { allowed: true, reason: `code_write:true for project "${projectKey}"` };
  }

  const scope = projectKey ? ` for project "${projectKey}" (code_write is not true)` : '';
  const reason = `Blocked: "${filePath}" is a code file and the triggering task was not an explicit code-writing instruction${scope} (General rule: agents research/investigate/recommend/write files but don't write code files unless directly instructed).`;
  console.warn(`[permission-guard] ${reason}`);
  return { allowed: false, reason };
}

/**
 * THE SINGLE ENTRY POINT FOR "may this write happen, where does it land, and
 * which secret pays for it". Added 2026-08-06 to close a FAIL-OPEN hole.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────
 *
 * commitFileToRepo() and fileGitHubIssue() both gated the entire permission
 * check behind a map lookup:
 *
 *     const projectKey = REPO_TO_PROJECT_KEY[repoName];
 *     if (projectKey) { ...resolveWriteTarget()... }   // else: nothing
 *     // ...then wrote to repoName anyway
 *
 * An unmapped repo name did not get denied — it SKIPPED THE CHECK ENTIRELY
 * and the write proceeded unchecked. `unknown_project_key_default` in
 * config/project-permissions.json says "deny (fail closed)", and
 * canPushToProject() does implement exactly that, but for an unmapped repo
 * name it was never reached. The documented safe state was real in the
 * config and absent from the call path.
 *
 * It was LATENT: all 17 commitFileToRepo() call sites passed REPO_NAME,
 * which was mapped, so nothing ever reached the hole. Latent is why there
 * is no damage to clean up. It is not why the documentation was wrong.
 *
 * This is the THIRD time this project has hit the same shape — a guard that
 * exists, documentation asserting the calling path reaches it, and a calling
 * path that does not. See the 2026-07-11/12 incident and the 2026-07-18
 * discovery that checkCodeWriteAllowedForModel() was never wired. The
 * pattern is worth naming: DOCUMENTATION ASSERTS A GUARD, THE CALLING PATH
 * NEVER REACHES IT.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────
 *
 * Resolution is ordered, and every step can only deny:
 *
 *   1. Repo name -> project key. NO KEY IS A DENIAL, never a skip. This is
 *      the step that used to be `if (projectKey)`.
 *   2. resolveWriteTarget() — push:false redirects into ownRepoName rather
 *      than dropping the write, unchanged behaviour.
 *   3. Code-file check against the FINAL destination's key, after any
 *      redirect, because that is the repo the bytes actually land in.
 *   4. Repo name -> token secret name. A repo with no mapped secret, or a
 *      mapped secret that is not configured, is a DENIAL — never a fallback
 *      to whichever token happens to be in scope. This is decision 0.8 (one
 *      scoped token per target) made enforceable: a write to back-office
 *      that silently used GITHUB_TOKEN would hand the campus path a
 *      public-repo write credential.
 *
 * Takes `secretsPresent` — a map of secret NAME to boolean — rather than
 * `env`, so no token value ever enters this module and the whole decision is
 * a pure function a dry-run verifier can call directly.
 *
 * @returns {{allowed: boolean, repoName?: string, path?: string,
 *            projectKey?: string, tokenSecret?: string, redirected?: boolean,
 *            reason?: string, blocked?: string}}
 */
export function resolveRepoWrite(permissions, {
  repoToProjectKey,
  repoToTokenSecret,
  ownRepoName,
  targetRepoName,
  path: filePath,
  explicitCodeTask = false,
  secretsPresent = {},
}) {
  // 1. Unmapped repo name is a denial. This is the fail-open fix.
  const projectKey = repoToProjectKey?.[targetRepoName];
  if (!projectKey) {
    const reason = `no config/project-permissions.json key mapped for repo "${targetRepoName}" — DENIED (fail closed). Add it to REPO_TO_PROJECT_KEY only alongside a real permissions entry and a scoped token secret.`;
    console.warn(`[permission-guard] ${reason}`);
    return { allowed: false, reason, blocked: 'unmapped_repo' };
  }

  // 2. push:false redirects rather than drops.
  const target = resolveWriteTarget(permissions, { projectKey, ownRepoName, targetRepoName, path: filePath });

  // 3. Code-file rule, judged against where the bytes actually land.
  const finalProjectKey = repoToProjectKey?.[target.repoName];
  if (!finalProjectKey) {
    const reason = `redirect destination "${target.repoName}" has no project-permissions key — DENIED (fail closed).`;
    console.warn(`[permission-guard] ${reason}`);
    return { allowed: false, reason, blocked: 'unmapped_redirect_destination' };
  }
  const codeCheck = checkCodeWriteAllowed(permissions, { filePath: target.path, explicitCodeTask, projectKey: finalProjectKey });
  if (!codeCheck.allowed) {
    return { allowed: false, reason: codeCheck.reason, blocked: 'code_write_guard' };
  }

  // 4. The token follows the repo. No fallback, ever.
  const tokenSecret = repoToTokenSecret?.[target.repoName];
  if (!tokenSecret) {
    const reason = `no token secret mapped for repo "${target.repoName}" — DENIED. A write target without its own scoped secret does not borrow another target's token (plan decision 0.8).`;
    console.warn(`[permission-guard] ${reason}`);
    return { allowed: false, reason, blocked: 'no_token_mapped' };
  }
  if (!secretsPresent[tokenSecret]) {
    const reason = `token secret "${tokenSecret}" is not configured on this Worker — DENIED for repo "${target.repoName}". Not a fallback condition: set that secret or the write does not happen.`;
    console.warn(`[permission-guard] ${reason}`);
    return { allowed: false, reason, blocked: 'token_not_configured' };
  }

  return {
    allowed: true,
    repoName: target.repoName,
    path: target.path,
    projectKey: finalProjectKey,
    tokenSecret,
    redirected: target.redirected === true,
    reason: target.reason ?? null,
  };
}

const PULL_LOG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pull_log (
  date TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  last_pulled_at TIMESTAMP
)`;

/**
 * ══════════════════════════════════════════════════════════════════════════
 * RETIRED 2026-08-15 — NOT CALLED, AND THERE IS NOTHING TO CALL IT FROM.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Found by `back-office-AI-agents/tools/gate-call-audit/` on its first real
 * run (OB-001, boarded 2026-08-06 and unbuilt for 40 days): defined, exported,
 * **zero call sites anywhere in the repo**, while three separate documents
 * described the cap as enforced. It is kept rather than deleted, with the
 * reasoning attached, because the third state — a gate that exists, is never
 * called and is never retired — is what let the previous reader assume a
 * protection that was not there.
 *
 * ── WHAT IT WAS BUILT TO PROTECT ─────────────────────────────────────────
 *
 * `config/project-permissions.json`'s `push_semantics`: "Pull (read-only
 * checkout/fetch) is always allowed regardless of push, but capped at 1/day
 * repo-wide." That rule is about **checking out an external project's repo** —
 * a git clone/fetch of somebody else's code.
 *
 * ── WHY IT CANNOT BE WIRED, RATHER THAN MERELY NOT HAVING BEEN ───────────
 *
 * Two independent reasons, and both had to be checked before retiring it:
 *
 * 1. **The Worker never pulls.** It has no git and no filesystem. Its only
 *    repo access is fine-grained GitHub Contents API reads — `office-context.js`
 *    reading `BOARD.md`, `architect-liaison.js` reading session records,
 *    `branch-watch.js:220` listing branches, `repo-write.js:288`'s pre-write
 *    existence check. Those are not checkouts, and capping them at one a day
 *    would stop the office running: `office_context_enabled` alone reads
 *    back-office on every tick. Wiring this gate to them would not be enforcing
 *    the rule; it would be applying a checkout rule to something that is not a
 *    checkout.
 *
 * 2. **The one thing that DOES pull cannot reach this code.** The Architect's
 *    headless midnight run does `git pull` across the three checkouts — that is
 *    the real pull the rule describes. It runs on the owner's machine, in a
 *    different process, with no `env.DB` and no import of this module. It also
 *    already pulls once per night by construction, which satisfies the cap
 *    without any gate at all.
 *
 * So the gate is in the wrong process for the only pull that happens, and the
 * process it lives in does not do the thing it caps. That is a completed
 * question, not an open one.
 *
 * ── WHAT WAS CORRECTED ALONGSIDE THIS ────────────────────────────────────
 *
 * The prose asserting the enforcement (KFM-09) was the actual defect, not the
 * unused function. Three sites, all corrected in the same commit:
 * `config/project-permissions.json` `push_semantics`, `workers/chore-runner.js`,
 * and `database/schema.sql`'s `pull_log` comment.
 *
 * `pull_log` stays in the schema. It has never held a row (nothing has ever
 * called this), dropping it would be the one irreversible act in a retirement
 * that is otherwise fully reversible, and A15's no-deletion posture covers it.
 *
 * **To un-retire:** a real checkout path inside the Worker would have to exist
 * first. If one is ever added, this function is complete and correct as
 * written — call it there and delete this block.
 */
/**
 * @unread-export RETIRED 2026-08-15 by the gate-call audit, deliberately
 *     kept as a tombstone with its un-retirement condition -- see the block
 *     above.
 */
export async function checkAndRecordPull(env, { label = 'pull' } = {}) {
  if (!env?.DB) {
    console.warn(`[permission-guard] No D1 binding — pull-count enforcement skipped for "${label}" (allowed by default).`);
    return { allowed: true, reason: 'no DB binding, enforcement skipped' };
  }

  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(PULL_LOG_TABLE_SQL).run();
  const row = await env.DB.prepare('SELECT count FROM pull_log WHERE date = ?').bind(today).first();

  if (row && row.count >= 1) {
    const reason = `daily pull cap (1/day, repo-wide) already used for ${today}`;
    console.warn(`[permission-guard] Pull blocked for "${label}" — ${reason}.`);
    return { allowed: false, reason };
  }

  if (row) {
    await env.DB.prepare('UPDATE pull_log SET count = count + 1, last_pulled_at = CURRENT_TIMESTAMP WHERE date = ?').bind(today).run();
  } else {
    await env.DB.prepare('INSERT INTO pull_log (date, count, last_pulled_at) VALUES (?, 1, CURRENT_TIMESTAMP)').bind(today).run();
  }
  return { allowed: true };
}
