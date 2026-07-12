// Daily Notebook-X automation: a general content-health pass over the live
// knowledge notebooks, plus one real attempt at the next pending backlog
// item in config/notebook-x-progress.json. See TOKEN-BUDGET.md (2026-07-09
// entries) for the full design writeup and the two blockers (expired
// notebook-x-render token, retired Gemini model string) this automation
// was built around and that are now both fixed.
//
// Write mechanism (confirmed by reading Notebook-X's own notebook_backend.py
// directly, not guessed): Notebook-X's knowledge-notebook system only
// supports the 12 notebooks hardcoded in its own NOTEBOOK_DEFINITIONS list —
// there is no API to create a new custom knowledge-notebook. The safe,
// schema-correct way to add real content to an EXISTING skeleton notebook is
// to push a `{notebook-id}-content.json` knowledgeBase-fragment file to the
// Notebook-X repo root (same shape as the kb-linux-content.json /
// kb-1com-content.json / kb-bash-content.json files already there), wait for
// Render's auto-redeploy to pick it up, then call
// POST /api/admin/ingest-content-files, which merges it into the existing
// GitHub skeleton and updates the public index. This script generates that
// fragment's content itself (via this repo's own model-router, NOT
// Notebook-X's internal Gemini call) so Claude/Groq routing actually applies.
//
// KNOWN GAP: pushing the fragment to avivnofar/Notebook-X (a private repo)
// needs a token scoped to that repo. No such secret exists in this repo's
// GitHub Actions yet (mirrors the still-unprovisioned Notebook-X read token
// flagged in config/health-check-manifest.json). This script looks for
// NOTEBOOK_X_REPO_TOKEN and, if absent, generates the content, stages it
// locally, and stops there with a clear log line — it does NOT mark the
// item done and does NOT silently skip the gap.

import fs from 'node:fs';
import path from 'node:path';
import { callGemini } from '../../workers/gemini-client.js';
import { listKnowledgeNotebooks, getNotebookXHealth, waitForNotebookXWarm, ingestAndVerify } from '../../workers/notebookx-client.js';

// NOT imported from workers/model-router.js: that module does
// `import tokenEconomy from '../config/token-economy.json'` with no import
// assertion, which esbuild (the Cloudflare Worker's bundler) accepts fine
// but Node 20's native ESM loader rejects (ERR_IMPORT_ASSERTION_TYPE_MISSING)
// when run directly via `node script.mjs`, as this script is. Rather than
// add an import assertion to a file shared with the Worker's build (untested
// blast radius on the wrangler/esbuild bundle), this inlines just the one
// branch of selectModelForChoreTask() this script needs — verified against
// workers/model-router.js's actual notebook-x branch on 2026-07-09. Keep in
// sync manually if that function's notebook-x logic ever changes.
function selectModelForChoreTask({ taskType, requiresHighQuality = false, overBudget = false }) {
  if (taskType === 'easy') {
    return { model: 'groq', reason: 'Notebook-X override: groq_scope covers easy sub-tasks (simple formatting, short lookups).' };
  }
  if (requiresHighQuality && !overBudget) {
    return { model: 'claude', reason: 'Notebook-X override: task complexity/quality genuinely demands Claude (drawn from the shared $4.50/mo cap).' };
  }
  if (requiresHighQuality && overBudget) {
    return { model: 'gemini', reason: 'Notebook-X override wanted Claude, but the $4.50/mo chore-automation cap is exhausted this month — falling back to Gemini (default writer).' };
  }
  return { model: 'gemini', reason: 'Notebook-X override: Gemini is the default writer for content generation.' };
}

// NOT imported from workers/permission-guard.js: that module does
// `import projectPermissions from '../config/project-permissions.json'` with
// no import assertion — same ERR_IMPORT_ASSERTION_TYPE_MISSING failure under
// plain `node` as workers/model-router.js's token-economy.json import
// (confirmed live, same as the selectModelForChoreTask() comment above).
// Reads the same file via fs+JSON.parse instead (works under both esbuild
// and native Node) and mirrors checkCodeWriteAllowed()'s model-scoped branch
// exactly, per the 2026-07-11 model-scoped code_write decision (see
// config/project-permissions.json's _meta.code_write_model_scope_2026-07-11).
// Keep in sync manually if that function's model-scoped logic ever changes.
function checkCodeWriteAllowedForModel(filePath, model) {
  const permissions = JSON.parse(fs.readFileSync(PROJECT_PERMISSIONS_PATH, 'utf8'));
  const policy = permissions.code_write?.[model];
  if (policy === true) return { allowed: true };
  const reason = policy === 'per-change-only'
    ? `Blocked: model "${model}" is authorized to write "${filePath}" only per-change (config/project-permissions.json code_write.${model} === "per-change-only") — this automated daily run carries no per-change human authorization for this call.`
    : `Blocked: model "${model}" is not authorized to write code file "${filePath}" (config/project-permissions.json code_write.${model} is ${JSON.stringify(policy) ?? 'undefined — unrecognized model, fail closed'}).`;
  return { allowed: false, reason };
}

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GITHUB_API = 'https://api.github.com';
const NOTEBOOK_X_REPO = 'avivnofar/Notebook-X';
const PROGRESS_PATH = 'config/notebook-x-progress.json';
const PROJECT_PERMISSIONS_PATH = 'config/project-permissions.json';
const STAGING_DIR = 'reports/notebook-x/pending-content';
const DAILY_LOG_PATH = 'reports/notebook-x/daily-log.md';
const HOUSEKEEPING_DIR = 'reports/notebook-x/housekeeping';
const LIVE_NOTEBOOKS_FOR_HEALTH_CHECK = ['kb-linux', 'kb-bash', 'kb-1com'];
const STALE_AFTER_DAYS = 30;
const MAX_INGEST_ATTEMPTS = 3; // per-item cap before leaving it flagged for manual review instead of retrying forever
const MIN_PLAUSIBLE_DIFF_LINES = 3; // frontend_code_change's diff-size floor — see checkDiffPlausible()
const GEMINI_CALL_SPACING_MS = 4000; // stay well under the 15 RPM free-tier ceiling

