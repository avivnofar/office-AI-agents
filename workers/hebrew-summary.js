/**
 * workers/hebrew-summary.js — OFFICE-POLICY.md A9, wired.
 *
 * "Daily report — Hebrew, entirely. Short. It answers one question: what
 * needs the owner's attention. It must name at least one concrete item or
 * state explicitly that there is none."
 * "Weekly report — English body, Hebrew executive summary at the top...
 * Not a translation — written to answer what he needs to know. One file,
 * two layers. Never two copies."
 *
 * Written 2026-08-11 (Audit-and-Fix session, Phase 4). A9 was specified and
 * had no calling path anywhere in the actual output — another documented
 * mechanism nobody wired. Pure module (imports nothing, this project's
 * standing rule for exactly this reason) so scripts/verify-* can load it
 * under plain node; the actual Gemini call lives in agent-runner.js's
 * callReportModel(), the same split the draft/review pipeline already uses.
 *
 * "Only Gemini writes Hebrew" (2026-07-19 routing fix, agent-base.js
 * flagCapabilityGap()) — this module follows the same rule: the caller is
 * expected to reach it via the DIRECT queryGeminiDirect() call shape, not
 * the routed hebrew_composition lane (which would let Mistral answer on a
 * backup, and hebrew_composition has no live call site anywhere in this
 * repo — see CAPABILITY-TOOLBOX.md).
 *
 * ── SCOPE, STATED HONESTLY ────────────────────────────────────────────
 *
 * "Entirely" is not literal for the daily report. day-NNN-summary.md
 * (agent-runner.js renderDailySummary()) is a structured operational log —
 * per-agent case stats, a verbatim standup transcript (itself English prose
 * from a SEPARATE model call), a branch section, a schedule section — built
 * by a template with NO model call, deliberately kept that way so it can
 * render for free even on a Saturday A13 forbids spending tokens on.
 * Converting the WHOLE file to Hebrew would mean either hardcoding Hebrew
 * labels through every one of those sub-renderers (mechanical, but large,
 * and easy to get subtly wrong across many call sites in one session) or
 * running the entire rendered document through a model (which stops being
 * free and stops being a template — a real design change, not a wiring
 * fix). Neither is what this session builds.
 *
 * What IS built: a short Hebrew block, composed by Gemini, PREPENDED above
 * the existing English body — the same "one file, two layers" shape the
 * weekly report uses below. It satisfies A9's functional core (a short
 * Hebrew answer to "what needs the owner's attention", naming a concrete
 * item or saying there is none) even though the operational log beneath it
 * stays English. Flagged here, in code, rather than silently claimed as
 * "entirely" done — the same posture this project's CLAUDE.md takes with
 * its own flagged-divergence block.
 */

export const HEBREW_SYSTEM_PROMPT = 'ענה אך ורק בעברית. אל תשתמש באנגלית כלל, '
  + 'מלבד שמות פרויקטים או מזהי משימות (כגון OB-001) שאין להם תרגום. '
  + 'אל תוסיף הקדמות, כותרות או חתימות — רק התוכן המבוקש עצמו.';

/**
 * The daily headline prompt. Fed the WHOLE rendered day-summary (English) so
 * the model has real material to judge, not a re-derivation of it — same
 * "read the artifact, don't guess" posture the review half of the report
 * pipeline already keeps.
 */
export function buildDailyHeadlinePrompt(markdown) {
  return 'להלן סיכום יומי מלא של המשרד (באנגלית). כתוב תקציר קצר בעברית (2-5 שורות) '
    + 'שעונה על שאלה אחת בלבד: מה דורש את תשומת הלב של הבעלים היום? '
    + 'אם יש פריט קונקרטי אחד לפחות שדורש תשומת לב (בעיה, חסימה, סיכון, או משהו שממתין '
    + 'להחלטה שלו) — ציין אותו במפורש, בשמו. אם באמת אין שום דבר שדורש תשומת לב — אמור '
    + 'זאת במפורש ("אין דבר שדורש את תשומת לבך היום"). אל תסכם את כל היום ואל תחזור על '
    + 'המספרים שכבר מופיעים למטה — רק מה שבאמת חשוב.\n\n---\n\n' + String(markdown || '');
}

/**
 * Layers the composed Hebrew block above the existing English day-summary.
 * `hebrewText` empty/falsy (a failed or skipped composition) returns the
 * markdown UNCHANGED — this is a degrade-gracefully-and-log-loudly design,
 * matching the report pipeline's own "a report that cannot be produced is a
 * logged skip, never a broken cron tick" rule; the caller is responsible for
 * the loud half.
 */
export function withDailyHeadline(markdown, hebrewText) {
  const clean = String(hebrewText || '').trim();
  if (!clean) return markdown;
  return `## תקציר יומי (Hebrew — OFFICE-POLICY.md A9)\n\n${clean}\n\n---\n\n${String(markdown || '').trim()}\n`;
}

/**
 * The weekly executive-summary prompt. Explicitly NOT a translation
 * instruction — A9's own words: "written to answer what he needs to know."
 * Fed the already-drafted-and-reviewed English report, after the structural
 * gate has passed it (see agent-runner.js's runReportPipeline()), so the
 * Hebrew layer judges finished, approved content rather than a draft that
 * might still be rejected.
 */
export function buildWeeklySummaryPrompt(finalReport, { periodLabel } = {}) {
  return `להלן דוח שבועי מלא${periodLabel ? ` (${periodLabel})` : ''} שכבר נכתב ונבדק, באנגלית. `
    + 'אל תתרגם אותו. כתוב תקציר מנהלים קצר בעברית (4-8 שורות) שעונה למה שהבעלים באמת צריך '
    + 'לדעת מהשבוע הזה — לא רשימה של כל מה שכתוב למטה, אלא שיפוט של מה שהכי משמעותי, כולל '
    + 'כל חסימה, סיכון או החלטה שממתינה לו באופן ספציפי.\n\n---\n\n' + String(finalReport || '');
}

/**
 * Layers the Hebrew executive summary above the English weekly body.
 * "One file, two layers. Never two copies." — the whole reason this
 * prepends rather than writing a second file.
 */
export function withWeeklySummary(finalReport, hebrewText) {
  const clean = String(hebrewText || '').trim();
  if (!clean) return finalReport;
  return `## תקציר מנהלים (Hebrew Executive Summary — OFFICE-POLICY.md A9)\n\n${clean}\n\n---\n\n${String(finalReport || '').trim()}`;
}
