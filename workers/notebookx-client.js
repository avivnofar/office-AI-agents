/**
 * Data Center — AI Agent Simulation — Notebook-X client.
 *
 * Thin REST client for Notebook-X's Render-hosted knowledge-notebook API
 * (config/ai-tools.json notebook_x). Queried by agent-base.js
 * interactWithApp() before an agent escalates a case to Claude, for cases
 * whose platform maps to a seeded notebook (kb-linux, kb-1com — see
 * ai-tools.json case_platform_map). No API key: the live OpenAPI spec
 * defines no securitySchemes on any endpoint.
 *
 * Status: as of 2026-07-09, Notebook-X's Render env was given a new GitHub
 * token — verified live via a real create/upload/read/cleanup round-trip
 * (independently confirmed via `gh api` against avivnofar/Notebook-X, not
 * just Notebook-X's own success responses). GET /api/health still reports
 * `githubConnected:false` — that field is stale/unreliable (looks like it
 * reflects local Render disk state, which resets on redeploy, not the
 * actual GitHub connection) and should not be trusted; GET
 * /api/knowledge-notebooks and the write endpoints below are the real
 * signal. Separately, `POST /api/knowledge-notebooks/{id}/ask` was 500ing
 * because Notebook-X's own backend called a deprecated Gemini model
 * (`gemini-2.5-flash`, retired by Google) — fixed same day in
 * Notebook-X's `notebook_backend.py` (`GEMINI_MODEL` constant switched to
 * `gemini-3.1-flash-lite`, confirmed live end-to-end with a real kb-linux
 * ask returning a real answer). This repo's own Gemini calls
 * (config/simulation-config.json, config/agents-config.json,
 * config/token-economy.json, agent-base.js/meeting-engine.js fallback
 * defaults) were pinned to the same retired model and were fixed in the
 * same session — see TOKEN-BUDGET.md.
 */

const NOTEBOOKX_API_BASE = 'https://notebook-x-api.onrender.com';

/**
 * @param {object} opts
 * @param {string} opts.kbSlug - e.g. "kb-linux", "kb-1com"
 * @param {string} opts.question - the case query to ask the notebook
 * @returns {Promise<{text: string, source: 'notebook-x'}|null>} null on
 *   network failure, non-2xx response, or an empty answer — callers should
 *   treat this as "no reference material found" and proceed to their normal
 *   escalation path, not as an error to surface.
 */
export async function queryNotebookX({ kbSlug, question }) {
  if (!kbSlug || !question) return null;

  let res;
  try {
    res = await fetch(`${NOTEBOOKX_API_BASE}/api/knowledge-notebooks/${encodeURIComponent(kbSlug)}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
  } catch (err) {
    console.warn(`[notebook-x] request failed for ${kbSlug}: ${err.message}`);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[notebook-x] API error (${res.status}) for ${kbSlug}: ${errText.slice(0, 300)}`);
    return null;
  }

  const data = await res.json().catch(() => null);
  const text = (data?.answer || data?.response || data?.text || '').trim();
  return text ? { text, source: 'notebook-x' } : null;
}

/**
 * GET /api/knowledge-notebooks — the curated GitHub-backed listing (real
 * signal; see the module comment on why GET /api/health is NOT). Used by
 * the daily automation's content-health pass. Returns [] on any failure
 * rather than throwing — this is a read-only check, never fatal to a
 * caller.
 */
