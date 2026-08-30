/**
 * workers/office-site-page.js — the office's own shell, wired to live data.
 *
 * Written 2026-08-25 (Session 17, Item C).
 *
 * ── WHAT THIS IS A MERGE OF ──────────────────────────────────────────────
 *
 * The OFFICE built a site in `warehouse-office-AI-agents/tasks/office-site/`
 * across four phases. It is genuinely good work: dependency-free, no build
 * step, real semantics, and — the part worth copying — a section called
 * *"What this page cannot show you"* that lists what it is missing and why,
 * rather than faking a number. It had one structural problem it could not
 * solve from inside the warehouse:
 *
 *   * `data.js` was a 52KB FROZEN SNAPSHOT, generated 2026-08-07T18:54:10Z by
 *     a local script. Nothing on the page updated itself.
 *   * The message box wrote to `localStorage` and nowhere else. The office
 *     said so in its own footer — *"not synced, not backed up, not visible to
 *     anyone else, not committed anywhere"* — which was honest and still left
 *     the owner with a form that could not deliver.
 *
 * Both are now solved, and NEITHER is solved by redesigning the office's work.
 * The stylesheet below is the office's `styles.css` COPIED BYTE FOR BYTE (see
 * the provenance line above the CSS); the markup and the render functions are
 * its `index.html` and `app.js` with the data source changed and tabs added.
 * The design decisions are the office's. This file is wiring.
 *
 * ── THE TWO SURFACES ARE TWO PAGES, NOT ONE PAGE WITH A CHECK ────────────
 *
 * `renderOfficeSite({ mode })` renders `public` at `/` and `admin` at
 * `/admin`. The difference is NOT a hidden div:
 *
 *   * `public` fetches `/api/public` and cannot fetch anything else — the
 *     admin endpoint's URL does not appear in the public render at all.
 *   * `admin` fetches `/api/admin`, is served only from behind the admin gate
 *     (admin-gate.js), and is the only mode that renders the pending list or
 *     the spec builder.
 *
 * Session 16 made two endpoints rather than one *because a single auth bug
 * would then expose everything*. A single page that fetched one or the other
 * depending on a flag would have handed that property straight back: the
 * public bundle would contain the admin path, the admin fields, and the render
 * code for them, and only a runtime check would stand between a visitor and an
 * attempt. Two renders means the public surface has no code that knows how to
 * read the office's internal material.
 *
 * ── THE SPEC BUILDER IS FRAMED, NOT REIMPLEMENTED ────────────────────────
 *
 * The "Write a spec" tab is an `<iframe src="/admin/spec">`, same-origin and
 * behind the same gate. spec-builder.js argues for one implementation of the
 * spec format — *two implementations of one format is the drift this project
 * keeps finding* — and a tab that rebuilt the form here would be exactly the
 * second implementation it warns about, drifting the first time either changed.
 */

/* eslint-disable no-useless-concat */

/**
 * The office's stylesheet.
 *
 * PROVENANCE: copied verbatim from
 * `warehouse-office-AI-agents/tasks/office-site/styles.css` (627 lines,
 * 11,853 bytes) on 2026-08-25. Not edited. Everything this file adds — the
 * tab bar, the stat tiles, the loading and error states — is appended in
 * OFFICE_CSS_ADDITIONS below, so a diff against the warehouse file stays
 * meaningful and the office's design is not quietly rewritten.
 */
/**
 * Exported 2026-08-30 (session 40, Item C) so a second admin page can use the
 * office's stylesheet VERBATIM instead of writing its own.
 *
 * A prior session added CSS that referenced variables absent from this `:root`
 * — every one fell through to a browser default and painted white tiles onto a
 * dark design, a bug invisible to code review and found only by loading the
 * page. The automations panel therefore imports these two strings unchanged and
 * declares NO new custom property. Exporting rather than copying is what makes
 * that checkable: `automations-panel.js` contains no `--` declaration at all,
 * and the verifier asserts it.
 */
const OFFICE_CSS = `/* styles.css — The Office, static site, phase 1 (scaffold)
   Dark theme. Font-stack only, no CDN, no web fonts. */

:root {
  --bg: #0b0d12;
  --bg-raised: #12151c;
  --bg-card: #161a23;
  --bg-card-hover: #1c212c;
  --border: #262b38;
  --border-strong: #3a4152;
  --text: #e7e9ee;
  --text-dim: #a7adbc;
  --text-faint: #6b7284;
  --accent: #6ea8fe;
  --accent-dim: #3a5a8c;
  --live: #5fd68a;
  --bible-only: #d6a35f;
  --persona: #c58fff;

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 1rem;
  --space-4: 1.5rem;
  --space-5: 2.5rem;
  --space-6: 4rem;

  --radius: 10px;
  --max-width: 72rem;
}

* {
  box-sizing: border-box;
}

html {
  color-scheme: dark;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.wrap {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 var(--space-4);
}

/* ---------- Header ---------- */

.site-header {
  padding: var(--space-6) 0 var(--space-5);
  background:
    radial-gradient(60rem 30rem at 15% -10%, rgba(110, 168, 254, 0.12), transparent 60%),
    var(--bg);
  border-bottom: 1px solid var(--border);
}

.eyebrow {
  margin: 0 0 var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.site-header h1 {
  margin: 0 0 var(--space-3);
  font-size: clamp(2.25rem, 5vw, 3.25rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.lede {
  margin: 0;
  max-width: 42rem;
  font-size: 1.1rem;
  color: var(--text-dim);
}

/* ---------- Sections ---------- */

main {
  padding: var(--space-6) 0;
}

section + section {
  margin-top: var(--space-6);
}

section h2 {
  margin: 0 0 var(--space-2);
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.section-note {
  margin: 0 0 var(--space-4);
  color: var(--text-dim);
  font-size: 0.95rem;
}

.section-note span {
  color: var(--text);
  font-weight: 600;
}

/* ---------- Agent grid ---------- */

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
  gap: var(--space-4);
}

.agent-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.agent-card:hover,
.agent-card:focus-visible {
  background: var(--bg-card-hover);
  border-color: var(--border-strong);
}

.agent-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.agent-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.status {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  border: 1px solid currentColor;
}

.status--live {
  color: var(--live);
}

.status--bible-only {
  color: var(--bible-only);
}

.status--persona {
  color: var(--persona);
}

.agent-name {
  margin: 0 0 0.15rem;
  font-size: 1.25rem;
  font-weight: 700;
}

.agent-title {
  margin: 0 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-faint);
  letter-spacing: 0.02em;
}

.agent-role {
  margin: 0 0 var(--space-2);
  font-weight: 600;
  color: var(--text);
}

.agent-role--missing,
.agent-purpose--missing {
  color: var(--text-faint);
  font-style: italic;
  font-weight: 400;
}

.agent-purpose {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.95rem;
}

.agent-produced {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px dashed var(--border);
}

.agent-produced-label {
  margin: 0 0 var(--space-1);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-faint);
}

.agent-produced ul {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--text-dim);
  font-size: 0.9rem;
}

/* ---------- Pending items ("waiting on you") ---------- */

.pending-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.pending-group-title {
  margin: 0 0 var(--space-3);
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text);
}

.pending-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--bible-only);
  border-radius: var(--radius);
  padding: var(--space-4);
}

.pending-item + .pending-item {
  margin-top: var(--space-3);
}

.pending-source {
  margin: 0 0 var(--space-1);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  color: var(--text-faint);
}

.pending-title {
  margin: 0 0 var(--space-2);
  font-size: 1.05rem;
  font-weight: 700;
}

.pending-detail {
  margin: 0 0 var(--space-3);
  color: var(--text-dim);
  font-size: 0.95rem;
}

.pending-status-note {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-raised);
  border-radius: var(--radius);
  color: var(--accent);
  font-size: 0.85rem;
}

.respond-btn {
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent-dim);
  border-radius: var(--radius);
  padding: 0.4rem 0.9rem;
  cursor: pointer;
}

.respond-btn:hover,
.respond-btn:focus-visible {
  background: var(--accent-dim);
  color: var(--text);
  outline: none;
}

/* ---------- Message box ---------- */

.message-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 42rem;
  margin-bottom: var(--space-5);
}

.message-reply-tag {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--persona);
}

.message-textarea {
  font-family: inherit;
  font-size: 0.95rem;
  color: var(--text);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
  resize: vertical;
}

.message-textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.message-send-btn {
  align-self: flex-start;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--bg);
  background: var(--accent);
  border: none;
  border-radius: var(--radius);
  padding: 0.6rem 1.4rem;
  cursor: pointer;
}

.message-send-btn:hover,
.message-send-btn:focus-visible {
  background: #86b9ff;
  outline: none;
}

.message-queue {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.message-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
}

.message-timestamp {
  margin: 0 0 var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-faint);
}

.message-reply-ref {
  margin: 0 0 var(--space-2);
  font-size: 0.8rem;
  color: var(--persona);
}

.message-body {
  margin: 0 0 var(--space-3);
  color: var(--text);
  white-space: pre-wrap;
}

.message-status-note {
  margin: 0 0 var(--space-3);
  font-size: 0.8rem;
  font-style: italic;
  color: var(--bible-only);
}

.message-status-note--sent {
  color: var(--live);
}

.message-badge {
  display: inline-block;
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  margin-bottom: var(--space-2);
}

.message-badge--queued {
  color: var(--bible-only);
}

.message-badge--sent {
  color: var(--live);
}

/* ---------- Phase 3: the delivery round trip ---------- */

.send-to-office-btn,
.confirm-sent-btn {
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent-dim);
  border-radius: var(--radius);
  padding: 0.4rem 0.9rem;
  cursor: pointer;
  margin-right: var(--space-2);
}

.send-to-office-btn:hover,
.send-to-office-btn:focus-visible,
.confirm-sent-btn:hover,
.confirm-sent-btn:focus-visible {
  background: var(--accent-dim);
  color: var(--text);
  outline: none;
}

.confirm-sent-btn {
  color: var(--live);
  border-color: var(--live);
}

.message-opened-note {
  margin: var(--space-3) 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-raised);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 0.85rem;
}

/* ---------- Phase 4: per-agent detail view ---------- */

.agent-card--open {
  background: var(--bg-card-hover);
  border-color: var(--border-strong);
}

.agent-detail-toggle {
  margin-top: var(--space-3);
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 0.35rem 0.8rem;
  cursor: pointer;
}

.agent-detail-toggle:hover,
.agent-detail-toggle:focus-visible {
  color: var(--text);
  border-color: var(--accent);
  outline: none;
}

.agent-detail {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px dashed var(--border);
}

.agent-detail-subtitle {
  margin: 0 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--persona);
}

.agent-detail-section-label {
  margin: var(--space-3) 0 0.15rem;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text);
}

.agent-detail-section-text {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.9rem;
}

.agent-detail-technical,
.agent-detail-purpose {
  margin: var(--space-3) 0 0;
  font-size: 0.85rem;
  color: var(--text-dim);
}

.agent-detail-technical-label {
  font-weight: 700;
  color: var(--text);
}

.agent-detail-missing {
  margin: var(--space-3) 0 0;
  color: var(--text-faint);
  font-style: italic;
  font-size: 0.9rem;
}

.message-agent-btn {
  margin-top: var(--space-3);
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent-dim);
  border-radius: var(--radius);
  padding: 0.4rem 0.9rem;
  cursor: pointer;
}

.message-agent-btn:hover,
.message-agent-btn:focus-visible {
  background: var(--accent-dim);
  color: var(--text);
  outline: none;
}

/* ---------- Phase 4: cross-repo activity feed ---------- */

.activity-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.activity-item {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--radius);
  padding: var(--space-3) var(--space-4);
}

.activity-item--session_record {
  border-left-color: var(--persona);
}

.activity-item--commit {
  border-left-color: var(--live);
}

.activity-meta {
  margin: 0 0 0.15rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  color: var(--text-faint);
}

.activity-body {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.9rem;
}

/* ---------- Data gaps ---------- */

.gaps-list {
  margin: 0;
  padding-left: 1.25rem;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.gaps-list li::marker {
  color: var(--bible-only);
}

/* ---------- Footer ---------- */

.site-footer {
  border-top: 1px solid var(--border);
  padding: var(--space-5) 0 var(--space-6);
  background: var(--bg-raised);
}

.site-footer p {
  margin: 0;
  color: var(--text-faint);
  font-size: 0.9rem;
  max-width: 42rem;
}

.site-footer code {
  font-family: var(--font-mono);
  color: var(--text-dim);
}

.site-footer strong {
  color: var(--text-dim);
}`;