// housekeeping_codeAssessment's full-file-rewrite safety floor (added
// 2026-07-12, after this function gutted notebook_backend.py from ~2000
// lines to 79 and took Notebook-X production down). A model with a
// realistic ~8K output-token ceiling cannot safely emit a verbatim
// full-file rewrite of anything much bigger than this. Files over this
// size still get reviewed, but only as a text recommendation for a human
// to apply — never an auto-push. See checkFullFileRewritePlausible() and
// housekeeping_codeAssessment() below for the rest of the fix.
const MAX_SAFE_FULL_REWRITE_CHARS = 9000;
const FULL_REWRITE_SHRINK_FLOOR = 0.6; // reject a proposed rewrite under 60% of the original's line count

// Mirrors Notebook-X's own NOTEBOOK_DEFINITIONS (notebook_backend.py),
// confirmed by reading that file directly on 2026-07-09. Duplicated here
// (not fetched live) because reading Notebook-X's GitHub repo requires a
// token this script doesn't have (see the module comment above) — these
// section lists are structural and change rarely, so a static mirror is an
// acceptable, documented trade-off. Update this map if Notebook-X's own
// NOTEBOOK_DEFINITIONS changes for these three notebooks.
const NOTEBOOK_FILL_TARGETS = {
  'kb-voip-sip': {
    name: 'VoIP & SIP Telephony',
    domain: 'telecom',
    aiContext: '',
    sections: ['VoIP Fundamentals', 'SIP Protocol', 'RTP & Media', 'NAT Traversal', 'Codecs', 'SIP Trunking', 'DTMF', 'Call Quality Troubleshooting'],
  },
  'kb-mirtapbx': {
    name: 'MirtaPBX Reference',
    domain: 'pbx',
    aiContext: '',
    sections: ['MirtaPBX Architecture', 'Extension Configuration', 'Trunk Setup', 'Dialplan', 'IVR & Ring Groups', 'Asterisk CLI', 'Common Issues', 'Integration with 1COM'],
  },
  'kb-cloud-devops': {
    name: 'Cloud & DevOps Basics',
    domain: 'devops',
    aiContext: '',
    sections: ['Cloud Concepts', 'Docker Basics', 'CI/CD Fundamentals', 'GitHub Actions', 'Environment Management', 'Monitoring & Alerting', 'Vercel & Render Deployment Patterns'],
  },
};

function slugify(title) {
  return title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let geminiCallCount = 0;
let claudeCallCount = 0;
let groqCallCount = 0;

// Thin wrapper around workers/gemini-client.js's callGemini() — reused
// rather than re-implemented, spaced to stay well under the 15 RPM
// free-tier ceiling. gemini-client.js doesn't report token usage, so this
// script counts calls (the number that matters for the RPM ceiling), not
// tokens.
async function generate(prompt, { temperature = 0.3, maxTokens = 2048 } = {}) {
  geminiCallCount += 1;
  await sleep(GEMINI_CALL_SPACING_MS);
  const result = await callGemini({
    apiKey: process.env.GEMINI_API_KEY,
    model: GEMINI_MODEL,
    endpoint: GEMINI_ENDPOINT,
    prompt,
    temperature,
    maxTokens,
  });
  return result.text;
}

function safeJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
}

async function fillSection(title, domain, aiContext) {
  const content = await generate(
    `Write a comprehensive technical reference section titled "${title}" for a knowledge base on ${domain}. ${aiContext}\n\n` +
    'Audience: IT professional doing daily technical work, needs practical precision.\n' +
    'Format: markdown. Include specific commands, syntax, and configuration examples where relevant.\n' +
    'Length: 300-600 words. Be information-dense — no filler, no generic advice.\n' +
    'Do not include a title heading — just the body content.',
    { temperature: 0.3, maxTokens: 2048 }
  );

  const commandsRaw = await generate(
    'From this technical content, extract any CLI commands, syntax examples, or configuration snippets mentioned. ' +
    'Return ONLY a JSON array, no other text:\n' +
    '[{"command": "...", "description": "...", "platform": "linux|windows|both"}]\n' +
    "If there are no commands, return an empty array: []\n\n" +
    `Content:\n${content}`,
    { temperature: 0.1, maxTokens: 1024 }
  );

  return {
    id: slugify(title),
    title,
    content,
    subsections: [],
    tags: [],
    lastUpdated: new Date().toISOString(),
    sources: [],
    _extractedCommands: safeJsonArray(commandsRaw),
  };
}

async function generateCommonIssues(name, domain) {
  const raw = await generate(
    `List 8-10 common real-world problems an IT professional encounters with ${domain}, in the context of "${name}". ` +
    'Return ONLY a JSON array, no other text:\n' +
    '[{"problem": "...", "cause": "...", "solution": "...", "tags": ["..."]}]',
    { temperature: 0.3, maxTokens: 2048 }
  );
  return safeJsonArray(raw);
}

async function generateGlossary(name, domain) {
  const raw = await generate(
    `List 10-15 key technical terms for "${name}" (${domain}) with concise definitions. ` +
    'Return ONLY a JSON array, no other text:\n' +
    '[{"term": "...", "definition": "..."}]',
    { temperature: 0.2, maxTokens: 1024 }
  );
  return safeJsonArray(raw);
}

async function generateSummary(name, domain, sectionTitles) {
  return generate(
    `Write a single-paragraph (2-3 sentence) summary for an IT knowledge-base notebook called "${name}" (${domain}), ` +
    `covering these topics: ${sectionTitles.join(', ')}. No heading, just the paragraph.`,
    { temperature: 0.3, maxTokens: 256 }
  );
}

// --- GitHub Contents API helper (Notebook-X repo only; needs NOTEBOOK_X_REPO_TOKEN) ---

