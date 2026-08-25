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
/* ---- tab bar (new: the static build was one long scroll) ---- */
.tabs { border-bottom: 1px solid var(--rule, #d8d3c8); margin-bottom: 2rem; }
.tabs .wrap { display: flex; flex-wrap: wrap; gap: .25rem; }
.tab-btn {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: .85rem 1rem; font: inherit; font-size: .95rem; color: var(--ink-soft, #5c574d);
  cursor: pointer; border-radius: 4px 4px 0 0;
}
.tab-btn:hover { color: var(--ink, #23201a); background: rgba(0,0,0,.03); }
.tab-btn[aria-selected="true"] { color: var(--ink, #23201a); border-bottom-color: var(--accent, #7a5c2e); font-weight: 600; }
.tab-btn:focus-visible { outline: 2px solid var(--accent, #7a5c2e); outline-offset: 2px; }
.tab-btn .tab-count { font-size: .8em; opacity: .7; margin-left: .35rem; }
.tab-panel[hidden] { display: none; }

/* ---- stat tiles for the live counts ---- */
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.stat { border: 1px solid var(--rule, #d8d3c8); border-radius: 6px; padding: 1rem 1.1rem; background: var(--card, #fff); }
.stat-value { font-size: 1.7rem; font-weight: 600; line-height: 1.1; color: var(--ink, #23201a); }
.stat-label { font-size: .8rem; color: var(--ink-soft, #5c574d); margin-top: .3rem; }

/* ---- the office blurb + mechanisms ---- */
.office-text { font-size: 1.02rem; line-height: 1.7; max-width: 62ch; }
.mech-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.1rem; margin-top: 1.5rem; }
.mech { border: 1px solid var(--rule, #d8d3c8); border-radius: 6px; padding: 1.1rem; background: var(--card, #fff); }
.mech h3 { margin: 0 0 .5rem; font-size: 1rem; }
.mech p { margin: 0; font-size: .9rem; line-height: 1.6; color: var(--ink-soft, #5c574d); }

/* ---- loading / error / lock states ---- */
.state-note { padding: 1.5rem 0; color: var(--ink-soft, #5c574d); font-size: .95rem; }
.state-note--error { color: #a3341f; }
.token-prompt { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .75rem; }
.token-prompt input { flex: 1 1 240px; padding: .55rem .7rem; border: 1px solid var(--rule, #d8d3c8); border-radius: 4px; font: inherit; }
.spec-frame { width: 100%; height: 78vh; border: 1px solid var(--rule, #d8d3c8); border-radius: 6px; background: #fff; }
.freshness { font-size: .8rem; color: var(--ink-soft, #5c574d); margin-top: 2rem; }
`;

/** The client script. Adapted from the office's `app.js`: the element
 *  builder, the agent card, the detail toggle and the pending-item grouping
 *  are its logic; what changed is where the data comes from and that there
 *  are tabs. No backticks and no `${` in here — this string is embedded in a
 *  template literal. */
function clientScript(mode) {
  const isAdmin = mode === 'admin';
  return [
    '(function () {',
    '  "use strict";',
    '  var MODE = ' + JSON.stringify(mode) + ';',
    '  var ENDPOINT = ' + JSON.stringify(isAdmin ? '/api/admin' : '/api/public') + ';',
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
    '      ["agents", "agents"],',
    '      ["questions_handled", "questions handled"],',
    '      ["reports_written", "reports written"],',
    '      ["meetings_held", "meetings held"],',
    '      ["interactions_logged", "interactions logged"],',
    '      ["simulated_day", "simulated day"]',
    '    ];',
    '    var row = el("div", { class: "stat-row" });',
    '    tiles.forEach(function (t) {',
    '      if (counts[t[0]] === undefined || counts[t[0]] === null) return;',
    '      row.appendChild(el("div", { class: "stat" }, [',
    '        el("div", { class: "stat-value", text: String(counts[t[0]]) }),',
    '        el("div", { class: "stat-label", text: t[1] })',
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
    '        el("span", { class: "agent-detail-technical-label", text: "Technical: " }),',
    '        el("span", { text: detail.technical_line })',
    '      ]));',
    '    } else if (agent.character) {',
    '      children.push(el("p", { class: "agent-detail-section-text", text: agent.character }));',
    '    } else {',
    '      children.push(el("p", { class: "agent-detail-missing", text: "No character text published for this agent." }));',
    '    }',
    '    if (agent.purpose) children.push(el("p", { class: "agent-detail-purpose" }, [',
    '      el("span", { class: "agent-detail-technical-label", text: "Purpose: " }),',
    '      el("span", { text: agent.purpose })',
    '    ]));',
    '    if (agent.produced && agent.produced.length) {',
    '      children.push(el("div", { class: "agent-produced" }, [',
    '        el("p", { class: "agent-produced-label", text: "Produced" }),',
    '        el("ul", {}, agent.produced.map(function (p) { return el("li", { text: p }); }))',
    '      ]));',
    '    }',
    '    return el("div", { class: "agent-detail" }, children);',
    '  }',
    '',
    '  function renderAgentCard(agent) {',
    '    var badges = [];',
    '    if (agent.live === true) badges.push(el("span", { class: "status status--live", text: "live in roster" }));',
    '    else if (agent.live === false) badges.push(el("span", { class: "status status--bible-only", text: "bible-only, not in live roster" }));',
    '    else if (agent.status) badges.push(el("span", { class: "status status--live", text: agent.status }));',
    '    if (agent.tier) badges.push(el("span", { class: "status status--persona", text: agent.tier }));',
    '    if (agent.has_persona) badges.push(el("span", { class: "status status--persona", text: "has PERSONA.md" }));',
    '',
    '    var isOpen = openAgentId === agent.id;',
    '    var toggle = el("button", { type: "button", class: "agent-detail-toggle" });',
    '    toggle.textContent = isOpen ? "Hide detail" : "View detail";',
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
    '        : el("p", { class: "agent-role agent-role--missing", text: "not in the live roster" }),',
    '      agent.purpose',
    '        ? el("p", { class: "agent-purpose", text: agent.purpose })',
    '        : el("p", { class: "agent-purpose agent-purpose--missing", text: "purpose not yet wired into the live config" }),',
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
    '    if (note) note.textContent = live + " of " + (data.agents || []).length',
    '      + " are in the live daily roster. \\"View detail\\" opens the office\'s own published character text.";',
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
    '    lines.forEach(function (g) { host.appendChild(el("li", { text: g })); });',
    '    var errs = data.errors || [];',
    '    var errHost = byId("gaps-errors");',
    '    if (errHost) {',
    '      clear(errHost);',
    '      if (errs.length) {',
    '        errHost.appendChild(el("h3", { text: "Errors the office hit while reading its own material, this request" }));',
    '        errHost.appendChild(el("ul", {}, errs.map(function (e) { return el("li", { text: e }); })));',
    '      }',
    '    }',
    '  }',
    '',
  ].concat(isAdmin ? [
    '  /* ---------- waiting on you (admin only) ---------- */',
    '  function renderPending() {',
    '    var host = byId("pending-groups");',
    '    if (!host) return;',
    '    clear(host);',
    '    var items = data.pending_items || [];',
    '    if (!items.length) {',
    '      host.appendChild(el("p", { class: "section-note", text: "Nothing open right now." }));',
    '      return;',
    '    }',
    '    var groups = {}, order = [];',
    '    items.forEach(function (i) {',
    '      if (!groups[i.kind]) { groups[i.kind] = []; order.push(i.kind); }',
    '      groups[i.kind].push(i);',
    '    });',
    '    var labels = {',
    '      decision: "Open decisions", authorization: "Pending authorizations",',
    '      blocked: "Blocked", question: "Questions for you", submission: "Awaiting your review"',
    '    };',
    '    order.forEach(function (kind) {',
    '      var kids = [el("h3", { class: "pending-group-title", text: (labels[kind] || kind) + " (" + groups[kind].length + ")" })];',
    '      groups[kind].forEach(function (item) {',
    '        var card = [',
    '          el("p", { class: "pending-source", text: item.source }),',
    '          el("h4", { class: "pending-title", text: item.title }),',
    '          item.detail ? el("p", { class: "pending-detail", text: item.detail }) : null',
    '        ];',
    '        if (item.status_note) card.push(el("p", { class: "pending-status-note", text: item.status_note }));',
    '        var respond = el("button", { type: "button", class: "respond-btn" });',
    '        respond.textContent = "Write a spec about this";',
    '        respond.addEventListener("click", function () { openSpecFor(item); });',
    '        card.push(respond);',
    '        kids.push(el("article", { class: "pending-item" }, card));',
    '      });',
    '      host.appendChild(el("div", { class: "pending-group" }, kids));',
    '    });',
    '    var tabCount = byId("pending-tab-count");',
    '    if (tabCount) tabCount.textContent = "(" + items.length + ")";',
    '  }',
    '',
    '  /* The office\'s Respond button used to seed a localStorage note. It now',
    '     opens the real spec builder with the item\'s title carried across. */',
    '  function openSpecFor(item) {',
    '    var frame = byId("spec-frame");',
    '    var btn = document.querySelector(\'.tab-btn[data-tab="spec"]\');',
    '    if (btn) btn.click();',
    '    if (frame) frame.src = "/admin/spec#" + encodeURIComponent(item.title);',
    '  }',
    '',
    '  extraRender = renderPending;',
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
    '      text: "The office accepted this page but not this tab: the admin token is not in this tab\'s session storage." }));',
    '    var input = el("input", { type: "password", placeholder: "X-Admin-Token", autocomplete: "off" });',
    '    var go = el("button", { type: "button", class: "message-send-btn" });',
    '    go.textContent = "Use token";',
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
    '    status.appendChild(el("p", { class: "state-note", text: "Reading the office\'s live data…" }));',
    '',
    '    fetch(ENDPOINT, { headers: MODE === "admin" ? adminHeaders() : {}, cache: "no-store" })',
    '      .then(function (res) {',
    '        if (res.status === 401 || res.status === 403) { showTokenPrompt(status); return null; }',
    '        if (!res.ok) throw new Error("the office answered HTTP " + res.status);',
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
    '        if (stamp) stamp.textContent = data.generated_at || "unknown";',
    '        var src = byId("data-source");',
    '        if (src) src.textContent = ENDPOINT;',
    '      })',
    '      .catch(function (err) {',
    '        clear(status);',
    '        status.hidden = false;',
    '        status.appendChild(el("p", { class: "state-note state-note--error",',
    '          text: "Could not read the office\'s live data: " + err.message }));',
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
  ]).join('\n');
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
  const shared = [
    'The counts are live D1 totals since the simulation began on 2026-06-17, but the office writes them on a 30-minute cron — a number here can be up to half an hour behind the office itself.',
    'Nothing here says whether an agent\'s answer was any GOOD. The office scores its own work internally and that score is not on this page; a high count of reports written is a count, not a quality claim.',
    'Each agent\'s journal exists and is never surfaced anywhere on this page. That is a standing rule of the office, not a gap waiting to be filled.',
    'This page renders what the endpoint returns and nothing else. It holds no data of its own, caches nothing, and has no copy to fall back on — if the office is down, this page says so rather than showing you a stale answer as though it were current.',
  ];
  if (mode === 'admin') {
    return shared.concat([
      'The pending list is read FRESH from the office\'s own material on every request, not from the 30-minute snapshot cache — so it can disagree with the counts above by design, and the pending side is the newer of the two.',
      'An item appearing here means the office believes it is waiting on you. It is not proof the office has nothing else waiting: anything the office has not yet written down in the board, the plan or the channel cannot appear.',
    ]);
  }
  return shared.concat([
    'The office\'s internal working material — its task board, meeting transcripts and correspondence with its owner — is not served to this page and is not reachable from the endpoint it reads. That is a property of the endpoint, not a filter applied here.',
  ]);
}

/**
 * The page.
 *
 * `mode`: 'public' (served at `/`) or 'admin' (served at `/admin`, behind the
 * gate). The admin render is the only one that contains the pending list, the
 * spec builder frame, or the string `/api/admin`.
 */
export function renderOfficeSite({ mode = 'public' } = {}) {
  const isAdmin = mode === 'admin';

  const tabs = [];
  if (isAdmin) {
    tabs.push({ id: 'pending', label: 'Waiting on you', count: true });
  }
  tabs.push({ id: 'office', label: 'The office' });
  tabs.push({ id: 'agents', label: 'The thirteen' });
  if (isAdmin) tabs.push({ id: 'spec', label: 'Write a spec' });
  tabs.push({ id: 'gaps', label: 'What this page cannot show you' });

  const tabButtons = tabs.map((t) =>
    '        <button class="tab-btn" type="button" role="tab" data-tab="' + t.id + '" aria-selected="false">'
    + t.label
    + (t.count ? ' <span class="tab-count" id="pending-tab-count"></span>' : '')
    + '</button>').join('\n');

  const pendingPanel = !isAdmin ? '' : `
      <section class="tab-panel pending" data-tab="pending" hidden>
        <div class="wrap">
          <h2>Waiting on you</h2>
          <p class="section-note">
            Open decisions, blocked board items, and questions the office has
            written down and cannot answer itself — read from the office's own
            board, plan and channel at the moment you loaded this page.
          </p>
          <div id="pending-groups" class="pending-groups"></div>
        </div>
      </section>`;

  const specPanel = !isAdmin ? '' : `
      <section class="tab-panel" data-tab="spec" hidden>
        <div class="wrap">
          <h2>Write a spec</h2>
          <p class="section-note">
            The real builder, framed from <code>/admin/spec</code> rather than
            rebuilt here — one implementation of the spec format. What you send
            is written to <code>channel/from-owner/</code> in back-office and is
            refused before anything is written if the office's own parser will
            not accept it.
          </p>
          <iframe id="spec-frame" class="spec-frame" src="/admin/spec" title="Spec builder"></iframe>
        </div>
      </section>`;

  const ownerLink = isAdmin
    ? '<p class="section-note"><a href="/admin/owner">The owner page</a> · <a href="/">the public view</a></p>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Office${isAdmin ? ' — owner' : ''}</title>
<meta name="description" content="Thirteen AI agents that run as an office — and review each other.">
${isAdmin ? '<meta name="robots" content="noindex, nofollow">\n' : ''}<style>
${OFFICE_CSS}
${OFFICE_CSS_ADDITIONS}
</style>
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <p class="eyebrow">${isAdmin ? 'owner view · live · behind the admin gate' : 'live · served by the office\'s own Worker'}</p>
      <h1>The Office</h1>
      <p class="lede">Thirteen AI agents that run as an office — and review each other.</p>
      ${ownerLink}
    </div>
  </header>

  <nav class="tabs" role="tablist" aria-label="Sections">
    <div class="wrap">
${tabButtons}
    </div>
  </nav>

  <main>
    <div class="wrap"><div id="load-status"></div></div>
${pendingPanel}
      <section class="tab-panel" data-tab="office" hidden>
        <div class="wrap">
          <h2>The office</h2>
          <div id="office-body"></div>
        </div>
      </section>

      <section class="tab-panel agents" data-tab="agents" hidden>
        <div class="wrap">
          <h2>The thirteen</h2>
          <p class="section-note" id="agent-count-note">—</p>
          <div id="agent-grid" class="agent-grid" role="list"></div>
        </div>
      </section>
${specPanel}
      <section class="tab-panel data-gaps" data-tab="gaps" hidden>
        <div class="wrap">
          <h2>What this page cannot show you</h2>
          <p class="section-note">
            The office built this section when the page was static and could not
            call a server. It can now. What follows is what is still missing and
            what the live wiring newly limits — kept for the same reason it was
            written: a page that hides its own gaps is harder to trust than one
            that names them.
          </p>
          <ul id="gaps-list" class="gaps-list"></ul>
          <div id="gaps-errors"></div>
        </div>
      </section>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <p>
        Served by the office's own Worker and read live from
        <code id="data-source">—</code> each time you load it. Nothing on this
        page is a stored copy. Office data generated at
        <span id="generated-at">—</span>.
      </p>
    </div>
  </footer>

<script>
${clientScript(mode)}
</` + `script>
</body>
</html>`;
}
