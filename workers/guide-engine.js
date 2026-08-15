/**
 * Data Center — AI Agent Simulation — Guides pipeline.
 *
 * Owner-approved special task for the (normally dormant) Architect persona
 * — see CLAUDE.md "Guides" section for the full spec. The office generates
 * high-quality ENGLISH technical guides for the owner's Smart Archive app:
 * markdown files land in this repo under guides/<domain>/<slug>.md; nothing
 * here touches Google Drive, the archive app, or any external repo.
 *
 * Pipeline: exactly two model calls, two names on each guide.
 *   1. A writer persona (chosen by domain, see pickWriterAgentId()) drafts
 *      the guide via Gemini (agent.queryGeminiDirect() — already wired for
 *      persona voice, see agent-base.js). No Groq anywhere in this pipeline.
 *   2. The Architect (agent 10) reviews/finalizes via a DIRECT Anthropic API
 *      call (workers/claude-client.js, model claude-sonnet-5) — final
 *      authority, not a rubber stamp. APPROVE commits the guide; REVISE
 *      sends one round of fixes back to the writer; REJECT (or a second
 *      failed review) files the draft + rejection note under guides/_drafts/.
 *
 * This module holds the PURE pipeline logic and all D1 reads/writes for the
 * guide_pipeline table (mirroring workers/gap-reports.js's split: engine
 * files read/write D1 directly, but the actual GitHub commit stays in
 * agent-runner.js's commitFileToRepo(), which this module has no access to).
 * agent-runner.js orchestrates: instantiate the writer agent, call Gemini/
 * Claude, then call back into this module's pure parsing/rendering
 * functions before committing.
 */

const GUIDE_PIPELINE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS guide_pipeline (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  topic TEXT NOT NULL,
  domain TEXT NOT NULL,
  slug TEXT NOT NULL,
  source TEXT,
  writer_agent_id INTEGER,
  status TEXT DEFAULT 'drafted',
  draft_content TEXT,
  review_notes TEXT,
  revision_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

const REPO_OWNER = 'avivnofar';
const REPO_NAME = 'office-AI-agents';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master`;

/** Derived from Notebook-X's notebook list + data-center's topic areas + Windows — see CLAUDE.md "Folder structure". */
export const DOMAIN_FOLDERS = ['networking', 'firewall', 'windows', 'ai', 'linux', 'cloud', 'cybersecurity'];

/**
 * ABSOLUTE ZERO blocklist (CLAUDE.md "Topic selection" step 2) — 1COM,
 * MirtaPBX, Netvill, or commercial cloud-telephony keywords. Checked against
 * topic platform/kbSlug AND free text, case-insensitively. Even a
 * gap-derived topic that happens to hit one of these never becomes a guide.
 */
export const BLOCKLIST_KEYWORDS = ['1com', 'mirtapbx', 'netvill', 'voip', 'sip', 'pbx', 'cloud telephony', 'cloud-telephony'];

export function isBlocklisted({ platform, kbSlug, title, description } = {}) {
  const haystack = [platform, kbSlug, title, description].filter(Boolean).join(' ').toLowerCase();
  return BLOCKLIST_KEYWORDS.some((kw) => haystack.includes(kw));
}

/** Maps a qa-topics.js platform/category to one of DOMAIN_FOLDERS, or null if it doesn't map (and isn't otherwise blocked). */
const DOMAIN_MAP = {
  linux: 'linux',
  bash: 'linux',
  windows: 'windows',
  network: 'networking',
  networking: 'networking',
  vpn: 'networking',
  firewall: 'firewall',
  cloud: 'cloud',
  'cloud-devops': 'cloud',
  ai: 'ai',
  cybersecurity: 'cybersecurity',
  security: 'cybersecurity',
};

export function mapPlatformToDomain(platform, category) {
  return DOMAIN_MAP[String(platform || '').toLowerCase()] || DOMAIN_MAP[String(category || '').toLowerCase()] || null;
}

/**
 * Writer persona by domain (CLAUDE.md "Writer persona by domain") — maps
 * from each persona's real topic_affinity in agents-config.json: The QA
 * (agent 6) firewall/vpn; The Lead QA (agent 8) cybersecurity/networking;
 * The Team Lead (agent 7) the remainder (windows, ai, linux, cloud).
 */
export function pickWriterAgentId(platformOrDomain) {
  const key = String(platformOrDomain || '').toLowerCase();
  if (key === 'firewall' || key === 'vpn') return 6;
  if (key === 'cybersecurity' || key === 'security' || key === 'networking' || key === 'network') return 8;
  return 7;
}

export function computeSlug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

/* ─────────────────────────── D1: guide_pipeline ────────────────────────── */

/** Finds the most recent guide_pipeline row for a slug, if any (across all dates — used for dedupe / improve-don't-repeat). */
export async function getLatestGuidePipelineRowForSlug(env, slug) {
  if (!env.DB) return null;
  await env.DB.prepare(GUIDE_PIPELINE_TABLE_SQL).run();
  return env.DB.prepare(
    `SELECT * FROM guide_pipeline WHERE slug = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(slug).first();
}

