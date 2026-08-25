#!/usr/bin/env node
/**
 * scripts/verify-access-jwt.js — does the Access credential actually check?
 *
 * Written 2026-08-25 (Session 18, Item A). Run:  node scripts/verify-access-jwt.js
 *
 * -- WHY THIS FILE MINTS REAL TOKENS -------------------------------------
 *
 * The failure this verifier exists to make impossible is the cheap version of
 * the feature: **checking that the header is present.** Anyone can send a
 * header. On `*.workers.dev` — the hostname no Access policy can ever cover —
 * nothing strips `Cf-Access-Jwt-Assertion`, so a gate that trusted its presence
 * would have opened the admin surface to a one-line curl.
 *
 * So this file does not assert. It GENERATES an RSA key pair, mints real RS256
 * tokens with it, serves the matching JWKS through an injected fetch, and
 * watches the real verifier accept the good one and refuse:
 *
 *   * a token for a DIFFERENT audience   (the mistake with the worst blast
 *                                         radius — another Access application's
 *                                         policy would become this door's)
 *   * a token from a DIFFERENT issuer
 *   * an EXPIRED token
 *   * a token whose payload was edited after signing
 *   * a token signed by a key the team does not publish
 *   * `alg: none`, and an unsigned token
 *   * everything, when the Worker has no Access configuration at all
 *
 * back-office `CLAUDE.md`: *a test that describes a fix is not a test that
 * catches a bug.* Section 6 is the closest equivalent available here — it runs
 * the scenario table against a transcription of the CHEAP verifier (does the
 * header exist?) and requires that the dangerous scenarios pass there. A
 * scenario table that the naive implementation also survives is documentation.
 *
 * NETWORK: zero calls. The JWKS is served from memory through an injected
 * fetch, so `globalThis.fetch` stays a tripwire.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

import {
  ACCESS_JWT_HEADER, ACCESS_JWT_ALG, JWKS_CACHE_TTL_MS,
  normalizeTeamDomain, accessIssuer, accessCertsUrl, accessConfig,
  decodeJwtParts, validateAccessClaims, fetchAccessKeys, verifyAccessJwt,
  accessCredential, accessKeyCacheState, __resetAccessKeyCache,
} from '../workers/access-jwt.js';
import { adminCredential, adminCookieValue } from '../workers/admin-gate.js';

const here = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(here, '..', 'workers', 'agent-runner.js'), 'utf8');
const gate = readFileSync(join(here, '..', 'workers', 'admin-gate.js'), 'utf8');
const wranglerToml = readFileSync(join(here, '..', 'wrangler.toml'), 'utf8');

const subtle = webcrypto.subtle;

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ══════════════════ 0. a real key pair, a real JWKS ═══════════════════════ */

const TEAM = 'office-verifier.cloudflareaccess.com';
const ISSUER = 'https://' + TEAM;
const AUD = 'a'.repeat(64);
const OTHER_AUD = 'b'.repeat(64);
const KID = 'verifier-key-1';
const OTHER_KID = 'verifier-key-2';

async function makeKeyPair() {
  return webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

const good = await makeKeyPair();
const rogue = await makeKeyPair();

async function jwkFor(keyPair, kid) {
  const jwk = await subtle.exportKey('jwk', keyPair.publicKey);
  return { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: ACCESS_JWT_ALG, use: 'sig', kid };
}

const JWKS = { keys: [await jwkFor(good, KID)] };

/** The certs endpoint, in memory. Counts its calls so the cache can be proved. */
let certFetches = 0;
function fetchImpl(url) {
  certFetches += 1;
  if (url !== accessCertsUrl(TEAM)) {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => JWKS });
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

const NOW = 1_800_000_000; // fixed clock — the verifier makes no clock call

async function mint({
  keyPair = good, kid = KID, iss = ISSUER, aud = AUD,
  exp = NOW + 3600, iat = NOW - 10, nbf = null, email = 'avivnofar@gmail.com',
  alg = ACCESS_JWT_ALG, sign = true, tamper = null,
} = {}) {
  const header = { alg, kid, typ: 'JWT' };
  const payload = { iss, aud, exp, iat, email, sub: 'verifier-subject', type: 'app' };
  if (nbf !== null) payload.nbf = nbf;
  const headerPart = b64urlJson(header);
  const payloadPart = b64urlJson(payload);
  const signingInput = headerPart + '.' + payloadPart;
  let sig = '';
  if (sign) {
    const raw = await subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(signingInput));
    sig = b64url(new Uint8Array(raw));
  }
  if (!tamper) return signingInput + '.' + sig;
  // Re-write the payload AFTER signing — the signature stays, the claims move.
  return headerPart + '.' + b64urlJson(Object.assign({}, payload, tamper)) + '.' + sig;
}

