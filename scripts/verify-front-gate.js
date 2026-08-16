#!/usr/bin/env node
/**
 * scripts/verify-front-gate.js
 *
 * Dry-run verifier for `workers/front-gate.js` — the publishing gate the
 * Designer operates (`OB-014`, built 2026-08-16, closing audit finding #17).
 *
 * LIVE IMPORT, not source-text assertions. `front-gate.js` imports only
 * `security-scan.js`, which imports nothing at all, so both load under plain
 * `node` and every refusal below is PRODUCED by calling the module rather than
 * matched against its text. That is deliberate and it is the point of the
 * module being pure: a gate whose refusals are asserted by regex over its own
 * source has been described, not tested.
 *
 * §1 carries the pre-2026-08-16 SCANNED_PREFIXES list as a FROZEN CONTROL and
 * asserts a Front path went UNSCANNED under it — the same technique
 * `verify-judge-sampler.js` §2b uses for the old hash expression. The defect
 * this closes is silent in both directions, so a check that only confirms the
 * fix would not distinguish "we fixed it" from "it was never broken".
 *
 * NO NETWORK.
 */

import { evaluateItem, evaluateBatch, assertScanCoverage, detectNonEnglish, renderPublicationRecord, FRONT_PREFIX, QA_AGENT_ID, DESIGNER_AGENT_ID } from '../workers/front-gate.js';
import { isScannedPath, SCANNED_PREFIXES, scanOutbound } from '../workers/security-scan.js';

