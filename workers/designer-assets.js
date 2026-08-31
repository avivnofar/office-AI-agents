/**
 * workers/designer-assets.js — the Designer's own gallery, read.
 *
 * Written 2026-08-31 for the "office console: the designer page" session.
 * Pure: this module imports nothing, so a verifier can load it under plain
 * `node`, the same rule `artifact-gallery.js`, `office-context.js` and
 * `item-detail.js` all keep.
 *
 * ── WHY THIS IS NOT `artifact-gallery.js`'S LISTING LOGIC, REUSED ─────────
 *
 * `artifact-gallery.js` lists warehouse TASK FOLDERS, each carrying one
 * `artifact.json` naming one browsable entry point. The Designer's assets do
 * not have that shape: they are a FLAT folder of paired image files, and
 * there is no folder-per-asset to hang a manifest off. Reusing
 * `buildArtifactGallery()` here would mean inventing a folder per image (and
 * a duplicate manifest that could drift from the provenance note already
 * written for it) just to fit a convention built for a different kind of
 * artifact. So this is a second, smaller listing function — not a rewrite of
 * the first one, and not a manifest format of its own.
 *
 * ── THE MANIFEST IS THE PROVENANCE NOTE, NOT A SECOND FILE ────────────────
 *
 * `provider-common.js` `renderAssetProvenance()` is, by the rule stated on
 * it, the ONLY renderer of a provenance note. This module is that
 * renderer's inverse: `parseProvenanceNote()` reads the same five lines back
 * out. No second manifest format is introduced beside it — the note IS the
 * manifest, so a draft and its polish cannot describe themselves two
 * different ways in two different files.
 *
 * ── PAIRING IS DATA, NOT A FILENAME GUESS ──────────────────────────────────
 *
 * A polished asset's own note already names the draft it came from
 * (`"Polished FROM \`<path>\`"` — see `renderAssetProvenance()`'s callers in
 * `agent-runner.js`). `parseProvenanceNote()` extracts that path and
 * `buildDesignerGallery()` uses it to attach a polish to its draft. The
 * `-polished` filename suffix is a naming CONVENTION this repo also keeps,
 * but it is never the thing this module trusts — a slug that happened to
 * already end in "polished" would break a filename-only pairing silently,
 * and the note's own recorded relationship would not.
 */

export const DESIGNER_ASSET_DIR = 'campus/agents/09-the-designer/assets';