/** Everything the merged page needs that a static, single-view page did not. */
const OFFICE_CSS_ADDITIONS = `
/* ---------------------------------------------------------------------------
   Everything below is NEW in the merge. It uses the office's own custom
   properties — --text, --text-dim, --border, --bg-card, --accent, --radius,
   --space-* — and defines none of its own.

   The first cut of this block invented fallback names (--ink, --card, --rule)
   that do not exist in the office's :root. Every one of them fell through to a
   LIGHT-THEME fallback and painted white stat tiles and a near-black selected
   tab onto the office's dark page: the shell was not redesigned on purpose, it
   was redesigned by a typo. Caught by loading the deployed page and looking at
   it, which is the only thing that would have caught it.
   --------------------------------------------------------------------------- */

/* ---- tab bar (the static build was one long scroll) ---- */
.tabs { border-bottom: 1px solid var(--border); background: var(--bg-raised); }
.tabs .wrap { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.tab-btn {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 0.85rem var(--space-3); font: inherit; font-size: 0.95rem;
  color: var(--text-dim); cursor: pointer; border-radius: var(--radius) var(--radius) 0 0;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.tab-btn:hover { color: var(--text); background: rgba(110, 168, 254, 0.08); }
.tab-btn[aria-selected="true"] {
  color: var(--text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.tab-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tab-btn .tab-count { font-size: 0.8em; color: var(--text-faint); margin-left: var(--space-1); }
.tab-panel[hidden] { display: none; }

/* ---- stat tiles for the live counts ---- */
.stat-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--space-3); margin: var(--space-4) 0;
}
.stat {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--space-3);
}
.stat-value {
  font-size: 1.7rem; font-weight: 700; line-height: 1.1;
  color: var(--text); letter-spacing: -0.01em;
}
.stat-label {
  margin-top: var(--space-1); font-family: var(--font-mono); font-size: 0.72rem;
  letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-faint);
}

/* ---- the office blurb + mechanisms ---- */
.office-text { max-width: 44rem; font-size: 1.05rem; color: var(--text-dim); }
.mech-list {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: var(--space-4); margin-top: var(--space-4);
}
.mech {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--space-4);
}
.mech h3 {
  margin: 0 0 var(--space-2); font-size: 1.05rem; font-weight: 700;
  color: var(--text); letter-spacing: -0.01em;
}
.mech p { margin: 0; font-size: 0.92rem; color: var(--text-dim); }

/* ---- loading / error / lock states ---- */
.state-note { padding: var(--space-4) 0; color: var(--text-dim); }
.state-note--error { color: #ff8f8f; }
.token-prompt { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.token-prompt input {
  flex: 1 1 15rem; padding: 0.55rem 0.7rem; font: inherit;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px;
}
.token-prompt input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ---- the framed spec builder ---- */
.spec-frame {
  width: 100%; height: 78vh; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius);
}

/* ---- gaps list + footer ---- */
.gaps-list { max-width: 52rem; color: var(--text-dim); padding-left: var(--space-3); }
.gaps-list li { margin-bottom: var(--space-2); }
#gaps-errors { margin-top: var(--space-4); color: #ff8f8f; }
.site-footer {
  margin-top: var(--space-6); padding: var(--space-4) 0;
  border-top: 1px solid var(--border); color: var(--text-faint); font-size: 0.85rem;
}
.site-footer code { font-family: var(--font-mono); color: var(--text-dim); }
.site-header a { color: var(--accent); }

/* ---------------------------------------------------------------------------
   SESSION 18 (2026-08-25) — the answer box, and the office-data tab.

   Same rule as the block above and for the same recorded reason: every colour
   here is one of the office's own custom properties. No new variable is
   defined, and no name is used that :root does not carry. The one literal is
   #ff8f8f, which the block above already uses for an error.
   --------------------------------------------------------------------------- */

/* ---- the three parts, on the card ---- */
.pending-ask { margin: var(--space-2) 0 0; font-size: 0.95rem; color: var(--text); }
.pending-when { margin: var(--space-2) 0 0; font-size: 0.85rem; color: var(--bible-only); }
.pending-options { margin: var(--space-3) 0 0; padding: 0; list-style: none; }
.pending-option {
  padding: var(--space-2) 0; border-top: 1px solid var(--border);
  font-size: 0.9rem; color: var(--text-dim);
}
.pending-option-label {
  display: block; font-family: var(--font-mono); font-size: 0.72rem;
  letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-faint);
  margin-bottom: var(--space-1);
}
.pending-missing {
  margin: var(--space-3) 0 0; padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--bible-only); background: var(--bg-raised);
  font-size: 0.85rem; color: var(--text-dim);
}

/* ---- answering in place ---- */
.answer-box { margin-top: var(--space-3); border-top: 1px solid var(--border); padding-top: var(--space-3); }
.answer-box textarea {
  width: 100%; box-sizing: border-box; min-height: 6.5rem; resize: vertical;
  padding: 0.6rem 0.7rem; font: inherit; font-size: 0.92rem;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px;
}
.answer-box textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.answer-actions {
  display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center;
  margin-top: var(--space-2);
}
.answer-send {
  appearance: none; border: 0; border-radius: 6px; cursor: pointer;
  padding: 0.5rem 0.9rem; font: inherit; font-size: 0.9rem; font-weight: 600;
  background: var(--accent); color: var(--bg);
}
.answer-send:disabled { opacity: 0.5; cursor: default; }
.answer-effect { font-size: 0.8rem; color: var(--text-faint); }
.answer-status { margin-top: var(--space-2); font-size: 0.85rem; color: var(--text-dim); }
.answer-status--ok { color: var(--live); }
.answer-status--err { color: #ff8f8f; }
.answer-status code { font-family: var(--font-mono); color: var(--text-dim); }
.pending-item--answered { border-color: var(--accent-dim); }

/* ---- the office-data tab ---- */
.auto-group { margin-top: var(--space-4); }
.auto-group h3 { margin: 0 0 var(--space-2); font-size: 1rem; color: var(--text); }
.auto-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
.auto-table th, .auto-table td {
  text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--border);
  vertical-align: top; color: var(--text-dim);
}
.auto-table th {
  font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.03em;
  text-transform: uppercase; color: var(--text-faint); font-weight: 400;
}
.auto-table td.auto-time { font-family: var(--font-mono); color: var(--text); white-space: nowrap; }
.auto-table td.auto-none { color: var(--text-faint); }
.auto-scroll { overflow-x: auto; }

/* ---------------------------------------------------------------------------
   SESSION 22 (2026-08-25) — the expansion: one item, whole.

   Same rule as every block above it: the office's own custom properties, no new
   variable, no name :root does not carry. #ff8f8f is the error colour the file
   already uses.

   THE VERBATIM BLOCK SCROLLS RATHER THAN WRAPS. A board entry is markdown the
   office wrote, and re-flowing it changes where its lines break — which is a
   change to what the owner is reading. It is presented as written and given a
   scrollbar; white-space:pre-wrap would have been prettier and slightly untrue.
   --------------------------------------------------------------------------- */
.item-open {
  margin-top: var(--space-3); font-family: inherit; font-size: 0.8rem; font-weight: 600;
  color: var(--text-dim); background: transparent;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  padding: 0.35rem 0.8rem; cursor: pointer;
}
.item-open:hover, .item-open:focus-visible { color: var(--text); border-color: var(--accent); outline: none; }
.item-detail {
  margin-top: var(--space-3); padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}
.item-detail h5 {
  margin: var(--space-3) 0 var(--space-1); font-family: var(--font-mono);
  font-size: 0.72rem; letter-spacing: 0.03em; text-transform: uppercase;
  color: var(--text-faint); font-weight: 400;
}
.item-detail h5:first-child { margin-top: 0; }
.item-verbatim {
  margin: 0; padding: var(--space-3); overflow-x: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.6;
  color: var(--text-dim); white-space: pre;
}
.item-blocker {
  margin-top: var(--space-2); padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--accent-dim); background: var(--bg-raised);
}
.item-blocker-head { margin: 0 0 var(--space-1); font-size: 0.9rem; color: var(--text); }
.item-blocker-id { font-family: var(--font-mono); color: var(--accent); }
.item-line { margin: var(--space-1) 0 0; font-size: 0.85rem; color: var(--text-dim); }
.item-line code { font-family: var(--font-mono); color: var(--text); }
.item-lookups { margin: var(--space-2) 0 0; padding-left: var(--space-3); font-size: 0.8rem; color: var(--text-faint); }
.item-lookups li { margin-bottom: 2px; }
.item-lookups .item-failed { color: #ff8f8f; }
.item-problem { margin: var(--space-2) 0 0; font-size: 0.85rem; color: #ff8f8f; }

/* ---- the blocker, on the card (2026-08-30) ----
   The same control shape as .item-open, marked so it reads as the narrower
   question it is. It sits ABOVE "open this item" because it answers the
   question the card raised. */
.blocker-open { border-color: var(--accent-dim); color: var(--accent); }
.blocker-detail { border-left: 2px solid var(--accent-dim); }

/* ---- Hebrew chrome (2026-08-30) ----
   THE CHROME IS RIGHT-TO-LEFT; THE OFFICE'S OWN WORDS ARE NOT. The direction
   is set per element by the render (dir="rtl" on chrome, dir="ltr" on values),
   so these rules only supply the alignment that direction implies. The
   office's verbatim entries, file paths, commit messages and lookup lines are
   forced back to left-to-right here as a backstop: a board entry rendered
   right-aligned is a paraphrase by typography, and this session translates no
   office text at any layer. */
.chrome-he [dir="rtl"] { text-align: right; }
.chrome-he .pending-group-title,
.chrome-he .tab-btn { text-align: right; }
.chrome-he .item-verbatim,
.chrome-he .item-lookups,
.chrome-he code,
.chrome-he pre { direction: ltr; text-align: left; }
.chrome-he .answer-box textarea { text-align: right; }
`;

/* ═══════════════════════ THE CHROME DICTIONARY ═══════════════════════════
 *
 * Added 2026-08-30 (layer 1 of the owner-channel readability plan, section ד).
 *
 * ── WHY A DICTIONARY AND NOT SIXTY INLINE CONDITIONALS ──────────────────
 *
 * The owner reads Hebrew. Every fixed string on the OWNER'S surface is
 * translated; not one character of what the OFFICE wrote is. That boundary is
 * the whole of this change, and a boundary that lives in sixty scattered
 * `isAdmin ? … : …` expressions is a boundary nobody can check.
 *
 * So it lives in one object. A string in here is chrome BY CONSTRUCTION: it is
 * written in this file, it is the same string regardless of which item is
 * showing, and it never passes through a value that came off the wire.
 * `scripts/verify-office-site.js` asserts that the two variants have identical
 * key sets, that the admin variant is actually Hebrew, and — the check that
 * matters — that the admin render still carries the office's own values
 * untranslated.
 *
 * ── WHAT IS DELIBERATELY NOT TRANSLATED ─────────────────────────────────
 *
 * `item-detail.js`'s header states the rule this session was built around: *a
 * fluent paraphrase of something the office did not mean is worse than no
 * expansion at all, because a paraphrase reads exactly like evidence.* So every
 * value out of `entryFields()`, `extractEntry()` and `buildItemDetail()`'s
 * `entry.verbatim` reaches the browser unaltered, in whatever language the
 * office wrote it in — which today is English.
 *
 * A Hebrew label above an English value is therefore the CORRECT result here,
 * not a defect. Two strings inside this dictionary end in English on purpose
 * for the same reason:
 *
 *   * `pending_missing_tail` and `default_none_head`'s companion both carry
 *     `NO_STATED_DEFAULT` — `item-detail.js`'s constant — word for word.
 *     `scripts/verify-item-detail.js` asserts this file still contains that
 *     sentence verbatim; translating it would make the module and the card say
 *     two different things about one silence, which is the drift a shared
 *     constant exists to prevent.
 *
 * ── THE PUBLIC PAGE IS UNTOUCHED ────────────────────────────────────────
 *
 * `/` is the office's public face and stays English. That is why every label is
 * looked up per mode rather than replaced outright: the same
 * `renderOfficeSite()` serves both surfaces, and three of the six tabs are on
 * both.
 */

/** The sentence `item-detail.js` owns, repeated so both variants below can end
 *  with it WITHOUT either of them becoming a second place it is defined. See
 *  `NO_STATED_DEFAULT` there, and verify-item-detail.js's check that this file
 *  still contains it character for character. */
