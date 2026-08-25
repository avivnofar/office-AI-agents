#!/usr/bin/env node
/**
 * scripts/verify-admin-gate.js — is /admin actually shut?
 *
 * Written 2026-08-25 (Session 17, Item A). Run:  node scripts/verify-admin-gate.js
 *
 * ── WHAT THIS FILE IS TRYING NOT TO BE ───────────────────────────────────
 *
 * back-office `CLAUDE.md`, learned on 2026-08-06:
 *
 *   > **A test that describes a fix is not a test that catches a bug.**
 *
 * A verifier that asserted "an unauthenticated request is refused" would pass
 * against the code written today and would ALSO have passed against any number
 * of arrangements that do not actually protect anything. So §2 below
 * transcribes the PRE-FIX routing decision — no admin gate at all, exactly what
 * was live at 09:00 on 2026-08-25 — and runs the identical scenario table
 * against it. Scenarios marked `failsOld` MUST fail there. If they all pass
 * against the old logic, this file is documentation and says so by failing.
 *
 * ── AND THE ONE THAT WOULD ACTUALLY BITE ─────────────────────────────────
 *
 * §7 of ARCHITECTURAL-DECISIONS.md records six occurrences of one shape:
 * *the guard exists, and the calling path never reaches it.* On 2026-08-06 an
 * unmapped repo name SKIPPED the write guard rather than being denied by it,
 * and the documentation had said the opposite for weeks.
 *
 * So §3 does not only exercise the module. It READS `agent-runner.js` and
 * asserts, on the source text, that the gate is invoked and that it is invoked
 * BEFORE the `/admin/spec` handler is reached. A gate module nothing routes
 * through is exactly as protective as no module at all.
 *
 * §4 asserts the boundary that keeps the cookie from becoming a CSRF surface:
 * the API's token check must NOT read cookies.
 *
 * NETWORK: this verifier makes zero network calls. It proves what the code
 * decides; the live 401s on both hostnames are in the session report, because
 * only a real HTTP request from outside can prove what is deployed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ADMIN_COOKIE_NAME, ADMIN_SESSION_PATH,
  isAdminPagePath, adminPageAuthorized, adminCredential, adminUnauthorizedResponse,
  adminCookieValue, adminSessionSetCookie, readCookie,
  renderAdminUnlockPage,
  ADMIN_API_PREFIX, canonicalAdminApiPath,
} from '../workers/admin-gate.js';

const here = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(here, '..', 'workers', 'agent-runner.js'), 'utf8');

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}

const TOKEN = 'the-real-admin-token-value';
const ENV = { ADMIN_TOKEN: TOKEN };
const GOOD_COOKIE = await adminCookieValue(TOKEN);

function req(path, { token, cookie, accept = 'text/html', method = 'GET' } = {}) {
  const headers = { Accept: accept };
  if (token) headers['X-Admin-Token'] = token;
  if (cookie) headers.Cookie = cookie;
  return new Request(`https://office.avivnofar.com${path}`, { method, headers });
}

/* ═══════════════ 1. THE SCENARIO TABLE, AGAINST THE REAL GATE ════════════ */

/**
 * `failsOld` marks the scenarios whose expected outcome the PRE-FIX code did
 * not produce. Those are the rows that make this a test rather than a
 * description. Rows without it are regression guards: things that were already
 * true and must stay true.
 */