const ASSET_LINE_RE = /-\s*\*\*Asset:\*\*\s*`([^`]+)`/;
const MODEL_LINE_RE = /-\s*\*\*Model:\*\*\s*`([^`]+)`\s*\(provider\s*`([^`]+)`,\s*image lane role\s*`([^`]+)`\)/;
const DATE_LINE_RE = /-\s*\*\*Date:\*\*\s*(\S+)/;
const PROMPT_LINE_RE = /-\s*\*\*Prompt:\*\*\s*(.+)/;
const SIZE_LINE_RE = /-\s*\*\*Size:\*\*\s*(\d+)\s*bytes/;
const NOTE_LINE_RE = /-\s*\*\*Note:\*\*\s*(.+)/;
const POLISHED_FROM_RE = /Polished FROM `([^`]+)`/;

/** Filename of an asset's provenance note — `<slug>.jpg` -> `<slug>.provenance.md`.
 *  Works on a bare filename or a full path; only the extension is touched. */
export function provenancePathFor(assetNameOrPath) {
  const dot = assetNameOrPath.lastIndexOf('.');
  const stem = dot === -1 ? assetNameOrPath : assetNameOrPath.slice(0, dot);
  return `${stem}.provenance.md`;
}

/** True for a committed image file — never for its `.provenance.md` sibling,
 *  which is metadata about the asset and not itself a gallery entry. */
export function isDesignerAssetImage(name) {
  return typeof name === 'string' && /\.(jpe?g|png|webp|gif|bin)$/i.test(name) && !/\.provenance\.md$/i.test(name);
}

/**
 * `renderAssetProvenance()`'s inverse. Refuses (rather than guessing) when
 * the required fields are not there, so a malformed note is reported as a
 * PROBLEM by the caller and not silently rendered with blanks.
 */
export function parseProvenanceNote(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'the provenance note was empty or could not be read' };
  }
  const assetM = text.match(ASSET_LINE_RE);
  if (!assetM) return { ok: false, reason: 'no "- **Asset:**" line — this is not a note renderAssetProvenance() wrote' };

  const modelM = text.match(MODEL_LINE_RE);
  const dateM = text.match(DATE_LINE_RE);
  const promptM = text.match(PROMPT_LINE_RE);
  const sizeM = text.match(SIZE_LINE_RE);
  const noteM = text.match(NOTE_LINE_RE);
  const note = noteM ? noteM[1].trim() : null;
  const polishedFromM = note ? note.match(POLISHED_FROM_RE) : null;

  return {
    ok: true,
    assetPath: assetM[1],
    model: modelM ? modelM[1] : null,
    provider: modelM ? modelM[2] : null,
    role: modelM ? modelM[3] : null,
    date: dateM ? dateM[1] : null,
    prompt: promptM ? promptM[1].trim() : null,
    bytes: sizeM ? Number(sizeM[1]) : null,
    note,
    // The relationship, read from DATA — see this file's header.
    polishedFrom: polishedFromM ? polishedFromM[1] : null,
  };
}

/**
 * The gallery listing, assembled from material already read.
 *
 * @param {Array<{name:string, type:string, size?:number}>} dirEntries the
 *   Designer asset directory listing, as the GitHub Contents API returns it
 * @param {object} provenanceResults `{ [imageFilename]: { text } |
 *   { text:null, reason } }` — one entry per image file, however the caller
 *   resolved reading its `.provenance.md`.
 * @returns {{assets: Array, problems: Array}} `assets` is drafts (each
 *   optionally carrying its own `.polished` sibling); a polish asset whose
 *   declared draft is missing from this listing is still returned, alone,
 *   flagged in `problems` rather than silently dropped.
 */
export function buildDesignerGallery(dirEntries, provenanceResults) {
  const problems = [];
  const parsedByPath = new Map();
  const results = provenanceResults || {};

  const files = (Array.isArray(dirEntries) ? dirEntries : [])
    .filter((e) => e && e.type === 'file' && isDesignerAssetImage(e.name));

  for (const f of files) {
    const path = `${DESIGNER_ASSET_DIR}/${f.name}`;
    const got = results[f.name];
    if (!got || typeof got.text !== 'string') {
      problems.push({ asset: path, reason: (got && got.reason) || `${provenancePathFor(f.name)} could not be read` });
      continue;
    }
    const parsed = parseProvenanceNote(got.text);
    if (!parsed.ok) {
      problems.push({ asset: path, reason: parsed.reason });
      continue;
    }
    parsedByPath.set(path, { path, name: f.name, size: f.size ?? null, ...parsed });
  }

  const attachedAsPolish = new Set();
  for (const item of parsedByPath.values()) {
    if (item.role === 'polish' && item.polishedFrom && parsedByPath.has(item.polishedFrom)) {
      attachedAsPolish.add(item.path);
    }
  }

  const assets = [];
  for (const item of parsedByPath.values()) {
    if (attachedAsPolish.has(item.path)) continue; // rendered under its draft, below

    if (item.role === 'polish') {
      // Its own note names a draft that is not in this folder listing — the
      // asset itself is real and is shown; the broken link is a PROBLEM.
      problems.push({
        asset: item.path,
        reason: item.polishedFrom
          ? `declares itself polished from "${item.polishedFrom}", which is not in this folder's listing`
          : 'a polish-role asset whose provenance note names no source (no "Polished FROM" in its Note field)',
      });
      assets.push({ ...item, polished: null });
      continue;
    }

    const polished = [...parsedByPath.values()].find((p) => p.polishedFrom === item.path) || null;
    assets.push({ ...item, polished });
  }

  assets.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.path.localeCompare(a.path));
  return { assets, problems };
}
