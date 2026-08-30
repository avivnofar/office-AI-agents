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

/*
 * The one import this file has, added 2026-08-25 (Session 18). `access-jwt.js`
 * imports nothing itself, so `scripts/verify-admin-gate.js` still loads this
 * module under plain `node` — and with no Access configuration in the test
 * environment the credential is inert and reaches no network, so
 * `globalThis.fetch` stays a tripwire there too.
 */
import { accessCredential } from './access-jwt.js';

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

/* ── THE ADMIN SURFACE'S OWN API PREFIX (2026-08-25, Session 21) ──────────
 *
 * Why this exists, stated as the measurement that produced it rather than as a
 * design preference:
 *
 *   $ curl -i https://office.avivnofar.com/admin/api/data     -> 302 cloudflareaccess.com
 *   $ curl -i https://office.avivnofar.com/api/admin          -> the Worker's own 401
 *
 * The first path is one this Worker did not serve when that was measured. It
 * still redirected. **An Access application binds a hostname AND A PATH**, and
 * this one is scoped to `/admin` — Cloudflare says so itself in the
 * `Www-Authenticate: Cloudflare-Access resource_metadata=".../admin"` header on
 * the 302. So Cloudflare attaches `Cf-Access-Jwt-Assertion` to everything under
 * `/admin`, and to NOTHING under `/api`.
 *
 * That is the whole of the owner's complaint. Since Session 18 the API gate has
 * accepted a verified assertion — `adminCredential(..., { surface: 'api' })` —
 * and it was never once reached with one, because the page's `fetch('/api/admin')`
 * left the Access application's path scope and arrived bare. The page was
 * authorised; its own calls were anonymous; it fell back to asking for a token.
 *
 * So the admin pages call their endpoints INSIDE the prefix that Access covers,
 * and this map turns each one back into the canonical route that already
 * exists. Nothing is duplicated and no handler moves.
 *
 * WHY AN EXPLICIT MAP AND NOT `'/api/' + rest`. A prefix that rewrites anything
 * after it into `/api/` is a path-traversal surface wearing a helpful face: a
 * percent-encoded segment survives `new URL().pathname` undecoded, so a
 * `.includes('..')` test would not be the check it looks like. Four named
 * routes cannot traverse anywhere. A fifth admin endpoint is one line here, and
 * having to write that line is the point.
 *
 * WHAT THIS IS NOT. It is not a new credential and not a new acceptance path.
 * The rewrite happens BEFORE the gates, so an aliased request is authenticated
 * by exactly the check its canonical path always had — `surface: 'api'`, which
 * refuses the page cookie and requires same-origin for anything that changes
 * something. On `*.workers.dev`, where no Access policy can reach and nothing
 * strips the header, `/admin/api/data` and `/api/admin` are the same request
 * with the same signature check in front of it.
 */
export const ADMIN_API_PREFIX = '/admin/api/';

