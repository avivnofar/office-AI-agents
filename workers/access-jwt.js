/**
 * workers/access-jwt.js — Cloudflare Access as a SECOND accepted credential.
 *
 * Written 2026-08-25 (Session 18, Item A). The office's admin surface has
 * worked since Session 17 and it has been wrong about one thing the whole
 * time: the owner is shown a PASTE-A-TOKEN prompt at his own front door. The
 * protection that was designed was Cloudflare Access with Google sign-in; the
 * token gate was built because an Access policy binds ONE HOSTNAME and
 * `workers_dev = true` is load-bearing, so a policy on `office.avivnofar.com`
 * could never have covered `data-center-agents.avivnofar.workers.dev`.
 *
 * **The token gate was the correct second layer. It became the first layer by
 * accident.** This file does not remove it. It adds the credential that was
 * supposed to be first:
 *
 *   through office.avivnofar.com, after Google sign-in -> valid JWT, allowed
 *   through *.workers.dev                              -> no JWT, the token
 *                                                         gate answers, as now
 *   neither                                            -> 401, as now
 *
 * -- WHY THE HEADER IS NOT THE CHECK -------------------------------------
 *
 * `Cf-Access-Jwt-Assertion` is set by Cloudflare in front of the Worker. It is
 * ALSO a header any client can type. On `*.workers.dev` — the hostname no
 * Access policy can cover — nothing strips it, so a request that merely
 * CARRIES the header proves nothing whatsoever. What proves something is the
 * signature over it, checked against the account's own public keys, for the
 * audience of THIS application.
 *
 * Four checks, and all four are load-bearing:
 *
 *   signature  RS256 against the JWKS at the team domain's
 *              `/cdn-cgi/access/certs`. Without it the token is a text field.
 *   audience   the AUD tag of this Access application. **A JWT check with the
 *              wrong audience accepts tokens minted for a DIFFERENT
 *              application** — including one with a laxer policy. This is why
 *              neither value below is guessed or defaulted.
 *   issuer     the team domain. A valid token from someone else's team is a
 *              valid token.
 *   expiry     Access tokens are short-lived; that is most of their value.
 *
 * -- FAIL CLOSED, AND UNCONFIGURED IS A REFUSAL, NOT A BYPASS ------------
 *
 * `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are read from the environment and
 * NEVER defaulted. Unset means this credential is INERT: verification refuses
 * everything and the admin gate falls through to the token exactly as it did
 * before this file existed. The estate's section 7 failure shape is *the guard
 * exists and the calling path never reaches it*; the inverse — a credential
 * path that starts accepting things because a config value is missing — is the
 * same mistake pointed the other way, and it is the one that would matter here.
 *
 * -- THE KEYS ARE CACHED, AND THAT IS A BUDGET DECISION ------------------
 *
 * This Worker runs against a 50-subrequest-per-invocation ceiling and has
 * already had scheduled blocks refused for crossing it (see
 * config/daily-schedule.json's OB-074 notes). Fetching the JWKS on every
 * request would put a subrequest in front of every admin page load. The keys
 * are cached in module scope for an hour, per team domain.
 *
 * In-memory rather than KV, deliberately: a KV read is itself a subrequest, so
 * caching in KV would spend the thing the cache exists to save. The cost of
 * the in-memory choice is stated rather than hidden — each isolate fetches
 * once, so a Worker spread across several isolates fetches several times an
 * hour. That is a handful of requests a day against Cloudflare's own endpoint.
 *
 * -- IMPORTS NOTHING -----------------------------------------------------
 *
 * The rule `owner-channel.js`, `owner-notify.js`, `site-data.js` and
 * `office-policy.js` keep, for the reason they keep it: plain `node` loads
 * this file and `scripts/verify-access-jwt.js` CALLS it — it mints real RS256
 * tokens against a generated key pair and watches the real verifier refuse a
 * wrong audience, a wrong issuer, an expired token and a tampered signature.
 * `fetch` and the clock are injected so the verifier needs no network and
 * `globalThis.fetch` stays a tripwire.
 */

/** The header Cloudflare Access attaches in front of the Worker. */
export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

/** The cookie Access sets. Read for DIAGNOSTICS ONLY — never as a credential:
 *  it is opaque to the Worker and carries no signature this side can check. */