const SCENARIOS = [
  // --- the exposure itself, on the path the private window loaded ---------
  { name: 'GET /admin/spec with NO credential is refused',
    path: '/admin/spec', opts: {}, expect: 'refused', failsOld: true },
  { name: 'GET /admin/spec/ (trailing slash) with no credential is refused',
    path: '/admin/spec/', opts: {}, expect: 'refused', failsOld: true },
  { name: 'the owner page at its new home is refused without a credential',
    path: '/admin/owner', opts: {}, expect: 'refused', failsOld: true },
  { name: 'the bare prefix /admin is refused',
    path: '/admin', opts: {}, expect: 'refused', failsOld: true },
  { name: 'a path invented tomorrow under /admin inherits the refusal',
    path: '/admin/whatever-someone-adds-next', opts: {}, expect: 'refused', failsOld: true },

  // --- the credentials that must work, or the door is bricked up ----------
  { name: 'the admin token in the header opens it',
    path: '/admin/spec', opts: { token: TOKEN }, expect: 'allowed' },
  { name: 'the derived cookie opens it (this is how a BROWSER gets in)',
    path: '/admin/spec', opts: { cookie: `${ADMIN_COOKIE_NAME}=${GOOD_COOKIE}` }, expect: 'allowed' },
  { name: 'the cookie still opens it when other cookies sit beside it',
    path: '/admin/spec', opts: { cookie: `_ga=1; ${ADMIN_COOKIE_NAME}=${GOOD_COOKIE}; other=2` },
    expect: 'allowed' },

  // --- near misses --------------------------------------------------------
  { name: 'a WRONG token is refused',
    path: '/admin/spec', opts: { token: 'not-the-token' }, expect: 'refused' },
  { name: 'the RAW TOKEN in the cookie is refused (the cookie is a hash, not the token)',
    path: '/admin/spec', opts: { cookie: `${ADMIN_COOKIE_NAME}=${TOKEN}` }, expect: 'refused' },
  { name: 'a truncated cookie is refused',
    path: '/admin/spec', opts: { cookie: `${ADMIN_COOKIE_NAME}=${GOOD_COOKIE.slice(0, -1)}` },
    expect: 'refused' },
  { name: 'an empty cookie value is refused',
    path: '/admin/spec', opts: { cookie: `${ADMIN_COOKIE_NAME}=` }, expect: 'refused' },
  { name: 'a lookalike path OUTSIDE the prefix is not swept in by accident',
    path: '/administration', opts: {}, expect: 'not-admin' },

  // --- public surface must be untouched -----------------------------------
  { name: '/api/public is not inside the admin surface',
    path: '/api/public', opts: {}, expect: 'not-admin' },
  { name: '/owner (the redirect stub) is not inside the admin surface',
    path: '/owner', opts: {}, expect: 'not-admin' },
];

/** The gate as agent-runner.js calls it, in one place, so the table and the
 *  router cannot drift on the shape of the decision. */
async function decideNew(path, opts) {
  if (!isAdminPagePath(path)) return 'not-admin';
  if (path === ADMIN_SESSION_PATH) return 'authenticator';
  return (await adminPageAuthorized(req(path, opts), ENV)) ? 'allowed' : 'refused';
}

console.log('--- 1. the gate, as it is now ---');
for (const s of SCENARIOS) {
  const got = await decideNew(s.path, s.opts);
  check(s.name, got === s.expect, `expected ${s.expect}, got ${got}`);
}

/* ═════════ 2. THE SAME TABLE AGAINST A TRANSCRIPTION OF THE OLD CODE ═════ */

/**
 * What fetch() did on 2026-08-25 before this session, transcribed rather than
 * described: `AUTHENTICATED_PREFIXES` covered `/api/agents/` and `/api/admin`
 * and NOTHING covered `/admin/*`, so every admin page was served to anyone.
 */
const OLD_AUTHENTICATED_PREFIXES = ['/api/agents/', '/api/admin'];
function decideOld(path) {
  if (OLD_AUTHENTICATED_PREFIXES.some((p) => path === p || path.startsWith(p))) return 'refused';
  if (path === '/admin/spec' || path === '/admin/spec/') return 'allowed';
  if (path === '/owner' || path === '/owner/') return 'allowed';
  return 'not-admin'; // everything else fell through to the 404 branch
}

console.log('\n--- 2. the same table against the PRE-FIX logic ---');
let caught = 0;
for (const s of SCENARIOS.filter((x) => x.failsOld)) {
  const got = decideOld(s.path);
  const didFail = got !== s.expect;
  if (didFail) caught += 1;
  check(`OLD CODE FAILS: ${s.name}`, didFail,
    `the pre-fix path returned ${got}, which MATCHES the expectation — this row proves nothing`);
}
check('the table catches the bug rather than describing the fix',
  caught >= 4, `only ${caught} scenarios failed against the pre-fix logic`);