/** Today's drafted-but-not-yet-reviewed row, if any (self-healing: guide_review checks this before generating its own draft). */
export async function getTodayDraftRow(env, dateStr) {
  if (!env.DB) return null;
  await env.DB.prepare(GUIDE_PIPELINE_TABLE_SQL).run();
  return env.DB.prepare(
    `SELECT * FROM guide_pipeline WHERE date = ? AND status = 'drafted' ORDER BY created_at DESC LIMIT 1`
  ).bind(dateStr).first();
}

export async function insertGuidePipelineRow(env, row) {
  if (!env.DB) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(GUIDE_PIPELINE_TABLE_SQL).run();
  await env.DB.prepare(
    `INSERT INTO guide_pipeline (id, date, topic, domain, slug, source, writer_agent_id, status, draft_content, review_notes, revision_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(
    id, row.date, row.topic, row.domain, row.slug, row.source ?? null,
    row.writerAgentId ?? null, row.status ?? 'drafted', row.draftContent ?? null,
    row.reviewNotes ?? null, row.revisionCount ?? 0
  ).run();
  return id;
}

export async function updateGuidePipelineRow(env, id, patch) {
  if (!env.DB || !id) return;
  const fields = [];
  const values = [];
  for (const [key, column] of [
    ['status', 'status'], ['draftContent', 'draft_content'], ['reviewNotes', 'review_notes'],
    ['revisionCount', 'revision_count'],
  ]) {
    if (key in patch) {
      fields.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  await env.DB.prepare(`UPDATE guide_pipeline SET ${fields.join(', ')} WHERE id = ?`).bind(...values, id).run();
}

/* ───────────────────────── Topic selection ─────────────────────────────── */

/**
 * Step 1 of topic selection: today's capability gaps, joined against the
 * `cases` table on reports.title == cases.id (agent-base.js fileGapReport()
 * passes caseId as the report's `title` column) to recover the original
 * question's platform/category/kb_slug for domain mapping. Returns
 * candidates in the order they were flagged today.
 */
export async function getTodayGapTopicCandidates(env, dateStr) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT r.id AS report_id, r.project, c.platform, c.category, c.kb_slug, c.title AS case_title, c.description
     FROM reports r LEFT JOIN cases c ON c.id = r.title
     WHERE r.type = 'gap_hebrew' AND DATE(r.created_at) = ?
     ORDER BY r.created_at ASC`
  ).bind(dateStr).all();

  return results
    .filter((r) => r.case_title) // join miss (title wasn't a case id) — not a usable topic
    .map((r) => ({
      source: `gap:${r.report_id}`,
      project: r.project,
      platform: r.platform,
      kbSlug: r.kb_slug,
      title: r.case_title,
      description: r.description || '',
      domain: mapPlatformToDomain(r.platform, r.category),
    }));
}

