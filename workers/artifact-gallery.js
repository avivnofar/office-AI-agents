/**
 * workers/artifact-gallery.js — the warehouse artifact convention, read.
 *
 * Written 2026-08-30. Pure: **this module imports nothing** and makes no
 * network call of its own, the same rule `item-detail.js`, `site-data.js`,
 * `owner-channel.js` and `owner-page.js` keep, and for the same reason:
 * plain `node` must be able to load it so a verifier exercises the real
 * builders instead of a hand-mirror of them. Everything here takes its
 * inputs as arguments; the GitHub Contents API reads live in
 * `agent-runner.js`, next to every other repo read this estate makes.
 *
 * ── THE CONVENTION THIS MODULE READS ──────────────────────────────────────
 *
 * A task folder under `warehouse-office-AI-agents/tasks/<slug>/` may carry
 * `artifact.json`, declaring one browsable entry point:
 *
 *   { "title": "…", "description": "…", "entry": "viewer/index.html",
 *     "kind": "static-html", "updated": "2026-08-30" }
 *
 * `entry` is relative to the task's own folder. Most tasks will never have
 * this file, and that is correct — not a gap. A folder with none is simply
 * not listed. A folder whose `artifact.json` exists but fails to parse, or
 * whose `kind` this gallery does not recognize, is reported as a PROBLEM,
 * never silently dropped — the same posture `office-context.js` and
 * `item-detail.js` both already take on malformed input.
 */

export const TASKS_DIR = 'tasks';
export const MANIFEST_FILENAME = 'artifact.json';

/** Kinds this gallery knows how to render. A second kind is a second entry
 *  here plus a second `case` in the renderer — not a redesign.
 *
 * `'image'` added 2026-08-31 (the designer-page session) for a task-folder
 * artifact whose entry file is an image rather than an HTML app — rendered
 * as `<img>`, never inside the `srcdoc` iframe `static-html` uses, since an
 * image has no script to sandbox against. This is the STRUCTURAL kind for a
 * warehouse task artifact; the Designer's own asset folder is a different
 * shape (a flat folder of paired images, not one task per artifact) and is
 * read by `workers/designer-assets.js`, not by this module — see that
 * file's header for why. */
export const KNOWN_ARTIFACT_KINDS = Object.freeze(['static-html', 'image']);

/** Lowercase, hyphenated, per `tasks/README.md`'s own intake convention for
 *  a task slug. The identity this whole gallery is keyed on, so it is
 *  validated once, here, rather than trusted at every call site. */
const TASK_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidTaskSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= 100 && TASK_SLUG_PATTERN.test(slug);
}

/**
 * `?task=dependency-audit` -> `{ ok: true, slug: 'dependency-audit' }`.
 *
 * REFUSES rather than guesses — the id arrives from a query string, so it is
 * caller-controlled in the only sense that matters: it must not be able to
 * name a path outside `tasks/<slug>/`. Validated against a fixed pattern;
 * the path is built from it only after this check passes, and only ever as
 * `tasks/<slug>/…`, never from anything else in the request.
 */
export function parseTaskQuery(raw) {
  const slug = String(raw || '').trim();
  if (!slug) return { ok: false, reason: 'no task was given' };
  if (slug.length > 100) return { ok: false, reason: 'that task name is too long to be one of the warehouse\'s' };
  if (!isValidTaskSlug(slug)) {
    return { ok: false, reason: `"${slug}" is not a task folder name — expected lowercase letters, digits and hyphens only` };
  }
  return { ok: true, slug };
}

/**
 * One `artifact.json`'s text, validated into the manifest this gallery
 * trusts — or a reason it does not, which the caller reports as a PROBLEM
 * rather than dropping the folder.
 *
 * Every field is checked because a manifest that parses but lies about its
 * own shape (an `entry` that is absolute, or that climbs out of the task
 * folder with `..`) is the one case this function exists to catch before it
 * ever reaches a path.
 */
export function parseArtifactManifest(text, slug) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: `${MANIFEST_FILENAME} was empty or could not be read` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${MANIFEST_FILENAME} is not valid JSON — ${err.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: `${MANIFEST_FILENAME} is not a JSON object` };
  }

  const { title, description, entry, kind, updated } = data;
  if (typeof title !== 'string' || !title.trim()) {
    return { ok: false, reason: `${MANIFEST_FILENAME} has no "title"` };
  }
  if (typeof description !== 'string' || !description.trim()) {
    return { ok: false, reason: `${MANIFEST_FILENAME} has no "description"` };
  }
  if (typeof entry !== 'string' || !entry.trim()) {
    return { ok: false, reason: `${MANIFEST_FILENAME} has no "entry"` };
  }
  const entryTrimmed = entry.trim();
  if (entryTrimmed.startsWith('/') || entryTrimmed.includes('..') || entryTrimmed.includes('\\')) {
    return {
      ok: false,
      reason: `${MANIFEST_FILENAME}'s "entry" ("${entryTrimmed}") must be a plain path relative to its own`
        + ' task folder, with no leading slash and no ".." segment',
    };
  }
  if (typeof kind !== 'string' || !KNOWN_ARTIFACT_KINDS.includes(kind)) {
    return {
      ok: false,
      reason: `${MANIFEST_FILENAME}'s "kind" (${JSON.stringify(kind)}) is not one this gallery recognizes`
        + ` — known kinds: ${KNOWN_ARTIFACT_KINDS.join(', ')}`,
    };
  }

  return {
    ok: true,
    task: slug,
    title: title.trim(),
    description: description.trim(),
    entry: entryTrimmed,
    kind,
    updated: typeof updated === 'string' && updated.trim() ? updated.trim() : null,
  };
}

/**
 * The entry file's path, for a manifest already validated by
 * `parseArtifactManifest()`. Never called on an unvalidated `entry` — the
 * traversal check lives in the parser, once, so this stays a plain join.
 */
export function resolveArtifactEntryPath(slug, entry) {
  return `${TASKS_DIR}/${slug}/${entry}`;
}

/**
 * The gallery listing, assembled from material already read.
 *
 * @param {Array<{name: string, type: string}>} dirEntries the `tasks/`
 *   directory listing, as the GitHub Contents API returns it
 * @param {object} manifestResults `{ [taskName]: { notFound: true } |
 *   { text: string, reason: null } | { text: null, reason: string } }` — one
 *   entry per directory, however the caller resolved reading its
 *   `artifact.json`. `notFound: true` is the ordinary case (no manifest) and
 *   contributes neither an artifact nor a problem.
 */
export function buildArtifactGallery(dirEntries, manifestResults) {
  const artifacts = [];
  const problems = [];
  const results = manifestResults || {};

  for (const entry of Array.isArray(dirEntries) ? dirEntries : []) {
    if (!entry || entry.type !== 'dir') continue;
    const name = entry.name;
    if (!isValidTaskSlug(name)) continue; // defensive: not a task-shaped folder at all

    const got = results[name];
    if (!got || got.notFound) continue; // no manifest — the ordinary case, not a problem

    if (typeof got.text !== 'string') {
      problems.push({ task: name, reason: got.reason || `${MANIFEST_FILENAME} could not be read` });
      continue;
    }

    const parsed = parseArtifactManifest(got.text, name);
    if (!parsed.ok) {
      problems.push({ task: name, reason: parsed.reason });
      continue;
    }
    artifacts.push(parsed);
  }

  artifacts.sort((a, b) => a.title.localeCompare(b.title));
  return { artifacts, problems };
}