/* ═════════════ 3. IS THE GATE ACTUALLY ON THE CALLING PATH? ══════════════ */

console.log('\n--- 3. the gate is wired, and wired EARLY ---');

const gateCall = runner.indexOf('if (isAdminPagePath(url.pathname)');
const specHandler = runner.indexOf("url.pathname === '/admin/spec'");
const ownerHandler = runner.indexOf("url.pathname === '/admin/owner'");
const apiGate = runner.indexOf('const AUTHENTICATED_PREFIXES');

check('agent-runner.js imports the gate module', /from '\.\/admin-gate\.js'/.test(runner));
check('the gate is CALLED in fetch()', gateCall !== -1);
check('the refusal is returned from the gate module, not hand-rolled at the call site',
  /return adminUnauthorizedResponse\(request, url\.pathname\)/.test(runner));
check('the gate runs BEFORE the /admin/spec handler',
  gateCall !== -1 && specHandler !== -1 && gateCall < specHandler,
  `gate at ${gateCall}, /admin/spec handler at ${specHandler}`);
check('the gate runs BEFORE the /admin/owner handler',
  gateCall !== -1 && ownerHandler !== -1 && gateCall < ownerHandler,
  `gate at ${gateCall}, /admin/owner handler at ${ownerHandler}`);
check('the gate sits alongside the API token gate at the top of fetch(), not deep in a branch',
  apiGate !== -1 && gateCall !== -1 && (gateCall - apiGate) < 4000,
  `${gateCall - apiGate} characters after the API gate`);
check('/admin/session is excluded from the gate (it IS the authenticator)',
  /url\.pathname !== ADMIN_SESSION_PATH/.test(runner));
check('/admin/session refuses a wrong token itself',
  /offered !== env\.ADMIN_TOKEN/.test(runner));
check('/admin/session is POST-only — no second login page at a second URL',
  /request\.method === 'POST' && url\.pathname === ADMIN_SESSION_PATH/.test(runner)
  && !/request\.method === 'GET' && url\.pathname === ADMIN_SESSION_PATH/.test(runner));
check('the old /owner path still answers, as a redirect into the gated prefix',
  /Location: '\/admin\/owner'/.test(runner));