/** Reads any file's raw content from this repo (read-only, same pattern as agent-runner.js fetchAssetBoard()). Returns '' on any failure. */
export async function fetchRawRepoFile(path) {
  return (await fetchRawRepoFileChecked(path)).text;
}

/**
 * The same read, with the ONE fact `fetchRawRepoFile()` throws away: whether
 * the read actually happened.
 *
 * ── AUDIT #14 / KFM-13, and this one had teeth (2026-08-16) ──────────────
 *
 * `fetchRawRepoFile()` returns `''` for a network error, a 404, a 500 and a
 * genuinely empty file alike. For `guides/TOPICS.md` that is harmless — an
 * empty topic list means "pick no topic today".
 *
 * For `guides/_verification-queue.md` it is a **silently lost write**, in two
 * places, and neither would raise anything:
 *
 *   agent-runner.js `processGuideReviewBlock()` — writes
 *   `[...existingQueue, ...newEntries]`. A failed read makes `existingQueue`
 *   empty, so the queue is REPLACED by just today's entries and every
 *   previously queued UNVERIFIED section disappears.
 *
 *   agent-runner.js `processGuideVerifyBlock()` — writes `remaining`. A failed
 *   read makes the entry list empty, and if anything triggers the write the
 *   whole queue is replaced with "no entries — every guide is currently
 *   stable."
 *
 * That queue is the office's record of claims it published but could not
 * verify. Erasing it does not merely lose data — it converts "we know these
 * sections are unverified" into "every guide is stable", which is a false
 * statement about published work, produced by a network blip.
 *
 * So the checked read is the one those two paths use, and they refuse to write
 * a queue they could not read. `ok:false` and an empty queue are different
 * facts and are now different values.
 *
 * @returns {Promise<{text: string, ok: boolean, reason: string|null}>}
 */
export async function fetchRawRepoFileChecked(path) {
  try {
    const res = await fetch(`${RAW_BASE}/${path}`);
    // 404 is `ok: true` with empty text — the file genuinely is not there,
    // which for a queue that has never been written is the correct reading and
    // must not be conflated with "could not reach GitHub".
    if (res.status === 404) return { text: '', ok: true, reason: 'not_found' };
    if (!res.ok) return { text: '', ok: false, reason: `http_${res.status}` };
    return { text: await res.text(), ok: true, reason: null };
  } catch (err) {
    return { text: '', ok: false, reason: `fetch_threw:${err?.message}` };
  }
}

/** Fetches guides/TOPICS.md's raw content from the repo. Returns '' on any failure. */
export async function fetchTopicsListText() {
  return fetchRawRepoFile('guides/TOPICS.md');
}

/**
 * Parses guides/TOPICS.md into { domain: [{slug, title, description}] },
 * in file order (the owner's stated priority order). Format:
 *   ## <domain>
 *   - `slug` — Title — description
 * Tolerant of a missing description (falls back to the title).
 */
export function parseTopicsMd(text) {
  const byDomain = {};
  let currentDomain = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^##\s+(\S+)/);
    if (headingMatch) {
      currentDomain = headingMatch[1].toLowerCase();
      if (!byDomain[currentDomain]) byDomain[currentDomain] = [];
      continue;
    }
    const itemMatch = line.match(/^-\s+`([a-z0-9-]+)`\s+—\s+(.+)$/);
    if (itemMatch && currentDomain) {
      const [, slug, rest] = itemMatch;
      const parts = rest.split(' — ');
      byDomain[currentDomain].push({
        slug,
        title: parts[0].trim(),
        description: (parts.slice(1).join(' — ') || parts[0]).trim(),
      });
    }
  }
  return byDomain;
}

/**
 * CLAUDE.md "Topic selection" — runs in guide_draft.
 *   1. Capability gaps first (today's gap_hebrew rows).
 *   2. ABSOLUTE ZERO blocklist — checked here for both gap and TOPICS.md
 *      candidates, so a gap can never sneak a blocked topic through.
 *   3. Fallback: guides/TOPICS.md in priority order, skipping topics that
 *      already have an approved guide or pending draft.
 *   4. Improve-don't-repeat: a REJECTED prior draft for the chosen topic
 *      becomes a revision task instead of a fresh write.
 * Returns null if nothing eligible was found today (log and move on).
 */