const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const OPTS = { teamDomain: TEAM, aud: AUD, fetchImpl, nowSeconds: NOW, subtle };

async function verdict(token, opts = {}) {
  return verifyAccessJwt(token, Object.assign({}, OPTS, opts));
}

/* ═══════════════════ 1. configuration, and fail-closed ═══════════════════ */

console.log('\n--- 1. configuration ---');

check('a bare team name normalises to the cloudflareaccess.com host',
  normalizeTeamDomain('myteam') === 'myteam.cloudflareaccess.com');
check('a full URL and a trailing slash normalise to the same host',
  normalizeTeamDomain('https://myteam.cloudflareaccess.com/') === 'myteam.cloudflareaccess.com');
check('a foreign host is refused, not accepted as a team domain',
  normalizeTeamDomain('evil.example.com') === null);
check('an empty ACCESS_TEAM_DOMAIN is null, never a default',
  normalizeTeamDomain('') === null && normalizeTeamDomain(undefined) === null);
check('the issuer is built from the normalised host',
  accessIssuer('myteam') === 'https://myteam.cloudflareaccess.com');
check('the certs URL is the team domain\'s own /cdn-cgi/access/certs',
  accessCertsUrl('myteam') === 'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs');

check('an unset environment is NOT configured, and says which value is missing',
  accessConfig({}).configured === false && accessConfig({}).missing.length === 2);
check('a set team domain with no AUD is still NOT configured',
  accessConfig({ ACCESS_TEAM_DOMAIN: TEAM }).configured === false);
check('a truncated AUD is refused rather than half-accepted',
  accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'abc123' }).configured === false);
check('an AUD with non-hex characters is refused',
  accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'z'.repeat(64) }).configured === false);
check('both values present and well-formed IS configured',
  accessConfig(ENV).configured === true && accessConfig(ENV).aud === AUD);
check('an unconfigured Worker exposes no audience to compare against',
  accessConfig({ ACCESS_TEAM_DOMAIN: TEAM }).aud === null);

/* ═════════════════════ 2. the good token, and only it ════════════════════ */

console.log('\n--- 2. a real signed token ---');
__resetAccessKeyCache();
certFetches = 0;

const goodToken = await mint();
const goodVerdict = await verdict(goodToken);
check('a correctly signed token for this audience and issuer is ACCEPTED',
  goodVerdict.ok === true, goodVerdict.reason || '');
check('the accepted token yields the identity the provider asserted',
  goodVerdict.email === 'avivnofar@gmail.com');
check('the accepted token carries its claims back to the caller',
  goodVerdict.claims && goodVerdict.claims.iss === ISSUER);

/* ══════════════ 3. every way a token can be wrong is REFUSED ═════════════ */

console.log('\n--- 3. refusals ---');

const wrongAud = await verdict(await mint({ aud: OTHER_AUD }));
check('a token minted for a DIFFERENT Access application is refused',
  wrongAud.ok === false && /audience/.test(wrongAud.reason));

const wrongIss = await verdict(await mint({ iss: 'https://someone-else.cloudflareaccess.com' }));
check('a token from a different team (issuer) is refused',
  wrongIss.ok === false && /issuer/.test(wrongIss.reason));

const expired = await verdict(await mint({ exp: NOW - 3600 }));
check('an expired token is refused', expired.ok === false && /expired/.test(expired.reason));

const noExp = await verdict(await mint({ exp: null }));
check('a token with no exp claim is refused, not treated as eternal',
  noExp.ok === false && /exp/.test(noExp.reason));

const future = await verdict(await mint({ nbf: NOW + 3600 }));
check('a not-yet-valid token (nbf in the future) is refused', future.ok === false);