const NO_STATED_DEFAULT_SENTENCE =
  'there is no stated default here — silence is not a decision the office knows how to act on.';

const CHROME_EN = {
  /* shell */
  lang: 'en',
  dir_chrome: 'ltr',
  body_class: '',
  h1: 'The Office',
  lede: 'Thirteen AI agents that run as an office — and review each other.',
  eyebrow_admin: 'owner view · live · behind the admin gate',
  eyebrow_public: 'live · served by the office\'s own Worker',
  title_owner_suffix: ' — owner',
  nav_aria: 'Sections',
  link_owner_page: 'The owner page',
  link_public_view: 'the public view',
  footer_a: 'Served by the office\'s own Worker and read live from',
  footer_b: 'each time you load it. Nothing on this page is a stored copy. Office data generated at',

  /* tabs */
  tab_pending: 'Waiting on you',
  tab_office: 'The office',
  tab_agents: 'The thirteen',
  tab_spec: 'Write a spec',
  tab_office_data: 'Office data',
  tab_gaps: 'What this page cannot show you',

  /* panel notes */
  pending_note: 'Open decisions, blocked board items, and questions the office has written down and cannot answer itself — read from the office\'s own board, plan and channel at the moment you loaded this page.',
  spec_note_a: 'The real builder, framed from',
  spec_note_b: 'rather than rebuilt here — one implementation of the spec format. What you send is written to',
  spec_note_c: 'in back-office and is refused before anything is written if the office\'s own parser will not accept it.',
  office_data_note: 'The office\'s meetings and the blocks its scheduler actually iterates — read from the same configuration the Worker itself reads, joined to its database where a block leaves something behind. It is an instrument, not a status board: where the office has no record that something ran, this says so instead of inferring it.',
  gaps_note: 'The office built this section when the page was static and could not call a server. It can now. What follows is what is still missing and what the live wiring newly limits — kept for the same reason it was written: a page that hides its own gaps is harder to trust than one that names them.',
  spec_frame_title: 'Spec builder',

  /* load / token states */
  loading: 'Reading the office\'s live data…',
  load_failed: 'Could not read the office\'s live data: ',
  token_expired: 'You are signed in, but the office refused this tab\'s request. Your sign-in has most likely expired — reload the page.',
  token_missing: 'The office accepted this page but not this tab: the admin token is not in this tab\'s session storage.',
  token_use: 'Use token',
  http_status: 'the office answered HTTP ',
  unknown: 'unknown',

  /* the office tab */
  stat_agents: 'agents',
  stat_questions: 'questions handled',
  stat_reports: 'reports written',
  stat_meetings: 'meetings held',
  stat_interactions: 'interactions logged',
  stat_day: 'simulated day',

  /* the thirteen */
  agent_count_a: ' of ',
  agent_count_b: ' are in the live daily roster. "View detail" opens the office\'s own published character text.',
  agent_hide: 'Hide detail',
  agent_view: 'View detail',
  agent_badge_live: 'live in roster',
  agent_badge_bible: 'bible-only, not in live roster',
  agent_badge_persona: 'has PERSONA.md',
  agent_no_role: 'not in the live roster',
  agent_no_purpose: 'purpose not yet wired into the live config',
  agent_no_character: 'No character text published for this agent.',
  agent_technical: 'Technical: ',
  agent_purpose: 'Purpose: ',
  agent_produced: 'Produced',

  /* gaps */
  gaps_errors_heading: 'Errors the office hit while reading its own material, this request',

  /* office data */
  office_data_none: 'The office returned no automation data on this request.',
  od_meetings_title: 'What the office produces, by kind of meeting',
  od_meetings_cols: ['Meeting', 'Held', 'Most recent'],
  od_reports_title: 'Reports the office has written, by type',
  od_reports_cols: ['Report type', 'Written', 'Most recent'],
  od_day_title: 'The working day — ',
  od_day_cols: ['Time', 'What runs', 'Last artifact the office can point at'],
  od_notes_title: 'What this tab does not know',
  od_never: 'never',
  od_in_db_b: ' in the database)',
  od_nothing: 'nothing recorded',

  /* the pending list */
  pending_empty: 'Nothing open right now.',
  pending_no_title: '(the office recorded no title for this)',
  pending_if_nothing: 'If you say nothing: ',
  pending_missing_head: 'The office did not record ',
  pending_missing_tail: ' for this one. Until it does, ' + NO_STATED_DEFAULT_SENTENCE,
  pending_no_notice: 'The office did not compose an ask for this item, so what you see is the raw board entry rather than a question.',
  pending_spec_instead: 'Write a full spec instead',

  /* the inline blocker */
  blocker_open: 'What is blocking this',
  blocker_close: 'Hide what is blocking this',
  blocker_reading: 'Reading the blocking entry…',
  blocker_none_read: 'The office reads no blocker for this item at all — its board entry names none.',

  /* the expansion */
  item_open: 'Open this item',
  item_close: 'Close',
  item_opening: 'Opening…',
  item_retry: 'Try again',
  item_reading: 'Reading the office\'s own file…',
  item_http_failed_a: 'The office could not open this item (HTTP ',
  item_http_failed_b: '): ',
  item_no_reason: 'no reason given',
  item_unreachable: 'Could not reach the office: ',
  item_h_entry: 'The entry, as the office wrote it',
  item_entry_unreadable_a: 'The entry could not be read out of ',
  item_entry_unreadable_b: 'its file',
  item_entry_unreadable_c: ': ',
  item_entry_unreadable_d: 'no reason recorded',
  item_h_blocker: 'What is blocking it',
  item_blocker_none_named: 'The board names no other item here — what is written above is the whole of what it says this is waiting on.',
  item_blocker_no_title: '(no title)',
  item_blocker_elsewhere: 'This is not on the board. It was found in ',
  item_blocker_struck: 'This entry\'s heading is struck through. The office\'s own board parser does not read that form, so this item is in no state count — it is still named as the blocker here.',
  item_blocker_unresolved: 'Named as a blocker but not found: ',
  item_h_where: 'Where it came from',
  item_where_file: 'a file',
  item_h_if_nothing: 'If you say nothing',
  default_none_head: 'The office recorded no default for this one — ',
  item_h_lookups: 'What was read to answer this',
  lk_chars_b: ' characters)',
  lk_commits_b: ' commits',
  lk_commits_capped: ', capped',
  lk_reads_b: ' file reads)',
  lk_failed: ' — FAILED: ',

  /* origin, from git */
  origin_exact_a: 'It entered the record on ',
  origin_exact_b: ' — commit ',
  origin_exact_d: '". That date is from git, not from anything written inside the entry.',
  origin_before_a: 'It was already in the file on ',
  origin_before_b: ' (commit ',
  origin_window_a: 'It first appeared between ',
  origin_window_b: ' and ',
  origin_none_a: 'The office could not date this from git: ',
  origin_none_b: 'no reason recorded',

  /* the answer box */
  answer_placeholder: 'Answer in your own words. Whatever you write is filed exactly as you wrote it.',
  answer_aria: 'Your answer',
  answer_send: 'Send this answer',
  answer_sent: 'Answer sent',
  answer_empty: 'Write something first — the office refuses an empty message.',
  answer_sending: 'Sending…',
  answer_refused_a: 'The office refused it (HTTP ',
  answer_refused_b: '): ',
  answer_filed_a: 'Filed as ',
  answer_stays: ' This card stays on this page until the office marks its own ledger entry — the page reads the ledger, and only the office writes to it.',
  answer_effect_stops: 'The office stops raising this by email and Issue once the file lands. It raises it once more after seven days if it has still not marked the entry, and then goes quiet.',
  answer_effect_default: 'The office files this and reads it; it does not mark this item answered.',

  /* the honesty section */
  gaps_shared: [
    'The counts are live D1 totals since the simulation began on 2026-06-17, but the office writes them on a 30-minute cron — a number here can be up to half an hour behind the office itself.',
    'Nothing here says whether an agent\'s answer was any GOOD. The office scores its own work internally and that score is not on this page; a high count of reports written is a count, not a quality claim.',
    'Each agent\'s journal exists and is never surfaced anywhere on this page. That is a standing rule of the office, not a gap waiting to be filled.',
    'This page renders what the endpoint returns and nothing else. It holds no data of its own, caches nothing, and has no copy to fall back on — if the office is down, this page says so rather than showing you a stale answer as though it were current.',
  ],
  gaps_admin: [
    'The pending list is read FRESH from the office\'s own material on every request, not from the 30-minute snapshot cache — so it can disagree with the counts above by design, and the pending side is the newer of the two.',
    'An item appearing here means the office believes it is waiting on you. It is not proof the office has nothing else waiting: anything the office has not yet written down in the board, the plan or the channel cannot appear.',
  ],
  gaps_public: [
    'The office\'s internal working material — its task board, meeting transcripts and correspondence with its owner — is not served to this page and is not reachable from the endpoint it reads. That is a property of the endpoint, not a filter applied here.',
  ],

  /* the pending group headings */
  group_decision: 'Open decisions',
  group_authorization: 'Pending authorizations',
  group_blocked: 'Blocked',
  group_question: 'Questions for you',
  group_approval: 'Waiting for your approval',
  group_submission: 'Awaiting your review',
};

