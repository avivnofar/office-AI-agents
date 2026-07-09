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
 * (`gemini-2.5-flash-lite`, retired by Google) — fixed same day in
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
