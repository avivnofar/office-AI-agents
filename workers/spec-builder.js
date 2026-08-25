/**
 * workers/spec-builder.js — A FORM THAT TURNS A REQUEST INTO A BUILDABLE SPEC.
 *
 * Written 2026-08-24 (Session 16, Item C). Pure: **this module imports
 * nothing**, the rule `owner-channel.js`, `owner-page.js`, `site-data.js`,
 * `office-policy.js` and `deliverable-lifecycle.js` all keep, so plain `node`
 * can load it and `scripts/verify-spec-builder.js` exercises the real
 * generator rather than a hand-mirror of it.
 *
 * ── NO MODEL IS INVOLVED, AND THAT IS A REQUIREMENT ──────────────────────
 *
 * Not a simplification, not a cost decision, not "for now". **The generator is
 * a template fill and the same answers must always produce the same bytes.**
 *
 * The reason is specific rather than ideological. A model asked to "improve"
 * the owner's wording produces a *convincing wrong spec*, and a convincing
 * wrong spec is worse than an empty form: an empty form is obviously not
 * finished, whereas a fluent paraphrase of something the owner did not mean
 * gets built. This estate's whole documented failure history is one shape —
 * *a claim that reads exactly like evidence* — and putting a paraphraser
 * between the client and the office would install that shape at the point
 * where intent enters the system.
 *
 * So: no `fetch`, no provider client, no `env`, no clock. `buildSpec()` is a
 * function of its arguments, `scripts/verify-spec-builder.js` asserts the
 * module's source contains no network or model call, and it asserts byte
 * equality across repeated builds.
 *
 * ── WHERE THE SEVEN FIELDS COME FROM ─────────────────────────────────────
 *
 * They are not invented. They are the structure of the two specs written in
 * the week of 2026-08-17 that both came back as working builds in a SINGLE
 * round, autonomously, with reasoned decisions and no clarifying questions —
 * the contract-analysis engine and the local web UI over it.
 *
 * Two of the seven are load-bearing in a way the other five are not, and both
 * are the fields a person writing a spec by hand leaves out:
 *
 *   WHAT IS OUT OF SCOPE  is the field that stopped a build from adding an
 *                         interface when an engine was what was asked for.
 *                         Without it a builder resolves ambiguity by adding.
 *
 *   OPEN DECISIONS        is the field that made both builds AUTONOMOUS. It
 *                         is rendered with a fixed instruction — *decide it,
 *                         implement it, record the decision and the
 *                         reasoning. Do not ask.* — which converts every
 *                         unknown from a reason to stop into a thing to
 *                         resolve and write down. The instruction is a
 *                         constant here, not a field, precisely so it cannot
 *                         be softened per-spec.
 *
 * ── THE CONDITIONAL QUESTIONS ARE A CONVENIENCE, NOT THE PRODUCT ─────────
 *
 * Four task types, one or two extra questions each. They are deliberately
 * small: their answers are appended to the spec as context, they never change
 * the seven required fields, and a spec is valid with all of them blank. If
 * this branching ever grows into a decision tree it has stopped being a form
 * and started being a wizard, and a wizard is a place people abandon.
 */

/* ────────────────────────────── The vocabulary ──────────────────────────── */

/**
 * THE FIXED INSTRUCTION. A constant, rendered verbatim under Open decisions on
 * every spec this form produces.
 *
 * It is not editable from the page, and that is the point: it is the single
 * sentence that made two builds finish in one round instead of coming back
 * with questions, and a field the owner could soften in a hurry is a field
 * that gets softened in a hurry.
 */
export const OPEN_DECISIONS_INSTRUCTION =
  'decide it, implement it, record the decision and the reasoning. Do not ask.';

/** The four task types the conditional questions branch on. */
export const TASK_TYPES = Object.freeze(['tool', 'interface', 'fix', 'integration']);