export async function selectGuideTopic(env, dateStr) {
  const gapCandidates = await getTodayGapTopicCandidates(env, dateStr);
  for (const candidate of gapCandidates) {
    if (!candidate.domain) continue; // no domain mapping — not a guide-worthy platform
    if (isBlocklisted(candidate)) continue;
    const slug = computeSlug(candidate.title);
    const prior = await getLatestGuidePipelineRowForSlug(env, slug);
    if (prior && (prior.status === 'approved' || prior.status === 'drafted' || prior.status === 'reviewing')) continue;
    return {
      source: candidate.source,
      project: candidate.project,
      platform: candidate.platform,
      domain: candidate.domain,
      title: candidate.title,
      description: candidate.description,
      slug,
      priorDraft: prior && prior.status === 'rejected'
        ? { draftContent: prior.draft_content, reviewNotes: prior.review_notes }
        : null,
    };
  }

  const topicsText = await fetchTopicsListText();
  const byDomain = parseTopicsMd(topicsText);
  for (const domain of DOMAIN_FOLDERS) {
    for (const entry of byDomain[domain] || []) {
      if (isBlocklisted({ title: entry.title, description: entry.description })) continue;
      const prior = await getLatestGuidePipelineRowForSlug(env, entry.slug);
      if (prior && (prior.status === 'approved' || prior.status === 'drafted' || prior.status === 'reviewing')) continue;
      return {
        source: `topics_md:${entry.slug}`,
        project: null,
        platform: domain,
        domain,
        title: entry.title,
        description: entry.description,
        slug: entry.slug,
        priorDraft: prior && prior.status === 'rejected'
          ? { draftContent: prior.draft_content, reviewNotes: prior.review_notes }
          : null,
      };
    }
  }

  return null;
}

/* ───────────────────────────── Draft prompt ─────────────────────────────── */

/**
 * Prompt sent as the user turn to the writer agent's queryGeminiDirect()
 * (already prepends that agent's persona system prompt — see agent-base.js
 * _buildPersonaSystemPrompt() — so no separate persona wiring is needed
 * here). Hard-requires English, a sources list, per-section confidence
 * markers, and a split recommendation instead of an oversized guide.
 */
export function buildDraftPrompt(topic, priorDraft) {
  const base = `Write a focused technical guide for an internal IT/cybersecurity knowledge archive.

Topic: ${topic.title}
Domain: ${topic.domain}
Context: ${topic.description || '(none provided beyond the title — use your own domain knowledge)'}

Requirements (all mandatory):
- English only.
- Target length: 3-5 pages (roughly 1200-2500 words). Never exceed 10 pages (~5000 words). If this topic genuinely cannot fit in 10 pages, do NOT write an oversized guide — instead reply with ONLY a line starting "SPLIT_RECOMMENDATION:" followed by a short explanation of how to split it into multiple guides, and nothing else.
- Structure: a short intro, clearly headed sections, and a concluding "## Sources" section listing what you drew on (real, plausible references — documentation, RFCs, vendor docs — not fabricated URLs you can't stand behind).
- After EVERY section heading, add one line in the exact form "Confidence: high" / "Confidence: medium" / "Confidence: low" rating your own certainty in that section's technical accuracy.
- Do not omit important details to hit a length target — prefer complete-but-tight over padded.
- Keep the technical content accurate and professional first; personality/voice is secondary.`;

  if (priorDraft) {
    return `${base}

This is a REVISION of a previously rejected draft. Rejection note from the editor:
"""${priorDraft.reviewNotes}"""

Previous draft:
"""${priorDraft.draftContent}"""

Rewrite the guide to fully address the rejection note above.`;
  }
  return base;
}

/** True if the writer's response is a split recommendation rather than a guide. */
export function isSplitRecommendation(text) {
  return /^SPLIT_RECOMMENDATION:/m.test(String(text || '').trim());
}