const tampered = await verdict(await mint({ tamper: { aud: AUD, email: 'attacker@example.com', exp: NOW + 999999 } }));
check('a token whose payload was edited after signing is refused',
  tampered.ok === false && /signature/.test(tampered.reason));

const rogueSigned = await verdict(await mint({ keyPair: rogue }));
check('a token signed by a key the team does not publish is refused',
  rogueSigned.ok === false);

const unknownKid = await verdict(await mint({ kid: OTHER_KID }));
check('a token naming a kid the JWKS does not carry is refused',
  unknownKid.ok === false && /does not publish/.test(unknownKid.reason));

const algNone = await verdict(await mint({ alg: 'none', sign: false }));
check('alg: none is refused by name, before any key is fetched',
  algNone.ok === false && /alg/.test(algNone.reason));

const hs256 = await verdict(await mint({ alg: 'HS256' }));
check('an HS256 header is refused — the key-confusion family never runs',
  hs256.ok === false && /alg/.test(hs256.reason));

const unsigned = await verdict(await mint({ sign: true, tamper: null }).then((t) => t.split('.').slice(0, 2).join('.') + '.'));
check('a token with an empty signature is refused', unsigned.ok === false);

check('a garbage string is refused without throwing',
  (await verdict('not-a-jwt')).ok === false);
check('an empty assertion is refused', (await verdict('')).ok === false);

/* ═══════════════ 4. unconfigured accepts NOTHING (fail closed) ═══════════ */

console.log('\n--- 4. unconfigured means inert, never open ---');

const noConfig = await verifyAccessJwt(goodToken, { fetchImpl, nowSeconds: NOW, subtle });
check('with no team domain and no AUD, even a genuine token is refused',
  noConfig.ok === false && /not configured/.test(noConfig.reason));

const audOnly = await verifyAccessJwt(goodToken, { teamDomain: TEAM, fetchImpl, nowSeconds: NOW, subtle });
check('a team domain with no audience configured accepts nothing',
  audOnly.ok === false);

const credNoConfig = await accessCredential(
  { headers: new Map([[ACCESS_JWT_HEADER, goodToken]]) }, {}, { fetchImpl, nowSeconds: NOW, subtle });
check('accessCredential on an unconfigured Worker reports NOT CONFIGURED, not a bad token',
  credNoConfig.ok === false && credNoConfig.configured === false);

/* ══════════════════ 5. the credential helper on a Request ════════════════ */

console.log('\n--- 5. the request-shaped helper ---');

function req(headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => map.get(String(name).toLowerCase()) || null } };
}

const credGood = await accessCredential(req({ [ACCESS_JWT_HEADER]: goodToken }), ENV, { fetchImpl, nowSeconds: NOW, subtle });
check('a request carrying a valid assertion is accepted and names the identity',
  credGood.ok === true && credGood.email === 'avivnofar@gmail.com', credGood.reason || '');

const credNone = await accessCredential(req({}), ENV, { fetchImpl, nowSeconds: NOW, subtle });
check('a request with no assertion is refused and says so — presented:false',
  credNone.ok === false && credNone.presented === false && credNone.configured === true);

const credForged = await accessCredential(req({ [ACCESS_JWT_HEADER]: 'anything-at-all' }), ENV, { fetchImpl, nowSeconds: NOW, subtle });
check('A HEADER TYPED BY HAND IS REFUSED — this is the whole point of the file',
  credForged.ok === false && credForged.presented === true);

/* ═════════ 6. against the CHEAP implementation, these MUST pass ══════════ */

console.log('\n--- 6. the naive check the estate must not ship ---');

/** What "wire up Access" looks like when it is done in one line. */
function naiveHeaderCheck(request) {
  return !!(request.headers.get(ACCESS_JWT_HEADER) || '');
}

const dangerous = [
  ['a hand-typed header', req({ [ACCESS_JWT_HEADER]: 'anything-at-all' })],
  ['a token for another application', req({ [ACCESS_JWT_HEADER]: await mint({ aud: OTHER_AUD }) })],
  ['an expired token', req({ [ACCESS_JWT_HEADER]: await mint({ exp: NOW - 3600 }) })],
  ['a token signed by a rogue key', req({ [ACCESS_JWT_HEADER]: await mint({ keyPair: rogue }) })],
];
for (const [label, request] of dangerous) {
  const naive = naiveHeaderCheck(request);
  const real = await accessCredential(request, ENV, { fetchImpl, nowSeconds: NOW, subtle });
  check(`${label}: the naive check ACCEPTS it and this verifier REFUSES it`,
    naive === true && real.ok === false,
    `naive=${naive} real=${real.ok}`);
}