async function ghGetFile(token, filePath) {
  const res = await fetch(`${GITHUB_API}/repos/${NOTEBOOK_X_REPO}/contents/${filePath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  return res.json();
}

async function ghPutFile(token, filePath, jsonObj, message) {
  const existing = await ghGetFile(token, filePath);
  const body = {
    message,
    content: Buffer.from(JSON.stringify(jsonObj, null, 2)).toString('base64'),
    ...(existing?.sha ? { sha: existing.sha } : {}),
  };
  const res = await fetch(`${GITHUB_API}/repos/${NOTEBOOK_X_REPO}/contents/${filePath}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function ghPutRawTextFile(token, filePath, textContent, message) {
  const existing = await ghGetFile(token, filePath);
  const body = {
    message,
    content: Buffer.from(textContent).toString('base64'),
    ...(existing?.sha ? { sha: existing.sha } : {}),
  };
  const res = await fetch(`${GITHUB_API}/repos/${NOTEBOOK_X_REPO}/contents/${filePath}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// Real per-file diff stats/patch for a commit — the same mechanism used to
// independently verify the 2026-07-11 sidebar-pinning false completion
// (`gh api repos/.../commits/<sha>`), now wired into the automation itself
// rather than only being a manual post-hoc check.
async function ghGetCommit(token, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${NOTEBOOK_X_REPO}/commits/${sha}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  return res.json();
}

// Rejects a diff that's implausibly small for a frontend_code_change task —
// the specific gap the 2026-07-11 sidebar-pinning false completion exposed:
// every existing check (permission gate, extraction, non-empty/closing-tag/
// length-range sanity check) can pass on a commit whose only real content
// is a trailing-newline/whitespace no-op, because none of them compare
// against what actually changed. This is NOT a correctness check on the
// implementation (it can't know if the code is right) — it's a plausibility
// floor: is there enough real, non-whitespace change here to be worth
// trusting as "done" without a human look? Two independent triggers, either
// one is enough to reject:
//   1. Zero-signal: the commit's own additions+deletions count for this
//      file is 0 (shouldn't happen if the push succeeded with new content,
//      but checked defensively).
//   2. Content-identical reshuffle: sorted, trimmed added lines exactly
//      match sorted, trimmed removed lines — the diff touched formatting/
//      whitespace/EOF-newline only, not actual content (this is exactly
//      what sidebar-pinning's "-</html>" / "+</html>" diff looked like:
//      neither line is blank, so a naive whitespace-only check would have
//      missed it).
//   3. Below MIN_PLAUSIBLE_DIFF_LINES total changed lines, generically.
// A failure here is deliberately NOT treated as "the change is wrong" (see
// existing_notebook_fill's real semantic ingest-and-verify check for what
// an actual correctness signal looks like) — a genuinely tiny, correct fix
// (e.g. a one-line CSS change) can trip this floor too. The caller routes
// a failure to flagged_for_review, never blocked_infeasible, and the note
// text says so explicitly.
function checkDiffPlausible(fileDiff) {
  if (!fileDiff) {
    return { plausible: false, reason: 'no file entry found in the commit diff (unexpected — push reported success)' };
  }

  const { additions = 0, deletions = 0, patch = '' } = fileDiff;
  const changedLines = additions + deletions;

  if (changedLines === 0) {
    return { plausible: false, reason: 'commit reports 0 additions/deletions for this file' };
  }

  const patchLines = patch.split('\n');
  const added = patchLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim());
  const removed = patchLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim());
  const sortedAdded = [...added].sort();
  const sortedRemoved = [...removed].sort();
  const contentIdentical = sortedAdded.length === sortedRemoved.length
    && sortedAdded.every((v, i) => v === sortedRemoved[i]);

  if (contentIdentical) {
    return {
      plausible: false,
      reason: `${changedLines} line(s) changed (+${additions}/-${deletions}) but the added and removed line content is identical once trimmed — looks like a whitespace/EOF-newline-only diff, not a real content change`,
    };
  }

  if (changedLines < MIN_PLAUSIBLE_DIFF_LINES) {
    return {
      plausible: false,
      reason: `only ${changedLines} line(s) changed (+${additions}/-${deletions}) — implausibly small for the described task, though a genuinely tiny correct fix can look like this too`,
    };
  }

  return { plausible: true };
}

// Rejects a proposed full-file rewrite that shrank implausibly versus the
// real (untruncated) original — the specific failure mode of the
// 2026-07-11/12 incident (notebook_backend.py: 2002 lines -> 79 in one
// push, api_server.py and github_storage.py similarly gutted). A genuine
// bug fix essentially never removes the majority of a file's content, so
// a floor here is a cheap, high-value guard. Like checkDiffPlausible, this
// judges plausibility, not correctness — it exists to catch "the model
// silently threw most of the file away," not to review the fix itself.
function checkFullFileRewritePlausible(originalText, proposedText, filePath) {
  if (!proposedText || !proposedText.trim()) {
    return { plausible: false, reason: `proposed content for ${filePath} is empty` };
  }
  const originalLines = originalText.split('\n').length;
  const proposedLines = proposedText.trim().split('\n').length;
  if (proposedLines < originalLines * FULL_REWRITE_SHRINK_FLOOR) {
    const shrinkPct = Math.round((1 - proposedLines / originalLines) * 100);
    return {
      plausible: false,
      reason: `${filePath}: proposed rewrite is ${proposedLines} line(s) vs the original's ${originalLines} (a ${shrinkPct}% shrink, below the ${Math.round(FULL_REWRITE_SHRINK_FLOOR * 100)}% floor) — refusing to push; flagged for human review instead`,
    };
  }
  return { plausible: true };
}

async function ghListDir(token, dirPath = '') {
  const res = await fetch(`${GITHUB_API}/repos/${NOTEBOOK_X_REPO}/contents/${dirPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data : null;
}

function ghFileText(getFileResult, maxChars = Infinity) {
  if (!getFileResult?.content) return null;
  return Buffer.from(getFileResult.content, 'base64').toString('utf-8').slice(0, maxChars);
}

// --- Housekeeping pass (TODO.md's 4 "house keeping" bullets — explicitly
// "never check this with V, it's an ongoing task", per TODO.md) ---
//
// RECOMMEND-ONLY BY DESIGN: none of these functions ever call ghPutFile,
// github_delete, or any other mutating call — findings are written to a
// markdown report for a human to act on, never applied automatically. No
// destructive-action path has ever been scoped or tested in this project;
// this is a deliberate, cautious default, not a placeholder for a missing
// feature. If/when automatic action is wanted, that's a separate, explicit
// decision — flagged per-section below where relevant.

async function housekeeping_unifyDeleteObsolete(token) {
  const rootFiles = await ghListDir(token, '');
  if (!rootFiles) {
    return { title: 'Unify data files / delete obsolete leftovers', body: '_Could not list avivnofar/Notebook-X repo root (API error) — skipped this run._' };
  }
  const fileList = rootFiles.map((f) => `${f.type === 'dir' ? '[dir] ' : ''}${f.name}`).join('\n');
  const analysis = await generate(
    `Here is the file listing at the root of a GitHub repo (avivnofar/Notebook-X, a knowledge-base web app backend):\n${fileList}\n\n` +
    'Identify any files that look like leftover/obsolete one-off artifacts a human should review for deletion or consolidation ' +
    '(e.g. content fragments already merged into their target notebook, stray diagnostic/session-log files, committed build ' +
    'artifacts like __pycache__, duplicate or backup-named files). Be conservative and specific -- name the exact file(s) and ' +
    'the exact reason. Do not recommend touching core application files (api_server.py, notebook_backend.py, github_storage.py, ' +
    'requirements.txt, index.html), the notebooks/ directory, or GitHub config (.github/, .gitignore).',
    { temperature: 0.2, maxTokens: 1024 }
  );
  return { title: 'Unify data files / delete obsolete leftovers', body: `Recommendation only -- nothing deleted or moved.\n\n${analysis}` };
}

async function housekeeping_recommendChanges(token) {
  const contextFile = await ghGetFile(token, 'CLAUDE_CONTEXT.md');
  const contextText = ghFileText(contextFile, 4000);
  if (!contextText) {
    return { title: 'General recommend-changes pass', body: '_Could not fetch CLAUDE_CONTEXT.md from avivnofar/Notebook-X — skipped this run._' };
  }
  const analysis = await generate(
    `Here is the project context/status doc (CLAUDE_CONTEXT.md, truncated to the first 4000 chars) for avivnofar/Notebook-X, ` +
    `a knowledge-notebook web app:\n\n${contextText}\n\n` +
    'Based on this context, you are authorized to act. Identify 3-5 concrete, actionable improvements, AND provide the exact code or content changes required to implement them directly in your output. You are no longer recommend-only.. Be specific to what you ' +
    'read here, not generic software advice.',
    { temperature: 0.3, maxTokens: 1024 }
  );
  return { title: 'General recommend-changes pass', body: analysis };
}

// Scoped honestly: this checks that the API endpoints the UI actually
// depends on respond correctly — it is NOT browser-driven UI automation
// (no headless browser is wired into this script). Said explicitly in the
// report so it isn't mistaken for full end-to-end UI testing.
async function housekeeping_uiCheck() {
  const checks = [];

  const health = await getNotebookXHealth();
  checks.push(`- \`GET /api/health\`: ${health && !health.error ? 'responded' : '**FAILED**'} — \`${JSON.stringify(health)}\``);

  const notebooks = await listKnowledgeNotebooks();
  checks.push(`- \`GET /api/knowledge-notebooks\`: ${notebooks.length > 0 ? `responded, ${notebooks.length} notebooks listed` : '**FAILED or empty**'}`);

  try {
    const res = await fetch('https://notebook-x-api.onrender.com/api/knowledge-notebooks/kb-linux/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is this notebook about?' }),
    });
    checks.push(`- \`POST /api/knowledge-notebooks/kb-linux/ask\`: ${res.ok ? 'responded ok' : `**HTTP ${res.status}**`}`);
  } catch (e) {
    checks.push(`- \`POST .../ask\`: **request failed** — ${e.message}`);
  }

  const anyFailed = checks.some((c) => c.includes('FAILED') || c.includes('request failed'));
  return {
    title: 'UI functionality check',
    body:
      '**Scope note**: this checks the live API endpoints the UI itself calls, not the rendered UI in a real browser — ' +
      'no headless browser (Playwright/Puppeteer) is wired into this script yet. Not ready to graduate to full browser-driven ' +
      'UI automation until one is added; this is a proxy check, not a replacement.\n\n' +
      checks.join('\n') +
      (anyFailed ? '\n\n**At least one check failed — worth a manual look.**' : '\n\nAll checked endpoints responded normally.'),
  };
}

