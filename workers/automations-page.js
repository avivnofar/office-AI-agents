/**
 * THE AUTOMATIONS PAGE — the render half of session 40, Item C.
 *
 * Split from `automations-panel.js` for the reason every other split in this
 * estate was made: the panel module is PURE and the verifier exercises it with
 * no D1, no network and no clock. Putting a 200-line HTML template in the same
 * file would not have broken that, but it would have made the purity a property
 * of care rather than of shape.
 *
 * ── THE STYLESHEET IS IMPORTED, NEVER WRITTEN ────────────────────────────
 *
 * `officeStylesheet()` is the office's own CSS, verbatim. **This file declares
 * no custom property and uses no class name `:root` does not carry.** A prior
 * session added CSS referencing variables that did not exist in the palette;
 * every one fell through to a browser default and painted white tiles onto a
 * dark design — a bug invisible to code review and found only by loading the
 * page. Importing rather than copying is what makes the rule checkable, and
 * `verify-automations.js` asserts that this file contains no `--name:`
 * declaration at all.
 */

/*
 * ── ONE IMPORT, AND WHY THE DECISION IS NOT MADE HERE (2026-08-31) ────────
 *
 * `workflowControl()` lives in the pure panel module, not in this template, so
 * "which rows get a control" is a statement the verifier can call directly with
 * a hand-made workflow row — and so this file stays what its header says it is:
 * a renderer. A control offered on the wrong row is a permission decision, and
 * a permission decision inside a string template is one nobody can test.
 */
import { workflowControl } from './automations-panel.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * SERVER-RENDERED, not fetched and drawn in the browser.
 *
 * Every other admin surface here fetches JSON and builds itself. This one does
 * not, and the reason is what the page is for: it is opened to answer "did the
 * thing run", and a page that renders empty while a fetch is in flight shows
 * NOTHING and NOTHING-YET as the same blank table for as long as the round trip
 * takes. The whole panel is one distinction, and the loading state was the one
 * place it could be lost for free.
 */
/*
 * ── THE TWO ENDPOINT URLS ARE PASSED IN, NOT BUILT HERE (2026-08-30) ──────
 *
 * They used to be a base plus a suffix, with the base defaulted to a string
 * literal. `admin-gate.js` exports `adminApiUrl()` for exactly this — its own
 * comment says it exists "so the three admin page renderers name one constant
 * instead of three string literals that can drift" — and it was **exported and
 * read by nothing**, which the weekly failure-mode walk flags as KFM-12
 * (`deadexport`). This page was a fourth renderer about to reproduce the drift
 * the helper was written to prevent.
 *
 * Passing the resolved URLs also keeps the alias map the single place a route
 * name is written down: change a key there and this page follows, instead of
 * silently pointing at a path that no longer rewrites.
 */