const ADMIN_API_ROUTES = new Map([
  ['data', '/api/admin'],
  ['agents/owner-state', '/api/agents/owner-state'],
  ['agents/owner-message', '/api/agents/owner-message'],
  ['spec/build', '/api/spec/build'],
  /*
   * ── `item` (2026-08-25, Session 22, Item A) ────────────────────────────
   *
   * ONE pending item, whole, for the expand control on its card.
   *
   * **THE ITEM'S IDENTITY TRAVELS IN THE QUERY STRING, NOT IN THE PATH.** That
   * is not a style choice and it is worth the line of explanation, because the
   * obvious spelling is `/admin/api/item/<id>` and it is the one this map
   * cannot have.
   *
   * The rule above this block is that the alias is a MAP and never `'/api/' +
   * rest`, because a prefix that rewrites anything after it into `/api/` is a
   * path-traversal surface wearing a helpful face. An item id is per-item and
   * changes as the board does, so a path segment carrying it cannot be an exact
   * key — it could only be matched by a pattern, and a pattern here is the
   * generalisation the rule forbids. A query string keeps the route EXACT:
   * `canonicalAdminApiPath()` rewrites `url.pathname` and never touches
   * `url.search`, so `?id=…` reaches the handler untouched and no attacker-
   * shaped string ever influences which path is served.
   *
   * The id is then validated against a fixed per-source pattern in
   * `item-detail.js` `parseItemRef()`, and the file it selects is a CONSTANT in
   * `ITEM_SOURCES` — the path is never built from the id.
   */
  ['item', '/api/admin/item'],
  /*
   * ── `automations` and `trigger` (2026-08-30, session 40, Item C) ───────
   *
   * Two lines, written by hand, exactly as this map's header says a fifth
   * endpoint must be — no pattern, no prefix rewrite, no traversal surface.
   *
   * `trigger` is the ONE that deserves a sentence. It is the endpoint that
   * flips the office's kill switches, and it is aliased here only so the
   * automations page can call it from inside the prefix Access covers. **It
   * gains no credential by being here.** The rewrite happens before the gates,
   * so it is still `surface: 'api'` — the page cookie is still refused, and a
   * state-changing call on the Access path still requires same-origin. On
   * `*.workers.dev`, where no Access policy reaches, the cookie is refused and
   * the toggles answer 401 until the caller presents the header; the page says
   * so rather than appearing broken.
   */
  ['automations', '/api/admin/automations'],
  ['trigger', '/api/agents/trigger'],
  /*
   * ── `artifacts` and `artifact` (2026-08-30) ─────────────────────────────
   *
   * Two more lines, written by hand, same discipline as every entry above:
   * an exact map, never a prefix rewrite. `artifact`'s identity travels in
   * the query string — `?task=<slug>` — for the same reason `item`'s does:
   * a task slug is per-task and changes as the warehouse does, so it cannot
   * be an exact key in this map, and it is validated against a fixed
   * pattern in `artifact-gallery.js` before it ever touches a path.
   */
  ['artifacts', '/api/admin/artifacts'],
  ['artifact', '/api/admin/artifact'],
]);

/**
 * The canonical route an `/admin/api/...` request means, or null when the path
 * is not one of them — null leaves the URL untouched, so an unknown path under
 * the prefix stays an ordinary gated admin path and 404s after the gate rather
 * than reaching anything.
 */
export function canonicalAdminApiPath(pathname) {
  const p = String(pathname || '');
  if (!p.startsWith(ADMIN_API_PREFIX)) return null;
  return ADMIN_API_ROUTES.get(p.slice(ADMIN_API_PREFIX.length)) || null;
}

/** The prefix, as the browser should call it. Exported so the three admin page
 *  renderers name one constant instead of three string literals that can drift. */
export function adminApiUrl(route) {
  return ADMIN_API_PREFIX + route;
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

/* ── THE THIRD CREDENTIAL: GOOGLE SIGN-IN (2026-08-25, Session 18) ────────
 *
 * The owner should never have seen a paste-a-token prompt at his own front
 * door. The protection that was DESIGNED was Cloudflare Access with Google
 * sign-in; this file's token gate was built because an Access policy binds one
 * hostname and could never cover `*.workers.dev`. It was the correct second
 * layer and it became the first layer by accident.
 *
 * So a valid Access assertion is now accepted as an ALTERNATIVE, and nothing
 * is removed:
 *
 *   office.avivnofar.com, after Google sign-in -> the JWT, verified. No prompt.
 *   *.workers.dev                              -> no JWT; the token, as before.
 *   neither                                    -> 401, as before.
 *
 * `access-jwt.js` holds the check itself and why merely reading the header
 * proves nothing. Unconfigured (`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` unset) is
 * INERT, not open: the credential refuses everything and the gate falls
 * through to the token exactly as it did before this existed.
 */

/** Methods that cannot change anything. Everything else is state-changing. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Is this a state-changing request the browser sent from THIS site?
 *
 * ── WHY THIS EXISTS AT ALL, AND WHY ONLY ON THE ACCESS PATH ─────────────
 *
 * The Access assertion is an AMBIENT credential in exactly the sense this
 * file's header warns about: Cloudflare attaches it because the browser holds
 * a `CF_Authorization` cookie, so the browser presents it on any request to
 * this origin — including one a hostile page caused. That is the definition of
 * a CSRF surface on endpoints that trigger office runs and write to the owner
 * channel, and it is precisely why the `office_admin` cookie is not honoured
 * by the API.
 *
 * The token path is unaffected: `X-Admin-Token` is not ambient — a browser
 * cannot attach it cross-site, and a script sets it deliberately.
 *
 * `Sec-Fetch-Site` is sent by every current browser and is the reliable
 * signal; `Origin` is the fallback for anything that does not send it. **A
 * state-changing request with NEITHER is refused on the Access path** rather
 * than given the benefit of the doubt — the caller that has neither header is
 * not a browser, and a non-browser has the token.
 */
export function accessRequestIsSameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site') || '';
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('Origin') || '';
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (err) {
    return false;
  }
}