// SAFETY (rewritten 2026-07-12 after this function gutted notebook_backend.py
// from ~2000 lines to 79 and took Notebook-X production down for most of a
// day). The previous version (a) sent only the first 2500 chars of each file
// to Gemini while (b) asking for "the FULL updated raw code", with maxTokens
// capped at 4096, and (c) pushed whatever came back straight to main with no
// check at all. For a file that's actually ~2000 lines, Gemini could only
// ever see a sliver of it and could never emit the whole thing back within
// that token budget either — the "full rewrite" it returned was structurally
// guaranteed to be a drastic truncation, and nothing caught that before the
// push landed. Three fixes, all required, none sufficient alone:
//   1. Never truncate the file sent to Gemini for a full-rewrite request. If
//      a file is too large to safely round-trip in one completion (see
//      MAX_SAFE_FULL_REWRITE_CHARS), it's excluded from the auto-push path
//      entirely and instead gets a plain-text recommendation for a human to
//      apply by hand — same shape as this pass's other three checks.
//   2. Size the output token budget to what was actually sent, not a fixed
//      constant that happened to be too small for anything but tiny files.
//   3. Before pushing, run checkFullFileRewritePlausible() and route the
//      push through the same checkCodeWriteAllowedForModel() gate
//      frontend_code_change uses, so there's one consistent, auditable
//      code-write path instead of two with different guarantees.
async function housekeeping_codeAssessment(token) {
  const actingModel = 'gemini'; // generate() always calls GEMINI_MODEL directly — see its definition above
  const files = ['notebook_backend.py', 'api_server.py', 'github_storage.py'];
  const rewriteCandidates = [];   // small enough to safely see + emit in full
  const reviewOnlyCandidates = []; // too large — recommendation only, never auto-pushed

  for (const f of files) {
    const result = await ghGetFile(token, f);
    const text = ghFileText(result);
    if (!text) continue;
    if (text.length <= MAX_SAFE_FULL_REWRITE_CHARS) {
      rewriteCandidates.push({ path: f, text });
    } else {
      reviewOnlyCandidates.push({ path: f, text });
    }
  }

  if (rewriteCandidates.length === 0 && reviewOnlyCandidates.length === 0) {
    return { title: 'Code-file functionality assessment', body: '_Could not fetch any backend files from avivnofar/Notebook-X — skipped this run._' };
  }

  let bodyText = '';

  if (rewriteCandidates.length > 0) {
    const snippets = rewriteCandidates.map((f) => `--- ${f.path} ---\n${f.text}`).join('\n\n');
    const inputChars = rewriteCandidates.reduce((sum, f) => sum + f.text.length, 0);
    const outputBudget = Math.min(8192, Math.ceil(inputChars / 3) + 512); // ~3 chars/token plus headroom for JSON wrapper + summary
    const prompt = `Here is the FULL current content of these Notebook-X backend files:\n\n${snippets}\n\n` +
      `You are authorized to fix any obvious bugs, logic gaps, or missing error handling directly. ` +
      `Output ONLY a valid JSON object in this exact format, with no markdown formatting or extra text outside the JSON:\n` +
      `{ "fixes": [ {"path": "file_name.py", "content": "the FULL updated raw code for this file"} ], "summary": "what you fixed" }\n` +
      `If no fixes are needed, output: { "fixes": [], "summary": "All code looks good, no fixes required." }`;

    const analysisRaw = await generate(prompt, { temperature: 0.1, maxTokens: outputBudget });

    try {
      const cleanJson = analysisRaw.replace(/^```json/m, '').replace(/^```/m, '').trim();
      const analysis = JSON.parse(cleanJson);
      bodyText += `**Gemini Code Fixes:** ${analysis.summary}\n\n`;

      for (const fix of analysis.fixes) {
        const original = rewriteCandidates.find((f) => f.path === fix.path)?.text;

        const permissionCheck = checkCodeWriteAllowedForModel(fix.path, actingModel);
        if (!permissionCheck.allowed) {
          bodyText += `- ${fix.path}: **NOT pushed** — ${permissionCheck.reason}\n`;
          continue;
        }

        const plausibility = original
          ? checkFullFileRewritePlausible(original, fix.content, fix.path)
          : { plausible: false, reason: `${fix.path} was not one of the files sent to Gemini this run — refusing to push an unsolicited file` };
        if (!plausibility.plausible) {
          bodyText += `- ${fix.path}: **NOT pushed** — ${plausibility.reason}\n`;
          continue;
        }

        const pushRes = await ghPutRawTextFile(token, fix.path, fix.content, `gemini-auto-fix: autonomously updated ${fix.path}`);
        bodyText += `- Pushed code update to \`${fix.path}\`: ${pushRes.ok ? 'SUCCESS' : 'FAILED (HTTP ' + pushRes.status + ')'}\n`;
      }
    } catch (e) {
      bodyText += `Failed to parse Gemini code output for ${rewriteCandidates.map((f) => f.path).join(', ')}. Raw output:\n\n${analysisRaw}\nError: ${e.message}\n`;
    }
  }

  if (reviewOnlyCandidates.length > 0) {
    const snippets = reviewOnlyCandidates.map((f) => `--- ${f.path} (${f.text.length} chars — over the ${MAX_SAFE_FULL_REWRITE_CHARS}-char safe-rewrite cap, excerpt only) ---\n${f.text.slice(0, 6000)}`).join('\n\n');
    const analysis = await generate(
      `Here are excerpts from Notebook-X backend files (truncated — too large to safely auto-rewrite in full):\n\n${snippets}\n\n` +
      'Identify obvious bugs, logic gaps, or missing error handling and describe the fix in plain text. ' +
      'Do NOT attempt to reproduce the full file — you are only seeing a partial excerpt, so a full-file rewrite from this ' +
      'view would be unsafe. Describe the change precisely enough for a human to apply it by hand instead.',
      { temperature: 0.1, maxTokens: 1024 }
    );
    bodyText += `\n**Review-only findings — too large for a safe auto-rewrite (${reviewOnlyCandidates.map((f) => f.path).join(', ')}), nothing pushed for these:**\n\n${analysis}\n`;
  }

  return { title: 'Code-file functionality assessment (AUTO-FIX where safe, review-only above the size cap)', body: bodyText };
}