export function renderAutomationsPage({
  stylesheet, view, actions, switches, today, versionId, triggerUrl, readBackUrl,
  workflowUrl, writableRepo,
}) {
  const blockRows = view.rows.map((r) => `      <tr>
        <td class="auto-time">${esc(r.time)}</td>
        <td>${esc(r.type)}${r.meetingType ? ` <span class="auto-none">(${esc(r.meetingType)})</span>` : ''}</td>
        <td${r.missed ? ' class="auto-none"' : ''}><strong>${esc(r.state)}</strong>${r.runs > 1 ? ` — ${r.runs} rows today` : ''}</td>
        <td class="auto-time">${r.ranAt ? esc(r.ranAt) : '—'}</td>
        <td class="auto-time">${r.estimate ?? '—'} / ${r.actual ?? '—'}</td>
        <td>${esc(r.produced)}</td>
        <td class="auto-none">${esc(r.note)}</td>
      </tr>`).join('\n');

  const missedBanner = !view.admissionsRead
    ? '<p class="answer-status answer-status--err">The admission record could not be read this load. Every row below says UNKNOWN, which is not the same as MISSED — nothing here should be acted on until D1 answers.</p>'
    : view.missedCount
      ? `<p class="answer-status answer-status--err"><strong>${view.missedCount} block${view.missedCount === 1 ? '' : 's'} due today with no admission row.</strong> That is the row this page exists for: it should have run and there is no record that it did.</p>`
      : '<p class="answer-status answer-status--ok">Every block due so far today has an admission row. Nothing is missing.</p>';

  /*
   * ── THE CONTROL COLUMN (2026-08-31) ─────────────────────────────────────
   *
   * `writable` is a comparison against the ONE repo this Worker's token may
   * write to, made per row rather than assumed for the table. The panel reads a
   * single repo today, so every row is writable and the comparison is trivially
   * true — which is exactly why it is written down: the day a second repo's
   * workflows appear here, the rows this token cannot touch say so instead of
   * offering a button that would 403.
   */
  const workflowRow = (w) => {
    const writable = !!writableRepo && actions.repo === writableRepo;
    const ctl = workflowControl(w, { writable, repo: actions.repo, writeRepo: writableRepo });
    const control = ctl.action
      ? `<button class="item-open" data-workflow="${esc(w.id)}"`
        + ` data-enable="${ctl.action === 'enable' ? 'true' : 'false'}"`
        + ` data-name="${esc(w.name)}">${esc(ctl.label)}</button>`
      : `<span class="auto-none">${esc(ctl.why)}</span>`;
    return `      <tr>
        <td>${esc(w.name)}</td>
        <td class="auto-time">${esc(w.path)}</td>
        <td class="auto-time">${w.lastRunAt ? esc(w.lastRunAt) : '<span class="auto-none">never / unknown</span>'}</td>
        <td${w.state && w.state !== 'active' ? ' class="auto-none"' : ''}><span data-state-for="${esc(w.id)}">${esc(w.conclusion || '—')}</span></td>
        <td class="auto-none">${esc(w.event || '—')}</td>
        <td data-control-for="${esc(w.id)}">${control}</td>
      </tr>`;
  };

  const actionRows = actions.ok
    ? (actions.workflows.length
      ? actions.workflows.map(workflowRow).join('\n')
      : '      <tr><td colspan="6" class="auto-none">The API answered and listed no active workflow. This is an empty list, not a refused read.</td></tr>')
    : `      <tr><td colspan="6" class="auto-none">NOT READ — ${esc(actions.reason)}</td></tr>`;

  const switchRows = switches.map((s) => {
    const on = s.value === true;
    const control = s.retired
      ? '<span class="auto-none">retired — no control offered</span>'
      : `<button class="item-open" data-trigger="${esc(s.trigger)}" data-next="${on ? 'false' : 'true'}">turn ${on ? 'OFF' : 'ON'}</button>`;
    return `      <tr>
        <td class="auto-time">${esc(s.key)}</td>
        <td><strong data-value-for="${esc(s.key)}">${on ? 'ON' : 'OFF'}</strong></td>
        <td>${control}</td>
        <td class="auto-none">${esc(s.retired || s.what)}</td>
      </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Office — automations</title>
<meta name="robots" content="noindex, nofollow">
<style>
${stylesheet}
</style>
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <p class="eyebrow">owner view · behind the admin gate · worker ${esc(versionId || 'unknown')}</p>
      <h1>Automations</h1>
      <p class="lede">What should run, what did, and what did not — ${esc(today)}, Israel time ${esc(view.israelTime)}, schedule <code>${esc(view.scheduleKey || 'none for this day')}</code>.</p>
    </div>
  </header>
  <main>
    <div class="wrap">
      ${missedBanner}

      <div class="auto-group">
        <h3>This Worker&rsquo;s scheduled blocks &mdash; <code>config/daily-schedule.json</code> joined against D1 <code>block_admissions</code></h3>
        <div class="auto-scroll">
          <table class="auto-table">
            <thead><tr>
              <th>due</th><th>block</th><th>state</th><th>last row at (UTC)</th>
              <th>est / actual subreq</th><th>produced today</th><th>what it is</th>
            </tr></thead>
            <tbody>
${blockRows || '      <tr><td colspan="7" class="auto-none">No blocks are scheduled for this day of week.</td></tr>'}
            </tbody>
          </table>
        </div>
        ${view.scheduleLabel ? `<p class="answer-effect">${esc(view.scheduleLabel)}</p>` : ''}
      </div>

      <div class="auto-group">
        <h3>GitHub Actions &mdash; the half that does not run in this Worker</h3>
        <div class="auto-scroll">
          <table class="auto-table">
            <thead><tr><th>workflow</th><th>file</th><th>last run</th><th>result</th><th>trigger</th><th></th></tr></thead>
            <tbody>
${actionRows}
            </tbody>
          </table>
        </div>
        <p class="answer-status" id="workflow-status"></p>
        <p class="answer-effect">The declared cron is NOT shown: it lives in each workflow&rsquo;s YAML and this Worker does not parse YAML. A guessed schedule beside a real last-run time is the more dangerous half of that pair.</p>
        <p class="answer-effect">Enable and disable act on GitHub, not on a local flag, and the state beside each row is re-read from GitHub after the call rather than repainted optimistically &mdash; a control that assumed its own success would reintroduce, inside this page, the gap between what should be true and what is that the page exists to close. This Worker holds one public-repo token: only <code>${esc(writableRepo || 'none')}</code> can be written from here, and nothing here pushes to a workflow YAML file &mdash; that is a different scope this token does not carry.</p>
      </div>

      <div class="auto-group">
        <h3>Kill switches &mdash; the ones that already exist</h3>
        <div class="auto-scroll">
          <table class="auto-table">
            <thead><tr><th>switch</th><th>live value</th><th></th><th>what it governs</th></tr></thead>
            <tbody>
${switchRows}
            </tbody>
          </table>
        </div>
        <p class="answer-status" id="toggle-status"></p>
        <p class="answer-effect">Every value above was read back from live SIM_KV on this page load. A toggle re-reads it after writing rather than assuming the write took &mdash; this estate has a documented case of a toggle answering 200 and changing nothing. Workers KV is eventually consistent, so a value that has not moved yet reads as <em>not yet visible</em> and is re-read once after ten seconds; only the second read is allowed to be a verdict.</p>
      </div>
    </div>
  </main>
<script>
(function () {
  var status = document.getElementById('toggle-status');
  function say(msg, ok) {
    status.textContent = msg;
    status.className = 'answer-status ' + (ok ? 'answer-status--ok' : 'answer-status--err');
  }
  function paint(row) {
    if (!row) return;
    var cell = document.querySelector('[data-value-for="' + row.key + '"]');
    if (cell) cell.textContent = row.value === true ? 'ON' : 'OFF';
    var b = document.querySelector('button[data-trigger="' + row.trigger + '"]');
    if (b) {
      b.setAttribute('data-next', row.value === true ? 'false' : 'true');
      b.textContent = 'turn ' + (row.value === true ? 'OFF' : 'ON');
    }
  }
  /* ── THE WORKFLOW CONTROLS (2026-08-31) ──────────────────────────────
     A separate status line and a separate handler, because a GitHub write and
     a KV write fail in different ways and one shared sentence would flatten
     them. Every branch below is a DIFFERENT message: the endpoint returns a
     code and that code is what is shown, so 403 (scope), 404 (no such
     workflow), unreachable (unknown, not failed) and unchanged (accepted, and
     the state did not move) never collapse into "it failed". */
  var wfStatus = document.getElementById('workflow-status');
  function sayWf(msg, ok) {
    wfStatus.textContent = msg;
    wfStatus.className = 'answer-status ' + (ok ? 'answer-status--ok' : 'answer-status--err');
  }
  document.addEventListener('click', async function (ev) {
    var wf = ev.target.closest('button[data-workflow]');
    if (!wf) return;
    var id = wf.getAttribute('data-workflow');
    var enable = wf.getAttribute('data-enable') === 'true';
    var name = wf.getAttribute('data-name') || id;
    wf.disabled = true;
    sayWf((enable ? 'enabling ' : 'disabling ') + name + ' on GitHub ...', true);
    var res;
    try {
      res = await fetch('${workflowUrl}?id=' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: enable }),
      });
    } catch (err) {
      /* The browser never got an answer. UNKNOWN, not failed — the call may
         have landed, so nothing is repainted and nothing is retried for you. */
      wf.disabled = false;
      sayWf('the call got no answer at all (' + err.message + '). This is UNKNOWN, not failed — it may have landed. Reload before trying again.', false);
      return;
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!data) {
      wf.disabled = false;
      sayWf('HTTP ' + res.status + ', and the response was not readable JSON — the result is unknown. Reload before trying again.', false);
      return;
    }
    if (data.ok) {
      /* The state shown is the one the SERVER read back from GitHub after the
         write, not the direction this button asked for. */
      var cell = document.querySelector('[data-state-for="' + id + '"]');
      if (cell) cell.textContent = data.state === 'active' ? 'active (re-read)' : 'DISABLED (' + data.state + ')';
      var host = document.querySelector('[data-control-for="' + id + '"]');
      if (host) {
        var flip = data.state === 'disabled_manually';
        wf.setAttribute('data-enable', flip ? 'true' : 'false');
        wf.textContent = flip ? 'enable' : 'disable';
      }
      wf.disabled = false;
      sayWf(name + ': ' + data.message, true);
      return;
    }
    /* Every refusal keeps its own sentence. The code distinguishes them; the
       message the endpoint wrote is what a person reads. */
    wf.disabled = false;
    sayWf(name + ' — [' + (data.code || 'error') + '] ' + (data.message || data.reason || ('HTTP ' + res.status)), false);
  });

  document.addEventListener('click', async function (ev) {
    var btn = ev.target.closest('button[data-trigger]');
    if (!btn) return;
    var type = btn.getAttribute('data-trigger');
    var next = btn.getAttribute('data-next') === 'true';
    btn.disabled = true;
    say('writing ' + type + ' -> ' + next + ' ...', true);
    try {
      var res = await fetch('${triggerUrl}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, enabled: next }),
      });
      if (!res.ok) { say('the write was refused: HTTP ' + res.status, false); btn.disabled = false; return; }
      /* THE READ-BACK. Not the write's own response — a fresh read of the live
         value, which is the only thing that answers "did it take". */
      var back = await fetch('${readBackUrl}?format=json', { headers: { Accept: 'application/json' } });
      if (!back.ok) { say('written, but the read-back failed (HTTP ' + back.status + ') - reload before trusting the value', false); btn.disabled = false; return; }
      var data = await back.json();
      var row = (data.switches || []).filter(function (s) { return s.trigger === type; })[0];
      if (!row) { say('written, but the read-back did not return this switch', false); btn.disabled = false; return; }
      paint(row);
      if (row.value === next) {
        btn.disabled = false;
        say('read back from live KV: ' + row.key + ' is now ' + (row.value ? 'ON' : 'OFF') + '.', true);
        return;
      }
      /* ── A MISMATCH IS NOT YET A FAILURE (found live, 2026-08-30) ───────
         The first version of this said THE WRITE DID NOT TAKE on any mismatch,
         and the session that wrote it watched that fire on a write that HAD
         taken: a read three seconds later returned the old value, and the same
         write read back correctly at +0s on the next attempt. Workers KV is
         eventually consistent — an immediate read can be served the prior
         value from another colo — so an immediate mismatch is INCONCLUSIVE,
         not a failure.
         Reporting it as a failure would be the estate's own recurring sin one
         level up: two different facts ("stale read" and "refused write")
         rendered as one sentence. So the first mismatch says NOT YET VISIBLE
         and re-reads; only the second, after a wait longer than KV's own
         propagation, is allowed to be a verdict. */
      say('written; the value is NOT YET VISIBLE (KV is eventually consistent) — re-reading in 10s before saying anything.', true);
      setTimeout(async function () {
        try {
          var again = await fetch('${readBackUrl}?format=json', { headers: { Accept: 'application/json' } });
          var d2 = await again.json();
          var r2 = (d2.switches || []).filter(function (s) { return s.trigger === type; })[0];
          paint(r2);
          btn.disabled = false;
          say(r2 && r2.value === next
            ? 'read back from live KV after 10s: ' + r2.key + ' is now ' + (r2.value ? 'ON' : 'OFF') + '.'
            : 'THE WRITE DID NOT TAKE: ' + row.key + ' still reads ' + (r2 && r2.value ? 'ON' : 'OFF') + ' after a second read. Reload before trusting anything on this page.',
          !!(r2 && r2.value === next));
        } catch (e2) {
          btn.disabled = false;
          say('the second read-back threw: ' + e2.message + ' — reload before trusting the value', false);
        }
      }, 10000);
    } catch (err) {
      say('the toggle threw: ' + err.message, false);
      btn.disabled = false;
    }
  });
}());
</script>
</body>
</html>`;
}
