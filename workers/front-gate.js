/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PUBLISHING GATE — the mechanism the Designer operates.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OB-014`. Built 2026-08-16. Until today this was a **specification with no
 * enforcement**: `back-office-AI-agents/campus/shared/front-drafts/
 * PUBLISHING-GATE.md` (2026-08-11) wrote the 8 criteria and the 5-step batch
 * flow in full and said so plainly in its own status line — *"ENFORCEMENT NOT
 * BUILT"* — because enforcement could not precede plan 0.4's publishing split.
 *
 * **0.4 is now done for every report type that can fire**, verified from real
 * Worker commits rather than from the plan's own checklist: meeting reports,
 * daily summaries, the weekly raw trio (`chore(office): week 7 executive
 * summary`, back-office `campus/shared/weekly/`) and side plots all land in
 * back-office. Only promotions is unverified, and it cannot fire before a
 * `day_365` milestone. So the stated blocker is lifted and this file is the
 * second half.
 *
 * The audit's finding #17 — *the Designer's bible role is "absolute gatekeeper
 * of the Front" and there is no gate for her to operate* — was still true this
 * morning, confirmed three independent ways: `config/capability-manifest.json`
 * carried `front-publishing-gate` as `supplied_by.kind: "none"`, no module or
 * script implemented it, and `front-drafts/` held three governance documents
 * and zero content drafts. This module is that finding's fix.
 *
 * ── WHAT A GATE IS HERE, AND WHAT IT DELIBERATELY IS NOT ──────────────────
 *
 * Four of the eight criteria are mechanical and are **enforced** below. Four
 * are judgement calls, and this module does not pretend to make them. What it
 * does instead is **refuse to publish without the record of the judgement
 * having been made** — named agent, timestamp, verdict, evidence.
 *
 * That distinction is the whole design. A gate that scored "delivery quality"
 * with a heuristic would be this project's own most-repeated defect wearing a
 * new hat: a number that looks like a judgement and is not one (see
 * `workers/quality-metric.js`, whose length proxy measured INVERTED against a
 * real judge). A gate that simply trusted the caller would be no gate. Refusing
 * on a *missing record* is mechanical, honest, and has real teeth: the Designer
 * cannot publish a batch the QA never signed, and the absence is countable.
 *
 * ── WHY THERE IS NO KILL SWITCH ───────────────────────────────────────────
 *
 * Every other feature in this repo ships behind one (`guides_enabled`,
 * `routing_enabled`, ...). This one deliberately does not, for the same reason
 * `workers/deliverable-lifecycle.js` does not: **a switch that turns off a
 * refusal mechanism is not a switch, it is a hole.** The thing a kill switch
 * protects against is a feature misbehaving in production; the failure mode of
 * a gate is that it lets something through, and an off-switch is that failure
 * mode with an admin endpoint attached. A10 is explicit that the security half
 * of this is "automatic, never judgment" — a bypass flag would put the
 * judgement back exactly where A10 removed it from.
 *
 * To stop the Front publishing, stop calling `front_publish`. There is nothing
 * else to turn off, because this module never publishes anything by itself.
 *
 * ── PURE ──────────────────────────────────────────────────────────────────
 *
 * No env, no I/O, no config import. Its single import is `isScannedPath` from
 * `security-scan.js`, which is itself pure for the same reason. That is what
 * lets `scripts/verify-front-gate.js` load this file and *call* it under plain
 * `node`, so the refusals below are demonstrated rather than described.
 */

import { isScannedPath } from './security-scan.js';

/**
 * Everything the Front publishes lives under ONE prefix.
 *
 * `OB-013`'s `delivered=` names five sections — landing, team/, portfolio/,
 * press/, product/ — and the obvious reading is five directories at the repo
 * root. They are nested under `front/` instead, and the reason is criterion 3
 * rather than taste: A10's mandatory scan is driven by
 * `security-scan.js SCANNED_PREFIXES`, a prefix list. Five root directories
 * means five prefixes to keep in sync forever, and the failure mode of
 * forgetting the sixth is *silent* — `scanOutbound()` returns
 * `{clean: true, scanned: false}` for an out-of-scope path and
 * `commitFileToRepo()` only refuses when `scanned.scanned` is true, so an
 * uncovered Front section publishes UNSCANNED and nothing says so.
 *
 * One prefix, one line in `SCANNED_PREFIXES`, and `assertScanCoverage()` below
 * checks it holds instead of assuming it.
 */
export const FRONT_PREFIX = 'front/';

/** The five sections, in the owner's narrative order. `landing` is `front/index.md`. */
export const FRONT_SECTIONS = Object.freeze(['landing', 'team', 'portfolio', 'press', 'product']);

/** The QA is Agent 6. The Designer is Agent 9. Named, not passed in — A10 names the roles. */
export const QA_AGENT_ID = 6;
export const DESIGNER_AGENT_ID = 9;

/** The lane that re-voices Hebrew for the Front. `config/model-routing.json`. */
export const LOCALIZATION_LANE = 'front_localization';

/**
 * Hebrew (and the rest of the Hebrew block). Used for criterion 1's mechanical
 * half only — see `detectNonEnglish()` for why finding a character is not the
 * same as refusing the item.
 */
const HEBREW_RE = /[֐-׿]/;

/**
 * Criterion 1, the mechanical half: where is there non-Latin script?
 *
 * Deliberately reports LOCATIONS rather than a verdict. `PUBLISHING-GATE.md`
 * criterion 1 is explicit that the final call is the Designer's, because a
 * proper noun or a deliberately-quoted Hebrew fragment ("in the office's own
 * words, in Hebrew, X") is not automatically wrong — and A10's "everything is
 * shown, including mistakes, in the same words it was recorded internally"
 * makes such a quote *likely*, not exotic.
 *
 * So the mechanism finds every occurrence and the batch must acknowledge each
 * one. Silence is the refusal, not the Hebrew.
 *
 * @returns {Array<{line: number, excerpt: string}>}
 */
export function detectNonEnglish(text) {
  const lines = String(text || '').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!HEBREW_RE.test(lines[i])) continue;
    hits.push({ line: i + 1, excerpt: lines[i].trim().slice(0, 80) });
  }
  return hits;
}

/**
 * Criterion 3's real check, and the one this module exists to make impossible
 * to forget: **is the path this batch is about to write actually covered by
 * A10's scan?**
 *
 * The gate does NOT re-run `scanOutbound()`. `PUBLISHING-GATE.md` criterion 3
 * says so directly — the scanner already runs unconditionally inside
 * `commitFileToRepo()` for every public-repo write, and duplicating it would
 * create a second copy to drift. What the gate owes is the thing nobody was
 * checking: that Front paths are IN SCOPE for it.
 *
 * This was not hypothetical when the gate was built. On 2026-08-16
 * `SCANNED_PREFIXES` was `['reports/', 'agent-output/', 'docs/', 'README',
 * 'PROJECT-CONTEXT-SUMMARY', 'AGENTS.md']` — no Front prefix at all. The very
 * first Front page would have published unscanned, past a control A10 calls
 * mandatory, with a success response and no signal anywhere. `front/` was added
 * in the same commit as this file; this function is what keeps it true.
 */
export function assertScanCoverage(path) {
  const p = String(path || '');
  if (!p.startsWith(FRONT_PREFIX)) {
    return {
      ok: false,
      code: 'front_path_outside_prefix',
      message: `"${p}" is not under ${FRONT_PREFIX}. The Front publishes under one prefix so A10's scan needs one entry in SCANNED_PREFIXES; a path outside it is either a mistake or a section that would go unscanned.`,
    };
  }
  if (!isScannedPath(p)) {
    return {
      ok: false,
      code: 'front_path_not_scanned',
      message: `"${p}" is under ${FRONT_PREFIX} but security-scan.js isScannedPath() says NO. A10's pre-publication scan would report {scanned: false} and commitFileToRepo() would let the write through unscanned. Add '${FRONT_PREFIX}' to SCANNED_PREFIXES before publishing anything here.`,
    };
  }
  return { ok: true, code: null, message: null };
}