check('the owner page is no longer served at the unguarded /owner path',
  !/'\/owner'\s*\|\|\s*url\.pathname === '\/owner\/'\)\)\s*\{\s*return new Response\(renderOwnerPage/.test(runner));

/* ═════ 4. THE COOKIE MUST NOT BECOME AN AMBIENT API CREDENTIAL ═══════════ */

console.log('\n--- 4. the API did not learn to accept the cookie ---');

/*
 * ── RE-POINTED 2026-08-25 (Session 18, Item A) ──────────────────────────
 *
 * This check used to read: *the /api/* gate still reads ONLY the X-Admin-Token
 * header* — asserted by finding that header's name in the gate's source text
 * and no mention of a cookie. The gate now delegates to `adminCredential()`,
 * which accepts a VERIFIED Cloudflare Access assertion as well as the token,
 * so the old assertion no longer describes the code.
 *
 * **The property it existed to protect is unchanged and is now checked by
 * RUNNING the gate rather than by reading it** — which is the stronger form,
 * and the one this file's own header argues for. A source-text check that a
 * cookie name is absent proves nothing about what the code decides; the two
 * checks below hand the real function a real cookie and require a refusal.
 */
const apiGateBlock = runner.slice(apiGate, apiGate + 1800);
check('the /api/* gate delegates to the one credential resolver, on the API surface',
  /adminCredential\(request, env, \{ surface: 'api' \}\)/.test(apiGateBlock));
check('the /api/* gate refuses when that resolver says no',
  /if \(!credential\.ok\)[\s\S]{0,120}401/.test(apiGateBlock));
check('THE API STILL REFUSES THE COOKIE — run, not read',
  (await adminCredential(
    req('/api/admin', { cookie: ADMIN_COOKIE_NAME + '=' + (await adminCookieValue(TOKEN)) }),
    { ADMIN_TOKEN: TOKEN },
    { surface: 'api' },
  )).ok === false,
  'a cookie the browser attaches automatically must never authorize an endpoint that triggers office runs');
check('the same cookie DOES still open an admin page — the two surfaces differ, deliberately',
  (await adminCredential(
    req('/admin/spec', { cookie: ADMIN_COOKIE_NAME + '=' + (await adminCookieValue(TOKEN)) }),
    { ADMIN_TOKEN: TOKEN },
    { surface: 'page' },
  )).ok === true);
check('agent-runner.js never reads a cookie itself — cookie handling lives only in admin-gate.js',
  !/headers\.get\(['"]Cookie['"]\)/i.test(runner) && !/\breadCookie\s*\(/.test(runner),
  'a second cookie reader in the router is a second place the credential rule can drift');
check('the cookie name appears in agent-runner.js nowhere at all',
  !runner.includes(ADMIN_COOKIE_NAME),
  'the router should know the gate, not the credential format');
check('the cookie is scoped to /admin so the browser never sends it to /api',
  adminSessionSetCookie('x').includes('Path=/admin'));
check('the cookie is HttpOnly, Secure and SameSite=Strict',
  /HttpOnly/.test(adminSessionSetCookie('x'))
  && /Secure/.test(adminSessionSetCookie('x'))
  && /SameSite=Strict/.test(adminSessionSetCookie('x')));
check('the cookie value is not the token',
  GOOD_COOKIE !== TOKEN && GOOD_COOKIE.length === 64 && /^[0-9a-f]+$/.test(GOOD_COOKIE));

/* ═══════════════════ 5. WHAT THE REFUSAL LOOKS LIKE ══════════════════════ */

console.log('\n--- 5. the refusal is a 401 a machine and a human can both use ---');

const htmlRefusal = adminUnauthorizedResponse(req('/admin/spec'), '/admin/spec');
const jsonRefusal = adminUnauthorizedResponse(req('/admin/spec', { accept: 'application/json' }), '/admin/spec');

check('a browser gets 401, not 200 and not 404', htmlRefusal.status === 401);
check('a machine gets 401 too', jsonRefusal.status === 401);
check('a machine gets JSON, not 6KB of unlock page',
  jsonRefusal.headers.get('Content-Type').includes('application/json'));
check('a browser gets HTML it can act on',
  htmlRefusal.headers.get('Content-Type').includes('text/html'));
check('the refusal is visible in a HEADER, not only in the body',
  htmlRefusal.headers.get('X-Admin-Gate') === 'refused');
check('the first line of the body says what happened',
  (await htmlRefusal.clone().text()).split('\n')[0].includes('401 unauthorized'));
check('the unlock page is never cached',
  htmlRefusal.headers.get('Cache-Control') === 'no-store');
check('the unlock page asks robots not to index it',
  /noindex/.test(renderAdminUnlockPage({ pathname: '/admin/spec' })));
check('the unlock page carries no token of its own',
  !renderAdminUnlockPage({ pathname: '/admin/spec' }).includes(TOKEN));
check('the unlock page returns the visitor to the path they asked for',
  renderAdminUnlockPage({ pathname: '/admin/spec' }).includes('"/admin/spec"'));
check('the unlock page writes BOTH sessionStorage keys the two admin pages use',
  /office\.token/.test(renderAdminUnlockPage({}))
  && /office-admin-token/.test(renderAdminUnlockPage({})));

/* ═══════════════════════ 6. FAIL CLOSED ══════════════════════════════════ */

console.log('\n--- 6. fail closed ---');
check('no ADMIN_TOKEN configured means NOBODY is authorized, not everybody',
  (await adminPageAuthorized(req('/admin/spec', { token: 'anything' }), { ADMIN_TOKEN: '' })) === false);
check('an empty env is refused rather than throwing',
  (await adminPageAuthorized(req('/admin/spec'), {})) === false);
check('readCookie returns a string for an absent cookie, never undefined',
  readCookie('', 'x') === '' && readCookie('a=1', 'x') === '');

/* ═══ 7. /admin/api — THE ADMIN PAGES' CALLS, INSIDE ACCESS'S PATH SCOPE ══
 *
 * Added 2026-08-25 (Session 21). The owner signed in with Google, the page
 * loaded, and the page then asked him for a token. The cause was not the
 * server's acceptance of an assertion — that has been correct since Session 18
 * — it was that the page's own `fetch('/api/admin')` left the Access
 * application's path scope, so Cloudflare attached no assertion to it and the
 * correct check was never reached with a credential.
 *
 * What must hold for the alias that fixes it:
 *   1. it maps exactly the four routes the admin pages call, and nothing else;
 *   2. it CANNOT be used to reach anything else — `/api/agents/trigger` above
 *      all, which fires office runs and is the one endpoint an ambient
 *      credential must never be able to steer;
 *   3. it is a rewrite that happens BEFORE both gates, so an aliased request is
 *      authenticated by the check its canonical path always had — never by the
 *      page gate, which accepts the admin cookie.
 */

console.log('\n--- 7. the admin API alias ---');

check('the prefix is under /admin, which is what makes Access cover it',
  ADMIN_API_PREFIX.startsWith('/admin/') && isAdminPagePath(ADMIN_API_PREFIX));
check('the four routes the admin pages call all resolve',
  canonicalAdminApiPath('/admin/api/data') === '/api/admin'
  && canonicalAdminApiPath('/admin/api/agents/owner-state') === '/api/agents/owner-state'
  && canonicalAdminApiPath('/admin/api/agents/owner-message') === '/api/agents/owner-message'
  && canonicalAdminApiPath('/admin/api/spec/build') === '/api/spec/build');
check('THE ONE THAT MATTERS — the alias cannot reach /api/agents/trigger',
  canonicalAdminApiPath('/admin/api/agents/trigger') === null,
  'an ambient credential that could fire an office run is the thing this map exists to make impossible');
check('...nor anything else under /api/agents/',
  ['trigger', 'status', 'reports', 'suggestions', 'state', 'sync_agents']
    .every((r) => canonicalAdminApiPath('/admin/api/agents/' + r) === null));
check('it does not concatenate — traversal, encoded or plain, resolves to nothing',
  canonicalAdminApiPath('/admin/api/../api/agents/trigger') === null
  && canonicalAdminApiPath('/admin/api/%2e%2e/agents/trigger') === null
  && canonicalAdminApiPath('/admin/api/') === null
  && canonicalAdminApiPath('') === null);
check('a path outside the prefix is left alone',
  canonicalAdminApiPath('/api/admin') === null
  && canonicalAdminApiPath('/admin/spec') === null
  && canonicalAdminApiPath('/adminapi/data') === null);

const rewriteAt = runner.indexOf('canonicalAdminApiPath(url.pathname)');
const apiGateAt = runner.indexOf('AUTHENTICATED_PREFIXES.some(');
const pageGateAt = runner.indexOf('if (isAdminPagePath(url.pathname)');
check('the rewrite is wired into agent-runner.js', rewriteAt !== -1);
check('it runs BEFORE the API gate, so an aliased call is authenticated as its canonical path',
  rewriteAt !== -1 && apiGateAt !== -1 && rewriteAt < apiGateAt,
  `rewrite at ${rewriteAt}, API gate at ${apiGateAt}`);
check('it runs BEFORE the page gate, so an aliased call never rides the admin COOKIE',
  rewriteAt !== -1 && pageGateAt !== -1 && rewriteAt < pageGateAt,
  `rewrite at ${rewriteAt}, page gate at ${pageGateAt}`);
check('the aliased canonical paths are all covered by AUTHENTICATED_PREFIXES or are the open builder',
  /const AUTHENTICATED_PREFIXES = \['\/api\/agents\/', '\/api\/admin'\]/.test(runner),
  'the prefix list is unchanged — the alias adds no route to it and removes none');

/* ═══════════════════════════ RESULT ══════════════════════════════════════ */

console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('/admin is shut in code, on every hostname the Worker answers on.');