/**
 * The seven fields, in the order they render.
 *
 * `required` is honest rather than decorative — `buildSpec()` refuses a
 * missing one by name. A spec produced with a blank "out of scope" would be
 * the exact spec that came back with an interface nobody asked for.
 */
export const SPEC_FIELDS = Object.freeze([
  Object.freeze({
    key: 'what', heading: 'What to build', required: true,
    hint: 'One paragraph. What the thing is, in plain words.',
    placeholder: 'A command-line tool that reads a CSV of invoices and reports which ones are missing a due date.',
  }),
  Object.freeze({
    key: 'out_of_scope', heading: 'What is out of scope', required: true,
    hint: 'Explicit. This is the field that stops a build from adding an interface when an engine was asked for — without it, an ambiguity gets resolved by adding.',
    placeholder: 'No web interface. No database. No scheduling — it runs when I run it.',
  }),
  Object.freeze({
    key: 'where', heading: 'Where it lives', required: true,
    hint: 'The exact repo path. Not "somewhere in the warehouse".',
    placeholder: 'warehouse-office-AI-agents/tasks/invoice-checker/',
  }),
  Object.freeze({
    key: 'io', heading: 'Input and output', required: true,
    hint: 'The shape, not a description of the shape. Show a line of input and a line of output if you can.',
    placeholder: 'In: a path to a .csv with columns id,vendor,amount,due_date.\nOut: a markdown table of the rows with an empty or unparseable due_date, printed to stdout.',
  }),
  Object.freeze({
    key: 'constraints', heading: 'Constraints', required: true,
    hint: 'No new dependencies, no keys in the repo, must run offline — whatever is actually true.',
    placeholder: 'No new dependencies — standard library only. No keys, no network. Must run on Windows.',
  }),
  Object.freeze({
    key: 'done', heading: 'What "done" looks like', required: true,
    hint: 'One sentence, and it has to be testable. "Works well" is not testable.',
    placeholder: 'Running it against samples/invoices.csv prints exactly the three rows with missing due dates and exits 0.',
  }),
  Object.freeze({
    key: 'open_decisions', heading: 'Open decisions', required: false,
    hint: 'Anything you have not decided. Leave it blank if there is nothing — the instruction below still renders, because "there were none" is worth recording.',
    placeholder: 'Whether to fail on a malformed row or skip it with a warning.',
  }),
]);

/**
 * One or two extra questions per task type. Optional, appended as context,
 * never a substitute for the seven above.
 *
 * The `fix` and `interface` pairs are the two that earn their place:
 *   a FIX without "how would you know it stopped" is a bug report, not a task
 *   an INTERFACE without "what do they see first" gets built inside-out
 */
export const CONDITIONAL_QUESTIONS = Object.freeze({
  tool: Object.freeze([
    Object.freeze({ key: 'invoked', heading: 'How it is invoked', placeholder: 'node check-invoices.js path/to/file.csv' }),
  ]),
  interface: Object.freeze([
    Object.freeze({ key: 'user', heading: 'Who the user is', placeholder: 'Me, on my phone, once a day.' }),
    Object.freeze({ key: 'first_screen', heading: 'What they see first', placeholder: 'A single list of what is waiting on me, newest first. Nothing else above it.' }),
  ]),
  fix: Object.freeze([
    Object.freeze({ key: 'symptom', heading: 'The symptom', placeholder: 'The daily email arrives with an empty body about twice a week.' }),
    Object.freeze({ key: 'how_known', heading: 'How you would know it stopped', placeholder: 'Fourteen consecutive days of emails with a non-empty body.' }),
  ]),
  integration: Object.freeze([
    Object.freeze({ key: 'sides', heading: 'The two sides', placeholder: 'The office Worker writes; the back-office repo receives.' }),
    Object.freeze({ key: 'must_not_change', heading: 'What must not change on either side', placeholder: 'The existing filename convention. Nothing in the public repo.' }),
  ]),
});

/* ───────────────────────────── The generator ────────────────────────────── */

/** Collapses runs of whitespace at line ends and normalises newlines, so the
 *  same answers typed on Windows and on a phone produce the same bytes. */