/* ═══════════════════════ 7. the key cache is real ════════════════════════ */

console.log('\n--- 7. the JWKS cache (a subrequest ceiling, not tidiness) ---');

__resetAccessKeyCache();
certFetches = 0;
await verdict(await mint());
const afterFirst = certFetches;
await verdict(await mint());
await verdict(await mint());
check('three verifications fetch the certs ONCE',
  afterFirst === 1 && certFetches === 1, `fetches=${certFetches}`);

check('the cache reports what it holds without exposing a key',
  accessKeyCacheState()[0].keys === 1 && !JSON.stringify(accessKeyCacheState()).includes(JWKS.keys[0].n));

const stale = await fetchAccessKeys(TEAM, { fetchImpl, nowMs: Date.now() + JWKS_CACHE_TTL_MS + 1000 });
check('past the TTL the keys are fetched again', stale.cached === false && certFetches === 2);

__resetAccessKeyCache();
certFetches = 0;
const deadEndpoint = await verifyAccessJwt(await mint(), {
  teamDomain: TEAM, aud: AUD, nowSeconds: NOW, subtle,
  fetchImpl: () => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }),
});
check('an unreachable certs endpoint REFUSES the request rather than allowing it',
  deadEndpoint.ok === false && /HTTP 503/.test(deadEndpoint.reason));

/* ═════════════════ 8. the gate actually routes through it ════════════════ */

console.log('\n--- 8. wiring (section 7 of ARCHITECTURAL-DECISIONS.md) ---');

check('admin-gate.js imports the Access credential',
  /import\s*\{[^}]*accessCredential[^}]*\}\s*from\s*'\.\/access-jwt\.js'/.test(gate));
check('the admin gate tries the Access credential BEFORE the admin token',
  gate.indexOf('accessCredential(') !== -1
  && gate.indexOf('accessCredential(') < gate.indexOf("request.headers.get('X-Admin-Token')"));