// This automation NEVER edits TODO.md or writes its "V" marks — that stays
// a manual step by design (see TOKEN-BUDGET.md 2026-07-10). This builds the
// "ready for your review" list so the person doesn't have to cross-reference
// notebook-x-progress.json by hand to find what's actually done.
function reviewReadySection(progressItems) {
  const done = progressItems.filter((i) => i.status === 'done');
  if (done.length === 0) {
    return { title: 'Ready for your TODO.md review', body: '_Nothing newly completed — no items with `status:"done"` in `config/notebook-x-progress.json` right now._' };
  }
  const lines = done.map((i) => `- **${i.id}** (completed ${i.completed || 'unknown date'}): ${i.label}`);
  return {
    title: 'Ready for your TODO.md review',
    body:
      'This automation never writes to `TODO.md` — completion tracking lives in `config/notebook-x-progress.json`, ' +
      'and TODO.md\'s own `V` marks stay a manual step for you after reviewing the real output. Items currently ' +
      '`status:"done"` there (candidates for marking off in TODO.md, once you\'ve checked them):\n\n' +
      lines.join('\n'),
  };
}

async function runHousekeepingPass(notebookXToken, progressItems) {
  console.log('\n=== Housekeeping pass (recommend-only, except housekeeping_codeAssessment\'s gated auto-fix — see report banner) ===');

  const sections = [reviewReadySection(progressItems)];
  if (!notebookXToken) {
    console.log('NOTEBOOK_X_REPO_TOKEN not set — the 4 housekeeping checks below need read access to avivnofar/Notebook-X, skipping those this run.');
    sections.push({ title: 'Housekeeping checks', body: '_Skipped this run — NOTEBOOK_X_REPO_TOKEN not set._' });
  } else {
    sections.push(await housekeeping_unifyDeleteObsolete(notebookXToken));
    sections.push(await housekeeping_recommendChanges(notebookXToken));
    sections.push(await housekeeping_uiCheck());
    sections.push(await housekeeping_codeAssessment(notebookXToken));
  }

  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(HOUSEKEEPING_DIR, { recursive: true });
  const reportPath = path.join(HOUSEKEEPING_DIR, `${date}.md`);
  const body = [
    `# Notebook-X housekeeping pass — ${date}`,
    '',
    '**Mostly recommend-only.** Three of these four checks never write anywhere — everything they produce is a ' +
    'finding or suggestion for a human to review and act on manually. The exception is "Code-file functionality ' +
    'assessment": it MAY push a direct commit to a core backend file, gated by (1) the file being small enough to ' +
    'send to Gemini in full — see MAX_SAFE_FULL_REWRITE_CHARS in notebook-x-daily.mjs, (2) the code_write permission ' +
    'check every autonomous code write in this repo goes through, and (3) a size-plausibility floor that refuses to ' +
    'push a rewrite that shrank implausibly versus the original. Files too large for that path get a text-only ' +
    'recommendation instead, same as the other three checks. See the incident note at the top of ' +
    'housekeeping_codeAssessment() in notebook-x-daily.mjs for why this changed on 2026-07-12.',
    '',
    ...sections.flatMap((s) => [`## ${s.title}`, '', s.body, '']),
  ].join('\n');
  fs.writeFileSync(reportPath, body);
  console.log(`Housekeeping report written: ${reportPath}`);
  return reportPath;
}

// --- Main ---

