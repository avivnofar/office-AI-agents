/**
 * THE DESIGNER PAGE — session "office console: the designer page" (2026-08-31).
 *
 * A request form and a gallery, closed-loop: the owner writes a brief, an
 * existing image client generates the asset, it is committed to the
 * Designer's own asset folder with a provenance note, and it shows up here.
 * No manual upload path — a `polish` request's source is always one of the
 * assets already listed below, never a file picked off the owner's disk.
 *
 * ── SERVER-RENDERED GALLERY METADATA, CLIENT-FETCHED BYTES ────────────────
 *
 * The GET handler in agent-runner.js calls the gallery reader itself and
 * hands this function the result — same idiom `renderAutomationsPage()`
 * keeps, and for the same reason: the page answers "what has the Designer
 * made" the instant it loads, with no round trip that can show an empty
 * gallery and a full one as the same blank state.
 *
 * The image BYTES are not inlined — three assets today, growing over time,
 * and a page that embeds every JPEG's base64 into its own HTML does not stay
 * light. Each `<img>` is filled in by one small client fetch to
 * `/api/admin/designer/asset`, which is the same endpoint the polish
 * picker's source list draws its bytes from — one read path, not two.
 *
 * ── THE STYLESHEET IS IMPORTED, NEVER WRITTEN ──────────────────────────────
 * Same rule `automations-page.js` keeps: no custom CSS property, no class
 * name the office's own stylesheet does not already carry.
 */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** True when a draft has been through polish — the one thing Part 3 of the
 *  spec asks to be obvious at a glance, because it was invisible until
 *  someone read the provenance files by hand. */
function polishBadge(asset) {
  if (asset.role === 'polish') return '<span class="auto-none">— orphaned polish, see problems below</span>';
  return asset.polished
    ? '<span>— polished</span>'
    : '<span class="auto-none">— draft only, never polished</span>';
}

function assetCard(asset) {
  const rows = [asset, asset.polished].filter(Boolean);
  const panes = rows.map((a) => `
        <div class="designer-pane">
          <div class="designer-imgwrap">
            <img class="designer-img" data-asset-path="${esc(a.path)}" alt="${esc(a.name)}">
          </div>
          <p class="auto-time">${esc(a.role || 'unknown role')} &middot; <code>${esc(a.model || 'unknown model')}</code> &middot; ${esc(a.date || 'undated')}</p>
        </div>`).join('\n');

  return `
    <div class="auto-group designer-card">
      <h3>${esc(asset.name)} ${polishBadge(asset)}</h3>
      <p class="section-note">${esc(asset.prompt || asset.note || 'no brief recorded in its provenance note')}</p>
      <div class="designer-pair">${panes}</div>
    </div>`;
}

/**
 * @param {object} o
 * @param {string} o.stylesheet
 * @param {string} o.versionId
 * @param {string} o.generateUrl
 * @param {string} o.assetUrl
 * @param {Array}  o.assets    from `buildDesignerGallery()` — drafts, each
 *   optionally carrying `.polished`.
 * @param {Array}  o.problems  from the same call — malformed/orphaned notes,
 *   shown rather than silently dropped.
 * @param {string} o.dir       the folder these assets live in, for display.
 */
