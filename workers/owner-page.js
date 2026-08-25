/**
 * workers/owner-page.js — THE PAGE THE OWNER TYPES INTO.
 *
 * Written 2026-08-10 (REQ-003). Pure: **this module imports nothing.** Same rule
 * `owner-channel.js`, `capability-audit.js`, `deliverable-lifecycle.js` and
 * `office-policy.js` keep, and for the same reason — plain `node` must be able to
 * load it so `scripts/verify-owner-page.js` exercises the real code, including
 * the real message builder, rather than a hand-mirror of it.
 *
 * ── WHAT THE OWNER ASKED FOR ─────────────────────────────────────────────
 *
 * *A page where I write a message, it reaches the office, and they reply on the
 * same page.*
 *
 * ── WHY THIS IS WIRING AND NOT CONSTRUCTION ──────────────────────────────
 *
 * Every piece already existed. The Worker is a server with an authenticated
 * endpoint. It holds `BACKOFFICE_REPO_TOKEN`. `owner-channel.js` already parses
 * the folder, keeps the read record and reads the replies. What was missing was
 * one hop: a page that POSTs a message and a handler that writes it into
 * `channel/from-owner/` in the contract's format.
 *
 * The warehouse's `office-site` (four phases, 129/129 checks, 2026-08-07) built a
 * message box whose own honesty note says it *"cannot yet deliver on its own"* —
 * its phase 3 offers to open a prefilled GitHub Issue in a new tab, which is a
 * hand-off, not a delivery. **This page is the delivery that box was waiting
 * for.** It does not replace that site; see `scripts/verify-owner-page.js`'s
 * header and the submission filed the same day for what deploying the fuller
 * interface would take.
 *
 * ── THE PARSER IS NOT RELAXED. THE PAGE IS CONSTRAINED INSTEAD ───────────
 *
 * `parseOwnerMessage()` refuses rather than defaults on a bad filename, missing
 * front matter, an unrecognised `kind` or an empty body. **Every one of those
 * refusals stays exactly as it is.** The page satisfies the contract; the
 * contract is not softened to suit the page.
 *
 * And it is enforced at the point of writing rather than trusted:
 * `buildOwnerMessage()` produces a candidate file, the HTTP handler runs that
 * candidate through THE REAL `parseOwnerMessage()`, and **a candidate that does
 * not parse is refused and never written.** So the page cannot produce a message
 * the office would later fail to read — not because the builder is careful, but
 * because the same parser that reads the folder stands between the page and the
 * folder. Two implementations of one format is the drift this project keeps
 * finding; there is one, and the writer is downstream of it.
 *
 * ── AUTHENTICATED, WITH NO SECOND PATH ───────────────────────────────────
 *
 * This is the owner's instruction channel and therefore a trust boundary. The
 * write endpoint sits under `/api/agents/`, which the Worker's own router
 * authenticates against `ADMIN_TOKEN` before any handler is reached — the same
 * check every trigger already passes. There is no unauthenticated write path and
 * no query-string token: the token travels in `X-Admin-Token`, so it never lands
 * in a URL, a referrer or a server log.
 *
 * The page itself is served unauthenticated and holds NO secret — it is an empty
 * form until the owner pastes his token in, and the token lives in
 * `sessionStorage` for that tab only. That split is deliberate: a page that
 * embedded the token would put it in the public repo's git history the moment
 * anybody saved a copy.
 *
 * ── AND WHY THE OFFICE MAY BUILD THIS AT ALL ─────────────────────────────
 *
 * `channel/from-owner/README.md` draws the line and it is worth quoting, because
 * it is the reason this file is a PAGE and not a redesign of the folder:
 *
 *   > An office that builds its own instruction channel builds the pipe that
 *   > feeds it.
 *
 * The BASE — the folder, the contract, the `kind` vocabulary, the read record —
 * is the owner's, built under supervision. The PRESENTATION LAYER over it is the
 * office's work and carries no such problem. This file is presentation. It adds
 * no `kind`, changes no field, and relaxes no rule.
 */

/* ─────────────────────────── The message file ───────────────────────────── */

