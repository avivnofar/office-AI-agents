/**
 * workers/admin-gate.js — the office's own gate on every /admin page.
 *
 * Written 2026-08-25 (Session 17, Item A), after a private-browsing window
 * loaded the full spec-builder form at `office.avivnofar.com/admin/spec` with
 * no login and no token — and the same form at
 * `data-center-agents.avivnofar.workers.dev/admin/spec`, which is the part that
 * decides the shape of this file.
 *
 * ── WHY A CODE GATE AND NOT JUST CLOUDFLARE ACCESS ───────────────────────
 *
 * Access was the plan of record: `/admin*` was chosen as the prefix precisely
 * so ONE Access policy could cover everything sensitive. Two things found on
 * 2026-08-25 make Access insufficient ON ITS OWN, neither of which is a
 * criticism of that plan:
 *
 *   1. The Access application configured in the dashboard shows
 *      `No policy associated`, so it enforces NOTHING. No request to either
 *      hostname was ever redirected to cloudflareaccess.com. An application
 *      with no policy is indistinguishable, from outside, from no application.
 *   2. **An Access policy binds a HOSTNAME.** `workers_dev = true` is a
 *      deliberate, load-bearing setting (three live consumers — see
 *      wrangler.toml), so this Worker answers on a SECOND hostname that no
 *      policy on `office.avivnofar.com` can ever cover. Whatever the dashboard
 *      says, `*.workers.dev` stays open unless the code closes it.
 *
 * So the gate is here, in version control, running on every hostname the
 * Worker answers on. Access, once the owner attaches a policy, becomes the
 * second layer in front of it. Neither is sufficient alone; that is the point.
 *
 * ── THE COOKIE IS NOT THE TOKEN, AND THAT IS DELIBERATE ──────────────────
 *
 * A browser cannot put `X-Admin-Token` on a top-level navigation. A page gated
 * on that header alone is a page the owner can never open — the gate would be
 * real and the door bricked up. So the credential has a second accepted form:
 * a cookie.
 *
 * That cookie holds **SHA-256 of a namespaced admin token, not the token**.
 * The distinction is the whole reason this is safe to do:
 *
 *   * A stolen cookie opens admin PAGES — which hold no data; they are empty
 *     forms that fetch everything they show from `/api/*`.
 *   * A stolen cookie CANNOT be replayed as `X-Admin-Token`, because it is not
 *     the token. Every API route keeps its header-only check, unchanged.
 *
 * And the API side deliberately does NOT accept the cookie. That is not an
 * omission to tidy up later: a cookie the API honoured would be an ambient
 * credential the browser attaches automatically, which is the definition of a
 * CSRF surface on endpoints that trigger office runs and write to the owner
 * channel. `SameSite=Strict` already blocks the cross-site send; not honouring
 * it on the API means the question never arises.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────
 *
 * No `env.ADMIN_TOKEN` configured means NOBODY is authorized, not everybody.
 * Same idiom as the `AUTHENTICATED_PREFIXES` block in agent-runner.js — one
 * authentication idiom in this estate, not two that must be kept in agreement.
 */

export const ADMIN_COOKIE_NAME = 'office_admin';
export const ADMIN_SESSION_PATH = '/admin/session';

/** Twelve hours. Long enough for a working day, short enough that a forgotten
 *  laptop is not a standing key. Re-typing the token is the whole recovery. */
export const ADMIN_COOKIE_MAX_AGE = 43200;

/**
 * Is this path inside the admin surface?
 *
 * `/admin` and `/admin/` are included as well as `/admin/...` so the bare
 * prefix cannot become an unguarded landing spot for a future handler. The
 * startsWith test uses `'/admin/'` WITH the slash: without it a future route
 * called `/administration` would silently inherit this gate, and a gate that
 * covers more than it claims is as hard to reason about as one that covers
 * less.
 */
export function isAdminPagePath(pathname) {
  return pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/');
}

/** Hex SHA-256 of the namespaced token. The namespace prefix makes the value
 *  useless anywhere else, even against a system that hashed the same secret. */