const CHROME_HE = {
  /* shell */
  lang: 'he',
  /* The chrome is right-to-left; the OFFICE'S values are not. Applied per
     element rather than to the document, so a verbatim entry, a file path and
     a commit message keep the direction they were written in. */
  dir_chrome: 'rtl',
  body_class: ' chrome-he',
  h1: 'המשרד',
  lede: 'שלושה עשר סוכני בינה מלאכותית שמתנהלים כמשרד — וסוקרים זה את זה.',
  eyebrow_admin: 'תצוגת הבעלים · חי · מאחורי שער הניהול',
  eyebrow_public: 'חי · מוגש על ידי ה-Worker של המשרד',
  title_owner_suffix: ' — הבעלים',
  nav_aria: 'לשוניות',
  link_owner_page: 'דף הבעלים',
  link_public_view: 'התצוגה הציבורית',
  footer_a: 'מוגש על ידי ה-Worker של המשרד ונקרא בשידור חי מתוך',
  footer_b: 'בכל טעינה. שום דבר בדף הזה אינו עותק שמור. נתוני המשרד נוצרו ב-',

  /* tabs */
  tab_pending: 'ממתין לך',
  tab_office: 'המשרד',
  tab_agents: 'שלושה עשר',
  tab_spec: 'כתוב מפרט',
  tab_office_data: 'נתוני המשרד',
  tab_gaps: 'מה הדף הזה לא יכול להראות לך',

  /* panel notes */
  pending_note: 'החלטות פתוחות, משימות חסומות בלוח, ושאלות שהמשרד רשם ואינו יכול לענות עליהן בעצמו — נקראו מהלוח, מהתוכנית ומהערוץ של המשרד עצמו ברגע שטענת את הדף הזה.',
  spec_note_a: 'הבנאי האמיתי, ממוסגר מתוך',
  spec_note_b: 'ולא נבנה כאן מחדש — מימוש אחד לפורמט המפרט. מה שתשלח נכתב אל',
  spec_note_c: 'ב-back-office, ונדחה עוד לפני שנכתב דבר אם המנתח של המשרד עצמו לא יקבל אותו.',
  office_data_note: 'הישיבות של המשרד והבלוקים שהמתזמן שלו באמת עובר עליהם — נקראו מאותה תצורה שה-Worker עצמו קורא, מוצלבים מול מסד הנתונים שלו במקום שבו בלוק משאיר משהו אחריו. זהו מכשיר מדידה, לא לוח סטטוס: היכן שלמשרד אין תיעוד שמשהו רץ, כתוב כאן כך במקום להסיק זאת.',
  gaps_note: 'המשרד בנה את החלק הזה כשהדף היה סטטי ולא יכול היה לפנות לשרת. עכשיו הוא יכול. מה שלהלן הוא מה שעדיין חסר ומה שהחיווט החי מגביל מחדש — נשמר מאותה סיבה שבגללה נכתב: לדף שמסתיר את הפערים של עצמו קשה יותר להאמין מאשר לדף שמונה אותם.',
  spec_frame_title: 'בונה המפרט',

  /* load / token states */
  loading: 'קורא את הנתונים החיים של המשרד…',
  load_failed: 'לא ניתן היה לקרוא את הנתונים החיים של המשרד: ',
  token_expired: 'אתה מחובר, אבל המשרד סירב לבקשה של הלשונית הזו. סביר להניח שההתחברות שלך פגה — טען את הדף מחדש.',
  token_missing: 'המשרד קיבל את הדף הזה אבל לא את הלשונית הזו: טוקן הניהול אינו באחסון הסשן של הלשונית.',
  token_use: 'השתמש בטוקן',
  http_status: 'המשרד ענה HTTP ',
  unknown: 'לא ידוע',

  /* the office tab */
  stat_agents: 'סוכנים',
  stat_questions: 'שאלות שטופלו',
  stat_reports: 'דוחות שנכתבו',
  stat_meetings: 'ישיבות שהתקיימו',
  stat_interactions: 'אינטראקציות שנרשמו',
  stat_day: 'יום מדומה',

  /* the thirteen */
  agent_count_a: ' מתוך ',
  agent_count_b: ' נמצאים במצבת היומית החיה. "הצג פירוט" פותח את טקסט האופי שהמשרד עצמו פרסם.',
  agent_hide: 'הסתר פירוט',
  agent_view: 'הצג פירוט',
  agent_badge_live: 'חי במצבת',
  agent_badge_bible: 'בספר האופי בלבד, לא במצבת החיה',
  agent_badge_persona: 'יש PERSONA.md',
  agent_no_role: 'לא במצבת החיה',
  agent_no_purpose: 'התכלית עדיין לא חוברה לתצורה החיה',
  agent_no_character: 'לא פורסם טקסט אופי לסוכן הזה.',
  agent_technical: 'טכני: ',
  agent_purpose: 'תכלית: ',
  agent_produced: 'הפיק',

  /* gaps */
  gaps_errors_heading: 'שגיאות שהמשרד נתקל בהן בקריאת החומר של עצמו, בבקשה הזו',

  /* office data */
  office_data_none: 'המשרד לא החזיר נתוני אוטומציה בבקשה הזו.',
  od_meetings_title: 'מה המשרד מפיק, לפי סוג ישיבה',
  od_meetings_cols: ['ישיבה', 'התקיימו', 'האחרונה'],
  od_reports_title: 'דוחות שהמשרד כתב, לפי סוג',
  od_reports_cols: ['סוג דוח', 'נכתבו', 'האחרון'],
  od_day_title: 'יום העבודה — ',
  od_day_cols: ['שעה', 'מה רץ', 'התוצר האחרון שהמשרד יכול להצביע עליו'],
  od_notes_title: 'מה הלשונית הזו לא יודעת',
  od_never: 'מעולם לא',
  od_in_db_b: ' במסד הנתונים)',
  od_nothing: 'לא נרשם דבר',

  /* the pending list */
  pending_empty: 'אין כרגע שום דבר פתוח.',
  pending_no_title: '(המשרד לא רשם כותרת לפריט הזה)',
  pending_if_nothing: 'אם לא תאמר דבר: ',
  pending_missing_head: 'המשרד לא רשם ',
  /* ENDS IN ENGLISH ON PURPOSE — the tail is item-detail.js's NO_STATED_DEFAULT,
     carried word for word. See the dictionary header. */
  pending_missing_tail: ' עבור הפריט הזה. עד שירשום, ' + NO_STATED_DEFAULT_SENTENCE,
  pending_no_notice: 'המשרד לא חיבר שאלה עבור הפריט הזה, ולכן מה שאתה רואה הוא רשומת הלוח הגולמית ולא שאלה.',
  pending_spec_instead: 'כתוב מפרט מלא במקום',

  /* the inline blocker */
  blocker_open: 'מה חוסם את זה',
  blocker_close: 'הסתר את מה שחוסם את זה',
  blocker_reading: 'קורא את הרשומה החוסמת…',
  blocker_none_read: 'המשרד אינו קורא שום חוסם לפריט הזה כלל — רשומת הלוח שלו אינה נוקבת באף אחד.',

  /* the expansion */
  item_open: 'פתח את הפריט הזה',
  item_close: 'סגור',
  item_opening: 'פותח…',
  item_retry: 'נסה שוב',
  item_reading: 'קורא את הקובץ של המשרד עצמו…',
  item_http_failed_a: 'המשרד לא הצליח לפתוח את הפריט הזה (HTTP ',
  item_http_failed_b: '): ',
  item_no_reason: 'לא נמסרה סיבה',
  item_unreachable: 'לא ניתן היה להגיע למשרד: ',
  item_h_entry: 'הרשומה, כפי שהמשרד כתב אותה',
  item_entry_unreadable_a: 'לא ניתן היה לקרוא את הרשומה מתוך ',
  item_entry_unreadable_b: 'הקובץ שלה',
  item_entry_unreadable_c: ': ',
  item_entry_unreadable_d: 'לא נרשמה סיבה',
  item_h_blocker: 'מה חוסם אותו',
  item_blocker_none_named: 'הלוח אינו נוקב בשום פריט אחר כאן — מה שכתוב למעלה הוא כל מה שהוא אומר שהפריט הזה ממתין לו.',
  item_blocker_no_title: '(ללא כותרת)',
  item_blocker_elsewhere: 'זה אינו על הלוח. הוא נמצא בתוך ',
  item_blocker_struck: 'הכותרת של הרשומה הזו מחוקה בקו. מנתח הלוח של המשרד עצמו אינו קורא את הצורה הזו, ולכן הפריט הזה אינו נספר בשום מצב — והוא עדיין נקוב כחוסם כאן.',
  item_blocker_unresolved: 'נקוב כחוסם אך לא נמצא: ',
  item_h_where: 'מהיכן זה הגיע',
  item_where_file: 'קובץ',
  item_h_if_nothing: 'אם לא תאמר דבר',
  /* ENDS IN ENGLISH ON PURPOSE — the sentence that follows this prefix is
     item-detail.js's NO_STATED_DEFAULT, sent by the server and rendered as it
     arrives. See the dictionary header. */
  default_none_head: 'המשרד לא רשם ברירת מחדל עבור הפריט הזה — ',
  item_h_lookups: 'מה נקרא כדי לענות על זה',
  lk_chars_b: ' תווים)',
  lk_commits_b: ' קומיטים',
  lk_commits_capped: ', נחתך',
  lk_reads_b: ' קריאות קובץ)',
  lk_failed: ' — נכשל: ',

  /* origin, from git */
  origin_exact_a: 'זה נכנס לתיעוד ב-',
  origin_exact_b: ' — קומיט ',
  origin_exact_d: '". התאריך הזה מגיע מ-git, לא ממשהו שנכתב בתוך הרשומה.',
  origin_before_a: 'זה כבר היה בקובץ ב-',
  origin_before_b: ' (קומיט ',
  origin_window_a: 'זה הופיע לראשונה בין ',
  origin_window_b: ' לבין ',
  origin_none_a: 'המשרד לא הצליח לתארך את זה מ-git: ',
  origin_none_b: 'לא נרשמה סיבה',

  /* the answer box */
  answer_placeholder: 'ענה במילים שלך. כל מה שתכתוב מתויק בדיוק כפי שכתבת אותו.',
  answer_aria: 'התשובה שלך',
  answer_send: 'שלח את התשובה',
  answer_sent: 'התשובה נשלחה',
  answer_empty: 'כתוב משהו קודם — המשרד מסרב להודעה ריקה.',
  answer_sending: 'שולח…',
  answer_refused_a: 'המשרד סירב לה (HTTP ',
  answer_refused_b: '): ',
  answer_filed_a: 'תויק כ-',
  answer_stays: ' הכרטיס הזה נשאר בדף עד שהמשרד יסמן את רשומת הפנקס שלו — הדף קורא את הפנקס, ורק המשרד כותב אליו.',
  answer_effect_stops: 'המשרד מפסיק להעלות את זה במייל וב-Issue ברגע שהקובץ נוחת. הוא מעלה את זה עוד פעם אחת אחרי שבעה ימים אם עדיין לא סימן את הרשומה, ואז שותק.',
  answer_effect_default: 'המשרד מתייק את זה וקורא את זה; הוא אינו מסמן את הפריט הזה כנענה.',

  /* the honesty section */
  gaps_shared: [
    'הספירות הן סכומים חיים מ-D1 מאז שהסימולציה החלה ב-2026-06-17, אך המשרד כותב אותן בקרון של 30 דקות — מספר כאן יכול לפגר עד חצי שעה אחרי המשרד עצמו.',
    'שום דבר כאן אינו אומר אם התשובה של סוכן הייתה טובה. המשרד מנקד את עבודתו שלו באופן פנימי, והניקוד הזה אינו בדף הזה; ספירה גבוהה של דוחות שנכתבו היא ספירה, לא טענת איכות.',
    'היומן של כל סוכן קיים ואינו מוצג בשום מקום בדף הזה. זהו כלל קבוע של המשרד, לא פער שממתין למילוי.',
    'הדף הזה מציג את מה שנקודת הקצה מחזירה ותו לא. אין לו נתונים משלו, הוא אינו שומר מטמון, ואין לו עותק ליפול אליו — אם המשרד מושבת, הדף אומר זאת במקום להראות לך תשובה ישנה כאילו הייתה עדכנית.',
  ],
  gaps_admin: [
    'רשימת הממתינים נקראת טרייה מהחומר של המשרד עצמו בכל בקשה, ולא ממטמון התצלום של 30 הדקות — ולכן היא יכולה לסתור את הספירות שלמעלה מתוך תכנון, וצד הממתינים הוא החדש מבין השניים.',
    'פריט שמופיע כאן פירושו שהמשרד מאמין שהוא ממתין לך. אין בכך הוכחה שלמשרד אין דבר אחר שממתין: כל מה שהמשרד עדיין לא רשם בלוח, בתוכנית או בערוץ אינו יכול להופיע.',
  ],
  gaps_public: [
    'החומר הפנימי של המשרד — לוח המשימות שלו, תמלילי הישיבות וההתכתבות עם הבעלים — אינו מוגש לדף הזה ואינו נגיש מנקודת הקצה שהוא קורא. זו תכונה של נקודת הקצה, לא סינון שנעשה כאן.',
  ],

  /* the pending group headings */
  group_decision: 'החלטות פתוחות',
  group_authorization: 'אישורים ממתינים',
  group_blocked: 'חסום',
  group_question: 'שאלות עבורך',
  group_approval: 'ממתין לאישורך',
  group_submission: 'ממתין לסקירתך',
};

/**
 * The chrome for one surface. `admin` is Hebrew, `public` is English — see the
 * dictionary header for why the public page is deliberately left alone.
 */
export function officeChrome(mode) {
  return mode === 'admin' ? CHROME_HE : CHROME_EN;
}

/** The client script. Adapted from the office's `app.js`: the element
 *  builder, the agent card, the detail toggle and the pending-item grouping
 *  are its logic; what changed is where the data comes from and that there
 *  are tabs. No backticks and no `${` in here — this string is embedded in a
 *  template literal. */