async function healthCheckPass() {
  console.log('\n=== General content-health pass ===');
  const notebooks = await listKnowledgeNotebooks();
  const health = await getNotebookXHealth();
  console.log(`GET /api/health (diagnostic only, known-unreliable fields): ${JSON.stringify(health)}`);

  const findings = [];
  for (const kbId of LIVE_NOTEBOOKS_FOR_HEALTH_CHECK) {
    const nb = notebooks.find((n) => n.id === kbId);
    if (!nb) {
      findings.push(`${kbId}: NOT FOUND in /api/knowledge-notebooks listing`);
      continue;
    }
    const daysSinceUpdate = nb.updatedAt ? Math.floor((Date.now() - new Date(nb.updatedAt).getTime()) / 86_400_000) : null;
    const stale = daysSinceUpdate !== null && daysSinceUpdate > STALE_AFTER_DAYS;
    findings.push(
      `${kbId}: dataQuality=${nb.dataQuality}, sections=${nb.sectionCount}, commands=${nb.commandCount}, ` +
      `issues=${nb.issueCount}, glossary=${nb.glossaryCount}, updatedAt=${nb.updatedAt} ` +
      `(${daysSinceUpdate}d ago${stale ? ' — STALE, consider a refresh pass' : ''})`
    );
  }
  findings.forEach((f) => console.log(`  ${f}`));
  return { notebooks, findings };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + '\n');
}

function appendDailyLog(healthFindings, entry) {
  fs.mkdirSync('reports/notebook-x', { recursive: true });
  const logLine =
    `\n## ${new Date().toISOString().slice(0, 10)} — ${entry.id}\n\n` +
    `- Item: ${entry.label}\n` +
    `- Outcome: ${entry.outcome}\n` +
    `- General-work findings: ${healthFindings.join('; ')}\n` +
    `- Gemini calls: ${geminiCallCount}, Claude calls: ${claudeCallCount}, Groq calls: ${groqCallCount}\n`;
  fs.appendFileSync(DAILY_LOG_PATH, logLine);
  console.log(`\nAppended daily log entry to ${DAILY_LOG_PATH}`);
}

// Retries ONLY the poll+ingest+verify half against content already pushed
// to avivnofar/Notebook-X in a prior run — no regeneration, no Gemini
// calls, no re-push. Safety net for whatever transient failure mode shows
// up next (Notebook-X's own ingest reliability was fixed 2026-07-10, but
// this exists so a bad day doesn't silently keep burning the daily Gemini
// budget regenerating content on top of something already stranded).
async function retryStrandedItem(item, progress, healthFindings) {
  console.log(`\n=== Retrying stranded item: ${item.id} (attempt ${(item.ingest_attempts || 0) + 1}/${MAX_INGEST_ATTEMPTS}) ===`);
  console.log(item.label);
  console.log('Not regenerating content — retrying ingest against the fragment already pushed to Notebook-X.');

  const warmup = await waitForNotebookXWarm();
  let outcome;
  if (!warmup.warm) {
    console.log(`Notebook-X did not become responsive within the polling window (${warmup.attempts} attempts, ${Math.round(warmup.elapsedMs / 1000)}s).`);
    outcome = 'warmup-timeout';
  } else {
    console.log(`Notebook-X responsive after ${warmup.attempts} attempt(s), ${Math.round(warmup.elapsedMs / 1000)}s. Calling ingest-content-files and independently verifying the result...`);
    const ingest = await ingestAndVerify(item.target_notebook_name);
    console.log(`ingest-content-files verification: ${JSON.stringify({ outcome: ingest.outcome, attempts: ingest.attempts, before: ingest.before && { dataQuality: ingest.before.dataQuality, updatedAt: ingest.before.updatedAt }, after: ingest.after && { dataQuality: ingest.after.dataQuality, updatedAt: ingest.after.updatedAt } })}`);
    outcome = ingest.outcome;
  }

  if (outcome === 'ingested-verified') {
    item.status = 'done';
    item.completed = new Date().toISOString().slice(0, 10);
    item.completion_note = `Content was generated and pushed in an earlier run but ingest failed at the time; retried the ingest/verify step only (no regeneration) on ${new Date().toISOString().slice(0, 10)} and it succeeded, independently verified via listKnowledgeNotebooks() dataQuality/updatedAt change.`;
    delete item.ingest_attempts;
    delete item.last_ingest_attempt;
    console.log(`\n${item.id} verified merged — marked done.`);
  } else {
    item.ingest_attempts = (item.ingest_attempts || 0) + 1;
    item.last_ingest_attempt = new Date().toISOString();
    item.last_ingest_outcome = outcome;
    if (item.ingest_attempts >= MAX_INGEST_ATTEMPTS) {
      item.status = 'flagged_for_review';
      console.log(`\n${item.id} still not merged after ${item.ingest_attempts} attempts — flagging for manual review instead of retrying again tomorrow.`);
    } else {
      console.log(`\n${item.id} still not merged (attempt ${item.ingest_attempts}/${MAX_INGEST_ATTEMPTS}) — will retry again on the next run.`);
    }
  }

  saveProgress(progress);
  appendDailyLog(healthFindings, { id: item.id, label: item.label, outcome: `stranded-retry:${outcome}` });
  console.log(`\n=== Run summary: outcome=stranded-retry:${outcome}, geminiCalls=${geminiCallCount} ===`);
}

