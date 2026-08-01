#!/usr/bin/env node
// Dry-run verification for the Guides pipeline. No network calls, no D1/KV,
// no model calls — pure logic checks against the real config files and
// workers/guide-engine.js (which has no JSON imports of its own, so it loads
// fine under plain `node` — same reasoning as scripts/verify-qa-engine.js's
// header comment for qa-topics.js/gap-reports.js/gemini-pacer.js).
//
// Run: node scripts/verify-guide-engine.js

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  DOMAIN_FOLDERS, BLOCKLIST_KEYWORDS, isBlocklisted, mapPlatformToDomain, pickWriterAgentId,
  computeSlug, parseTopicsMd, buildDraftPrompt, isSplitRecommendation, parseReviewDecision,
  extractUnverifiedSections, renderGuideFile, renderRejectedDraftFile, guidePath, draftPath,
  parseVerificationQueue, renderVerificationQueue, replaceGuideSection, ARCHITECT_REVIEW_SYSTEM,
} from '../workers/guide-engine.js';

const require = createRequire(import.meta.url);
const tokenEconomy = require('../config/token-economy.json');
const dailySchedule = require('../config/daily-schedule.json');
const agentsConfig = require('../config/agents-config.json');
const projectPermissions = require('../config/project-permissions.json');

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`[PASS] ${label}`);
    pass += 1;
  } else {
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

console.log('=== Guides pipeline verification — dry-run only, no network/model/D1/KV calls ===\n');

/* ── Blocklist enforcement ─────────────────────────────────────────────── */
console.log('--- Blocklist enforcement (1COM/MirtaPBX/Netvill/cloud-telephony) ---');

check('blocklist keywords cover 1com/mirtapbx/netvill/voip/sip/pbx',
  ['1com', 'mirtapbx', 'netvill', 'voip', 'sip', 'pbx'].every((kw) => BLOCKLIST_KEYWORDS.includes(kw)));

check('a 1com-platform topic is blocked', isBlocklisted({ platform: '1com', title: 'Diagnosing an extension' }));
check('a mirtapbx kbSlug topic is blocked', isBlocklisted({ kbSlug: 'kb-mirtapbx', title: 'Cluster sync' }));
check('a title mentioning Netvill is blocked', isBlocklisted({ title: 'Netvill onboarding guide' }));
check('a plain firewall topic is NOT blocked', !isBlocklisted({ platform: 'firewall', title: 'Auditing a firewall rule base' }));
check('a plain windows topic is NOT blocked', !isBlocklisted({ platform: 'windows', title: 'Event Viewer basics' }));

/* ── Domain mapping + folder set ────────────────────────────────────────── */
console.log('\n--- Domain folder set + platform mapping ---');

const EXPECTED_FOLDERS = ['networking', 'firewall', 'windows', 'ai', 'linux', 'cloud', 'cybersecurity'];
check('DOMAIN_FOLDERS matches the CLAUDE.md-specified 7 folders exactly',
  EXPECTED_FOLDERS.every((f) => DOMAIN_FOLDERS.includes(f)) && DOMAIN_FOLDERS.length === EXPECTED_FOLDERS.length,
  `got: ${DOMAIN_FOLDERS.join(', ')}`);

check('platform "linux" maps to domain "linux"', mapPlatformToDomain('linux') === 'linux');
check('platform "windows" maps to domain "windows"', mapPlatformToDomain('windows') === 'windows');
check('platform "vpn" maps to domain "networking"', mapPlatformToDomain('vpn') === 'networking');
check('platform "cloud-devops" maps to domain "cloud"', mapPlatformToDomain('cloud-devops') === 'cloud');
check('platform "security" maps to domain "cybersecurity"', mapPlatformToDomain('security') === 'cybersecurity');
check('an unmapped/VoIP platform (e.g. "1com") maps to null', mapPlatformToDomain('1com') === null);

/* ── Writer persona mapping ─────────────────────────────────────────────── */
console.log('\n--- Writer persona mapping (matches CLAUDE.md "Writer persona by domain") ---');

check('firewall -> Agent 6 (The QA)', pickWriterAgentId('firewall') === 6);
check('vpn -> Agent 6 (The QA)', pickWriterAgentId('vpn') === 6);
check('cybersecurity -> Agent 8 (The Lead QA)', pickWriterAgentId('cybersecurity') === 8);
check('networking -> Agent 8 (The Lead QA)', pickWriterAgentId('networking') === 8);
check('windows (remainder) -> Agent 7 (The Team Lead)', pickWriterAgentId('windows') === 7);
check('ai (remainder) -> Agent 7 (The Team Lead)', pickWriterAgentId('ai') === 7);
check('linux (remainder) -> Agent 7 (The Team Lead)', pickWriterAgentId('linux') === 7);
check('cloud (remainder) -> Agent 7 (The Team Lead)', pickWriterAgentId('cloud') === 7);

for (const id of [6, 7, 8]) {
  check(`writer persona agent ${id} exists in agents-config.json`, agentsConfig.agents.some((a) => a.id === id));
}

/* ── TOPICS.md parsing + slugs ──────────────────────────────────────────── */
console.log('\n--- guides/TOPICS.md parsing ---');

const topicsMdText = readFileSync(new URL('../guides/TOPICS.md', import.meta.url), 'utf8');
const parsedTopics = parseTopicsMd(topicsMdText);

for (const domain of EXPECTED_FOLDERS) {
  check(`TOPICS.md has at least one seeded topic under "${domain}"`, (parsedTopics[domain] || []).length > 0,
    `got ${(parsedTopics[domain] || []).length}`);
}
check('TOPICS.md has multiple Windows topics (Windows never arrives via gaps)', (parsedTopics.windows || []).length >= 3,
  `got ${(parsedTopics.windows || []).length}`);

const allParsedTopics = Object.values(parsedTopics).flat();
check('no TOPICS.md entry is blocklisted', allParsedTopics.every((t) => !isBlocklisted(t)));
check('every TOPICS.md entry has a non-empty slug/title/description',
  allParsedTopics.every((t) => t.slug && t.title && t.description));

check('computeSlug() produces a stable kebab-case slug', computeSlug('Diagnosing a Firewall Rule!') === 'diagnosing-a-firewall-rule');

/* ── Draft prompt requirements ──────────────────────────────────────────── */
console.log('\n--- Draft prompt (English/sources/confidence/split) ---');

const sampleTopic = { title: 'Sample Topic', domain: 'linux', description: 'A sample.' };
const draftPromptText = buildDraftPrompt(sampleTopic, null);
check('draft prompt requires English only', /English only/i.test(draftPromptText));
check('draft prompt requires a Sources section', /Sources/i.test(draftPromptText));
check('draft prompt requires per-section confidence markers', /Confidence: high/i.test(draftPromptText));
check('draft prompt requires a split recommendation instead of an oversized guide', /SPLIT_RECOMMENDATION/i.test(draftPromptText));
check('draft prompt mentions the 10-page hard ceiling', /10 pages/i.test(draftPromptText));

const revisionPrompt = buildDraftPrompt(sampleTopic, { draftContent: 'old draft', reviewNotes: 'fix X' });
check('revision-mode prompt includes the prior rejection note', revisionPrompt.includes('fix X'));
check('revision-mode prompt includes the previous draft', revisionPrompt.includes('old draft'));

check('isSplitRecommendation() detects the sentinel', isSplitRecommendation('SPLIT_RECOMMENDATION: this is too broad'));
check('isSplitRecommendation() is false for a normal guide', !isSplitRecommendation('# A Guide\n\nSome content.'));

/* ── Review decision parsing ────────────────────────────────────────────── */
console.log('\n--- Architect review decision parsing ---');

check('ARCHITECT_REVIEW_SYSTEM demands extra skepticism on high-confidence sections',
  /extra skepticism/i.test(ARCHITECT_REVIEW_SYSTEM) && /Confidence: high/i.test(ARCHITECT_REVIEW_SYSTEM));
check('ARCHITECT_REVIEW_SYSTEM requires an explicit UNVERIFIED marker, never a guess',
  /UNVERIFIED/.test(ARCHITECT_REVIEW_SYSTEM) && /[Nn]ever guess/i.test(ARCHITECT_REVIEW_SYSTEM));

const approveText = 'DECISION: APPROVE\nNOTES: Looks solid.\n---GUIDE---\n# Final Guide\n\nBody text.';
const approveDecision = parseReviewDecision(approveText);
check('parses APPROVE decision', approveDecision.decision === 'APPROVE');
check('extracts the final guide body after ---GUIDE---', approveDecision.finalGuide.includes('# Final Guide'));

const reviseText = 'DECISION: REVISE\nNOTES: Section 2 is wrong about MTU sizes.';
const reviseDecision = parseReviewDecision(reviseText);
check('parses REVISE decision', reviseDecision.decision === 'REVISE');
check('REVISE carries no finalGuide (nothing to commit yet)', reviseDecision.finalGuide === '');

const rejectText = 'DECISION: REJECT\nNOTES: Fundamentally off-topic.';
check('parses REJECT decision', parseReviewDecision(rejectText).decision === 'REJECT');

check('unparseable/garbled review text defaults to REJECT (fail closed, never auto-publish)',
  parseReviewDecision('not the expected format at all').decision === 'REJECT');

/* ── UNVERIFIED extraction + verification queue ─────────────────────────── */
console.log('\n--- UNVERIFIED extraction + verification queue ---');

const guideWithUnverified = `# Guide\n\n## Section A\nConfidence: high\nSome text.\n\n## Section B\nConfidence: low (UNVERIFIED)\nSome other text.\n`;
const unverified = extractUnverifiedSections(guideWithUnverified);
check('extracts exactly the UNVERIFIED section heading', unverified.length === 1 && unverified[0] === 'Section B',
  JSON.stringify(unverified));

const queueMd = renderVerificationQueue([{ guidePath: 'guides/linux/x.md', section: 'Section B' }]);
check('rendered queue contains the guide path and section', queueMd.includes('guides/linux/x.md') && queueMd.includes('Section B'));
const reparsedQueue = parseVerificationQueue(queueMd);
check('round-trips through parseVerificationQueue()', reparsedQueue.length === 1 && reparsedQueue[0].section === 'Section B');

const emptyQueueMd = renderVerificationQueue([]);
check('empty queue renders a stable "no entries" message', /no entries/i.test(emptyQueueMd));

const replaced = replaceGuideSection(guideWithUnverified, 'Section B', 'Confirmed via RFC 1234.');
check('replaceGuideSection() replaces only the targeted section body', replaced.includes('Confirmed via RFC 1234.') && replaced.includes('## Section A'));
check('replaceGuideSection() leaves the guide untouched if the heading is not found',
  replaceGuideSection(guideWithUnverified, 'Nonexistent Section', 'x') === guideWithUnverified);

/* ── File paths + byline header ─────────────────────────────────────────── */
console.log('\n--- File paths + byline rendering ---');

check('guidePath() builds guides/<domain>/<slug>.md', guidePath('linux', 'my-slug') === 'guides/linux/my-slug.md');
check('draftPath() builds guides/_drafts/<slug>.md', draftPath('my-slug') === 'guides/_drafts/my-slug.md');

const rendered = renderGuideFile({
  topic: { domain: 'linux', source: 'gap:abc123' },
  writerAgentName: 'The Team Lead',
  finalGuide: '# A Guide\n\nBody.',
  dateStr: '2026-08-02',
});
check('rendered guide names the writer persona', rendered.includes('The Team Lead'));
check('rendered guide names The Architect as final editor', rendered.includes('The Architect'));
check('rendered guide records the date/domain/source', rendered.includes('2026-08-02') && rendered.includes('linux') && rendered.includes('gap:abc123'));

const rejectedRendered = renderRejectedDraftFile({
  topic: { domain: 'windows', source: 'topics_md:x' }, writerAgentName: 'The Team Lead',
  draftContent: 'draft body', reviewNotes: 'not good enough', dateStr: '2026-08-02',
});
check('rejected-draft file includes the rejection note at the top', rejectedRendered.trim().startsWith('# REJECTED DRAFT') && rejectedRendered.includes('not good enough'));

/* ── Budget-key isolation (qa vs guides) ─────────────────────────────────── */
console.log('\n--- Budget-key isolation (component: qa vs guides) ---');

check('guides_claude_budget block exists in token-economy.json', !!tokenEconomy.guides_claude_budget);
check('guides_claude_budget has its own $4.50 soft-stop (independent of shared_claude_budget)',
  tokenEconomy.guides_claude_budget?.cap_usd_per_month === 4.5);
check('shared_claude_budget (qa) is UNCHANGED at $4.50', tokenEconomy.shared_claude_budget?.cap_usd_per_month === 4.5);
check('app_search_model no longer claims the stale claude-sonnet-4-6', tokenEconomy.app_search_model !== 'anthropic/claude-sonnet-4-6');
check('app_search_model is Sonnet 5', tokenEconomy.app_search_model === 'anthropic/claude-sonnet-5');

const modelRouterSrc = readFileSync(new URL('../workers/model-router.js', import.meta.url), 'utf8');
check('model-router.js getClaudeBudgetStatus/recordClaudeSpend accept a component option',
  /getClaudeBudgetStatus\(env, \{ asOf = new Date\(\), component = 'qa' \}/.test(modelRouterSrc) &&
  /recordClaudeSpend\(env, \{ inputTokens, outputTokens, asOf = new Date\(\), component = 'qa' \}/.test(modelRouterSrc));
check('model-router.js month key branches on component (qa vs guides)',
  /component === 'guides'.*#guides/s.test(modelRouterSrc) || modelRouterSrc.includes("`${base}#guides`"));

const claudeClientSrc = readFileSync(new URL('../workers/claude-client.js', import.meta.url), 'utf8');
check('claude-client.js targets claude-sonnet-5', claudeClientSrc.includes("CLAUDE_MODEL = 'claude-sonnet-5'"));
check('claude-client.js calls api.anthropic.com directly (not the APP_API service binding)',
  claudeClientSrc.includes('https://api.anthropic.com/v1/messages'));
check('claude-client.js never imports Groq or Gemini clients (no Groq anywhere in this pipeline)',
  !/groq-client|gemini-client/i.test(claudeClientSrc));

/* ── Schedule-block wiring ──────────────────────────────────────────────── */
console.log('\n--- daily-schedule.json block wiring ---');

function hasBlock(schedule, time, type) {
  return schedule.blocks.some((b) => b.time === time && b.type === type);
}

check('Sun-Thu: guide_draft at 16:00', hasBlock(dailySchedule.full_day_schedule, '16:00', 'guide_draft'));
check('Sun-Thu: guide_draft is ordered AFTER the 16:00 report block',
  dailySchedule.full_day_schedule.blocks.findIndex((b) => b.time === '16:00' && b.type === 'report') <
  dailySchedule.full_day_schedule.blocks.findIndex((b) => b.time === '16:00' && b.type === 'guide_draft'));
check('Sun-Thu: guide_review at 16:30', hasBlock(dailySchedule.full_day_schedule, '16:30', 'guide_review'));

check('Friday: guide_draft at 10:30 (after the Friday report block)',
  hasBlock(dailySchedule.friday_schedule, '10:30', 'guide_draft') &&
  dailySchedule.friday_schedule.blocks.findIndex((b) => b.time === '10:30' && b.type === 'report') <
  dailySchedule.friday_schedule.blocks.findIndex((b) => b.time === '10:30' && b.type === 'guide_draft'));
check('Friday: guide_review at 12:00', hasBlock(dailySchedule.friday_schedule, '12:00', 'guide_review'));

check('Saturday: guide_verify at 08:00', hasBlock(dailySchedule.saturday_schedule, '08:00', 'guide_verify'));
check('Saturday schedule label documents the "no longer zero-API-calls" reality',
  /guide|verif/i.test(dailySchedule.saturday_schedule.label));
check('week_mapping Saturday entry no longer claims a blanket "no Gemini/Claude calls"',
  !/Saturday \(off — idle only, no Gemini\/Claude calls\)/.test(dailySchedule._meta.week_mapping['7']));

const agentRunnerSrc = readFileSync(new URL('../workers/agent-runner.js', import.meta.url), 'utf8');
check('agent-runner.js dispatches guide_draft/guide_review/guide_verify block types',
  agentRunnerSrc.includes("block.type === 'guide_draft'") &&
  agentRunnerSrc.includes("block.type === 'guide_review'") &&
  agentRunnerSrc.includes("block.type === 'guide_verify'"));
check('agent-runner.js commits approved guides via the existing guarded commitFileToRepo()',
  /processGuideReviewBlock[\s\S]{0,6000}commitFileToRepo\(/.test(agentRunnerSrc));
check('agent-runner.js never escalates a rejected guide to a GitHub Issue',
  !/processGuideReviewBlock[\s\S]{0,7000}fileGitHubIssue\(/.test(agentRunnerSrc));

/* ── Kill-switch gate (guides_enabled, added 2026-08-02) ────────────────── */
console.log('\n--- Kill-switch gate (guides_enabled) ---');
check('guidesEnabled() reads simulation-state and defaults CLOSED (=== true, so absent flag means off)',
  /async function guidesEnabled\(env\)[\s\S]{0,200}guides_enabled === true/.test(agentRunnerSrc));
for (const fn of ['processGuideDraftBlock', 'processGuideReviewBlock', 'processGuideVerifyBlock']) {
  check(`${fn} checks the gate at the top (bypassGate opt honoured, guides_disabled no-op otherwise)`,
    new RegExp(`(async function|const) ${fn}[\\s\\S]{0,400}bypassGate[\\s\\S]{0,120}guidesEnabled\\(env\\)[\\s\\S]{0,250}guides_disabled`).test(agentRunnerSrc));
}
check('scheduled dispatch does NOT bypass the gate (no bypassGate on the block.type call sites)',
  !/block\.type === 'guide_(draft|review|verify)'[\s\S]{0,200}bypassGate/.test(agentRunnerSrc));
check('guides_toggle admin trigger exists (flag flip without redeploy)',
  /case 'guides_toggle':[\s\S]{0,600}guides_enabled: !!body\.enabled/.test(agentRunnerSrc));
check('guide_block supervised trigger exists and passes bypassGate for all three handlers',
  /case 'guide_block':[\s\S]{0,1500}processGuideDraftBlock\(env, todayDateStr\(\), \{ bypassGate: true \}\)[\s\S]{0,600}processGuideVerifyBlock\(env, \{ bypassGate: true \}\)/.test(agentRunnerSrc));
check('guides_enabled is whitelisted in updateSimulationState',
  /allowedKeys = \[[^\]]*'guides_enabled'[^\]]*\]/.test(agentRunnerSrc));
check('review self-heal passes the gate decision through (inner draft call uses bypassGate)',
  /processGuideReviewBlock[\s\S]{0,900}processGuideDraftBlock\(env, dateStr, \{ bypassGate: true \}\)/.test(agentRunnerSrc));

/* ── Fail-closed publish guards (2026-08-01 first-supervised-run bug) ───── */
console.log('\n--- Fail-closed publish guards ---');
check('review prompt explicitly requires the full guide body on APPROVE (invalid without it)',
  /APPROVE response MUST include the ---GUIDE--- marker[\s\S]{0,400}invalid/.test(
    readFileSync(new URL('../workers/guide-engine.js', import.meta.url), 'utf8')));
check('APPROVE with a missing/implausibly-short guide body never commits (approve_without_guide_body)',
  /finalGuide\.trim\(\)\.length < 500[\s\S]{0,600}approve_without_guide_body/.test(agentRunnerSrc) &&
  agentRunnerSrc.indexOf('approve_without_guide_body') < agentRunnerSrc.indexOf("decision.decision === 'APPROVE') {\n    const finalMarkdown"));
check('review call fails on a max_tokens-truncated response instead of parsing a fragment',
  /maxTokens: 8192[\s\S]{0,700}stopReason === 'max_tokens'[\s\S]{0,300}truncated/.test(agentRunnerSrc));
check('verify call never splices a max_tokens-truncated section into a published guide',
  /processGuideVerifyBlock[\s\S]{0,3000}stopReason === 'max_tokens'[\s\S]{0,300}continue;/.test(agentRunnerSrc));

/* ── Permissions — nothing loosens ──────────────────────────────────────── */
console.log('\n--- Permissions unchanged ---');

check('automated_code_write stays false', projectPermissions.automated_code_write === false);
check('office-agents push stays true (guides commit through the same path as gap digests)',
  projectPermissions['office-agents']?.push === true);

const permissionGuardSrc = readFileSync(new URL('../workers/permission-guard.js', import.meta.url), 'utf8');
check('.md is NOT in the code-file extension guard (guides commit like any other report)',
  !permissionGuardSrc.match(/CODE_FILE_EXTENSIONS[\s\S]*?\]/)[0].includes("'.md'"));

/* ── Summary ─────────────────────────────────────────────────────────── */
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('MISMATCH — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('All scenarios matched expectations.');
  process.exit(0);
}