export const ACCESS_COOKIE_NAME = 'CF_Authorization';

/** One hour. Cloudflare rotates these keys on a much longer cycle, and an hour
 *  bounds how long a rotated-out key could still be honoured here. */
export const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

/** Clock skew tolerated on exp/nbf/iat. Sixty seconds is the usual allowance
 *  for two machines that are both trying to be right. */
export const CLOCK_SKEW_SECONDS = 60;

/** The only algorithm accepted. Named as a constant so `alg: "none"` and the
 *  HMAC-confusion family are refused by a comparison rather than by hope. */
export const ACCESS_JWT_ALG = 'RS256';

/**
 * `myteam`, `myteam.cloudflareaccess.com`, `https://myteam.cloudflareaccess.com`
 * and a trailing slash all name the same team. Normalised to the bare host so
 * the issuer this file builds is byte-identical whichever form the config uses.
 *
 * Returns null for anything that is not a plausible team domain — including
 * the empty string, which is what an unset var looks like.
 */
export function normalizeTeamDomain(raw) {
  let v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (v.includes('/')) return null;
  if (!v.includes('.')) v = v + '.cloudflareaccess.com';
  if (!/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(v)) return null;
  return v;
}

/** The `iss` claim Access mints. */
export function accessIssuer(teamDomain) {
  const host = normalizeTeamDomain(teamDomain);
  return host ? 'https://' + host : null;
}

/** Where the account's public keys live. */
export function accessCertsUrl(teamDomain) {
  const host = normalizeTeamDomain(teamDomain);
  return host ? 'https://' + host + '/cdn-cgi/access/certs' : null;
}

/**
 * What the environment says about Access, and what it fails to say.
 *
 * `missing` is the product here. A gate that is inert because a value was
 * never set looks exactly like a gate that is inert because it is broken, and
 * this estate has spent six recorded incidents on that distinction — so the
 * reason is carried out of this function rather than inferred from a false.
 */
export function accessConfig(env) {
  const teamDomain = normalizeTeamDomain(env && env.ACCESS_TEAM_DOMAIN);
  const aud = String((env && env.ACCESS_AUD) || '').trim();
  const missing = [];
  if (!teamDomain) {
    missing.push(env && env.ACCESS_TEAM_DOMAIN
      ? 'ACCESS_TEAM_DOMAIN is set but is not a <team>.cloudflareaccess.com host'
      : 'ACCESS_TEAM_DOMAIN is not set');
  }
  // Access AUD tags are 64 hex characters. Checked rather than assumed,
  // because a truncated paste is the failure that would accept nothing while
  // looking configured.
  if (!/^[0-9a-f]{64}$/.test(aud)) {
    missing.push(aud ? 'ACCESS_AUD is set but is not a 64-character hex AUD tag' : 'ACCESS_AUD is not set');
  }
  return {
    configured: missing.length === 0,
    teamDomain,
    aud: missing.length === 0 ? aud : null,
    issuer: accessIssuer(teamDomain),
    certsUrl: accessCertsUrl(teamDomain),
    missing,
  };
}

/* ------------------------------- decoding -------------------------------- */

/** base64url -> bytes. No dependency, and it refuses rather than throwing on
 *  input that is not base64url at all. */