export async function adminCookieValue(adminToken) {
  const bytes = new TextEncoder().encode('office-admin-page:v1:' + adminToken);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read one cookie out of a Cookie header. Returns '' when absent — never
 *  undefined, so a caller cannot accidentally compare undefined to undefined. */
export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/** Length-independent comparison. The values compared here are hashes, so a
 *  timing leak would leak a hash rather than the token — tidiness, not the
 *  thing standing between an attacker and the secret. */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The decision. Two accepted credentials, both derived from one secret:
 *
 *   * `X-Admin-Token` — what a script or a curl presents.
 *   * the `office_admin` cookie — what a BROWSER presents, because a browser
 *     cannot set a header on a navigation.
 */
export async function adminPageAuthorized(request, env) {
  if (!env || !env.ADMIN_TOKEN) return false;

  const header = request.headers.get('X-Admin-Token') || '';
  if (header && constantTimeEqual(header, env.ADMIN_TOKEN)) return true;

  const cookie = readCookie(request.headers.get('Cookie') || '', ADMIN_COOKIE_NAME);
  if (!cookie) return false;
  return constantTimeEqual(cookie, await adminCookieValue(env.ADMIN_TOKEN));
}

/** `Path=/admin` so the browser never sends this cookie to `/api/*` at all.
 *  The API's refusal to honour it is then belt AND braces. */
export function adminSessionSetCookie(value) {
  return ADMIN_COOKIE_NAME + '=' + value + '; Path=/admin; Max-Age=' + ADMIN_COOKIE_MAX_AGE
    + '; HttpOnly; Secure; SameSite=Strict';
}

/**
 * The unlock page, served as the BODY OF THE 401 — not as a 200 at some other
 * path.
 *
 * A separate `/admin/login` returning 200 would be a second live entrance, and
 * the brief that produced this file is explicit that a second live entrance is
 * the thing to avoid. A 401 whose body happens to be a usable form is one
 * door: an unauthenticated request is refused with the correct status for a
 * machine, and a human standing at the same door is handed the keyhole.
 *
 * The two sessionStorage keys are not a mistake. `/owner` reads `office.token`
 * and the spec builder reads `office-admin-token` — two names for one secret,
 * a pre-existing divergence this file has no standing to rename. Writing both
 * means one unlock serves both pages.
 */
export function renderAdminUnlockPage({ pathname = '/admin' } = {}) {
  const wanted = JSON.stringify(pathname);
  const sessionPath = JSON.stringify(ADMIN_SESSION_PATH);
  return [
    "<!-- 401 unauthorized — /admin is gated by the office's own admin token -->",
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<title>The office &mdash; locked</title>',
    '<style>',
    '  :root { color-scheme: dark; }',
    '  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;',
    '         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;',
    '         background:#0f1115; color:#e6e8ee; padding:24px; }',
    '  .card { width:100%; max-width:420px; background:#171a21; border:1px solid #262b36;',
    '          border-radius:12px; padding:28px; }',
    '  h1 { margin:0 0 6px; font-size:18px; letter-spacing:-.01em; }',
    '  p  { margin:0 0 18px; color:#9aa3b2; font-size:13px; }',
    '  label { display:block; font-size:12px; color:#9aa3b2; margin-bottom:6px; }',
    '  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px;',
    '          border:1px solid #2f3542; background:#0f1115; color:#e6e8ee; font-size:14px; }',
    '  button { margin-top:12px; width:100%; padding:10px 12px; border-radius:8px; border:0;',
    '           background:#3b6cf6; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }',
    '  button:disabled { opacity:.5; cursor:default; }',
    '  .msg { margin-top:12px; font-size:13px; min-height:1.4em; }',
    '  .err { color:#ff8f8f; }',
    '  .foot { margin-top:18px; font-size:11px; color:#6b7484; line-height:1.5; }',
    '  code { color:#b9c2d0; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="card">',
    '  <h1>The office is locked</h1>',
    '  <p>This page is under <code>/admin</code>. It needs the office&rsquo;s admin token.</p>',
    '  <label for="tok">Admin token</label>',
    '  <input id="tok" type="password" autocomplete="off" placeholder="X-Admin-Token">',
    '  <button id="go">Unlock</button>',
    '  <div class="msg" id="msg"></div>',
    '  <p class="foot">The token is checked by the Worker. What is stored in this browser is a',
    '  derived value that cannot be replayed against the office&rsquo;s API &mdash; every API call',
    '  still needs the token itself, which stays in this tab only.</p>',
    '</div>',
    '<script>',
    '(function () {',
    "  var tok = document.getElementById('tok');",
    "  var go  = document.getElementById('go');",
    "  var msg = document.getElementById('msg');",
    '  var WANTED = ' + wanted + ';',
    '',
    '  function say(text, isErr) {',
    '    msg.textContent = text;',
    "    msg.className = isErr ? 'msg err' : 'msg';",
    '  }',
    '',
    '  function unlock() {',
    '    var value = tok.value.trim();',
    "    if (!value) { say('Paste the token first.', true); return; }",
    '    go.disabled = true;',
    "    say('Checking...', false);",
    '    fetch(' + sessionPath + ', {',
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    '      body: JSON.stringify({ token: value })',
    '    }).then(function (res) {',
    '      if (!res.ok) {',
    '        go.disabled = false;',
    "        say(res.status === 401 ? 'That token was refused.' : 'Refused (HTTP ' + res.status + ').', true);",
    '        return;',
    '      }',
    '      // Both keys, because the two admin pages disagree on the name.',
    "      try { sessionStorage.setItem('office.token', value); } catch (e) {}",
    "      try { sessionStorage.setItem('office-admin-token', value); } catch (e) {}",
    "      say('Unlocked. Loading...', false);",
    '      window.location.replace(WANTED);',
    '    }).catch(function (e) {',
    '      go.disabled = false;',
    "      say('Could not reach the Worker: ' + e.message, true);",
    '    });',
    '  }',
    '',
    "  go.addEventListener('click', unlock);",
    "  tok.addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });",
    '  tok.focus();',
    '})();',
    '</' + 'script>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * The refusal. 401 either way; only the body's shape follows the caller.
 *
 * A browser navigating here gets the unlock form. Anything else — curl, a
 * monitor, a script — gets JSON, because handing 6KB of HTML to a machine that
 * asked for an API is how a status code ends up being read out of a body.
 */
export function adminUnauthorizedResponse(request, pathname) {
  const accept = request.headers.get('Accept') || '';
  const wantsHtml = accept.includes('text/html');
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // Observable from outside without reading the body. §7 of
    // ARCHITECTURAL-DECISIONS.md is six instances of a gate nobody could watch
    // refuse anything.
    'X-Admin-Gate': 'refused',
  };
  if (!wantsHtml) {
    return new Response(JSON.stringify({ error: 'unauthorized', gate: 'admin-page' }), {
      status: 401,
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json; charset=utf-8' }),
    });
  }
  return new Response(renderAdminUnlockPage({ pathname }), {
    status: 401,
    headers: Object.assign({}, headers, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
    }),
  });
}
