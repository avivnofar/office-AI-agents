#!/usr/bin/env node
/**
 * scripts/verify-hebrew-summary.js — OFFICE-POLICY.md A9, proved rather than
 * claimed.
 *
 * Run: node scripts/verify-hebrew-summary.js
 *
 * NO NETWORK — `workers/hebrew-summary.js` is a pure module (imports
 * nothing, its own file's rule) and is loaded directly here, the same way
 * `verify-owner-channel.js` loads `owner-channel.js`. The tripwire below
 * proves it, rather than merely trusting the header comment.
 *
 * This file checks the PURE prompt-building and text-layering functions.
 * It does not and cannot prove the live Gemini call composes fluent Hebrew
 * — that is unverifiable without a network call, same limitation every
 * other *-summary/*-composition verifier in this repo carries.
 */

import {
  HEBREW_SYSTEM_PROMPT, buildDailyHeadlinePrompt, withDailyHeadline,
  buildWeeklySummaryPrompt, withWeeklySummary,
} from '../workers/hebrew-summary.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

globalThis.fetch = () => { throw new Error('TRIPWIRE: verify-hebrew-summary.js made a network call. It must not.'); };

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n--- ${title} ---`); }

const HEBREW_RE = /[֐-׿]/;

/* ── §1 the system prompt actually demands Hebrew ─────────────────────── */
section('§1 the system prompt');

check('HEBREW_SYSTEM_PROMPT is itself written in Hebrew (not an English instruction ABOUT Hebrew)', HEBREW_RE.test(HEBREW_SYSTEM_PROMPT));
check('…and it forbids English explicitly', /אנגלית/.test(HEBREW_SYSTEM_PROMPT));
check('…and it carves out the one unavoidable exception — task ids like OB-001', /OB-001/.test(HEBREW_SYSTEM_PROMPT));

/* ── §2 the daily headline prompt ──────────────────────────────────────── */
section('§2 daily headline — one question, names a concrete item or says there is none');

{
  const sampleMarkdown = '# Day 47 Summary\n\n## Case Handling\n\n- Agent 1: 12/12 cases, mood HAPPY\n\n## Daily Standup\n\nEverything is fine.\n';
  const prompt = buildDailyHeadlinePrompt(sampleMarkdown);
  check('the prompt is written in Hebrew', HEBREW_RE.test(prompt));
  check('…and it embeds the REAL rendered markdown, not a re-derivation of it', prompt.includes(sampleMarkdown));
  check('…and it asks for the one-question shape A9 requires (concrete item OR explicit "none")', /תשומת/.test(prompt) && /אין דבר/.test(prompt));
  check('…and it asks for SHORT (2-5 lines), matching A9\'s "Short"', /2-5/.test(prompt));

  check('buildDailyHeadlinePrompt tolerates a missing/undefined markdown rather than throwing', typeof buildDailyHeadlinePrompt(undefined) === 'string');
}

/* ── §3 layering — one file, two layers, never two copies ─────────────── */
section('§3 withDailyHeadline / withWeeklySummary — layering, not a second file');

{
  const body = '# Day 47 Summary\n\nEnglish content here.';
  const hebrew = 'אין דבר שדורש את תשומת לבך היום.';
  const layered = withDailyHeadline(body, hebrew);
  check('the Hebrew layer is PREPENDED, above the English body', layered.indexOf(hebrew) < layered.indexOf('English content here.'));
  check('…the English body survives UNCHANGED beneath it (never a translation, never a rewrite)', layered.includes(body));
  check('…it is ONE string, not two files worth of content concatenated with any marker implying a second document', !/two copies|SECOND FILE/i.test(layered));

  check('[FAILS-OLD] a failed/empty composition returns the ORIGINAL markdown unchanged — the pre-A9 state, degrading gracefully rather than blocking the report',
    withDailyHeadline(body, '') === body && withDailyHeadline(body, null) === body && withDailyHeadline(body, undefined) === body);

  const weeklyBody = '## At a glance\n\nEnglish weekly report body.\n\n<!-- END OF REPORT -->';
  const weeklyHebrew = 'תקציר בעברית של השבוע.';
  const weeklyLayered = withWeeklySummary(weeklyBody, weeklyHebrew);
  check('the weekly layer is prepended above the English body too', weeklyLayered.indexOf(weeklyHebrew) < weeklyLayered.indexOf('English weekly report body.'));
  check('…and the sentinel/structure the report-pipeline gate checks survives intact beneath it', weeklyLayered.includes('<!-- END OF REPORT -->') && weeklyLayered.includes('## At a glance'));
  check('[FAILS-OLD] a failed weekly composition also degrades to the English body alone, unchanged',
    withWeeklySummary(weeklyBody, '') === weeklyBody);
}

/* ── §4 weekly prompt — a judgement, explicitly not a translation ─────── */
section('§4 weekly executive summary — "not a translation"');

{
  const englishReport = '## At a glance\n\nThis week the office shipped three guides and closed OB-041.';
  const prompt = buildWeeklySummaryPrompt(englishReport, { periodLabel: 'week-08' });
  check('the prompt is written in Hebrew', HEBREW_RE.test(prompt));
  check('…and it explicitly says NOT to translate', /אל תתרגם/.test(prompt));
  check('…and it embeds the real reviewed report body', prompt.includes(englishReport));
  check('…and it names the period label when given', prompt.includes('week-08'));
  check('…and asks for judgement of what is significant, not a full recap', /שיפוט|משמעותי/.test(prompt));

  const noLabel = buildWeeklySummaryPrompt(englishReport, {});
  check('period label is optional — omitting it does not throw or leave a literal "undefined"', !/undefined/.test(noLabel));
}

/* ── §5 the honestly-scoped divergence is stated in the source, not just here ── */
section('§5 the "entirely" gap is documented in the module itself');

{
  const src = read('workers/hebrew-summary.js');
  check('the module\'s own header states "entirely" is NOT literal for the daily report', /"Entirely" is not literal/.test(src));
  check('…and explains WHY (the operational log is template-rendered, deliberately free of a model call)', /NO model call/.test(src));
  check('…and says this is flagged rather than silently claimed done', /Flagged here/.test(src));
}

/* ── §6 wiring — the calling path exists, not just the module (OB-001) ───── */
section('§6 wiring — on the calling path, not merely defined nearby');

{
  const runnerSrc = read('workers/agent-runner.js');
  check('agent-runner.js imports the module', /from '\.\/hebrew-summary\.js'/.test(runnerSrc));
  check('composeDailyHeadline() exists and is called at the daily-summary commit path', /async function composeDailyHeadline/.test(runnerSrc) && (runnerSrc.match(/composeDailyHeadline\(env, markdown, isOffDay\)/g) || []).length >= 2);
  check('…it is guarded on isOffDay — no model call on a Saturday whose result is thrown away (A13)', /if \(isOffDay\) return markdown;/.test(runnerSrc));
  check('the weekly path calls buildWeeklySummaryPrompt/withWeeklySummary inside runReportPipeline()', /buildWeeklySummaryPrompt\(finalReport/.test(runnerSrc) && /withWeeklySummary\(finalReport/.test(runnerSrc));
  check('…AFTER the structural gate (validateReportBody) has already run — the Hebrew layer never precedes the check it must not break',
    runnerSrc.indexOf('structural.ok') < runnerSrc.indexOf('buildWeeklySummaryPrompt(finalReport'));
  check('…and "only Gemini writes Hebrew" — the call is DIRECT (queryGeminiDirect), never the routed hebrew_composition lane',
    /path: 'queryGeminiDirect', provider: 'gemini', agentId: row\.drafter_agent_id/.test(runnerSrc)
    && /path: 'queryGeminiDirect', provider: 'gemini', agentId: 12/.test(runnerSrc));
  check('a failed Hebrew composition is logged LOUDLY (console.warn), not swallowed',
    /A9 Hebrew (executive summary|headline) NOT composed/.test(runnerSrc));
}

/* ════════════════════════════════ summary ══════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`
  PROVEN HERE:   the prompts are Hebrew, forbid English, ask the exact
                 question A9 requires; layering prepends rather than
                 replacing or duplicating; a failed composition degrades to
                 the English body unchanged rather than blocking the report;
                 the calling path exists in agent-runner.js, guarded on
                 A13's rest day, sequenced after the structural gate, and
                 always the direct Gemini path.
  NOT PROVEN:    that a live Gemini call actually returns fluent, correct
                 Hebrew for real content. That requires a network call this
                 verifier deliberately does not make.
  SCOPE, STATED: the daily report is NOT "entirely" Hebrew — a short Hebrew
                 headline is prepended above the still-English operational
                 log. See workers/hebrew-summary.js's header for why, and
                 report this session's write-up for the honest accounting.
${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