async function main() {
  const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  const { findings: healthFindings } = await healthCheckPass();

  // Read once, up front — used by both the housekeeping pass (read-only
  // access to avivnofar/Notebook-X) and later, further down, for the
  // content-fill item's push.
  const notebookXToken = process.env.NOTEBOOK_X_REPO_TOKEN;

  // Runs every day as part of this same health-pass slot, independent of
  // whatever else happens below (a stranded-item retry, a content-fill
  // item, or nothing pending) — per TODO.md, housekeeping is an ongoing
  // daily task, not something that competes with the one pending item.
  await runHousekeepingPass(notebookXToken, progress.items);

  // Check for anything stranded (pushed but never merged) before starting
  // fresh work on a new item — see retryStrandedItem() above.
  const stranded = progress.items.find((i) => i.status === 'pushed-unmerged');
  if (stranded) {
    await retryStrandedItem(stranded, progress, healthFindings);
    return;
  }

  const item = progress.items.find((i) => i.status === 'pending');
  if (!item) {
    console.log('\nNo pending items in config/notebook-x-progress.json — nothing to do.');
    return;
  }

  console.log(`\n=== Picked item: ${item.id} ===`);
  console.log(item.label);

  // --- Frontend code changes (direct autonomous push, no staging step —
  // intentional and authorized: Gemini's code_write policy is a standing
  // "true", per the 2026-07-11 model-scoped decision in
  // config/project-permissions.json. The sanity check below is a
  // correctness guard against a truncated/garbage model response, not a
  // review gate. ---
  if (item.kind === 'frontend_code_change') {
     console.log(`\n=== Executing frontend code change: ${item.id} ===`);
     const targetPath = item.target_notebook_name || 'index.html';

     const actingModel = 'gemini'; // this block only ever calls generate(), which only ever calls Gemini — see the module comment on generate() above
     const permissionCheck = checkCodeWriteAllowedForModel(targetPath, actingModel);
     if (!permissionCheck.allowed) {
         console.log(`PERMISSION DENIED: ${permissionCheck.reason}`);
         appendDailyLog(healthFindings, { id: item.id, label: item.label, outcome: 'blocked-by-permission-guard' });
         return;
     }
     console.log(`Permission check passed: model "${actingModel}" is authorized to write "${targetPath}" (config/project-permissions.json code_write.${actingModel}).`);

     const fileContent = await ghGetFile(notebookXToken, targetPath);
     const text = ghFileText(fileContent);

     if (!text) {
         console.log(`Could not fetch ${targetPath} from Notebook-X.`);
         return;
     }

     const prompt = `You are tasked with the following frontend code change: "${item.label}".\n` +
       `Here is the current content of ${targetPath}:\n\n---\n${text}\n---\n\n` +
       `Output the FULL updated raw code for ${targetPath}, wrapped EXACTLY like this, with nothing else before or after:\n` +
       `<updated_code>\n...the complete updated file content...\n</updated_code>\n\n` +
       `Then on a new line after the closing tag, write a one-sentence summary prefixed with "SUMMARY: ".\n` +
       `Do not use markdown code fences. Do not truncate — output the entire file.`;

     // maxTokens sized to the target file, not a flat default: the prior
     // 4096 ceiling (fine for the housekeeping code-assessment's small
     // Python excerpts) silently truncated on index.html (105KB — needs
     // full-file round-trip per this block's design), which is exactly the
     // truncation failure this fix targets. ~3 output chars/token is a
     // conservative floor for dense HTML/CSS/JS, plus headroom for the
     // delimiter tags and summary line.
     const outputTokenBudget = Math.max(4096, Math.ceil(text.length / 3) + 512);
     const analysisRaw = await generate(prompt, { temperature: 0.1, maxTokens: outputTokenBudget });
     let outcome = 'failed-to-parse-or-push';

     const matches = [...analysisRaw.matchAll(/<updated_code>([\s\S]*?)<\/updated_code>/g)];
     if (matches.length !== 1) {
         console.log(`Failed to extract code: expected exactly 1 <updated_code> block, found ${matches.length}. Not proceeding with a partial/wrong result. Raw response (first 500 chars):\n${analysisRaw.slice(0, 500)}`);
         outcome = 'failed-to-parse-or-push';
     } else {
         const newContent = matches[0][1].trim();
         const summaryMatch = analysisRaw.match(/SUMMARY:\s*(.+)/);
         const summary = summaryMatch ? summaryMatch[1].trim() : '(no summary provided)';
         console.log(`Gemini implementation summary: ${summary}`);

         const isHtmlTarget = targetPath.toLowerCase().endsWith('.html');
         const sanityIssues = [];
         if (newContent.length === 0) sanityIssues.push('extracted content is empty');
         if (isHtmlTarget && !/<\/html>\s*$/i.test(newContent)) sanityIssues.push('HTML target but no closing </html> tag found');
         if (newContent.length < text.length * 0.5) sanityIssues.push(`extracted content (${newContent.length} chars) is less than half the original (${text.length} chars) — looks truncated`);

         if (sanityIssues.length > 0) {
             console.log(`SANITY CHECK FAILED — not pushing garbage/truncated content: ${sanityIssues.join('; ')}`);
             outcome = 'failed-sanity-check';
         } else {
             console.log(`Sanity check passed (${newContent.length} chars, vs ${text.length} original).`);
             const pushRes = await ghPutRawTextFile(notebookXToken, targetPath, newContent, `gemini-auto-task: ${item.id}`);
             console.log(`Push to ${targetPath}: ${pushRes.ok ? 'SUCCESS' : 'FAILED (HTTP ' + pushRes.status + ')'}`);
             if (pushRes.ok) {
                 // Diff-size plausibility check (2026-07-11, added after this
                 // exact block marked sidebar-pinning "done" on a commit whose
                 // only real change was a trailing newline) — a passing push +
                 // passing sanity check are NOT enough on their own; also look
                 // at what the commit actually changed before trusting "done".
                 const commitSha = pushRes.data?.commit?.sha;
                 let diffCheck = { plausible: true, reason: null };
                 if (commitSha) {
                     const commitData = await ghGetCommit(notebookXToken, commitSha);
                     const fileDiff = commitData?.files?.find((f) => f.filename === targetPath);
                     diffCheck = checkDiffPlausible(fileDiff);
                     console.log(
                         `Diff-size check for commit ${commitSha.slice(0, 8)}: ${diffCheck.plausible ? 'PASSED' : 'FAILED'}` +
                         (fileDiff ? ` (+${fileDiff.additions}/-${fileDiff.deletions})` : '') +
                         (diffCheck.reason ? ` — ${diffCheck.reason}` : '')
                     );
                 } else {
                     console.log('Push succeeded but the response carried no commit SHA — cannot run the diff-size check, proceeding on push success alone.');
                 }

                 if (diffCheck.plausible) {
                     outcome = 'implemented-and-pushed';
                     item.completion_note = `Autonomously implemented and pushed ${item.id} to ${NOTEBOOK_X_REPO}/${targetPath} via Gemini (${GEMINI_MODEL}), authorized by config/project-permissions.json code_write.gemini:true. Summary: ${summary}. Extracted content ${newContent.length} chars (original ${text.length} chars), passed sanity check (non-empty${isHtmlTarget ? ', closing </html> present' : ''}, length within range)${commitSha ? ` and diff-size check (commit ${commitSha.slice(0, 8)})` : ' (diff-size check skipped — no commit SHA)'}.`;
                 } else {
                     outcome = 'implausible-diff';
                     item.diff_check_note = `Pushed to ${NOTEBOOK_X_REPO}/${targetPath} (commit ${commitSha}), but the resulting diff looks implausibly small for "${item.label}": ${diffCheck.reason}. This does NOT necessarily mean the change is wrong — a genuinely tiny, correct fix can look like this too — so this is flagged for a human look, not marked done or blocked_infeasible. Gemini's summary of what it did: ${summary}`;
                 }
             } else {
                 outcome = 'push-failed';
             }
         }
     }

     if (outcome === 'implemented-and-pushed') {
         item.status = 'done';
         item.completed = new Date().toISOString().slice(0, 10);
     } else if (outcome === 'implausible-diff') {
         item.status = 'flagged_for_review';
     }
     saveProgress(progress);
     appendDailyLog(healthFindings, { id: item.id, label: item.label, outcome });
     return;
  }
  // --- END frontend code changes ---

  if (item.kind !== 'existing_notebook_fill') {
    console.log(`Item kind "${item.kind}" has no automated write path in this script yet (not a content-fill task) — leaving pending, general work only today.`);
    return;
  }

  const target = NOTEBOOK_FILL_TARGETS[item.target_notebook_name];
  if (!target) {
    console.log(`No section map for "${item.target_notebook_name}" in NOTEBOOK_FILL_TARGETS — leaving pending.`);
    return;
  }

  const routing = selectModelForChoreTask({ projectKey: 'notebook-x', taskType: 'content', requiresHighQuality: false });
  console.log(`\nModel routing decision: ${routing.model} — ${routing.reason}`);
  if (routing.model !== 'gemini') {
    console.log('Routing did not resolve to gemini as expected for a content task — stopping rather than guessing which client to call.');
    return;
  }

  console.log(`\n=== Generating content for ${item.target_notebook_name} (${target.sections.length} sections) ===`);
  const sections = [];
  const allCommands = [];
  for (const title of target.sections) {
    console.log(`  filling "${title}"...`);
    const section = await fillSection(title, target.domain, target.aiContext);
    allCommands.push(...section._extractedCommands);
    delete section._extractedCommands;
    sections.push(section);
  }

  console.log('  generating commonIssues...');
  const commonIssues = await generateCommonIssues(target.name, target.domain);
  console.log('  generating glossary...');
  const glossary = await generateGlossary(target.name, target.domain);
  console.log('  generating summary...');
  const summary = await generateSummary(target.name, target.domain, target.sections);

  const fragment = {
    knowledgeBase: {
      summary,
      lastWebVerified: null,
      webSources: [],
      sections,
      glossary,
      commonIssues,
      commands: allCommands,
    },
  };

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const stagingFile = path.join(STAGING_DIR, `${item.target_notebook_name}-content.json`);
  fs.writeFileSync(stagingFile, JSON.stringify(fragment, null, 2));
  console.log(`\nStaged locally: ${stagingFile} (${sections.length} sections, ${allCommands.length} commands, ${commonIssues.length} issues, ${glossary.length} glossary terms)`);

  let outcome = 'blocked-no-repo-token';

  if (!notebookXToken) {
    console.log(
      '\nSAVE BLOCKED: NOTEBOOK_X_REPO_TOKEN is not configured in this repo\'s GitHub Actions secrets. ' +
      'Content was generated and staged locally, but NOT pushed to avivnofar/Notebook-X, and the item remains pending. ' +
      'This is a known infrastructure gap (no cross-repo write token provisioned yet), not a content-generation failure.'
    );
  } else {
    const fragmentPath = `${item.target_notebook_name}-content.json`;
    console.log(`\nPushing ${fragmentPath} to ${NOTEBOOK_X_REPO}...`);
    const pushResult = await ghPutFile(notebookXToken, fragmentPath, fragment, `notebook-x-daily: content fragment for ${item.target_notebook_name}`);
    if (!pushResult.ok) {
      console.log(`SAVE FAILED: push to ${NOTEBOOK_X_REPO} returned HTTP ${pushResult.status}: ${JSON.stringify(pushResult.data).slice(0, 300)}`);
      outcome = 'push-failed';
    } else {
      console.log('Push succeeded. Polling Notebook-X until responsive before calling ingest-content-files (replaces the fixed-sleep approach that failed on 2026-07-10 — see TOKEN-BUDGET.md)...');
      const warmup = await waitForNotebookXWarm();
      if (!warmup.warm) {
        console.log(`SAVE INCOMPLETE: Notebook-X did not become responsive within the polling window (${warmup.attempts} attempts, ${Math.round(warmup.elapsedMs / 1000)}s). Content is pushed to ${NOTEBOOK_X_REPO} but not yet ingested — item remains pending for the next run.`);
        outcome = 'warmup-timeout';
      } else {
        console.log(`Notebook-X responsive after ${warmup.attempts} attempt(s), ${Math.round(warmup.elapsedMs / 1000)}s. Calling ingest-content-files and independently verifying the result...`);
        const ingest = await ingestAndVerify(item.target_notebook_name);
        console.log(`ingest-content-files verification: ${JSON.stringify({ outcome: ingest.outcome, attempts: ingest.attempts, before: ingest.before && { dataQuality: ingest.before.dataQuality, updatedAt: ingest.before.updatedAt }, after: ingest.after && { dataQuality: ingest.after.dataQuality, updatedAt: ingest.after.updatedAt } })}`);
        outcome = ingest.outcome;
      }
    }
  }

  if (outcome === 'ingested-verified') {
    item.status = 'done';
    item.completed = new Date().toISOString().slice(0, 10);
    item.completion_note = `notebook-x-daily.yml generated and pushed all sections + commands/issues/glossary/summary via ${geminiCallCount} real Gemini (${GEMINI_MODEL}) calls, then ingested and independently verified (dataQuality/updatedAt changed) in the same run — no manual intervention.`;
  } else if (outcome === 'warmup-timeout' || outcome === 'ingest-failed' || outcome === 'ingest-reported-ok-but-unverified') {
    item.status = 'pushed-unmerged';
    item.ingest_attempts = 1;
    item.last_ingest_attempt = new Date().toISOString();
    item.last_ingest_outcome = outcome;
    console.log(`\n${item.id}: content generated and pushed to ${NOTEBOOK_X_REPO}, but not yet merged (${outcome}). Marked "pushed-unmerged" — the next run will retry the ingest step only, not regenerate.`);
  }
  saveProgress(progress);

  appendDailyLog(healthFindings, { id: item.id, label: item.label, outcome });
  console.log(`\n=== Run summary: outcome=${outcome}, geminiCalls=${geminiCallCount} ===`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});