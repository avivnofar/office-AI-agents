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
export function checkCodeWriteAllowed(permissions, { filePath, explicitCodeTask = false }) {
  if (!isCodeFilePath(filePath)) return { allowed: true };

  if (explicitCodeTask) return { allowed: true };
  const reason = `Blocked: "${filePath}" is a code file and the triggering task was not an explicit code-writing instruction (General rule: agents research/investigate/recommend/write files but don't write code files unless directly instructed).`;
  console.warn(`[permission-guard] ${reason}`);
  return { allowed: false, reason };
}

const PULL_LOG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pull_log (
  date TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  last_pulled_at TIMESTAMP
)`;

/**
 * Enforces "max 1 pull/day, repo-wide" (General rule, applies regardless
 * of project-permissions push state). No-ops (allows, logs a warning) if
 * env.DB isn't available — same graceful-no-op pattern this repo already
 * uses for other optional bindings (GITHUB_TOKEN, etc.).
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