export function base64UrlToBytes(part) {
  const s = String(part || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch (err) {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlToJson(part) {
  const bytes = base64UrlToBytes(part);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return null;
  }
}

/**
 * Splits a compact JWS. **Decoding is not verifying** — nothing this function
 * returns has been checked against a key, and every caller in this file treats
 * it that way.
 */
export function decodeJwtParts(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a three-part compact JWT' };
  const header = base64UrlToJson(parts[0]);
  const payload = base64UrlToJson(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  if (!header) return { ok: false, reason: 'header is not base64url JSON' };
  if (!payload) return { ok: false, reason: 'payload is not base64url JSON' };
  if (!signature) return { ok: false, reason: 'signature is not base64url' };
  return {
    ok: true,
    header,
    payload,
    signature,
    signingInput: parts[0] + '.' + parts[1],
  };
}

/**
 * Issuer, audience, expiry — the three claims that decide whether a
 * cryptographically valid token was minted for THIS door.
 *
 * The audience check is why this function exists as its own exported unit: a
 * token signed by the right team for a DIFFERENT Access application is a
 * perfectly valid token, and accepting it would mean the office's admin
 * surface inherits the policy of whatever other application the owner ever
 * creates. `aud` may be a string or an array; both shapes are Access's.
 */
export function validateAccessClaims(payload, { issuer, aud, nowSeconds = null, skew = CLOCK_SKEW_SECONDS } = {}) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'no claims' };
  if (!issuer) return { ok: false, reason: 'no issuer configured to compare against' };
  if (!aud) return { ok: false, reason: 'no audience configured to compare against' };

  if (payload.iss !== issuer) {
    return { ok: false, reason: 'issuer mismatch — the token says ' + JSON.stringify(payload.iss || null) };
  }

  const audience = Array.isArray(payload.aud) ? payload.aud : (payload.aud ? [payload.aud] : []);
  if (!audience.includes(aud)) {
    return { ok: false, reason: 'audience mismatch — this token was minted for a different Access application' };
  }

  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'no exp claim — a token with no expiry is not one Access mints' };
  if (exp + skew < now) return { ok: false, reason: 'token expired' };

  const nbf = Number(payload.nbf);
  if (Number.isFinite(nbf) && nbf - skew > now) return { ok: false, reason: 'token is not valid yet (nbf)' };

  const iat = Number(payload.iat);
  if (Number.isFinite(iat) && iat - skew > now) return { ok: false, reason: 'token was issued in the future (iat)' };

  return { ok: true, reason: null };
}

/* ----------------------------- the key cache ----------------------------- */

/**
 * Module scope, keyed by team domain. Reset between isolates, which is fine:
 * the cost of a cold isolate is one fetch.
 *
 * `__resetAccessKeyCache()` exists for the verifier and for nothing else — a
 * cache with no way to clear it is a test that cannot prove the TTL works.
 */
const KEY_CACHE = new Map();

export function __resetAccessKeyCache() {
  KEY_CACHE.clear();
}

/** What the cache is holding, for the diagnostics endpoint. Never the keys. */
export function accessKeyCacheState(nowMs = Date.now()) {
  const out = [];
  for (const [domain, entry] of KEY_CACHE) {
    out.push({
      team_domain: domain,
      keys: entry.keys.length,
      age_seconds: Math.max(0, Math.round((nowMs - entry.fetchedAt) / 1000)),
      expires_in_seconds: Math.max(0, Math.round((entry.fetchedAt + JWKS_CACHE_TTL_MS - nowMs) / 1000)),
    });
  }
  return out;
}

/**
 * The account's public keys, cached for an hour per team domain.
 *
 * A FETCH FAILURE DOES NOT POISON THE CACHE and does not clear it. If the keys
 * cannot be re-fetched, the last good set keeps working until its hour is up
 * and then this returns an error — which the caller turns into a refusal, not
 * into an acceptance.
 */
export async function fetchAccessKeys(teamDomain, { fetchImpl = null, nowMs = Date.now(), ttlMs = JWKS_CACHE_TTL_MS } = {}) {
  const host = normalizeTeamDomain(teamDomain);
  if (!host) return { ok: false, reason: 'no team domain', keys: [] };

  const cached = KEY_CACHE.get(host);
  if (cached && nowMs - cached.fetchedAt < ttlMs) {
    return { ok: true, keys: cached.keys, cached: true };
  }

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, reason: 'no fetch implementation available', keys: [] };

  let res;
  try {
    res = await doFetch(accessCertsUrl(host), { headers: { Accept: 'application/json' } });
  } catch (err) {
    return { ok: false, reason: 'could not reach the Access certs endpoint: ' + (err && err.message ? err.message : err), keys: [] };
  }
  if (!res || !res.ok) {
    return { ok: false, reason: 'the Access certs endpoint answered HTTP ' + (res ? res.status : 'nothing'), keys: [] };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, reason: 'the Access certs endpoint did not return JSON', keys: [] };
  }
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  if (!keys.length) return { ok: false, reason: 'the Access certs endpoint returned no keys', keys: [] };

  KEY_CACHE.set(host, { keys, fetchedAt: nowMs });
  return { ok: true, keys, cached: false };
}