/* ───────────────────────────── Review (Architect) ───────────────────────── */

const ARCHITECT_REVIEW_SYSTEM = `You are the final editor for an internal technical knowledge archive. A draft guide was written by another persona; you are FINAL AUTHORITY, not a rubber stamp.

Fact-check the draft end to end, with EXTRA skepticism on any section the draft marks "Confidence: high" — the writer has repeatedly been wrong while confident, so a high-confidence marker is a reason to scrutinize harder, not a reason to trust more.

If you cannot verify a specific technical claim, mark that section explicitly "UNVERIFIED" in your final guide text (do not silently drop the confidence markers or the claim — mark it and keep it). Never guess at a fact you can't verify.

Respond in EXACTLY this format, nothing before or after:

DECISION: APPROVE | REVISE | REJECT
NOTES: <your editor notes — required for REVISE/REJECT, one or two sentences for APPROVE>
---GUIDE---
<the finalized guide markdown, ONLY when DECISION is APPROVE — omit this section entirely for REVISE/REJECT>

An APPROVE response MUST include the ---GUIDE--- marker followed by the COMPLETE finalized guide markdown — the guide text you output here is exactly what gets published, so never reply APPROVE with only notes, a summary, or a reference back to the draft. An APPROVE without a full guide body is invalid and will be discarded. Keep NOTES to one or two sentences on APPROVE so the guide itself gets the bulk of your output.`;

export function buildReviewPrompt(topic, draftContent, opts = {}) {
  const revisionNote = opts.isSecondPass
    ? '\n\nThis is the SECOND review pass after one revision round. If it still does not meet the bar, DECISION must be REJECT — there is no further revision round.'
    : '';
  return `Topic: ${topic.title}
Domain: ${topic.domain}

Draft to review:
"""
${draftContent}
"""${revisionNote}`;
}

/** Parses the Architect's structured response into a decision object. */
export function parseReviewDecision(text) {
  const raw = String(text || '');
  const decisionMatch = raw.match(/DECISION:\s*(APPROVE|REVISE|REJECT)/i);
  const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'REJECT';

  const guideSplitIndex = raw.indexOf('---GUIDE---');
  const notesBlock = guideSplitIndex >= 0 ? raw.slice(0, guideSplitIndex) : raw;
  const notesMatch = notesBlock.match(/NOTES:\s*([\s\S]*)$/);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  const finalGuide = guideSplitIndex >= 0 ? raw.slice(guideSplitIndex + '---GUIDE---'.length).trim() : '';

  return { decision, notes, finalGuide: decision === 'APPROVE' ? finalGuide : '' };
}

/** Scans an approved guide for "UNVERIFIED" section markers, for the verification queue. Returns [{section}]. */
export function extractUnverifiedSections(guideMarkdown) {
  const sections = [];
  const lines = String(guideMarkdown || '').split('\n');
  let currentHeading = '(intro)';
  for (const line of lines) {
    const headingMatch = line.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) currentHeading = headingMatch[1].trim();
    if (/UNVERIFIED/.test(line) && !sections.includes(currentHeading)) {
      sections.push(currentHeading);
    }
  }
  return sections;
}

/* ─────────────────────────── Rendering / files ──────────────────────────── */

/**
 * Byline header (CLAUDE.md: "Only personas that actually touched the guide
 * are named: writer persona + The Architect as final editor, plus date,
 * domain, and source gap/case ID when applicable").
 */
export function renderGuideFile({ topic, writerAgentName, finalGuide, dateStr }) {
  return `<!--
Written by: ${writerAgentName} (draft)
Finalized by: The Architect (final review + fact-check)
Date: ${dateStr}
Domain: ${topic.domain}
Source: ${topic.source}
-->

${finalGuide.trim()}
`;
}

export function renderRejectedDraftFile({ topic, writerAgentName, draftContent, reviewNotes, dateStr }) {
  return `# REJECTED DRAFT — editor's note

**Written by:** ${writerAgentName} · **Reviewed by:** The Architect · **Date:** ${dateStr} · **Domain:** ${topic.domain} · **Source:** ${topic.source}

**Rejection note:**

${reviewNotes || '_No note provided._'}

---

${draftContent.trim()}
`;
}

