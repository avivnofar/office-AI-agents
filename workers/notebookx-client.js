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
 * Status: DRAFT — as of 2026-07-01 Notebook-X's own GitHub-backed storage
 * is disconnected (GET /api/health -> githubConnected:false, 0 notebooks),
 * so real calls currently fail with a 401 from Notebook-X's backend. This
 * client treats that (and any other failure) as best-effort: return null,
 * caller falls through to normal Claude-escalation logic.
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