/* ------------------------------ verification ----------------------------- */

/**
 * THE CHECK. Returns `{ ok, reason, claims, email }` and never throws.
 *
 * Order is deliberate: config, shape, algorithm, SIGNATURE, then claims. The
 * signature comes before the claims because until it passes, `payload` is a
 * string the caller's adversary wrote — reading an email out of it first and
 * checking the signature afterwards is how an unauthenticated identity ends up
 * in a log line that reads like an authenticated one.
 */
export async function verifyAccessJwt(token, {
  teamDomain = null, aud = null, fetchImpl = null, nowSeconds = null, nowMs = Date.now(),
  subtle = (globalThis.crypto && globalThis.crypto.subtle) || null,
} = {}) {
  const issuer = accessIssuer(teamDomain);
  if (!issuer || !aud) return { ok: false, reason: 'Access is not configured on this Worker', claims: null };
  if (!token) return { ok: false, reason: 'no Access assertion on the request', claims: null };
  if (!subtle) return { ok: false, reason: 'no WebCrypto available to check the signature', claims: null };

  const decoded = decodeJwtParts(token);
  if (!decoded.ok) return { ok: false, reason: decoded.reason, claims: null };

  if (decoded.header.alg !== ACCESS_JWT_ALG) {
    return {
      ok: false,
      reason: 'unexpected alg ' + JSON.stringify(decoded.header.alg || null) + ' — only ' + ACCESS_JWT_ALG + ' is accepted',
      claims: null,
    };
  }
  const kid = decoded.header.kid;
  if (!kid || typeof kid !== 'string') return { ok: false, reason: 'no kid in the token header', claims: null };

  const jwks = await fetchAccessKeys(teamDomain, { fetchImpl, nowMs });
  if (!jwks.ok) return { ok: false, reason: jwks.reason, claims: null };

  const jwk = jwks.keys.find((k) => k && k.kid === kid);
  if (!jwk) return { ok: false, reason: 'the token was signed by a key this team does not publish', claims: null };

  let key;
  try {
    key = await subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: ACCESS_JWT_ALG, ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch (err) {
    return { ok: false, reason: 'the published key could not be imported: ' + (err && err.message ? err.message : err), claims: null };
  }

  let valid = false;
  try {
    valid = await subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decoded.signature,
      new TextEncoder().encode(decoded.signingInput),
    );
  } catch (err) {
    return { ok: false, reason: 'signature check threw: ' + (err && err.message ? err.message : err), claims: null };
  }
  if (!valid) return { ok: false, reason: 'signature does not verify', claims: null };

  const claims = validateAccessClaims(decoded.payload, { issuer, aud, nowSeconds });
  if (!claims.ok) return { ok: false, reason: claims.reason, claims: null };

  return {
    ok: true,
    reason: null,
    claims: decoded.payload,
    // The identity, for logging and for the page to name him by. It is
    // whatever the identity provider asserted, and it is only ever read AFTER
    // the signature passed.
    email: typeof decoded.payload.email === 'string' ? decoded.payload.email : null,
  };
}

/**
 * The whole credential in one call: pull the header off the request, verify it.
 *
 * Returns `{ ok, configured, reason, email, presented }`. `configured` is
 * separate from `ok` on purpose — "Access is not set up on this Worker" and
 * "this token was refused" are different facts, and the report of an admin
 * refusal must be able to say which one it hit.
 */
export async function accessCredential(request, env, opts = {}) {
  const cfg = accessConfig(env);
  if (!cfg.configured) {
    return { ok: false, configured: false, reason: cfg.missing.join('; '), email: null, presented: false };
  }
  const token = request && request.headers && request.headers.get
    ? (request.headers.get(ACCESS_JWT_HEADER) || '')
    : '';
  if (!token) {
    return { ok: false, configured: true, reason: 'no Access assertion on the request', email: null, presented: false };
  }
  const verdict = await verifyAccessJwt(token, Object.assign({ teamDomain: cfg.teamDomain, aud: cfg.aud }, opts));
  return {
    ok: verdict.ok,
    configured: true,
    reason: verdict.reason,
    email: verdict.email || null,
    presented: true,
  };
}
