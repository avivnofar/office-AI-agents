#!/usr/bin/env node
/**
 * scripts/verify-artifact-gallery.js — does the warehouse artifact gate stay
 * honest, and does a malformed manifest surface rather than vanish?
 *
 * Written 2026-08-30. Run: node scripts/verify-artifact-gallery.js
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────
 *
 * 1. A task id from a query string is validated against a fixed pattern and
 *    is REFUSED, never guessed at, for anything hostile — the same standard
 *    `verify-item-detail.js` holds `parseItemRef()` to, applied here to
 *    `parseTaskQuery()`.
 * 2. A manifest that names an absolute or traversing `entry`, or an
 *    unrecognized `kind`, is refused before it ever becomes a path.
 * 3. A folder with NO manifest is not an error and is not listed. A folder
 *    whose manifest exists but fails validation is reported as a PROBLEM,
 *    never silently dropped — §7 of ARCHITECTURAL-DECISIONS.md is six
 *    recorded occurrences of "the guard exists and nobody sees it fire";
 *    this file exists to keep this gate off that list.
 * 4. The two routes are registered in `admin-gate.js`'s alias map by hand,
 *    are inside `/api/admin` so the shared prefix gate authenticates them,
 *    and the handlers contain no authentication check of their own.
 * 5. The page opens the artifact in a sandboxed `srcdoc` iframe, never `src`.
 *
 * NO NETWORK. `globalThis.fetch` is replaced with a tripwire — the gallery
 * module makes no call of its own, by construction (it imports nothing).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TASKS_DIR, MANIFEST_FILENAME, KNOWN_ARTIFACT_KINDS,
  isValidTaskSlug, parseTaskQuery, parseArtifactManifest, resolveArtifactEntryPath, buildArtifactGallery,
} from '../workers/artifact-gallery.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

globalThis.fetch = () => { throw new Error('verify-artifact-gallery.js: a network call was attempted — this module must make none'); };

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) { console.log(`\n${title}`); }

/* ═════════════════ §1 the task id is validated, never a path ═════════════ */

section('§1 the task id is validated, and never becomes a path');

check('a real slug resolves', parseTaskQuery('dependency-audit').ok === true);
check('a real slug round-trips the same string', parseTaskQuery('dependency-audit').slug === 'dependency-audit');

const HOSTILE = [
  '../../etc/passwd', '..%2f..%2fBOARD.md', 'dependency-audit/../../x',
  'Dependency-Audit', 'DEPENDENCY_AUDIT', '', null, undefined, '   ',
  'a'.repeat(200), 'has spaces', 'trailing-/', '/leading-slash',
  'contract..analyst', 'contract\\analyst',
];
check('every hostile or malformed task id is refused',
  HOSTILE.every((h) => parseTaskQuery(h).ok === false),
  HOSTILE.filter((h) => parseTaskQuery(h).ok).join(', '));
check('a refusal always says why',
  HOSTILE.every((h) => typeof parseTaskQuery(h).reason === 'string' && parseTaskQuery(h).reason.length > 5));
check('isValidTaskSlug agrees with parseTaskQuery on every fixture',
  ['dependency-audit', ...HOSTILE].every((h) => isValidTaskSlug(h) === parseTaskQuery(h).ok));

