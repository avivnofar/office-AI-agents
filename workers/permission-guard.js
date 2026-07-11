/**
 * Shared enforcement for the office-wide "General" agent-conduct rules
 * (TODO.md's General section) and the manually maintained
 * config/project-permissions.json push/pull model.
 *
 * Pure decision logic only — no fetch/GitHub API calls live here, so this
 * stays importable by both the Worker (agent-runner.js, bundled by
 * wrangler/esbuild) and Node tooling.
 */

import projectPermissions from '../config/project-permissions.json';

const CODE_FILE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.sh', '.ps1', '.psm1', '.sql',
]);

/**
 * True if `push` is enabled for `projectKey` in project-permissions.json.
 * Unknown keys default to false (deny) — fail closed.
 */
export function canPushToProject(projectKey) {
  return projectPermissions[projectKey]?.push === true;
}

/**
 * Decides where a write actually lands. If push is disabled for
 * `projectKey`, the write is redirected into office-AI-agents' own repo
 * under agent-output/<projectKey>/ rather than being silently dropped —
 * per the General rule, push:false means "recommend/write-to-own-repo
 * only", not "do nothing".
 */
export function resolveWriteTarget({ projectKey, ownRepoName, targetRepoName, path }) {
  if (canPushToProject(projectKey)) {
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
export function resolveIssueTarget({ projectKey, ownRepoName, targetRepoName, title, body }) {
  if (canPushToProject(projectKey)) {
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
 * Two independent checks, per the 2026-07-11 model-scoped code_write
 * decision (config/project-permissions.json `code_write` — see its _meta
 * for the full reasoning):
 *
 *   - If `model` is given, the acting model's global code_write policy
 *     (`code_write.<model>`) governs: `true` allows unconditionally,
 *     `"per-change-only"` allows only when `explicitCodeTask` is also set
 *     for this specific call, `false` (or an unrecognized model) blocks —
 *     fail closed.
 *   - If `model` is omitted (legacy call sites that don't track an acting
 *     model), falls back to the original explicitCodeTask-only rule.
 */
export function checkCodeWriteAllowed({ filePath, model, explicitCodeTask = false }) {
  if (!isCodeFilePath(filePath)) return { allowed: true };

  if (model) {
    const policy = projectPermissions.code_write?.[model];
    if (policy === true) return { allowed: true };
    if (policy === 'per-change-only' && explicitCodeTask) return { allowed: true };

    const reason = policy === 'per-change-only'
      ? `Blocked: "${filePath}" is a code file and model "${model}" is authorized for code-write only per-change (config/project-permissions.json code_write.${model} === "per-change-only"), but this call did not carry an explicit per-change authorization (explicitCodeTask).`
      : `Blocked: "${filePath}" is a code file and model "${model}" is not authorized to write code (config/project-permissions.json code_write.${model} is ${JSON.stringify(policy) ?? 'undefined — unrecognized model, fail closed'}).`;
    console.warn(`[permission-guard] ${reason}`);
    return { allowed: false, reason };
  }

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