export function guidePath(domain, slug) {
  return `guides/${domain}/${slug}.md`;
}

export function draftPath(slug) {
  return `guides/_drafts/${slug}.md`;
}

/* ─────────────────────── Weekly verification (Saturday) ─────────────────── */

/** Parses guides/_verification-queue.md into entries: [{guidePath, section}]. Format: "- guides/x/y.md — Section Name". */
export function parseVerificationQueue(text) {
  const entries = [];
  for (const rawLine of String(text || '').split('\n')) {
    const match = rawLine.trim().match(/^-\s+(\S+\.md)\s+—\s+(.+)$/);
    if (match) entries.push({ guidePath: match[1], section: match[2].trim() });
  }
  return entries;
}

export function renderVerificationQueue(entries) {
  const header = '# Verification Queue\n\nEvery UNVERIFIED section across all guides. Appended when a guide with UNVERIFIED sections is finalized; entries removed once verified.\n\n';
  if (!entries.length) return `${header}_No entries — every guide is currently stable._\n`;
  return header + entries.map((e) => `- ${e.guidePath} — ${e.section}`).join('\n') + '\n';
}

export async function fetchVerificationQueueText() {
  return fetchRawRepoFile('guides/_verification-queue.md');
}

/**
 * The verification queue read that says whether it worked. Every caller that
 * WRITES the queue back must use this one and refuse on `ok: false` — see
 * fetchRawRepoFileChecked()'s header for what happens otherwise.
 */
export async function fetchVerificationQueueChecked() {
  return fetchRawRepoFileChecked('guides/_verification-queue.md');
}

/**
 * Replaces one ##/### section's body (heading through the line before the
 * next same-or-higher-level heading) with `newSectionText`, used to write a
 * freshly-verified section back into a guide. Leaves the markdown untouched
 * if the heading can't be found (defensive — a guide should never silently
 * lose a section because a heading string didn't match exactly).
 */
export function replaceGuideSection(guideMarkdown, sectionHeading, newSectionText) {
  const lines = String(guideMarkdown).split('\n');
  const escaped = String(sectionHeading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRegex = new RegExp(`^#{2,3}\\s+${escaped}\\s*$`, 'i');

  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === -1 && headingRegex.test(lines[i].trim())) {
      start = i;
      continue;
    }
    if (start !== -1 && /^#{2,3}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) return guideMarkdown;

  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  return [before, newSectionText.trim(), after].filter(Boolean).join('\n\n');
}

/** Picks up to n queue entries for one weekly verification pass. */
export function pickVerificationQueueItems(entries, n = 2) {
  return entries.slice(0, n);
}

const VERIFY_SYSTEM = `You are fact-checking one section of a previously published technical guide, marked UNVERIFIED because the original reviewer could not confirm it. Use web search to find current, authoritative grounding. Respond in EXACTLY this format:

RESULT: VERIFIED | STILL_UNVERIFIED
UPDATED_SECTION: <the corrected section text, English, same heading level — ONLY when RESULT is VERIFIED>`;

export function buildVerifyPrompt(guideMarkdown, section) {
  return `Guide content:
"""
${guideMarkdown}
"""

Section to verify: "${section}" (currently marked UNVERIFIED)`;
}

export function parseVerifyResult(text) {
  const raw = String(text || '');
  const resultMatch = raw.match(/RESULT:\s*(VERIFIED|STILL_UNVERIFIED)/i);
  const result = resultMatch ? resultMatch[1].toUpperCase() : 'STILL_UNVERIFIED';
  const updatedMatch = raw.match(/UPDATED_SECTION:\s*([\s\S]*)$/);
  return { verified: result === 'VERIFIED', updatedSection: updatedMatch ? updatedMatch[1].trim() : '' };
}

export { VERIFY_SYSTEM, ARCHITECT_REVIEW_SYSTEM, pad };