/** The `kind` values the PAGE offers. A subset of OWNER_KINDS, deliberately:
 *  `reply` is threaded by `re:` and belongs to a reply control rather than a
 *  free-standing compose box. The page must never offer a kind the parser does
 *  not know — and `scripts/verify-owner-page.js` asserts this list is a subset of
 *  the parser's, so adding one here without adding it there fails a check. */
export const PAGE_KINDS = Object.freeze(['instruction', 'decision', 'approval', 'emergency', 'reply']);

/** Filename slug rules, taken from OWNER_FILE_RE in owner-channel.js:
 *  `^[a-z0-9][a-z0-9-]*$`. Enforced here so the page cannot even offer to
 *  create a filename the parser would refuse. */
export function slugify(raw) {
  const slug = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}

/**
 * Builds the message file the page will write.
 *
 * Returns `{ ok: false, reason }` rather than a best-effort file when the input
 * cannot make a valid message. Refusing here as well as at the parser is not
 * belt-and-braces for its own sake: a refusal HERE can name the field the owner
 * needs to fix, and a refusal at the parser can only say the file is malformed.
 * The parser stays the authority; this is the better error message.
 *
 * ── THE SUBJECT IS REQUIRED, AND THE REASON IS THE PARSER'S ──────────────
 *
 * `parseOwnerMessage()` takes the message's title from the body's first `# `
 * heading and falls back to the de-hyphenated slug. A page that let the owner
 * send a body with no heading would produce messages whose titles were guesses
 * from filenames — readable, and wrong in every prompt they appear in. So the
 * page asks for one line of subject and writes it as the `# ` heading.
 *
 * @param {object} input
 * @param {string} input.subject - one line; becomes the `# ` heading AND the slug
 * @param {string} input.body    - what he wants
 * @param {string} input.kind    - one of PAGE_KINDS
 * @param {string} input.date    - `YYYY-MM-DD`, supplied by the caller so this
 *   module makes no clock call and the verifier can pin a date
 * @param {string} [input.re]    - the slug this replies to, or 'new'
 * @param {string} [input.slug]  - override; defaults to slugify(subject)
 * @returns {{ok: true, filename, path, text, slug} | {ok: false, reason}}
 */
export function buildOwnerMessage({ subject, body, kind, date, re = 'new', slug = null } = {}) {
  const subj = String(subject || '').trim().replace(/\s+/g, ' ');
  if (!subj) return { ok: false, reason: 'subject is required — it becomes the message\'s title in every prompt, and without it the office would read a title guessed from the filename' };
  if (/[\r\n]/.test(String(subject || ''))) return { ok: false, reason: 'the subject must be a single line' };

  const text = String(body || '').trim();
  if (!text) return { ok: false, reason: 'the message body is empty — the parser refuses a message with no instruction in it, and so does this' };

  if (!PAGE_KINDS.includes(kind)) {
    return { ok: false, reason: `kind must be one of ${PAGE_KINDS.join(' | ')} — refused rather than defaulted, because the default would be the office deciding how urgently to treat your own words` };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return { ok: false, reason: 'date must be YYYY-MM-DD — the date prefix is what orders the directory' };
  }

  const finalSlug = slug ? slugify(slug) : slugify(subj);
  if (!finalSlug) {
    return { ok: false, reason: 'could not build a filename slug from the subject — use at least one letter or digit' };
  }

  const filename = `${date}-${finalSlug}.md`;

  /*
   * `status:` is written as `open`, always, and the page offers no control for it.
   * That is the contract's rule stated as code: *"the office writes this, you do
   * not"*. `acted` additionally requires an `Acted:` line, and a page that let the
   * owner set it would let him mark the office's homework — which is the one thing
   * the field exists to prevent.
   */
  const fileText = `---
from: owner
date: ${date}
kind: ${kind}
re: ${re || 'new'}
status: open
---

# ${subj}

${text}
`;

  return { ok: true, filename, path: `channel/from-owner/${filename}`, text: fileText, slug: finalSlug };
}

/* ──────────────────────────── The state view ────────────────────────────── */