function refusal(criterion, code, message) {
  return { criterion, code, message };
}

/** A timestamp comparison that treats an unparseable date as unusable, not as zero. */
function parsedTime(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Evaluates ONE staged item against the per-item criteria (1, 2, 3, 4).
 *
 * Item shape — every field is a RECORD the office produces, not something this
 * module infers:
 *   {
 *     path: 'front/team/09-the-designer.md',   // where it publishes
 *     content: '...',                          // the English text
 *     contentIsBase64: false,                  // criterion 4
 *     sourceLanguage: 'en' | 'he',             // criterion 2
 *     localization: { lane, sourceRef, at },   // criterion 2, required when 'he'
 *     provenance: { sourceRef, author },       // who/what it came from
 *     revisedAt: ISO,                          // criterion 5's staleness check
 *     hebrewFragmentsAcknowledged: [ { line, why } ]  // criterion 1
 *   }
 */
export function evaluateItem(item) {
  const refusals = [];
  const path = String(item?.path || '');

  // ── Criterion 4: no binary through this path ────────────────────────────
  // Checked FIRST and separately from the scan, even though commitFileToRepo()
  // refuses base64 to the public repo on its own. Two reasons it is not
  // redundant: this runs before the batch is assembled, so the Designer learns
  // at curation time rather than at publish time; and a refusal here names the
  // image lane, which is the actual answer to what she was trying to do.
  if (item?.contentIsBase64) {
    refusals.push(refusal(4, 'binary_item_refused',
      `"${path}" is base64. A10's scan is a TEXT scan and cannot read bytes. Images go through the Designer's image lane and asset-provenance path (config/model-routing.json lane 'image'), never through front-drafts/.`));
  }

  // ── Criterion 3: the scan must actually cover where this lands ──────────
  const coverage = assertScanCoverage(path);
  if (!coverage.ok) refusals.push(refusal(3, coverage.code, coverage.message));

  // ── Criterion 1: English only ───────────────────────────────────────────
  const nonEnglish = detectNonEnglish(item?.content);
  if (nonEnglish.length) {
    const acked = new Set(
      (Array.isArray(item?.hebrewFragmentsAcknowledged) ? item.hebrewFragmentsAcknowledged : [])
        .filter((a) => a && a.why)          // an acknowledgement with no reason is not one
        .map((a) => Number(a.line)),
    );
    const unacked = nonEnglish.filter((h) => !acked.has(h.line));
    if (unacked.length) {
      refusals.push(refusal(1, 'hebrew_fragment_unacknowledged',
        `"${path}" carries non-Latin script on line(s) ${unacked.map((h) => h.line).join(', ')} that the batch does not acknowledge. The Front is English only; a deliberate quoted fragment is allowed but must be declared with a reason in hebrewFragmentsAcknowledged, so a raw-Hebrew process error and a chosen quote are distinguishable. First: "${unacked[0].excerpt}"`));
    }
  }

  // ── Criterion 2: re-voiced, not translated ──────────────────────────────
  // Mechanical check of the RECORD, not of the prose. Whether the English
  // reads like narrative rather than a rendered sentence is the Designer's
  // read; whether it went through the localization lane at all is a fact.
  if (String(item?.sourceLanguage || 'en').toLowerCase() === 'he') {
    const loc = item?.localization || {};
    if (loc.lane !== LOCALIZATION_LANE) {
      refusals.push(refusal(2, 'hebrew_source_not_localized',
        `"${path}" declares sourceLanguage 'he' but carries no ${LOCALIZATION_LANE} localization record (lane was ${JSON.stringify(loc.lane ?? null)}). Internal Hebrew material is RE-VOICED through workers/localization-engine.js localizeForFront(), not translated and not hand-carried.`));
    } else if (!loc.sourceRef) {
      refusals.push(refusal(2, 'localization_provenance_missing',
        `"${path}" was localized but names no sourceRef. A re-voiced piece without its source is unfalsifiable — nobody can check it against what the office actually wrote.`));
    }
  }

  return { path, ok: refusals.length === 0, refusals, nonEnglishCount: nonEnglish.length };
}

/**
 * Evaluates a whole batch: the per-item criteria plus the batch-level ones
 * (5, 6, 7, 8) that are properties of the batch rather than of any one file.
 *
 * Batch shape:
 *   {
 *     batchId, curatedBy, curatedAt,
 *     qaSignOff: { agentId, at, verdict: 'approved'|'returned', notes },
 *     mistakesShown: { included: bool, evidence: string },
 *     disagreementShown: { applicable: bool, included: bool, evidence: string },
 *     items: [ ...see evaluateItem ]
 *   }
 */
export function evaluateBatch(batch) {
  const batchRefusals = [];
  const items = Array.isArray(batch?.items) ? batch.items : [];

  // An empty batch is refused rather than trivially approved. "Nothing to
  // publish" and "a batch that passed every check" must not produce the same
  // response — that equivalence is how a broken pipeline reports success.
  if (!items.length) {
    batchRefusals.push(refusal(0, 'empty_batch',
      'A batch with no items is refused. Publishing nothing is not publishing, and an empty pass is indistinguishable from a working one.'));
  }

  // ── Criterion 6: the Designer curated it ────────────────────────────────
  // A10: she and Gemini are the only ones authorised to write for humans, and
  // the bible calls her the absolute gatekeeper. This is the line that makes
  // that role real rather than descriptive: a batch nobody curated does not
  // publish, no matter how clean its files are.
  const curatedAt = parsedTime(batch?.curatedAt);
  if (Number(batch?.curatedBy) !== DESIGNER_AGENT_ID) {
    batchRefusals.push(refusal(6, 'designer_curation_missing',
      `curatedBy is ${JSON.stringify(batch?.curatedBy ?? null)}, not Agent ${DESIGNER_AGENT_ID} (The Designer). The Front's delivery quality is her judgement call and A10 gives her the gate; a batch assembled by anyone else has skipped it.`));
  }
  if (curatedAt === null) {
    batchRefusals.push(refusal(6, 'curation_undated',
      'curatedAt is missing or unparseable. An undated curation cannot be checked against the QA sign-off or against the items it claims to cover.'));
  }

  // ── Criterion 5: QA sign-off, and it must be the QA ─────────────────────
  const qa = batch?.qaSignOff || {};
  const qaAt = parsedTime(qa.at);
  if (!qa || qa.verdict !== 'approved') {
    batchRefusals.push(refusal(5, 'qa_signoff_missing',
      `QA sign-off is ${JSON.stringify(qa.verdict ?? null)}, not 'approved'. OFFICE-POLICY A4 requires a full reasoned review from the QA for this content type — not a rubber stamp and not optional.`));
  }
  if (Number(qa.agentId) !== QA_AGENT_ID) {
    batchRefusals.push(refusal(5, 'qa_signoff_not_qa',
      `The sign-off names Agent ${JSON.stringify(qa.agentId ?? null)}, not Agent ${QA_AGENT_ID} (The QA). A review by whoever wrote it is not a review — the same rule A10 states for security fixes.`));
  }
  if (qaAt === null) {
    batchRefusals.push(refusal(5, 'qa_signoff_undated',
      'The QA sign-off carries no parseable timestamp, so it cannot be shown to postdate the content it signs.'));
  }
  if (!String(qa.notes || '').trim()) {
    batchRefusals.push(refusal(5, 'qa_signoff_unreasoned',
      'The QA sign-off carries no notes. A4 asks for a reasoned review; a verdict with no reasoning is the rubber stamp it is meant to exclude.'));
  }

  // A sign-off that predates the item it signs has not seen it. This is the
  // one ordering check the batch flow genuinely depends on, and it is exactly
  // the class of thing a human reviewer does not notice.
  if (qaAt !== null) {
    for (const item of items) {
      const revised = parsedTime(item?.revisedAt);
      if (revised === null) {
        batchRefusals.push(refusal(5, 'item_undated',
          `"${item?.path}" has no parseable revisedAt, so the QA sign-off cannot be shown to cover its current text.`));
      } else if (revised > qaAt) {
        batchRefusals.push(refusal(5, 'qa_signoff_stale',
          `"${item?.path}" was revised at ${item.revisedAt}, AFTER the QA signed off at ${qa.at}. The sign-off is for text that no longer exists; re-review before publishing.`));
      }
    }
  }

  // ── Criterion 7: everything is shown, including mistakes ────────────────
  // A10's central claim about the Front, and the one most likely to erode
  // quietly — nobody ever *decides* to publish only successes, batches just
  // come out that way. So the batch must state its position and evidence it.
  const mistakes = batch?.mistakesShown || {};
  if (typeof mistakes.included !== 'boolean') {
    batchRefusals.push(refusal(7, 'mistakes_disclosure_missing',
      'mistakesShown.included is not declared. A10: an office that publishes only successes reads as public relations. The batch must state whether it shows a mistake, and silence is refused rather than read as "no".'));
  } else if (mistakes.included && !String(mistakes.evidence || '').trim()) {
    batchRefusals.push(refusal(7, 'mistakes_evidence_missing',
      'mistakesShown.included is true but names no evidence. An unevidenced claim to be showing mistakes is the exact public-relations posture A10 forbids.'));
  } else if (!mistakes.included && !String(mistakes.evidence || '').trim()) {
    batchRefusals.push(refusal(7, 'mistakes_omission_unexplained',
      'mistakesShown.included is false and no reason is given. A batch may legitimately contain no mistake — but it must say why, so "nothing went wrong this period" and "we left it out" stay distinguishable.'));
  }

  // ── Criterion 8: a disagreement is published as a disagreement ──────────
  const dis = batch?.disagreementShown || {};
  if (typeof dis.applicable !== 'boolean') {
    batchRefusals.push(refusal(8, 'disagreement_applicability_undeclared',
      'disagreementShown.applicable is not declared. A10 publishes disagreements between agents; the batch must state whether its content depends on one.'));
  } else if (dis.applicable && !dis.included) {
    batchRefusals.push(refusal(8, 'disagreement_merged',
      'The batch says its content depends on a disagreement between agents and that the disagreement is NOT shown. A10: an office that always agrees with itself looks like one model speaking in several voices. Show it, or explain why the content no longer depends on it.'));
  } else if (dis.applicable && dis.included && !String(dis.evidence || '').trim()) {
    batchRefusals.push(refusal(8, 'disagreement_evidence_missing',
      'The disagreement is declared shown but names no evidence.'));
  }

  const itemResults = items.map(evaluateItem);
  const itemRefusals = itemResults.flatMap((r) => r.refusals.map((x) => ({ ...x, path: r.path })));
  const allRefusals = [...batchRefusals, ...itemRefusals];

  return {
    batchId: batch?.batchId ?? null,
    publishable: allRefusals.length === 0,
    refusals: allRefusals,
    batchRefusals,
    itemResults,
    counts: {
      items: items.length,
      itemsClean: itemResults.filter((r) => r.ok).length,
      refusals: allRefusals.length,
      criteriaFailed: [...new Set(allRefusals.map((r) => r.criterion))].sort((a, b) => a - b),
    },
  };
}

/**
 * Step 5 of the batch flow: the record of the gate's own operation.
 *
 * `PUBLISHING-GATE.md` step 5 asks for what published, when, and by whose
 * sign-off — "the same 'everything is shown' posture the content itself
 * carries, applied to the gate's own operation." A refused batch gets a record
 * too, and that is the point: a gate whose refusals leave no trace is a gate
 * nobody can audit, which is the argument A10 makes about security posture
 * generally.
 *
 * Returns markdown. It writes nothing — the caller decides where it lands, the
 * same split `gap-reports.js` and `guide-engine.js` already use.
 */
export function renderPublicationRecord(batch, result, { date } = {}) {
  const when = date || (batch?.curatedAt ? String(batch.curatedAt).slice(0, 10) : 'undated');
  const qa = batch?.qaSignOff || {};
  const lines = [];

  lines.push(`# Front publication record — batch ${result.batchId ?? '(unidentified)'}`);
  lines.push('');
  lines.push(`**Verdict:** ${result.publishable ? 'PUBLISHED' : 'REFUSED'} · **Date:** ${when}`);
  lines.push(`**Curated by:** Agent ${batch?.curatedBy ?? '?'} · **QA sign-off:** Agent ${qa.agentId ?? '?'}, ${qa.verdict ?? 'none'}, ${qa.at ?? 'undated'}`);
  lines.push('');
  lines.push(`**Items:** ${result.counts.items} (${result.counts.itemsClean} clean) · **Refusals:** ${result.counts.refusals}`);
  lines.push('');

  if (qa.notes) {
    lines.push('## QA review');
    lines.push('');
    lines.push(String(qa.notes).trim());
    lines.push('');
  }

  lines.push('## Items');
  lines.push('');
  lines.push('| Path | Source | Verdict |');
  lines.push('|---|---|---|');
  for (const r of result.itemResults) {
    const item = (batch?.items || []).find((i) => i?.path === r.path) || {};
    const src = item.sourceLanguage === 'he'
      ? `re-voiced from \`${item?.localization?.sourceRef || '?'}\``
      : `English-authored${item?.provenance?.sourceRef ? ` (\`${item.provenance.sourceRef}\`)` : ''}`;
    lines.push(`| \`${r.path}\` | ${src} | ${r.ok ? 'clean' : `${r.refusals.length} refusal(s)`} |`);
  }
  lines.push('');

  if (result.refusals.length) {
    lines.push('## Refusals');
    lines.push('');
    for (const r of result.refusals) {
      lines.push(`- **Criterion ${r.criterion} · \`${r.code}\`**${r.path ? ` — \`${r.path}\`` : ''}: ${r.message}`);
    }
    lines.push('');
  }

  const m = batch?.mistakesShown || {};
  const d = batch?.disagreementShown || {};
  lines.push('## A10 disclosures');
  lines.push('');
  lines.push(`- **Shows a mistake:** ${m.included === true ? 'yes' : m.included === false ? 'no' : 'undeclared'} — ${m.evidence || '(none given)'}`);
  lines.push(`- **Depends on a disagreement:** ${d.applicable === true ? 'yes' : d.applicable === false ? 'no' : 'undeclared'}${d.applicable ? ` · shown: ${d.included ? 'yes' : 'no'} — ${d.evidence || '(none given)'}` : ''}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Produced by `workers/front-gate.js` (`OB-014`). The security scan that governs this content is not run here — it runs unconditionally inside `commitFileToRepo()` on every public-repo write, and this gate\'s criterion 3 asserts that Front paths are in its scope rather than re-implementing it.*');

  return lines.join('\n');
}