function tidy(v) {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** One line of `Field: value` from the header block, or null. */
function headerLine(label, value) {
  const v = tidy(value);
  return v ? `**${label}:** ${v}` : null;
}

/**
 * THE TEMPLATE FILL. Deterministic: no clock, no randomness, no model.
 *
 * `date` is a parameter rather than a `new Date()` for the same reason
 * `buildOwnerMessage()` takes one — a module that reads the clock cannot be
 * pinned by a verifier, and "the same answers produce the same spec" then
 * becomes a claim nobody can check.
 *
 * @param {object} answers
 * @param {string} answers.title      one line; becomes the `# ` heading
 * @param {string} answers.task_type  one of TASK_TYPES
 * @param {string} answers.date       `YYYY-MM-DD`
 * @param {string} answers.what … answers.open_decisions  the seven fields
 * @returns {{ok: true, markdown: string, title: string}
 *          | {ok: false, reason: string}}
 */
export function buildSpec(answers = {}) {
  const title = tidy(answers.title).replace(/\s+/g, ' ');
  if (!title) {
    return { ok: false, reason: 'a title is required — it becomes the spec\'s heading and the office\'s name for the task in every prompt it appears in' };
  }
  if (/[\r\n]/.test(String(answers.title || ''))) {
    return { ok: false, reason: 'the title must be a single line' };
  }

  const taskType = tidy(answers.task_type).toLowerCase();
  if (!TASK_TYPES.includes(taskType)) {
    return { ok: false, reason: `task type must be one of ${TASK_TYPES.join(' | ')} — it decides which extra questions are asked, and guessing it would put the wrong ones in the spec` };
  }

  const date = tidy(answers.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: 'date must be YYYY-MM-DD' };
  }

  // REFUSE BY NAME. A generic "some fields are missing" would make the owner
  // hunt; naming the field is the only reason to validate here at all, since
  // the office's own parser validates the message separately downstream.
  for (const f of SPEC_FIELDS) {
    if (f.required && !tidy(answers[f.key])) {
      return { ok: false, reason: `"${f.heading}" is empty, and it is required. ${f.hint}` };
    }
  }

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  const header = [
    headerLine('Assigned by', 'the owner'),
    headerLine('Date', date),
    headerLine('Task type', taskType),
  ].filter(Boolean);
  lines.push(header.join('  \n'));
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const f of SPEC_FIELDS) {
    const value = tidy(answers[f.key]);

    if (f.key === 'open_decisions') {
      /*
       * THE FIELD THAT MADE BOTH BUILDS AUTONOMOUS, and the instruction is
       * rendered whether or not anything was written under it.
       *
       * An EMPTY open-decisions section is not the same as an ABSENT one.
       * "There were none" is a fact the office should be able to read; a
       * missing heading reads as "nobody thought about it", and the office
       * would then be right to ask.
       */
      lines.push(`## ${f.heading}`);
      lines.push('');
      lines.push(`> **${OPEN_DECISIONS_INSTRUCTION}**`);
      lines.push('');
      lines.push(value || '_None stated. If you hit one anyway, the instruction above applies to it._');
      lines.push('');
      continue;
    }

    lines.push(`## ${f.heading}`);
    lines.push('');
    lines.push(value);
    lines.push('');
  }

  const extras = CONDITIONAL_QUESTIONS[taskType] || [];
  const answered = extras.filter((q) => tidy(answers[q.key]));
  if (answered.length) {
    lines.push(`## Additional context (${taskType})`);
    lines.push('');
    for (const q of answered) {
      lines.push(`**${q.heading}:** ${tidy(answers[q.key])}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('*Written with the office\'s spec builder. No model was involved in producing this text — it is a template fill, so the same answers always produce the same spec.*');
  lines.push('');

  const markdown = lines.join('\n');

  /*
   * ── TWO RENDERINGS OF ONE SPEC, AND WHY THE SECOND EXISTS ─────────────
   *
   * `markdown` is the file: it opens with `# <title>` and is what the
   * download button and the copy box hand over.
   *
   * `channelBody` is the same spec MINUS that first heading line, and it is
   * what the Send button posts. `buildOwnerMessage()` in owner-page.js writes
   * its own `# <subject>` heading above the body it is given — that heading is
   * where `parseOwnerMessage()` takes the message title from — so posting the
   * full markdown would produce a file with two H1s, one of them redundant,
   * and the office would read the wrapper's.
   *
   * Deriving it here rather than at the caller keeps one place that knows the
   * spec's shape. A caller that stripped the heading itself would be a second
   * implementation of this format, which is the drift this estate keeps
   * finding.
   */
  const channelBody = markdown.replace(/^#\s+.*\n+/, '');

  return { ok: true, markdown, channelBody, title };
}

/** A filename for the download button. Mirrors the owner-channel slug rules so
 *  a downloaded spec and a sent one carry the same name. */
export function specFilename({ title, date }) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  return `${date}-${slug}.md`;
}

/* ─────────────────────────────── The page ───────────────────────────────── */

/** HTML-escapes a value destined for an attribute or a text node. The page is
 *  assembled as a string, so this is the only thing between a quote character
 *  in a placeholder and a broken document. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The spec builder page, as one self-contained HTML string.
 *
 * ── WHAT IS AND IS NOT PROTECTED HERE, STATED PLAINLY ────────────────────
 *
 * The page holds NO SECRET and reads NO OFFICE DATA. It is an empty form; the
 * generator runs entirely in the browser; the markdown never leaves the tab
 * unless the owner presses Send.
 *
 * SEND is the only privileged act, and it is authenticated — it POSTs to
 * `/api/agents/owner-message`, which the router's `AUTHENTICATED_PREFIXES`
 * gate refuses without `X-Admin-Token`. The token is typed in by hand, lives
 * in that tab's `sessionStorage` only, and travels in a header rather than a
 * URL so it never reaches a referrer or a log.
 *
 * That split is why serving this page unauthenticated is safe even though
 * Cloudflare Access is not yet enabled on this account: an unauthenticated
 * visitor to `/admin/spec` gets a blank form and can do nothing with it.
 */
export function renderSpecPage({ endpointBase = '' } = {}) {
  const typeOptions = TASK_TYPES
    .map((t) => `<option value="${esc(t)}"${t === 'tool' ? ' selected' : ''}>${esc(t)}</option>`)
    .join('');

  const fieldBlocks = SPEC_FIELDS.map((f) => `
    <div class="field">
      <label for="f-${esc(f.key)}">${esc(f.heading)}${f.required ? ' <span class="req">required</span>' : ' <span class="opt">optional</span>'}</label>
      <p class="hint">${esc(f.hint)}</p>
      <textarea id="f-${esc(f.key)}" data-key="${esc(f.key)}" rows="${f.key === 'where' ? 2 : 4}" placeholder="${esc(f.placeholder)}"></textarea>
    </div>`).join('');

  const conditionalBlocks = TASK_TYPES.map((t) => `
    <div class="cond hide" data-type="${esc(t)}">
      <h3>A couple more, because this is a <em>${esc(t)}</em></h3>
      ${(CONDITIONAL_QUESTIONS[t] || []).map((q) => `
      <div class="field">
        <label for="c-${esc(q.key)}">${esc(q.heading)} <span class="opt">optional</span></label>
        <textarea id="c-${esc(q.key)}" data-key="${esc(q.key)}" rows="2" placeholder="${esc(q.placeholder)}"></textarea>
      </div>`).join('')}
    </div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Office — spec builder</title>
<style>
:root{--ink:#1b2432;--ink-2:#4a5568;--line:#dfe3ea;--bg:#fbfaf7;--card:#fff;--accent:#24406b;--warn:#8a3b12;--ok:#1f6b45}
@media (prefers-color-scheme:dark){:root{--ink:#e8ecf2;--ink-2:#a3adbd;--line:#2c3444;--bg:#151a22;--card:#1d2430;--accent:#8fb3e6;--warn:#e0a273;--ok:#77c79c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px 18px 72px}
header{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:20px}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.08rem;margin:26px 0 10px}
h3{font-size:.95rem;margin:18px 0 6px;color:var(--ink-2);font-weight:600}
.sub{color:var(--ink-2);font-size:.92rem;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.field{margin-bottom:16px}
label{display:block;font-size:.82rem;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);margin:0 0 2px}
.req{color:var(--warn);text-transform:none;letter-spacing:0;font-size:.9em}
.opt{color:var(--ink-2);text-transform:none;letter-spacing:0;font-size:.9em;opacity:.8}
.hint{margin:0 0 6px;font-size:.85rem;color:var(--ink-2)}
input,textarea,select{width:100%;padding:10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:inherit}
textarea{resize:vertical}
button{margin-top:4px;padding:11px 18px;border:0;border-radius:7px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line);font-weight:400}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
#out{width:100%;min-height:340px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;overflow:auto}
.note{font-size:.86rem;color:var(--ink-2);border-left:3px solid var(--line);padding-left:12px;margin:12px 0}
.note.warn{border-left-color:var(--warn);color:var(--warn)}
#status{margin-top:10px;font-size:.9rem;min-height:1.4em}
.hide{display:none}
code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:.86em}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Spec builder</h1>
  <p class="sub">Seven fields. No model touches your words — the same answers always produce the same spec.</p>
</header>

<div class="card">
  <div class="field">
    <label for="f-title">Title <span class="req">required</span></label>
    <p class="hint">One line. It becomes the heading and the office's name for this task.</p>
    <input id="f-title" data-key="title" placeholder="Build an invoice due-date checker">
  </div>
  <div class="field">
    <label for="f-type">Task type <span class="req">required</span></label>
    <p class="hint">Changes only which extra questions get asked. It does not change the seven fields.</p>
    <select id="f-type">${typeOptions}</select>
  </div>
</div>

<div class="card">
  <h2>The seven fields</h2>
  ${fieldBlocks}
  ${conditionalBlocks}
  <div class="row">
    <button id="gen" type="button">Generate the spec</button>
    <button id="clear" class="ghost" type="button">Clear the form</button>
  </div>
  <div id="genstatus" class="note hide"></div>
</div>

<div class="card" id="outcard">
  <h2>The spec</h2>
  <p class="hint">This is the file. Copy it, download it, or send it straight to the office.</p>
  <textarea id="out" spellcheck="false" readonly placeholder="Fill the fields above and press Generate."></textarea>
  <div class="row" style="margin-top:12px">
    <button id="dl" class="ghost" type="button" disabled>Download .md</button>
    <button id="copy" class="ghost" type="button" disabled>Copy</button>
  </div>
</div>

<div class="card">
  <h2>Send it to the office</h2>
  <p class="hint">This writes the spec into <code>channel/from-owner/</code> in the back-office repo, in the format the office's own parser accepts. Your admin token stays in this tab and is sent as a header.</p>
  <div class="field">
    <label for="tok">Admin token</label>
    <input id="tok" type="password" autocomplete="off" placeholder="pasted once, kept in this tab only">
  </div>
  <div class="row">
    <button id="send" type="button" disabled>Send to the office</button>
  </div>
  <div id="status"></div>
  <div class="note">
    <strong>What happens after it lands, honestly.</strong> The file is written to the repo and reaches every agent's
    prompt on the office's next context refresh — that path is verified and works. Whether anything then <em>picks the
    work up</em> is a separate and currently unresolved question: the office's dispatcher has no scheduled caller.
    Sending this puts the spec in front of the office. It does not start a build.
  </div>
</div>

</div>
<script>
(function () {
  var BASE = ${JSON.stringify(endpointBase)};
  var TYPES = ${JSON.stringify(TASK_TYPES)};
  var out = document.getElementById('out');
  var genstatus = document.getElementById('genstatus');
  var status = document.getElementById('status');
  var tok = document.getElementById('tok');
  var current = null;

  try { var saved = sessionStorage.getItem('office-admin-token'); if (saved) tok.value = saved; } catch (e) {}
  tok.addEventListener('input', function () {
    try { sessionStorage.setItem('office-admin-token', tok.value); } catch (e) {}
  });

  function showConditionals() {
    var t = document.getElementById('f-type').value;
    TYPES.forEach(function (name) {
      var el = document.querySelector('.cond[data-type="' + name + '"]');
      if (el) el.classList.toggle('hide', name !== t);
    });
  }
  document.getElementById('f-type').addEventListener('change', showConditionals);
  showConditionals();

  function collect() {
    var a = {};
    document.querySelectorAll('[data-key]').forEach(function (el) {
      if (el.closest('.cond') && el.closest('.cond').classList.contains('hide')) return;
      a[el.getAttribute('data-key')] = el.value;
    });
    a.task_type = document.getElementById('f-type').value;
    a.date = new Date().toISOString().slice(0, 10);
    return a;
  }

  document.getElementById('gen').addEventListener('click', function () {
    genstatus.classList.remove('hide');
    genstatus.classList.remove('warn');
    var body = collect();
    fetch(BASE + '/api/spec/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) {
        genstatus.classList.add('warn');
        genstatus.textContent = j.reason || 'the form could not be turned into a spec';
        out.value = '';
        current = null;
        document.getElementById('dl').disabled = true;
        document.getElementById('copy').disabled = true;
        document.getElementById('send').disabled = true;
        return;
      }
      current = j;
      out.value = j.markdown;
      genstatus.textContent = 'Generated. ' + j.markdown.length + ' characters. No model was called.';
      document.getElementById('dl').disabled = false;
      document.getElementById('copy').disabled = false;
      document.getElementById('send').disabled = false;
    }).catch(function (e) {
      genstatus.classList.add('warn');
      genstatus.textContent = 'could not reach the office: ' + e.message;
    });
  });

  document.getElementById('clear').addEventListener('click', function () {
    document.querySelectorAll('[data-key]').forEach(function (el) { el.value = ''; });
    out.value = ''; current = null;
    genstatus.classList.add('hide');
    document.getElementById('dl').disabled = true;
    document.getElementById('copy').disabled = true;
    document.getElementById('send').disabled = true;
  });

  document.getElementById('dl').addEventListener('click', function () {
    if (!current) return;
    var blob = new Blob([current.markdown], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = current.filename || 'spec.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  document.getElementById('copy').addEventListener('click', function () {
    out.removeAttribute('readonly'); out.select();
    try { document.execCommand('copy'); } catch (e) {}
    out.setAttribute('readonly', 'readonly');
    window.getSelection().removeAllRanges();
    genstatus.classList.remove('hide');
    genstatus.textContent = 'Copied.';
  });

  document.getElementById('send').addEventListener('click', function () {
    if (!current) return;
    var t = tok.value.trim();
    if (!t) { status.textContent = 'the admin token is required to write to the repo'; return; }
    var btn = document.getElementById('send');
    btn.disabled = true;
    status.textContent = 'sending…';
    fetch(BASE + '/api/agents/owner-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': t },
      body: JSON.stringify({ subject: current.title, body: current.channel_body, kind: 'instruction' })
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (res) {
        btn.disabled = false;
        if (res.s === 401) { status.textContent = 'the office refused the token.'; return; }
        if (!res.j.ok) { status.textContent = 'refused: ' + (res.j.reason || res.s); return; }
        status.textContent = 'Landed at ' + res.j.path + ' (id ' + res.j.id + '). The office reads this folder on its next context refresh.';
      }).catch(function (e) {
        btn.disabled = false;
        status.textContent = 'could not reach the office: ' + e.message;
      });
  });
}());
</script>
</body>
</html>`;
}