/**
 * What the owner sees back: each of his messages with its READ STATE, plus what
 * the office has sent him.
 *
 * ── THE READ STATE IS THE POINT, NOT A DETAIL ────────────────────────────
 *
 * `channel/README.md` names the failure this whole channel was built against:
 *
 *   > A message the office has not read looks exactly like a message the office
 *   > has read and ignored.
 *
 * A page that showed him a list of his own messages and nothing else would
 * reproduce that failure in a nicer font. So every message carries one of three
 * states, and they come from `classifyOwnerMessages()` — the same classifier the
 * agent prompts use, not a second reading of the same files.
 *
 * @param {object} snapshot - getOfficeSnapshot()'s result
 * @returns {object} a JSON-safe view; no secrets, no tokens, no file contents
 *   beyond what the owner wrote himself and what the office wrote to him.
 */
export function buildOwnerState(snapshot) {
  const owner = snapshot?.owner || null;
  const classified = owner?.classified || null;

  const state = (m) => {
    if (m.status === 'acted' || m.status === 'closed') return 'ACTED';
    return m.readAt ? 'READ_NOT_ACTED' : 'UNREAD';
  };

  const messages = classified
    ? [...classified.unactioned, ...classified.acted].map((m) => ({
      id: m.id,
      date: m.date,
      kind: m.kind,
      title: m.title,
      status: m.status,
      state: state(m),
      readAt: m.readAt || null,
      // The `Acted:` line, verbatim. This is the only place the owner can see
      // WHAT the office did rather than that it says it did something — the whole
      // distinction the field exists for.
      acted: m.acted || null,
      body: m.body,
      path: m.path,
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)))
    : [];

  return {
    // `ok: false` when the channel could not be read AT ALL. Distinct from an
    // empty channel, and the page says which — "you have written nothing" and
    // "the office cannot see what you wrote" must never look alike.
    ok: !!owner,
    channelReadable: !!owner,
    messages,
    counts: classified?.counts || { total: 0, unactioned: 0, unread: 0, readNotActed: 0, acted: 0, emergency: 0 },
    malformed: owner?.malformed || [],
    submissions: (snapshot?.submissions?.submissions || []).map((s) => ({
      id: s.id, title: s.title, date: s.date, open: s.open, marker: s.marker,
      did: s.did, recommend: s.recommend, decision: s.decision, fallback: s.fallback,
      rung: s.escalation?.rung || null, days: s.escalation?.days ?? null,
    })),
    questions: (snapshot?.questions?.questions || []).map((q) => ({
      id: q.id, title: q.title || q.question || null, open: q.open, date: q.date,
    })),
    // Reported, not hidden. A page that silently omitted the office's own read
    // errors would be the most misleading surface in the whole system: the owner
    // would conclude his message was ignored when it was unreadable.
    errors: snapshot?.errors || [],
    fetchedAt: snapshot?.fetched_at || null,
  };
}

/* ──────────────────────────────── The page ─────────────────────────────── */

/**
 * The page, as one self-contained HTML string.
 *
 * No build step, no external asset, no CDN — the same constraint the warehouse's
 * `office-site` holds, and here it is load-bearing rather than stylistic: this is
 * served by a Worker with no static-asset binding, and a page with an external
 * dependency is a page that stops working when that host does.
 *
 * `endpointBase` is passed in rather than hardcoded so a preview deployment
 * serves a page that talks to itself.
 */
/**
 * `signedInViaAccess` (2026-08-25, Session 21): the router telling this page
 * that the request which fetched it carried a VERIFIED Cloudflare Access
 * assertion. When true, the paste-a-token card is not rendered — he is signed
 * in with Google and the browser puts the same assertion on this page's own
 * calls, because they now go to `/admin/api/...`, inside the Access
 * application's path scope. It changes what is DRAWN; every call is still
 * authenticated by the Worker on its own.
 */