globalThis.fetch = () => {
  throw new Error('TRIPWIRE: verify-front-gate.js made a network call. It must not.');
};

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n--- ${title} ---`); }

/** Refusal codes present in a result. */
const codes = (r) => r.refusals.map((x) => x.code);
const has = (r, code) => codes(r).includes(code);

/* ───────────────────────────────────────────────────────────────────────── */
section('§1 A10 scan coverage — the defect this gate was built around');

const FRONT_PAGE = 'front/team/09-the-designer.md';

check('front/ is in SCANNED_PREFIXES', SCANNED_PREFIXES.includes('front/'));
check('a Front path is a scanned path today', isScannedPath(FRONT_PAGE));
check('assertScanCoverage() passes a Front path', assertScanCoverage(FRONT_PAGE).ok);

// The frozen control: the exact list as it stood before 2026-08-16.
const PRE_OB014_PREFIXES = ['reports/', 'agent-output/', 'docs/', 'README', 'PROJECT-CONTEXT-SUMMARY', 'AGENTS.md'];
const wasScanned = PRE_OB014_PREFIXES.some((p) => FRONT_PAGE.startsWith(p));
check('FROZEN CONTROL: under the pre-OB-014 prefix list the same Front path was NOT scanned',
  wasScanned === false);

// And the consequence, demonstrated rather than argued: scanOutbound() reports
// a page containing a real security sentence as CLEAN when the path is out of
// scope, which is what commitFileToRepo() would have acted on.
const SENSITIVE = 'The office found an unauthenticated endpoint leaking every kill switch, and closed it.';
const outOfScope = scanOutbound(SENSITIVE, { path: 'team/09-the-designer.md' });
check('a security sentence at an OUT-OF-SCOPE path returns scanned:false', outOfScope.scanned === false);
check('...and clean:true, which is what would have let it publish', outOfScope.clean === true);
const inScope = scanOutbound(SENSITIVE, { path: FRONT_PAGE });
check('the SAME sentence under front/ is scanned', inScope.scanned === true);
check('...and is REFUSED', inScope.clean === false && inScope.hits.length > 0);

check('a path outside front/ is refused by the gate with its own code',
  assertScanCoverage('team/09-the-designer.md').code === 'front_path_outside_prefix');
check('FRONT_PREFIX is a single prefix, so SCANNED_PREFIXES needs one entry',
  FRONT_PREFIX === 'front/');

/* ───────────────────────────────────────────────────────────────────────── */
section('§2 criterion 1 — English only, with acknowledged fragments allowed');

check('detectNonEnglish finds Hebrew and reports its line',
  detectNonEnglish('one\nשתיים\nthree').length === 1
  && detectNonEnglish('one\nשתיים\nthree')[0].line === 2);
check('detectNonEnglish returns nothing for plain English', detectNonEnglish('all english here').length === 0);

const baseItem = {
  path: FRONT_PAGE,
  content: 'The Designer curates the Front.',
  sourceLanguage: 'en',
  revisedAt: '2026-08-16T09:00:00Z',
};

check('a clean English item passes', evaluateItem(baseItem).ok);

const rawHebrew = { ...baseItem, content: 'The Designer said:\nהעבודה לא מספיק טובה' };
check('unacknowledged Hebrew is REFUSED', has(evaluateItem(rawHebrew), 'hebrew_fragment_unacknowledged'));

const ackedHebrew = {
  ...rawHebrew,
  hebrewFragmentsAcknowledged: [{ line: 2, why: "the office's own words, quoted deliberately per A10" }],
};
check('the same Hebrew, acknowledged WITH a reason, passes', evaluateItem(ackedHebrew).ok);

const ackedNoReason = { ...rawHebrew, hebrewFragmentsAcknowledged: [{ line: 2 }] };
check('an acknowledgement with no reason is not an acknowledgement',
  has(evaluateItem(ackedNoReason), 'hebrew_fragment_unacknowledged'));

const ackedWrongLine = { ...rawHebrew, hebrewFragmentsAcknowledged: [{ line: 99, why: 'quoted' }] };
check('acknowledging the WRONG line does not clear the real one',
  has(evaluateItem(ackedWrongLine), 'hebrew_fragment_unacknowledged'));

/* ───────────────────────────────────────────────────────────────────────── */
section('§3 criterion 2 — re-voiced, not translated');

const heNoLoc = { ...baseItem, sourceLanguage: 'he' };
check('a Hebrew-sourced item with no localization record is REFUSED',
  has(evaluateItem(heNoLoc), 'hebrew_source_not_localized'));

const heWrongLane = { ...baseItem, sourceLanguage: 'he', localization: { lane: 'hebrew_composition', sourceRef: 'x' } };
check('the WRONG lane is refused — hebrew_composition writes Hebrew, it does not carry it back',
  has(evaluateItem(heWrongLane), 'hebrew_source_not_localized'));

const heNoSource = { ...baseItem, sourceLanguage: 'he', localization: { lane: 'front_localization' } };
check('a localized item naming no sourceRef is refused as unfalsifiable',
  has(evaluateItem(heNoSource), 'localization_provenance_missing'));

const heGood = {
  ...baseItem,
  sourceLanguage: 'he',
  localization: { lane: 'front_localization', sourceRef: 'reports/gaps/data-center/2026-07-20.md', at: '2026-08-16T09:00:00Z' },
};
check('a properly re-voiced item passes', evaluateItem(heGood).ok);

/* ───────────────────────────────────────────────────────────────────────── */
section('§4 criterion 4 — no binary through this path');

check('a base64 item is REFUSED by the gate',
  has(evaluateItem({ ...baseItem, contentIsBase64: true }), 'binary_item_refused'));

/* ───────────────────────────────────────────────────────────────────────── */
section('§5 criteria 5-8 — the judgement calls, enforced as required RECORDS');

const goodBatch = {
  batchId: 'batch-001',
  curatedBy: DESIGNER_AGENT_ID,
  curatedAt: '2026-08-16T12:00:00Z',
  qaSignOff: {
    agentId: QA_AGENT_ID,
    at: '2026-08-16T11:00:00Z',
    verdict: 'approved',
    notes: 'Read end to end. The claim about autonomy is narrower than the section title implied; asked for it to be narrowed and it was.',
  },
  // OB-096: a claim to be showing a mistake now has to say WHERE, and the
  // quote must be in the item it names. See disclosureLocatorRefusals().
  mistakesShown: {
    included: true,
    evidence: 'The page states the sampler selected 2.4% against a declared 12.5%.',
    disclosedAt: { path: FRONT_PAGE, quote: 'selected 2.4% against a declared 12.5%' },
  },
  disagreementShown: { applicable: false },
  items: [{
    ...baseItem,
    revisedAt: '2026-08-16T10:00:00Z',
    content: 'The Designer curates the Front. The sampler selected 2.4% against a declared 12.5%.',
  }],
};

const good = evaluateBatch(goodBatch);
check('a complete, well-formed batch is publishable', good.publishable, JSON.stringify(codes(good)));
check('...and counts its items', good.counts.items === 1 && good.counts.itemsClean === 1);

check('an EMPTY batch is refused, not trivially approved',
  has(evaluateBatch({ ...goodBatch, items: [] }), 'empty_batch'));

check('a batch curated by anyone but the Designer is refused',
  has(evaluateBatch({ ...goodBatch, curatedBy: 11 }), 'designer_curation_missing'));
check('an undated curation is refused',
  has(evaluateBatch({ ...goodBatch, curatedAt: null }), 'curation_undated'));

check('no QA sign-off — refused',
  has(evaluateBatch({ ...goodBatch, qaSignOff: {} }), 'qa_signoff_missing'));
check("a 'returned' verdict is not an approval",
  has(evaluateBatch({ ...goodBatch, qaSignOff: { ...goodBatch.qaSignOff, verdict: 'returned' } }), 'qa_signoff_missing'));
check('sign-off by the Designer herself is refused — a review by whoever wrote it is not a review',
  has(evaluateBatch({ ...goodBatch, qaSignOff: { ...goodBatch.qaSignOff, agentId: DESIGNER_AGENT_ID } }), 'qa_signoff_not_qa'));
check('a sign-off with no notes is refused as a rubber stamp',
  has(evaluateBatch({ ...goodBatch, qaSignOff: { ...goodBatch.qaSignOff, notes: '  ' } }), 'qa_signoff_unreasoned'));

// The ordering check.
const stale = evaluateBatch({
  ...goodBatch,
  items: [{ ...baseItem, revisedAt: '2026-08-16T11:30:00Z' }], // after the 11:00 sign-off
});
check('an item revised AFTER the sign-off is refused as stale', has(stale, 'qa_signoff_stale'));
check('an item with no revisedAt is refused', has(evaluateBatch({ ...goodBatch, items: [{ ...baseItem, revisedAt: null }] }), 'item_undated'));

check('an undeclared mistakes position is refused — silence is not "no"',
  has(evaluateBatch({ ...goodBatch, mistakesShown: {} }), 'mistakes_disclosure_missing'));
check('claiming to show a mistake with no evidence is refused',
  has(evaluateBatch({ ...goodBatch, mistakesShown: { included: true, evidence: '' } }), 'mistakes_evidence_missing'));
check('showing NO mistake is allowed but must say why',
  has(evaluateBatch({ ...goodBatch, mistakesShown: { included: false } }), 'mistakes_omission_unexplained'));
check('...and IS allowed once the reason is given',
  evaluateBatch({ ...goodBatch, mistakesShown: { included: false, evidence: 'This batch is the team section; the mistakes belong to press/ and publish there.' } }).publishable);

/* ── OB-096: a non-empty record is not a responsive one ────────────────────
 *
 * The gate's second-ever live batch answered criterion 7 — "does this batch
 * DISCLOSE a mistake the office made?" — with a flaw the Designer had spotted
 * in the page under review. Non-empty, useful, and not the question.
 *
 * The fix does NOT score the text, which would be scoring judgement with a
 * heuristic. It asks for a locator, because a disclosure and a critique differ
 * REFERENTIALLY: a disclosure is in the published text and can be pointed at;
 * a review finding is about the text and is not in it. The first case below is
 * the real answer from batch `2026-08-16-team-01`, checked in situ against the
 * archived batch before these fixtures were written. */
{
  const withLoc = (disclosedAt) => evaluateBatch({
    ...goodBatch, mistakesShown: { included: true, evidence: 'something happened', disclosedAt },
  });
  check('[OB-096, the real case] a claim with no locator is refused',
    has(evaluateBatch({ ...goodBatch, mistakesShown: { included: true, evidence: "'I'm at a 30 raw meter value' is vague" } }),
      'mistakes_disclosure_unlocated'));
  check('a locator naming a path but no quote is refused',
    has(withLoc({ path: FRONT_PAGE }), 'mistakes_disclosure_locator_incomplete'));
  check('a locator naming a file that is not in this batch is refused',
    has(withLoc({ path: 'front/team/99-nobody.md', quote: 'anything' }), 'mistakes_disclosure_path_not_in_batch'));
  check('a quote that does not appear in the published text is refused — the OB-096 shape',
    has(withLoc({ path: FRONT_PAGE, quote: "'I'm at a 30 raw meter value' is vague" }), 'mistakes_disclosure_quote_absent'));
  check('a real disclosure, quoted from the page, is ACCEPTED',
    evaluateBatch(goodBatch).publishable);
  check('...and the quote match survives a line wrap, so formatting is not the finding',
    withLoc({ path: FRONT_PAGE, quote: 'selected 2.4%\n   against a declared 12.5%' }).publishable);
  check('an item with NO content is "could not check", not "quote absent" (KFM-13)',
    has(evaluateBatch({
      ...goodBatch,
      items: [{ ...baseItem, revisedAt: '2026-08-16T10:00:00Z', content: '' }],
    }), 'mistakes_disclosure_uncheckable'));
  check('the locator is required ONLY when a mistake is claimed, never when none is',
    evaluateBatch({ ...goodBatch, mistakesShown: { included: false, evidence: 'nothing went wrong in this batch\'s period.' } }).publishable);
}

check('an undeclared disagreement applicability is refused',
  has(evaluateBatch({ ...goodBatch, disagreementShown: {} }), 'disagreement_applicability_undeclared'));
check('a batch that DEPENDS on a disagreement and hides it is refused',
  has(evaluateBatch({ ...goodBatch, disagreementShown: { applicable: true, included: false } }), 'disagreement_merged'));
check('a shown disagreement with no evidence is refused',
  has(evaluateBatch({ ...goodBatch, disagreementShown: { applicable: true, included: true, evidence: '' } }), 'disagreement_evidence_missing'));

/* ───────────────────────────────────────────────────────────────────────── */
section('§6 the gate has teeth — a plausible-looking batch that fails');

// The realistic failure: everything looks done, and two things are wrong that
// no reader would catch — the QA signed before the last revision, and the page
// carries a Hebrew line nobody declared.
const plausible = evaluateBatch({
  ...goodBatch,
  items: [{
    path: 'front/press/2026-08-week-08.md',
    content: 'The office reviewed its own metric.\nהמדד מדד אורך, לא איכות',
    sourceLanguage: 'en',
    revisedAt: '2026-08-16T11:45:00Z',
  }],
});
check('the plausible batch is REFUSED', !plausible.publishable);
check('...for the stale sign-off', has(plausible, 'qa_signoff_stale'));
check('...and for the undeclared Hebrew', has(plausible, 'hebrew_fragment_unacknowledged'));
check('...and names both criteria', plausible.counts.criteriaFailed.includes(1) && plausible.counts.criteriaFailed.includes(5));

/* ───────────────────────────────────────────────────────────────────────── */
section('§7 the publication record — refusals are recorded too');

const recPass = renderPublicationRecord(goodBatch, good, { date: '2026-08-16' });
check('a published batch records PUBLISHED', /\*\*Verdict:\*\* PUBLISHED/.test(recPass));
check('...names the QA and the curator', /Curated by:\*\* Agent 9/.test(recPass) && /Agent 6/.test(recPass));
check('...carries the QA reasoning, not just the verdict', /Read end to end/.test(recPass));
check('...and the A10 disclosures', /## A10 disclosures/.test(recPass));

const recFail = renderPublicationRecord(goodBatch, plausible, { date: '2026-08-16' });
check('a refused batch also produces a record — an unauditable refusal is not a control',
  /\*\*Verdict:\*\* REFUSED/.test(recFail) && /## Refusals/.test(recFail));
check('the record names the refusal codes', /qa_signoff_stale/.test(recFail));

/* ───────────────────────────────────────────────────────────────────────── */
section('§8 the gate does not re-implement the scanner');

const gateSrc = (await import('node:fs')).readFileSync(new URL('../workers/front-gate.js', import.meta.url), 'utf8');
// Comments are stripped first. The module DISCUSSES scanOutbound() at length —
// explaining why it does not call it is most of its header — and a check that
// cannot tell prose from a call would fail on a correct file, which is the
// same class of defect as a metric that measures length.
const gateCode = gateSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('front-gate.js never calls scanOutbound() — the write path owns that check',
  !/scanOutbound\s*\(/.test(gateCode));
check('...and never imports it, so it could not call it', !/scanOutbound/.test(gateCode));
check('it imports only isScannedPath from security-scan.js',
  /import \{ isScannedPath \} from '\.\/security-scan\.js';/.test(gateSrc));
check('it has no kill switch — a switch that disables a refusal mechanism is a hole',
  !/front_gate_enabled|frontGateEnabled/.test(gateSrc));

/* ───────────────────────────────────────────────────────────────────────── */
console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
