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

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GITHUB_API = 'https://api.github.com';
const NOTEBOOK_X_REPO = 'avivnofar/Notebook-X';
const PROGRESS_PATH = 'config/notebook-x-progress.json';
const STAGING_DIR = 'reports/notebook-x/pending-content';
const DAILY_LOG_PATH = 'reports/notebook-x/daily-log.md';
const LIVE_NOTEBOOKS_FOR_HEALTH_CHECK = ['kb-linux', 'kb-bash', 'kb-1com'];
const STALE_AFTER_DAYS = 30;
const MAX_INGEST_ATTEMPTS = 3; // per-item cap before leaving it flagged for manual review instead of retrying forever
const GEMINI_CALL_SPACING_MS = 4000; // stay well under the 15 RPM free-tier ceiling

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
  const notebookXToken = process.env.NOTEBOOK_X_REPO_TOKEN;

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

  // Persist the outcome back into notebook-x-progress.json instead of
  // leaving every non-success outcome as an unchanged "pending" for the
  // next run to blindly regenerate on top of. Only "push-failed" (nothing
  // landed on Notebook-X at all) stays "pending" as-is — everything else
  // that got a fragment successfully pushed but not merged becomes
  // "pushed-unmerged" so the next run's stranded-item check (see
  // retryStrandedItem() above) retries just the ingest half.
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