export function renderOwnerPage({ endpointBase = '', signedInViaAccess = false } = {}) {
  const kindOptions = PAGE_KINDS
    .map((k) => `<option value="${k}"${k === 'instruction' ? ' selected' : ''}>${k}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Office — your channel</title>
<style>
:root{--ink:#1b2432;--ink-2:#4a5568;--line:#dfe3ea;--bg:#fbfaf7;--card:#fff;--accent:#24406b;--warn:#8a3b12;--ok:#1f6b45}
@media (prefers-color-scheme:dark){:root{--ink:#e8ecf2;--ink-2:#a3adbd;--line:#2c3444;--bg:#151a22;--card:#1d2430;--accent:#8fb3e6;--warn:#e0a273;--ok:#77c79c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:24px 18px 64px}
header{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:24px}
h1{font-size:1.5rem;margin:0 0 4px}
.sub{color:var(--ink-2);font-size:.92rem;margin:0}
h2{font-size:1.08rem;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
label{display:block;font-size:.82rem;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);margin:12px 0 4px}
input,textarea,select{width:100%;padding:10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:140px;resize:vertical}
button{margin-top:14px;padding:11px 18px;border:0;border-radius:7px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line);font-weight:400;padding:6px 12px;margin:0}
.badge{display:inline-block;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:20px;border:1px solid var(--line);color:var(--ink-2)}
.badge.unread{border-color:var(--warn);color:var(--warn)}
.badge.acted{border-color:var(--ok);color:var(--ok)}
.msg{border-bottom:1px solid var(--line);padding:12px 0}
.msg:last-child{border-bottom:0}
.msg h3{font-size:1rem;margin:0 0 4px;font-weight:600}
.meta{font-size:.8rem;color:var(--ink-2)}
.body{white-space:pre-wrap;margin-top:8px;font-size:.94rem}
.note{font-size:.86rem;color:var(--ink-2);border-left:3px solid var(--line);padding-left:12px;margin:10px 0}
.err{border-left-color:var(--warn);color:var(--warn)}
#status{margin-top:12px;font-size:.9rem;min-height:1.4em}
.hide{display:none}
code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:.86em}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>The Office — your channel</h1>
  <p class="sub">Write here and it lands in <code>back-office-AI-agents/channel/from-owner/</code>. Every agent sees it at the top of every prompt, above the delegation board.</p>
</header>

<div class="card" id="auth">
  ${signedInViaAccess ? '<p class="note">Signed in. Reading your channel…</p>' : `<label for="token">Admin token</label>
  <input id="token" type="password" autocomplete="off" placeholder="X-Admin-Token">
  <p class="note">Held in this tab only (<code>sessionStorage</code>) and sent as a header, never in the URL. This page carries no secret of its own.</p>
  <button id="unlock">Unlock</button>`}
  <div id="status"></div>
</div>

<div id="app" class="hide">
  <h2>Write to the office</h2>
  <div class="card">
    <form id="compose">
      <label for="kind">Kind — this changes what happens, it is not a label</label>
      <select id="kind">${kindOptions}</select>
      <p class="note" id="kindNote"></p>

      <label for="subject">Subject — one line. Becomes the title the office sees everywhere.</label>
      <input id="subject" maxlength="140" placeholder="Ship the office site">

      <label for="body">Message</label>
      <textarea id="body" placeholder="What you want, in as many or as few words as you like."></textarea>

      <label for="re">In reply to <span style="text-transform:none">(a slug, or leave as <code>new</code>)</span></label>
      <input id="re" value="new">

      <button id="send" type="submit">Send to the office</button>
    </form>
    <p class="note">Validated against the office's own parser <em>before</em> anything is written. If it would not parse, nothing is committed and you are told which field to fix — the parser is not relaxed to accept the page.</p>
  </div>

  <h2>Your messages, and whether the office has read them</h2>
  <p class="note">Three states, because <em>unread</em> and <em>read&nbsp;and&nbsp;ignored</em> must not look alike:
    <span class="badge unread">unread</span> no read record exists for this content ·
    <span class="badge">read, not acted</span> the office has seen it ·
    <span class="badge acted">acted</span> and it says what it did.</p>
  <div class="card" id="messages">Loading…</div>

  <h2>What the office has sent you</h2>
  <div class="card" id="outbound">Loading…</div>
</div>

<script>
(function(){
  var BASE = ${JSON.stringify(endpointBase)};
  var KIND_NOTES = {
    instruction: 'Do this / stop doing that. Treated as work that OUTRANKS the delegation board.',
    decision: 'Your ruling on something the office referred up. Unblocks whatever named it.',
    approval: 'You approving a deliverable. The only thing that moves finished work past the CEO.',
    emergency: 'Stop and deal with this. Rendered first, ahead of every other message regardless of date — the office is expected to have STOPPED and be waiting.',
    reply: 'An answer to something the office wrote. Threaded by the slug in "In reply to".'
  };
  var $ = function(id){ return document.getElementById(id); };
  var token = '';

  function setStatus(msg, isErr){
    var el = $('status');
    el.textContent = msg || '';
    el.style.color = isErr ? 'var(--warn)' : 'var(--ink-2)';
  }

  function api(path, opts){
    opts = opts || {};
    /* The token header is OMITTED when there is no token, rather than sent
       empty. A signed-in owner has no token to send — Cloudflare Access put a
       verified assertion on this request instead — and an empty header would
       be a credential the server has to decide about for no reason. */
    var base = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) base['X-Admin-Token'] = token;
    opts.headers = Object.assign(base, opts.headers || {});
    return fetch(BASE + path, opts).then(function(r){
      return r.json().catch(function(){ return { error: 'the server did not return JSON (HTTP ' + r.status + ')' }; })
        .then(function(j){ return { status: r.status, body: j }; });
    });
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }

  function renderMessages(st){
    var box = $('messages');
    if (!st.channelReadable) {
      box.innerHTML = '<p class="note err">The office could not read the channel at all. This is NOT the same as you having written nothing — do not read an empty list as silence.</p>';
      return;
    }
    if (!st.messages.length) {
      box.innerHTML = '<p class="note">You have not written to the office yet. (The channel is readable — this is genuinely empty, not broken.)</p>';
      return;
    }
    var html = st.messages.map(function(m){
      var cls = m.state === 'UNREAD' ? 'unread' : (m.state === 'ACTED' ? 'acted' : '');
      var label = m.state === 'UNREAD' ? 'not yet read' : (m.state === 'ACTED' ? 'acted' : 'read, not acted');
      return '<div class="msg"><h3>' + esc(m.title) + '</h3>'
        + '<p class="meta"><span class="badge ' + cls + '">' + label + '</span> '
        + esc(m.kind) + ' · ' + esc(m.date) + ' · <code>' + esc(m.id) + '</code>'
        + (m.readAt ? ' · read ' + esc(m.readAt) : '') + '</p>'
        + (m.acted ? '<p class="meta">Acted: ' + esc(m.acted) + '</p>' : '')
        + '<div class="body">' + esc(m.body) + '</div>'
        + '<button class="ghost" data-reply="' + esc(m.id.replace(/^\\d{4}-\\d{2}-\\d{2}-/, '')) + '">Reply to this</button></div>';
    }).join('');
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-reply]'), function(b){
      b.addEventListener('click', function(){
        $('re').value = b.getAttribute('data-reply');
        $('kind').value = 'reply';
        $('kind').dispatchEvent(new Event('change'));
        $('subject').focus();
      });
    });
  }

  function renderOutbound(st){
    var box = $('outbound');
    var parts = [];
    var openSubs = st.submissions.filter(function(s){ return s.open; });
    if (openSubs.length) {
      parts.push('<h3 style="font-size:.98rem;margin:0 0 8px">Awaiting your decision</h3>');
      parts.push(openSubs.map(function(s){
        return '<div class="msg"><h3>' + esc(s.id) + ' — ' + esc(s.title) + '</h3>'
          + '<p class="meta"><span class="badge">' + esc(s.rung || '') + (s.days != null ? ', ' + s.days + 'd' : '') + '</span> ' + esc(s.date) + '</p>'
          + '<div class="body"><strong>We did:</strong> ' + esc(s.did) + '\\n<strong>We recommend:</strong> ' + esc(s.recommend)
          + '\\n<strong>Your decision:</strong> ' + esc(s.decision) + '\\n<strong>If you say nothing:</strong> ' + esc(s.fallback) + '</div></div>';
      }).join(''));
    }
    var openQs = st.questions.filter(function(q){ return q.open; });
    if (openQs.length) {
      parts.push('<h3 style="font-size:.98rem;margin:18px 0 8px">Open questions</h3>');
      parts.push(openQs.map(function(q){
        return '<div class="msg"><h3>' + esc(q.id) + ' — ' + esc(q.title || '') + '</h3><p class="meta">' + esc(q.date) + '</p></div>';
      }).join(''));
    }
    if (!parts.length) parts.push('<p class="note">Nothing is waiting on you.</p>');
    if (st.errors && st.errors.length) {
      parts.push('<p class="note err"><strong>The office reports ' + st.errors.length
        + ' problem(s) reading its own channel.</strong> Shown because a page that hid them would let you read "unreachable" as "ignored":<br>'
        + st.errors.map(esc).join('<br>') + '</p>');
    }
    box.innerHTML = parts.join('');
  }

  function load(opts){
    var quiet = !!(opts && opts.quiet);
    return api('/admin/api/agents/owner-state').then(function(r){
      if (r.status !== 200) {
        if (!quiet) setStatus(r.body.error || ('HTTP ' + r.status), true);
        return false;
      }
      renderMessages(r.body.state);
      renderOutbound(r.body.state);
      return true;
    });
  }

  $('kind').addEventListener('change', function(){ $('kindNote').textContent = KIND_NOTES[$('kind').value] || ''; });
  $('kindNote').textContent = KIND_NOTES.instruction;

  /* Absent on a page rendered for a signed-in owner — there is no token field
     and no unlock button in that HTML at all. */
  if ($('unlock')) $('unlock').addEventListener('click', function(){
    token = $('token').value.trim();
    if (!token) { setStatus('Paste the admin token first.', true); return; }
    setStatus('Checking…');
    load().then(function(ok){
      if (!ok) return;
      try { sessionStorage.setItem('office.token', token); } catch (e) {}
      $('auth').classList.add('hide');
      $('app').classList.remove('hide');
    });
  });

  $('compose').addEventListener('submit', function(e){
    e.preventDefault();
    $('send').disabled = true;
    setStatus('Sending…');
    api('/admin/api/agents/owner-message', {
      method: 'POST',
      body: JSON.stringify({
        kind: $('kind').value,
        subject: $('subject').value,
        body: $('body').value,
        re: $('re').value.trim() || 'new'
      })
    }).then(function(r){
      $('send').disabled = false;
      if (r.status !== 200 || !r.body.ok) {
        setStatus('Not sent — ' + (r.body.reason || r.body.error || ('HTTP ' + r.status)), true);
        return;
      }
      setStatus('Delivered as ' + r.body.path + '. The office reads this folder on every context refresh.');
      $('subject').value = ''; $('body').value = ''; $('re').value = 'new';
      load();
    });
  });

  try {
    var saved = sessionStorage.getItem('office.token');
    if (saved && $('token')) { $('token').value = saved; token = saved; }
  } catch (e) {}

  /* ── ASK THE SERVER BEFORE LOCKING THE PAGE (2026-08-25, Session 21) ─────
   *
   * This page used to decide, on its own, that it was locked: the form was
   * shown and no call was made until somebody typed something into it.
   * That is the defect the owner has reported twice. He signs in with Google,
   * Cloudflare Access authorises the request, the Worker serves this page —
   * and the page then asks him for a token it does not need, because it never
   * asked whether it had one.
   *
   * So the first thing it does now is CALL. /admin/api/agents/owner-state
   * is inside the Access application's path scope, so a signed-in browser
   * carries the assertion on it and the answer is 200 with no token anywhere.
   * The form is revealed only when the server actually refuses.
   *
   * Quietly, and this is the part worth keeping: a failure here writes NO
   * error. On *.workers.dev, or signed out, a 401 is the expected answer and
   * the correct response to it is the unlock form the page already renders —
   * not a red line accusing the owner of something before he has typed. */
  var SIGNED_IN = ${JSON.stringify(!!signedInViaAccess)};
  (function boot(){
    load({ quiet: true }).then(function(ok){
      if (ok) {
        $('auth').classList.add('hide');
        $('app').classList.remove('hide');
        return;
      }
      /* Silent when there is a form to fall back to — a 401 is the expected
         answer on *.workers.dev and signed out, and the unlock card already
         says what to do. NOT silent when the page was rendered for a signed-in
         owner: there is no form behind it, so an unexplained empty page would
         be the only thing he saw. */
      if (SIGNED_IN) setStatus('Your sign-in did not carry through to the office. Reload this page; if it happens again, sign out of Cloudflare Access and back in.', true);
    });
  })();
})();
</script>
</div>
</body>
</html>`;
}