export function renderDesignerPage({
  stylesheet, versionId, generateUrl, assetUrl, assets = [], problems = [], dir,
}) {
  const cards = assets.length
    ? assets.map(assetCard).join('\n')
    : '<p class="auto-none">No assets yet. Write a brief below to make the first one.</p>';

  const problemRows = problems.length
    ? `<ul class="gaps-list">${problems.map((p) => `<li><code>${esc(p.asset)}</code> — ${esc(p.reason)}</li>`).join('')}</ul>`
    : '';

  // The polish picker's options: every DRAFT asset with a known path — a
  // polish's own source is always one of these, never a file from the
  // owner's disk. Encoded as JSON for the client script rather than as
  // `<option>` markup built twice.
  const draftChoices = assets
    .filter((a) => a.role !== 'polish')
    .map((a) => ({ path: a.path, label: `${a.name} — ${a.date || 'undated'} (${a.role || 'unknown role'})` }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Office — the Designer</title>
<meta name="robots" content="noindex, nofollow">
<style>
${stylesheet}
.designer-form label { display: block; margin: 12px 0 4px; font-size: 13px; }
.designer-form textarea, .designer-form select { width: 100%; box-sizing: border-box; }
.designer-pair { display: flex; flex-wrap: wrap; gap: 16px; }
.designer-pane { flex: 1 1 220px; max-width: 320px; }
.designer-imgwrap { background: rgba(127,127,127,.12); border-radius: 8px; min-height: 160px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.designer-img { max-width: 100%; display: block; }
</style>
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <p class="eyebrow">owner view &middot; behind the admin gate &middot; worker ${esc(versionId || 'unknown')}</p>
      <h1>The Designer</h1>
      <p class="lede">A brief in, a committed asset with its own provenance note out. Assets live in <code>${esc(dir)}</code> of the back-office repo. No manual upload — a polish always starts from an asset already here.</p>
    </div>
  </header>
  <main>
    <div class="wrap">
      <div class="auto-group designer-form">
        <h3>Request an asset</h3>
        <label for="brief">Brief</label>
        <textarea id="brief" rows="3" placeholder="Describe the image, or — for a polish — what to change"></textarea>
        <label for="role">Role</label>
        <select id="role">
          <option value="draft">draft (Cloudflare, cheap, first pass)</option>
          <option value="polish">polish (Gemini, needs a source image)</option>
        </select>
        <div id="source-row" hidden>
          <label for="source">Source (one of the drafts below)</label>
          <select id="source"></select>
        </div>
        <label for="slug">Slug (optional — filename stem)</label>
        <input id="slug" type="text" placeholder="leave blank to derive one from the brief">
        <p><button type="button" id="go" class="message-send-btn">Generate</button></p>
        <p class="answer-status" id="gen-status"></p>
      </div>

      <div class="auto-group">
        <h3>Gallery — newest first</h3>
        ${cards}
        ${problemRows ? `<p class="section-note">Problems found while reading the folder:</p>${problemRows}` : ''}
      </div>
    </div>
  </main>
<script>
(function () {
  var DRAFTS = ${JSON.stringify(draftChoices)};
  var ASSET_URL = ${JSON.stringify(assetUrl)};
  var GENERATE_URL = ${JSON.stringify(generateUrl)};

  function byId(id) { return document.getElementById(id); }

  /* ---------- fill every <img> from the asset endpoint ---------- */
  document.querySelectorAll('img.designer-img[data-asset-path]').forEach(function (img) {
    var path = img.getAttribute('data-asset-path');
    fetch(ASSET_URL + '?path=' + encodeURIComponent(path), { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body || body.ok !== true) { img.alt = 'could not load (' + ((body && body.reason) || 'unknown reason') + ')'; return; }
        img.src = 'data:' + body.mimeType + ';base64,' + body.base64;
      })
      .catch(function (err) { img.alt = 'could not load: ' + err.message; });
  });

  /* ---------- role -> source picker ---------- */
  var roleSel = byId('role');
  var sourceRow = byId('source-row');
  var sourceSel = byId('source');
  DRAFTS.forEach(function (d) {
    var opt = document.createElement('option');
    opt.value = d.path;
    opt.textContent = d.label;
    sourceSel.appendChild(opt);
  });
  function syncSourceVisibility() {
    sourceRow.hidden = roleSel.value !== 'polish';
  }
  roleSel.addEventListener('change', syncSourceVisibility);
  syncSourceVisibility();

  /* ---------- generate ---------- */
  var status = byId('gen-status');
  function say(msg, ok) {
    status.textContent = msg;
    status.className = 'answer-status ' + (ok ? 'answer-status--ok' : 'answer-status--err');
  }
  byId('go').addEventListener('click', async function () {
    var brief = byId('brief').value.trim();
    if (!brief) { say('write a brief first', false); return; }
    var role = roleSel.value;
    if (role === 'polish' && !DRAFTS.length) { say('there is no draft in the gallery to polish yet', false); return; }
    var payload = { brief: brief, role: role };
    if (role === 'polish') payload.sourceAssetPath = sourceSel.value;
    var slug = byId('slug').value.trim();
    if (slug) payload.slug = slug;

    var btn = byId('go');
    btn.disabled = true;
    say('generating (' + role + ') ...', true);
    var res, data;
    try {
      res = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await res.json().catch(function () { return null; });
    } catch (err) {
      btn.disabled = false;
      say('the call got no answer at all (' + err.message + ') — this is UNKNOWN, not failed. Reload before trying again.', false);
      return;
    }
    btn.disabled = false;
    if (!data) { say('HTTP ' + res.status + ' with an unreadable response.', false); return; }
    if (!data.ok) {
      say('[' + (data.error || 'error') + '] ' + (data.message || data.reason || ('HTTP ' + res.status)), false);
      return;
    }
    say('committed ' + data.assetPath + ' (' + data.bytes + ' bytes, ' + data.provider + '/' + data.model + '). Reloading the gallery ...', true);
    setTimeout(function () { window.location.reload(); }, 1200);
  });
}());
</script>
</body>
</html>`;
}