function clientScript(mode, signedInViaAccess) {
  const isAdmin = mode === 'admin';
  const lines = [
    '(function () {',
    '  "use strict";',
    '  var MODE = ' + JSON.stringify(mode) + ';',
    CHROME_SLOT,
    /* '/admin/api/data' rather than '/api/admin' — same handler, reached by
     * a rewrite in agent-runner.js. The Access application is scoped to the
     * `/admin` PATH, so this is the only spelling Cloudflare attaches the
     * owner's signed-in assertion to; the old one arrived anonymous and got
     * this page's token prompt. See admin-gate.js's ADMIN_API_PREFIX. */
    '  var ENDPOINT = ' + JSON.stringify(isAdmin ? '/admin/api/data' : '/api/public') + ';',
    '  var SIGNED_IN = ' + JSON.stringify(!!signedInViaAccess) + ';',
    '  var data = null;',
    // Filled in by the admin-only block below. The shared loader calls it
    // without knowing what it is, so the public bundle contains no reference
    // to the pending renderer at all — not a guarded one, none.
    '  var extraRender = null;',
    '  var openAgentId = null;',
    '',
    '  function el(tag, attrs, children) {',
    '    var node = document.createElement(tag);',
    '    if (attrs) Object.keys(attrs).forEach(function (k) {',
    '      if (k === "text") node.textContent = attrs[k]; else node.setAttribute(k, attrs[k]);',
    '    });',
    '    (children || []).forEach(function (c) { if (c) node.appendChild(c); });',
    '    return node;',
    '  }',
    '  function byId(id) { return document.getElementById(id); }',
    '  function clear(node) { if (node) node.textContent = ""; }',
    '',
    '  /* ---------- tabs ---------- */',
    '  function initTabs() {',
    '    var buttons = [].slice.call(document.querySelectorAll(".tab-btn"));',
    '    function show(name) {',
    '      buttons.forEach(function (b) {',
    '        var on = b.getAttribute("data-tab") === name;',
    '        b.setAttribute("aria-selected", on ? "true" : "false");',
    '      });',
    '      [].slice.call(document.querySelectorAll(".tab-panel")).forEach(function (p) {',
    '        p.hidden = p.getAttribute("data-tab") !== name;',
    '      });',
    '      try { history.replaceState(null, "", "#" + name); } catch (e) {}',
    '    }',
    '    buttons.forEach(function (b) {',
    '      b.addEventListener("click", function () { show(b.getAttribute("data-tab")); });',
    '    });',
    '    var wanted = (location.hash || "").replace("#", "");',
    '    var known = buttons.some(function (b) { return b.getAttribute("data-tab") === wanted; });',
    '    show(known ? wanted : buttons[0].getAttribute("data-tab"));',
    '  }',
    '',
    '  /* ---------- the office ---------- */',
    '  function renderOffice() {',
    '    var office = data.office || {};',
    '    var host = byId("office-body");',
    '    clear(host);',
    '    if (office.text) host.appendChild(el("p", { class: "office-text", text: office.text }));',
    '',
    '    var counts = data.counts || {};',
    '    var tiles = [',
    '      ["agents", T.stat_agents],',
    '      ["questions_handled", T.stat_questions],',
    '      ["reports_written", T.stat_reports],',
    '      ["meetings_held", T.stat_meetings],',
    '      ["interactions_logged", T.stat_interactions],',
    '      ["simulated_day", T.stat_day]',
    '    ];',
    '    var row = el("div", { class: "stat-row" });',
    '    tiles.forEach(function (t) {',
    '      if (counts[t[0]] === undefined || counts[t[0]] === null) return;',
    '      row.appendChild(el("div", { class: "stat" }, [',
    '        el("div", { class: "stat-value", text: String(counts[t[0]]) }),',
    '        el("div", { class: "stat-label", dir: T.dir_chrome, text: t[1] })',
    '      ]));',
    '    });',
    '    host.appendChild(row);',
    '',
    '    var mechs = data.mechanisms || [];',
    '    if (mechs.length) {',
    '      var grid = el("div", { class: "mech-list" });',
    '      mechs.forEach(function (m) {',
    '        grid.appendChild(el("div", { class: "mech" }, [',
    '          el("h3", { text: m.title }),',
    '          el("p", { text: m.text })',
    '        ]));',
    '      });',
    '      host.appendChild(grid);',
    '    }',
    '  }',
    '',
    '  /* ---------- the thirteen (the office\'s own card, both data shapes) ---------- */',
    '  function renderAgentDetail(agent) {',
    '    var children = [];',
    '    var detail = agent.bible_detail;',
    '    if (detail) {',
    '      if (detail.subtitle) children.push(el("p", { class: "agent-detail-subtitle", text: detail.subtitle }));',
    '      (detail.sections || []).forEach(function (s) {',
    '        children.push(el("h4", { class: "agent-detail-section-label", text: s.label }));',
    '        children.push(el("p", { class: "agent-detail-section-text", text: s.text }));',
    '      });',
    '      if (detail.technical_line) children.push(el("p", { class: "agent-detail-technical" }, [',
    '        el("span", { class: "agent-detail-technical-label", dir: T.dir_chrome, text: T.agent_technical }),',
    '        el("span", { text: detail.technical_line })',
    '      ]));',
    '    } else if (agent.character) {',
    '      children.push(el("p", { class: "agent-detail-section-text", text: agent.character }));',
    '    } else {',
    '      children.push(el("p", { class: "agent-detail-missing", dir: T.dir_chrome, text: T.agent_no_character }));',
    '    }',
    '    if (agent.purpose) children.push(el("p", { class: "agent-detail-purpose" }, [',
    '      el("span", { class: "agent-detail-technical-label", dir: T.dir_chrome, text: T.agent_purpose }),',
    '      el("span", { text: agent.purpose })',
    '    ]));',
    '    if (agent.produced && agent.produced.length) {',
    '      children.push(el("div", { class: "agent-produced" }, [',
    '        el("p", { class: "agent-produced-label", dir: T.dir_chrome, text: T.agent_produced }),',
    '        el("ul", {}, agent.produced.map(function (p) { return el("li", { text: p }); }))',
    '      ]));',
    '    }',
    '    return el("div", { class: "agent-detail" }, children);',
    '  }',
    '',
    '  function renderAgentCard(agent) {',
    '    var badges = [];',
    '    if (agent.live === true) badges.push(el("span", { class: "status status--live", dir: T.dir_chrome, text: T.agent_badge_live }));',
    '    else if (agent.live === false) badges.push(el("span", { class: "status status--bible-only", dir: T.dir_chrome, text: T.agent_badge_bible }));',
    '    else if (agent.status) badges.push(el("span", { class: "status status--live", text: agent.status }));',
    '    if (agent.tier) badges.push(el("span", { class: "status status--persona", text: agent.tier }));',
    '    if (agent.has_persona) badges.push(el("span", { class: "status status--persona", text: T.agent_badge_persona }));',
    '',
    '    var isOpen = openAgentId === agent.id;',
    '    var toggle = el("button", { type: "button", class: "agent-detail-toggle" });',
    '    toggle.textContent = isOpen ? T.agent_hide : T.agent_view;',
    '    toggle.addEventListener("click", function () {',
    '      openAgentId = isOpen ? null : agent.id;',
    '      renderAgentGrid();',
    '    });',
    '',
    '    var kids = [',
    '      el("div", { class: "agent-badges" }, badges),',
    '      el("h3", { class: "agent-name", text: agent.name }),',
    '      agent.title ? el("p", { class: "agent-title", text: agent.title }) : null,',
    '      agent.role',
    '        ? el("p", { class: "agent-role", text: agent.role })',
    '        : el("p", { class: "agent-role agent-role--missing", dir: T.dir_chrome, text: T.agent_no_role }),',
    '      agent.purpose',
    '        ? el("p", { class: "agent-purpose", text: agent.purpose })',
    '        : el("p", { class: "agent-purpose agent-purpose--missing", dir: T.dir_chrome, text: T.agent_no_purpose }),',
    '      toggle',
    '    ];',
    '    if (isOpen) kids.push(renderAgentDetail(agent));',
    '    return el("article", {',
    '      class: "agent-card" + (isOpen ? " agent-card--open" : ""),',
    '      role: "listitem", tabindex: "0",',
    '      "aria-label": agent.name + (agent.title ? " — " + agent.title : "")',
    '    }, kids);',
    '  }',
    '',
    '  function renderAgentGrid() {',
    '    var grid = byId("agent-grid");',
    '    if (!grid) return;',
    '    clear(grid);',
    '    (data.agents || []).slice().sort(function (a, b) { return a.id - b.id; })',
    '      .forEach(function (a) { grid.appendChild(renderAgentCard(a)); });',
    '    var live = (data.agents || []).filter(function (a) { return a.live !== false; }).length;',
    '    var note = byId("agent-count-note");',
    '    if (note) { note.setAttribute("dir", T.dir_chrome);',
    '      note.textContent = live + T.agent_count_a + (data.agents || []).length + T.agent_count_b; }',
    '  }',
    '',
    '  /* ---------- what this page cannot show you ---------- */',
    '  function renderGaps() {',
    '    var host = byId("gaps-list");',
    '    if (!host) return;',
    '    clear(host);',
    '    var lines = [];',
    '    GAP_KEYS.forEach(function (key) {',
    '      (data[key] || []).forEach(function (line) { lines.push(line); });',
    '    });',
    '    STATIC_GAPS.forEach(function (g) { lines.push(g); });',
    '    lines.forEach(function (g) { host.appendChild(el("li", { dir: T.dir_chrome, text: g })); });',
    '    var errs = data.errors || [];',
    '    var errHost = byId("gaps-errors");',
    '    if (errHost) {',
    '      clear(errHost);',
    '      if (errs.length) {',
    '        errHost.appendChild(el("h3", { dir: T.dir_chrome, text: T.gaps_errors_heading }));',
    '        errHost.appendChild(el("ul", {}, errs.map(function (e) { return el("li", { text: e }); })));',
    '      }',
    '    }',
    '  }',
    '',
  ].concat(isAdmin ? [
    '  /* ---------- waiting on you (admin only) ----------',
    '',
    '     SESSION 18 (2026-08-25). What changed, and why:',
    '',
    '     THE CARD NOW CARRIES THE THREE PARTS. What is being asked, what the',
    '     options are and what each one means, and what happens if he says',
    '     nothing. Those are composed SERVER-SIDE by the same function that',
    '     writes the office\'s email and its Issues — this renders them, it does',
    '     not compose a second version of them.',
    '',
    '     AND IT TAKES THE ANSWER HERE. Four input channels have been built for',
    '     this owner over a month and each one broke at the step below it. The',
    '     answer goes through the path that already works, unchanged: the same',
    '     POST the spec builder uses, into channel/from-owner/, refused by the',
    '     office\'s own parser before anything is written if it would not accept',
    '     the file.',
    '',
    '     THE ONE CLAIM THIS PAGE IS CAREFUL NOT TO MAKE is that answering makes',
    '     an item disappear from THIS list. It does not: this list reads the',
    '     ledger, and only the office marks a ledger entry. What an answer stops',
    '     is the office ASKING AGAIN by email and Issue — and only for the items',
    '     whose id its reader matches, which the card says on its face. ---- */',
    '  function renderPending() {',
    '    var host = byId("pending-groups");',
    '    if (!host) return;',
    '    clear(host);',
    '    var items = data.pending_items || [];',
    '    if (!items.length) {',
    '      host.appendChild(el("p", { class: "section-note", dir: T.dir_chrome, text: T.pending_empty }));',
    '      return;',
    '    }',
    '    var groups = {}, order = [];',
    '    items.forEach(function (i) {',
    '      if (!groups[i.kind]) { groups[i.kind] = []; order.push(i.kind); }',
    '      groups[i.kind].push(i);',
    '    });',
    /* The six group headings. Keyed by the kind the office assigned, and the
       fallback is the kind itself rather than an invented label — a kind this
       page has not been taught is shown as what it is, not renamed. */
    '    var labels = {',
    '      decision: T.group_decision, authorization: T.group_authorization,',
    '      blocked: T.group_blocked, question: T.group_question,',
    '      approval: T.group_approval, submission: T.group_submission',
    '    };',
    '    order.forEach(function (kind) {',
    '      var kids = [el("h3", { class: "pending-group-title", dir: T.dir_chrome, text: (labels[kind] || kind) + " (" + groups[kind].length + ")" })];',
    '      groups[kind].forEach(function (item) { kids.push(renderPendingItem(item)); });',
    '      host.appendChild(el("div", { class: "pending-group" }, kids));',
    '    });',
    '    var tabCount = byId("pending-tab-count");',
    '    if (tabCount) tabCount.textContent = "(" + items.length + ")";',
    '  }',
    '',
    '  function renderPendingItem(item) {',
    '    var notice = item.notice || null;',
    '    var headline = item.ask || item.title || T.pending_no_title;',
    '    var card = [',
    '      el("p", { class: "pending-source", text: item.source_plain || "" }),',
    '      el("h4", { class: "pending-title", text: headline })',
    '    ];',
    '',
    /* The ask, where the office phrased what it needs differently from the
       item's own title. Shown only when it says something the headline does
       not. THE OFFICE'S OWN WORDS — no dir, no translation. */
    '    if (notice && notice.ask && notice.ask !== headline) {',
    '      card.push(el("p", { class: "pending-ask", text: notice.ask }));',
    '    }',
    /* detail_plain, never detail: the office's own "Blocked by: OB-001" names
       an item the client has never agreed to learn. The plain form substitutes
       a noun phrase rather than deleting the id, because deleting one from the
       middle of a sentence is what produced Issue #47's broken text. */
    '    var detail = item.detail_plain || item.detail;',
    '    if (detail) card.push(el("p", { class: "pending-detail", text: detail }));',
    '',
    '    if (notice && notice.options && notice.options.length) {',
    '      var opts = notice.options.map(function (o) {',
    '        return el("li", { class: "pending-option" }, [',
    '          el("span", { class: "pending-option-label", text: o.label }),',
    '          el("span", { text: o.text })',
    '        ]);',
    '      });',
    '      card.push(el("ul", { class: "pending-options" }, opts));',
    '    }',
    '',
    '    if (notice && notice.no_answer) {',
    '      card.push(el("p", { class: "pending-when" }, [',
    '        el("span", { dir: T.dir_chrome, text: T.pending_if_nothing }),',
    '        el("span", { text: notice.no_answer })',
    '      ]));',
    '    }',
    '    if (item.by_when) card.push(el("p", { class: "pending-when", text: item.by_when }));',
    '    var note = item.status_note_plain || item.status_note;',
    '    if (note) card.push(el("p", { class: "pending-status-note", text: note }));',
    '',
    /* What the office could NOT state. Shown, never swallowed: an item with no
       recorded default is one where the office does not know what it will do
       if he stays quiet, and that is the most important sentence on the card.

       The TAIL of this sentence is item-detail.js's NO_STATED_DEFAULT and is
       English in both chrome variants, deliberately. See the dictionary. */
    '    if (notice && notice.missing && notice.missing.length) {',
    '      card.push(el("p", { class: "pending-missing",',
    '        text: T.pending_missing_head + notice.missing.join(", ") + T.pending_missing_tail }));',
    '    } else if (!notice) {',
    '      card.push(el("p", { class: "pending-missing", dir: T.dir_chrome, text: T.pending_no_notice }));',
    '    }',
    '',
    '    var article = el("article", { class: "pending-item" }, card);',
    /* ONE loader per card, shared by both controls below. The detail endpoint
       costs up to seventeen GitHub requests; opening the blocker and then
       opening the whole item must not pay that twice. */
    '    var loader = itemLoader(item);',
    '    var blocker = blockerControl(item, loader);',
    '    if (blocker) article.appendChild(blocker);',
    '    article.appendChild(expandControl(item, loader));',
    '    article.appendChild(answerBox(item, article));',
    '',
    '    var respond = el("button", { type: "button", class: "respond-btn" });',
    '    respond.textContent = T.pending_spec_instead;',
    '    respond.addEventListener("click", function () { openSpecFor(item); });',
    '    article.appendChild(respond);',
    '    return article;',
    '  }',
    '',
    /* ---------- one fetch per card, shared ----------
     *
     * FETCH ON OPEN, NEVER ON PAGE LOAD. Twenty items' full source material on
     * every load is the 272 KB board problem moved somewhere worse, and the
     * detail endpoint makes up to seventeen GitHub requests per item. So each
     * card opens on its own, once — and because a card now has TWO controls
     * that want the same answer ("what is blocking this" and "open this item"),
     * the answer is memoised here rather than inside either of them. A second
     * request for an item that has already been read is free, and a request
     * made while one is in flight joins it instead of starting another.
     *
     * The route is `/admin/api/item?id=…`, INSIDE the prefix Cloudflare Access
     * binds — `admin-gate.js`'s alias map carries `['item', '/api/admin/item']`
     * and the rewrite happens before the gates. A bare `/api/...` here would
     * arrive with no Access assertion on it, which is the defect that map
     * exists to prevent.
     */
    '  function itemLoader(item) {',
    '    var loaded = null;',
    '    var waiting = null;',
    '    return function (onDone) {',
    '      if (loaded) { onDone(loaded); return; }',
    '      if (waiting) { waiting.push(onDone); return; }',
    '      waiting = [onDone];',
    '      var finish = function (result) {',
    '        loaded = result;',
    '        var queue = waiting; waiting = null;',
    '        queue.forEach(function (cb) { cb(result); });',
    '      };',
    '      fetch("/admin/api/item?id=" + encodeURIComponent(item.id), { headers: adminHeaders(), cache: "no-store" })',
    '        .then(function (res) { return res.json().then(function (b) { return { status: res.status, body: b }; }); })',
    '        .then(function (r) {',
    '          if (!r.body || r.body.ok !== true) {',
    '            finish({ ok: false, problem: T.item_http_failed_a + r.status + T.item_http_failed_b',
    '              + ((r.body && r.body.reason) || T.item_no_reason) });',
    '            return;',
    '          }',
    '          finish({ ok: true, detail: r.body });',
    '        })',
    '        .catch(function (err) { finish({ ok: false, problem: T.item_unreachable + err.message }); });',
    '    };',
    '  }',
    '',
    /* ---------- the blocker, on the card ----------
     *
     * ADDED 2026-08-30. The card used to say *"Blocked by another item on the
     * board"* and stop there. Which item, and what that item says, was three
     * clicks and a scroll away inside the full expansion — and the full
     * expansion opens with the item's own entry, so the blocker was below the
     * fold of a panel opened for a different question.
     *
     * `resolveBlockers()` has returned the blocking entry IN FULL since the
     * endpoint was built. Nothing new is fetched and nothing new is parsed:
     * this is the same answer, surfaced where the question is asked.
     *
     * WHO GETS THE CONTROL. Only a card whose own board entry carries a
     * "Blocked by" line — `site-data.js` writes `detail` as
     * `"Blocked by: <the office's words>"` for exactly those, and writes a
     * different sentence when the board states none. The test is on the
     * office's own text rather than on the card's `kind`, because a NOT-READY
     * task can carry a blocker too and would be missed by a kind check.
     */
    '  function blockerControl(item, loader) {',
    '    if (!/^Blocked by:/i.test(String(item.detail || ""))) return null;',
    '    var wrap = el("div", {});',
    '    var btn = el("button", { type: "button", class: "item-open blocker-open" });',
    '    var panel = el("div", { class: "item-detail blocker-detail" });',
    '    panel.hidden = true;',
    '    var shown = false;',
    '    btn.textContent = T.blocker_open;',
    '',
    '    btn.addEventListener("click", function () {',
    '      if (shown) {',
    '        panel.hidden = !panel.hidden;',
    '        btn.textContent = panel.hidden ? T.blocker_open : T.blocker_close;',
    '        return;',
    '      }',
    '      panel.hidden = false;',
    '      clear(panel);',
    '      panel.appendChild(el("p", { class: "item-line", dir: T.dir_chrome, text: T.blocker_reading }));',
    '      loader(function (r) {',
    '        clear(panel);',
    /* A failed lookup is REPORTED, never rendered as an empty panel. An
       expansion that opens blank reads as "there was nothing more to show",
       which is the opposite of what a failed read means. */
    '        if (!r.ok) {',
    '          panel.appendChild(el("p", { class: "item-problem", dir: T.dir_chrome, text: r.problem }));',
    '          btn.textContent = T.item_retry;',
    '          return;',
    '        }',
    '        shown = true;',
    '        renderBlockerSection(panel, r.detail, false);',
    '        btn.textContent = T.blocker_close;',
    '      });',
    '    });',
    '',
    '    wrap.appendChild(btn);',
    '    wrap.appendChild(panel);',
    '    return wrap;',
    '  }',
    '',
    /* ---------- the expansion: one item, whole ----------
     *
     * WHAT IT SHOWS IS WHAT THE OFFICE WROTE. The entry is inserted with
     * textContent into a `pre`; nothing here summarises, re-wraps, translates
     * or explains it, and no model is anywhere in this path.
     */
    '  function expandControl(item, loader) {',
    '    var wrap = el("div", {});',
    '    var btn = el("button", { type: "button", class: "item-open" });',
    '    var panel = el("div", { class: "item-detail" });',
    '    panel.hidden = true;',
    '    var shown = false;',
    '    btn.textContent = T.item_open;',
    '',
    '    btn.addEventListener("click", function () {',
    '      if (shown) {',
    '        panel.hidden = !panel.hidden;',
    '        btn.textContent = panel.hidden ? T.item_open : T.item_close;',
    '        return;',
    '      }',
    '      panel.hidden = false;',
    '      btn.textContent = T.item_opening;',
    '      clear(panel);',
    '      panel.appendChild(el("p", { class: "item-line", dir: T.dir_chrome, text: T.item_reading }));',
    '      loader(function (r) {',
    '        clear(panel);',
    '        if (!r.ok) {',
    '          panel.appendChild(el("p", { class: "item-problem", dir: T.dir_chrome, text: r.problem }));',
    '          btn.textContent = T.item_retry;',
    '          return;',
    '        }',
    '        shown = true;',
    '        renderItemDetail(panel, r.detail);',
    '        btn.textContent = T.item_close;',
    '      });',
    '    });',
    '',
    '    wrap.appendChild(btn);',
    '    wrap.appendChild(panel);',
    '    return wrap;',
    '  }',
    '',
    /* ---------- the blocker, rendered — ONE implementation ----------
     *
     * Called by the card's own blocker control AND by the full expansion. Two
     * renderings of one answer is the drift this estate keeps finding; the
     * only difference between the two callers is `withHeading`, because inside
     * the full expansion the section needs a heading to separate it from the
     * entry above it, and on the card it IS the panel.
     *
     * Every value below — `r.title`, `r.state`, `r.verbatim`, `b.stated`,
     * `u.reason` — comes out of `resolveBlockers()` and is rendered as it
     * arrived. Only the labels around them are the page's own words.
     */
    '  function renderBlockerSection(host, d, withHeading) {',
    '    var b = d.blocker || {};',
    '    var anything = b.stated || (b.resolved && b.resolved.length) || (b.unresolved && b.unresolved.length);',
    '    if (!anything) {',
    '      if (!withHeading) host.appendChild(el("p", { class: "item-line", dir: T.dir_chrome, text: T.blocker_none_read }));',
    '      return;',
    '    }',
    '    if (withHeading) host.appendChild(el("h5", { dir: T.dir_chrome, text: T.item_h_blocker }));',
    /* The board's own "Blocked by" line, verbatim and with its identifiers
       intact. The CARD shows the plain-language form; this is the record. */
    '    if (b.stated) host.appendChild(el("p", { class: "item-line", text: b.stated }));',
    '    if (b.names_no_item) {',
    '      host.appendChild(el("p", { class: "item-line", dir: T.dir_chrome, text: T.item_blocker_none_named }));',
    '    }',
    '    (b.resolved || []).forEach(function (r) {',
    '      var box = el("div", { class: "item-blocker" });',
    '      var head = el("p", { class: "item-blocker-head" });',
    '      head.appendChild(el("span", { class: "item-blocker-id", text: r.item_id }));',
    '      head.appendChild(el("span", { text: " — " + (r.title || T.item_blocker_no_title) + (r.state ? "  ·  " + r.state : "") }));',
    '      box.appendChild(head);',
    /* Found beside the board rather than on it. "Finished and filed elsewhere"
       and "still on the board" are different answers to the owner's question,
       so the card names the file it actually came out of. */
    '      if (r.elsewhere) {',
    '        box.appendChild(el("p", { class: "item-line" }, [',
    '          el("span", { dir: T.dir_chrome, text: T.item_blocker_elsewhere }),',
    '          el("code", { text: r.file })',
    '        ]));',
    '      }',
    /* A struck-through entry is one the office's own board parser does not
       read. Saying so matters: it is why the blocker appears in no count, and
       it is the difference between "this is still open" and "this is finished
       and the blocking line was never cleared". */
    '      if (r.match === "decided") {',
    '        box.appendChild(el("p", { class: "item-line", dir: T.dir_chrome, text: T.item_blocker_struck }));',
    '      }',
    '      box.appendChild(el("pre", { class: "item-verbatim", text: r.verbatim }));',
    '      host.appendChild(box);',
    '    });',
    /* NAMED, AND NOT THERE. The reason sentence is the server's, and it says
       where it looked — a silently missing blocker reads as "nothing blocks
       this", which is the confusion this whole path exists to remove. */
    '    (b.unresolved || []).forEach(function (u) {',
    '      host.appendChild(el("p", { class: "item-problem" }, [',
    '        el("span", { dir: T.dir_chrome, text: T.item_blocker_unresolved }),',
    '        el("span", { text: u.reason })',
    '      ]));',
    '    });',
    '  }',
    '',
    '  function renderItemDetail(panel, d) {',
    '    var src = d.source || {};',
    '',
    '    /* The whole entry, as the office wrote it. */',
    '    panel.appendChild(el("h5", { dir: T.dir_chrome, text: T.item_h_entry }));',
    '    if (d.entry && d.entry.verbatim) {',
    '      panel.appendChild(el("pre", { class: "item-verbatim", text: d.entry.verbatim }));',
    '    } else {',
    '      panel.appendChild(el("p", { class: "item-problem",',
    '        text: T.item_entry_unreadable_a + (src.file || T.item_entry_unreadable_b)',
    '          + T.item_entry_unreadable_c + (src.reason || T.item_entry_unreadable_d) + "." }));',
    '    }',
    '',
    '    /* The blocker, named — the same renderer the card itself uses. */',
    '    renderBlockerSection(panel, d, true);',
    '',
    '    /* Where it came from, and when it entered the record — from git. */',
    '    panel.appendChild(el("h5", { dir: T.dir_chrome, text: T.item_h_where }));',
    '    var where = el("p", { class: "item-line" });',
    '    where.appendChild(el("span", { text: (src.what || T.item_where_file) + " — " }));',
    '    where.appendChild(el("code", { text: (src.repo || "") + "/" + (src.file || "") }));',
    '    panel.appendChild(where);',
    '    panel.appendChild(originLine(d.origin || {}));',
    '',
    '    /* Whether it has a stated default — in the office\'s own words when it',
    '       has none. `def.words` is item-detail.js\'s NO_STATED_DEFAULT and is',
    '       rendered exactly as it arrived; only the prefix is this page\'s. */',
    '    panel.appendChild(el("h5", { dir: T.dir_chrome, text: T.item_h_if_nothing }));',
    '    var def = d.default || {};',
    '    if (def.stated) {',
    '      panel.appendChild(el("p", { class: "item-line", text: def.label + ": " + def.text }));',
    '    } else {',
    '      panel.appendChild(el("p", { class: "pending-missing" }, [',
    '        el("span", { dir: T.dir_chrome, text: T.default_none_head }),',
    '        el("span", { text: def.words })',
    '      ]));',
    '    }',
    '    if (d.answer_note) panel.appendChild(el("p", { class: "item-line", text: d.answer_note }));',
    '',
    '    /* Every read this answer needed, including the ones that failed. */',
    '    panel.appendChild(el("h5", { dir: T.dir_chrome, text: T.item_h_lookups }));',
    '    var list = el("ul", { class: "item-lookups" });',
    '    (d.lookups || []).forEach(function (l) {',
    '      var bits = l.what;',
    '      if (l.bytes != null) bits += " (" + l.bytes + T.lk_chars_b;',
    '      if (l.count != null) bits += " (" + l.count + T.lk_commits_b + (l.complete === false ? T.lk_commits_capped : "") + ")";',
    '      if (l.file_reads != null) bits += " (" + l.file_reads + T.lk_reads_b;',
    '      if (!l.ok) bits += T.lk_failed + (l.reason || T.item_no_reason);',
    '      else if (l.reason) bits += " — " + l.reason;',
    '      list.appendChild(el("li", { class: l.ok ? "" : "item-failed", text: bits }));',
    '    });',
    '    panel.appendChild(list);',
    '  }',
    '',
    /* The office has never dated one of its own records from git before. The
       precision is carried in words rather than collapsed into a date, because
       "first appeared on the 10th" and "first appeared on or before the 10th"
       are different claims and only one of them is usually true. */
    '  function originLine(o) {',
    '    if (o.ok && o.precision === "exact" && o.commit) {',
    '      return el("p", { class: "item-line",',
    '        text: T.origin_exact_a + String(o.commit.date || "").slice(0, 10)',
    '          + T.origin_exact_b + String(o.commit.sha || "").slice(0, 7) + ", \\"" + (o.commit.message || "")',
    '          + T.origin_exact_d });',
    '    }',
    '    if (o.ok && o.precision === "at-or-before" && o.commit) {',
    '      return el("p", { class: "item-line",',
    '        text: T.origin_before_a + String(o.commit.date || "").slice(0, 10)',
    '          + T.origin_before_b + String(o.commit.sha || "").slice(0, 7) + "). " + (o.reason || "") });',
    '    }',
    '    if (o.ok && o.precision === "window" && o.window) {',
    '      return el("p", { class: "item-line",',
    '        text: T.origin_window_a + String(o.window.oldest && o.window.oldest.date || "").slice(0, 10)',
    '          + T.origin_window_b + String(o.window.newest && o.window.newest.date || "").slice(0, 10)',
    '          + ". " + (o.reason || "") });',
    '    }',
    '    return el("p", { class: "item-line", text: T.origin_none_a + (o.reason || T.origin_none_b) + "." });',
    '  }',
    '',
    '  /* ---------- the answer, in place ---------- */',
    '',
    '  /* Sending needs a content type; reading does not. The token is added only',
    '     if this tab HAS one — a browser that arrived through Google sign-in has',
    '     no token and does not need one, because Cloudflare puts the signed',
    '     assertion on this request and the Worker accepts it. That is the whole',
    '     of why the prompt below stops appearing once Access is enforcing. */',
    '  function postHeaders() {',
    '    var h = adminHeaders();',
    '    h["Content-Type"] = "application/json";',
    '    return h;',
    '  }',
    '',
    '  /* The subject leads with the item id and the reason is mechanical, not',
    '     bureaucratic: the office\'s reader (itemIdsInText) attributes a reply to',
    '     an item by finding its id in the file, and the filename slug is cut at',
    '     48 characters — an id at the END would be truncated away, taking the',
    '     attribution and the uniqueness of the filename with it. */',
    '  function answerSubject(item) {',
    '    var ask = (item.ask || item.title || "answer").replace(/\\s+/g, " ").trim();',
    '    if (ask.length > 64) ask = ask.slice(0, 63).replace(/[\\s,;:.-]+$/, "") + "…";',
    '    return item.item_id ? item.item_id + " — " + ask : ask;',
    '  }',
    '',
    '  function answerBody(item, text) {',
    '    var lines = [text.trim(), "", "---", ""];',
    /* The provenance line describes the ROUTE, not the author. "Answered by
       the owner" would be a claim about who typed it, and this page has no
       way to check that — it knows only which door the message came through.
       The office's record must not carry an authorship claim its writer could
       not verify. */
    '    lines.push("Filed through the office admin page, on the waiting-on-you tab.");',
    '    if (item.item_id) lines.push("In answer to item " + item.item_id + ".");',
    '    return lines.join("\\n");',
    '  }',
    '',
    '  function answerBox(item, article) {',
    '    var box = el("div", { class: "answer-box" });',
    '    var input = el("textarea", {',
    '      placeholder: T.answer_placeholder,',
    '      dir: T.dir_chrome,',
    '      "aria-label": T.answer_aria',
    '    });',
    '    var send = el("button", { type: "button", class: "answer-send" });',
    '    send.textContent = T.answer_send;',
    '    var status = el("p", { class: "answer-status" });',
    '',
    '    var effect = item.answer_stops_the_asking',
    '      ? T.answer_effect_stops',
    '      : (item.answer_note || T.answer_effect_default);',
    '',
    '    send.addEventListener("click", function () {',
    '      var text = input.value.trim();',
    '      if (!text) { say(status, T.answer_empty, "err"); return; }',
    '      send.disabled = true;',
    '      say(status, T.answer_sending, "");',
    '      fetch("/admin/api/agents/owner-message", {',
    '        method: "POST",',
    '        headers: postHeaders(),',
    '        cache: "no-store",',
    '        body: JSON.stringify({',
    '          subject: answerSubject(item),',
    '          body: answerBody(item, text),',
    '          kind: item.answer_kind || "instruction",',
    '          re: "new"',
    '        })',
    '      }).then(function (res) { return res.json().then(function (b) { return { status: res.status, body: b }; }); })',
    '        .then(function (r) {',
    '          if (!r.body || r.body.ok !== true) {',
    '            send.disabled = false;',
    '            /* The parser\'s own words, verbatim. The office refuses before it',
    '               writes, and a page that summarised the refusal would hide the',
    '               only thing that says how to fix it. */',
    '            say(status, T.answer_refused_a + r.status + T.answer_refused_b + ((r.body && r.body.reason) || T.item_no_reason), "err");',
    '            return;',
    '          }',
    '          input.disabled = true;',
    '          article.className = "pending-item pending-item--answered";',
    '          clear(status);',
    '          status.className = "answer-status answer-status--ok";',
    '          status.appendChild(el("span", { dir: T.dir_chrome, text: T.answer_filed_a }));',
    '          status.appendChild(el("code", { text: r.body.path }));',
    '          status.appendChild(el("span", { text: ". " + (r.body.note || "") }));',
    '          status.appendChild(el("span", { text: " " + effect }));',
    '          status.appendChild(el("span", { dir: T.dir_chrome, text: T.answer_stays }));',
    '          send.textContent = T.answer_sent;',
    '        })',
    '        .catch(function (err) {',
    '          send.disabled = false;',
    '          say(status, T.item_unreachable + err.message, "err");',
    '        });',
    '    });',
    '',
    '    box.appendChild(input);',
    '    box.appendChild(el("div", { class: "answer-actions" }, [',
    '      send, el("span", { class: "answer-effect", text: effect })',
    '    ]));',
    '    box.appendChild(status);',
    '    return box;',
    '  }',
    '',
    '  function say(node, text, kind) {',
    '    clear(node);',
    '    node.className = "answer-status" + (kind ? " answer-status--" + kind : "");',
    '    node.textContent = text;',
    '  }',
    '',
    /* The office's Respond button used to seed a localStorage note. It then
       opened the real spec builder with the item's title in the URL fragment —
       and the builder read no fragment at all, so it opened EMPTY and the owner
       retyped what this card had just told him.

       It now passes the item's IDENTITY, and the builder asks the office for
       that item and fills what the item honestly states. The id rather than the
       text, because the text is what the builder would then have to
       re-derive — and one derivation, server-side, in the module that owns the
       seven fields, is the whole point. */
    '  function openSpecFor(item) {',
    '    var frame = byId("spec-frame");',
    '    var btn = document.querySelector(\'.tab-btn[data-tab="spec"]\');',
    '    if (btn) btn.click();',
    '    if (frame) frame.src = "/admin/spec#item=" + encodeURIComponent(item.id);',
    '  }',
    '',
    '  /* ---------- office data: what runs, and what it produced ---------- */',
    '  function renderOfficeData() {',
    '    var host = byId("office-data-body");',
    '    if (!host) return;',
    '    clear(host);',
    '    var auto = data.automation || null;',
    '    if (!auto) {',
    '      host.appendChild(el("p", { class: "state-note", dir: T.dir_chrome, text: T.office_data_none }));',
    '      return;',
    '    }',
    '',
    '    host.appendChild(table(T.od_meetings_title,',
    '      T.od_meetings_cols,',
    '      (auto.meeting_types || []).map(function (m) {',
    '        return [m.type || "—", String(m.count), m.last_at || T.od_never];',
    '      })));',
    '',
    '    host.appendChild(table(T.od_reports_title,',
    '      T.od_reports_cols,',
    '      (auto.report_types || []).map(function (r) {',
    '        return [r.type || "—", String(r.count), r.last_at || T.od_never];',
    '      })));',
    '',
    '    var byDay = {}, dayOrder = [];',
    '    (auto.blocks || []).forEach(function (b) {',
    '      if (!byDay[b.day_type]) { byDay[b.day_type] = []; dayOrder.push(b.day_type); }',
    '      byDay[b.day_type].push(b);',
    '    });',
    '    dayOrder.forEach(function (day) {',
    '      host.appendChild(table(T.od_day_title + day,',
    '        T.od_day_cols,',
    '        byDay[day].map(function (b) {',
    '          var what = (b.type || "—") + (b.label ? " — " + b.label : "");',
    '          var evidence = b.evidence',
    '            ? (b.evidence.last_at || T.od_never) + " (" + b.evidence.count + T.od_in_db_b',
    '            : b.evidence_note;',
    '          return [b.time || "—", what, evidence];',
    '        }), true));',
    '    });',
    '',
    '    if (auto.notes && auto.notes.length) {',
    '      var ul = el("ul", { class: "gaps-list" }, auto.notes.map(function (n) { return el("li", { text: n }); }));',
    '      host.appendChild(el("div", { class: "auto-group" }, [',
    '        el("h3", { dir: T.dir_chrome, text: T.od_notes_title }), ul',
    '      ]));',
    '    }',
    '  }',
    '',
    '  function table(title, headers, rows, timeFirst) {',
    '    var thead = el("tr", {}, headers.map(function (h) { return el("th", { dir: T.dir_chrome, text: h }); }));',
    '    var body = rows.length',
    '      ? rows.map(function (cells) {',
    '        return el("tr", {}, cells.map(function (c, i) {',
    '          var cls = (timeFirst && i === 0) ? "auto-time" : (c === T.od_never ? "auto-none" : "");',
    '          return el("td", cls ? { class: cls, text: String(c) } : { text: String(c) });',
    '        }));',
    '      })',
    '      : [el("tr", {}, [el("td", { class: "auto-none", dir: T.dir_chrome, text: T.od_nothing })])];',
    '    var t = el("table", { class: "auto-table" }, [el("thead", {}, [thead]), el("tbody", {}, body)]);',
    '    return el("div", { class: "auto-group" }, [',
    '      el("h3", { dir: T.dir_chrome, text: title }),',
    '      el("div", { class: "auto-scroll" }, [t])',
    '    ]);',
    '  }',
    '',
    '  extraRender = function () { renderPending(); renderOfficeData(); };',
    '',
  ] : []).concat([
    '  /* ---------- load ---------- */',
    '  function adminHeaders() {',
    '    var t = "";',
    '    try { t = sessionStorage.getItem("office.token") || sessionStorage.getItem("office-admin-token") || ""; } catch (e) {}',
    '    return t ? { "X-Admin-Token": t } : {};',
    '  }',
    '',
    '  function showTokenPrompt(host) {',
    '    clear(host);',
    '    host.appendChild(el("p", { class: "state-note state-note--error",',
    '      dir: T.dir_chrome, text: SIGNED_IN ? T.token_expired : T.token_missing }));',
    /* Nothing to paste when a sign-in is what authorised this page: the
       recovery is a reload, not a secret he does not have. */
    '    if (SIGNED_IN) return;',
    '    var input = el("input", { type: "password", placeholder: "X-Admin-Token", autocomplete: "off" });',
    '    var go = el("button", { type: "button", class: "message-send-btn" });',
    '    go.textContent = T.token_use;',
    '    go.addEventListener("click", function () {',
    '      if (!input.value.trim()) return;',
    '      try { sessionStorage.setItem("office.token", input.value.trim()); } catch (e) {}',
    '      try { sessionStorage.setItem("office-admin-token", input.value.trim()); } catch (e) {}',
    '      load();',
    '    });',
    '    host.appendChild(el("div", { class: "token-prompt" }, [input, go]));',
    '  }',
    '',
    '  function load() {',
    '    var status = byId("load-status");',
    '    status.hidden = false;',
    '    clear(status);',
    '    status.appendChild(el("p", { class: "state-note", dir: T.dir_chrome, text: T.loading }));',
    '',
    '    fetch(ENDPOINT, { headers: MODE === "admin" ? adminHeaders() : {}, cache: "no-store" })',
    '      .then(function (res) {',
    '        if (res.status === 401 || res.status === 403) { showTokenPrompt(status); return null; }',
    '        if (!res.ok) throw new Error(T.http_status + res.status);',
    '        return res.json();',
    '      })',
    '      .then(function (body) {',
    '        if (!body) return;',
    '        data = body;',
    '        status.hidden = true;',
    '        renderOffice();',
    '        renderAgentGrid();',
    '        renderGaps();',
    '        if (extraRender) extraRender();',
    '        var stamp = byId("generated-at");',
    '        if (stamp) stamp.textContent = data.generated_at || T.unknown;',
    '        var src = byId("data-source");',
    '        if (src) src.textContent = ENDPOINT;',
    '      })',
    '      .catch(function (err) {',
    '        clear(status);',
    '        status.hidden = false;',
    '        status.appendChild(el("p", { class: "state-note state-note--error",',
    '          dir: T.dir_chrome, text: T.load_failed + err.message }));',
    '      });',
    '  }',
    '',
    '  var STATIC_GAPS = ' + JSON.stringify(staticGaps(mode)) + ';',
    // The public payload has no data_gaps and the public bundle does not know
    // the name.
    '  var GAP_KEYS = ' + JSON.stringify(isAdmin ? ['notes', 'data_gaps'] : ['notes']) + ';',
    '',
    '  function boot() { initTabs(); load(); }',
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);',
    '  else boot();',
    '})();',
  ]);
  return fillChromeSlot(lines, mode).join('\n');
}