check('agent-runner.js routes the API gate through the shared credential resolver',
  /adminCredential\(/.test(runner));
check('the API gate no longer decides on the raw token comparison alone',
  !/const token = request\.headers\.get\('X-Admin-Token'\) \|\| '';\s*\n\s*if \(!env\.ADMIN_TOKEN \|\| token !== env\.ADMIN_TOKEN\)/.test(runner));
check('the Worker declares both Access vars in wrangler.toml',
  /ACCESS_TEAM_DOMAIN/.test(wranglerToml) && /ACCESS_AUD/.test(wranglerToml));
check('the shipped Access vars are EMPTY until the owner fills them in',
  /ACCESS_TEAM_DOMAIN\s*=\s*""/.test(wranglerToml) && /ACCESS_AUD\s*=\s*""/.test(wranglerToml));

/* ══════ 9. the gate itself: order, the CSRF rule, nothing removed ════════ */

console.log('\n--- 9. the gate, exercised ---');

const TOKEN = 'session-18-verifier-token';
const GATE_ENV = { ADMIN_TOKEN: TOKEN, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const gateOpts = { accessOpts: { fetchImpl, nowSeconds: NOW, subtle } };

function gateReq(method, headers = {}, url = 'https://office.avivnofar.com/api/admin') {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, url, headers: { get: (n) => map.get(String(n).toLowerCase()) || null } };
}

const viaAccess = await adminCredential(
  gateReq('GET', { [ACCESS_JWT_HEADER]: goodToken }), GATE_ENV, { surface: 'api', ...gateOpts });
check('a signed-in GET is authorized BY THE ACCESS ASSERTION, with no token present',
  viaAccess.ok === true && viaAccess.via === 'access-jwt', viaAccess.reason || '');

const viaToken = await adminCredential(
  gateReq('GET', { 'X-Admin-Token': TOKEN }), GATE_ENV, { surface: 'api', ...gateOpts });
check('the admin token still authorizes on its own — nothing was replaced',
  viaToken.ok === true && viaToken.via === 'admin-token');

const neither = await adminCredential(gateReq('GET'), GATE_ENV, { surface: 'api', ...gateOpts });
check('neither credential is still a refusal', neither.ok === false);

const forgedHeader = await adminCredential(
  gateReq('GET', { [ACCESS_JWT_HEADER]: 'typed-by-hand' }), GATE_ENV, { surface: 'api', ...gateOpts });
check('a forged assertion does NOT authorize, even with Access configured',
  forgedHeader.ok === false);

// THE CSRF RULE. The assertion is ambient; the cookie was kept off the API for
// exactly this reason, and letting the assertion in without this check would
// have handed that property straight back.
const crossSitePost = await adminCredential(
  gateReq('POST', { [ACCESS_JWT_HEADER]: goodToken, 'Sec-Fetch-Site': 'cross-site' }), GATE_ENV, { surface: 'api', ...gateOpts });
check('a CROSS-SITE POST carrying a valid assertion is REFUSED',
  crossSitePost.ok === false && /this site made/.test(crossSitePost.reason));

const sameSitePost = await adminCredential(
  gateReq('POST', { [ACCESS_JWT_HEADER]: goodToken, 'Sec-Fetch-Site': 'same-origin' }), GATE_ENV, { surface: 'api', ...gateOpts });
check('a SAME-ORIGIN POST carrying the same assertion is allowed',
  sameSitePost.ok === true && sameSitePost.via === 'access-jwt');

const noFetchMetadataPost = await adminCredential(
  gateReq('POST', { [ACCESS_JWT_HEADER]: goodToken }), GATE_ENV, { surface: 'api', ...gateOpts });
check('a POST with NEITHER Sec-Fetch-Site nor Origin is refused on the Access path',
  noFetchMetadataPost.ok === false);

const originMatchPost = await adminCredential(
  gateReq('POST', { [ACCESS_JWT_HEADER]: goodToken, Origin: 'https://office.avivnofar.com' }), GATE_ENV, { surface: 'api', ...gateOpts });
check('an Origin matching the request host is accepted where Sec-Fetch-Site is absent',
  originMatchPost.ok === true);

const foreignOriginPost = await adminCredential(
  gateReq('POST', { [ACCESS_JWT_HEADER]: goodToken, Origin: 'https://evil.example.com' }), GATE_ENV, { surface: 'api', ...gateOpts });
check('a foreign Origin is refused', foreignOriginPost.ok === false);

// A POST carrying the TOKEN is unaffected by any of the above: it is not
// ambient, so no browser can attach it cross-site.
const tokenPost = await adminCredential(
  gateReq('POST', { 'X-Admin-Token': TOKEN, 'Sec-Fetch-Site': 'cross-site' }), GATE_ENV, { surface: 'api', ...gateOpts });
check('the token path is NOT subject to the same-origin rule — it is not ambient',
  tokenPost.ok === true && tokenPost.via === 'admin-token');

// The cookie boundary, unchanged since the day it was introduced.
const cookieValue = await adminCookieValue(TOKEN);
const cookieOnPage = await adminCredential(
  gateReq('GET', { Cookie: `office_admin=${cookieValue}` }, 'https://office.avivnofar.com/admin/spec'),
  GATE_ENV, { surface: 'page', ...gateOpts });
check('the derived cookie still opens an admin PAGE', cookieOnPage.ok === true && cookieOnPage.via === 'admin-cookie');
const cookieOnApi = await adminCredential(
  gateReq('GET', { Cookie: `office_admin=${cookieValue}` }), GATE_ENV, { surface: 'api', ...gateOpts });
check('the derived cookie STILL does not open the API', cookieOnApi.ok === false);

const noAdminToken = await adminCredential(
  gateReq('GET', { 'X-Admin-Token': TOKEN }), { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { surface: 'api', ...gateOpts });
check('no ADMIN_TOKEN configured still means NOBODY, even with Access configured',
  noAdminToken.ok === false);

check('the admin token and cookie are both still named in the gate',
  /X-Admin-Token/.test(gate) && /adminCookieValue/.test(gate));

/* ═════════════════════════════ RESULT ════════════════════════════════════ */

console.log(`\n=== ${pass} passed, ${fails.length} failed ===`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('The Access credential is verified, not asserted: signature, audience, issuer, expiry.');