const MODULE = readFileSync(join(repo, 'workers', 'artifact-gallery.js'), 'utf8');
check('the module imports nothing', !/^import\s/m.test(MODULE));
check('the module contains no fetch and no provider client',
  !/\bfetch\s*\(/.test(MODULE) && !/api\.(?:anthropic|github)\.com|generativelanguage|groq\.com/.test(MODULE));

/* ═══════════════ §2 the manifest is validated before it is a path ════════ */

section('§2 a manifest is validated, and a bad one is refused before it becomes a path');

const GOOD = JSON.stringify({
  title: 'Dependency audit report', description: 'Every dependency, checked against a local advisory file.',
  entry: 'viewer/index.html', kind: 'static-html', updated: '2026-08-30',
});
const good = parseArtifactManifest(GOOD, 'dependency-audit');
check('a well-formed manifest parses', good.ok === true);
check('resolveArtifactEntryPath joins under the task folder',
  resolveArtifactEntryPath('dependency-audit', good.entry) === 'tasks/dependency-audit/viewer/index.html');

const BAD_MANIFESTS = [
  ['not json at all', 'is not valid JSON'],
  ['[]', 'is not a JSON object'],
  ['null', 'is not a JSON object'],
  [JSON.stringify({ description: 'x', entry: 'a.html', kind: 'static-html' }), 'no "title"'],
  [JSON.stringify({ title: 'x', entry: 'a.html', kind: 'static-html' }), 'no "description"'],
  [JSON.stringify({ title: 'x', description: 'x', kind: 'static-html' }), 'no "entry"'],
  [JSON.stringify({ title: 'x', description: 'x', entry: '/etc/passwd', kind: 'static-html' }), 'relative'],
  [JSON.stringify({ title: 'x', description: 'x', entry: '../../secret.html', kind: 'static-html' }), 'relative'],
  [JSON.stringify({ title: 'x', description: 'x', entry: 'viewer\\index.html', kind: 'static-html' }), 'relative'],
  [JSON.stringify({ title: 'x', description: 'x', entry: 'a.html', kind: 'server-node' }), 'not one this gallery recognizes'],
  [JSON.stringify({ title: 'x', description: 'x', entry: 'a.html' }), 'not one this gallery recognizes'],
];
check('every malformed manifest is refused, with a reason naming the defect',
  BAD_MANIFESTS.every(([text, needle]) => {
    const r = parseArtifactManifest(text, 'x');
    return r.ok === false && r.reason.toLowerCase().includes(needle.toLowerCase());
  }),
  JSON.stringify(BAD_MANIFESTS.filter(([text, needle]) => {
    const r = parseArtifactManifest(text, 'x');
    return r.ok !== false || !r.reason.toLowerCase().includes(needle.toLowerCase());
  })));
check('an absent updated field is null, not a fabricated date',
  parseArtifactManifest(JSON.stringify({ title: 'x', description: 'x', entry: 'a.html', kind: 'static-html' }), 'x').updated === null);
check('KNOWN_ARTIFACT_KINDS is a real, non-empty list', Array.isArray(KNOWN_ARTIFACT_KINDS) && KNOWN_ARTIFACT_KINDS.includes('static-html'));

/* ═══════ §3 the gallery: no manifest is not an error; a bad one IS ══════ */

section('§3 no manifest is silence; a manifest that fails validation is a reported problem');

const DIR_ENTRIES = [
  { name: 'dependency-audit', type: 'dir' },
  { name: 'contract-analyst', type: 'dir' },
  { name: 'daily-report-agent-names', type: 'dir' },
  { name: 'README.md', type: 'file' }, // not a directory — must be ignored outright
];

const MANIFESTS_ALL_ABSENT = {
  'dependency-audit': { notFound: true },
  'contract-analyst': { notFound: true },
  'daily-report-agent-names': { notFound: true },
};
const noneListed = buildArtifactGallery(DIR_ENTRIES, MANIFESTS_ALL_ABSENT);
check('a task with no manifest contributes neither an artifact nor a problem',
  noneListed.artifacts.length === 0 && noneListed.problems.length === 0,
  'most tasks will never have one, and that must not read as broken');

const MIXED = {
  'dependency-audit': { text: GOOD, reason: null },
  'contract-analyst': { notFound: true },
  'daily-report-agent-names': { text: '{ this is not json', reason: null },
};
const mixed = buildArtifactGallery(DIR_ENTRIES, MIXED);
check('the one real artifact is listed', mixed.artifacts.length === 1 && mixed.artifacts[0].task === 'dependency-audit');
check('the absent manifest is silent — no problem entry for contract-analyst',
  !mixed.problems.some((p) => p.task === 'contract-analyst'));
check('THE MALFORMED MANIFEST SURFACES AS A PROBLEM, NOT A SILENT DROP',
  mixed.problems.length === 1 && mixed.problems[0].task === 'daily-report-agent-names'
  && /not valid JSON/.test(mixed.problems[0].reason),
  'a folder whose artifact.json exists but is broken must be a visible finding, never absence read as fact');

const FETCH_ERROR = { 'dependency-audit': { text: null, reason: 'GET tasks/dependency-audit/artifact.json failed: HTTP 500' } };
const errored = buildArtifactGallery([{ name: 'dependency-audit', type: 'dir' }], FETCH_ERROR);
check('a real fetch failure (not a 404) is a problem too, distinct from "no manifest"',
  errored.problems.length === 1 && /HTTP 500/.test(errored.problems[0].reason));

check('a non-directory entry in the listing is ignored outright',
  !mixed.artifacts.some((a) => a.task === 'README.md') && !mixed.problems.some((p) => p.task === 'README.md'));
check('a hostile-shaped folder name is never trusted even if the listing carried one', (() => {
  const hostileDir = [{ name: '../../etc', type: 'dir' }];
  const r = buildArtifactGallery(hostileDir, { '../../etc': { text: GOOD, reason: null } });
  return r.artifacts.length === 0 && r.problems.length === 0;
})(), 'buildArtifactGallery must re-validate folder names, not trust the caller\'s listing');

/* ═════════════════ §4 the routes: registered, gated, mapped by hand ══════ */

section('§4 the routes exist, are inside the Access path, and are gated');

const GATE = readFileSync(join(repo, 'workers', 'admin-gate.js'), 'utf8');
const RUNNER = readFileSync(join(repo, 'workers', 'agent-runner.js'), 'utf8');
const PAGE = readFileSync(join(repo, 'workers', 'office-site-page.js'), 'utf8');

check('the alias map carries explicit entries for both routes',
  /\['artifacts', '\/api\/admin\/artifacts'\]/.test(GATE) && /\['artifact', '\/api\/admin\/artifact'\]/.test(GATE));

const canonicalBody = GATE.slice(GATE.indexOf('export function canonicalAdminApiPath'));
check('the alias is still a lookup and not a concatenation',
  /ADMIN_API_ROUTES\.get\(/.test(canonicalBody) && !/'\/api\/'\s*\+/.test(canonicalBody.slice(0, canonicalBody.indexOf('}'))));

check('the gallery list handler is under /api/admin, covered by the shared prefix gate',
  /url\.pathname === '\/api\/admin\/artifacts'/.test(RUNNER)
  && /const AUTHENTICATED_PREFIXES\s*=\s*\['\/api\/agents\/', '\/api\/admin'\]/.test(RUNNER));
check('the single-artifact handler is under /api/admin too',
  /url\.pathname === '\/api\/admin\/artifact'/.test(RUNNER));

check('the list handler contains no authentication check of its own', (() => {
  const i = RUNNER.indexOf("url.pathname === '/api/admin/artifacts'");
  if (i < 0) return false;
  const body = RUNNER.slice(i, RUNNER.indexOf("url.pathname === '/api/admin/artifact'", i));
  return !/ADMIN_TOKEN|adminCredential|adminCookieValue/.test(body);
})(), 'a handler-local check is the one a refactor moves');
check('the single-artifact handler contains no authentication check of its own', (() => {
  const i = RUNNER.indexOf("url.pathname === '/api/admin/artifact'");
  if (i < 0) return false;
  const body = RUNNER.slice(i, RUNNER.indexOf("url.pathname === '/api/admin'", i));
  return !/ADMIN_TOKEN|adminCredential|adminCookieValue/.test(body);
})());

check('the task identity travels in the query string, never the path',
  /url\.searchParams\.get\('task'\)/.test(RUNNER),
  'a path segment carrying the slug would be the traversal surface admin-gate.js\'s header warns against');
check('the manifest path is never built from the raw query value directly', (() => {
  const i = RUNNER.indexOf("url.pathname === '/api/admin/artifact'");
  const body = RUNNER.slice(i, RUNNER.indexOf("url.pathname === '/api/admin'", i));
  return /ref\.slug/.test(body) && !/searchParams\.get\('task'\)\s*\}/.test(body);
})());

check('the page calls both endpoints inside /admin/api, not the bare canonical path',
  /"\/admin\/api\/artifacts"/.test(PAGE) && /"\/admin\/api\/artifact\?task=" \+ encodeURIComponent/.test(PAGE));

/* ═══════════════════════ §5 the sandbox is real ═══════════════════════════ */

section('§5 the artifact renders in a sandboxed srcdoc iframe, never src');

check('the iframe carries a sandbox attribute', /<iframe id="artifacts-frame"[^>]*sandbox="allow-scripts"/.test(PAGE));
check('the fetched html is assigned to srcdoc',
  /frame\.srcdoc = r\.body\.html/.test(PAGE),
  'src would load the fetched document with the origin\'s own privileges');
check('the iframe is never given a src attribute in the markup',
  !/<iframe id="artifacts-frame"[^>]*\bsrc=/.test(PAGE));
check('the sandbox does not carry allow-same-origin',
  !/sandbox="[^"]*allow-same-origin/.test(PAGE.slice(PAGE.indexOf('id="artifacts-frame"') - 40, PAGE.indexOf('id="artifacts-frame"') + 120)),
  'allow-same-origin together with allow-scripts would let the task\'s markup reach this page\'s origin');

/* ═════════════════════════════ §6 the tab exists ══════════════════════════ */

section('§6 the tab is wired for admin only, and lazily fetches on open');

check('the admin render carries the artifacts tab and panel',
  /data-tab="artifacts"/.test(PAGE) && /tab_artifacts/.test(PAGE));
check('it fetches on tab open, not on page load',
  /tabLoaders\.artifacts = loadArtifactsGallery/.test(PAGE)
  && /if \(tabLoaders\[name\]\)/.test(PAGE));

/* ════════════════════════════════ Result ════════════════════════════════ */

console.log(`\nartifact-gallery: ${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILED:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`  a task with no manifest is silent; a broken one is a reported problem; the id never becomes a path. (${TASKS_DIR}/${MANIFEST_FILENAME})\n`);
process.exit(0);