/**
 * The chrome slot, filled with EXACTLY the strings this bundle uses.
 *
 * ── WHY THE BUNDLE IS FILTERED AND NOT JUST SERIALISED ──────────────────
 *
 * §2 of `scripts/verify-office-site.js` asserts that the PUBLIC bundle contains
 * no admin material — not that a runtime check hides it, but that the code and
 * the vocabulary are not there. Serialising the whole dictionary into both
 * bundles broke that on the first attempt: the public page started shipping
 * *"The office returned no automation data on this request."*, a sentence about
 * a tab the public page does not have, and the verifier caught it.
 *
 * A hand-maintained "admin-only keys" list would have fixed the symptom and
 * gone stale the first time somebody added a key. So the keys are taken from
 * THE BUNDLE ITSELF: every `T.something` the assembled script actually
 * references, and nothing else. The public bundle cannot carry an admin string
 * because the public bundle does not contain the code that reads one.
 *
 * A key referenced but absent from the dictionary ships as `undefined` rather
 * than throwing — a render that 500s the owner's page over a typo is worse than
 * one that shows a gap — and `verify-office-site.js` asserts there are none.
 */
const CHROME_SLOT = '  /* __CHROME__ */';

export function fillChromeSlot(lines, mode) {
  const chrome = officeChrome(mode);
  const used = new Set(
    [...lines.join('\n').matchAll(/\bT\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  );
  const shipped = {};
  for (const key of [...used].sort()) shipped[key] = chrome[key];
  const out = lines.slice();
  const at = out.indexOf(CHROME_SLOT);
  if (at >= 0) {
    /* THE CHROME, AND ONLY THE CHROME. Every string in here is written in
     * office-site-page.js and is the same string regardless of which item is
     * showing. Nothing that came off the wire is looked up in it, and nothing
     * in it is applied to a value that did. See the dictionary's own header. */
    out[at] = '  var T = ' + JSON.stringify(shipped) + ';';
  }
  return out;
}

/** The keys a bundle would ship for one mode. Exported for the verifier, which
 *  asserts every one of them resolves — the check that makes the
 *  ship-undefined-rather-than-throw decision above safe. */
export function chromeKeysUsed(mode) {
  const script = clientScript(mode, false);
  return [...new Set([...script.matchAll(/\bT\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))].sort();
}

/**
 * "What this page cannot show you", rewritten for a page that CAN now call a
 * live server.
 *
 * The office's original six gaps were all consequences of being static — the
 * first one literally read *"Live D1 report/case counts are not available from
 * a static page"*, and it is no longer true. Leaving that list up would have
 * been false in the other direction, which is the same failure the section was
 * built to prevent. What replaces it is what is still genuinely missing, plus
 * the new limits the live wiring introduces and the snapshot version did not
 * have. The live endpoints supply their own notes on top of these.
 */
function staticGaps(mode) {
  const c = officeChrome(mode);
  return c.gaps_shared.concat(mode === 'admin' ? c.gaps_admin : c.gaps_public);
}

/**
 * The page.
 *
 * `mode`: 'public' (served at `/`) or 'admin' (served at `/admin`, behind the
 * gate). The admin render is the only one that contains the pending list, the
 * spec builder frame, or the string `/api/admin`.
 */
export function officeStylesheet() {
  return `${OFFICE_CSS}
${OFFICE_CSS_ADDITIONS}`;
}

export function renderOfficeSite({ mode = 'public', signedInViaAccess = false } = {}) {
  const isAdmin = mode === 'admin';
  /* The chrome for THIS surface. Hebrew on /admin, English on /. See the
   * dictionary's header: the same function serves both pages, so a label is
   * looked up rather than replaced. */
  const c = officeChrome(mode);

  const tabs = [];
  if (isAdmin) {
    tabs.push({ id: 'pending', label: c.tab_pending, count: true });
  }
  tabs.push({ id: 'office', label: c.tab_office });
  tabs.push({ id: 'agents', label: c.tab_agents });
  if (isAdmin) tabs.push({ id: 'spec', label: c.tab_spec });
  if (isAdmin) tabs.push({ id: 'office-data', label: c.tab_office_data });
  tabs.push({ id: 'gaps', label: c.tab_gaps });

  const tabButtons = tabs.map((t) =>
    '        <button class="tab-btn" type="button" role="tab" dir="' + c.dir_chrome + '" data-tab="' + t.id + '" aria-selected="false">'
    + t.label
    + (t.count ? ' <span class="tab-count" id="pending-tab-count"></span>' : '')
    + '</button>').join('\n');

  const pendingPanel = !isAdmin ? '' : `
      <section class="tab-panel pending" data-tab="pending" hidden>
        <div class="wrap">
          <h2 dir="${c.dir_chrome}">${c.tab_pending}</h2>
          <p class="section-note" dir="${c.dir_chrome}">${c.pending_note}</p>
          <div id="pending-groups" class="pending-groups"></div>
        </div>
      </section>`;

  const specPanel = !isAdmin ? '' : `
      <section class="tab-panel" data-tab="spec" hidden>
        <div class="wrap">
          <h2 dir="${c.dir_chrome}">${c.tab_spec}</h2>
          <p class="section-note" dir="${c.dir_chrome}">
            ${c.spec_note_a} <code dir="ltr">/admin/spec</code> ${c.spec_note_b}
            <code dir="ltr">channel/from-owner/</code> ${c.spec_note_c}
          </p>
          <iframe id="spec-frame" class="spec-frame" src="/admin/spec" title="${c.spec_frame_title}"></iframe>
        </div>
      </section>`;

  const officeDataPanel = !isAdmin ? '' : `
      <section class="tab-panel" data-tab="office-data" hidden>
        <div class="wrap">
          <h2 dir="${c.dir_chrome}">${c.tab_office_data}</h2>
          <p class="section-note" dir="${c.dir_chrome}">${c.office_data_note}</p>
          <div id="office-data-body"></div>
        </div>
      </section>`;

  const ownerLink = isAdmin
    ? '<p class="section-note" dir="' + c.dir_chrome + '"><a href="/admin/owner">' + c.link_owner_page
      + '</a> · <a href="/">' + c.link_public_view + '</a></p>'
    : '';

  return `<!doctype html>
<html lang="${c.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.h1}${isAdmin ? c.title_owner_suffix : ''}</title>
<meta name="description" content="${c.lede}">
${isAdmin ? '<meta name="robots" content="noindex, nofollow">\n' : ''}<style>
${OFFICE_CSS}
${OFFICE_CSS_ADDITIONS}
</style>
</head>
<body class="office-site${c.body_class}">
  <header class="site-header">
    <div class="wrap">
      <p class="eyebrow" dir="${c.dir_chrome}">${isAdmin ? c.eyebrow_admin : c.eyebrow_public}</p>
      <h1 dir="${c.dir_chrome}">${c.h1}</h1>
      <p class="lede" dir="${c.dir_chrome}">${c.lede}</p>
      ${ownerLink}
    </div>
  </header>

  <nav class="tabs" role="tablist" aria-label="${c.nav_aria}">
    <div class="wrap">
${tabButtons}
    </div>
  </nav>

  <main>
    <div class="wrap"><div id="load-status"></div></div>
${pendingPanel}
      <section class="tab-panel" data-tab="office" hidden>
        <div class="wrap">
          <h2 dir="${c.dir_chrome}">${c.tab_office}</h2>
          <div id="office-body"></div>
        </div>
      </section>

      <section class="tab-panel agents" data-tab="agents" hidden>
        <div class="wrap">
          <h2 dir="${c.dir_chrome}">${c.tab_agents}</h2>
          <p class="section-note" id="agent-count-note">—</p>
          <div id="agent-grid" class="agent-grid" role="list"></div>
        </div>
      </section>
${specPanel}
${officeDataPanel}
      <section class="tab-panel data-gaps" data-tab="gaps" hidden>
        <div class="wrap">
          <h2 dir="${c.dir_chrome}">${c.tab_gaps}</h2>
          <p class="section-note" dir="${c.dir_chrome}">${c.gaps_note}</p>
          <ul id="gaps-list" class="gaps-list"></ul>
          <div id="gaps-errors"></div>
        </div>
      </section>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <p dir="${c.dir_chrome}">
        ${c.footer_a} <code id="data-source" dir="ltr">—</code> ${c.footer_b}
        <span id="generated-at" dir="ltr">—</span>.
      </p>
    </div>
  </footer>

<script>
${clientScript(mode, signedInViaAccess)}
</` + `script>
</body>
</html>`;
}