export async function listKnowledgeNotebooks() {
  try {
    const res = await fetch(`${NOTEBOOKX_API_BASE}/api/knowledge-notebooks`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return Array.isArray(data?.notebooks) ? data.notebooks : [];
  } catch (err) {
    console.warn(`[notebook-x] listKnowledgeNotebooks failed: ${err.message}`);
    return [];
  }
}

/**
 * POST /api/admin/ingest-content-files — scans Notebook-X's own Render
 * filesystem for `{notebook-id}-content.json` fragments (repo root or
 * notebooks/) and merges each into its matching existing knowledge
 * notebook via normalize_notebook() (GitHub read -> merge -> GitHub
 * write -> public-index update). Requires the fragment file to already
 * be present on Notebook-X's deployed filesystem — i.e. pushed to
 * avivnofar/Notebook-X's repo root *and* Render redeployed — before
 * calling this; see notebook-x-daily.mjs for the full sequence.
 */
export async function triggerIngestContentFiles() {
  try {
    const res = await fetch(`${NOTEBOOKX_API_BASE}/api/admin/ingest-content-files`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: data || (await res.text().catch(() => '')) };
    }
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * GET /api/health — kept for logging only. Per the module comment above,
 * `githubConnected`/`notebookCount` here are unreliable (look like local
 * Render-disk state, which resets on redeploy) — do not gate any decision
 * on this response, it's diagnostic context only.
 */
export async function getNotebookXHealth() {
  try {
    const res = await fetch(`${NOTEBOOKX_API_BASE}/api/health`);
    return await res.json().catch(() => null);
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Poll GET /api/health until Notebook-X responds, instead of a single fixed
 * sleep after a push. Found necessary 2026-07-10: a real run pushed content
 * successfully then called ingest-content-files after a blind 60s sleep and
 * got a 502 — independently confirmed the target notebook never actually
 * updated (not a false-negative error), consistent with Render's free-tier
 * cold start taking longer than 60s. A fixed sleep can't adapt to that; this
 * polls instead, with a timeout generous enough for a genuinely cold
 * instance rather than just a bigger fixed number (same fragile pattern with
 * a higher ceiling).
 *
 * IMPORTANT CAVEAT: a fast /api/health response proves the Render instance
 * is up and answering requests. It does NOT prove the specific redeploy
 * containing the just-pushed commit has finished building and is what's
 * currently serving — Notebook-X exposes no deploy-status/commit-SHA
 * endpoint to check that directly. So this narrows the failure mode (dead
 * service) but doesn't eliminate "warm old build, new build still cooking";
 * that residual case is why the caller should retry the ingest call itself
 * too, not just gate once on this.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=300000] - overall budget (default 5min)
 * @param {number} [opts.intervalMs=12000] - delay between polls
 * @returns {Promise<{warm: boolean, attempts: number, elapsedMs: number}>}
 */
export async function waitForNotebookXWarm({ timeoutMs = 300_000, intervalMs = 12_000 } = {}) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    const health = await getNotebookXHealth();
    if (health && !health.error && health.status) {
      return { warm: true, attempts, elapsedMs: Date.now() - start, health };
    }
    if (Date.now() - start + intervalMs >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { warm: false, attempts, elapsedMs: Date.now() - start };
}

/**
 * Call ingest-content-files, retrying on failure (a cold/still-building
 * instance can 502 even after /api/health looks warm — see
 * waitForNotebookXWarm's caveat), then INDEPENDENTLY confirm the target
 * notebook's dataQuality/updatedAt actually changed via a fresh
 * listKnowledgeNotebooks() read. Do not trust the endpoint's own {ok:true}
 * response as proof of success — 2026-07-09's session established that
 * standard (verified kb-voip-sip via a direct GitHub read after a manual
 * ingest) and the point of this function is to make that same standard the
 * automation's own default, not a manual follow-up step.
 *
 * Distinguishes three outcomes on purpose, per the incident this was built
 * for: "the service was cold" (retries resolve it), "ingest is genuinely
 * broken" (retries exhaust, still failing) and "ingest claims success but
 * nothing changed" (a different, real bug — a silent no-op merge — that
 * must not be reported the same as either of the above).
 *
 * @param {string} targetNotebookId - e.g. "kb-mirtapbx"
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=180000] - overall retry budget (3min)
 * @param {number} [opts.intervalMs=15000] - delay between ingest attempts
 * @returns {Promise<{outcome: string, verified: boolean, attempts: number, before: object|null, after: object|null, lastResult: object|null}>}
 */
export async function ingestAndVerify(targetNotebookId, { timeoutMs = 180_000, intervalMs = 15_000 } = {}) {
  const beforeList = await listKnowledgeNotebooks();
  const before = beforeList.find((n) => n.id === targetNotebookId) || null;

  const start = Date.now();
  let attempts = 0;
  let lastResult = null;
  let targetFileResult = null;
  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    lastResult = await triggerIngestContentFiles();
    // ingest-content-files processes ALL pending fragments in one batch and
    // its top-level {ok:true} only means the request itself was accepted —
    // NOT that our specific notebook's merge succeeded. Confirmed
    // 2026-07-10 against real stranded content: the endpoint returned
    // {status:"ok", results:[...]} while kb-mirtapbx's own entry inside
    // `results` had status:"error" ("GitHub GET notebooks/kb-mirtapbx.json:
    // HTTP 502" — a transient GitHub API read failure inside Notebook-X's
    // own merge step), because other notebooks in the same batch succeeded.
    // Must check the target's own per-file result, not the batch status.
    targetFileResult = lastResult?.results?.find((r) => r.id === targetNotebookId) || null;
    if (lastResult.ok && targetFileResult?.status === 'ok') break;
    if (Date.now() - start + intervalMs >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (!lastResult?.ok || targetFileResult?.status !== 'ok') {
    return { outcome: 'ingest-failed', verified: false, attempts, before, after: null, lastResult, targetFileResult };
  }

  // The ingest endpoint's per-file "ok" already reports the merge happened,
  // but confirmed 2026-07-10 that an immediate listKnowledgeNotebooks() call
  // right after a successful ingest can race a listing-endpoint refresh and
  // return nothing for the target notebook (transient, not a real absence —
  // the notebook obviously still exists). Give the listing a few short
  // retries of its own before concluding verification failed.
  let after = null;
  for (let i = 0; i < 4; i += 1) {
    const afterList = await listKnowledgeNotebooks();
    after = afterList.find((n) => n.id === targetNotebookId) || null;
    if (after) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const changed = !!after && (after.dataQuality !== before?.dataQuality || after.updatedAt !== before?.updatedAt);

  if (changed) {
    return { outcome: 'ingested-verified', verified: true, attempts, before, after, lastResult, targetFileResult };
  }
  return { outcome: 'ingest-reported-ok-but-unverified', verified: false, attempts, before, after, lastResult, targetFileResult };
}