/**
 * THE DECISION, for both surfaces. Returns which credential answered — never a
 * bare boolean, because "refused" and "refused, and Access is not even
 * configured" are different facts and the estate has spent six recorded
 * incidents on exactly that distinction.
 *
 * Order: Access JWT, then `X-Admin-Token`, then the cookie.
 *
 * `surface` decides whether the cookie counts. `'page'` accepts it — a browser
 * cannot set a header on a navigation, so without it the door is bricked up.
 * `'api'` does NOT, unchanged from the day the cookie was introduced: a cookie
 * the API honoured would be an ambient credential on endpoints that trigger
 * office runs.
 */
export async function adminCredential(request, env, { surface = 'page', accessOpts = {} } = {}) {
  // 1. Google sign-in, through Cloudflare Access.
  let access = { ok: false, configured: false, reason: 'not evaluated', email: null, presented: false };
  try {
    access = await accessCredential(request, env, accessOpts);
  } catch (err) {
    // A throw here must never become an ALLOW, and must never take the token
    // path down with it.
    access = { ok: false, configured: false, reason: 'access check threw: ' + (err && err.message ? err.message : err), email: null, presented: false };
  }
  if (access.ok) {
    if (!SAFE_METHODS.has(String(request.method || 'GET').toUpperCase()) && !accessRequestIsSameOrigin(request)) {
      return {
        ok: false, via: null, access,
        reason: 'a signed-in session may only change something from a request this site made',
      };
    }
    return { ok: true, via: 'access-jwt', email: access.email, access, reason: null };
  }

  // 2 and 3. The office's own token, and the derived cookie a browser carries.
  if (!env || !env.ADMIN_TOKEN) {
    return { ok: false, via: null, access, reason: 'no ADMIN_TOKEN is configured — nobody is authorized' };
  }

  const header = request.headers.get('X-Admin-Token') || '';
  if (header && constantTimeEqual(header, env.ADMIN_TOKEN)) {
    return { ok: true, via: 'admin-token', email: null, access, reason: null };
  }

  if (surface === 'page') {
    const cookie = readCookie(request.headers.get('Cookie') || '', ADMIN_COOKIE_NAME);
    if (cookie && constantTimeEqual(cookie, await adminCookieValue(env.ADMIN_TOKEN))) {
      return { ok: true, via: 'admin-cookie', email: null, access, reason: null };
    }
  }

  return { ok: false, via: null, access, reason: 'no accepted credential on the request' };
}

/**
 * The decision, as a boolean, for callers that only need one.
 *
 * Three accepted credentials now: a verified Cloudflare Access assertion, the
 * `X-Admin-Token` header a script or a curl presents, and the `office_admin`
 * cookie a BROWSER presents because it cannot set a header on a navigation.
 */
export async function adminPageAuthorized(request, env) {
  return (await adminCredential(request, env, { surface: 'page' })).ok;
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
